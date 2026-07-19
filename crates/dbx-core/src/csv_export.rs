use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::query::{execute_sql_statement_with_options, QueryExecutionOptions};
use crate::sql_dialect::{build_table_data_select_sql, TableDataSelectSqlOptions};

const TABLE_DATA_EXPORT_PAGE_SIZE: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCsvExportOptions {
    pub file_path: String,
    pub connection_id: String,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

/// CSV 转义直写目标 buffer：包引号 + 内部 `"` 翻倍。值不含 `"` 时整段拷贝，
/// 不做 replace 分配（逐批流式导出对每个单元格调用，是导出热路径）。
fn push_csv_escaped_content(out: &mut String, value: &str) {
    let mut rest = value;
    while let Some(pos) = rest.find('"') {
        out.push_str(&rest[..=pos]);
        out.push('"');
        rest = &rest[pos + 1..];
    }
    out.push_str(rest);
}

pub(crate) fn push_csv_escaped(out: &mut String, value: &str) {
    out.push('"');
    push_csv_escaped_content(out, value);
    out.push('"');
}

struct CsvEscapedWriter<'a>(&'a mut String);

impl fmt::Write for CsvEscapedWriter<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        push_csv_escaped_content(self.0, value);
        Ok(())
    }
}

/// 将表导出 CSV 值直接写入已有 buffer；包括 NULL 在内的值均保留分页导出的带引号旧语义。
pub(crate) fn push_csv_text_value(out: &mut String, value: &Value) {
    out.push('"');
    match value {
        Value::Null => {}
        Value::String(value) => push_csv_escaped_content(out, value),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        // 数组和对象可能包含引号，通过转义 writer 格式化，避免分配中间 JSON 字符串
        other => fmt::write(&mut CsvEscapedWriter(out), format_args!("{other}"))
            .expect("writing JSON into a String cannot fail"),
    }
    out.push('"');
}

fn push_csv_value(out: &mut String, value: &Value) {
    if value.is_null() {
        return;
    }
    push_csv_text_value(out, value);
}

/// TSV 转义直写：仅含特殊字符时包引号（语义与原 escape_tsv 一致）。
fn push_tsv_escaped(out: &mut String, value: &str) {
    if value.contains('\t') || value.contains('\n') || value.contains('\r') || value.contains('"') {
        push_csv_escaped(out, value);
    } else {
        out.push_str(value);
    }
}

fn push_tsv_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => {}
        Value::String(v) => push_tsv_escaped(out, v),
        Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        other => push_tsv_escaped(out, &other.to_string()),
    }
}

/// 预分配粗估：按全部行的实际单元格数求和（不假设等宽），饱和运算防溢出，
/// 并设上限——估算只是性能提示，绝不能因病态输入放大成巨额分配
const ROWS_CAPACITY_ESTIMATE_MAX: usize = 16 * 1024 * 1024;

pub(crate) fn estimated_rows_capacity(rows: &[Vec<Value>]) -> usize {
    let cells: usize = rows.iter().map(Vec::len).fold(0usize, usize::saturating_add);
    cells.saturating_mul(12).min(ROWS_CAPACITY_ESTIMATE_MAX)
}

pub(crate) fn escape_csv(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_csv_escaped(&mut out, value);
    out
}

fn format_csv_value(value: &Value) -> String {
    let mut out = String::new();
    push_csv_value(&mut out, value);
    out
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn escape_tsv(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    push_tsv_escaped(&mut out, value);
    out
}

fn push_tsv_rows(out: &mut String, rows: &[Vec<Value>]) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        for (cell_index, cell) in row.iter().enumerate() {
            if cell_index > 0 {
                out.push('\t');
            }
            push_tsv_value(out, cell);
        }
    }
}

pub(crate) fn format_tsv_rows(rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(estimated_rows_capacity(rows));
    push_tsv_rows(&mut out, rows);
    out
}

pub(crate) fn format_tsv(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            out.push('\t');
        }
        push_tsv_escaped(&mut out, column);
    }
    out.push('\n');
    push_tsv_rows(&mut out, rows);
    out
}

/// Format query-result rows as CSV text without a header row. Database NULLs
/// use the same empty-cell representation as table-data exports. Used by the
/// streaming query-result export for batches after the first.
fn push_query_result_csv_rows(out: &mut String, rows: &[Vec<Value>]) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        for (cell_index, cell) in row.iter().enumerate() {
            if cell_index > 0 {
                out.push(',');
            }
            push_csv_value(out, cell);
        }
    }
}

pub fn format_query_result_csv_rows(rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(estimated_rows_capacity(rows));
    push_query_result_csv_rows(&mut out, rows);
    out
}

fn format_csv_with_value_formatter(columns: &[String], rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_csv_escaped(&mut out, column);
    }
    out.push('\n');
    push_query_result_csv_rows(&mut out, rows);
    out
}

pub fn format_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    format_csv_with_value_formatter(columns, rows)
}

pub fn format_query_result_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    format_csv(columns, rows)
}

fn write_csv_text_row(writer: &mut impl Write, values: impl IntoIterator<Item = String>) -> Result<(), String> {
    let mut first = true;
    for value in values {
        if !first {
            writer.write_all(b",").map_err(|err| err.to_string())?;
        }
        first = false;
        writer.write_all(escape_csv(&value).as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn write_csv_value_row(writer: &mut impl Write, values: impl IntoIterator<Item = Value>) -> Result<(), String> {
    let mut first = true;
    for value in values {
        if !first {
            writer.write_all(b",").map_err(|err| err.to_string())?;
        }
        first = false;
        writer.write_all(format_csv_value(&value).as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.db_type)
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn export_table_data_csv_core(state: &AppState, options: TableCsvExportOptions) -> Result<u64, String> {
    let database_type = connection_database_type(state, &options.connection_id).await?;
    let page_size = options.page_size.unwrap_or(TABLE_DATA_EXPORT_PAGE_SIZE).max(1);
    let mut writer =
        BufWriter::new(File::create(&options.file_path).map_err(|err| format!("Failed to write CSV file: {err}"))?);
    writer.write_all("\u{FEFF}".as_bytes()).map_err(|err| err.to_string())?;

    let mut offset = 0usize;
    let mut rows_exported = 0u64;
    let mut wrote_header = false;

    loop {
        let sql = build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(database_type),
            schema: options.schema.clone(),
            table_name: options.table_name.clone(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: options.columns.clone(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(page_size),
            offset: Some(offset),
            where_input: None,
            include_row_id: false,
            ..Default::default()
        });
        let result = execute_sql_statement_with_options(
            state,
            &options.connection_id,
            &options.database,
            &sql,
            options.schema.as_deref(),
            None,
            QueryExecutionOptions {
                max_rows: Some(page_size),
                timeout_secs: options.timeout_secs,
                ..Default::default()
            },
        )
        .await?;

        if !wrote_header {
            write_csv_text_row(&mut writer, result.columns)?;
            wrote_header = true;
        }

        let fetched = result.rows.len();
        if fetched == 0 {
            break;
        }
        for row in result.rows {
            writer.write_all(b"\n").map_err(|err| err.to_string())?;
            write_csv_value_row(&mut writer, row)?;
        }

        rows_exported += fetched as u64;
        if fetched < page_size {
            break;
        }
        offset += fetched;
    }

    if rows_exported == 0 {
        writer.write_all(b"\n").map_err(|err| err.to_string())?;
    }
    writer.flush().map_err(|err| err.to_string())?;
    Ok(rows_exported)
}

#[cfg(test)]
mod tests {
    use super::{format_csv, format_query_result_csv, format_query_result_csv_rows, format_tsv};
    use serde_json::json;

    #[test]
    fn formats_csv_with_header_and_escaped_values() {
        let out = format_csv(&["id".to_string(), "name".to_string()], &[vec![json!(1), json!("Ada \"Lovelace\"")]]);
        assert_eq!(out, "\"id\",\"name\"\n\"1\",\"Ada \"\"Lovelace\"\"\"");
    }

    #[test]
    fn formats_null_as_empty_cell() {
        let out = format_csv(&["id".to_string(), "note".to_string()], &[vec![json!(1), Value::Null]]);
        assert_eq!(out, "\"id\",\"note\"\n\"1\",");
    }

    #[test]
    fn formats_query_result_null_as_empty_cell() {
        let out = format_query_result_csv(&["id".to_string(), "note".to_string()], &[vec![json!(1), Value::Null]]);
        assert_eq!(out, "\"id\",\"note\"\n\"1\",");
    }

    #[test]
    fn formats_streamed_query_result_null_as_empty_cell_and_preserves_literal_null() {
        let out = format_query_result_csv_rows(&[vec![Value::Null, json!("NULL"), json!("")]]);
        assert_eq!(out, ",\"NULL\",\"\"");
    }

    #[test]
    fn formats_tsv_with_empty_null_and_escaped_special_values() {
        let out = format_tsv(
            &["id".to_string(), "note".to_string()],
            &[vec![json!(1), Value::Null], vec![json!(2), json!("line1\n\"line2\"")]],
        );
        assert_eq!(out, "id\tnote\n1\t\n2\t\"line1\n\"\"line2\"\"\"");
    }

    #[test]
    fn capacity_estimate_sums_actual_cells_across_ragged_rows() {
        // 不等宽行按实际单元格数求和，不得按首行宽度放大
        let wide_first = vec![vec![serde_json::Value::Null; 1000], vec![], vec![serde_json::Value::Null]];
        assert_eq!(super::estimated_rows_capacity(&wide_first), 1001 * 12);
        assert!(super::estimated_rows_capacity(&[]) == 0);
    }

    #[test]
    fn escape_tsv_matches_reference_semantics() {
        // TSV 仅在含 \t/\n/\r/引号时包引号；逗号不触发
        for input in ["", "plain", "with,comma", "tab\there", "line\nbreak", "cr\rhere", "quo\"te", "\t\"mix\""] {
            let expected =
                if input.contains('\t') || input.contains('\n') || input.contains('\r') || input.contains('"') {
                    format!("\"{}\"", input.replace('"', "\"\""))
                } else {
                    input.to_string()
                };
            assert_eq!(super::escape_tsv(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn push_csv_escaped_matches_replace_reference() {
        // 直写实现必须与原 replace 版本逐字节等价（含引号在首/尾/连续的边界）
        for input in ["", "plain", "\"", "\"\"", "a\"b", "\"start", "end\"", "mid\"\"dle", "逗,号\n换行"] {
            let expected = format!("\"{}\"", input.replace('"', "\"\""));
            assert_eq!(super::escape_csv(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn push_csv_text_value_preserves_paginated_export_semantics() {
        let cases = [
            (serde_json::Value::Null, "\"\""),
            (serde_json::json!(true), "\"true\""),
            (serde_json::json!(42.5), "\"42.5\""),
            (serde_json::json!("a\"b"), "\"a\"\"b\""),
            (serde_json::json!({"key": "value"}), "\"{\"\"key\"\":\"\"value\"\"}\""),
        ];

        for (value, expected) in cases {
            let mut out = String::from("prefix,");
            super::push_csv_text_value(&mut out, &value);
            assert_eq!(out, format!("prefix,{expected}"));
        }
    }

    use serde_json::Value;
}
