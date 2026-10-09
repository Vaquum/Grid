// The strip: a view in one line of figures, each a label over its value,
// and the view's two tools at its end: its blurb behind an (i), and a copy
// of what it shows as notes.

import { h, icon, tip, copyText, infoButton } from "./ui.js";

// One figure. `onPick` makes it a button; `tipFn` explains it.
export function stripCell(label, value, suffix, tipFn, onPick, attrs = {}) {
  const el = h(onPick ? "button" : "div", { class: "sc" + (onPick ? " pick" : "") + " has-tip", type: onPick ? "button" : null, onclick: onPick || null, ...attrs },
    h("span", { class: "sc-k", text: label }),
    h("span", { class: "sc-v" }, h("b", { class: "num", title: value, text: value }), suffix ? h("small", { title: suffix, text: suffix }) : null));
  if (tipFn) tip(el, tipFn);
  return el;
}

// `about` is { key, label, content } for the (i); `copy` is { label, what,
// text, done } for the copy button.
export function strip(ariaLabel, cells, about, copy, A) {
  const tools = h("div", { class: "strip-tools" });
  if (about) tools.append(infoButton(about.key, about.label, about.content));
  if (copy) {
    const b = h("button", { class: "icon-btn strip-copy", type: "button", "aria-label": copy.label, onclick: async () => {
      const ok = await copyText(copy.text(), null);
      A.toast(h("span", null, h("b", { text: ok ? `${copy.done} ` : "Copying was refused. " }), ok ? "Paste it into the research notes." : "The browser did not allow the clipboard."));
    } }, icon("copy"));
    tip(b, () => h("div", null, h("b", { text: copy.label }), h("div", { class: "k", text: copy.what })));
    tools.append(b);
  }
  return h("section", { class: "strip", "aria-label": ariaLabel }, h("div", { class: "strip-cells" }, cells), tools);
}

// The blurb's body: a title and paragraphs.
export function about(title, ...paras) {
  return h("div", { class: "about" }, h("b", { text: title }), paras.filter(Boolean).map(p => h("p", null, p)));
}
