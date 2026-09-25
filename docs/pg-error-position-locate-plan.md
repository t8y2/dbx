# PostgreSQL 执行错误「点击定位到行列」开发方案

> 目标：在 PG 连接下执行 SQL 失败后，错误信息区域出现「定位错误」入口，点击后把编辑器光标定位到出错的行/列（并高亮该位置）。
> 本文先给出代码现状分析，再给出可执行的改造方案与分阶段任务。

---

## 1. 现状分析

### 1.1 错误从 PG 到界面的完整链路

```
tokio_postgres::Error
  └─ DbError.position() = ErrorPosition::Original(cursorpos)   ← 位置信息在这里，当前被丢弃
        │
        │  crates/dbx-core/src/db/postgres.rs::pg_error_to_string()
        │  (只取 err.as_db_error().map(ToString::to_string))     ← 只保留文本，未保留 cursorpos
        ▼
Result<db::QueryResult, String>            ← db 层统一用 String 承载错误
        │
        │  crates/dbx-core/src/query.rs::do_execute_typed() 尾部 .map_err(...)
        ▼
QueryExecutionError::{Legacy|Sql}(String)   ← 仍是纯文本
        │
        │  QueryExecutionError::into_backend_error()
        ▼
BackendError { code, messageKey, detail, diagnostics, ... }   ← 结构化，但无位置
        │
        ├─ 单语句/事务：tauri command 返回 Err(BackendError)
        └─ 多语句：ExecuteMultiResult { execution_error: true, error: BackendError, statement_index }
        ▼
前端 queryStore：
  - 多语句：annotateQueryResultSources() 给每个 result 写 sourceStatement / sourceFrom / sourceTo / statement_index
  - 单语句异常：toErrorResult() 合成 { columns:["Error"], execution_error:true, error:BackendError }
        ▼
DataGrid ErrorBanner（apps/desktop/src/components/grid/DataGrid.vue:11835）
  └─ #error-actions slot → ContentArea.vue:2032 → QueryErrorActions.vue
```

### 1.2 关键结论

1. **位置信息在驱动层就已存在**：`tokio_postgres::error::DbError::position()` 返回 `ErrorPosition::Original(u32)`，语义是 **1-based 的字符下标**（不是字节，PG 文档明确规定）。
2. **当前被丢弃**：`postgres.rs:1482` 的 `pg_error_to_string` 只用 `Display`，而 `DbError` 的 `Display` 实现**不包含** position 字段（见 `tokio-postgres/src/error/mod.rs` 的 `impl fmt::Display for DbError`）。所以前端完全拿不到。
3. **中间层是 String ABI**：`db::postgres` 到 `query.rs` 之间所有用户查询函数都返回 `Result<_, String>`（`execute_query_with_max_rows_and_cancel` / `execute_postgres_user_query(_with_mode)` / `execute_query_with_max_rows_inner` 等），错误在多个 `?`/`map_err(pg_error_to_string)` 中被反复包装、拼接（如 `merge_postgres_operation_and_rollback_result`）。直接引入类型化错误会牵动整个 `postgres.rs`。
4. **前端已经具备映射到编辑器位置的能力**：`apps/desktop/src/lib/tabs/tabPresentation.ts:244` 的 `resultSourceRange(editorSql, result, resultIndex, dbType, params)` 能把「某个 result 对应的语句」映射回当前编辑器文档的 `{from,to,sql}`，并且带一致性校验（`editorSql.slice(from,to) === sourceStatement`），stale 时返回 `undefined`。这就是把「语句内行列」换算成「编辑器绝对 offset」的现成入口。
5. **编辑器已有定位能力**：`QueryEditor.vue` 通过 `defineExpose` 暴露 `focusStatementRange({from,to})`（1105 行）与 `previewStatementRange`，内部用 CodeMirror 的 `EditorView.scrollIntoView` + selection 实现。新增一个「定位到点」的方法即可复用同一套机制。
6. **UI 入口已经存在**：错误横幅的 action 插槽（`ContentArea.vue:2032` / `:2390`）已经挂了 `QueryErrorActions`；执行摘要（`executionSummaryItems` + `ContentArea.vue:1869`）也已经有「单击预览语句 / 双击聚焦语句」的交互。这两个地方都是本次新增「定位错误」的天然落点。
7. **后端契约允许加可选字段**：`docs/backend-error-handling.md` 明确「新增可选字段可以保持 v1」，并要求错误对象由 catalog 构造、前后端不因未知可选字段丢弃 envelope。因此给 `BackendError` 增加可选 `errorPosition` 是向后兼容的。
8. **契约同时要求**：「不得先降级为字符串再重建 envelope」——这条针对的是**错误分类**。位置是驱动事实、不是分类依据，但方案会尽量把它做成类型化字段，字符串只作为跨 `String` ABI 的临时载体，并在第一层知道 SQL 文本的地方立刻还原为类型化字段。

### 1.3 需要动到的文件清单

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 驱动 | `crates/dbx-core/src/db/postgres.rs` | 从 `DbError` 提取 cursorpos |
| 新模块 | `crates/dbx-core/src/sql_error_position.rs`（新增） | 位置类型、行列换算、marker 编解码 |
| 查询层 | `crates/dbx-core/src/query.rs` | 还原位置、挂到 `QueryExecutionError` |
| 契约 | `crates/dbx-core/src/backend_error.rs` | `BackendError.errorPosition` 字段与构造器 |
| 契约文档 | `docs/backend-error-handling.md` | 记录新可选字段 |
| 前端类型 | `apps/desktop/src/lib/backend/errorUtils.ts` | TS `BackendError.errorPosition` + 校验 |
| 前端映射 | `apps/desktop/src/lib/sql/errorPosition.ts`（新增） | 语句内行列 → 编辑器 offset |
| 前端状态 | `apps/desktop/src/stores/queryStore.ts` | 错误结果附带位置（必要时） |
| 前端 UI | `apps/desktop/src/components/common/QueryErrorActions.vue`、`ContentArea.vue`、`editor/QueryEditor.vue`、`grid/DataGrid.vue`（如做内联标记） | 按钮 + 定位 + 行列展示 |
| i18n | `apps/desktop/src/i18n/locales/*.ts` | 新增文案 |
| 测试 | 各处 `#[cfg(test)]` / `apps/desktop/src/**/__tests__` | 单测覆盖 |

---

## 2. 方案总览

```
PG server cursorpos (字符下标)
   │  ① 提取
   ▼
pg_error_to_string() 追加临时 marker: "\nDBX_SQL_ERROR_POSITION:<cursor>"
   │  ② 沿既有 String ABI 冒泡（不改各函数签名）
   ▼
query.rs::do_execute_typed() 尾部 .map_err：
   PG 分支解析 marker + 用已执行 SQL 文本换算 line/column/offset
   → QueryExecutionError::SqlWithPosition { message, position }
   │  ③ 类型化
   ▼
QueryExecutionError::into_backend_error()
   → BackendError { ..., errorPosition: { line, column, offset } }
   │  ④ 随 envelope 到前端（单语句 Err / 多语句 result.error 两条路都覆盖）
   ▼
前端 QueryErrorActions / ExecutionSummary 显示「行 L 列 C」+「定位」按钮
   │  ⑤ 点击
   ▼
sqlErrorEditorOffset(): resultSourceRange() 得到语句范围 → 语句内行列换算为编辑器 UTF-16 offset
   ▼
QueryEditor.focusErrorPosition(offset)：selection + scrollIntoView + 高亮
```

设计取舍：

- **位置换算放在后端**：后端在 `do_execute_typed` 处同时掌握「原始 SQL 文本」和「cursorpos」，直接算出行列，前端只做「语句范围 → 文档 offset」的平移，避免前端再次处理字符/字节/码点差异。
- **跨层用 marker**：`db::postgres` 全链路是 `Result<_, String>`，引入类型化错误代价大且风险高。用与仓库既有 `DBX_AGENT_ERROR_DATA`（`agent_driver.rs:385`）同款「结构化后缀 marker」把类型化事实无损穿过 String 边界，并在第一层知道 SQL 的 `query.rs` 立即还原并剥离。marker 是**位置载体**而非分类依据，符合契约边界。
- **两级安全网**：`BackendError` 的 `detail` 清洗（`bounded_detail` / `bounded_native_detail`）里也剥离 marker，保证元数据/连接等旁路错误即使没走到 PG 分支也不会把 marker 泄漏到界面。

> 备选方案（更「类型化」但改动大）：把 `db::postgres` 用户查询链路（`execute_query_with_max_rows_and_cancel` → `execute_postgres_user_query(_with_mode)` → `execute_query_with_max_rows_inner` 及其等待包装）的返回错误从 `String` 改为 `PostgresQueryError { message, position }`，并给 `String` 提供 `From` 以便内部 `?` 继续工作。优点是彻底无 marker；缺点是触及 `postgres.rs` 多处签名与等待辅助函数。若团队不接受 marker，可切换到该方案，`query.rs` 以上的设计不变。

---

## 3. 后端改造

### 3.1 新模块 `crates/dbx-core/src/sql_error_position.rs`

```rust
use serde::{Deserialize, Serialize};

/// 跨 String 边界携带 PG cursorpos 的临时后缀。
pub const SQL_ERROR_POSITION_MARKER: &str = "\nDBX_SQL_ERROR_POSITION:";

/// 相对「实际下发的那条语句文本」的出错位置。
/// line/column 为 1-based、按 Unicode 码点计数；offset 为 0-based 码点下标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlErrorPosition {
    pub line: u32,
    pub column: u32,
    pub offset: u32,
}

impl SqlErrorPosition {
    /// `cursor` 为 PostgreSQL 的 1-based 字符下标。
    pub fn from_pg_cursor(sql: &str, cursor: u32) -> Option<Self> {
        if cursor == 0 {
            return None;
        }
        let total = sql.chars().count() as u32;
        // 越界时钳到末尾（"unexpected end of input" 这类错误常见 position == len+1）
        let target = (cursor - 1).min(total.saturating_sub(1));
        if total == 0 {
            return None;
        }
        let mut line = 1u32;
        let mut column = 1u32;
        for (index, ch) in sql.chars().enumerate() {
            if index as u32 == target {
                return Some(Self { line, column, offset: target });
            }
            if ch == '\n' {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        None
    }
}

pub fn encode_marker(cursor: u32) -> String {
    format!("{SQL_ERROR_POSITION_MARKER}{cursor}")
}

/// 从字符串尾部取出 marker 并剥离。返回原始 cursor。
pub fn take_marker(message: &mut String) -> Option<u32> {
    let index = message.rfind(SQL_ERROR_POSITION_MARKER)?;
    let cursor = message[index + SQL_ERROR_POSITION_MARKER.len()..].trim().parse::<u32>().ok()?;
    message.truncate(index);
    Some(cursor)
}

pub fn strip_marker(message: &str) -> String {
    let mut owned = message.to_string();
    let _ = take_marker(&mut owned);
    owned
}

/// 把一条错误文本（可能带 marker）解析为「清理后的文本 + 已换算位置」。
pub fn resolve_message(message: &str, executed_sql: &str) -> Option<(String, SqlErrorPosition)> {
    let mut owned = message.to_string();
    let cursor = take_marker(&mut owned)?;
    let position = SqlErrorPosition::from_pg_cursor(executed_sql, cursor)?;
    Some((owned, position))
}
```

> 在 `crates/dbx-core/src/lib.rs` 注册 `pub mod sql_error_position;`（仓库若已有模块清单，按现有顺序追加）。

### 3.2 `db/postgres.rs`：提取 cursorpos

改 `pg_error_to_string`（1482 行）——这是把 tokio 错误变文本的唯一汇聚点：

```rust
fn pg_error_to_string(err: tokio_postgres::Error) -> String {
    let Some(db_error) = err.as_db_error() else {
        return err.to_string();
    };
    let mut message = db_error.to_string();
    if let Some(tokio_postgres::error::ErrorPosition::Original(cursor)) = db_error.position() {
        message.push_str(&crate::sql_error_position::encode_marker(*cursor));
    }
    message
}
```

注意：

- `ErrorPosition::Internal { .. }` 表示位置在服务端内部生成的语句里，**不映射**，保持无位置。
- `pg_db_error_to_string`（1542 行，给 `pg_error_from_sources`/池错误用）**不加 marker**，因为那条路径没有用户 SQL 上下文。
- marker 只对 PG 生效，其它驱动零影响。

### 3.3 `query.rs`：还原为类型化位置

1) 扩展 `QueryExecutionError`（`query.rs:69`）新增变体：

```rust
pub enum QueryExecutionError {
    Agent(AgentCallError),
    DuckDb { code: String, message: String },
    Canceled { stage: AgentErrorStage, operation_outcome: AgentOperationOutcome },
    Timeout(String),
    Sql(String),
    /// PG 原生驱动：携带已换算好的出错行列。
    SqlWithPosition { message: String, position: crate::sql_error_position::SqlErrorPosition },
    Legacy(String),
}
```

2) 补齐所有 match 分支（按现有 `Self::Sql(..)` 处理方式）：

- `into_legacy_string()`（85 行附近）：`Self::SqlWithPosition { message, .. } => message`
- `into_backend_error()`（90 行附近）：
  ```rust
  Self::SqlWithPosition { message, position } =>
      crate::backend_error::BackendError::from_sql_detail_with_position(&message, position),
  ```
- `with_omitted_sql_context()`：保留 position，仅对 message 追加 `SQL_OMITTED_ERROR_CONTEXT`
- `with_context()`：同上，仅改 message
- `as_agent_error()`：归入 `None`
- `Display`：输出 message
- `query_execution_error_action()` 的 `Sql(message) | Legacy(message)` 分支（1497 行）加 `SqlWithPosition { message, .. }`
- `classify_query_error()`（2358 行）保持 `other => other` 即可透传

3) 在 `do_execute_typed` 的最终 `.map_err`（2350~2357 行）解析 marker：

```rust
.map_err(|error| {
    #[cfg(feature = "duckdb-sidecar")]
    if let Some(duckdb_error) = typed_duckdb_error {
        return QueryExecutionError::DuckDb { code: duckdb_error.code, message: duckdb_error.message };
    }
    if let Some(agent_error) = typed_agent_error {
        return QueryExecutionError::Agent(agent_error);
    }
    if pool_db_type == Some(DatabaseType::Postgres) {
        if let Some((message, position)) = crate::sql_error_position::resolve_message(&error, sql) {
            return QueryExecutionError::SqlWithPosition { message, position };
        }
    }
    QueryExecutionError::Legacy(error)
})
```

此处 `sql: &str` 就是该语句实际下发的文本，`pool_db_type` 已在前文计算。**注意**：`execute_sql_statement_with_options_typed(_inner)` 里 `with_omitted_sql_context` 之后还会走 reconnect 重试等分支，位置只在真正执行、且 SQL 未再改写的那次错误上正确；重试后再次执行会重新产生新的 marker，逻辑自洽。

4) `error_query_result(error.clone().into_legacy_string())`（`query.rs:3345` / `3833`）自动拿到清理后的文本，无需改动。

### 3.4 `backend_error.rs`：新增可选字段

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendError {
    // ...既有字段...
    #[serde(skip_serializing_if = "Option::is_none")]
    error_position: Option<crate::sql_error_position::SqlErrorPosition>,
}

impl BackendError {
    /// 在既有 SQL 失败 envelope 上附加驱动给出的出错位置（保持 v1）。
    pub fn from_sql_detail_with_position(
        message: &str,
        position: crate::sql_error_position::SqlErrorPosition,
    ) -> Self {
        let mut error = Self::from_sql_detail(message);
        error.error_position = Some(position);
        error
    }

    pub fn error_position(&self) -> Option<crate::sql_error_position::SqlErrorPosition> {
        self.error_position
    }

    fn new(/* 既有参数 */) -> Self {
        Self { /* ... */ error_position: None }
    }
}
```

安全网（防止 marker 从旁路泄漏到 detail）：

```rust
fn bounded_detail(message: &str) -> Option<String> {
    let message = crate::sql_error_position::strip_marker(message);
    // ...对 message 走原有逻辑
}
fn bounded_native_detail(message: &str) -> Option<String> {
    let message = crate::sql_error_position::strip_marker(message);
    // ...原有逻辑
}
```

（注意现有函数签名与所有权，改成接收 `&str` 后用局部 `String` 即可。）

### 3.5 契约文档

在 `docs/backend-error-handling.md` 的「公共错误对象」示例与「协议演进」段落补充：新增可选字段 `errorPosition: { line, column, offset }`，仅 PG 原生驱动 SQL 错误存在，为 v1 向后兼容可选字段；`offset` 为语句内 0-based 码点下标，`line/column` 为 1-based 码点计数。

---

## 4. 前端改造

### 4.1 类型与校验（`lib/backend/errorUtils.ts`）

```ts
export interface SqlErrorPosition {
  line: number;
  column: number;
  offset: number;
}

export interface BackendError {
  // ...既有字段...
  /** PostgreSQL 原生驱动给出的出错位置（相对该语句文本）。 */
  errorPosition?: SqlErrorPosition;
}
```

在 `isBackendError` 中对 `errorPosition` 做形状校验（三个字段均为有限非负整数，`line/column >= 1`），不合法时忽略整个字段但不丢弃 envelope（与既有「未知可选字段」策略一致）。

### 4.2 行列 → 编辑器 offset（新增 `lib/sql/errorPosition.ts`）

```ts
import { resultSourceRange } from "@/lib/tabs/tabPresentation";
import type { QueryResult, DatabaseType } from "@/types/database";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";

export interface EditorErrorPosition {
  offset: number;
  line: number;
  column: number;
}

/**
 * 把 result.error.errorPosition（语句内行列）换算为当前编辑器文档的 UTF-16 offset。
 * 只有在 resultSourceRange 能证明该 result 仍对应编辑器里同一段语句时才返回。
 */
export function sqlErrorEditorOffset(options: {
  editorSql: string;
  result: QueryResult | undefined;
  resultIndex?: number;
  databaseType?: DatabaseType;
  parameterOptions?: SqlParameterOptions;
}): EditorErrorPosition | undefined {
  const position = options.result?.error?.errorPosition;
  if (!position) return undefined;
  const range = resultSourceRange(
    options.editorSql,
    options.result,
    options.resultIndex,
    options.databaseType,
    options.parameterOptions,
  );
  if (!range) return undefined;

  // 目标：range.sql 内第 position.line 行、第 position.column 列（均 1-based，按码点）
  const chars = Array.from(range.sql);
  let line = 1;
  let lineStart = 0;
  let index = 0;
  while (index < chars.length && line < position.line) {
    if (chars[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
    index += 1;
  }
  if (line !== position.line) return undefined; // 行号超出语句

  // 该行内前进 column-1 个码点，遇到行尾或换行则钳制
  let columnOffset = 0;
  while (columnOffset < position.column - 1 && lineStart + columnOffset < chars.length) {
    if (chars[lineStart + columnOffset] === "\n") break;
    columnOffset += 1;
  }
  const charIndex = lineStart + columnOffset;

  // 码点下标 → range.sql 内 UTF-16 下标
  const utf16Offset = chars.slice(0, charIndex).join("").length;
  return { offset: range.from + utf16Offset, line: position.line, column: position.column };
}
```

> 优先用 `line/column` 而非 `offset`，因为二者都是「码点计数」，语义一致；`offset` 作为兜底/测试信号。

### 4.3 编辑器定位能力（`components/editor/QueryEditor.vue`）

在 `focusStatementRange`（1105 行）旁新增并加入 `defineExpose`（7542 行）：

```ts
function focusErrorPosition(offset: number) {
  const currentView = view.value;
  if (!currentView || !editorViewModule) return;
  const pos = Math.max(0, Math.min(offset, currentView.state.doc.length));
  currentView.dispatch({
    selection: { anchor: pos },
    effects: [editorViewModule.EditorView.scrollIntoView(pos, { y: "center" })],
  });
  currentView.focus();
}
```

可选增强（二选一或都做）：

- 用一次性 decoration 在 `pos` 处画一个短暂的错误下划线/闪烁光标（复用已有 `cm-sql-error` 样式与 `Decoration` 机制，5897 行附近）。
- 在 `pos` 处选中一个「词」（向两侧扫描标识符边界），让出错 token 更醒目。

### 4.4 UI 入口

**A. 错误横幅（主入口，符合「点击错误信息定位」）**

`QueryErrorActions.vue` 增加 props/emit 与按钮：

```ts
const props = defineProps<{ errorMessage: string; backendError?: BackendError; connectionId?: string; errorPosition?: { line: number; column: number } }>();
const emit = defineEmits<{
  /* 既有 */
  locateError: [];
}>();
const showLocate = computed(() => !!props.errorPosition);
```

```vue
<Button v-if="showLocate" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('locateError')">
  <LocateFixed class="h-3.5 w-3.5" />
  {{ t("editor.locateError", { line: errorPosition!.line, column: errorPosition!.column }) }}
</Button>
```

`ContentArea.vue` 两处 `#error-actions`（2032 / 2390 行）传入 `:error-position="activeTab.result?.error?.errorPosition"` 并绑定 `@locate-error="locateActiveResultError"`：

```ts
function locateActiveResultError() {
  const result = props.activeTab.result;
  const mapped = sqlErrorEditorOffset({
    editorSql: props.activeTab.sql,
    result,
    resultIndex: props.activeTab.activeResultIndex,
    databaseType: activeEffectiveDatabaseType.value,
    parameterOptions: activeSqlStatementParameterOptions.value,
  });
  if (!mapped) {
    toast(t("editor.errorPositionUnavailable"), 3000);
    return;
  }
  if (queryEditorRef.value) queryEditorRef.value.focusErrorPosition(mapped.offset);
  else emit("focusErrorPosition", props.activeTab.id, mapped.offset); // 多窗口/分离 tab 兼容
}
```

**B. 执行摘要（多语句场景体验更好）**

- `executionSummaryItems`（`tabPresentation.ts:419`）的 `ExecutionSummaryItem` 增加 `errorPosition?`，多语句分支直接从 `result.error?.errorPosition` 取。
- `ContentArea.vue` 摘要行的错误文本后追加「行 L 列 C」小标签；`focusExecutionSummaryItem` 改为优先使用 `sqlErrorEditorOffset`（有位置就精确定位，否则退回整条语句 `focusStatementRange`）。

**C. DataGrid 内联提示（可选）**

如需「点击错误信息本体」而非按钮：在 `DataGrid.vue:11835` 的 `ErrorBanner` 上对 message 绑定点击，emit 一个新事件透传到 `ContentArea` 的同一处理函数。建议保留按钮作为主要交互，避免与文本选择冲突。

### 4.5 i18n

在 `i18n/locales/en.ts` 与 `zh-CN.ts`（其余 locale 走 fallback）新增：

```ts
editor: {
  locateError: "Locate error (line {line}, col {column})", // zh: 定位错误（第 {line} 行，第 {column} 列）
  errorPositionUnavailable: "The error position no longer matches the editor content", // zh: 错误位置与当前编辑器内容不一致，无法定位
}
executionSummary: {
  lineColumn: "line {line}, col {column}", // zh: 第 {line} 行，第 {column} 列
}
```

---

## 5. 分阶段任务清单

### Phase 1 — 后端位置提取与透传（不影响 UI）

- [ ] 新增 `crates/dbx-core/src/sql_error_position.rs` 并在 `lib.rs` 注册；写 `from_pg_cursor` / marker 的单测（多行、`\r\n`、含 emoji、越界钳制）。
- [ ] `postgres.rs::pg_error_to_string` 追加 marker（仅 `ErrorPosition::Original`）。
- [ ] `backend_error.rs`：加 `error_position` 字段、`from_sql_detail_with_position`、`error_position()`，`new()` 补默认；在 `bounded_detail`/`bounded_native_detail` 内 `strip_marker`。
- [ ] `query.rs`：新增 `QueryExecutionError::SqlWithPosition`，补齐所有 match 分支，在 `do_execute_typed` 尾部 PG 分支解析。
- [ ] Rust 测试：序列化 `errorPosition`（camelCase）；`into_backend_error()` 产出正确 position；`into_legacy_string()` 不含 marker；`SqlWithPosition` 不被 `classify_query_error` 降级。

### Phase 2 — 前端类型与映射

- [ ] `errorUtils.ts` 增加 `SqlErrorPosition` 与 `errorPosition?`，扩展 `isBackendError` 校验。
- [ ] 新增 `lib/sql/errorPosition.ts` + vitest：用带 `sourceFrom/sourceTo/sourceStatement` 的假 result 验证多行/非 BMP 字符/行超界/stale 返回 `undefined`。
- [ ] 同步 `lib/backend/http.ts`、`lib/backend/tauri.ts` 的错误规范化路径（复用 `normalizeBackendError` 应无需改，确认即可）。

### Phase 3 — UI 与编辑器定位

- [ ] `QueryErrorActions.vue` 增加 `errorPosition` prop、`locateError` emit 与按钮；`__tests__/QueryErrorActions.spec.ts` 补用例。
- [ ] `QueryEditor.vue` 增加 `focusErrorPosition(offset)` 并 `defineExpose`；`ContentArea.vue` 接线 + toast 兜底。
- [ ] `tabPresentation.ts` 的 `ExecutionSummaryItem` 增加 `errorPosition`；`ExecutionSummary` 行显示行列并支持精确定位。
- [ ] i18n 文案（en / zh-CN）。
- [ ] 手工验证：`SELECT * FROM no_such_table;`（表不存在）、`SELECT FROMM t;`（语法错误）、多语句中第 2 条报错、光标定位与高亮。

### Phase 4 — 文档与收尾

- [ ] 更新 `docs/backend-error-handling.md`。
- [ ] 跑提交前检查（见第 7 节）。

---

## 6. 边界、风险与对策

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| **SQL 被前端改写** | 分页包装、排序、只读事务、schema 限定等会在下发前改写 SQL，PG 的 cursorpos 相对改写后的文本，映射到用户原文会偏移 | 位置只在「result 仍能通过 `resultSourceRange` 证明对应当前编辑器同一段语句」时启用；仍可能因包装漂移时，回退为仅展示行列、禁用定位（Phase 3 的 `undefined` 分支）。后续可在前端记录 `sqlToExecute === queryBaseSql` 标志，仅在该成立时启用 |
| **前后端语句切分差异** | 后端 `split_sql_statements` 与前端 `splitSqlStatementRanges` 对前导注释/空白/分号处理可能不同 | 加对照测试（同一批脚本）；前端已有 `submittedStatement.sql === sourceStatement` 校验，边界不符时不定位 |
| **PG cursorpos 语义** | 1-based、按字符（码点）而非字节 | 全部换算按 `chars()`/`Array.from` 码点进行；单测覆盖多字节与 emoji |
| **agent/JDBC PG 无位置** | JDBC 路径错误来自 `AgentCallError`，结构化上下文里没有 position | 明确 Phase 1 只覆盖 tokio-postgres 原生驱动；JDBC 需在 Agent Protocol 扩展字段，另开阶段 |
| **字符串 marker 泄漏到 UI** | 旁路错误（元数据/连接）可能带 marker | `bounded_detail`/`bounded_native_detail` 统一剥离 + `into_legacy_string` 返回已清理文本；补「不含 marker」单测 |
| **契约兼容** | `BackendError` 新增字段 | 可选字段保持 v1；前端 `isBackendError` 对未知/非法可选字段宽容处理 |
| **大小写/换行** | `\r\n` 的行列计算 | `from_pg_cursor` 只以 `\n` 分行，`\r` 计入列；前端按同一规则处理，保持一致 |

---

## 7. 测试与验收

**Rust 单测**

```text
cargo test -j 1 -p dbx-core --no-default-features --lib sql_error_position::tests
cargo test -j 1 -p dbx-core --no-default-features --lib backend_error::tests
cargo test -j 1 -p dbx-core --no-default-features --lib query::tests  # QueryExecutionError 分支
```

**前端**

```text
pnpm vitest run apps/desktop/src/lib/__tests__/sql/errorPosition.spec.ts
pnpm vitest run apps/desktop/src/components/common/__tests__/QueryErrorActions.spec.ts
pnpm vitest run apps/desktop/src/i18n/__tests__/backendErrors.spec.ts
pnpm typecheck
```

**手工验收（PG 连接）**

1. `SELECT * FROM no_such_table;` → 错误横幅出现「定位错误（第 1 行，第 15 列）」→ 点击后光标落在 `no_such_table` 起首。
2. 多行脚本第 3 条报错 → 执行摘要该行显示行列，点击精确跳转；错误横幅定位到同一条语句。
3. 执行后手动改动编辑器使语句不再匹配 → 点击定位给出「位置不可用」提示，不误跳。
4. 非 PG 连接（MySQL/SQLite）错误 → 无定位入口，行为不变。

**完成标准**

- PG 原生驱动的 SQL 错误（语法错误、对象不存在等）在单语句与多语句两条路径都能拿到 `errorPosition` 并正确定位。
- 其它驱动与既有错误展示零回归（现有 `BackendError` / `translateBackendError` 测试全绿）。
- 契约文档更新；`docs/backend-error-handling.md` 的提交前检查全过。

---

## 8. 工作量估算

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| Phase 1 | 后端位置提取 + 类型化 + 透传 + 单测 | 0.5–1 天 |
| Phase 2 | 前端类型 + 映射函数 + 单测 | 0.5 天 |
| Phase 3 | UI 按钮 + 编辑器定位 + 摘要 + i18n + 手工验证 | 1 天 |
| Phase 4 | 文档、回归、提测 | 0.5 天 |
| 合计 | | **约 2.5–3 天** |

---

## 9. 一句话总结

PG 的出错行列一直存在于 `DbError::position()`，只是被 `pg_error_to_string` 丢弃；本方案在驱动层提取 cursorpos，用轻量 marker 穿过既有 `String` 错误 ABI，在 `query.rs` 还原为类型化的 `BackendError.errorPosition`，前端借助已有的 `resultSourceRange` 把「语句内行列」换算成编辑器 offset，并在错误横幅/执行摘要上提供一键定位。整体对现有架构侵入小、对非 PG 驱动零影响。

## 10. 实现补充：下发语句漂移的处理（已落地）

「位置相对实际下发语句」在本方案实现后暴露出一个高频问题：DBX 常在下发前改写语句（追加 `LIMIT/OFFSET`、用 `SELECT * FROM (…)` 包裹分页、为可编辑查询注入隐藏主键列），导致后端位置与用户原文对不上，定位会失败或偏移。已在前端增加一层投影，无需改动后端协议：

1. `annotateQueryResultSources` 额外接收本次实际下发的 SQL（`sqlToExecute`），当某个 result 的语句文本与 `sourceStatement` 不同时，把实际下发的语句文本记录到 `QueryResult.executedStatement`（仅在前端内部使用）。
2. `sqlErrorEditorOffset` 先把后端 `line/column` 解析到 `executedStatement`（位置本就相对它），再用 `mapExecutedOffsetToSource` 投影回 `sourceStatement`：
   - 直接子串匹配 → 精确处理「追加子句」与「子查询包裹」；
   - 前缀对齐 + 剩余文本重定位 → 处理「在投影中注入隐藏列」；
   - 最后退回「首个/末个差异之间的单一变更区间」对齐。
3. 行/列越界时钳制而非报「不可用」，因此只要还存在该语句的源码范围，点击定位总能落到句式内的合理位置；只有编辑器内容与结果语句确实不一致（stale）时才提示无法定位。

新增单测覆盖：追加 `LIMIT`、分页包裹、注入隐藏列、多行语句、软字符（emoji）列宽换算与越界钳制。
