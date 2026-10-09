// Every page module parses: node --check on each, the first failure named.
// A script of its own, so it runs wherever a runner may call node on a file.

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../web/js/", import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith(".js")).sort();
for (const f of files) execFileSync(process.execPath, ["--check", join(dir, f)], { stdio: "inherit" });
console.log(`${files.length} modules parse`);
