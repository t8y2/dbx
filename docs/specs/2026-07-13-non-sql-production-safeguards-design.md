# 2026-07-13 Non-SQL Production Safeguards Design

## Context

Production markers currently protect SQL writes through a shared frontend confirmation flow and restrict AI/MCP execution. Dedicated Redis, MongoDB, Elasticsearch, vector database, Etcd, ZooKeeper, Nacos, and message queue write APIs bypass that SQL-oriented flow. Most backend routes check only `read_only`, and several Redis and MongoDB aggregate paths have incomplete read-only enforcement.

The implementation must start from `main`, remain focused on production safety, preserve existing connection configuration compatibility, and follow the repository's Tauri/Web dual-backend architecture.

## Goal

Every user-accessible write operation against an explicitly marked production scope requires a fresh confirmation before execution. AI Agent and MCP writes remain blocked on production. Desktop and Web backends reject production writes when the current request does not carry explicit confirmation.

## Non-Goals

- Adding new product-specific production scopes such as Elasticsearch index, vector collection, key prefix, Nacos namespace, or MQ topic.
- Changing the existing SQL risk taxonomy beyond fixes required for non-SQL operation classification.
- Treating production as permanently read-only for human operators.
- Adding authentication intended to defend the local backend from a malicious local process.

## Recommended Approach

Generalize the existing SQL production guard into an operation guard while retaining the SQL helper as a compatibility wrapper. A guarded operation supplies its connection, optional database, operation label, review text, and execution callback. After confirmation, the callback receives request-scoped production authorization that is forwarded to the backend.

Add a shared Rust write-policy helper that checks, in order:

1. ordinary connection `read_only` state;
2. connection-level `is_production` state;
3. Redis logical database or MongoDB database membership in `production_databases`;
4. request-scoped production confirmation.

Dedicated Tauri commands and Web routes call this helper before mutation. Raw command/request surfaces use product-aware classifiers and conservatively treat unknown operations as writes. This creates one policy contract without changing persisted connection data.

## Alternatives Considered

- Frontend-only wrappers: smaller, but direct backend calls and future entrypoints can silently bypass production safety.
- Hard backend read-only for production: strongest and simplest enforcement, but conflicts with the existing product behavior that allows a human to confirm an intentional production write.
- Short-lived server-issued confirmation tickets: stronger protocol separation, but the local backend cannot prove that a human saw the dialog, and multi-request operations add lifecycle and concurrency complexity without a meaningful security gain for the current trust model.

## Design

### User-visible behavior

- Every production write initiated from a dedicated UI shows the existing production confirmation dialog with a product-specific source and an operation preview.
- Confirmation is never remembered. Repeating an action asks again.
- One user action that performs a batch of backend calls asks once and forwards authorization only to calls belonging to that action.
- Cancelling the dialog performs no mutation.
- Non-production behavior remains unchanged.

### Scope resolution

- Redis resolves production by logical database number.
- MongoDB resolves production by database name.
- Elasticsearch, Qdrant, Milvus, Weaviate, ChromaDB, Etcd, ZooKeeper, Nacos, and MQ use connection-level production scope only.
- The connection dialog disables database-level production selection for non-SQL products other than Redis and MongoDB.

### Frontend ownership

- Extend the production safety store/dialog request from SQL-only data to generic operation review data.
- Add a generic production operation execution guard and retain `executeWithProductionSqlGuard` as a wrapper.
- Route Redis browser/console, document and GridFS browsers, Mongo sidebar administration, vector operations, key-value browsers, Nacos administration, and all MQ mutation panels through the generic guard.
- Keep destructive-operation confirmations that serve a different purpose; production confirmation remains an additional fresh decision.

### Backend ownership

- Define a serializable request-scoped production confirmation field with a backward-compatible default of `false`.
- Centralize production scope and read-only evaluation in `dbx-core` so Tauri and Web use identical rules and error messages.
- Apply the helper to every dedicated mutation endpoint. Core services that are reachable without those endpoints retain or gain their own read-only checks.
- Detect MongoDB aggregate `$out` and `$merge` stages as mutations.
- Fix Redis `ZADD`, `XADD`, and `JSON.SET` read-only gaps in both backends while integrating production checks.
- MQ send, raw admin requests, Nacos raw requests, and arbitrary Redis commands use their existing mutation classifiers plus production policy.
- Vector/Elasticsearch REST requests use safe-read endpoint allowlists because POST can be either read or write; unknown POST endpoints are treated as writes.

### AI and MCP

- Production confirmation is never exposed to AI Agent or MCP tool calls.
- Existing SQL, MongoDB, and Redis production blocks remain in place.
- Add regression tests proving specialized or raw non-SQL operations cannot acquire human confirmation implicitly.

## Edge Cases And Risks

- Batch UI actions must not accidentally authorize later unrelated calls.
- A selected Redis/MongoDB production database must remain protected after an in-session database switch.
- Raw REST POST classification requires explicit read allowlists for search/query endpoints.
- Existing HTTP clients omit the new field, so omission must safely mean unconfirmed.
- Some files contain both guarded SQL calls and unguarded non-SQL calls; tests must inspect individual call sites or shared API contracts rather than only checking whether a file imports the guard.

## Verification

- Unit tests for production scope resolution and each non-SQL mutation classifier.
- Frontend tests for confirm, cancel, non-production bypass, database-level Redis/MongoDB scope, and batch behavior.
- Tauri/Web tests proving unconfirmed production mutations fail and confirmed mutations reach the underlying operation.
- Regression tests for MongoDB `$out`/`$merge` and Redis `ZADD`/`XADD`/`JSON.SET` ordinary read-only protection.
- Static entrypoint coverage tests for every dedicated write API.
- Run `make cargo-check-fast`, focused Rust tests, focused frontend/package tests, and `pnpm test` when practical.

## Open Questions

None.
