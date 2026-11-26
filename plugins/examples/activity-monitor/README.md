# DBX Activity Monitor (example plugin)

A frontend-only plugin that streams DBX's host observation events into a live
table — the seed for debugging, performance-analysis and audit plugins.

It declares all five observation permissions:

| Permission | Events |
| --- | --- |
| `host.observe:queries` | `query.started`, `query.finished`, `query.message` |
| `host.observe:connections` | `connection.opened`, `connection.open_failed`, `connection.closed`, `connection.liveness_lost`, `connection.idle_closed` |
| `host.observe:ai` | `ai.turn_*`, `ai.tool_call_*`, `ai.approval_*`, `ai.text_delta`, `ai.reasoning_delta`, `ai.agent_finished`, `ai.error`, … |
| `host.observe:transfers` | `transfer.progress` (transfer, database export, table import/export, SQL file, Mongo, Dameng, query-result export) |
| `host.observe:plugins` | `plugin.activated`, `plugin.activate_failed`, `plugin.status_changed`, `plugin.stopped` |

UI features: per-category filters, pause/resume, clear, dropped-event counter
(host gap notices) and a payload inspector.

## Run it

In the SDK dev host (no DBX desktop needed):

```bash
cd plugins/sdk/dev-host && npm ci && npm run build
cargo run --manifest-path plugins/sdk/cli/Cargo.toml -- dev --path plugins/examples/activity-monitor
```

The dev host has no real DBX activity, so simulate events through the mock API
(the dev host applies the same gate as the desktop bridge: only registered
kinds whose category permission the manifest declares are delivered):

```bash
curl -X POST http://127.0.0.1:5190/api/observations/publish \
  -H 'Content-Type: application/json' \
  -d '{"event":{"id":1,"tsMs":1730000000000,"kind":"query.finished","payload":{"sql":"select 1","status":"ok","durationMs":12}}}'
```

In DBX desktop, package and install it:

```bash
dbx-plugin package plugins/examples/activity-monitor
```

Then open **Plugins → Activity Monitor** and run a query, connect/disconnect,
start an AI agent turn, or run an export — events appear live.

## Notes for real plugins

- `ai.text_delta` / `ai.reasoning_delta` are UI-only; a sidecar receives every
  other AI event but not the deltas, so persist the final answer from the
  `text` field of `ai.agent_finished` (`response_complete` is CLI-only and
  non-terminal).
- SQL text, tool arguments/results and summaries are capped at 16 KiB; a
  clipped field carries `<field>Truncated: true`.
- The bus drops events under back-pressure and tells subscribers through
  `onHostGap(({ skipped }) => ...)`. Do not infer drops from `id` gaps: ids are
  host-global while delivery is filtered per permission, so gaps are normal.
- Sidecars only receive observations while already running; observation never
  activates a plugin.
