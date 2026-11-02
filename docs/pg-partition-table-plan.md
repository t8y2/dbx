# PostgreSQL 分区表管理功能开发方案

> 目标：在「表属性 / 表结构编辑器」中新增一个「分区」页签，提供与 Navicat 类似的分区表查看与维护能力。
> 范围：优先 PostgreSQL（10+，声明式分区），架构预留 opengauss / kingbase / vastbase / GaussDB 等 PG 兼容系的扩展位。

---

## 1. 现状分析（已具备的能力）

### 1.1 后端

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 单表分区信息 | `crates/dbx-core/src/db/postgres.rs::get_table_partition_info` | 返回 `is_partition`、`parent_schema/table`、`bound`（`pg_get_expr(relpartbound)`）、`key`（`pg_get_partkeydef`）、是否外部表 |
| 分区树 | `postgres.rs::fetch_postgres_partition_tree` | 一条 `WITH RECURSIVE` 取回根 + 全部层级后代（含每节点 bound/key），有 PG 9.x 兼容降级 SQL |
| 分区本地对象 | `postgres.rs::get_table_partition_local_objects(_for_relations)` | 分区自己独有的 PK/UNIQUE/FK/CHECK/索引/列默认值 |
| 分区树 DDL | `schema.rs::pg_ddl_with_partitions` | 把整棵树渲染成多段 `CREATE TABLE ... PARTITION OF ... FOR VALUES ...` |
| 状态探针 | `schema.rs::table_partition_status_core` → 命令 `get_table_partition_status` | 只返回 `isPartitionedParent` / `isPartition`，已用于并发建索引禁用判断 |
| 侧边栏分区子节点 | `apps/desktop/src/lib/table/tableTree.ts`、`objectBrowserRows.ts` | 已能把分区表在对象树里挂到父表下 |
| Agent 系分区接口 | `schema.rs::list_partitions_core` / `list_subpartitions_core` | 目前只走 Agent 池（Xugu/Oracle 等），PG 池返回空 |

### 1.2 前端

- 表结构编辑器：`apps/desktop/src/components/structure/TableStructureEditor.vue`（5484 行），页签集合由 `TableInfoTab` 定义：
  `apps/desktop/src/types/database.ts:1490`
  ```ts
  export type TableInfoTab = "columns" | "indexes" | "foreignKeys" | "constraints" | "triggers" | "ddl";
  ```
- 页签可见性由 `tableMetadataCapabilities.ts` 的 `TableMetadataCapabilities` + `isStructureMetadataTabSupported` 控制。
- 刷新范围由 `tableStructureMetadataLoading.ts` 的 `TableStructureRefreshScope` 控制。
- DDL 生成统一走后端命令 `buildTableStructureChangeSql` / `buildCreateTableSql`（Rust `table_structure_sql`），前端只在 `tableStructureEditorSql.ts` 里声明 options 类型。
- `TableStructureSqlOptions` 已有一个 `partitioned: bool` 字段，但**仅用于拒绝分区父表上的并发建索引**，不是分区管理数据。

### 1.3 结论

读取侧（分区树、bound、key、DDL 渲染）**已经基本齐全**，缺的是：

1. 一个**结构化的、面向前端的分区模型**（现在只有原始字符串 `key` / `bound`，且分散在树/DLL 内部）；
2. 一个**暴露给前端的读取命令**（现在没有 `get_table_partitioning` 这类命令，前端拿不到树）；
3. **分区维护 DDL 生成**（新增/删除/attach/detach/默认分区）；
4. **建表时声明分区策略**；
5. **前端页签 UI** 与 i18n、测试。

---

## 2. Navicat 分区功能对照与目标功能

Navicat 的「分区」页签（表设计器内）典型能力：

| 功能 | 目标 | PG 可行性 |
| --- | --- | --- |
| 显示分区策略（类型 + 键） | ✅ | `pg_get_partkeydef` / `pg_partitioned_table.partstrat` |
| 显示分区列表（名称、边界值、是否默认） | ✅ | 分区树 + `relpartbound` |
| 新增分区 | ✅ | `CREATE TABLE ... PARTITION OF ... FOR VALUES ...` |
| 删除分区 | ✅ | `DROP TABLE child`（或 DETACH） |
| 附加 / 分离分区 | ✅ | `ALTER TABLE ... ATTACH/DETACH PARTITION` |
| 默认分区 | ✅ | `... PARTITION OF ... DEFAULT` |
| 子分区（多级） | ✅（二期） | PG 支持分区表再分区 |
| 修改已有表的分区策略 | ⚠️ 只读 + 重建 | PG 不支持 `ALTER ... PARTITION BY`，需重建表 |
| 建表时指定分区 | ✅（二期） | `CREATE TABLE ... PARTITION BY RANGE/LIST/HASH` |

**一期只读展示 + 二期维护**是风险最低的落地路径（见 §7）。

---

## 3. PostgreSQL 语法与语义映射

### 3.1 分区策略

```sql
PARTITION BY RANGE  (col)                  -- 单列
PARTITION BY RANGE  (col1, col2)           -- 多列（PG 11+）
PARTITION BY RANGE  (date_trunc('month', ts))  -- 表达式
PARTITION BY LIST   (col)
PARTITION BY HASH   (col)
```

策略类型从 `pg_get_partkeydef()` 字符串前缀即可判定：`RANGE (` / `LIST (` / `HASH (`。
是否需要解析列 vs 表达式：`pg_partitioned_table.partnatts` 与 `pg_get_partkeydef` 文本组合判断（多列时是元组，表达式时不是纯列清单）。

### 3.2 分区边界（子分区）

| 策略 | `relpartbound` 渲染 | 生成语法 |
| --- | --- | --- |
| RANGE | `FOR VALUES FROM ('a') TO ('b')` | `FOR VALUES FROM (...) TO (...)`，支持 `MINVALUE`/`MAXVALUE` |
| LIST | `FOR VALUES IN (1, 2, 3)` | `FOR VALUES IN (...)` |
| HASH | `FOR VALUES WITH (MODULUS 4, REMAINDER 0)` | `FOR VALUES WITH (MODULUS n, REMAINDER m)` |
| DEFAULT | `DEFAULT` | `DEFAULT` |

### 3.3 版本差异（必须处理）

| 特性 | 最低版本 |
| --- | --- |
| 声明式分区 | 10 |
| 多列 / 哈希分区 | 11 |
| `DETACH PARTITION CONCURRENTLY` | 12 |
| `ATTACH PARTITION` 支持表达式/多列、`DETACH FINALIZE` | 14 |
| `<10` | 无声明式分区 → **隐藏分区页签** |

`fetch_postgres_partition_tree` 已有 9.x 兼容降级；新命令需沿用同一 `query_with_compat_fallback` 模式。

### 3.4 关键限制（UI 必须提示）

- 分区键列不能为 NULL 拆分；`DEFAULT` 分区最多一个。
- 分区表上的唯一索引 / 主键必须包含分区键。
- 有 `DEFAULT` 分区时 `ATTACH` 需要全表扫描校验不重叠（可能长时间锁）。
- 分区父表不能 `CREATE INDEX CONCURRENTLY`（已实现，`validate_concurrent_index_scope`）。
- 成员分区上的 DDL 大多需带 `ONLY` 才作用于该分区自身。

---

## 4. 数据模型设计

### 4.1 Rust：`crates/dbx-core/src/types.rs`（或新模块 `db/postgres/partition.rs`）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PgPartitionKind { Range, List, Hash }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PgPartitionBound {
    Range { from: Vec<String>, to: Vec<String> },      // 保留 MINVALUE/MAXVALUE 原文
    List  { values: Vec<String> },
    Hash  { modulus: i32, remainder: i32 },
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgPartitionNode {
    pub schema: String,
    pub name: String,
    /// 该节点自身是分区父表时的策略；叶子分区为 None
    pub strategy: Option<PgPartitionKind>,
    /// `pg_get_partkeydef` 原文，仅分区父表有
    pub key_definition: Option<String>,
    /// 该节点作为子分区时的边界
    pub bound: Option<PgPartitionBound>,
    pub bound_definition: Option<String>, // pg_get_expr 原文，便于展示/兜底
    pub is_leaf: bool,
    pub row_estimate: Option<i64>,        // pg_class.reltuples，可选
    pub total_bytes: Option<i64>,         // pg_total_relation_size，可选
    pub children: Vec<PgPartitionNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgTablePartitioning {
    /// 表本身是否为分区父表
    pub is_partitioned: bool,
    /// 表本身是否为某个父表的分区
    pub is_partition: bool,
    pub parent: Option<String>,          // "schema.table"
    pub own_bound: Option<PgPartitionBound>,
    /// 分区策略（根节点，仅根是分区父表时有值）
    pub strategy: Option<PgPartitionKind>,
    pub key_definition: Option<String>,
    /// 键列（表达式键时为空）
    pub key_columns: Vec<String>,
    pub key_expression: Option<String>,
    pub default_partition: Option<String>,
    /// 完整的（子）分区树
    pub partitions: Vec<PgPartitionNode>,
}
```

新增命令（Rust → Tauri/Web）：

```rust
pub async fn get_table_partitioning_core(state, connection_id, database, schema, table)
    -> Result<PgTablePartitioning, String>
```

- 复用 `fetch_postgres_partition_tree`（含 oid，便于 `pg_partition_tree()` 关联）与 `get_table_partition_info`；
- 在 `postgres.rs` 内新增：
  - `list_partition_strategy(pool, schema, table)` → `pg_partitioned_table.partstrat` + `pg_get_partkeydef`；
  - `pg_partition_row_estimates(pool, oids)`（可选，一次批量查 `pg_class.reltuples` / `pg_total_relation_size`）；
  - `parse_pg_partition_bound(text) -> PgPartitionBound`（纯函数，带单元测试）；
  - 兼容 9.x 的降级查询。

### 4.2 Tauri 命令注册

- `src-tauri/src/commands/schema.rs`：新增 `get_table_partitioning` 命令。
- `src-tauri/src/commands/mod.rs` / `lib.rs` 的 `invoke_handler` 里注册。
- `src-tauri/src/commands/mcp.rs`、`crates/dbx-mcp` 是否暴露：一期不暴露（可选后续）。

### 4.3 前端类型

`apps/desktop/src/types/database.ts`

```ts
export type TableInfoTab = "columns" | "indexes" | "foreignKeys" | "constraints" | "triggers" | "ddl" | "partitions";

export type PgPartitionKind = "range" | "list" | "hash";
export type PgPartitionBound =
  | { kind: "range"; from: string[]; to: string[] }
  | { kind: "list"; values: string[] }
  | { kind: "hash"; modulus: number; remainder: number }
  | { kind: "default" };

export interface PgPartitionNode { schema: string; name: string; strategy?: PgPartitionKind; keyDefinition?: string; bound?: PgPartitionBound; boundDefinition?: string; isLeaf: boolean; rowEstimate?: number; totalBytes?: number; children: PgPartitionNode[]; }
export interface PgTablePartitioning { isPartitioned: boolean; isPartition: boolean; parent?: string; ownBound?: PgPartitionBound; strategy?: PgPartitionKind; keyDefinition?: string; keyColumns: string[]; keyExpression?: string; defaultPartition?: string; partitions: PgPartitionNode[]; }
```

API 封装（三处都要加，保持一致）：
- `apps/desktop/src/lib/backend/tauri.ts`
- `apps/desktop/src/lib/backend/http.ts`
- `apps/desktop/src/lib/backend/api.ts`

另有 `apps/desktop/src/lib/backend/__tests__/` 下的契约测试需要补分支。

---

## 5. DDL 生成设计

### 5.1 新模块：`crates/dbx-core/src/table_structure_sql/partitions.rs`

```rust
pub fn validate_partitioning(options) -> Vec<String>;                 // 非 PG 直接拒绝
pub fn build_create_partitioned_table_clause(draft) -> String;        // " PARTITION BY RANGE (col)"
pub fn build_add_partition_sql(parent, draft) -> Vec<String>;         // CREATE TABLE ... PARTITION OF ... FOR VALUES ...
pub fn build_attach_partition_sql(parent, child, bound) -> Vec<String>;
pub fn build_detach_partition_sql(parent, child, concurrently) -> Vec<String>;
pub fn build_drop_partition_sql(parent, child) -> Vec<String>;        // DROP TABLE child;
```

要点：
- 标识符统一走 `util::quote_ident` / 限定名，禁止拼接未转义的 schema/table。
- `MINVALUE` / `MAXVALUE` 是关键字，**不能加引号**；普通值按列类型决定是否加引号（文本/日期加，数字不加）——一期可让 UI 直接输入 SQL 字面量并做「默认按文本引号、检测到纯数字/`MINVALUE`/`MAXVALUE` 时不加引号」的规范化。
- `DEFAULT` 分区只允许一个；`validate_partitioning` 里做前置校验。
- 非 PostgreSQL/opengauss/... 方言调用时返回 warning 并拒绝生成（fail closed，与现有 `validate_concurrent_index_scope` 风格一致）。

### 5.2 扩展 options

`table_structure_sql/types.rs` + `apps/desktop/src/lib/table/tableStructureEditorSql.ts`：

```rust
pub struct TableStructureSqlOptions {
    // ... 现有字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partitioning: Option<TablePartitioningDraft>,
}

pub struct TablePartitioningDraft {
    pub kind: PgPartitionKind,
    #[serde(default)] pub key_columns: Vec<String>,
    #[serde(default)] pub key_expression: String,
    #[serde(default)] pub partitions: Vec<TablePartitionDraft>,
}

pub struct TablePartitionDraft {
    pub id: String,
    pub name: String,
    pub bound: PgPartitionBoundDraft,
    #[serde(default)] pub original: Option<PgPartitionBoundDraft>, // 已存在分区
    #[serde(default)] pub marked_for_drop: bool,
    #[serde(default)] pub children: Vec<TablePartitionDraft>,       // 二期：子分区
}
```

- **建表**：在 `build_create_table_sql` 末尾，若 `partitioning` 存在且非空，追加 `PARTITION BY ...`。
  - 注意：`PARTITION BY` 只能用于 `CREATE TABLE`，不能用于 `CREATE TABLE ... PARTITION OF`。
  - 分区父表上不应自动生成「子分区 CREATE」，由 draft 里的 `partitions` 决定是否一并生成。
- **改现有表**：分区操作**不参与列/索引 diff**，而是作为独立语句追加到 `statements`（新增/删除/attach/detach）。这样既能复用现有「预览 SQL → 执行」通道，又不会和列 diff 相互干扰。
- 策略字段在现有表上是只读的（PG 不支持改），只在建表模式可编辑。

---

## 6. 前端 UI 设计

### 6.1 页签接入

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/types/database.ts` | `TableInfoTab` 加 `"partitions"` + 新类型 |
| `apps/desktop/src/lib/table/tableMetadataCapabilities.ts` | `TableMetadataCapabilities` 加 `partitions: boolean`；`postgres: { constraints: true, partitions: true }`；`isStructureMetadataTabSupported` / `firstStructureMetadataTab` 补分支 |
| `apps/desktop/src/lib/table/tableStructureMetadataLoading.ts` | `TableStructureRefreshScope` 加 `partitions`；`visibleTableStructureRefreshScope` 加 `case "partitions"` |
| `apps/desktop/src/components/structure/TableStructureEditor.vue` | 新增 `TabsTrigger value="partitions"` 与 `TabsContent`；新增分区状态/加载/草稿逻辑 |
| i18n：`locales/zh-CN.ts`、`en.ts`（其余语言走 `i18n-autofill.mjs`） | `structureEditor.partitions*` 一组 key |

### 6.2 页签内容

**A. 分区表（父表）**

- 顶部信息条：分区类型（RANGE/LIST/HASH）、分区键、默认分区名、分区总数。
- 分区树/列表（参考 `constraints` 页签的只读卡片风格）：
  - 层级缩进展示（一期可用扁平列表 + parent 列，二期再树形）；
  - 每行：分区名、边界（`FROM (...) TO (...)` / `IN (...)` / `MODULUS..REMAINDER..` / DEFAULT）、是否默认、行数/大小（可选）。
- 操作按钮：`新增分区`、`删除分区`、`附加已有表`、`分离分区`。
- 所有操作 → 弹窗填写参数 → 把生成的 SQL 语句加入 `pendingStatements` → 复用底部「预览 SQL / 保存」流程执行。

**B. 分区（子表）**

- 只读展示：所属父表、自身边界。
- 提供「分离此分区」入口（`DETACH PARTITION`）。

**C. 非分区表**

- 空态：提示「当前表不是分区表」；建表模式下可开启分区并配置（二期）。

### 6.3 交互细节

- 新增分区弹窗按策略切换表单：
  - RANGE：起始值 / 结束值（支持 `MINVALUE` / `MAXVALUE` 开关）；
  - LIST：值列表（逗号分隔，支持多值）；
  - HASH：`MODULUS`、`REMAINDER`；
  - 勾选「默认分区」则禁用边界输入。
- 删除 / 分离需二次确认，文案提示影响（DROP 会连带删除数据）。
- `DETACH CONCURRENTLY` 仅在服务端版本 ≥ 12 时可选（通过 `server_version_num` 或 `get_table_partitioning` 返回的版本能力位判断）。
- 有 `DEFAULT` 分区时，新增分区提示可能触发表扫描。

---

## 7. 分阶段实施计划

> **实施状态**：Phase 0 / 1 / 2a / 3a 已完成并通过真实库验证（PostgreSQL 14.19、KingbaseES V009R001C010）。
> 待办：Phase 2b 子分区树编辑、Phase 3b openGauss / GaussDB / Vastbase（`pg_partition` catalog，非 PG 声明式分区模型）。

### Phase 0 — 只读展示（建议先落地，1–2 天）

1. 后端：`PgTablePartitioning` 模型 + `get_table_partitioning_core` + `parse_pg_partition_bound` + 单元测试。
2. 命令注册 + 前端三个 api 封装 + 契约测试。
3. 前端：`TableInfoTab` / capabilities / refresh scope / 页签 + 只读 UI + i18n。
4. 测试：Rust 解析测试、前端 vitest 能力门控与渲染测试。
5. 价值：立即可在表属性里看到分区结构与边界，且完全无写入风险。

**验收**：PostgreSQL 10–17 上打开分区父表 → 显示策略与全部（子）分区边界；子分区表显示父表与自身边界；普通表显示空态；PG 9.x 与 MySQL 不显示该页签。

### Phase 1 — 分区维护（3–5 天）

1. `partitions.rs` DDL 生成 + 校验 + 单元测试。
2. options 扩展 + 前端 draft 类型。
3. UI：新增 / 删除 / attach / detach 弹窗 + SQL 预览 + 执行。
4. 事务/并发安全：`DETACH CONCURRENTLY` 版本门控；attach 有默认分区时的警告。
5. 测试：`live_postgres_partitioning.rs` 真实库读 + 生成 DDL 执行。

### Phase 2 — 建表声明分区 + 子分区（2–3 天）

1. 建表模式下的分区策略编辑器；`build_create_table_sql` 追加 `PARTITION BY`。
2. 子分区树编辑（可选，复杂度较高，可再拆）。
3. 分区父表上并发建索引的禁用已存在，补充与新页签的联动提示。

### Phase 3 — 方言扩展（3–5 天，按需）

- **3a（已完成）**：kingbase — KingbaseES V9 与 PostgreSQL 共用 `pg_partitioned_table` / `relispartition` / `pg_get_partkeydef` catalog 与 `PARTITION OF` / `ATTACH` / `DETACH` 语法，直接复用同一模型；后端 `supports_partition_ddl` 放行 PostgreSQL + Kingbase，前端 capability 同步开启，已用真实 KingbaseES 实例跑通全部 live 用例。
- **3b（待办）**：openGauss / GaussDB / Vastbase 使用 **openGauss 专有的 `pg_partition` catalog**（无 `relispartition`/`relpartbound`/`pg_get_partkeydef`），且分区是 Oracle 风格（`PARTITION BY RANGE (col) (PARTITION p1 VALUES LESS THAN (...))`），没有独立子表。需要单独的读取与 DDL 通道，不能复用本模型，因此暂不开启。
- Oracle / Xugu 等已有 `list_partitions` Agent 通路，可复用新页签的只读形态，DDL 走各自方言。

---

## 8. 测试方案

### 8.1 Rust 单元测试

- `table_structure_sql/tests.rs`：
  - RANGE 单列 / 多列 / 表达式；
  - LIST（含字符串、数字、NULL 边界）；
  - HASH MODULUS/REMAINDER；
  - DEFAULT 分区唯一性校验；
  - attach / detach（含 concurrently）；
  - 非 PG 方言拒绝生成；
  - 标识符转义（含引号、schema 限定）。
- `postgres.rs` 内 `parse_pg_partition_bound` 的往返测试（覆盖 `pg_get_expr` 的真实输出格式）。

### 8.2 Rust 集成测试

- 新增 `crates/dbx-core/tests/live_postgres_partitioning.rs`，沿用 `live_postgres_concurrent_index.rs` 的 env 约定（`DBX_LIVE_POSTGRES_*`，`#[ignore]`）。
- 场景：建分区父表 → 读树 → 生成新增分区 DDL 并执行 → 读回校验 → detach → drop。

### 8.3 前端测试

- `apps/desktop/src/lib/__tests__/table/`：能力门控（postgres 有、mysql 无）、refresh scope、bound 格式化工具。
- `apps/desktop/src/components/structure/__tests__/`：页签可见性、加载态、空态、错误态（参考 `TableStructureEditor.ddlTab.spec.ts` 的 mock 方式）。
- `packages/app-tests/` 下如有跨包契约测试也需同步。

### 8.4 契约/回归

- `crates/dbx-core/tests/api_contract_verification.rs`、`packages/app-tests/*` 若枚举命令或页签，需同步更新。
- CI：`.github/workflows/database-environments.yml` 已支持多数据库环境，PG 场景加进 live 测试矩阵。

---

## 9. 风险与注意事项

| 风险 | 应对 |
| --- | --- |
| PG 版本差异（`DETACH CONCURRENTLY`、多列/哈希） | 版本能力位 + 完整降级 SQL；9.x 隐藏页签 |
| 改分区策略需重建表 | 现有表策略只读，UI 明确提示「需重建」，不提供隐式重建 |
| `ATTACH` 有默认分区时全表扫描 | UI 警告 + 建议在低峰执行；不做自动并发 |
| 值字面量引号处理错误 | 单测覆盖；UI 提示「按 SQL 字面量输入」；后端规范化 |
| 分区父表并发建索引 | 已实现拦截，新页签复用同一状态探针，避免重复查询 |
| 大分区树（数千分区）渲染卡顿 | 复用对象树的分页/懒加载思路；一期限制一次渲染条数并提示 |
| i18n 全语言缺失 | 新增 key 后跑 `.github/scripts/i18n-autofill.mjs` |
| 与 DDL 页签重复 | DDL 页签继续展示整棵树（`pg_ddl_with_partitions`），分区页签负责结构化查看与操作，二者数据同源不冲突 |

---

## 10. 涉及文件清单（速查）

**后端（Rust）**
- `crates/dbx-core/src/db/postgres.rs`（策略查询、bound 解析、批量估算）
- `crates/dbx-core/src/schema.rs`（`get_table_partitioning_core`）
- `crates/dbx-core/src/types.rs`（分区模型）
- `crates/dbx-core/src/table_structure_sql/partitions.rs`（新，DDL 生成）
- `crates/dbx-core/src/table_structure_sql/{types.rs,create_table.rs,tests.rs,mod.rs}`
- `src-tauri/src/commands/schema.rs` + 命令注册
- `crates/dbx-core/tests/live_postgres_partitioning.rs`（新）

**前端（Vue/TS）**
- `apps/desktop/src/types/database.ts`
- `apps/desktop/src/lib/table/tableMetadataCapabilities.ts`
- `apps/desktop/src/lib/table/tableStructureMetadataLoading.ts`
- `apps/desktop/src/lib/table/tableStructureEditorSql.ts`
- `apps/desktop/src/lib/backend/{api,tauri,http}.ts`
- `apps/desktop/src/components/structure/TableStructureEditor.vue`
- `apps/desktop/src/i18n/locales/{zh-CN,en,...}.ts`
- 对应 `*.spec.ts` 测试

---

## 11. 估算

| 阶段 | 工作量 |
| --- | --- |
| Phase 0 只读 | 1–2 天 |
| Phase 1 维护 | 3–5 天 |
| Phase 2 建表 + 子分区 | 2–3 天 |
| Phase 3 方言扩展 | 3–5 天（按需） |
| 合计（PG 完整） | **约 6–10 天**（不含方言扩展） |

> 建议以 Phase 0 作为第一个可合并 PR：改动小、无写入风险、立刻可见收益，并为后续维护功能打下数据模型基础。
