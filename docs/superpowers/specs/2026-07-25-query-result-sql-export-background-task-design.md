# Query Result SQL INSERT Async Background Export

Date: 2026-07-25
Author: dbx team
Status: Draft

## Problem

点击"导出当前结果集全部数据 SQL INSERT"后，UI 会冻结数十秒甚至一分钟（4 万行 ~20s，10 万行 ~1min+），然后才弹出保存对话框。用户以为功能坏了。

## Root Cause

当前 `exportSql()` 对 query-result 场景走 `resultToExport()` → 全量数据先拉到前端内存 → `formatSqlInsert()` 通过 Tauri IPC 发给 Rust 生成 INSERT → 再回前端 → `saveTextFile()` 写入。整个过程阻塞 UI 线程，保存对话框出现在最后。

**对比 CSV/XLSX/TXT 的后台流式导出**（右键表名导出、工具栏导出 query result）：
1. 先弹保存对话框（立即响应）
2. 注册后台任务（进度显示在 toolbar popover）
3. Rust 端流式分页读取 DB → 直接写入文件
4. 完成后 toast 通知

## Design

### 方案

在 `export_query_result_core_inner()` 的通用 JDBC 分页循环中添加 `"sql"` 格式支持。复用 `build_export_insert_statements()`，按 100 行一批 flush 到文件。

**不碰** Postgres/MySQL/ClickHouse/SQL Server 四个原生流式路径——SQL 格式只走分页循环（原生路径检测到 `format == "sql"` 返回 `false` 后回退）。

前端 `exportSql()` 增加 Step 2：先尝试 `exportQueryResultSqlViaBackend()` 走后台流式导出，失败/Web 才回退到当前本地导出。

### 修复的 Blocker

1. **复用 `buildQueryResultExportRequest`**（`queryResultExportRequest` callback），不手撸 request 对象。保留 `rowLimit`、`totalRows`、`timeoutSecs`、`useAgentCursor`、`setupSql`、`clientSessionId`、`executionId`、`keysetOptimizationEnabled` 等字段。
2. **`export_table_name` 兜底**：Rust 侧当 `export_table_name` 为空时回退到 `"query_result"`，纯 `SELECT` 查询不再报错。
3. **启动失败处理**：`startQueryResultExport()` rejecting 时将后台任务标记为 `Error`，清理 cancel handler，防止任务卡在 `Running` 状态。

## Files Changed

| File | What | Lines |
|------|------|-------|
| `crates/dbx-core/src/query_result_export.rs` | 格式守卫放松 + 分页循环 SQL 分支 + 新字段 + helper | ~80 |
| `apps/desktop/src/composables/useDataGridExport.ts` | 新增 `exportQueryResultSqlViaBackend`，`exportSql()` 增加 Step 2 | ~50 |
| `apps/desktop/src/components/grid/DataGrid.vue` | `queryResultExportRequest` prop 类型加 `"sql"` 和两个 new fields | ~5 |
| `apps/desktop/src/components/layout/ContentArea.vue` | 同 DataGrid.vue 类型更新 | ~3 |
| `apps/desktop/src/stores/queryStore.ts` | `BuildQueryResultExportRequestOptions` 加 `exportTableName`、`exportColumnTypes` | ~5 |
| `packages/app-tests/useDataGridExport.test.ts` | 测试适配（TXT/SQL Web fallback） | ~5 |

**Total: ~148 lines, zero new files, zero new dependencies.**

## Detailed Design

### 1. Rust: `QueryResultExportRequest` — new optional fields

File: `crates/dbx-core/src/query_result_export.rs`

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    // -- new fields --
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_column_types: Option<Vec<String>>,
}
```

### 2. Rust: format guard

Relax the existing guard to accept `"sql"`:

```rust
if format != "csv" && format != "xlsx" && format != "txt" && format != "sql" {
    return Err(format!("Unsupported streaming query-result export format: {format}"));
}
```

### 3. Rust: effective_row_limit

SQL format has no XLSX row cap:

```rust
fn effective_row_limit(format: &str, request: &QueryResultExportRequest) -> Option<usize> {
    if format == "xlsx" {
        Some(request.row_limit.map_or(XLSX_MAX_DATA_ROWS, |limit| limit.min(XLSX_MAX_DATA_ROWS)))
    } else {
        request.row_limit
    }
}
```

### 4. Rust: native stream skip

原生流式路径（Postgres/MySQL/ClickHouse/SQL Server）只支持 CSV/TXT/XLSX。在 `export_query_result_core_inner` 中跳过它们对 `"sql"` 的调用，改为直接走通用分页循环：

```rust
// Before: 对每种格式都尝试原生流
// After: SQL 格式跳过原生流路径
if format != "sql" {
    if try_export_postgres_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? { return Ok(()); }
    if try_export_sqlserver_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? { return Ok(()); }
    if try_export_mysql_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? { return Ok(()); }
    if try_export_clickhouse_query_result_stream(state, request, &format, cancel_token.clone(), on_progress).await? { return Ok(()); }
}
```

1 行变更（在原有 `if` 外包装一个 `format != "sql"` 条件），避免了修改 4 个原生函数的 60+ 行。

### 5. Rust: pagination loop — `"sql"` branch

Inserted alongside existing CSV/TXT branch. Uses a `pending_rows` buffer that flushes via `build_export_insert_statements` every 100 rows.

**New imports:**

```rust
use std::mem;
use crate::database_export::{build_export_insert_statements, BuildExportInsertStatementsOptions};
```

**New constant:**

```rust
const SQL_INSERT_BATCH_SIZE: usize = 100;
```

**New helper:**

```rust
fn sql_insert_column_types(request: &QueryResultExportRequest, column_types: &[String]) -> Vec<Option<String>> {
    request.export_column_types
        .as_ref()
        .map(|types| types.iter().map(|t| if t.is_empty() { None } else { Some(t.clone()) }).collect())
        .unwrap_or_else(|| vec![None; column_types.len()])
}
```

**New variables** (alongside existing `columns`/`column_types`):

```rust
let mut sql_file: Option<BufWriter<File>> = None;
let mut pending_rows: Vec<Vec<Value>> = Vec::new();
let mut sql_insert_col_types: Vec<Option<String>> = Vec::new();
```

**Initialize types** (inside existing `if columns.is_empty()` block):

```rust
if columns.is_empty() {
    columns = result.columns.clone();
    column_types = result.column_types.clone();
    sql_insert_col_types = sql_insert_column_types(request, &column_types);
}
```

**Write branch** (after the `if format == "csv" || format == "txt"` block):

```rust
} else if format == "sql" {
    if sql_file.is_none() {
        sql_file = Some(BufWriter::new(
            File::create(&request.file_path)
                .map_err(|e| format!("Failed to create SQL file: {e}"))?,
        ));
    }
    pending_rows.extend(formatted_rows);
    if pending_rows.len() >= SQL_INSERT_BATCH_SIZE {
        let col_types = sql_insert_col_types.clone();
        let table_name = request.export_table_name
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("query_result");
        let stmts = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(request.database_type),
            schema: request.schema.clone(),
            table_name: Some(table_name.to_string()),
            qualified_table_name: None,
            columns: columns.clone(),
            column_types: col_types,
            column_extras: Vec::new(),
            rows: mem::take(&mut pending_rows),
            batch_size: Some(SQL_INSERT_BATCH_SIZE),
        })?;
        let file = sql_file.as_mut().unwrap();
        for stmt in &stmts {
            writeln!(file, "{stmt}").map_err(|e| format!("Failed to write SQL: {e}"))?;
        }
    }
}
```

**Post-loop flush** (alongside CSV/TXT flush):

```rust
} else if format == "sql" {
    if !pending_rows.is_empty() {
        let col_types = sql_insert_col_types.clone();
        let table_name = request.export_table_name
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("query_result");
        let stmts = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(request.database_type),
            schema: request.schema.clone(),
            table_name: Some(table_name.to_string()),
            qualified_table_name: None,
            columns: columns.clone(),
            column_types: col_types,
            column_extras: Vec::new(),
            rows: mem::take(&mut pending_rows),
            batch_size: Some(SQL_INSERT_BATCH_SIZE),
        })?;
        for stmt in &stmts {
            writeln!(sql_file.as_mut().unwrap(), "{stmt}")
                .map_err(|e| format!("Failed to write SQL: {e}"))?;
        }
    }
    if let Some(file) = sql_file.as_mut() {
        file.flush().map_err(|e| format!("Failed to flush SQL file: {e}"))?;
    }
}
```

**File open output**: the `File::create` overwrites by design — same behavior as all other export formats.

### 6. Frontend: Types

**queryStore.ts:**

```typescript
interface BuildQueryResultExportRequestOptions {
  exportId: string;
  filePath: string;
  format: "csv" | "xlsx" | "txt" | "sql";      // ← "sql" 新增
  includeSqlSheet?: boolean;
  exportTableName?: string;                       // ← new
  exportColumnTypes?: Array<string | null | undefined>;  // ← new
}
```

**DataGrid.vue prop type:**

```typescript
queryResultExportRequest?: (options: {
  exportId: string;
  filePath: string;
  format: "csv" | "xlsx" | "txt" | "sql";    // ← "sql" 新增
  includeSqlSheet?: boolean;
  exportTableName?: string;                    // ← new
  exportColumnTypes?: Array<string | null | undefined>;  // ← new
}) => Promise<api.QueryResultExportRequest | undefined>;
```

### 6. Frontend: `exportQueryResultSqlViaBackend`

New function in `useDataGridExport.ts`.

**新增 import** (文件头部):

```typescript
import { useExportTracker } from "@/composables/useExportTracker";
```

**新增 destructure** (在 `useDataGridExport` 函数体开头):

```typescript
const { addTask, updateTableExportTask, registerTaskCancelHandler, unregisterTaskCancelHandler } = useExportTracker();
```

```typescript
async function exportQueryResultSqlViaBackend(rowIds?: number[]): Promise<boolean> {
  // Guard: 仅用于 query-result、无完整结果、桌面端
  if (rowIds !== undefined || context.value !== "results" || !queryResultExportRequest) return false;
  if (hasCompleteLocalResult?.value) return false;
  if (!isTauriRuntime()) return false;   // Web fall through → local export

  // 1. 保存对话框 FIRST（立即响应）
  let outputPath = exportFileName("query-result", "sql");
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: outputPath,
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  if (!path) return true;
  outputPath = path as string;

  // 2. 通过 buildQueryResultExportRequest 构建完整 request
  const exportId = uuid();
  const request = await queryResultExportRequest({
    exportId,
    filePath: outputPath,
    format: "sql",
    exportTableName: tableMeta.value?.tableName,
    exportColumnTypes: columnTypes.value?.map(
      t => t ?? null
    ) as Array<string | null | undefined> | undefined,
  });
  if (!request) throw new Error("Unable to build query result export request");

  // 3. 注册后台任务 + cancel handler
  registerTaskCancelHandler(exportId, () => api.cancelQueryResultExport(exportId, request.executionId));
  addTask(tableMeta.value?.tableName || "Query Result", "sql", outputPath, exportId);

  try {
    await api.startQueryResultExport(request, (progress) => {
      updateTableExportTask(exportId, progress);
      if (progress.status === "Done") {
        toast(t("grid.exported"));
      }
    });
  } catch (e) {
    // 4. 启动失败 → 标记 Error（修复 Blocker 3）
    updateTableExportTask(exportId, {
      exportId,
      tableName: tableMeta.value?.tableName || "Query Result",
      rowsExported: 0,
      totalRows: null,
      status: "Error" as const,
      errorMessage: e?.message || String(e),
    });
    throw e;
  } finally {
    unregisterTaskCancelHandler(exportId);
  }
  return true;
}
```

### 7. Frontend: `exportSql()` — new middle step

```typescript
async function exportSql(rowIds?: number[]) {
  await runExclusiveExport(async () => {
    try {
      // Step 1: table-data context — 已有后台表导出（不变）
      if (await exportFullTableDataViaBackend("sql", rowIds)) return;

      // Step 2: query-result context — NEW 后台流式导出
      if (await exportQueryResultSqlViaBackend(rowIds)) return;

      // Step 3: fallback — 本地导出（Web 和异常场景）
      const result = await resultToExport(rowIds, undefined, true, false);
      const exportData = sqlInsertExportData(result);
      const content = await formatSqlInsert({ ... });
      await saveTextFile(content, exportFileName(..., "sql", ...), "SQL", "sql");
      toast(t("grid.exported"));
    } catch (e: any) {
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
    }
  });
}
```

## User Experience Flow

```
1. 用户点击 "导出当前结果集全部数据 SQL INSERT"
2. 系统保存对话框立即弹出  ← 无冻结
3. 用户选择路径 → 点击保存
4. 后台任务指示器在 toolbar 出现（带进度条）
5. Export 分页流式执行：DB → 分批读取 → build INSERT → 写入文件
6. 完成 → toast "已导出"
   或
   失败 → 后台任务显示 Error 状态
```

## Backward Compatibility

- 新增字段均为 `Option` + `skip_serializing_if`，现有 caller 无损
- SQL INSERT 输出格式与现有 `build_export_insert_statements` 完全一致（batch 从 1→100，语义等价）
- 纯查询兜底表名 `"query_result"`，导出文件内容与之前不同（之前失败），属于 bugfix 而非 regression
- Web 端保持不变，仍走本地导出（Blob download）

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `startQueryResultExport` 拒绝启动 | catch 中标记 task Error + 清理 cancel handler |
| 文件创建失败 | 错误传播到前端，task 标记 Error |
| 磁盘满 | `std::io::Error` → 游标中断 → task Error |
| 用户取消 | CancellationToken → OnProgress(Cancelled) → 清理文件 |
| SQL 表单 export_table_name 为空 | Rust 回退到 `"query_result"` |
