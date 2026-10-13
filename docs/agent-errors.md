# Agent errors, recovery and limits

See [connection and transports](agents.md) before diagnosing a failed call.
The error envelope is:

```json
{"apiVersion":1,"ok":false,"result":null,"error":{"code":"SNAPSHOT_EXPIRED","message":"snapshot is unavailable","retryable":false}}
```

Branch on `error.code`; `message` is diagnostic text, not a stable identifier.
`retryable` says whether a transport/runtime retry may help. It never authorizes
repeating a write under a new ID. Keep the original operation, arguments and
`requestId` together until the outcome is known.

## Error reference

| Code | Meaning | Recovery |
| --- | --- | --- |
| `INVALID_INPUT` | The JSON CLI cannot read the connection/argument file, parse JSON, or accept its shape. | Fix the local input. Arguments must be an object. The connection needs a nonempty `url` and `token`; its URL is an HTTP(S) server root, without credentials, query or fragment. |
| `CONNECTION_FAILED` | Connection, I/O or response decoding failed; `retryable: true`. A write may already have executed. | Check the server. For a write, query `grid_receipt`, then retry only the identical intent with the original ID. |
| `HTTP_ERROR` | The server/proxy returned an HTTP failure without a Grid error envelope. Redirects are refused. | Read the HTTP status in the message; check the address, proxy and whether agent access was enabled. Preserve write IDs. |
| `AUTHENTICATION_FAILED` | HTTP 403: wrong bearer credential, indirect Host name, or disallowed Origin/site. | Use the current private connection file and a localhost/IP address. The page token and public human URL do not authorize agent calls. |
| `INVALID_REQUEST` | HTTP request framing, JSON, content type or fields are invalid; also used for other HTTP failures on `/api/agent`. | Send `application/json` with only `operation` and `arguments`; check the 4 MiB body limit. |
| `UNKNOWN_OPERATION` | The operation is absent or not in discovery. | Call `grid_discover`; use an exact tool name. |
| `INVALID_ARGUMENT` | A tool argument fails its input schema, or cohort references span runs/generations. | Fix required fields, types, bounds and unknown fields using discovery. Booleans are not integers. |
| `INVALID_QUERY` | Analysis state is invalid: unknown run/target/dimension/level/cluster, duplicate condition, wrong edge/order, or generation mismatch. | Read status and schema; use IDs and keys from that run. Query cluster IDs on the same snapshot before selecting them. |
| `PROJECT_REQUIRED` | The operation needs a project, but the server was started with results only. | Connect to a server started with `serve --project DIR`. Analysis remains available on results-only servers. |
| `ANALYSIS_RUNTIME_MISSING` | `node` is absent from the server's PATH. | Provide Node.js 18+ on the server and restart with a new connection-file path. |
| `ANALYSIS_TIMEOUT` | The headless calculation exceeded 120 seconds; `retryable: true`. | Narrow context, reduce replay edge or interaction order. Retrying the same expensive query may time out again. |
| `ANALYSIS_FAILED` | The headless worker returned no readable result. | Check Node.js version and the checkout; retry after correcting the runtime problem. |
| `SNAPSHOT_EXPIRED` | The capture expired, was evicted, or belongs to a previous server instance. | Omit `snapshot` to capture again. Retain the question's state; reset `edge` to null if latest rows are wanted. Rediscover IDs if the run changed. |
| `STALE_REFERENCE` | Server instance, run generation, row index or recorded identity no longer matches. | Analyze again and select new member/row references. Never substitute an index alone. |
| `UNKNOWN_REQUEST` | No receipt exists for that `requestId` in this project. | Check project and ID. Retry the original intent with the same ID if a lost response is suspected. |
| `REQUEST_CONFLICT` | A durable ID was used with a different operation or arguments. | Recover its receipt. A genuinely new intent needs a new ID; a retry needs the original arguments. |
| `OUTCOME_UNKNOWN` | Intent was recorded but no final receipt was committed. Grid refuses to execute it again. | Inspect receipt, status, manifests, runs and cohorts for evidence. Reconcile the side effect before deciding on a new intent. Automatic replay is unsafe. |
| `OPERATION_FAILED` | Project/Limen/I/O rejected an operation. Examples: stale manifest version, invalid name, unavailable recording, incompatible cohort, or failed validation. | Read the message and relevant status/logs. For a stale manifest, reread, reconcile and validate before a new save/start ID. Failed write receipts are durable; corrected arguments need a new ID. |

An HTTP 200 means Grid accepted the protocol, not that the operation succeeded.
Read `ok`. `grid_validate` can return `ok: true` with a nonempty `result.errors`:
the validator ran successfully but the manifest is invalid. An analysis can
return `available: false`, null statistics or `withheld: true` without an error.

## Lost write responses

1. Keep the original request unchanged, including its ID, manifest version and
   member references. Reconnect with the server's current credential if needed.
2. Call `grid_receipt` with that ID. A `complete` receipt contains `response`,
   the original success or failure envelope. Use it as the outcome.
3. If no receipt exists, resend the original intent with the same ID. If another
   request already completed it, Grid returns the original response.
4. A `running` receipt or `OUTCOME_UNKNOWN` needs reconciliation. It can survive
   a crash indefinitely; waiting alone does not turn it into a completed job.

Receipts live in the project's `.grid/agent-requests/`, survive server restarts,
and have no automatic expiry. Do not delete them to force a repeated operation.
Different requests for the same project share this journal.

## MCP failures

MCP separates JSON-RPC errors from tool failures. A tool failure is a successful
JSON-RPC reply whose `result.isError` is true and whose `structuredContent` is
the Grid error envelope above. The text content is a copy of that envelope.

| JSON-RPC code | Meaning | Recovery |
| --- | --- | --- |
| `-32700` | Malformed JSON line | Send one complete JSON object per line. |
| `-32600` | Request is not a JSON-RPC 2.0 object | Set `jsonrpc` to `"2.0"`; use a request ID when a reply is wanted. |
| `-32601` | Unsupported method | Use `initialize`, `ping`, `tools/list` or `tools/call`. |
| `-32602` | Params are not an object, tool name is unknown, or arguments are not an object | Discover tools and send object arguments. Field validation failures use Grid's `INVALID_ARGUMENT` envelope. |

Notifications (requests without `id`) receive no response. A malformed connection
file prevents adapter startup: it exits 1, writes a diagnostic to stderr and
does not produce an initialization reply. The adapter accepts protocol revisions
`2025-11-25`, `2025-06-18` and `2024-11-05`; otherwise it returns its newest
supported revision. The client must decide whether that revision is acceptable.

## Implemented limits

| Limit | Value and consequence |
| --- | --- |
| HTTP request body | At most 4 MiB (4,194,304 bytes); oversized requests return HTTP 413 / `INVALID_REQUEST`. |
| Server analysis runtime | 120 seconds per headless query. |
| JSON CLI/MCP HTTP timeout | 150 seconds. Some project/Limen operations can exceed this; use receipts after a lost write response. |
| Limen control-command timeout | 180 seconds; this bounds commands such as validation, not the lifetime of a started run or predictor job. |
| Status wait | `timeout`: integer 0–30 seconds, default 0. `afterVersion` waits for sweep changes, not every project/job transition. Poll status for job completion. |
| Snapshots | Four per server instance, ten minutes from capture. The fifth capture evicts the oldest; reuse does not extend lifetime. Restart removes them. |
| Analysis pagination | `limit`: 1–1000, default 100; `offset`: 0–run row count. Trials rank only the best 100 before pagination. These fields do not bound other analysis payloads. |
| Cohort selection/references | 1–100 members, default selection count 5. References must share one run/generation; actual rounds must be distinct and locally recorded. |
| Pair interaction order | 2–6, default 2. An explicit `pair` must contain that many distinct dimension IDs. Higher orders use the UI's bounded candidate search. |
| Pair search candidates | At most 26 eligible dimensions. Higher-order plans use a 2,000-set cap and a row-work budget of 400 million (with a minimum plan budget of 50 sets). Read `plan`/`sets` to see actual coverage. |
| Cluster count | `clusterK`: null (automatic) or 2–7. Small/sparse runs may have no clusters. |
| Agent run rounds | Integer 1–1,000,000. Shards: at least 1, no more than rounds or the server's cores. Multiple shards require random search. Shares are rounded up, so total planned rounds may exceed the requested total. |
| Experiment/predictor name | 1–64 characters: first character is ASCII letter, digit or underscore; remaining characters may also be hyphens. |
| Predictor provenance | Serialized `how` JSON may contain at most 65,536 characters. Store the selection question and capture identity rather than an entire analysis payload. |
| Statistical support | Summaries with `n < 30` withhold `mean`, `lo`, `hi`, `lift`, `delta` and `keep` where present; support is retained. It is not a blanket guarantee that every diagnostic is suppressed. |
| Numeric transport | Nonfinite/missing numbers become JSON null. Never interpret null as zero. |

Use [the reference](agent-reference.md) for field meanings and
[workflows](agent-workflows.md) for concrete calls and result handling.
