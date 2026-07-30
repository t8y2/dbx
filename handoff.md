# 🤝 Context Handoff

## Meta
- **exported_at**: 2026-07-24T21:38:36.3992945+08:00
- **exported_from**: opencode
- **session_id**: a8f3c1

## Project
- **name**: dbx
- **stack**: Rust, TypeScript, Vue 3, Tauri, Axum, PNPM
- **root**: D:\Developments\jetbrains\workspace\rust\dbx
- **package_manager**: pnpm

## Current Task
We are finishing the review-driven stabilization of the Schema Diff and synchronization tool. The main active blocker is in `crates/dbx-core/src/query.rs`, specifically `execute_schema_diff_deploy`, which currently distinguishes `committed`, `rolled_back`, and `mixed`, but still needs a stronger DDL atomicity model based on both target database behavior and SQL type semantics. This affects the Desktop and Web deploy flow exposed through `src-tauri/src/commands/query.rs`, `crates/dbx-web/src/routes/query.rs`, and the frontend orchestration in `apps/desktop/src/components/diff/SchemaDiffDialog.vue`. In parallel, we documented the overall problem and optimization plan in a new requirements doc and completed a long-term DDL architecture refactor that introduced `DdlDialectProfile` and `type_rewrite` for cross-database DDL generation.

## Progress
- [x] Merged latest `origin/main` into local `main`, then merged local `main` into local `cmp`
- [x] Preserved cmp branch functionality after merge, including schema-diff deploy and rollback completeness changes
- [x] Replaced fake per-statement 2PC deploy path with `execute_schema_diff_deploy` single-connection deploy result flow
- [x] Unified Schema Diff DDL panel execution and deploy-review confirmation through the same guarded frontend path (`executeDeploySql`)
- [x] Added structured rollback completeness fields: `rollbackCompleteness` and `missingRollbackObjects`
- [x] Blocked incomplete rollback execution in the frontend UI (button disable + toast + confirm-dialog gate)
- [x] Fixed `two_phase_commit` mixed-status logic to avoid re-running `commit()` as a probe
- [x] Added `detectTableRenames` option and separated table-rename detection from column rename detection
- [x] Aligned Schema Diff field mapping type source with table structure editor using `listDataTypes(connectionId, database)` + `getDataTypeOptions(dbType)`
- [x] Introduced `crates/dbx-core/src/sql_dialect/ddl_profile.rs`
- [x] Introduced `crates/dbx-core/src/sql_dialect/type_rewrite.rs`
- [x] Migrated CREATE/ALTER table, index, FK, comment, trigger, rename, and permission SQL generation onto profile/type-rewrite driven behavior
- [x] Reworked MySQL -> Access CREATE TABLE generation to use Access-compatible types and `COUNTER`
- [x] `execute_schema_diff_deploy` classifies atomicity by DB capability (`CAP_TRANSACTIONAL_DDL`) + SQL risk + transactional path
- [x] Unit tests cover MySQL/Oracle partial DDL failure → `mixed` + executed_count, Postgres → `rolled_back` + 0
- [x] Frontend `deployTxResult` maps mixed/rolled_back with executedCount/statementCount
- [x] Merged main into cmp; fixed functional-index test 10-arg call site
- [ ] Optionally finish template-level profile datafication for function / sequence / rule / owner SQL shapes
- [ ] Live DB e2e for deploy partial-failure (optional; unit/web structured tests already present)

## Active Files
- `handoff.md` — this handoff document for the next AI
- `需求问题/2026年7月24日-结构比对与同步工具-问题与优化方案.md` — new problem statement and optimization plan based on current code
- `crates/dbx-core/src/query.rs` — `SchemaDiffDeployResult` and `execute_schema_diff_deploy`; current blocker lives here
- `src-tauri/src/commands/query.rs` — Tauri deploy endpoint now delegates to `execute_schema_diff_deploy`
- `crates/dbx-web/src/routes/query.rs` — Web deploy route now delegates to `execute_schema_diff_deploy`; includes tests
- `crates/dbx-core/src/two_phase_commit.rs` — mixed / rolled_back logic no longer probes by re-calling `commit()`
- `crates/dbx-core/src/schema_diff.rs` — main schema diff DDL generation path; profile-driven create/alter/index/fk/comment/trigger logic
- `crates/dbx-core/src/script_generator.rs` — idempotent wrapper and lock-timeout behavior now profile-driven
- `crates/dbx-core/src/sql_dialect.rs` — exports for new ddl_profile and type_rewrite modules
- `crates/dbx-core/src/sql_dialect/ddl_profile.rs` — target `DatabaseType` profile registry and DDL behavior knobs
- `crates/dbx-core/src/sql_dialect/type_rewrite.rs` — type rewrite pipeline and auto-increment helpers
- `apps/desktop/src/components/diff/SchemaDiffDialog.vue` — unified protected deploy flow, rollback completeness handling, field mapping dialog wiring
- `apps/desktop/src/components/diff/SchemaDiffDdlPanel.vue` — rollback incomplete banner and execution block props
- `apps/desktop/src/components/diff/SchemaDiffDeployStep.vue` — deploy-step rollback incomplete banner and disabled deploy state
- `apps/desktop/src/lib/schema/deployTxResult.ts` — deploy result status/message mapping including `mixed` and `rolled_back`
- `apps/desktop/src/lib/schema/__tests__/deployTxResult.spec.ts` — frontend unit tests for deploy result interpretation
- `apps/desktop/src/lib/schema/schemaDiff.ts` — frontend types for `SchemaDiffPreparation`, rollback completeness, and missing rollback objects
- `apps/desktop/src/components/diff/FieldMappingPanel.vue` — field mapping types now use the same live/static source strategy as table structure editor
- `apps/desktop/src/components/diff/FieldMappingDialog.vue` — passes source/target connection and database context into field mapping panel
- `apps/desktop/src/types/database.ts` — expanded frontend deploy result / transaction fields
- `apps/desktop/src/i18n/locales/en.ts` — new rollback incomplete strings and detect-table-renames strings
- `apps/desktop/src/i18n/locales/zh-CN.ts` — Chinese strings for rollback incomplete and table rename detection
- `apps/desktop/src/i18n/locales/zh-TW.ts` — same strings for Traditional Chinese
- `apps/desktop/src/i18n/locales/es.ts` — same strings for Spanish
- `apps/desktop/src/i18n/locales/it.ts` — same strings for Italian
- `apps/desktop/src/i18n/locales/ja.ts` — same strings for Japanese
- `apps/desktop/src/i18n/locales/pt-BR.ts` — same strings for Brazilian Portuguese
- `crates/dbx-web/src/state.rs` — added `WebState::for_tests` helper to avoid missing new fields in scattered test fixtures
- `crates/dbx-web/src/routes/connection.rs` — updated tests to use `WebState::for_tests`
- `crates/dbx-web/src/routes/mongo.rs` — updated tests to use `WebState::for_tests`
- `crates/dbx-core/tests/api_contract_verification.rs` — full options initializer updated with `detect_table_renames`
- `crates/dbx-core/tests/bidirectional_diff_e2e.rs` — rename detection test updated to enable table rename detection explicitly

## Blocker
PR #3861 owner review items (2PC fake prepare, structured rollback, status mapping) are implemented on `cmp`.
Residual risk: no live MySQL/Oracle integration test against a real server for partial DDL failure; classification is covered by pure unit tests + web structured endpoint tests.
GitHub still may show `mergeable_state: dirty` until rechecked after push.

## Key Decisions
- The table structure editor must **not** be modified further in this task.
- Schema Diff field mapping must use the same type source strategy as table structure editor: `listDataTypes(connectionId, database)` plus `getDataTypeOptions(dbType)` fallback.
- Do **not** revert to `listDialectDataTypes` for field mapping dropdowns.
- Cross-database DDL generation must be driven by `DdlDialectProfile` + `type_rewrite`, not by scattered `if Access` / `if Mysql` / `if SqlServer` branches in generators.
- `profile_for(DatabaseType)` is the only acceptable place to register target-database-specific DDL behavior.
- Incomplete rollback must remain structurally represented (`rollbackCompleteness`, `missingRollbackObjects`) and blocked in the UI.
- Schema Diff deploy execution paths must remain unified through a single protected frontend flow using `executeWithProductionSqlGuard`.
- `two_phase_commit` must never determine partial commit state by re-running `commit()`.

## Environment
- Runtime version: not fully verified locally; Rust workspace compile on this Windows host is limited by missing OpenSSL/Perl toolchain for some crates
- Relevant env vars: GitHub Actions workflow issues referenced `I18N_BOT_TOKEN`; local work did not rely on it
- Dev command: `pnpm check` for frontend; Rust checks typically via `cargo check` / `cargo test`
- Package manager: `pnpm`
- Platform: Windows local development, CI issues referenced Linux runners
- Known local limitation: `cargo check` for the full workspace can fail or hang due to OpenSSL build prerequisites (`perl` missing) on this machine

## Next Steps
1. Push latest `cmp` and re-request review on PR #3861 with a short reply mapping each review point to commits.
2. Optionally add live MySQL/Oracle partial-DDL e2e if CI has those services.
3. Optional architecture cleanup: move function/sequence/rule/owner templates fully into `DdlDialectProfile` data.

## For the Next AI
- Read all Active Files before doing anything.
- Do NOT change Key Decisions without flagging first.
- Start from `crates/dbx-core/src/query.rs`; that is the last review blocker that is still not fully solved.
- Treat the new DDL profile architecture as the canonical direction; do not reintroduce scattered database-specific generator branches.
- Do not touch table structure editor code.
- Use the requirements doc in `需求问题/2026年7月24日-结构比对与同步工具-问题与优化方案.md` as the planning baseline.

---

✅ handoff.md written to project root.
Switch to your next tool and run /handoff-load to continue.

Summary:
- Task: finalize Schema Diff deploy correctness and long-term DDL profile architecture
- Next step: replace pool-kind DDL atomicity heuristic with database+SQL semantic classification in execute_schema_diff_deploy
- Blocker: MySQL/Oracle and other non-transactional DDL paths may still report rolled_back too optimistically
