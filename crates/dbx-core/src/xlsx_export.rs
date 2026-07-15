use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Seek, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorksheetData {
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// Streaming XLSX writer that incrementally writes rows to a ZIP-backed
/// workbook.  This avoids accumulating all rows in memory before building the
/// final file, drastically reducing peak memory for large exports.
pub struct StreamingXlsxWriter<W: Write + Seek> {
    zip: zip::ZipWriter<W>,
    columns: Vec<String>,
    column_types: Vec<String>,
    next_row_number: usize,
    trailing_sheets: Vec<XlsxWorksheetData>,
}

/// Estimate column widths from header names only (used by the streaming path
/// where full row data is not available up-front).  Each width is clamped to
/// [10, 60] to stay within reasonable bounds.
fn estimate_header_widths(columns: &[String]) -> Vec<usize> {
    columns.iter().map(|col| (col.chars().count() + 2).clamp(10, 60)).collect()
}

/// Build the `<cols>` XML fragment from a width slice.
fn cols_xml(widths: &[usize]) -> String {
    widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            format!("<col min=\"{}\" max=\"{}\" width=\"{}\" customWidth=\"1\"/>", index + 1, index + 1, width)
        })
        .collect()
}

/// Build a single `<row>` XML fragment for the header row (row 1).
pub(crate) fn header_row_xml(columns: &[String]) -> String {
    format!(
        "<row r=\"1\">{}</row>",
        columns
            .iter()
            .enumerate()
            .map(|(index, col)| cell_xml(Some(&Value::String(col.clone())), 0, index, Some(1)))
            .collect::<String>()
    )
}

/// Build a single `<row>` XML fragment for a data row.
pub(crate) fn data_row_xml(row_number: usize, columns: &[String], column_types: &[String], row: &[Value]) -> String {
    let cells = columns
        .iter()
        .enumerate()
        .map(|(col_index, _)| {
            typed_cell_xml(row.get(col_index), column_types.get(col_index), row_number - 1, col_index, None)
        })
        .collect::<String>();
    format!("<row r=\"{row_number}\">{cells}</row>")
}

/// Shared ZIP entry options for all XLSX parts. XLSX is a ZIP of XML, and the
/// `inlineStr` cell encoding is highly repetitive, so Deflate typically shrinks
/// the file several-fold over `Stored` (matching what Excel/Navicat produce).
fn xlsx_zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

fn write_zip_entry<W: Write + Seek>(zip: &mut zip::ZipWriter<W>, path: &str, content: &str) -> Result<(), String> {
    zip.start_file(path, xlsx_zip_options()).map_err(|err| err.to_string())?;
    zip.write_all(content.as_bytes()).map_err(|err| err.to_string())
}

/// Start a new streaming XLSX workbook.  The ZIP skeleton, worksheet header,
/// column widths (estimated from header names) and the header row are written
/// immediately.  Callers then feed data rows via [`StreamingXlsxWriter::write_row`]
/// and finalize with [`StreamingXlsxWriter::finish`].
pub(crate) fn start_streaming_xlsx_workbook<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
) -> Result<StreamingXlsxWriter<W>, String> {
    start_streaming_xlsx_workbook_with_trailing_sheets(writer, sheet_name, columns, column_types, &[])
}

pub(crate) fn start_streaming_xlsx_workbook_with_trailing_sheets<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
    trailing_sheets: &[XlsxWorksheetData],
) -> Result<StreamingXlsxWriter<W>, String> {
    let primary_sheet = XlsxWorksheetData {
        sheet_name: sheet_name.map(str::to_string),
        columns: columns.to_vec(),
        column_types: column_types.to_vec(),
        rows: Vec::new(),
    };
    let all_sheets = std::iter::once(primary_sheet).chain(trailing_sheets.iter().cloned()).collect::<Vec<_>>();
    let sheet_names = normalize_unique_sheet_names(&all_sheets);
    let sheet_count = sheet_names.len();
    let widths = estimate_header_widths(columns);

    let mut zip = zip::ZipWriter::new(writer);
    write_zip_entry(&mut zip, "[Content_Types].xml", &content_types_xml_for_sheet_count(sheet_count))?;
    write_zip_entry(&mut zip, "_rels/.rels", root_rels_xml())?;
    write_zip_entry(&mut zip, "xl/workbook.xml", &workbook_xml_for_sheets(&sheet_names))?;
    write_zip_entry(&mut zip, "xl/_rels/workbook.xml.rels", &workbook_rels_xml_for_sheet_count(sheet_count))?;
    write_zip_entry(&mut zip, "xl/styles.xml", styles_xml())?;

    // Begin the sheet1.xml entry with header, frozen pane, column widths and
    // the header row.
    let options = xlsx_zip_options();
    zip.start_file("xl/worksheets/sheet1.xml", options).map_err(|err| err.to_string())?;

    let sheet_header = format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
            "<sheetViews><sheetView workbookViewId=\"0\">",
            "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>",
            "</sheetView></sheetViews>",
            "<sheetFormatPr defaultRowHeight=\"15\"/>",
            "<cols>{cols}</cols>",
            "<sheetData>"
        ),
        cols = cols_xml(&widths),
    );
    zip.write_all(sheet_header.as_bytes()).map_err(|err| err.to_string())?;
    zip.write_all(header_row_xml(columns).as_bytes()).map_err(|err| err.to_string())?;

    Ok(StreamingXlsxWriter {
        zip,
        columns: columns.to_vec(),
        column_types: column_types.to_vec(),
        next_row_number: 2,
        trailing_sheets: trailing_sheets.to_vec(),
    })
}

impl<W: Write + Seek> StreamingXlsxWriter<W> {
    /// Append a single data row to the worksheet.
    pub fn write_row(&mut self, row: &[Value]) -> Result<(), String> {
        self.zip
            .write_all(data_row_xml(self.next_row_number, &self.columns, &self.column_types, row).as_bytes())
            .map_err(|err| err.to_string())?;
        self.next_row_number += 1;
        Ok(())
    }

    /// Finalize the worksheet and close the ZIP archive.  Returns the
    /// underlying writer so callers can flush / close it as needed.
    pub fn finish(mut self) -> Result<W, String> {
        let row_count = self.next_row_number.saturating_sub(1);
        let range = sheet_range(self.columns.len(), row_count);
        self.zip
            .write_all(format!("</sheetData><autoFilter ref=\"{range}\"/></worksheet>").as_bytes())
            .map_err(|err| err.to_string())?;
        for (index, sheet) in self.trailing_sheets.iter().enumerate() {
            self.zip
                .start_file(format!("xl/worksheets/sheet{}.xml", index + 2), xlsx_zip_options())
                .map_err(|err| err.to_string())?;
            self.zip.write_all(worksheet_xml(sheet).as_bytes()).map_err(|err| err.to_string())?;
        }
        self.zip.finish().map_err(|err| err.to_string())
    }
}

/// Convenience wrapper that finalizes a streaming workbook.
pub(crate) fn finish_streaming_xlsx_workbook<W: Write + Seek>(writer: StreamingXlsxWriter<W>) -> Result<W, String> {
    writer.finish()
}

fn escape_xml(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        let code = ch as u32;
        if code != 9 && code != 10 && code != 13 && code < 32 {
            continue;
        }
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            _ => result.push(ch),
        }
    }
    result
}

fn column_name(index: usize) -> String {
    let mut out = String::new();
    let mut n = index + 1;
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push((b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    out.chars().rev().collect()
}

fn cell_ref(row_index: usize, col_index: usize) -> String {
    format!("{}{}", column_name(col_index), row_index + 1)
}

fn sheet_range(column_count: usize, row_count: usize) -> String {
    if column_count == 0 || row_count == 0 {
        return "A1".to_string();
    }
    format!("A1:{}{}", column_name(column_count - 1), row_count)
}

fn normalize_sheet_name(input: Option<&str>) -> String {
    let base = input.unwrap_or("Sheet1");
    let name: String = base
        .chars()
        .map(|ch| match ch {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => ' ',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();
    let fallback = if name.is_empty() { "Sheet1" } else { &name };
    fallback.chars().take(31).collect()
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn estimate_column_widths(columns: &[String], rows: &[Vec<Value>]) -> Vec<usize> {
    columns
        .iter()
        .enumerate()
        .map(|(col_index, column)| {
            let max_len = std::iter::once(column.chars().count().min(60))
                .chain(rows.iter().take(100).map(|row| value_text(row.get(col_index)).chars().count().min(60)))
                .fold(8usize, usize::max);
            (max_len + 2).clamp(10, 60)
        })
        .collect()
}

fn cell_xml(value: Option<&Value>, row_index: usize, col_index: usize, style: Option<usize>) -> String {
    let reference = cell_ref(row_index, col_index);
    let style_attr = style.map_or(String::new(), |s| format!(" s=\"{s}\""));
    match value {
        Some(Value::Null) | None => format!("<c r=\"{reference}\"{style_attr}/>"),
        Some(Value::Bool(v)) => {
            let bool_v = if *v { 1 } else { 0 };
            format!("<c r=\"{reference}\" t=\"b\"{style_attr}><v>{bool_v}</v></c>")
        }
        Some(Value::Number(n)) => {
            if n.as_f64().is_some_and(|f| f.is_finite()) {
                format!("<c r=\"{reference}\"{style_attr}><v>{}</v></c>", n)
            } else {
                format!(
                    "<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>",
                    escape_xml(&n.to_string())
                )
            }
        }
        Some(Value::String(s)) => {
            format!("<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>", escape_xml(s))
        }
        Some(other) => format!(
            "<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>",
            escape_xml(&other.to_string())
        ),
    }
}

fn is_numeric_column_type(column_type: Option<&String>) -> bool {
    let normalized = column_type.map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default();
    let base = normalized.split(['(', ' ', '[']).next().unwrap_or_default();
    matches!(
        base,
        "bit"
            | "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "int2"
            | "int4"
            | "int8"
            | "uint8"
            | "uint16"
            | "uint32"
            | "uint64"
            | "uint128"
            | "uint256"
            | "float"
            | "float4"
            | "float8"
            | "float32"
            | "float64"
            | "real"
            | "double"
            | "decimal"
            | "numeric"
            | "number"
            | "money"
            | "smallmoney"
    )
}

fn safe_excel_number(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.parse::<f64>().ok().is_none_or(|number| !number.is_finite()) {
        return None;
    }
    // Excel stores numbers with at most 15 significant decimal digits. Keep
    // higher-precision database values as text rather than silently rounding.
    let significant_digits = trimmed
        .split(['e', 'E'])
        .next()
        .unwrap_or(trimmed)
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .skip_while(|ch| *ch == '0')
        .count();
    (significant_digits <= 15).then_some(trimmed)
}

fn typed_cell_xml(
    value: Option<&Value>,
    column_type: Option<&String>,
    row_index: usize,
    col_index: usize,
    style: Option<usize>,
) -> String {
    if is_numeric_column_type(column_type) {
        if let Some(Value::String(value)) = value {
            if let Some(number) = safe_excel_number(value) {
                let reference = cell_ref(row_index, col_index);
                let style_attr = style.map_or(String::new(), |style| format!(" s=\"{style}\""));
                return format!("<c r=\"{reference}\"{style_attr}><v>{number}</v></c>");
            }
        }
    }
    cell_xml(value, row_index, col_index, style)
}

fn worksheet_xml(data: &XlsxWorksheetData) -> String {
    let total_rows = data.rows.len() + 1;
    let range = sheet_range(data.columns.len(), total_rows);
    let widths = estimate_column_widths(&data.columns, &data.rows);

    let cols_xml = widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            format!("<col min=\"{}\" max=\"{}\" width=\"{}\" customWidth=\"1\"/>", index + 1, index + 1, width)
        })
        .collect::<String>();

    let header_xml = format!(
        "<row r=\"1\">{}</row>",
        data.columns
            .iter()
            .enumerate()
            .map(|(index, col)| cell_xml(Some(&Value::String(col.clone())), 0, index, Some(1)))
            .collect::<String>()
    );

    let body_xml = data
        .rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let excel_row = row_index + 2;
            let cells = data
                .columns
                .iter()
                .enumerate()
                .map(|(col_index, _)| {
                    typed_cell_xml(row.get(col_index), data.column_types.get(col_index), excel_row - 1, col_index, None)
                })
                .collect::<String>();
            format!("<row r=\"{excel_row}\">{cells}</row>")
        })
        .collect::<String>();

    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
            "<dimension ref=\"{range}\"/>",
            "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>",
            "<sheetFormatPr defaultRowHeight=\"15\"/>",
            "<cols>{cols_xml}</cols>",
            "<sheetData>{header_xml}{body_xml}</sheetData>",
            "<autoFilter ref=\"{range}\"/>",
            "</worksheet>"
        ),
        range = range,
        cols_xml = cols_xml,
        header_xml = header_xml,
        body_xml = body_xml,
    )
}

fn content_types_xml_for_sheet_count(sheet_count: usize) -> String {
    let worksheet_overrides = (1..=sheet_count)
        .map(|index| {
            format!(
                "<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            )
        })
        .collect::<String>();
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
            "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
            "{}",
            "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>",
            "</Types>"
        ),
        worksheet_overrides
    )
}

fn root_rels_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
        "</Relationships>"
    )
}

fn workbook_xml_for_sheets(sheet_names: &[String]) -> String {
    let sheets = sheet_names
        .iter()
        .enumerate()
        .map(|(index, sheet_name)| {
            let sheet_id = index + 1;
            format!("<sheet name=\"{}\" sheetId=\"{sheet_id}\" r:id=\"rId{sheet_id}\"/>", escape_xml(sheet_name))
        })
        .collect::<String>();
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
            "<sheets>{}</sheets>",
            "</workbook>"
        ),
        sheets
    )
}

fn workbook_rels_xml_for_sheet_count(sheet_count: usize) -> String {
    let worksheet_rels = (1..=sheet_count)
        .map(|index| {
            format!(
                "<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>"
            )
        })
        .collect::<String>();
    let styles_id = sheet_count + 1;
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
            "{}",
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
            "</Relationships>"
        ),
        worksheet_rels, styles_id
    )
}

fn styles_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
        "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>",
        "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>",
        "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>",
        "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>",
        "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>",
        "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>",
        "</styleSheet>"
    )
}

fn normalize_unique_sheet_names(sheets: &[XlsxWorksheetData]) -> Vec<String> {
    let mut names = Vec::with_capacity(sheets.len());
    for (index, sheet) in sheets.iter().enumerate() {
        let base = normalize_sheet_name(sheet.sheet_name.as_deref().or(Some(&format!("Sheet{}", index + 1))));
        let mut candidate = base.clone();
        let mut suffix = 2;
        while names.iter().any(|name| name == &candidate) {
            let suffix_text = format!(" ({suffix})");
            let max_base_len = 31usize.saturating_sub(suffix_text.chars().count());
            candidate = format!("{}{}", base.chars().take(max_base_len).collect::<String>(), suffix_text);
            suffix += 1;
        }
        names.push(candidate);
    }
    names
}

pub fn build_xlsx_workbook(data: &XlsxWorksheetData) -> Result<Vec<u8>, String> {
    build_xlsx_workbook_multi(std::slice::from_ref(data))
}

pub fn build_xlsx_workbook_multi(sheets: &[XlsxWorksheetData]) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("At least one worksheet is required".to_string());
    }
    let sheet_names = normalize_unique_sheet_names(sheets);
    let files = vec![
        ("[Content_Types].xml", content_types_xml_for_sheet_count(sheets.len())),
        ("_rels/.rels", root_rels_xml().to_string()),
        ("xl/workbook.xml", workbook_xml_for_sheets(&sheet_names)),
        ("xl/_rels/workbook.xml.rels", workbook_rels_xml_for_sheet_count(sheets.len())),
        ("xl/styles.xml", styles_xml().to_string()),
    ];

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = xlsx_zip_options();

    for (path, content) in files {
        zip.start_file(path, options).map_err(|err| err.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|err| err.to_string())?;
    }
    for (index, sheet) in sheets.iter().enumerate() {
        zip.start_file(format!("xl/worksheets/sheet{}.xml", index + 1), options).map_err(|err| err.to_string())?;
        zip.write_all(worksheet_xml(sheet).as_bytes()).map_err(|err| err.to_string())?;
    }

    let output = zip.finish().map_err(|err| err.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{
        build_xlsx_workbook, build_xlsx_workbook_multi, start_streaming_xlsx_workbook,
        start_streaming_xlsx_workbook_with_trailing_sheets, XlsxWorksheetData,
    };
    use calamine::{open_workbook_auto, Reader};
    use serde_json::json;
    use std::fs;
    use std::io::Read;

    /// Read and decompress a single entry from an in-memory XLSX (ZIP) buffer.
    fn read_zip_entry(bytes: &[u8], path: &str) -> String {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("open xlsx as zip archive");
        let mut entry = archive.by_name(path).unwrap_or_else(|_| panic!("missing zip entry: {path}"));
        let mut content = String::new();
        entry.read_to_string(&mut content).expect("read zip entry");
        content
    }

    /// Assert every entry in the XLSX (ZIP) buffer is Deflate-compressed, which
    /// is what keeps exported workbooks small (see `xlsx_zip_options`).
    fn assert_all_entries_deflated(bytes: &[u8]) {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("open xlsx as zip archive");
        for index in 0..archive.len() {
            let entry = archive.by_index(index).expect("zip entry");
            assert_eq!(
                entry.compression(),
                zip::CompressionMethod::Deflated,
                "entry {} should be Deflate-compressed",
                entry.name()
            );
        }
    }

    #[test]
    fn builds_xlsx_zip_with_sheet_data() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Users".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
            column_types: vec![],
            rows: vec![vec![json!(1), json!("Ada & Bob"), json!(true)], vec![json!(2), json!(null), json!(false)]],
        })
        .expect("build workbook");

        // ZIP magic bytes.
        assert_eq!(workbook[0], 0x50);
        assert_eq!(workbook[1], 0x4b);

        // Entries are stored compressed; assert on their decompressed contents.
        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        let workbook_xml = read_zip_entry(&workbook, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Users\""));
        assert!(sheet.contains("<c r=\"A2\"><v>1</v></c>"));
        assert!(sheet.contains("Ada &amp; Bob"));
        assert!(sheet.contains("<c r=\"C2\" t=\"b\"><v>1</v></c>"));
        assert_all_entries_deflated(&workbook);
    }

    #[test]
    fn writes_safe_numeric_strings_as_numbers_for_numeric_columns() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Amounts".to_string()),
            columns: vec!["quantity".to_string(), "amount".to_string(), "code".to_string()],
            column_types: vec!["decimal(10,5)".to_string(), "numeric".to_string(), "varchar".to_string()],
            rows: vec![vec![json!("1.00000"), json!("2800.000000"), json!("00123")]],
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<c r=\"A2\"><v>1.00000</v></c>"));
        assert!(sheet.contains("<c r=\"B2\"><v>2800.000000</v></c>"));
        assert!(sheet.contains("<c r=\"C2\" t=\"inlineStr\"><is><t>00123</t></is></c>"));
    }

    #[test]
    fn writes_mysql_57_numeric_strings_as_numeric_cells() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("MySQL 5.7".to_string()),
            columns: vec![
                "id".to_string(),
                "nullable_int".to_string(),
                "tinyint_value".to_string(),
                "unsigned_int_value".to_string(),
                "bigint_safe".to_string(),
                "float_value".to_string(),
                "double_value".to_string(),
                "decimal_value".to_string(),
            ],
            column_types: vec![
                "bigint".to_string(),
                "int(11)".to_string(),
                "tinyint(4)".to_string(),
                "int(10) unsigned".to_string(),
                "bigint(20)".to_string(),
                "float".to_string(),
                "double".to_string(),
                "decimal(18,6)".to_string(),
            ],
            rows: vec![vec![
                json!("2"),
                json!("42"),
                json!("-7"),
                json!("4000000000"),
                json!("123456789012345"),
                json!("123.5"),
                json!("987654.321"),
                json!("2800.000000"),
            ]],
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        for (reference, value) in [
            ("A2", "2"),
            ("B2", "42"),
            ("C2", "-7"),
            ("D2", "4000000000"),
            ("E2", "123456789012345"),
            ("F2", "123.5"),
            ("G2", "987654.321"),
            ("H2", "2800.000000"),
        ] {
            assert!(sheet.contains(&format!("<c r=\"{reference}\"><v>{value}</v></c>")), "sheet={sheet}");
        }
    }

    #[test]
    fn preserves_high_precision_numeric_strings_as_text() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Precision".to_string()),
            columns: vec!["large_id".to_string(), "precise_amount".to_string()],
            column_types: vec!["bigint".to_string(), "decimal(30,10)".to_string()],
            rows: vec![vec![json!("9223372036854775807"), json!("123456789012345.6789000000")]],
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("t=\"inlineStr\"") && sheet.contains("9223372036854775807"));
        assert!(sheet.contains("123456789012345.6789000000"));
    }

    #[test]
    fn sanitizes_invalid_sheet_name() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("bad/name:with*chars?and-a-very-long-tail".to_string()),
            columns: vec!["value".to_string()],
            column_types: vec![],
            rows: vec![vec![json!("ok")]],
        })
        .expect("build workbook");
        let workbook_xml = read_zip_entry(&workbook, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"bad name with chars and-a-very-\""));
    }

    #[test]
    fn builds_multi_sheet_xlsx_workbook() {
        let path = std::env::temp_dir().join(format!("dbx-multi-sheet-test-{}.xlsx", uuid::Uuid::new_v4()));
        let workbook = build_xlsx_workbook_multi(&[
            XlsxWorksheetData {
                sheet_name: Some("Result 1".to_string()),
                columns: vec!["id".to_string()],
                column_types: vec![],
                rows: vec![vec![json!(1)]],
            },
            XlsxWorksheetData {
                sheet_name: Some("Result 2".to_string()),
                columns: vec!["name".to_string()],
                column_types: vec![],
                rows: vec![vec![json!("Ada")]],
            },
        ])
        .expect("build multi-sheet workbook");
        fs::write(&path, workbook).expect("write temp workbook");

        let mut workbook = open_workbook_auto(&path).expect("open workbook");
        let names = workbook.sheet_names().to_vec();
        assert_eq!(names, vec!["Result 1".to_string(), "Result 2".to_string()]);
        let first = workbook.worksheet_range("Result 1").expect("read first worksheet");
        let second = workbook.worksheet_range("Result 2").expect("read second worksheet");
        assert_eq!(first.get_value((1, 0)).expect("first row"), &calamine::Data::Float(1.0));
        assert_eq!(second.get_value((1, 0)).expect("second row"), &calamine::Data::String("Ada".to_string()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn streams_xlsx_rows_to_a_readable_workbook() {
        let path = std::env::temp_dir().join(format!("dbx-stream-test-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let mut writer =
                start_streaming_xlsx_workbook(file, Some("Streamed"), &["id".to_string(), "name".to_string()], &[])
                    .expect("start workbook");
            writer.write_row(&[json!(1), json!("Ada")]).expect("write row");
            writer.write_row(&[json!(2), json!("Bob")]).expect("write row");
            drop(writer.finish().expect("finish workbook"));
        }

        let mut workbook = open_workbook_auto(&path).expect("open workbook");
        let range = workbook.worksheet_range("Streamed").expect("read worksheet");
        assert_eq!(range.get_value((0, 0)).expect("header"), &calamine::Data::String("id".to_string()));
        assert_eq!(range.get_value((1, 0)).expect("row1"), &calamine::Data::Float(1.0));
        assert_eq!(range.get_value((2, 1)).expect("row2"), &calamine::Data::String("Bob".to_string()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn streams_mysql_numeric_strings_as_numeric_cells() {
        let path = std::env::temp_dir().join(format!("dbx-mysql-stream-test-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let columns = ["nullable_int".to_string(), "float_value".to_string(), "decimal_value".to_string()];
            let column_types = ["int(11)".to_string(), "float".to_string(), "decimal(18,6)".to_string()];
            let mut writer = start_streaming_xlsx_workbook(file, Some("MySQL Stream"), &columns, &column_types)
                .expect("start workbook");
            writer.write_row(&[json!("42"), json!("123.5"), json!("2800.000000")]).expect("write row");
            drop(writer.finish().expect("finish workbook"));
        }

        let bytes = fs::read(&path).expect("read workbook");
        let sheet = read_zip_entry(&bytes, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<c r=\"A2\"><v>42</v></c>"));
        assert!(sheet.contains("<c r=\"B2\"><v>123.5</v></c>"));
        assert!(sheet.contains("<c r=\"C2\"><v>2800.000000</v></c>"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn streams_xlsx_rows_with_a_trailing_sql_worksheet() {
        let path = std::env::temp_dir().join(format!("dbx-stream-sql-test-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let sql_sheet = XlsxWorksheetData {
                sheet_name: Some("SQL".to_string()),
                columns: vec!["SQL".to_string()],
                column_types: vec![],
                rows: vec![vec![json!("SELECT id, name FROM users")]],
            };
            let mut writer = start_streaming_xlsx_workbook_with_trailing_sheets(
                file,
                Some("Result"),
                &["id".to_string(), "name".to_string()],
                &[],
                &[sql_sheet],
            )
            .expect("start workbook");
            writer.write_row(&[json!(1), json!("Ada")]).expect("write row");
            drop(writer.finish().expect("finish workbook"));
        }

        let mut workbook = open_workbook_auto(&path).expect("open workbook");
        assert_eq!(workbook.sheet_names(), &["Result".to_string(), "SQL".to_string()]);
        let result = workbook.worksheet_range("Result").expect("read result worksheet");
        let sql = workbook.worksheet_range("SQL").expect("read sql worksheet");
        assert_eq!(result.get_value((1, 0)), Some(&calamine::Data::Float(1.0)));
        assert_eq!(sql.get_value((1, 0)), Some(&calamine::Data::String("SELECT id, name FROM users".to_string())));
        let _ = fs::remove_file(path);
    }
}
