// Focused browser regressions for measurement definitions, coverage and timing.
import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-name-pattern", "measurement|trial figures", "tests/browser/page.test.mjs"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
