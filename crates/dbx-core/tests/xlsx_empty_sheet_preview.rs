use std::path::{Path, PathBuf};

use dbx_core::table_import::{
    parse_xlsx_file_with_options, preview_table_import_file_with_request, TableImportParseOptions,
    TableImportPreviewRequest,
};
use dbx_formats::xlsx_export::{build_xlsx_workbook_multi, XlsxWorksheetData};
use serde_json::{json, Value};

fn worksheet(name: &str, columns: &[&str], rows: Vec<Vec<Value>>) -> XlsxWorksheetData {
    XlsxWorksheetData {
        sheet_name: Some(name.to_string()),
        columns: columns.iter().map(|column| column.to_string()).collect(),
        column_types: vec![],
        column_comments: vec![],
        rows,
        numeric_column_right_align: false,
        auto_filter: None,
        header_comment_rows: false,
    }
}

fn workbook_file() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sheets.xlsx");
    let bytes = build_xlsx_workbook_multi(&[
        worksheet("EmptyFirst", &[], vec![]),
        worksheet("Data", &["id"], vec![vec![json!(7)]]),
        worksheet("HeaderOnly", &["id"], vec![]),
        worksheet("EmptyLast", &[], vec![]),
    ])
    .unwrap();
    std::fs::write(&path, bytes).unwrap();
    (directory, path)
}

fn request(path: &Path, options: TableImportParseOptions) -> TableImportPreviewRequest {
    TableImportPreviewRequest {
        file_path: path.to_string_lossy().into_owned(),
        connection_id: None,
        database: None,
        source_ref: None,
        source_format: None,
        parse_options: options,
        preview_limit: Some(10),
    }
}

#[tokio::test]
async fn empty_excel_preview_preserves_sheet_choices_without_allowing_empty_imports() {
    let (_directory, path) = workbook_file();
    let expected_sheets = ["EmptyFirst", "Data", "HeaderOnly", "EmptyLast"];
    for sheet_name in [None, Some("EmptyFirst"), Some("HeaderOnly"), Some("EmptyLast")] {
        let options = TableImportParseOptions {
            sheet_name: sheet_name.map(str::to_string),
            ..TableImportParseOptions::default()
        };
        let preview = preview_table_import_file_with_request(request(&path, options.clone())).await.unwrap();
        assert_eq!(preview.sheets, expected_sheets);
        assert!(preview.rows.is_empty());
        assert_eq!(preview.total_rows, 0);
        assert!(preview.total_rows_exact);
        assert!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).is_err());
    }

    let options =
        TableImportParseOptions { sheet_name: Some("Data".to_string()), ..TableImportParseOptions::default() };
    let preview = preview_table_import_file_with_request(request(&path, options.clone())).await.unwrap();
    assert_eq!(preview.sheets, expected_sheets);
    assert_eq!(preview.columns, ["id"]);
    assert_eq!(preview.rows, [vec![json!(7)]]);
    assert_eq!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap().rows, preview.rows);
}

#[tokio::test]
async fn empty_excel_row_range_keeps_the_workbook_selectable() {
    let (_directory, path) = workbook_file();
    let options = TableImportParseOptions {
        sheet_name: Some("Data".to_string()),
        data_start_row: Some(20),
        ..TableImportParseOptions::default()
    };
    let preview = preview_table_import_file_with_request(request(&path, options.clone())).await.unwrap();
    assert_eq!(preview.sheets, ["EmptyFirst", "Data", "HeaderOnly", "EmptyLast"]);
    assert!(preview.rows.is_empty());
    assert!(preview.total_rows_exact);
    assert!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).is_err());
}

/// Replace one ZIP entry's content, keeping every other entry byte-for-byte.
fn rewrite_zip_entry(bytes: &[u8], entry: &str, replacement: &str) -> Vec<u8> {
    use std::io::{Cursor, Read, Write};
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        writer.start_file(file.name().to_string(), zip::write::SimpleFileOptions::default()).unwrap();
        if file.name() == entry {
            writer.write_all(replacement.as_bytes()).unwrap();
        } else {
            let mut content = String::new();
            file.read_to_string(&mut content).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
    }
    writer.finish().unwrap().into_inner()
}

// Regression for the review on PR #12738: a sheet whose only data row sits beyond the
// preview limit (id header in A1, first value in A100) must not be reported as an empty
// preview, and the other data sheets in the same workbook must stay importable.
#[tokio::test]
async fn sparse_excel_data_beyond_preview_limit_is_not_treated_as_empty() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("sparse.xlsx");
    let built = build_xlsx_workbook_multi(&[
        worksheet("Sparse", &["id"], vec![vec![json!(7)]]),
        worksheet("Normal", &["id"], vec![vec![json!(1)]]),
    ])
    .unwrap();
    let sparse_sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>
<row r="100"><c r="A100"><v>7</v></c></row>
</sheetData></worksheet>"#;
    std::fs::write(&path, rewrite_zip_entry(&built, "xl/worksheets/sheet1.xml", sparse_sheet_xml)).unwrap();

    let options =
        TableImportParseOptions { sheet_name: Some("Sparse".to_string()), ..TableImportParseOptions::default() };
    let preview = preview_table_import_file_with_request(request(&path, options.clone())).await.unwrap();
    assert_eq!(preview.columns, ["id"]);
    assert_eq!(preview.rows, [vec![json!(7)]]);
    assert_eq!(preview.total_rows, 1);
    assert!(!preview.total_rows_exact);
    assert_eq!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap().rows, preview.rows);

    let options =
        TableImportParseOptions { sheet_name: Some("Normal".to_string()), ..TableImportParseOptions::default() };
    let preview = preview_table_import_file_with_request(request(&path, options.clone())).await.unwrap();
    assert_eq!(preview.rows, [vec![json!(1)]]);
    assert!(preview.total_rows > 0);
    assert_eq!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 10).unwrap().rows, preview.rows);
}

// The preview grid-size guard counts only the anchored window: with the first data row at
// A200000 and a preview limit of 500, the blank-row span must not count as 200k preview
// cells and falsely fail with "preview grid is too large".
#[tokio::test]
async fn far_sparse_excel_preview_does_not_trip_the_grid_size_guard() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("far-sparse.xlsx");
    let built = build_xlsx_workbook_multi(&[worksheet("Sparse", &["id"], vec![vec![json!(7)]])]).unwrap();
    let sparse_sheet_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row>
<row r="200000"><c r="A200000"><v>7</v></c></row>
</sheetData></worksheet>"#;
    std::fs::write(&path, rewrite_zip_entry(&built, "xl/worksheets/sheet1.xml", sparse_sheet_xml)).unwrap();

    let options =
        TableImportParseOptions { sheet_name: Some("Sparse".to_string()), ..TableImportParseOptions::default() };
    let mut req = request(&path, options.clone());
    req.preview_limit = Some(500);
    let preview = preview_table_import_file_with_request(req).await.unwrap();
    assert_eq!(preview.columns, ["id"]);
    assert_eq!(preview.rows, [vec![json!(7)]]);
    assert_eq!(parse_xlsx_file_with_options(&path.to_string_lossy(), &options, 500).unwrap().rows, preview.rows);
}
