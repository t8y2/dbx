# DBX Observation Analyst (test companion plugin)

A frontend-only plugin that **verifies** the host observation bus against the
three target workloads — debugging, performance analysis, and audit — by
aggregating the live event stream into requirement-shaped metrics.

## What it proves

| Requirement | Metrics this plugin surfaces |
| --- | --- |
| 调试 (debugging) | Recent-error table (`query.finished` errors, `ai.error`, `connection.open_failed`, `plugin.activate_failed`), live event feed, per-kind counters, dropped-event counter from explicit host gap notices |
| 性能分析 (performance) | Query duration **p50 / p95 / max**, duration histogram, slowest-statement top 10, rows returned, avg connection-open duration, events/min throughput |
| 审计 (audit) | Bounded JSONL audit buffer (20k events) with one-click clipboard export + preview, plugin activate-failure tracking, AI token accounting (`agent_finished` input/output) |

## Verification recipe

1. Package and install:

   ```bash
   dbx-plugin package plugins/examples/observation-analyst
   ```

2. Open **Plugins → Observation Analyst**.
3. Exercise the host and watch the panel react:
   - run queries (including one that fails) → query KPIs, latency histogram, error table;
   - connect/disconnect a connection → connection KPIs;
   - run one AI agent turn → tool calls, approvals, token counters;
   - start a table import/export or database export → transfer snapshot table;
   - install/stop any plugin → plugin KPIs.
4. Press **Copy JSONL audit log** and paste the stream into a file for offline
   assertions (every line is the raw envelope `{id, tsMs, kind, …}`).

Expected invariants while the panel is open:

- `DROPPED (ID GAPS)` stays `0` under normal load; growth means the bus
  dropped events under back-pressure (bounded by design).
- Every `query.started` is eventually paired by a `query.finished` with a
  matching `executionId`.
- `ai.text_delta` / `ai.reasoning_delta` appear in the stream (UI-only kinds);
  an audit sidecar would **not** receive them (see below).

## Sidecar (audit persistence) note

This companion is UI-only. A plugin that must **persist** the audit stream
declares the same `host.observe:*` permissions on a backend entrypoint and
receives id-less `host/observation` notifications on stdin while running —
delta kinds are excluded there by design. Use
`plugins/examples/hello-workbench`'s Rust/Go sidecar skeleton as the base and
answer `host/observation` like any other notification (no response frame).

## Related

- `plugins/examples/activity-monitor` — minimal live stream viewer.
- `docs/content/docs/plugin-development.mdx` → *Host Observation Events*.
