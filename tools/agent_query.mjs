// One isolated query per process; stdout contains only the result envelope.
import { analyzePack } from "../web/js/agent-query.js";
let input = "";
for await (const part of process.stdin) input += part;
try {
  const { pack, args } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ ok: true, result: analyzePack(pack, args) }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "INVALID_QUERY", message: err.message, retryable: false } }));
  process.exitCode = 1;
}
