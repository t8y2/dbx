# Protocol and failure contract

## State machine

1. Accept a numeric-loopback client with a bounded startup deadline
2. Reject unsupported startup protocol, replication/options, or oversized metadata
3. Match connect/drop rules before opening the upstream connection
4. Open exactly one numeric-loopback upstream; relay authentication, parameters
   and backend cancel key; accept PostgreSQL 17 / protocol 3.0 only
5. Process one frontend message at a time. Parse/Bind/Describe/Close/Execute are
   followed by a proxy-generated Flush so the proxy can observe their completion
   before accepting the next dependent message. This is serialization, not a pool
6. On an extended ErrorResponse, discard frontend messages until Sync, forward
   Sync, and use the actual ReadyForQuery transaction state to resume
7. Reject a second Execute (or its Parse/Bind) before Sync, MaxRows-limited Execute,
   unsupported protocol messages, and multi-statement Query/Parse. Close both
   sockets; never forward a trailing unsupported statement
8. On Terminate, disconnect, deadline, rule abort, cancellation of a paused
   operation, or shutdown, close both sockets and remove session/barrier state

Named prepared statements map to fingerprints and commands. Bound portals map to
those statement descriptions. Unnamed replacement invalidates the previous map
before forwarding. The map is updated only after ParseComplete/BindComplete;
CloseComplete removes its entry. Portals survive Sync inside a transaction and
are discarded when ReadyForQuery is idle. Raw SQL and bind parameters are not
retained in the controller. Prepared/portal names are capped at 128 bytes, maps
at 256 entries, wire bodies at 1 MiB, active connections at 16 by default (max 64),
rules at 128, events at 512 and control requests at 64 KiB.

Default pauses time out after 15 seconds. Each active upstream operation and
idle frontend read has a 30-second deadline; the core accepts bounded overrides.
The upstream read budget is per operation, not refreshed on each row. Control
connections have a 3-second deadline and 16 concurrent handlers per endpoint.
Shutdown closes listeners/sockets and joins handlers. Rules, events and barriers
are in memory only. There is no durable crash-recovery journal.

## SQL boundary lexer

PostgreSQL remains the SQL parser. A conservative lexer scans quotes, dollar
quotes, line comments and nested block comments to enforce one statement. It
accepts ordinary SELECT, INSERT, UPDATE, DELETE, WITH, transaction/savepoint
commands, SET/SHOW, and transactional CREATE/ALTER/DROP/TRUNCATE. Empty/comment-only
queries are accepted, including pgx/database/sql's Ping. Identifiers and values
are not parsed into a query model.

Backslashes inside quoted strings/identifiers are intentionally rejected rather
than guessing escape semantics; use bind parameters. Changing
standard_conforming_strings, database/tablespace/system DDL, SQL PREPARE/EXECUTE,
2PC, CALL/DO, COPY, and replication are excluded. This is an explicit narrow lab
contract, not a general-purpose PostgreSQL firewall or complete SQL validator.

## Where a rule stops execution

- `connect`: after startup metadata is known, before dialing PostgreSQL; drop only
- `execute`: before forwarding a Simple Query or Extended Execute
- `commit`: before forwarding explicit COMMIT/END, or before the Sync that ends
  one successful implicit extended transaction

An ordinary simple-protocol autocommit statement has no client-visible wire
boundary between execution and commit. If a commit rule would apply, the proxy
rejects that statement **before forwarding it**, with an explanatory error. It
does not claim to pause after execution. Use an explicit transaction or the
ordinary extended protocol when that boundary is required.

Rule hits are consumed under one mutex. Each matching pause has a unique ID,
connection, rule and deadline. Resume affects only that pause. Abort/timeout
terminates both sockets before the held message is forwarded. Rules remain
bounded even if the controller disappears. Expired/exhausted rules are pruned on
matching/inspection; stored rules are always capped. Deleting a rule does not
release an already-existing barrier.

## Truthful transaction outcomes

- `upstream_success` records an original CommandComplete, never an injected result
- `upstream_error` records only the original SQLSTATE in observation data
- `injected_abort` / `injected_drop` with `not_forwarded` means the held request
  was not sent. It does **not** assert that backend cleanup is already complete
- `uncommitted_connection_closed` means an uncommitted connection was closed;
  PostgreSQL will clean up its transaction. Integration tests separately prove
  the aborted row is absent and the transaction's advisory lock was released
- `committed` requires an original COMMIT CommandComplete, or successful
  ReadyForQuery after a potentially committing autocommit/implicit Sync operation
- `rolled_back` requires an original ROLLBACK CommandComplete for the whole
  transaction. ROLLBACK TO SAVEPOINT is not reported as whole-transaction rollback
- `rejected` requires an observed upstream error followed by synchronization
- `unknown` is recorded when a potentially committing message was forwarded but
  the confirmation was lost. Never automatically replay it or tell the caller it
  definitely rolled back. The application must reconcile idempotently

Read-only simple autocommit SELECT may also produce a `committed` transaction
completion event: it is not a claim that rows changed. Result delivery can fail
after the server confirms commit; the confirmed transaction event remains true.
If the entire proxy process is killed, its in-memory events are lost; a missing
event is never proof of rollback or success.

Original PostgreSQL response messages, including business errors/results, are
forwarded to the application. The plugin/CLI/MCP observation path omits SQL,
bind values, result rows, passwords, backend PID/secret cancel keys and server
error text. SQL fingerprints are deterministic hashes, not secrecy guarantees
against guessing a known statement.

## Cancel and TLS

CancelRequest uses a separate client connection. Only a PID/key belonging to a
currently live proxied session is routed to this instance's fixed upstream;
unknown keys are dropped. A paused request is cancelled locally and both sockets
close. A running request's cancellation is forwarded on a fresh upstream socket,
then the main connection follows normal PostgreSQL error/Sync recovery. This
retains PostgreSQL's inherent cancellation race; cancellation is not a guarantee
that a COMMIT was undone.

TLS and GSS encryption are explicitly unsupported. The proxy returns `N` to
negotiation, and a TLS-required client fails. Both upstream and proxy are
loopback-only, for new disposable clusters. There is no transparent TLS MITM,
certificate installation, downgrade of a real deployment, or secret-store access.

## Security boundary

The native sidecar is trusted code, as in DBX's existing platform. Loopback alone
is not authentication. Observe and injection control listeners have independent
32-byte random process-lifetime capabilities; an observer cannot obtain the
injector capability through snapshots/MCP. Mutating dispatch also checks the
core's immutable AllowInjection flag. A local process with memory/debug access to
the same OS identity is outside this boundary; this is not multi-user isolation.

A saved DBX connection must explicitly acknowledge disposable data. Tunnels and
changed runtime endpoints are rejected. UI calls and MCP use the same bounded
controller; MCP calls require the host-bound connection and retain the host's
per-action approval rules. Standalone MCP discovery returns a static catalog without
starting any listener; explicitly mutating lab_start/lab_stop own lifecycle. The
saved connection read-only flag and injection opt-in are rechecked on calls. No third-party network APIs, public listeners,
persistent tokens, OS security changes or business-application instrumentation
are part of the MVP.
