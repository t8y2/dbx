# PIP: 数据传输「创建前删除目标表」

## 状态

Proposed（设计已确认，待实现）

## 摘要

为数据传输新增「创建前删除目标表」选项：勾选后，传输前先把目标表改名为备份表，按源结构重建，写入数据，全部成功后删除备份；任一步失败则保留备份并在错误中回报备份表全名。对齐 Navicat 的「创建前删除目标对象」。

采用 rename-then-drop 而非直接 DROP，因为传输路径不开事务且多数方言 DDL 不可回滚，备份表是唯一可行的恢复手段。

## 背景

当前目标表已存在且结构与源不一致时，传输会 fail-fast，错误原文即：

> DBX does not alter an existing target table's columns during transfer — drop the target table or adjust its structure to match the source first.

见 `crates/dbx-core/src/transfer.rs:1633-1662`（`validate_preexisting_target_columns`）。用户必须离开传输对话框、手工删表、再回来重跑。本功能把这句提示自动化。

`TransferMode`（`transfer.rs:71-78`）目前是 `Append | Overwrite | Upsert`，`Overwrite` 生成单条 `TRUNCATE TABLE`（`:7679-7690`，SQLite/CloudflareD1/DuckDb 用 `DELETE FROM`）。`create_table: bool`（`:189`）在 UI 上没有开关，由传输内容推导（`DataTransferDialog.vue:768`）。

## 已确认的设计决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 数据模型 | **独立布尔字段** `drop_target_before_create`，不新增 `TransferMode` 变体 |
| 2 | 方言范围 | **首版覆盖 14 个标准库**，其余在 UI 禁用并提示暂不支持 |
| 3 | 失败恢复 | **rename-then-drop** 备份策略 |
| 4 | 架构落点 | **方案 4′**：`DdlDialectProfile` 只加数据字段，`build_drop_table_sql` 留在 `db_admin_sql.rs` 作为唯一渲染入口 |
| 5 | 强确认 | **不要求手打库名**，仅 `DangerConfirmDialog` + 生产库闸门 |

### 决策 1 的决定性理由

写入方式 Select 在 `transferContent === 'structureOnly'` 时被 `v-if` 隐藏（`DataTransferDialog.vue:1248`），而「仅结构 + 先删除重建」恰是本功能最正当的用法。做成 Select 第四项会让主场景直接不可达。独立布尔另有三点收益：不污染 `TransferMode`（避免一个字段承担 DDL 与 DML 两个维度）；危险开关有稳定版面位置可挂常驻警告；`transfer.rs:3836`/`:3838`/`:4233` 三处 match 与 `:12475`/`:12575` 两处 `for mode in [...]` 测试遍历全部无需改动。

### 决策 2 的覆盖清单

**启用（14 个）**：mysql、postgres、oracle、sqlserver、dameng、oceanbase-oracle、kingbase、gaussdb、opengauss、kwdb、goldendb、sqlite、duckdb、cloudflare-d1

**禁用并提示暂不支持（10 个，均为 `dataTransfer: true` 但 DROP 语义高危或不适用）**：

| 库 | 禁用原因 |
|---|---|
| mongodb | 无表概念。现有 Overwrite 走 `deleteMany({})`（`transfer.rs:4802-4811`）而非 drop collection；真 drop 会丢索引 / validator / shard key |
| clickhouse | `can_reuse_source_table_ddl` 对其返回 false（断言 `transfer.rs:10663`），重建必丢 ENGINE / ORDER BY / 分区 / TTL |
| hive、spark、kyuubi、impala、argo | managed（非 EXTERNAL）表 DROP 会连带删除仓库目录中的数据文件，删除范围溢出用户勾选的表清单 |
| questdb | 丢 designated timestamp / partition by |
| turso、rqlite | 见「顺带修复」——先修既有 TRUNCATE 分支遗漏再评估 |

## 可行性依据（已有资产）

drop-then-create 在 `transfer.rs` 内已是既定模式，仅未用于表对象：

| 资产 | 位置 | 说明 |
|---|---|---|
| 物化视图 drop-then-create | `transfer.rs:2463-2469` | `generate_postgres_materialized_view_ddls` 返回 `vec![DROP, CREATE]` |
| 触发器 drop-then-create | `transfer.rs:8323-8350` | 进度按两步计数（`:8192` `trigger_step_count = len * 2`） |
| RLS policy drop-then-create | `transfer.rs:6421-6432` | `sort_order` 保证顺序 |
| MySQL routine drop-then-create | `object_source_sql.rs:565-588` | `mysql_drop_routine_if_exists` |
| **子表优先拓扑排序** | `transfer.rs:6790-6859` | Kahn 算法带 `parents_first: bool`；`false` 分支注释明确写明用于 batch drop，已作为 Tauri command 暴露（`src-tauri/src/commands/transfer.rs:418-428`） |
| **表改名生成器** | `db_admin_sql.rs:872-928` | `build_rename_object_sql` + `supports_object_rename:840-869`，**14 库中 13 个已支持** |
| 跨方言 DROP 生成器 | `db_admin_sql.rs:411-430` | `build_drop_table_sql`（不生成 `IF EXISTS`；CASCADE 白名单仅 9 个 PG 系，`:432-447`） |
| SQL Server 条件删除解法 | `schema_diff.rs:3691-3702` | `IF OBJECT_ID(N'..', N'U') IS NOT NULL DROP TABLE` |
| 带 IF EXISTS 的 DROP | `database_export.rs:3379-3381` | 复用 `crate::transfer::qualified_table` |
| 同类选项全栈先例 | `database_export.rs:65` → `tauri.ts:4804` → `DatabaseExportDialog.vue:871-874` | `drop_table_if_exists`，命名与产品语义可对齐 |
| 标识符长度上限常量 | `descriptor.rs:161` | MySQL 64 / PG 63 / SQL Server 128 / **Oracle 30**；目前**零校验消费者** |
| 备份名派生 + 冲突预检范式 | `sqlite_rebuild.rs:493-511` | schema 内容 SHA256 派生（幂等）；冲突即报错，不自动清理不重试换名 |
| 清理失败处理范式 | `table_import.rs:5675-5700` | staging 清理失败视为连接状态污染，直接作废池 |
| 生产库谓词 | `production_safety.rs:111` / `:197` | `DDL_OBJECT_TARGET_RE` 已覆盖 `DROP TABLE [IF EXISTS]`，解析不出目标时 fail-closed |
| 前端生产闸门 | `productionExecutionGuard.ts:15-63` | 已有 20+ 调用点，transfer 链路零接入 |
| 危险操作 UI 骨架 | `useSidebarTableMutationRuntime.ts:100-111` / `:459-497` | 先生成 SQL 预览再弹窗 |
| 强确认组件 | `DangerConfirmDialog.vue:29-60` | 含 `confirmDisabled` / `showSuppressToggle` / `details` |

## 已排除的方案（含前期判断纠正）

### 排除：PG 家族包显式事务以获得原子性

`execute_on_pool`（`transfer.rs:5097-5098`）每次调用都重新 checkout 连接 —— MySQL 走 sqlx 池、PG 系走 deadpool。`BEGIN` 与后续语句会落在不同连接上，`BEGIN` 随连接归还立即回滚，**给出虚假的原子性错觉，比没有事务更危险**。

旁证：MySQL 的 `lock_timeout_sql`（`ddl_profile.rs:351` `SET SESSION lock_wait_timeout = 3;`）在这条路径上本来就是失效的。

Oracle / Dameng / Kingbase（`PoolKind::Agent`，单 client + Mutex + 固定 `agent_session_id`）与 SQL Server（`Arc<Mutex<SqlServerClient>>`）侥幸同会话，但这是实现巧合非契约 —— `PoolErrorAction::ReconnectAndRetry`（`transfer.rs:5060-5081`）会在错误时重建池并换 `pool_key`。

### 纠正：rename-then-drop 不需要同会话

前期误判「多步操作无法保证同会话」会阻塞决策 3。前提事实成立，但推论错误：rename-then-drop 的价值是**可恢复性**而非原子性，每步独立提交恰恰是它能工作的原因。逐失败点见「关键设计 · 失败点状态矩阵」。**无需新增「持连接执行多语句」入口。**

### 排除：激活 `plugins/dialects/*.yaml` 的 drop_table 模板（原决策 4 方案 B）

yaml 里确实已有 `ddl_capabilities.templates.drop_table`（`mysql.yaml:116`、`oracle.yaml:109`）、`online_safety.drop_table`、`destruction_level.drop_table: "FATAL"`，且全部零消费。但缺的不是接线，是整条通路，有三个结构性障碍加一个既有 bug：

1. **`to_descriptor` 根本不读模板**（`dialect_yaml.rs:637-694` 只映射 33 个 bool + `max_length` + `structural_capabilities`）。`templates` / `rollback_templates` / `online_safety` / `destruction_level` 只走「解析 → 存进 `LoadedDialect.yaml` → 回写」的往返。
2. **类型不兼容**：profile 字段是 `Option<&'static str>` 且 struct 是 `Copy`（`ddl_profile.rs:99`），yaml 给 `String`。放弃 `Copy` 会波及全部 `profile_for` 调用点（`script_generator.rs` 四处、`schema_diff.rs` 十处、`type_rewrite.rs:315`、`db_admin_sql.rs:1101`）。
3. **键空间不匹配**：profile 按 `DatabaseType`（80+ 变体），registry 按 `DialectKind`（11 个）。`dameng.yaml` / `kingbase.yaml` / `goldendb.yaml` / `oceanbase.yaml` 的模板永远取不到。
4. **既有 bug**：注册键 = `lowercase(yaml.dialect.name)`（`build.rs:63` + `dialect_loader.rs:117`），查找键 = `kind.label()`（`sql_dialect.rs:73`）。`"PostgreSQL"→"postgresql"` vs `"postgres"`、`"SQL Server"→"sql server"` vs `"sqlserver"` 两处 miss，**postgres 与 sqlserver 一直走硬编码回落**。目前不可见（yaml 与硬编码对 `transactional_ddl` 恰好同值），但意味着任何新增 yaml 字段对这两库都不生效。

改为方案 4′（见阶段 1）。原方案值得单独一个 PIP，约 4-5 人日，回归风险集中在已上线的侧边栏删表与批量删除路径。

## 实现路径

### 阶段 1：方言底座（方案 4′）

**任务 1.1 — `DdlDialectProfile` 新增四个数据字段**

在 `crates/dbx-core/src/sql_dialect/ddl_profile.rs` 的 `DdlDialectProfile`（`:99-167`）新增：

- `drop_table_template: Option<&'static str>`（占位符 `{table}` / `{cascade}`，与既有 `FN_DROP:209` / `SEQ_DROP:214` 同风格）
- `drop_table_supports_cascade: bool`
- `drop_table_supports_if_exists: bool`
- `rename_table_syntax: RenameTableSyntax`（新枚举，参照既有 `RenameColumnSyntax:70-79`）

全部为 `Copy` 兼容类型，不破坏 struct 的 `Copy` 派生。渲染沿用 `render_template`（`:199-205`，纯 `String::replace`，**调用方必须自己先 `quote_ident`**）。

覆盖 6 个 family 构造函数 + `conservative_ansi`：`mysql_family:311`、`postgres_family:356`、`oracle_family:401`、`sqlserver_family:447`、`sqlite_family:492`、`conservative_ansi:627`（⚠️ **DuckDB 落在 `conservative_ansi`（`profile_for:710`），不在 sqlite family**，`create_table_if_not_exists=false`、`type_map` 为空）。

**任务 1.2 — `build_drop_table_sql` 改为读 profile**

`db_admin_sql.rs:411-430` 保持为唯一渲染入口，内部改为读 profile 字段替代硬编码。`supports_drop_table_cascade`（`:432-447`）改为读 `profile.drop_table_supports_cascade`，同时同步前端复制的白名单 `dbAdminSql.ts:322`（两处逐项一致，漏改会导致前端预览 SQL 与后端生成 SQL 分叉）。

**为什么不把函数整体搬进 profile**：`qualified_name_with_quote`（`:1078-1093`，私有）存在的唯一理由是 Cloud Spanner 双方言 —— 连接上报的 `identifier_quote` 必须覆盖静态映射，而 `DdlDialectProfile::quote_ident`（`:174-196`）只认静态 `QuoteStyle`。整体搬迁会撕裂 `identifier_quote` 语义、迫使私有 helper 跨模块提升可见性、让 `supports_drop_table_cascade` 与姊妹函数 `supports_truncate_table_cascade` 分居两处、并让 IoTDB（`DELETE TIMESERIES`）/ InfluxDB（`DROP MEASUREMENT`）特判（`:418-422`）失去归属。

**必须先定真源**：`oracle.yaml:109` 的模板是 `DROP TABLE {table} CASCADE CONSTRAINTS`，而 `supports_drop_table_cascade` 白名单**不含 Oracle**。三个 Oracle 系 yaml 之间也不一致（`dameng.yaml:101` 是 `IF EXISTS`），只因都被 `oracle.yaml` 覆盖才未暴露。本 PIP 以 Rust 侧现状为真源（Oracle 无 CASCADE），yaml 差异记为技术债。

- 验收：单测挂 `db_admin_sql.rs:1573-1594` 现有 `builds_drop_and_clear_table_sql` 旁；覆盖 6 个 family + DuckDB；**Rust 生产调用方仅 2 个**（`src-tauri/src/commands/query.rs:632-635`、`crates/dbx-web/src/routes/query.rs:904-906`），签名不变故零改动
- 工作量：1 人日

**任务 1.3 — `TransferRequest` 新增字段与校验**

`transfer.rs:176-203` 新增 `#[serde(default)] pub drop_target_before_create: bool`（紧邻 `create_table:189`）。`validate_transfer_request`（`:727-743`）拒绝 `drop_target_before_create && content == DataOnly`（措辞参照 `table_import.rs:5925-5935` 拒绝 `create_table` + `Truncate` 的先例）。

Tauri 与 Web 共用 `dbx_core::transfer::TransferRequest`，一次改动双向生效。`crates/dbx-web/src/routes/transfer.rs:623-660` 的 fixture 需补字段。

- 验收：`#[serde(default)]` 保证旧任务反序列化不破；校验单测挂 `transfer.rs:8745` `transfer_validation_tests`
- 工作量：0.5 人日

**任务 1.4 — 补 oceanbase-oracle 的 rename 支持**

`is_oracle_like_rename`（`db_admin_sql.rs:1009-1012`）只列 `Oracle | Dameng | Oscar`，不含 `OceanbaseOracle`，导致 `supports_object_rename` 返回 false、`build_rename_object_sql` 直接返回 `Err`。补一个变体 + 单测（`:2433-2620` 已覆盖 mysql/sqlite/duckdb/postgres/sqlserver/oracle/dameng/oscar）。

- 工作量：0.25 人日

**任务 1.5 — 备份表名生成器（新增）**

读 `descriptor.rs:161 max_identifier_length`（目前零校验消费者），实现「截断 + 短哈希」。`{table}__dbx_bak` 比原名长 13 字符，Oracle 上限 30 意味着原名超过 17 字符即溢出。派生思路参照 `sqlite_rebuild.rs:493-496`（内容哈希，幂等），冲突预检参照 `:498-511`（命中即报错，不自动清理不重试换名）。

- 验收：Oracle（30）/ PG（63）/ MySQL（64）/ SQL Server（128）四个边界各一条单测；长表名不溢出且不同源表不碰撞
- 工作量：0.75 人日

**任务 1.6 — 接入生产库闸门（传输链路首次）**

在 `src-tauri/src/commands/transfer.rs:26`（`ensure_connection_writable` 旁）与 `crates/dbx-web/src/routes/transfer.rs:81-89`（只读拒绝旁）新增：`drop_target_before_create && is_production_database(...)` 时要求请求携带显式确认标记，否则返回可辨识错误码供前端弹确认框。

- 工作量：0.5 人日

### 阶段 2：传输编排与 rename-then-drop

**任务 2.1 — 单表 rename → create 路径，并重置 `target_table_preexisting`**

在建表主流程 `transfer.rs:7364-7592` 的 `:7376` `else` 分支之前插入 rename 备份。本模式下跳过 `validate_preexisting_target_columns`（`:7669-7677`，表即将改名，结构不匹配不再是问题）与 TRUNCATE 判定（`:7679-7690`，新表本就为空）。

⚠️ **最容易漏的一处**：`:7318`（PG 索引抓取）、`:7331`（PG 外键抓取）、`:7595`（`should_restore_postgres_table_schema`）三处均门控在 `!target_table_preexisting` 上。rename 后**必须**把该标志置回 `false`，否则 `source_indexes` / `source_foreign_keys` 会是空 `Vec`，索引与外键**静默不重建**。

- 验收：必须有 live 测试锁定「DROP 模式下 PG 索引与外键被重建」
- 工作量：1 人日

**任务 2.2 — 双趟编排**

rename 顺序（子表先）与 create/insert 顺序（父表先）相反，但现有编排是单趟 per-table 循环、一张表内部完成建表加写数据。改为：`drop_target_before_create` 为真时先按 `parents_first=false`（`transfer.rs:6770`）全量 rename 一趟，再走现有 `parents_first=true` 循环。进度事件需覆盖 rename 阶段（参照 `:8192` 的两步计数）。

⚠️ **Tauri（`src-tauri/src/commands/transfer.rs:160-253`）与 Web（`crates/dbx-web/src/routes/transfer.rs:277-340`）两处必须同步改**，否则 Web API 行为与桌面端分歧。取消（`is_cancelled`，`transfer.rs:6673`）在 rename 预趟中同样生效；成环的表由 `:6846-6856` 追加到末尾而非报错，此行为保留。

- 工作量：1.5 人日（**架构风险集中点**，建议先跑通「无外键多表」再进 2.3）

**任务 2.3 — 外键处理**

传输路径当前对 DROP 被 FK 阻塞**零处理**：无 `SET FOREIGN_KEY_CHECKS=0`（仅 `database_export.rs:2533`/`:3344` 写进导出文件且限 MySQL）；`session_replication_role` / `SET CONSTRAINTS` / `NOCHECK CONSTRAINT` 全仓零命中；`CASCADE` 在 `transfer.rs` 中不存在。

**rename 相比直接 DROP 的关键差异（见「关键设计」）**：MySQL 的 `RENAME TABLE` 与 PG 的 `ALTER TABLE RENAME` 都会让**入向外键跟着走**，改名后其他表的 FK 指向备份表。这与直接 DROP（打断后重建）行为不同，必须显式处理。

可复用的既有 FK 结构：`strip_inline_foreign_key_constraint_lines`（`:4970-4989`）、`supports_deferred_mysql_foreign_keys`（`:1831-1834`）、`generate_mysql_foreign_key_alter_statements`（`:2167-2232`）、`pending_fk_alters` 末尾统一执行（`src-tauri/src/commands/transfer.rs:259-272`）。会话开关的恢复参照 `transfer.rs:1703-1717` 的 `SET IDENTITY_INSERT ON/OFF` 双 result match 补偿模式（本文件唯一的补偿式清理先例）。

⚠️ 注意会话状态不跨 `execute_on_pool` 保留（见「已排除的方案」），`SET FOREIGN_KEY_CHECKS=0` 在 MySQL 池上**不会生效**。MySQL 侧必须靠 rename 顺序（子表先）而非关闭 FK 检查。

- 验收：live 测试覆盖「父子表」与「循环引用」两种拓扑在 MySQL 与 PG 上均能完成
- 工作量：2 人日

**任务 2.4 — 备份表生命周期**

序列：rename 备份 → create 新表 → 写数据 → 全部成功后 `DROP TABLE {backup}`。任一步失败保留备份，错误信息回报备份表全名（文案风格参照 `sqlite_rebuild.rs:508-510`）。删备份失败的处理参照 `table_import.rs:5675-5700`：视为连接状态污染，合并错误串并作废池。

- 工作量：1 人日

### 阶段 3：前端选项与警示

**任务 3.1 — 契约与类型**

`apps/desktop/src/lib/backend/tauri.ts:4566-4585` 的 `TransferRequest` 新增 `dropTargetBeforeCreate: boolean`（紧邻 `createTable:4577`）；`types/database.ts:1438-1455` 的 `TransferTaskConfig` 同步。其余为 `import type` 自动跟随。

⚠️ Rust serde camelCase 与 TS 类型**无任何编译期或 CI 校验**，需人工核对。

- 工作量：0.25 人日

**任务 3.2 — 复选框与联动数据流**

**插入点**：`DataTransferDialog.vue` 的 `:1247`（传输内容 radio 组收尾 `</div>`）之后、`:1248`（写入方式 `<div v-if=...>`）之前。视觉顺序即依赖顺序。

**形态**：原生 `<input type="checkbox">` + `accent-destructive`，包在 `<label>` 内（隐式关联），`pl-5` 缩进表示从属于「传输内容」。

> 已核实：`DataTransferDialog.vue` 内**没有任何复选框**；手搓 `CheckSquare`/`Square` 是 `DatabaseExportDialog.vue` 的写法，该写法有 7 项 a11y 缺陷（完全无法键盘操作、无 role/state、无 name 关联、Space/Enter 无响应、disabled 仅视觉、未勾选态对比度低于 3:1、无焦点指示器）。本文件自身惯用原生 `<input type="radio">`（`:1233`/`:1237`/`:1242`），项目**不存在** shadcn Checkbox 组件。危险复选框范式见 `ObjectBrowser.vue:3785`、`ConnectionTree.vue:2777`。

**数据流（关键，强于 watch 兜底）**：

- `dropTargetBeforeCreateChecked`（ref）只喂 `v-model`，仅服务 UI
- `canDropTargetBeforeCreate`（computed）= `transferContent !== 'dataOnly' && targetSupportsDropRecreate`
- `dropTargetBeforeCreate`（computed）= `canDropTargetBeforeCreate && dropTargetBeforeCreateChecked` —— **这是 `TransferRequest` 与 `currentConfig()` 唯一的读取源**，不可达状态在结构上无法泄进请求体
- 另加一个仅为视觉卫生的 watch（`[transferContent, targetConnectionId]` → 若已不可达则写 `false`）。只写 false，故**不需要** `skip*Watch` 标记

> 反面教训：朴素的 reset watch 会破坏 `loadTaskIntoForm()` —— 它在 `:886` 先设 `transferContent` 再设 `transferMode`，这正是 `:442-451` 那批 `skip*Watch` 一次性标记存在的原因。

**方言门控**：必须用 `effectiveDatabaseTypeForConnection`，**不能**用 `transferDatabaseTypeForConnection`（后者在 `jdbcDialect.ts:97` 会把 doris/starrocks 掩回 `mysql`）。禁用样式照 `DatabaseExportDialog.vue:871` 的 `cursor-not-allowed text-muted-foreground/50`——渲染但禁用，避免版面跳动并让用户看到原因。

**顺带修两处现存缺陷**（各一行）：`:771` 改为 `structureOnly` 时不发送 `transferMode`；`:1222` 的琥珀横幅补 `dark:` 变体（现为 `bg-amber-50 text-amber-700`，暗色主题下浅底浅字；正确写法见 `TableImportDialog.vue:1521`）。

⚠️ `__tests__/DataTransferDialog.spec.ts` 是**源码文本断言**测试：`:59-60` 逐字符 pin 住 `createTable: transferContent.value !== "dataOnly"`、`:12` pin 住 `DialogContent` 完整 class 串、`:23`/`:33-38` pin 住布局 class。触碰这些行必须同步改 spec。

- 工作量：1 人日

**任务 3.3 — 三层警示 + 确认链**

**第一层**（常驻、刻意中性，`text-[11px] text-muted-foreground/70`，与 `contentStructureOnlyHint:1239` 同层级）：说明三步机制。对未勾选项挂红字只会训练用户忽略红字。

**第二层**（勾选后出现，`role="alert"`，`border-destructive/30 bg-destructive/10 text-destructive` + `AlertTriangle`，来自 `@lucide/vue`）。**因采用 rename-then-drop，文案不再是「永久消失」**：

> 目标表及其索引、触发器、约束、注释和对象权限会被替换为源结构。原表会先改名为备份表，传输成功后删除；任一步失败则保留备份，可手工恢复。

行内最高级别且只有这一条。不加第三条横幅、不在勾选时弹 modal、不要求手打——勾选动作本身可逆，不配不可逆级别的摩擦。配色不加过渡动画（危险警示应瞬时呈现，与 `:1222`、`TableImportDialog.vue:1521` 一致）。

**第三层**：`requestStartTransfer()`（`:1012-1015`）按 `dropTargetBeforeCreate` 分流——未勾选走原 `showStartConfirm`（`:1322`），已勾选走 `DangerConfirmDialog`。普通 append 传输不该看到红色弹窗，否则红色贬值。

- **DROP SQL 预览**：照 `useSidebarTableMutationRuntime.ts:108-111` 的「先生成预览再弹窗」。价值最高的元素——它顺带回答「目标表名大小写」（`:1261`）改写后到底操作的是哪个名字。约束：`buildDropTableSql`（`dbAdminSql.ts:298`）是**每张表一次 IPC**，故只生成前 10 条 + 一行 `-- 其余 N 张表省略`（`DangerConfirmDialog` 自身另有 8192 字符 / 200 行截断，`:13-14`）；必须传 `detailsText`（`:149`）声明这是**示例**，实际 SQL 由 Rust 按目标方言生成
- **生产闸门**：把 `:743-745` 的 `ensureReadOnlyWriteAccess` 升级为 `executeWithProductionContextGuard`（`productionExecutionGuard.ts:47-63`，其 `:48` 内部已含 `ensureReadOnlyWriteAccess`，unlock 在 `readOnlyUnlockStore` 中记忆化（`readOnlyWriteAccess.ts:60`），不会二次弹解锁框），`reviewText` 设为 DROP 预览
- **不传 `showSuppressToggle`**（`DangerConfirmDialog.vue:38`）：已保存任务支持一键 Start，此弹窗是该路径唯一关卡

⚠️ `DataTransferDialog.spec.ts:9-11` 断言「只有一个可 resize 的 `DialogContent`」，新弹窗**不能**带 `resize`。

- 工作量：1.5 人日

**任务 3.4 — 任务持久化闭环**

`currentConfig()`（`:846-861`）、`loadTaskIntoForm()`（`:886-889`）、`resetState()`（`:644-648`）三处都要带上新字段；`configSnapshot` / `isConfigDirty` 因整对象 `JSON.stringify`（`:865-875`）自动生效。

- 验收：旧任务（无该字段）加载后为 `false` 而非 `undefined`。照 `transferTaskStore.spec.ts:70`（「keeps target column quoting enabled for saved tasks created before the option existed」）风格补一条向后兼容测试
- 工作量：0.5 人日

### 阶段 4：测试与文档

**任务 4.1 — 单元测试（最先写，无需真实库）**

- DROP / rename SQL 生成的方言单测：挂 `db_admin_sql.rs:1573-1594`（DROP）与 `:2433-2620`（rename）
- 备份名生成器的四个长度边界单测
- `validate_transfer_request` 拒绝非法组合：挂 `transfer.rs:8745`
- 建表流程单测：挂 `transfer.rs:9765` `transfer_content_mode_tests` 或新建 `transfer_drop_recreate_tests`
- 工作量：1 人日

**任务 4.2 — live 集成测试**

`crates/dbx-core/tests/live_mysql_transfer.rs` 的 `fn transfer_request()`（`:69-96`）是新字段第一个落点。**最佳断言范式在 `:707-741`**（插脏数据 → 传输 → 断言脏数据消失）。生命周期沿用 `:651-657` 建 AppState → `:660` `let test_result = async {...}.await` → `:779` 先 cleanup 再 `cleanup.unwrap(); test_result.unwrap();` 的 cleanup-before-assert 结构。

⚠️ **两处既有断言与新模式冲突，必须处理**：

- `live_mysql_transfer.rs:882-895` 断言 `"target row was destroyed by TRUNCATE despite the transfer failing"` —— 锁定「校验必须在 TRUNCATE 之前」。新模式下该校验因 rename 而不必要，需显式决策并在测试中体现等价语义
- `live_postgres_transfer.rs:849-851` `live_postgres_transfer_skips_create_ddl_for_existing_target_table` —— 语义**直接冲突**。另注意该文件**没有任何 Overwrite 测试**

新增覆盖：结构不兼容目标 + 新模式 → 成功；父子外键两表 → rename 顺序正确；PG 索引与外键在重建后存在（对应任务 2.1 验收）；失败时备份表保留且错误含备份名。

跑法：`make db DB=mysql@8.4` → 导出 `DBX_LIVE_MYSQL_TRANSFER_{HOST,PORT,USER,PASSWORD}` → `cargo test -p dbx-core --test live_mysql_transfer -- --ignored`。**`RUST_MIN_STACK=8388608` 必须设置**（transfer future 栈很深，`live_mysql_transfer.rs:104-118` 有 2MB 栈手工线程测试）。

- 工作量：1.5 人日

**任务 4.3 — 文档与 i18n**

文档必改 4 个文件：`docs/content/docs/data-transfer.{mdx,cn.mdx}` 的传输选项表格（各 `:59-70`，另 `:14`/`:48` 也提到写入模式）；**容易漏的** `docs/content/docs/production-safety.{mdx,cn.mdx}:133`（现文案「跨引擎传输和批量导入需要单独检查类型映射、目标表和清空选项」）。

**i18n key 清单**（扁平挂 `transfer.*`，en 插在 `en.ts:5372` 之后、zh-CN 在 `:5356` 之后，与其描述的 content radio 相邻）：

| key | zh-CN | en |
|---|---|---|
| `dropTargetBeforeCreate` | 创建前删除目标表 | Drop the target table before creating |
| `dropTargetBeforeCreateHint` | 先将目标表改名备份，按源结构重建后写入数据，成功后删除备份 | Rename the target table to a backup, recreate it from the source structure, write data, then drop the backup |
| `dropTargetWarning` | 目标表及其索引、触发器、约束、注释和对象权限会被替换为源结构。原表会先改名为备份表，传输成功后删除；任一步失败则保留备份，可手工恢复。 | The target table and its indexes, triggers, constraints, comments, and object grants are replaced by the source structure. The original is renamed to a backup and dropped only after the transfer succeeds; if any step fails the backup is kept for manual recovery. |
| `dropTargetDataOnlyDisabled` | 仅数据模式不建表，删除目标表后不会重建 | Data-only mode does not create tables, so a dropped target would not be rebuilt |
| `dropTargetUnsupportedDatabase` | 该数据库暂不支持此选项 | This option is not yet supported for this database |
| `dropTargetNonTableNote` | 该选项只作用于表；已选中的视图、存储过程等对象不会被删除。 | This option affects tables only; selected views, procedures, and other objects are not dropped. |
| `dropTargetConfirmTitle` | 确认重建目标表 | Confirm rebuilding target tables |
| `dropTargetConfirmMessage` | 将在 {target} 重建 {count} 张目标表并写入数据。原表会先改名备份，成功后删除。 | {count} target table(s) in {target} will be rebuilt and repopulated. Originals are renamed to backups and dropped only on success. |
| `dropTargetConfirmSqlNote` | 以下为示例语句，实际由传输任务按目标方言生成。 | The statements below are illustrative; the transfer task generates the actual SQL for the target dialect. |
| `dropTargetConfirmButton` | 重建后传输 | Rebuild and transfer |
| `dropTargetPreviewOmitted` | -- 其余 {count} 张表省略 | -- {count} more table(s) omitted |
| `dropTargetBackupKept` | 传输失败，已保留备份表 {backup}，可手工恢复 | Transfer failed; backup table {backup} was kept for manual recovery |

⚠️ **漏加 i18n key 不会被任何现有检查捕获** —— 7 个非英语文件都是 `export default withEnglishFallback({...})`（`locales/fallback.ts:29`），缺键静默回退英文；`transfer` 命名空间**没有 parity 测试**；`i18n/index.ts:74-81` 的 `createI18n` 未传 message schema 泛型，`t()` 的 key 不做类型检查。必须人工逐文件核对 8 个语言文件（`en` / `zh-CN` / `zh-TW` / `ja` / `ko` / `es` / `it` / `pt-BR`）。

不需要改：`docs/content/docs/meta.json`（已含 `data-transfer`）、CHANGELOG（`changelog.rs:90-107` 是远端 CDN 读取器，仓库无本地 `CHANGELOG.md`）、知识库（`scripts/build-knowledge-base.mjs` 产物在 `outputs/`，已 gitignore 且不在 CI）。

- 工作量：0.75 人日

## 关键设计

### 备份表命名与冲突

- 命名：`{truncated_table}__dbx_bak_{short_hash}`，总长受 `descriptor.rs:161 max_identifier_length` 约束（Oracle 30 / PG 63 / MySQL 64 / SQL Server 128）
- 哈希从源表限定名 + 传输 id 派生，保证同一传输内幂等、不同源表不碰撞
- 冲突预检：rename 前查询目标库是否已存在该名；命中即报错，**不自动清理、不重试换名**（沿用 `sqlite_rebuild.rs:498-511` 的判断——自动清理一个我们没创建的对象是不可接受的）

### 外键与 rename 的交互

MySQL 的 `RENAME TABLE` 与 PG 的 `ALTER TABLE ... RENAME TO` 都会让**入向外键跟着走**：改名后其他表的 FK 定义指向备份表，新建的同名表不会自动继承这些入向引用。这与直接 DROP（打断后由 `pending_fk_alters` 重建）行为不同。

处理：rename 预趟按 `parents_first=false`（子表先）执行，使被引用表在其引用者之后才被改名；配合现有的 FK 延迟重建机制（`generate_mysql_foreign_key_alter_statements:2167-2232` + `pending_fk_alters` 末尾统一执行）。**不能依赖 `SET FOREIGN_KEY_CHECKS=0`** —— 会话状态不跨 `execute_on_pool` 保留。

### 失败点状态矩阵

| 失败点 | 目标端状态 | 用户可恢复 |
|---|---|---|
| rename 之前（预检 / 权限 / 冲突） | 完全未改动 | 无需恢复 |
| rename 成功、create 失败 | 备份表存在，原名无表 | 是：改回名 |
| create 成功、写数据失败 | 备份表存在，新表空或部分 | 是：删新表、改回名 |
| 写数据成功、删备份失败 | 新表完整，备份残留 | 是：手工删备份（错误串含表名，池已作废） |
| 用户中途取消 | 同上按取消时点 | 是，同上 |

每一步独立提交，不依赖回滚。这是 rename-then-drop 相比直接 DROP 的全部价值。

## 顺带修复与技术债

**建议纳入本次改动**（各一行，与新功能同源）：

- `script_generator.rs:437-443` 对 `DROP TABLE` **无条件**插入 `IF EXISTS`（`CREATE TABLE`/`CREATE INDEX` 分支会查 profile，DROP 分支因 profile 无字段而不查），Oracle 23c 之前生成非法 SQL。任务 1.1 的 `drop_table_supports_if_exists` 字段正好修掉
- `DataTransferDialog.vue:771` 在 `structureOnly` 下仍无条件发送 `transferMode`
- `DataTransferDialog.vue:1222` 琥珀横幅缺 `dark:` 变体

**建议独立提交**（与本功能无依赖）：

- `transfer.rs:7683-7688` 与 `db_admin_sql.rs:552-576` 的 SQLite 系名单漏了 Turso / Rqlite（两者无 `TRUNCATE`，会落到 `TRUNCATE TABLE` 分支）。修完可评估把这两库纳入决策 2 的启用清单

**记为技术债，不在本次范围**：

- dialect registry 注册键与查找键错位（`build.rs:63` + `dialect_loader.rs:117` vs `sql_dialect.rs:73`），导致 postgres / sqlserver 的 yaml descriptor 从未生效。目前不可见但会让任何新增 yaml 字段对这两库失效
- `plugins/dialects/` 的 `templates` / `rollback_templates` / `online_safety` / `destruction_level` 四组数据零消费（`to_descriptor:637-694` 不读）。激活方案见「已排除的方案」，值得独立 PIP
- 三个 Oracle 系 yaml 的 `drop_table` 模板互相不一致（`oracle.yaml:109` 带 `CASCADE CONSTRAINTS`、`dameng.yaml:101` 带 `IF EXISTS`、`oceanbase.yaml:83` 带 `CASCADE CONSTRAINTS`），且与 Rust 侧 `supports_drop_table_cascade`（不含 Oracle）冲突
- `descriptor.rs:451` 的 Oracle `max_identifier_length = 30` 对 Oracle 12.2+ 偏保守（实际支持 128）。保守值对备份名生成器是安全侧，暂不改
- `query.rs:3815` 的事务性 DDL 白名单不含 DuckDB，尽管 DuckDB 实际支持

## 范围边界

**不在本次范围**：

- **备份表遗留清理入口**。仓库中没有任何机制让用户发现或清理残留备份（grep `_old_` / `__dbx` / `staging` / `orphan` 确认无此类 UI 或命令）。本次仅在失败错误串中回报备份表全名（`dropTargetBackupKept` key）。完整方案（命名前缀约定 + 列举查询 + UI 入口）约 +1 人日，建议观察实际使用后再定
- 10 个高危 / 不适用方言的支持（见决策 2）
- 非表对象（视图 / 存储过程 / 触发器 / 序列）的先删后建。这些对象已有各自的 `CREATE OR REPLACE` 或 drop-then-create 路径，本选项只作用于表（`dropTargetNonTableNote` key 明确告知用户）

## 工作量与关键路径

```
1.1 ─┬─> 1.2 ─┐
     └─> 1.4 ─┤
1.3 ──────────┼─> 2.1 ─> 2.2 ─> 2.3 ─> 2.4 ─> 4.2
1.5 ──────────┤          │
1.6 ──────────┘          └─> 3.1 ─> 3.2 ─> 3.3 ─> 3.4
4.1 可与阶段 1/2 并行；4.3 最后
```

关键路径：**1.3 → 2.1 → 2.2 → 2.3 → 4.2**。任务 2.2 是架构风险集中点。

| 阶段 | 人日 |
|---|---|
| 1（方言底座） | 3.0 |
| 2（编排与 rename） | 5.5 |
| 3（前端） | 3.25 |
| 4（测试文档） | 3.25 |
| **合计** | **约 15 人日** |

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `target_table_preexisting` 未重置 → PG 索引与外键静默不重建 | 高（数据可用但结构残缺，难察觉） | 任务 2.1 验收强制 live 测试；review 专查 `transfer.rs:7318`/`:7331`/`:7595` |
| 入向外键跟随 rename 指向备份表 | 高（约束静默丢失） | 见「关键设计 · 外键与 rename 的交互」；任务 2.3 的循环引用 live 测试 |
| Tauri 与 Web 两处编排改动不同步 | 中（Web API 与桌面端分歧） | 任务 2.2 验收显式要求；两处均有 fixture 可挂断言 |
| 备份名在 Oracle 30 字符上限溢出 | 中（长表名直接失败） | 任务 1.5 的四个边界单测 |
| 备份表残留无清理入口 | 中（磁盘占用累积） | 本次仅回报表名；见「范围边界」 |
| 前后端 cascade 白名单分叉 | 低（预览 SQL 与实际不符） | 任务 1.2 明确要求同步 `dbAdminSql.ts:322` |
| i18n 漏键静默回退英文 | 低 | 无自动化手段，人工核对 8 文件；可考虑为 `transfer` 补 parity 测试（注意 `docsNamespaceParity.spec.ts:11-17` 记录的陷阱：必须 import 原始对象而非 `withEnglishFallback` 合并后的默认导出） |
| `DataTransferDialog.spec.ts` 源码文本断言被打断 | 低（CI 红但原因明确） | 任务 3.2/3.3 已列出被 pin 的具体行号 |






