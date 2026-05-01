# SQL File Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a safe SQL file execution/import workflow with toolbar and tree context-menu entry points, backend streaming execution, progress events, stop-on-error defaults, and cancellation.

**Architecture:** Add a focused Rust command module for SQL file preview, splitting, execution, progress events, and cancellation. Reuse the existing query execution path by extracting a small shared helper from `commands/query.rs`, then add a Vue dialog component that owns file selection and progress UI.

**Tech Stack:** Tauri 2 commands/events, Rust async file IO, existing `tokio_util::sync::CancellationToken`, Vue 3 + Pinia + shadcn-vue/reka UI, existing i18n files, existing Tauri dialog/fs patterns.

---

## File Structure

- Create `src-tauri/src/commands/sql_file.rs`
  - SQL splitter.
  - File preview command.
  - SQL file execution request/progress types.
  - File execution command and cancel command.
  - Rust unit tests for splitting and execution control flow.
- Modify `src-tauri/src/commands/query.rs`
  - Extract a reusable `execute_sql_statement` helper that accepts an optional cancellation token.
  - Keep existing `execute_query` behavior unchanged.
- Modify `src-tauri/src/commands/mod.rs`
  - Register `sql_file` module.
- Modify `src-tauri/src/lib.rs`
  - Register `preview_sql_file`, `execute_sql_file`, and `cancel_sql_file_execution`.
- Modify `src/lib/tauri.ts`
  - Add request/progress/preview types.
  - Add wrappers and event subscription helper.
- Modify `src/stores/connectionStore.ts`
  - Add `sqlFileSource` prefill state mirroring transfer/schema diff patterns.
- Create `src/components/sql-file/SqlFileExecutionDialog.vue`
  - File picker, connection/database selectors, preview metadata, progress UI, cancel.
- Modify `src/App.vue`
  - Toolbar entry.
  - Dialog state, prefill watcher, and component mount.
- Modify `src/components/sidebar/TreeItem.vue`
  - Context-menu entry on connection/database/schema nodes.
- Modify `src/i18n/locales/en.ts` and `src/i18n/locales/zh-CN.ts`
  - Add `sqlFile` strings and context-menu labels.

---

### Task 1: Backend SQL Splitter

**Files:**
- Create: `src-tauri/src/commands/sql_file.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Add failing splitter tests**

Add `mod sql_file;` to `src-tauri/src/commands/mod.rs`.

Create `src-tauri/src/commands/sql_file.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::split_sql_script;

    #[test]
    fn splits_semicolon_delimited_statements() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int); INSERT INTO a VALUES (1);").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn ignores_semicolons_inside_quotes_and_comments() {
        let sql = "\
            INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`);\n\
            -- comment ; ignored\n\
            /* block ; ignored */\n\
            SELECT 1;";
        assert_eq!(
            split_sql_script(sql).unwrap(),
            vec![
                "INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`)",
                "-- comment ; ignored\n/* block ; ignored */\nSELECT 1",
            ]
        );
    }

    #[test]
    fn emits_trailing_statement_without_semicolon() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int);\nINSERT INTO a VALUES (1)").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }
}
```

- [ ] **Step 2: Run splitter tests and verify RED**

Run:

```bash
cd src-tauri
cargo test sql_file::tests::splits_semicolon_delimited_statements --lib
```

Expected: fail because `split_sql_script` does not exist.

- [ ] **Step 3: Implement minimal splitter**

In `src-tauri/src/commands/sql_file.rs`, add:

```rust
use serde::{Deserialize, Serialize};

#[derive(Default)]
struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    previous: Option<char>,
}

impl SqlStatementSplitter {
    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let mut chars = chunk.chars().peekable();

        while let Some(ch) = chars.next() {
            let next = chars.peek().copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
            }

            match ch {
                '\'' if !self.in_double_quote && !self.in_backtick && self.previous != Some('\\') => {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote && !self.in_backtick && self.previous != Some('\\') => {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    self.push_current_statement(&mut statements);
                }
                _ => self.buffer.push(ch),
            }

            self.previous = Some(ch);
        }

        statements
    }

    fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if !statement.is_empty() {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.previous = None;
    }
}

#[cfg(test)]
fn split_sql_script(sql: &str) -> Result<Vec<String>, String> {
    let mut splitter = SqlStatementSplitter::default();
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    Ok(statements)
}
```

- [ ] **Step 4: Run splitter tests and verify GREEN**

Run:

```bash
cd src-tauri
cargo test sql_file::tests --lib
```

Expected: all splitter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/commands/sql_file.rs
git commit -m "add sql file statement splitter"
```

---

### Task 2: Shared Query Execution Helper

**Files:**
- Modify: `src-tauri/src/commands/query.rs`
- Test: `src-tauri/src/commands/query.rs`

- [ ] **Step 1: Add helper-level cancellation regression test**

Add this test to `src-tauri/src/commands/query.rs` tests module:

```rust
#[tokio::test]
async fn wait_for_query_without_token_still_times_out() {
    let result = wait_for_query(None, async {
        tokio::time::sleep(Duration::from_secs(31)).await;
        Ok(db::QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
        })
    })
    .await;

    assert_eq!(result.unwrap_err(), timeout_error());
}
```

- [ ] **Step 2: Run query tests and verify they pass before refactor**

Run:

```bash
cd src-tauri
cargo test commands::query::tests --lib
```

Expected: query tests pass before refactor.

- [ ] **Step 3: Extract reusable helper**

In `src-tauri/src/commands/query.rs`, add a public-in-commands helper below `do_execute`:

```rust
pub(super) async fn execute_sql_statement(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    cancel_token: Option<CancellationToken>,
) -> Result<db::QueryResult, String> {
    let pool_key = if database.is_empty() {
        connection_id.to_string()
    } else {
        state.get_or_create_pool(connection_id, Some(database)).await?
    };

    if is_canceled(&cancel_token) {
        return Err(canceled_error());
    }

    let result = do_execute(state, &pool_key, sql, cancel_token.clone()).await;

    match &result {
        Err(e) if is_connection_error(e) && !is_canceled(&cancel_token) => {
            let db_opt = if database.is_empty() { None } else { Some(database) };
            let new_key = state.reconnect_pool(connection_id, db_opt).await?;
            do_execute(state, &new_key, sql, cancel_token).await
        }
        _ => result,
    }
}
```

Then simplify `execute_query` to call it:

```rust
let result = execute_sql_statement(
    &state,
    &connection_id,
    &database,
    &sql,
    cancel_token,
)
.await;

result
```

- [ ] **Step 4: Run query tests**

Run:

```bash
cd src-tauri
cargo test commands::query::tests --lib
```

Expected: all query tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/query.rs
git commit -m "share query execution helper"
```

---

### Task 3: Backend SQL File Preview, Execution, Progress, And Cancel

**Files:**
- Modify: `src-tauri/src/commands/sql_file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add backend control-flow tests**

Add test-only fake execution helpers in `src-tauri/src/commands/sql_file.rs`:

```rust
#[cfg(test)]
mod execution_tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    async fn run_fake_script(
        statements: Vec<String>,
        continue_on_error: bool,
        cancel_after_successes: Option<usize>,
    ) -> SqlFileSummary {
        let token = CancellationToken::new();
        run_statements_for_test(statements, continue_on_error, token, cancel_after_successes).await
    }

    #[tokio::test]
    async fn stops_on_first_failure_by_default() {
        let summary = run_fake_script(
            vec!["ok 1".into(), "fail 2".into(), "ok 3".into()],
            false,
            None,
        ).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Error);
        assert_eq!(summary.failed_statement_index, Some(2));
    }

    #[tokio::test]
    async fn continues_after_failure_when_enabled() {
        let summary = run_fake_script(
            vec!["ok 1".into(), "fail 2".into(), "ok 3".into()],
            true,
            None,
        ).await;

        assert_eq!(summary.success_count, 2);
        assert_eq!(summary.failure_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Done);
    }

    #[tokio::test]
    async fn cancellation_stops_before_next_statement() {
        let summary = run_fake_script(
            vec!["ok 1".into(), "ok 2".into(), "ok 3".into()],
            true,
            Some(1),
        ).await;

        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.status, SqlFileStatus::Cancelled);
    }
}
```

- [ ] **Step 2: Run backend control-flow tests and verify RED**

Run:

```bash
cd src-tauri
cargo test sql_file::execution_tests --lib
```

Expected: fail because `SqlFileSummary`, `SqlFileStatus`, and `run_statements_for_test` do not exist.

- [ ] **Step 3: Add command types and execution implementation**

Add these types and command functions to `src-tauri/src/commands/sql_file.rs`:

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::commands::connection::AppState;
use crate::commands::query::execute_sql_statement;

static SQL_FILE_EXECUTIONS: std::sync::LazyLock<RwLock<HashMap<String, CancellationToken>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRequest {
    pub execution_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileStatus {
    Started,
    Running,
    StatementDone,
    StatementFailed,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileProgress {
    pub execution_id: String,
    pub status: SqlFileStatus,
    pub statement_index: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlFileSummary {
    status: SqlFileStatus,
    success_count: usize,
    failure_count: usize,
    failed_statement_index: Option<usize>,
}
```

Add preview command:

```rust
#[tauri::command]
pub async fn preview_sql_file(file_path: String) -> Result<SqlFilePreview, String> {
    let path = PathBuf::from(&file_path);
    let metadata = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let mut buffer = vec![0; 4096];
    let bytes_read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer)
        .await
        .map_err(|e| e.to_string())?;
    buffer.truncate(bytes_read);
    let preview = String::from_utf8_lossy(&buffer).to_string();

    Ok(SqlFilePreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("script.sql")
            .to_string(),
        file_path,
        size_bytes: metadata.len(),
        preview,
    })
}
```

Add execution command:

```rust
#[tauri::command]
pub async fn execute_sql_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: SqlFileRequest,
) -> Result<(), String> {
    let token = CancellationToken::new();
    SQL_FILE_EXECUTIONS
        .write()
        .await
        .insert(request.execution_id.clone(), token.clone());

    let started_at = Instant::now();
    emit_progress(&app, &request.execution_id, SqlFileStatus::Started, 0, 0, 0, 0, started_at, "", None);

    let result = execute_sql_file_inner(&app, &state, &request, token, started_at).await;
    SQL_FILE_EXECUTIONS.write().await.remove(&request.execution_id);
    result
}

#[tauri::command]
pub async fn cancel_sql_file_execution(execution_id: String) -> Result<bool, String> {
    let executions = SQL_FILE_EXECUTIONS.read().await;
    if let Some(token) = executions.get(&execution_id) {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}
```

Add the execution helpers:

```rust
async fn execute_sql_file_inner(
    app: &AppHandle,
    state: &AppState,
    request: &SqlFileRequest,
    token: CancellationToken,
    started_at: Instant,
) -> Result<(), String> {
    let file = tokio::fs::File::open(&request.file_path).await.map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut splitter = SqlStatementSplitter::default();
    let mut line = String::new();
    let mut statement_index = 0;
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut affected_rows = 0;

    loop {
        line.clear();
        let read = reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        for statement in splitter.push_chunk(&line) {
            statement_index += 1;
            let outcome = execute_statement_with_progress(
                app,
                state,
                request,
                &token,
                statement_index,
                &statement,
                &mut success_count,
                &mut failure_count,
                &mut affected_rows,
                started_at,
            )
            .await;
            if outcome? {
                return Ok(());
            }
        }
    }

    for statement in splitter.finish() {
        statement_index += 1;
        let outcome = execute_statement_with_progress(
            app,
            state,
            request,
            &token,
            statement_index,
            &statement,
            &mut success_count,
            &mut failure_count,
            &mut affected_rows,
            started_at,
        )
        .await;
        if outcome? {
            return Ok(());
        }
    }

    emit_progress(app, &request.execution_id, SqlFileStatus::Done, statement_index, success_count, failure_count, affected_rows, started_at, "", None);
    Ok(())
}

async fn execute_statement_with_progress(
    app: &AppHandle,
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    statement_index: usize,
    statement: &str,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    started_at: Instant,
) -> Result<bool, String> {
    if token.is_cancelled() {
        emit_progress(app, &request.execution_id, SqlFileStatus::Cancelled, statement_index, *success_count, *failure_count, *affected_rows, started_at, "", None);
        return Ok(true);
    }

    emit_progress(app, &request.execution_id, SqlFileStatus::Running, statement_index, *success_count, *failure_count, *affected_rows, started_at, statement, None);

    match execute_sql_statement(
        state,
        &request.connection_id,
        &request.database,
        statement,
        Some(token.clone()),
    ).await {
        Ok(result) => {
            *success_count += 1;
            *affected_rows += result.affected_rows;
            emit_progress(app, &request.execution_id, SqlFileStatus::StatementDone, statement_index, *success_count, *failure_count, *affected_rows, started_at, statement, None);
            Ok(false)
        }
        Err(err) => {
            *failure_count += 1;
            let status = if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::StatementFailed };
            emit_progress(app, &request.execution_id, status, statement_index, *success_count, *failure_count, *affected_rows, started_at, statement, Some(err.clone()));
            if token.is_cancelled() {
                return Ok(true);
            }
            if request.continue_on_error {
                Ok(false)
            } else {
                emit_progress(app, &request.execution_id, SqlFileStatus::Error, statement_index, *success_count, *failure_count, *affected_rows, started_at, statement, Some(format!("Statement {statement_index} failed: {err}. Previous {} statement(s) may have been committed.", statement_index.saturating_sub(1))));
                Ok(true)
            }
        }
    }
}

fn emit_progress(
    app: &AppHandle,
    execution_id: &str,
    status: SqlFileStatus,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    statement: &str,
    error: Option<String>,
) {
    let _ = app.emit("sql-file-progress", SqlFileProgress {
        execution_id: execution_id.to_string(),
        status,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        elapsed_ms: started_at.elapsed().as_millis(),
        statement_summary: statement_summary(statement),
        error,
    });
}

fn statement_summary(statement: &str) -> String {
    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 120 {
        collapsed
    } else {
        let mut summary = collapsed.chars().take(117).collect::<String>();
        summary.push_str("...");
        summary
    }
}
```

Use this outcome convention throughout Task 3: `Ok(true)` means stop because cancelled or stop-on-error already emitted a terminal event.

Add the test-only fake runner required by the tests:

```rust
#[cfg(test)]
async fn run_statements_for_test(
    statements: Vec<String>,
    continue_on_error: bool,
    token: CancellationToken,
    cancel_after_successes: Option<usize>,
) -> SqlFileSummary {
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut failed_statement_index = None;

    for (idx, statement) in statements.iter().enumerate() {
        if token.is_cancelled() {
            return SqlFileSummary {
                status: SqlFileStatus::Cancelled,
                success_count,
                failure_count,
                failed_statement_index,
            };
        }

        if statement.starts_with("fail") {
            failure_count += 1;
            failed_statement_index = Some(idx + 1);
            if !continue_on_error {
                return SqlFileSummary {
                    status: SqlFileStatus::Error,
                    success_count,
                    failure_count,
                    failed_statement_index,
                };
            }
        } else {
            success_count += 1;
            if cancel_after_successes == Some(success_count) {
                token.cancel();
            }
        }
    }

    SqlFileSummary {
        status: if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::Done },
        success_count,
        failure_count,
        failed_statement_index,
    }
}
```

- [ ] **Step 4: Register commands**

In `src-tauri/src/lib.rs`, add to `generate_handler!`:

```rust
commands::sql_file::preview_sql_file,
commands::sql_file::execute_sql_file,
commands::sql_file::cancel_sql_file_execution,
```

- [ ] **Step 5: Run backend tests**

Run:

```bash
cd src-tauri
cargo test sql_file --lib
cargo test commands::query::tests --lib
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/sql_file.rs src-tauri/src/lib.rs
git commit -m "execute sql files with progress"
```

---

### Task 4: Tauri API Wrappers And Store Prefill

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/stores/connectionStore.ts`

- [ ] **Step 1: Add TypeScript API types**

In `src/lib/tauri.ts`, add:

```ts
export type SqlFileStatus =
  | "started"
  | "running"
  | "statementDone"
  | "statementFailed"
  | "done"
  | "error"
  | "cancelled";

export interface SqlFileRequest {
  executionId: string;
  connectionId: string;
  database: string;
  filePath: string;
  continueOnError: boolean;
}

export interface SqlFilePreview {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  preview: string;
}

export interface SqlFileProgress {
  executionId: string;
  status: SqlFileStatus;
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
  elapsedMs: number;
  statementSummary: string;
  error?: string | null;
}
```

- [ ] **Step 2: Add wrappers**

In `src/lib/tauri.ts`, add:

```ts
export async function previewSqlFile(filePath: string): Promise<SqlFilePreview> {
  return invoke("preview_sql_file", { filePath });
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return invoke("execute_sql_file", { request });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return invoke("cancel_sql_file_execution", { executionId });
}

export async function listenSqlFileProgress(
  handler: (progress: SqlFileProgress) => void,
): Promise<UnlistenFn> {
  return listen<SqlFileProgress>("sql-file-progress", (event) => handler(event.payload));
}
```

- [ ] **Step 3: Add connection store prefill**

In `src/stores/connectionStore.ts`, add beside transfer/schema diff refs:

```ts
const sqlFileSource = ref<{ connectionId: string; database: string } | null>(null);
```

Return it from the store:

```ts
sqlFileSource,
```

- [ ] **Step 4: Run frontend typecheck**

Run:

```bash
pnpm build
```

Expected: build passes or fails only because the dialog is not created yet. If it fails because the new wrappers are unused, continue; TypeScript should not fail on unused exports.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauri.ts src/stores/connectionStore.ts
git commit -m "add sql file frontend api"
```

---

### Task 5: SQL File Execution Dialog

**Files:**
- Create: `src/components/sql-file/SqlFileExecutionDialog.vue`

- [ ] **Step 1: Create dialog component**

Create `src/components/sql-file/SqlFileExecutionDialog.vue`:

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileCode, Loader2, Play, Square } from "lucide-vue-next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/tauri";

const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();

const connectionId = ref("");
const database = ref("");
const filePath = ref("");
const preview = ref<api.SqlFilePreview | null>(null);
const continueOnError = ref(false);
const isRunning = ref(false);
const isCancelling = ref(false);
const executionId = ref("");
const progress = ref<api.SqlFileProgress | null>(null);
const error = ref("");

const sqlConnections = computed(() =>
  connectionStore.connections.filter((connection) => !["redis", "mongodb", "elasticsearch"].includes(connection.db_type)),
);

const selectedConnection = computed(() => connectionStore.getConfig(connectionId.value));
const canStart = computed(() => !!connectionId.value && !!filePath.value && !isRunning.value);

watch(open, (value) => {
  if (!value) return;
  connectionId.value = props.prefillConnectionId || sqlConnections.value[0]?.id || "";
  database.value = props.prefillDatabase || selectedConnection.value?.database || "";
  filePath.value = "";
  preview.value = null;
  continueOnError.value = false;
  isRunning.value = false;
  isCancelling.value = false;
  progress.value = null;
  error.value = "";
});

async function chooseFile() {
  const selected = await openDialog({
    filters: [{ name: "SQL", extensions: ["sql"] }],
    multiple: false,
  });
  if (!selected || Array.isArray(selected)) return;
  filePath.value = selected;
  preview.value = await api.previewSqlFile(selected);
}

async function start() {
  if (!canStart.value) return;
  error.value = "";
  progress.value = null;
  executionId.value = crypto.randomUUID();
  isRunning.value = true;
  isCancelling.value = false;
  const id = executionId.value;
  const unlisten = await api.listenSqlFileProgress((event) => {
    if (event.executionId !== id) return;
    progress.value = event;
    if (event.status === "done" || event.status === "error" || event.status === "cancelled") {
      isRunning.value = false;
      isCancelling.value = false;
    }
  });

  try {
    await api.executeSqlFile({
      executionId: id,
      connectionId: connectionId.value,
      database: database.value,
      filePath: filePath.value,
      continueOnError: continueOnError.value,
    });
  } catch (e: any) {
    error.value = String(e?.message || e);
    isRunning.value = false;
    isCancelling.value = false;
  } finally {
    unlisten();
  }
}

async function cancel() {
  if (!executionId.value) return;
  isCancelling.value = true;
  await api.cancelSqlFileExecution(executionId.value);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[680px]">
      <DialogHeader>
        <DialogTitle>{{ t("sqlFile.title") }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <div class="grid grid-cols-4 items-center gap-3">
          <label class="text-right text-sm">{{ t("connection.name") }}</label>
          <Select v-model="connectionId" :disabled="isRunning">
            <SelectTrigger class="col-span-3">
              <SelectValue :placeholder="t('editor.selectConnection')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">
                {{ connection.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="grid grid-cols-4 items-center gap-3">
          <label class="text-right text-sm">{{ t("connection.database") }}</label>
          <input v-model="database" class="col-span-3 h-9 rounded-md border bg-transparent px-3 text-sm" :disabled="isRunning" />
        </div>

        <div class="grid grid-cols-4 items-center gap-3">
          <label class="text-right text-sm">{{ t("sqlFile.file") }}</label>
          <div class="col-span-3 flex gap-2">
            <input :value="filePath" class="min-w-0 flex-1 h-9 rounded-md border bg-transparent px-3 text-sm" readonly />
            <Button variant="outline" :disabled="isRunning" @click="chooseFile">
              <FileCode class="h-4 w-4" />
              {{ t("sqlFile.chooseFile") }}
            </Button>
          </div>
        </div>

        <label class="ml-[25%] flex items-center gap-2 text-sm">
          <Checkbox v-model:checked="continueOnError" :disabled="isRunning" />
          {{ t("sqlFile.continueOnError") }}
        </label>

        <div v-if="preview" class="rounded-md border bg-muted/20 p-3 text-xs">
          <div class="mb-2 font-medium">{{ preview.fileName }} · {{ Math.ceil(preview.sizeBytes / 1024) }} KB</div>
          <pre class="max-h-36 overflow-auto whitespace-pre-wrap text-muted-foreground">{{ preview.preview }}</pre>
        </div>

        <div v-if="progress" class="rounded-md border p-3 text-sm">
          <div>{{ t("sqlFile.progress", { current: progress.statementIndex, success: progress.successCount, failed: progress.failureCount }) }}</div>
          <div class="mt-1 text-xs text-muted-foreground">{{ progress.statementSummary }}</div>
          <div v-if="progress.error" class="mt-2 text-xs text-destructive">{{ progress.error }}</div>
        </div>

        <div v-if="error" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {{ error }}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="isRunning" @click="open = false">{{ t("grid.dismiss") }}</Button>
        <Button v-if="isRunning" variant="destructive" :disabled="isCancelling" @click="cancel">
          <Loader2 v-if="isCancelling" class="h-4 w-4 animate-spin" />
          <Square v-else class="h-4 w-4" />
          {{ t("sqlFile.cancel") }}
        </Button>
        <Button v-else :disabled="!canStart" @click="start">
          <Play class="h-4 w-4" />
          {{ t("sqlFile.execute") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

- [ ] **Step 2: Run frontend build**

Run:

```bash
pnpm build
```

Expected: build passes. If TypeScript reports that `Checkbox` requires `boolean | "indeterminate"`, change the binding to `:checked="continueOnError" @update:checked="(value) => { continueOnError = value === true }"` and rerun `pnpm build`.

- [ ] **Step 3: Commit**

```bash
git add src/components/sql-file/SqlFileExecutionDialog.vue
git commit -m "add sql file execution dialog"
```

---

### Task 6: Toolbar And Tree Entry Points

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/sidebar/TreeItem.vue`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add App state and dialog mount**

In `src/App.vue`, import the dialog and icon:

```ts
import SqlFileExecutionDialog from "@/components/sql-file/SqlFileExecutionDialog.vue";
```

Add state beside transfer/schema diff state:

```ts
const showSqlFileDialog = ref(false);
const sqlFilePrefillConnectionId = ref("");
const sqlFilePrefillDatabase = ref("");
```

Add watcher:

```ts
watch(() => connectionStore.sqlFileSource, (v) => {
  if (v) {
    sqlFilePrefillConnectionId.value = v.connectionId;
    sqlFilePrefillDatabase.value = v.database;
    showSqlFileDialog.value = true;
    connectionStore.sqlFileSource = null;
  }
});
```

Add toolbar button after Data Transfer:

```vue
<Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="showSqlFileDialog = true" :disabled="!connectionStore.connections.length">
  <FileCode class="h-3.5 w-3.5" />
  {{ t('sqlFile.title') }}
</Button>
```

Mount dialog near existing dialogs:

```vue
<SqlFileExecutionDialog
  v-model:open="showSqlFileDialog"
  :prefill-connection-id="sqlFilePrefillConnectionId"
  :prefill-database="sqlFilePrefillDatabase"
/>
```

- [ ] **Step 2: Add tree context action**

In `src/components/sidebar/TreeItem.vue`, add:

```ts
function openSqlFileExecution() {
  if (props.node.connectionId) {
    connectionStore.sqlFileSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}
```

For connection menu, add after New Query:

```vue
<ContextMenuItem @click="openSqlFileExecution">
  <FileCode class="w-4 h-4" /> {{ t('sqlFile.title') }}
</ContextMenuItem>
```

For database/schema menu, add after New Query:

```vue
<ContextMenuItem @click="openSqlFileExecution">
  <FileCode class="w-4 h-4" /> {{ t('sqlFile.title') }}
</ContextMenuItem>
```

- [ ] **Step 3: Add i18n strings**

In `src/i18n/locales/en.ts`, add:

```ts
sqlFile: {
  title: "Execute SQL File",
  file: "SQL File",
  chooseFile: "Choose File",
  execute: "Execute File",
  cancel: "Cancel",
  continueOnError: "Continue after failed statements",
  progress: "Statement {current} · {success} succeeded · {failed} failed",
},
```

In `src/i18n/locales/zh-CN.ts`, add:

```ts
sqlFile: {
  title: "执行 SQL 文件",
  file: "SQL 文件",
  chooseFile: "选择文件",
  execute: "执行文件",
  cancel: "取消",
  continueOnError: "失败后继续执行",
  progress: "第 {current} 条 · 成功 {success} · 失败 {failed}",
},
```

- [ ] **Step 4: Run frontend build**

Run:

```bash
pnpm build
```

Expected: build passes.

- [ ] **Step 5: Commit**

```bash
git add src/App.vue src/components/sidebar/TreeItem.vue src/i18n/locales/en.ts src/i18n/locales/zh-CN.ts
git commit -m "wire sql file execution entry points"
```

---

### Task 7: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run Rust tests**

Run:

```bash
cd src-tauri
cargo test --lib
```

Expected: all tests pass.

- [ ] **Step 2: Run frontend build**

Run:

```bash
pnpm build
```

Expected: build passes. Existing chunk-size warnings are acceptable.

- [ ] **Step 3: Run diff hygiene**

Run:

```bash
git diff --check
git status -sb
```

Expected: no whitespace errors. Status should show only intended tracked changes plus any pre-existing untracked docs that are not part of this PR.

- [ ] **Step 4: Manual smoke test**

Create a small file outside the repo:

```sql
CREATE TABLE IF NOT EXISTS codex_sql_file_test (id INTEGER);
INSERT INTO codex_sql_file_test VALUES (1);
SELECT * FROM codex_sql_file_test;
```

Open DBX with `pnpm tauri dev`, choose a local SQLite or DuckDB connection, execute the file, and verify progress reaches done with at least two successful statements.

- [ ] **Step 5: Manual failure smoke test**

Create a small file outside the repo:

```sql
CREATE TABLE IF NOT EXISTS codex_sql_file_test_failure (id INTEGER);
BROKEN STATEMENT;
INSERT INTO codex_sql_file_test_failure VALUES (1);
```

Run with default stop-on-error. Verify the dialog stops at statement 2 and shows the error without executing statement 3.

- [ ] **Step 6: Final commit after verification fixes**

If verification uncovers a concrete issue, stage the exact files changed by that fix:

```bash
git add src-tauri/src/commands/sql_file.rs src/App.vue src/components/sql-file/SqlFileExecutionDialog.vue src/lib/tauri.ts
git commit -m "polish sql file execution"
```

If those exact files were not all touched by the fix, remove the untouched paths from the `git add` command before running it. If no verification fixes were needed, leave the task commits as the implementation history.
