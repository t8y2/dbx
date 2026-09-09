# Transfer rebuild hardening Implementation Plan

> **For agentic workers:** Use the approved design from the conversation and execute the independent frontend, dependency-check, and regression-test tasks in parallel. Keep core orchestration and integration sequential. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将重建整合为第四种目标表处理方式，并修复本次 review 发现的依赖越界、序列和索引冲突、提前清理和取消恢复问题。

**Architecture:** UI 提供四种互斥策略，API 继续使用 `TransferMode` 与 `dropTargetBeforeCreate`。后端先准备完整备份计划并保存恢复记录，再执行备份、建表、写入和结构恢复，全部必要步骤成功后才清理；Tauri 与 Web 共用编排。确认预览复用后端计划，包含实际限定目标名和 SQL。

**Tech Stack:** Rust / Tokio / existing database drivers, Vue 3 / TypeScript / Pinia, Vitest, Cargo tests.

**Spec:** 本会话用户已确认的 review 与改造方案；原设计背景见 `docs/pips/plans/2026-09-03-transfer-drop-before-create.md`。

## Global Constraints

- 使用现有依赖，离线构建；数据库验证仅在临时实例或临时 SQLite 文件中进行。
- 兼容已有任务的重建布尔字段，不增加第四个底层 DML `TransferMode`。
- 不把生产标记当作永久禁止：复用连接和数据库级生产确认，确认字段仅作用于一次请求。
- 不对未选中的依赖对象执行隐式 CASCADE；预检无法确认安全时在第一条 DDL 前报错。
- 普通追加、清空、Upsert 的行为保持兼容；重建模式以 INSERT 写入新表。
- 所有对象名称经方言 quoting，备份名称按对象完整身份派生并预检冲突。
- 回归测试验证数据库对象与数据结果，不添加源码文本断言。
- 本轮交付可审查的本地修改，不 push 或发布。

## Task 1: 四种 UI 策略及确认流程

**Files:** `apps/desktop/src/components/transfer/DataTransferDialog.vue`, new `transferStrategy.ts` and behavior tests, `stores/transferTaskStore.ts`, `types/database.ts`, `lib/backend/tauri.ts`, transfer locale keys and user documentation.

**Interfaces:** Existing `TransferRequest` stays compatible. `TransferOwnershipPreview` gains optional `rebuild: { sql: string; tables: Array<{ sourceTable: string; targetTable: string; backupTable?: string }>; warnings: string[] }`. Preview and actual execution use the same frozen request and transfer ID.

- [ ] Write behavior tests for legacy task migration and mutually exclusive request mapping.

```ts
expect(resolveTransferStrategy({ mode: 'upsert', dropTargetBeforeCreate: true })).toBe('rebuild');
expect(transferStrategyOptions('rebuild')).toEqual({ mode: 'append', dropTargetBeforeCreate: true });
```

- [ ] Run the new tests and observe failures before implementation.
- [ ] Add four-way strategy selection. Structure-only offers keep/rebuild; data-only and unsupported targets disable rebuild with a reason.
- [ ] Freeze the request before preview/confirmation. Display backend rebuild SQL; combine destructive and production confirmation without instructing users to disable protection.
- [ ] Normalize saved legacy rebuild tasks, keep confirmation transient, update all eight locales and docs including malformed JSX quotes.
- [ ] Run covering Vitest tests and frontend typecheck.

## Task 2: 依赖预检

**Files:** `crates/dbx-core/src/transfer_rebuild.rs` and its tests.

**Interfaces:** Preserve `ensure_no_external_incoming_foreign_keys`. Add `ensure_no_external_table_dependencies(state: &AppState, target_pool_key: &str, target_database: &str, target_schema: &str, target_tables: &[String], target_database_type: DatabaseType) -> Result<(), String>` for rebuild planning and cleanup verification.

- [ ] Add a real SQLite regression that creates parent/external child with `ON DELETE CASCADE`, runs preflight, and verifies rejection before mutation.
- [ ] Add PostgreSQL dependency SQL coverage and live regression for a target-only dependent view.
- [ ] Implement SQLite incoming-FK metadata checks and dependent-view checks with quoted values/identifiers; refuse unsafe or uninspectable dependencies.
- [ ] Keep MySQL, PostgreSQL, Oracle and SQL Server incoming-FK checks; include schema identity and normalized table matching where required.
- [ ] Run the targeted tests; the temporary external table and its rows must remain intact.

## Task 3: 备份计划及生命周期

**Files:** `crates/dbx-core/src/transfer.rs`, `transfer_rebuild.rs` integration, focused new core module if appropriate, `storage.rs`, `src-tauri/src/commands/transfer.rs`, `crates/dbx-web/src/routes/transfer.rs`.

**Interfaces:** Keep `rename_tables_to_backup` and `transfer_table` public signatures compatible. Add serializable recovery records with qualified source/target/backup identities, SQL, operation state and error/cancellation outcome. Ownership preview gains the optional rebuild preview from Task 1.

- [ ] Reproduce failed source-sequence ownership and colliding long PostgreSQL index names with live regression tests.
- [ ] Resolve all actual target names, source structure, backup names and collisions before the first DDL; propagate metadata lookup errors for rebuilds.
- [ ] Rename owned PostgreSQL sequences and indexes with hashes containing each object's identity; abort on rename errors and retain complete recovery information.
- [ ] Free MySQL backup FK names using atomically replaced constraints on backup tables, preserving referenced backups and ON UPDATE/DELETE rules.
- [ ] Persist the recovery plan before mutations and update execution state; terminal errors/cancellation expose retained backups and manual recovery SQL.
- [ ] Share the orchestration between desktop and Web. Use typed internal cancellation and preserve the public cancellation event.
- [ ] Restore all deferred constraints and selected schema objects before cleanup. Never issue broad `DROP ... CASCADE`.
- [ ] Break only backup-to-backup FK cycles during final cleanup; a cleanup failure reports retained objects without claiming the whole rollback set remains intact.
- [ ] Use the same prepared DDL and actual target identifiers for preview and execution.

## Task 4: 集成回归及审查

**Files:** `crates/dbx-core/tests/live_mysql_transfer.rs`, `live_postgres_transfer.rs`, new SQLite rebuild regression tests, existing frontend behavior tests.

- [ ] Add regression cases for PostgreSQL SERIAL/identity ownership, shared long index prefixes, external views, MySQL cyclic FKs, SQLite external children, partial rename cancellation, failure before final cleanup, and successful cleanup.
- [ ] Verify red before the relevant fixes, then run green against temporary PostgreSQL and MySQL servers and temporary SQLite databases.
- [ ] Run `RUST_MIN_STACK=8388608 cargo test --offline --locked -p dbx-core --no-default-features --features sqlite-bundled --lib transfer`.
- [ ] Run relevant frontend Vitest cases, `pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json`, and Rust checks for core/Web/Tauri with available local features.
- [ ] Request an independent code review, fix actionable findings, inspect the final diff and working-tree state.

## Progress

- Baseline: commit `c3e417a9a`, clean working tree; prior review verified 45 frontend and 265 core transfer tests passing.
- Branch: `codex/transfer-rebuild`; use the current clean workspace to keep the user's local changes directly reviewable and reuse offline build caches.
- Task 1 (UI strategies): `transferStrategy.ts` + 26 behavior tests, legacy-task migration and store coverage (23 tests) all passing; `vue-tsc --noEmit` clean; locales and dialog updated.
- Task 2 (dependency preflight): `ensure_no_external_table_dependencies` (incoming FKs + dependent views) implemented with SQLite/PG-family/MySQL-family/Oracle-family/SQL Server/DuckDB coverage; wired into `rename_tables_to_backup` before the first rename. 24+ module tests pass.
- Task 3 (backup lifecycle):
  - Backup-name collision preflight is now all-or-nothing before any rename (red test fixed).
  - Cancellation keeps its exact `"Cancelled"` discriminator; retained-backup annotation is appended only to real failures (red test fixed).
  - PostgreSQL-family pre-pass renames owned sequences and indexes with per-object identity hashes; listing/rename failures abort instead of being swallowed.
  - Recovery journal (`transfer-rebuild:<id>` in the existing state store) is persisted before the first rename and updated per step; removed after successful cleanup.
  - New `free_backup_foreign_key_names` frees MySQL backup constraint names atomically before the deferred FK ALTERs.
  - Cleanup order: table loop → free constraint names → deferred FK ALTERs → schema objects → `drop_backup_tables` (which now breaks the backup-to-backup FK graph first, fixing "Cannot drop table ... referenced by a foreign key constraint" seen with Flowable schemas).
- DDL planning shared: `transfer/ddl_plan.rs::prepare_table_ddl` replaces the inline block in `transfer_table_inner`; rebuild mode fails closed on incomplete columns, unreadable source DDL, and failed FK inspection.
- Verification: 283 core transfer lib tests pass (2 prior red tests fixed); full dbx-core lib suite 5653 passed with one pre-existing environment failure (`external_driver_preview_retry_preserves_marker_truncation`, JDBC plugin timeout, reproduced on the clean baseline); `dbx-web` and Tauri `dbx` `cargo check` clean; frontend Vitest (49) and `vue-tsc` clean.
- Live regression (temporary Docker `postgres:16-alpine` + `mysql:8.0` on loopback ports 55432/53306, cleaned up afterwards):
  - PostgreSQL rebuild tests: 4/4 passed (`rebuilds_same_named_serial_sequence`, `rebuilds_indexes_with_shared_long_prefix`, `rebuild_rejects_target_only_view_before_any_rename`, `drop_target_rebuilds_structure_and_indexes`).
  - MySQL `drop_target` tests: 5/5 passed, including the Flowable-style `parent_child` FK, the `circular_foreign_keys` cleanup (the `ERROR 3730` scenario), and `retains_backup_on_failure`.
- Recovery semantics (user decision "B"): `create_transfer_target_table` was extracted, and the rebuild path now creates the target table from the source DDL *before* reading the source column list. A source column-read failure therefore still leaves the empty new table + retained backup behind (drop the empty table, rename the backup back).
- Ownership preview gains the optional rebuild plan: `TransferOwnershipPreview.rebuild` (`TransferRebuildPreview` with `sql`/`tables`/`warnings`) is built by `build_rebuild_preview` — pure planning that reuses the same resolution, backup-name derivation, dependency preflight, and DDL planning as execution, so the confirmation dialog shows the real rename/create/cleanup statements. A SQLite regression (`transfer_rebuild_preview_plans_without_executing_ddl`) verifies it plans without renaming anything.
- Final verification: 284 core transfer lib tests, PostgreSQL rebuild 4/4, MySQL `drop_target` 5/5, `dbx-web` + Tauri `dbx` `cargo check` clean, `vue-tsc` clean.
- Pending: an independent review pass.
