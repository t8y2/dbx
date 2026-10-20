# SDD ledger - plan: docs/specs/970-mysql-binlog-recovery/plan.md

- Issue claimed using `/claim`; bot confirmed assignment to caichangqing1120.
- Base: 87f1432fc4c3c2e5e8b42c52eb05beafc2b423c2 (origin/main, 2026-10-20).
- Branch: codex/issue-12838-binlog. Original checkout's untracked files preserved.
- Pre-flight: Task 2 consumes Task 1's inspect/Inspection API; Task 1 must
  establish RowChange's typed visitor boundary. Task 3 consumes test evidence.
- Ruling: use a standalone probe, not a shipping crate yet. The dependency has
  truncated-input/unchecked indexing hazards requiring audit before production
  exposure; independent Cargo workspace avoids activating binlog in all drivers.
- Environment: Rust/Cargo 1.95.0. Docker, mysql, mysqld and podman were not on PATH.
  No real MySQL restore test has run. No baseline full-app suite has run because
  this stage does not modify the shipping workspace or frontend.

## Verification evidence

- Task 1 RED: 1 test passed / 5 failed against the no-implementation API.
  GREEN: 6 passed / 0 failed after strict framing/checksum implementation.
- Task 2 RED: 8 passed / 5 failed before row inspection/diagnostics;
  GREEN: 13 passed / 0 failed. CLI RED: 1 failed (exit 1 placeholder).
  CLI GREEN and full standalone suite: 14 passed / 0 failed.
- `cargo test --offline --locked --manifest-path examples/mysql-binlog-probe/Cargo.toml`:
  14 integration tests passed; no unit/doc tests, no ignored tests.
- `cargo fmt --manifest-path examples/mysql-binlog-probe/Cargo.toml -- --check`:
  exit 0. `cargo clippy --offline --locked --manifest-path
  examples/mysql-binlog-probe/Cargo.toml --all-targets -- -D warnings`: exit 0.
- First offline dependency resolution lacked miniz_oxide 0.9.1; fetched package
  dependencies using the existing system proxy for that command only, then
  repeated locked offline checks. No persistent network configuration changed.

## Local dependency fixture observations

Read-only CLI runs against the pinned dependency's local `test-data/binlogs/`;
these files are NOT copied or redistributed. These observations are supplemental,
not deterministic repo tests and not an independent reference decode.

| Fixture | Observed inspection result |
| --- | --- |
| minimal_row_metadata.000001 | MySQL 8.0.40; 8 events, 1 row, 1 commit, 1 partial row |
| time_issue.000001 | MySQL 8.0.40; 8 events, 1 row, 1 commit, no unsupported events |
| json.binlog.000001 | MySQL 8.0.22; 36 events, 12 rows, 6 commits; 3 unsupported events (2 QUERY, 1 partial JSON) |
| binlog_transaction_with_GTID.000001 | MySQL 5.6.24; 11 events, 0 rows, 1 commit; 3 unsupported QUERY events |
| transaction_compression.000001 | MySQL 8.0.32; 5 outer events; compressed payload explicitly unsupported, no embedded rows decoded |
| write-full-row.binlog, write-partial-row.binlog, update-full-row.binlog, update-partial-row.binlog | Exit 1: outside the probe's CRC32 FDE scope; no claim about their row contents |
| binlog_truncated_event.000001 | Exit 1: truncated header at position 4 |

## Conclusions and next gates

- A pure-Rust local-file path is feasible, with no external mysqlbinlog process.
  Typed BIGINT unsigned maximum, signed integers, SQL NULL and arbitrary bytes
  round-trip through authored row fixtures without a JSON-number intermediate.
- FULL images may lack column names and key definitions. Optional signedness may
  also be absent; the library then uses defaults. The visitor exposes metadata
  presence, but cannot establish trustworthy schema or restoration eligibility.
- Before shipping, audit/fuzz the parser's internal indexing and allocation paths,
  bound table-map state, and decide how to handle missing checksum metadata,
  unknown types and compressed payloads. The 16 MiB outer-event cap is not a full
  memory bound or an untrusted-input safety guarantee.
- Next implementation slice: transaction model/order and explicit selection
  closure, trusted historical schema contract, then typed inverse-SQL generation
  with conflict/abort tests. Desktop integration follows that tested engine.
- Still unverified: actual MySQL 8.0.27 generate/restore/field comparison,
  DECIMAL/JSON/temporal value equality, FK/trigger behavior, cross-platform
  distribution, full transitive license review and DBX editor script atomicity.
- No shipping code, root Cargo manifests/lockfile, frontend or user DBX data changed.
  No commit, push, PR, production operation or additional issue comment performed.
- Transaction counters are observational only; a successful file scan does not
  establish transaction closure or detect an event-aligned open transaction.

## Independent review

- Fresh read-only reviewer found no important issue within the explicit probe
  scope and independently reran the initial 14-test suite successfully.
- Added both nonblocking coverage suggestions: sparse bitmaps crossing the eighth
  column with multiple rows/NULL values, and a valid complete checksummed frame
  containing an internally truncated row. These test existing production paths;
  no behavior was changed to satisfy them.

## Stage-1 final state

- Task 1: complete (no commits; framing and row tests verified).
- Task 2: complete (no commits; standalone CLI verified).
- Task 3: complete (evidence and limitations recorded; independent review done).
- Final locked offline suite: 16 passed / 0 failed / 0 ignored. Final fmt check
  and clippy all-targets with warnings denied: exit 0. New-file whitespace check
  includes the untracked deliverables, not only git diff.
- Stage-1 completion means offline probe delivery only. The product MVP and real
  MySQL restore acceptance are not complete, and no shipping capability is exposed.

## Stage 2: recovery engine (current work)

The user explicitly requested development to continue. Tasks 1-3 above are
historical stage-1 evidence, not a description of the new current file layout.
The worktree/base/branch and original user checkout remain unchanged.

- Task 4: complete. Moved the parser to the new reusable dbx-binlog crate and
  kept the probe as an adapter. Added complete transaction collection, GTID,
  rollback handling, EOF/nesting/orphan rejection and whole-file SHA256.
  RED: 17 passed / 2 failed; GREEN: 19 passed.
- Task 5: complete. Whole-transaction database/table/time/position/GTID filtering,
  exact-offset export selection, later-unselected-table dependency refusal and
  explicit historical schema validation (hash/range/provenance/attestations,
  columns, types, nullability, names, signedness and primary-key metadata).
  RED for planning/selection: 19 passed / 4 failed; GREEN: 23 passed.
- Task 6: complete within the initial type matrix. Reversed typed actions and
  manual-only guarded SQL. Preserved u64 maximum, bytes/NULL and DECIMAL(30,6).
  In-memory action replay returns to the authored initial state; this is NOT a
  MySQL SQL execution test. SQL RED: 25 passed / 2 failed; GREEN: 27 passed.
- Task 7: complete for offline CLI delivery. Added transactions/recover commands,
  bounded manifest input and no partial SQL on validation failure. CLI RED:
  28 passed / 1 failed; GREEN: 29 passed before review additions.
- Moved engine tests into crates/dbx-binlog/tests so ordinary native workspace
  CI actually runs them; the standalone package retains its CLI subprocess tests.
  Shared binary-fixture helpers are authored repo fixtures, not vendor copies.

### Independent review and fixes

A fresh read-only review found two P1 SQL safety defects; neither was ignored.

1. Stored-procedure local variables could shadow unqualified target column names.
   All row predicates now use dbx_row-qualified columns and matching target
   aliases. Regression fixtures use v_tx_active and v_count column names.
2. AUTO_INCREMENT restoration of key zero could allocate a new key. SQL now saves
   the caller mode, captures STRICT_ALL_TABLES + NO_AUTO_VALUE_ON_ZERO before
   CREATE PROCEDURE, restores caller mode BEFORE CALL and checks captured modes.
   The empty original mode is handled with NULLIF in CONCAT_WS.

The two review regressions were observed RED (28 passed / 2 failed), then GREEN
(30 passed). Added SQLWARNING rollback/error handling, post-DML restored-image or
absence checks, and replaced deprecated BINARY operators with CAST(... AS BINARY).
The reviewer independently re-read the fixes and found both P1 resolved, with no
new P1/P2 regression in the inspected source.

Additional own-review regressions reject logged charset disagreement and values
that fit VARCHAR bytes but exceed character capacity: RED 30 passed / 2 failed,
then GREEN 32 passed. Legacy utf8 schema literals render explicit utf8mb3;
that regression was also observed RED before the renderer fix. Added literal
injection/approximation rejection coverage. Real cross-table filtering is covered
with two distinct table-map IDs, not two rows of the same table.

### Build and verification

- Native package build initially lacked the offline xxhash-rust index entry used
  by the pre-existing Redis workspace dependency. Command-local system proxy use
  resolved the index gap without upgrading existing locked dependencies.
- Root Cargo.toml adds only the dbx-binlog workspace member. Root Cargo.lock adds
  its package record and binlog's existing bitvec/zstd feature dependencies;
  existing dependency versions are unchanged.
- Final native suite: 2 unit tests and 32 integration tests passed, 0 failed,
  0 ignored. Full standalone CLI suite: 2 subprocess tests passed, 0 failed.
  Total: 36 behavior tests. Unit/doc-test targets with no tests are not counted.
- Native and CLI Clippy all-targets with -D warnings: passed. Package formatting
  checks and tracked/untracked whitespace checks: passed.
- Full Desktop/Web application suites, browser checks and actual MySQL execution
  were NOT run; no frontend or shipping runtime path is added in this stage.

### Current delivery boundary

The offline engine and CLI are implemented, not the complete issue MVP. Export
currently supports integer, binary/text and exact DECIMAL; JSON, temporal,
floating-point and other unsupported types refuse export. FULL named/signed/key
metadata plus an explicitly attested historical manifest are required. No schema
is fetched from a live database. Tables with generated columns/triggers/FKs are
out of scope, and full metadata visibility is a manual execution prerequisite.

Remaining shipping gates: isolated MySQL 8.0.27 restoration and conflict/rollback
comparison, datatype expansion, parser resource/fuzz audit, cross-platform checks,
then Desktop preview/export and editor DELIMITER integration. Schema attestations
and permission-filtered information_schema results are not automatic proof of
historical/target safety. Do not use experimental SQL artifacts in production.

No commit, push, PR, further issue writeback, DB connection, SQL execution,
deployment, or cleanup of user files/worktrees has been performed.

## Stage 3: real acceptance, type expansion and worker protocol

Continued on the same isolated branch/work package at user request. This section
supersedes the earlier "no SQL execution/no real MySQL" historical stage notes:
ONLY the new disposable task-owned instance was used, never an existing DB.

### Live MySQL 8.0.27 acceptance

- Downloaded official portable MySQL 8.0.27 macos11-arm64 archive into ignored
  target/live-mysql. Observed MD5 matches the official .md5 artifact:
  aba688984408a82b65fc0eba4032a127. No system service/configuration changed.
- tests/live_mysql.py accepts only mysql-home/probe/artifact paths, initializes a
  NEW data directory, and starts its owned mysqld with --no-defaults,
  --skip-networking, --mysqlx=OFF and a private Unix socket. No existing DB endpoint
  can be supplied. It captures historical schema BEFORE DML, rotates the test
  binlog, generates SQL through the actual CLI and executes on that instance only.
- Final live run: target/live-mysql/runs/dbx-binlog-live-5uxjg5ah (relative to the
  probe package). All 8 acceptance cases passed. Portable evidence and comparison
  hashes: live-acceptance.json. Baseline/restored TSV SHA256 are equal.
- Covered full row insert/delete/update, two original transactions, repeated
  primary-key changes, zero AUTO_INCREMENT key, exact DECIMAL(30,6), binary bytes,
  UTF8 text/NULL, JSON uint64/int64/nested/null/double, DATETIME/TIMESTAMP/TIME
  microseconds, non-UTC caller restoration, post-image and PK conflicts, active
  transaction rollback vs previously committed inverse tx, runtime schema drift.
- Test-only mysql --force inspects the SAME session after deliberate SQLEXCEPTION
  and injected SQLWARNING; both timezone-restoration checks passed. The warning
  case tests the actual handler via injected SIGNAL, not a data-coercion claim.
  Production artifacts still require stop-on-first-error execution.
- Every owned mysqld stopped in finally. Evidence-write failure now cannot skip
  termination: lifecycle fault-injection unittest proved RED then GREEN.

### Engine changes and evidence

- Added modern full JSON and DATETIME2/TIMESTAMP2/TIME2 recovery; opaque typed JSON,
  partial JSON, DATE/legacy temporal, ordinary FLOAT/DOUBLE/ENUM/SET/etc remain
  fail-closed. Integer JSON never goes through JS/floating conversion.
- Authored type tests: RED 33 passed/2 failed before conversion, then GREEN.
  A real MySQL fixture rejected -838:59:59.999999: investigated the server TIME
  endpoint and added a native rejection regression (RED observed before fix).
  Accepted near-endpoint -838:59:58.999999 restores exactly.
- Added table-map count/encoded-state caps and file/event budgets. Map-growth
  regression observed RED before limit implementation. These do NOT solve all
  pinned-parser allocations/indexing hazards or replace fuzz/process isolation.
- Fresh independent review found a JSON key-loss path in upstream DOM conversion.
  Added RED tests for malformed UTF8 keys, key collisions/duplicates, then raw-key
  validation and node/depth budget checks BEFORE DOM conversion. Added 70-deep
  array rejection. The reviewer confirmed the fix on re-read.
- Review also found the live harness reusing a helper after a failed CALL left
  it installed. Actual schema-drift test failed with PROCEDURE already exists;
  re-generate nonce per failed-call replay, then full 8-case live run passed.

### Desktop preparation (not Desktop delivery)

- Added a single-request worker module and CLI --worker entry for paginated
  list/details/generate. No execute, connection or write-file actions. Requests
  limited to 64 KiB, serialized responses to 8 MiB and pages to 100 entries.
- Details/generation require preview SHA256 and reject changed files. Preview
  positions/integers are strings, byte cells are hex and NULL/absent images stay
  distinct. Worker protocol tests observed RED 2 failures then GREEN; actual CLI
  subprocess round-trip is covered. No native Tauri command, toolbar/UI entry or
  Web route is exposed yet.
- Response limit runs after allocation/serialization, so it is NOT a peak-memory
  budget. Regular-file checks do not eliminate open races. Desktop host still
  needs enforced timeout/termination and process resource containment before UI.

### Verification and outstanding work

- Native engine suite: 2 unit + 40 integration tests passed; CLI suite: 3 passed;
  Python lifecycle suite: 1 passed. Total automated non-live behavior tests: 46.
  Native/CLI Clippy all-targets -D warnings and formatting/whitespace checks pass.
- Local frontend dependencies installed with --frozen-lockfile --ignore-scripts
  for later UI work; no frontend source or pnpm lockfile changed. No browser or
  full Desktop/Web test suite ran and no such success is claimed.
- Task 8 is complete for this isolated MySQL8.0.27 tested matrix. Task 9 remains
  partial (broader fuzz/resource/cross-platform gates open). Task 10 remains open;
  only its typed worker protocol has been prepared, not app-host enforcement/UI.
- No commit, push, PR, extra issue writeback, deployment or production operation.
  Original checkout and unrelated worktrees/files remain unchanged.


## Stage 4: Desktop implementation and local validation complete

The user explicitly asked to continue until the Desktop work was implemented.
This section supersedes earlier "Desktop not exposed" phase statements.

### Implemented

- Added optional process-host module with timeout, sampled RSS, bounded pipes,
  cancellation and owned-child kill/reap. Native regressions observed RED against
  the stub, then GREEN using real child/timeout/output/memory cases.
- Wired same-executable early worker entry plus request/cancel/export commands
  into Tauri. No connection/AppState/database execution access. Export helper is
  independently tested against real files: 0600 on Unix, existing-file/symlink
  refusal, .sql-only and nonempty/bounded data. RED observed before helper code.
- Added lazy Desktop-only More-menu dialog: import, seven filters, whole-transaction
  selection/paging, available before/after images, historical evidence, SQL preview
  and explicit new-file export. Input changes invalidate SQL; close cancels and
  ignores late responses. English/zh-CN/zh-TW messages and bilingual website docs.
- Docker dependency-cache scaffold now includes the new workspace crate; this is
  a build-manifest fix, NOT Web runtime exposure or an image build/deployment.

### Review and regressions

- Independent review found two P2: cancellation could beat async admission, and
  absent signedness could display u64 high bits as a definite negative integer.
- Added RED regressions, then bounded cancellation tombstones/permit ownership
  and ambiguous_integer bit-pattern previews with UI warnings. Independent
  re-review closed both findings and found no new P1/P2 in the reviewed scope.
- Browser exposed scoped CSS not reaching the DialogContent root (384px width).
  Corrected the root class and checked real desktop/mobile geometry/screenshots.
- Full frontend run caught direct crypto.randomUUID use, incomplete inherited
  zh-TW messages in autofill parsing, and the async-component test mock's module
  marker. Used the existing uuid helper, completed Traditional translations and
  corrected the test boundary. No safety/architecture tests were removed.
- Added an observed-RED export-retry regression; subsequent successful exports
  now clear the old error. Browser reproduced existing-target refusal followed
  by a successful fresh-target export without stale errors.

### Final evidence

- Full frontend: 1,883 files / 24,712 tests PASS, exit 0 (maxWorkers=4).
  Existing expected happy-dom localhost diagnostics/SQLite warnings remain in
  stdout; no failing/unhandled tests. An earlier full run was RED and is not used
  as delivery evidence.
- Frontend vue-tsc PASS with command-local 6 GiB heap. Default heap previously
  exhausted; ignore-scripts setup also required building the existing mongo-shell
  package's type declarations. No unrelated source or package versions changed.
- Native cargo check PASS: --offline --locked -p dbx --no-default-features
  --features sqlite-bundled (x86_64-apple-darwin, debug=0). Initial long build
  captured an old dependency API while edits were in flight; stopped that known
  failed task-owned check and reran against stable sources. Final current-source
  check passed; no claim of a signed/full-default-feature release build.
- Rust engine: 4 unit + 41 integration PASS; standalone CLI: 5 integration PASS.
  Native/CLI Clippy all-targets -D warnings PASS. Architecture suite: 28 PASS;
  originally caught missing Docker workspace manifest, fixed scaffold then GREEN.
- Actual editor parser processed the generated export into 7 executable MySQL
  statements, exactly one intact CREATE PROCEDURE, zero client DELIMITER commands
  and retained the rollback/RESIGNAL handler. This was read-only parser validation,
  NOT execution in a DBX database connection.
- Actual browser: real Vue component -> owned IPC test bridge -> real latest CLI
  worker over the authored MySQL8.0.27 log -> private SQL artifact. Verified import,
  filters, selection, preview/generate/export, existing-target retry, stale export,
  empty/invalid states, en/zh-CN, 1440x1000 / 390x844 and light/dark. Signed native
  WebView IPC/startup has not been run. See desktop-validation.json.
- Browser session binlog12838 closed; owned Vite server stopped; task browser
  records preserved under ignored target/browser/playwright-records. Unrelated
  Chrome and the pre-existing apollo-continue session were not touched.

### Current boundary

Desktop feature code and local checks are complete for the documented experimental
scope. Remaining RELEASE gates: actual signed/native app startup + WebView IPC,
Windows/Linux/default-feature matrix, broader parser fuzz/hard process policies,
and explicitly unsupported types (DATE/ordinary float/etc.). The previous 8-case
real MySQL8.0.27 restore evidence remains applicable: this stage changes UI/IPC/
process hosting and preview uncertainty, not the validated inverse SQL engine.

No commit, push, PR, extra issue writeback, release, user-DB connection or automatic
SQL execution. Original checkout/unrelated changes remain preserved.

## PR #12880 CI follow-up (2026-10-20)

- Initial delivery: `fbbae1d2f61f95fe2e70bbe570b7fd2a6de1b824` was pushed to
  `fork/codex/issue-12838-binlog` and opened as PR #12880. The preceding
  no-push statement describes the pre-delivery checkpoint, not current status.
- CI run `39399502677`: `fast-checks` rejected the missing `dbx-binlog` Rust
  group entry. `rust` and `agents` were consequent gate failures, not compiler
  errors. Register the crate in `application`, update the planner fixture's
  desktop dependency, and test binlog-specific routing and Windows selection.
- I18n run `39399502584`: the translation provider returned empty content for
  Thai after processing earlier languages. Add explicit Spanish, Italian,
  Japanese, Korean, Brazilian Portuguese, Russian and Thai messages locally;
  preserve safety warnings and placeholders. No workflow checks are disabled.
  The autofill dry run against `origin/main` now needs no translations or API.
- Regression evidence: missing locale exports were RED (7 failed, 3 passed),
  then all 10 locale exports passed key/placeholder parity. Planner routing was
  RED before registration, then all 113 planner/gate tests passed. Local Cargo
  is Homebrew 1.95, not rustup: a temporary `/tmp` adapter strips only `+stable`
  and delegates to real Cargo for the actual workspace metadata test. CI still
  uses its configured Rust 1.97.1; no repository toolchain checks were changed.
- Grouped Cargo feature coverage passes, including `dbx-binlog/process-host`
  in the application lane. Architecture contracts (28), binlog UI/client and
  translation tests (20), whole-frontend formatting, workspace Rust formatting
  and generated connection-type checks pass. Final i18n regressions pass
  (19 files / 1,603 tests), including explicit root-locale registration without
  English fallback masking omissions. Frontend vue-tsc also passes with its
  command-local 6 GiB heap. Remote rerun remains a separate
  delivery gate; local checks do not establish an all-green PR.
