# SQL server output

## Scope

- Desktop PostgreSQL native connections forward server notices to Messages while SQL is running, including manual transactions. Output already received remains visible after cancellation or a SQL error.
- Notices are associated with the physical PostgreSQL connection and the desktop execution ID. The subscription is removed when the statement future completes or is dropped. Old notices are discarded before another user statement.
- Desktop events are batched every 100 ms and flushed before the command returns. Live output retains at most 1,000 messages or 1 MiB per execution, followed by an explicit truncation warning. Each PostgreSQL statement and Kingbase cursor also bounds its retained notices.
- The Kingbase Go agent captures the pinned `gokb` driver's NOTICE callback, preserving severity, SQLSTATE, detail and hint. Messages survive normal queries, paged commands, cursor pages, batches and transaction results.
- JDBC results expose warnings in `messages`, including paged statements with and without rows. Existing synthetic Message rows remain unchanged for compatibility.
- This change does not introduce live output for JDBC or the Web HTTP transport. Those paths still display messages after execution returns.

## Reproduction

```sql
SET client_min_messages = NOTICE;
DO $$
BEGIN
    FOR message_index IN 1..10 LOOP
        RAISE NOTICE 'Real-time message at %', clock_timestamp();
        PERFORM pg_sleep(2);
    END LOOP;
END $$;
```

Messages should become available during execution. Cancel after the first few messages and confirm that they remain visible. Replace the loop with a NOTICE followed by `RAISE EXCEPTION` to exercise the error path. A subsequent `SELECT 1` must not inherit the previous statement's notices. Identical repeated messages must remain separate occurrences, without being duplicated by the final response.

## Verification (2026-10-11)

- PostgreSQL 18.6 on the test server, through an SSH tunnel: native notice output before completion, successful completion, SQL error, cancellation, subsequent-query isolation, and existing command notice capture pass targeted nextest tests.
- Frontend tests cover execution-ID filtering, listener cleanup, output during execution, cancellation retention, repeated messages, and reconciliation with the final response.
- The Kingbase Go agent passes its tests with the race detector. Its notice integration test also passes against the test server's PostgreSQL 18.6 using the actual pinned `gokb` driver. This validates the callback and result serialization, not Kingbase-specific runtime behavior.
- JDBC executor tests cover warnings with ordinary rows, paged commands without a driver-specific reader, and paged rows without replacing existing result data.
- Final validation: 106 frontend tests, 26 JDBC executor tests, Go race tests, affected-package Rust checks, and Vue type checking pass. The combined native notice nextest run passes all 9 tests; 2 receive nextest LEAK status (inherited output handles remain open after test exit), without assertion failures.
- No Kingbase server instance or image is available on the test server. Verification against the reporter's Kingbase version remains outstanding.

## Reference implementations

- DBeaver's `PostgreServerOutputReader` extends `AsyncServerOutputReader`; `SQLEditor` reads running statement output independently of completed query results. Its asynchronous reader intentionally avoids connection-wide warnings, which can block cancellation.
- The pinned Kingbase driver is `gitea.com/kingbase/gokb` at `29bd62a876c3`. Its [notice callback source](https://gitea.com/kingbase/gokb/src/commit/29bd62a876c3/notice.go) states: “Notice handlers are executed synchronously ... commands won't continue to be processed until the handler returns.” The callback only buffers bounded messages; it does not execute another query.
- [PostgreSQL 18 query protocol](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-SIMPLE-QUERY): “Notices are in addition to other responses, i.e., the backend will continue processing the command.” This permits display before CommandComplete/ReadyForQuery.

The behavior is tracked by discussion #10130 and the Kingbase feedback on merged PR #5451; that earlier PR only added completed-result message display.
