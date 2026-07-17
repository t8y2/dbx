# Agent Protocol v2: Multi-session runtimes

Protocol v2 allows one Agent process to serve multiple isolated database sessions. The handshake advertises `protocolVersion: 2` and the `multi_session` capability. DBX falls back to the v1 one-process-per-pool lifecycle when that capability is absent.

## Session lifecycle

- `open_session` creates one logical database session. Parameters contain the normal connection fields plus `agentSessionId`.
- Every connection-scoped RPC contains `agentSessionId`.
- `validate_session` validates and, where supported, reconnects only that session.
- `cancel_session` cancels active statements and cursor fetches for only that session; other sessions in the runtime continue normally.
- `close_session` closes the session connection, query cursors, and table-read cursors without affecting other sessions.
- `shutdown` closes all sessions and terminates the runtime.

`agentSessionId` identifies a logical database connection. Existing `sessionId` fields remain pagination cursor identifiers and must not be used as logical connection identifiers.

## Concurrency

Requests for different sessions may execute concurrently. Requests for the same session are serialized because connection state, transactions, schema changes, and driver connections are not generally safe for concurrent use. JSON-RPC responses may be returned out of order and are correlated by request `id`.

## Runtime compatibility

Runtime reuse keys include the Agent driver key, executable or JAR path, launch arguments, working directory, JRE selection, JVM options, classpath-affecting options, and native executable version boundary. Host, account, schema, and credentials belong to sessions and are not part of the runtime key.

Etcd and ZooKeeper retain the legacy path because they use the key-value Agent protocol rather than the SQL session contract. Older Agent binaries and JARs also remain on the legacy path.

## Resource limits and recovery

A runtime accepts at most 256 logical sessions. Closing the final session starts a 30-second grace period before the process exits, preventing rapid tab open/close cycles from repeatedly starting a runtime. Process EOF fails all pending requests; the failed runtime is removed from reuse and recreated on demand. Connection validation and reconnect operate on a single logical session.

## Driver author guidance

Use `MultiSessionJsonRpcServer(YourAgent::new)` for Java SQL Agents so each logical session receives a new `DatabaseAgent` and JDBC connection. Do not store connection, statement, cursor, transaction, or schema state in static mutable fields. Use the session execution context for paged query resources. Native Agents must provide equivalent per-session state and synchronized stdout writes.

The Xugu native Agent keeps one database connection per logical session plus one shared control connection per database endpoint. Because `go-xugu-driver` does not interrupt network reads through `context.Context`, cancellation records the server-side session ID and calls `DBMS_DBA.KILL_SESSION_TRANS` through the shared control connection.
