# Mongo tasks and scheduling / Mongo 任务与调度

This is a bounded, **read-only foundational task runner**, not Studio 3T's complete task/scripting engine.

## Available

- Save, edit, delete, manually run and cancel workflows of 1–20 sequential `find` / `aggregate` steps. Total task definition limited to 256 KiB. Each step selects a saved native MongoDB connection/database/collection. Stops on first error.
- Enable an elapsed-time interval (1–525600 minutes), with next-run time calculated by the backend in UTC. UI polls **status only**; Rust executes tasks independently of dialog/browser lifetime.
- Shared desktop/Web service, SQLite WAL + FULL synchronous transactions, atomic queue/claim/cancel, optimistic definition revisions, one queued/running run per task, and a process-held `fs2` file lock per data directory. The OS releases the lock on process death. Do not place the database/lock on a network filesystem with unreliable locking.
- Durable history and bounded result samples: latest 100 terminal runs plus up to 100 pending runs; five canonical Extended JSON documents per step, 64 KiB total per run. Samples **may contain sensitive data**. Protect the DBX data directory. Full query definitions are also persisted; no credentials are copied into task definitions.
- On restart: formerly running runs become `interrupted`, not replayed; queued jobs survive. Missed interval ticks are coalesced into one run. No catch-up storm, retry loop, or claim of exactly-once remote execution.
- Each step has a 1–1000 row cap, 1–300 second local timeout and server `maxTimeMS`, `allowDiskUse: false`, a bounded first batch of at most the row cap plus one; server-side limits let successful bounded reads exhaust the cursor. A result that hits the cap is explicitly marked and must not be interpreted as a collection total.
- Cancellation persists in SQLite, is polled by the backend every 500 ms, drops in-flight futures/cursors and prevents later steps. Cancellation is best-effort server-side: an already submitted read can run until its server timeout; there are no write effects to roll back.
- Separate per-run connection state, loaded from saved connection definitions; no interactive pool mutation. Saved credentials are required for all queued runs, including manually enqueued runs, because execution/recovery must not borrow an interactive session secret.

## Explicit boundaries

- Desktop process or Web server **must remain running**. No OS startup registration or standalone Mongo worker is installed. Closing the dialog/tab does not stop backend execution; quitting DBX or shutting down the host does. For unattended work, keep the server running under the user's service manager.
- Native Mongo driver only; Legacy Agent is rejected at execution because bounded cursor/cancellation behavior cannot be guaranteed. Scheduled OIDC/SSH setups that require interactive prompts may fail; configure unattended credentials or use interactive queries.
- No writes, `$out`, `$merge`, `$where`, `$function`, `$accumulator`, change streams or arbitrary commands/scripts. Allowed aggregate stages are validated recursively, including `$lookup`, `$facet`, `$unionWith` subpipelines. Unknown stages fail closed. A write must use the separate manual preview/confirmation workflow, **not** an unattended task.
- Steps are independent reads, not a transaction, DAG, shared-variable script runtime, export/backup, notification engine or cross-step data transformation. Only sampled results are retained.
- Fixed intervals only; no cron, day-of-week/local-calendar/DST schedule UI yet.
- Web endpoint inherits the same existing authenticated API boundary and base-path behavior as backup commands. Tasks are shared within the server data directory; there is no additional per-task user ACL.

## Integration

- Core: `dbx_core::mongo_tasks::{MongoTaskCommand, MongoTaskService}`.
- Tauri command `mongo_task_command`; worker starts at app initialization and shuts down before shared database state.
- Web `POST /api/mongo-tasks`; worker starts alongside backup scheduling and stops on server shutdown.
- UI `MongoTasksDialog.vue`, `v-model:open`, optional `prefillConnectionId`, `prefillDatabase`, `prefillCollection`. English, Simplified Chinese, and Traditional Chinese translations are provided, with the application fallback for other languages. Host toolbar/AppDialogs must provide the entry point.
- Frontend calls use `backend/api.ts` forwarding with the standard Tauri `invokeBackend` update-preparation guard/error normalization and HTTP `post` base-path/auth handling; there is no direct invoke bypass.

## Verification

Rust tests cover validation/write rejection, bounded find conversion, durable queue/recovery, stale revisions, duplicate/concurrent enqueue, queued cancellation, missed-interval coalescing, and file locking. Frontend tests cover editor shape/bounds and active-run state.

Run:

```sh
cargo test -p dbx-core --no-default-features --features sqlite-bundled --lib mongo_tasks
cargo test -p dbx-driver-mongodb --lib
cargo check -p dbx-web --locked
pnpm exec vitest run apps/desktop/src/lib/backend/mongoTasks.spec.ts apps/desktop/src/i18n/__tests__/mongoTasks.spec.ts
pnpm typecheck
```

The ignored `crates/dbx-core/tests/mongo_tasks_live.rs` integration test uses only an explicitly provided `DBX_MONGO_FIXTURE_PORT` on localhost. Provision a disposable MongoDB instance with test commands enabled before running it. It verifies scheduling, cancellation, timeout and cursor cleanup, and must not target a user database.
