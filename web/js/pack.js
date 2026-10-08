// Decode the server's column exports into growable typed arrays, and apply
// live deltas to them. The encoding is defined in tessera/columns.py:
// numbers exact, -1 / null for a null value, -2 / "~" for an absent key.

export const NULL = -1;
export const ABSENT = -2;
const ABSENT_TEXT = "~";

function numberOf(v) {
  if (typeof v === "number") return v;
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  throw new Error(`not a number in a numeric column: ${JSON.stringify(v)}`);
}

function grow(arr, need, Ctor) {
  if (arr.length >= need) return arr;
  let cap = Math.max(16, arr.length);
  while (cap < need) cap *= 2;
  const out = new Ctor(cap);
  out.set(arr);
  return out;
}

// One field. `n` rows are valid; arrays may be longer (capacity).
export class Column {
  constructor(name, kind) {
    this.name = name;
    this.kind = kind;
    this.n = 0;
    this.levels = [];        // str/json levels, set members
    this.vals = new Float64Array(0);   // num: value (NaN when null/absent)
    this.state = new Uint8Array(0);    // num/set: 0 value, 1 null, 2 absent
    this.codes = new Int32Array(0);    // bool 0/1, str/json level; -1/-2
    this.words = 1;                    // set: 32-bit words per row
    this.bits = new Uint32Array(0);    // set: row-major membership bits
    this.nonFinite = false;            // num: holds NaN/±Infinity values
  }

  // Row i's state: 0 value, 1 null, 2 absent.
  stateAt(i) {
    if (this.kind === "num" || this.kind === "set") return this.state[i];
    const c = this.codes[i];
    return c === ABSENT ? 2 : c === NULL ? 1 : 0;
  }

  padAbsent(count) {
    this._reserve(this.n + count);
    for (let i = this.n; i < this.n + count; i++) this._setAbsent(i);
    this.n += count;
  }

  _setAbsent(i) {
    if (this.kind === "num") { this.vals[i] = NaN; this.state[i] = 2; }
    else if (this.kind === "set") { this.state[i] = 2; this.bits.fill(0, i * this.words, (i + 1) * this.words); }
    else this.codes[i] = ABSENT;
  }

  _reserve(need) {
    if (this.kind === "num") {
      this.vals = grow(this.vals, need, Float64Array);
      this.state = grow(this.state, need, Uint8Array);
    } else if (this.kind === "set") {
      this.state = grow(this.state, need, Uint8Array);
      this.bits = grow(this.bits, need * this.words, Uint32Array);
    } else {
      this.codes = grow(this.codes, need, Int32Array);
    }
  }

  _widen(members) {
    const words = Math.max(1, Math.ceil(members / 32));
    if (words <= this.words) return;
    const old = this.bits, w0 = this.words;
    const out = new Uint32Array(Math.max(16, this.state.length) * words);
    for (let i = 0; i < this.n; i++) {
      for (let w = 0; w < w0; w++) out[i * words + w] = old[i * w0 + w];
    }
    this.bits = out;
    this.words = words;
  }

  // Append rows from an exported column (see Column.export in columns.py).
  append(ex, count) {
    if (ex.kind !== this.kind) {
      throw new Error(`column ${this.name} changed kind ${this.kind} -> ${ex.kind}; reload the sweep`);
    }
    const sent = (ex.data || ex.codes).length;
    if (sent !== count) {
      throw new Error(`column ${this.name}: ${sent} values for ${count} rows`);
    }
    if (ex.levelBase !== undefined) {
      if (ex.levelBase !== this.levels.length) {
        throw new Error(`column ${this.name}: dictionary out of step (have ${this.levels.length}, delta starts at ${ex.levelBase})`);
      }
      for (const l of ex.levels) this.levels.push(l);
    }
    if (this.kind === "set") this._widen(this.levels.length);
    this._reserve(this.n + count);
    const base = this.n;
    if (this.kind === "num") {
      this._appendNum(ex, base, count);
    } else if (this.kind === "set") {
      const W = this.words;
      for (let j = 0; j < count; j++) {
        const v = ex.data[j], i = base + j;
        if (v === null) { this.state[i] = 1; this.bits.fill(0, i * W, (i + 1) * W); continue; }
        if (v === ABSENT_TEXT) { this.state[i] = 2; this.bits.fill(0, i * W, (i + 1) * W); continue; }
        this.state[i] = 0;
        // hex mask, least significant member last
        let w = 0;
        for (let end = v.length; end > 0; end -= 8, w++) {
          const chunk = v.slice(Math.max(0, end - 8), end);
          this.bits[i * W + w] = parseInt(chunk, 16) >>> 0;
        }
        for (; w < W; w++) this.bits[i * W + w] = 0;
      }
    } else {
      for (let j = 0; j < count; j++) this.codes[base + j] = ex.data[j];
    }
    this.n += count;
  }

  _appendNum(ex, base, count) {
    if (ex.codes) {
      const lv = ex.levels.map(numberOf);
      for (let j = 0; j < count; j++) {
        const c = ex.codes[j], i = base + j;
        if (c >= 0) {
          this.vals[i] = lv[c]; this.state[i] = 0;
        } else {
          this.vals[i] = NaN; this.state[i] = c === ABSENT ? 2 : 1;
        }
      }
      return;
    }
    for (let j = 0; j < count; j++) {
      const v = ex.data[j], i = base + j;
      if (v === null) { this.vals[i] = NaN; this.state[i] = 1; }
      else if (v === ABSENT_TEXT) { this.vals[i] = NaN; this.state[i] = 2; }
      else {
        const x = numberOf(v);
        if (!Number.isFinite(x)) this.nonFinite = true;
        this.vals[i] = x; this.state[i] = 0;
      }
    }
  }

  // Row i's value: number / string / boolean / string[] (set), null, or
  // undefined when absent.
  value(i) {
    const st = this.stateAt(i);
    if (st === 2) return undefined;
    if (st === 1) return null;
    switch (this.kind) {
      case "num": return this.vals[i];
      case "bool": return this.codes[i] === 1;
      case "str": return this.levels[this.codes[i]];
      case "json": return JSON.parse(this.levels[this.codes[i]]);
      case "set": return this.members(i);
      default: throw new Error(`unknown kind ${this.kind}`);
    }
  }

  has(i, m) {
    return (this.bits[i * this.words + (m >>> 5)] >>> (m & 31)) & 1;
  }

  members(i) {
    const out = [];
    for (let m = 0; m < this.levels.length; m++) if (this.has(i, m)) out.push(this.levels[m]);
    return out;
  }
}

// One run's rows.
export class Dataset {
  constructor(meta) {
    this.id = meta.id;
    this.meta = meta;
    this.n = 0;
    this.cols = new Map();
    this.order = [];
    this.arrivals = new Float64Array(0);
    this.version = 0;
  }

  col(name) { return this.cols.get(name); }

  // Append rows [lo, hi) from an export (a whole pack has lo = 0).
  append(lo, hi, columns, arrivals) {
    if (lo !== this.n) throw new Error(`run ${this.id}: rows ${lo}..${hi} do not follow ${this.n}`);
    const count = hi - lo;
    const seen = new Set();
    for (const ex of columns) {
      let c = this.cols.get(ex.name);
      if (!c) {
        c = new Column(ex.name, ex.kind);
        c.padAbsent(lo);
        this.cols.set(ex.name, c);
        this.order.push(ex.name);
      }
      c.append(ex, count);
      seen.add(ex.name);
    }
    for (const name of this.order) if (!seen.has(name)) this.cols.get(name).padAbsent(count);
    this.arrivals = grow(this.arrivals, hi, Float64Array);
    for (let j = 0; j < count; j++) {
      const t = arrivals ? arrivals[j] : null;
      this.arrivals[lo + j] = t === null || t === undefined ? NaN : t;
    }
    this.n = hi;
    this.version++;
  }
}

// A whole pack as served by /api/pack or embedded in the page.
export function decodePack(pack) {
  if (pack.tessera !== 1) throw new Error(`unknown pack version ${pack.tessera}`);
  const runs = pack.runs.map(r => {
    const ds = new Dataset(r);
    ds.append(0, r.rows, r.columns, r.arrivals);
    delete r.columns;
    delete r.arrivals;
    return ds;
  });
  return { meta: pack, runs, logs: pack.logs || {}, docs: pack.docs || {} };
}

// Row i rebuilt as a JSON object (absent keys left out), the way
// tessera/columns.py Store.row_object does it.
export function rowObject(ds, i) {
  if (!(i >= 0 && i < ds.n)) throw new Error(`row ${i} is outside 0..${ds.n - 1}`);
  const root = {};
  for (const name of ds.order) {
    const v = ds.cols.get(name).value(i);
    if (v === undefined) continue;
    const parts = name.split(".");
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (node[p] === null || typeof node[p] !== "object" || Array.isArray(node[p])) node[p] = {};
      node = node[p];
    }
    node[parts[parts.length - 1]] = v;
  }
  return toLists(root);
}

function toLists(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const keys = Object.keys(node);
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map(k => toLists(node[k]));
  const out = {};
  for (const k of keys) out[k] = toLists(node[k]);
  return out;
}
