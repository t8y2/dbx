use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Seek, Write};

use crate::temporal_format::{excel_temporal_serial, ExcelTemporalKind};

pub(crate) const XLSX_MAX_DATA_ROWS: usize = 1_048_575;
const XLSX_DATE_STYLE: usize = 2;
const XLSX_DATETIME_STYLE: usize = 3;
const NUMERIC_RIGHT_ALIGN_STYLE: usize = 4;
const NUMERIC_LEFT_ALIGN_STYLE: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorksheetData {
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<String>,
    #[serde(default)]
    pub column_comments: Vec<Option<String>>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub numeric_column_right_align: bool,
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

/// Allocates unique sheet names for data sheets, avoiding conflicts with
/// pre-reserved trailing sheet names. Data sheets are named sequentially:
/// "Result", "Result (2)", "Result (3)", etc.
struct SheetNameAllocator {
    /// The original unsuffixed base name (e.g. "Result"), stored so that
    /// [`allocate_next`] always derives continuation names from the original
    /// name rather than from an already-de-duplicated first name.
    base: String,
    data_names: Vec<String>,
    trailing_names: Vec<String>,
}

impl SheetNameAllocator {
    fn new(data_sheet_name: Option<&str>, trailing_sheets: &[XlsxWorksheetData]) -> Self {
        // Pre-reserve trailing sheet names (normalized, deduplicated) so data
        // sheet names never collide with them, and no two trailing sheets share
        // the same name.
        let mut trailing_names: Vec<String> = Vec::with_capacity(trailing_sheets.len());
        for (index, sheet) in trailing_sheets.iter().enumerate() {
            let base = normalize_sheet_name(sheet.sheet_name.as_deref().or(Some(&format!("Sheet{}", index + 1))));
            trailing_names.push(make_unique_name(&base, &trailing_names));
        }

        let base = normalize_sheet_name(data_sheet_name);
        // Allocate the first data sheet name, avoiding trailing names.
        let reserved: Vec<String> = trailing_names.clone();
        let first = make_unique_name(&base, &reserved);
        let data_names = vec![first];

        Self { base, data_names, trailing_names }
    }

    /// Allocate the next data sheet name, avoiding all previously allocated
    /// names (both data and trailing). Uses the stored original base name so
    /// that continuation names are always "base (2)", "base (3)", ... even
    /// when the first data name was de-duplicated.
    fn allocate_next(&mut self) {
        let mut reserved: Vec<String> = self.trailing_names.clone();
        reserved.extend(self.data_names.iter().cloned());
        let next = make_unique_name(&self.base, &reserved);
        self.data_names.push(next);
    }

    /// Ordered list: data sheet names first, then trailing sheet names.
    fn all_names(&self) -> Vec<String> {
        let mut names = self.data_names.clone();
        names.extend(self.trailing_names.clone());
        names
    }
}

fn make_unique_name(base: &str, reserved: &[String]) -> String {
    let mut candidate = base.to_string();
    let mut suffix = 2;
    while reserved.iter().any(|name| name == &candidate) {
        let suffix_text = format!(" ({suffix})");
        let max_base_len = 31usize.saturating_sub(suffix_text.chars().count());
        if max_base_len > 0 {
            candidate = format!("{}{}", base.chars().take(max_base_len).collect::<String>(), suffix_text);
        } else {
            candidate = suffix_text.clone();
        }
        suffix += 1;
    }
    candidate
}

/// Streaming XLSX writer that incrementally writes rows to a ZIP-backed
/// workbook.  This avoids accumulating all rows in memory before building the
/// final file, drastically reducing peak memory for large exports.
///
/// When the per-sheet data row count reaches [`XLSX_MAX_DATA_ROWS`], the writer
/// automatically closes the current sheet and starts a new one, repeating
/// column headers, frozen panes, and column widths. Trailing sheets (e.g. SQL)
/// are written after all data sheets in [`finish`].
pub struct StreamingXlsxWriter<W: Write + Seek> {
    zip: zip::ZipWriter<W>,
    columns: Vec<String>,
    column_types: Vec<String>,
    next_row_number: usize,
    current_data_rows: usize,
    max_data_rows_per_sheet: usize,
    /// Track the sheet number within the ZIP (1-based). Increments when a new
    /// data sheet or trailing sheet is started.
    current_sheet_number: usize,
    sheet_name_allocator: SheetNameAllocator,
    trailing_sheets: Vec<XlsxWorksheetData>,
    width_cache: Vec<usize>,
    column_comments: Vec<Option<String>>,
    date_time_format: Option<String>,
    numeric_right_align: bool,
}

/// Estimate column widths from header names only (used by the streaming path
/// where full row data is not available up-front).  Each width is clamped to
/// [10, 60] to stay within reasonable bounds.
fn estimate_header_widths(columns: &[String], column_comments: &[Option<String>]) -> Vec<usize> {
    columns
        .iter()
        .enumerate()
        .map(|(index, col)| {
            let header_text = column_comments.get(index).and_then(|c| c.as_deref()).unwrap_or(col.as_str());
            (header_text.chars().count() + 2).clamp(10, 60)
        })
        .collect()
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

/// Resolve the effective header text: prefer a non-empty column comment, fall
/// back to the original column name.
fn effective_header(column: &str, comment: Option<&str>) -> String {
    comment.filter(|c| !c.is_empty()).unwrap_or(column).to_string()
}

/// Build a single `<row>` XML fragment for the header row (row 1).
pub(crate) fn header_row_xml(columns: &[String], column_comments: &[Option<String>]) -> String {
    format!(
        "<row r=\"1\">{}</row>",
        columns
            .iter()
            .enumerate()
            .map(|(index, col)| {
                let header = effective_header(col, column_comments.get(index).and_then(|c| c.as_deref()));
                cell_xml(Some(&Value::String(header)), 0, index, Some(1))
            })
            .collect::<String>()
    )
}

fn data_row_xml_with_date_time_format(
    row_number: usize,
    columns: &[String],
    column_types: &[String],
    row: &[Value],
    date_time_format: Option<&str>,
    numeric_right_align: bool,
) -> String {
    let cells = columns
        .iter()
        .enumerate()
        .map(|(col_index, _)| {
            let col_type = column_types.get(col_index);
            let align_style = numeric_column_style(col_type, numeric_right_align);
            typed_cell_xml(row.get(col_index), col_type, row_number - 1, col_index, align_style, date_time_format)
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
#[cfg(test)]
pub(crate) fn start_streaming_xlsx_workbook<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
) -> Result<StreamingXlsxWriter<W>, String> {
    start_streaming_xlsx_workbook_with_options(writer, sheet_name, columns, column_types, &[], &[], None, false)
}

#[cfg(test)]
pub(crate) fn start_streaming_xlsx_workbook_with_trailing_sheets<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
    trailing_sheets: &[XlsxWorksheetData],
) -> Result<StreamingXlsxWriter<W>, String> {
    start_streaming_xlsx_workbook_with_options(
        writer,
        sheet_name,
        columns,
        column_types,
        &[],
        trailing_sheets,
        None,
        false,
    )
}

/// Start a new streaming XLSX workbook with full options. Metadata files
/// ([Content_Types].xml, workbook.xml, styles.xml, etc.) are deferred to
/// [`StreamingXlsxWriter::finish`] so that the final sheet count is known
/// — this supports automatic multi-sheet splitting.
fn start_xlsx_writer_inner<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
    column_comments: &[Option<String>],
    trailing_sheets: &[XlsxWorksheetData],
    date_time_format: Option<&str>,
    numeric_right_align: bool,
    max_data_rows_per_sheet: usize,
) -> Result<StreamingXlsxWriter<W>, String> {
    let width_cache = estimate_header_widths(columns, column_comments);
    let sheet_name_allocator = SheetNameAllocator::new(sheet_name, trailing_sheets);

    let mut zip = zip::ZipWriter::new(writer);

    // Start sheet1 immediately. Metadata files are written in finish().
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
        cols = cols_xml(&width_cache),
    );
    zip.write_all(sheet_header.as_bytes()).map_err(|err| err.to_string())?;
    zip.write_all(header_row_xml(columns, column_comments).as_bytes()).map_err(|err| err.to_string())?;

    Ok(StreamingXlsxWriter {
        zip,
        columns: columns.to_vec(),
        column_types: column_types.to_vec(),
        next_row_number: 2,
        current_data_rows: 0,
        max_data_rows_per_sheet,
        current_sheet_number: 1,
        sheet_name_allocator,
        trailing_sheets: trailing_sheets.to_vec(),
        width_cache,
        column_comments: column_comments.to_vec(),
        date_time_format: date_time_format.map(str::to_string),
        numeric_right_align,
    })
}

pub(crate) fn start_streaming_xlsx_workbook_with_options<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
    column_comments: &[Option<String>],
    trailing_sheets: &[XlsxWorksheetData],
    date_time_format: Option<&str>,
    numeric_right_align: bool,
) -> Result<StreamingXlsxWriter<W>, String> {
    start_xlsx_writer_inner(
        writer,
        sheet_name,
        columns,
        column_types,
        column_comments,
        trailing_sheets,
        date_time_format,
        numeric_right_align,
        XLSX_MAX_DATA_ROWS,
    )
}

#[cfg(test)]
pub(crate) fn start_streaming_xlsx_workbook_with_max_rows<W: Write + Seek>(
    writer: W,
    sheet_name: Option<&str>,
    columns: &[String],
    column_types: &[String],
    trailing_sheets: &[XlsxWorksheetData],
    max_data_rows_per_sheet: usize,
) -> Result<StreamingXlsxWriter<W>, String> {
    start_xlsx_writer_inner(
        writer,
        sheet_name,
        columns,
        column_types,
        &[],
        trailing_sheets,
        None,
        false,
        max_data_rows_per_sheet,
    )
}

impl<W: Write + Seek> StreamingXlsxWriter<W> {
    /// Append a single data row to the current worksheet. If the current sheet
    /// has reached [`self.max_data_rows_per_sheet`] data rows, this method
    /// automatically closes the sheet and opens a new one before writing the row.
    pub fn write_row(&mut self, row: &[Value]) -> Result<(), String> {
        if self.current_data_rows >= self.max_data_rows_per_sheet {
            self.finish_current_sheet()?;
            self.start_next_data_sheet()?;
        }
        self.zip
            .write_all(
                data_row_xml_with_date_time_format(
                    self.next_row_number,
                    &self.columns,
                    &self.column_types,
                    row,
                    self.date_time_format.as_deref(),
                    self.numeric_right_align,
                )
                .as_bytes(),
            )
            .map_err(|err| err.to_string())?;
        self.next_row_number += 1;
        self.current_data_rows += 1;
        Ok(())
    }

    /// Close the currently open data sheet XML: writes `</sheetData>`,
    /// `<autoFilter>` and `</worksheet>`.
    fn finish_current_sheet(&mut self) -> Result<(), String> {
        let row_count = self.next_row_number.saturating_sub(1);
        let range = sheet_range(self.columns.len(), row_count);
        self.zip
            .write_all(format!("</sheetData><autoFilter ref=\"{range}\"/></worksheet>").as_bytes())
            .map_err(|err| err.to_string())
    }

    /// Start a new data sheet, reusing the same header row, column widths and
    /// frozen pane from the first sheet.
    fn start_next_data_sheet(&mut self) -> Result<(), String> {
        self.sheet_name_allocator.allocate_next();
        self.current_sheet_number += 1;

        let options = xlsx_zip_options();
        self.zip
            .start_file(format!("xl/worksheets/sheet{}.xml", self.current_sheet_number), options)
            .map_err(|err| err.to_string())?;

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
            cols = cols_xml(&self.width_cache),
        );
        self.zip.write_all(sheet_header.as_bytes()).map_err(|err| err.to_string())?;
        self.zip
            .write_all(header_row_xml(&self.columns, &self.column_comments).as_bytes())
            .map_err(|err| err.to_string())?;

        // Reset row counters for the new sheet.
        self.next_row_number = 2;
        self.current_data_rows = 0;
        Ok(())
    }

    /// Finalize the workbook: close the current data sheet, write trailing
    /// sheets, write metadata files, and close the ZIP archive. Returns the
    /// underlying writer so callers can flush / close it as needed.
    pub fn finish(mut self) -> Result<W, String> {
        // 1. Close the current data sheet.
        self.finish_current_sheet()?;

        // 2. Write trailing sheets (e.g. SQL) after all data sheets.
        for sheet in &self.trailing_sheets {
            self.current_sheet_number += 1;
            self.zip
                .start_file(format!("xl/worksheets/sheet{}.xml", self.current_sheet_number), xlsx_zip_options())
                .map_err(|err| err.to_string())?;
            let segment = WorksheetSegment {
                name: sheet.sheet_name.clone(),
                columns: &sheet.columns,
                column_types: &sheet.column_types,
                column_comments: &sheet.column_comments,
                rows: &sheet.rows,
                numeric_column_right_align: sheet.numeric_column_right_align,
            };
            write_worksheet_xml(&mut self.zip, &segment)?;
        }

        // 3. Write metadata files. These appear AFTER sheet data in the ZIP
        //    stream, but ZIP readers use the central directory to locate entries
        //    by name, so the physical ordering is irrelevant.
        let sheet_names = self.sheet_name_allocator.all_names();
        let total_sheet_count = sheet_names.len();
        write_zip_entry(&mut self.zip, "[Content_Types].xml", &content_types_xml_for_sheet_count(total_sheet_count))?;
        write_zip_entry(&mut self.zip, "_rels/.rels", root_rels_xml())?;
        write_zip_entry(&mut self.zip, "xl/workbook.xml", &workbook_xml_for_sheets(&sheet_names))?;
        write_zip_entry(
            &mut self.zip,
            "xl/_rels/workbook.xml.rels",
            &workbook_rels_xml_for_sheet_count(total_sheet_count),
        )?;
        write_zip_entry(&mut self.zip, "xl/styles.xml", &styles_xml(self.date_time_format.as_deref()))?;

        // 4. Finalize the ZIP.
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

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn estimate_column_widths(columns: &[String], column_comments: &[Option<String>], rows: &[Vec<Value>]) -> Vec<usize> {
    columns
        .iter()
        .enumerate()
        .map(|(col_index, col)| {
            let header_text = effective_header(col, column_comments.get(col_index).and_then(|c| c.as_deref()));
            let max_len = std::iter::once(header_text.chars().count().min(60))
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
    let mut normalized = column_type.map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default();
    while normalized.ends_with(')') {
        let Some(open_index) = normalized.find('(') else {
            break;
        };
        if !matches!(normalized[..open_index].trim(), "nullable" | "lowcardinality") {
            break;
        }
        normalized = normalized[open_index + 1..normalized.len() - 1].trim().to_string();
    }
    let base = normalized.split(['(', ' ', '[']).next().unwrap_or_default();
    matches!(
        base,
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "serial"
            | "smallserial"
            | "bigserial"
            | "int2"
            | "int4"
            | "int8"
            | "int1"
            | "int16"
            | "int32"
            | "int64"
            | "int128"
            | "int256"
            | "intn"
            | "uint"
            | "uint8"
            | "uint16"
            | "uint32"
            | "uint64"
            | "uint128"
            | "uint256"
            | "float"
            | "float4"
            | "float8"
            | "float16"
            | "float32"
            | "float64"
            | "floatn"
            | "real"
            | "double"
            | "decimal"
            | "decimal32"
            | "decimal64"
            | "decimal128"
            | "decimal256"
            | "decimaln"
            | "numeric"
            | "numericn"
            | "number"
            | "dec"
            | "fixed"
            | "money"
            | "money4"
            | "moneyn"
            | "smallmoney"
            | "smallmoneyn"
            | "binary_float"
            | "binary_double"
    )
}

fn numeric_column_style(column_type: Option<&String>, enabled: bool) -> Option<usize> {
    if !is_numeric_column_type(column_type) {
        return None;
    }
    if enabled {
        Some(NUMERIC_RIGHT_ALIGN_STYLE)
    } else {
        Some(NUMERIC_LEFT_ALIGN_STYLE)
    }
}

fn safe_excel_number(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.parse::<f64>().ok().is_none_or(|number| !number.is_finite()) {
        return None;
    }
    // Fractional trailing zeros preserve database scale but add no numeric
    // precision. Keep values with more than 15 actual digits as text.
    let significand = trimmed.split(['e', 'E']).next().unwrap_or(trimmed);
    let (integer, fraction) = significand.split_once('.').unwrap_or((significand, ""));
    let significant_digits = integer
        .chars()
        .chain(fraction.trim_end_matches('0').chars())
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
    date_time_format: Option<&str>,
) -> String {
    if let Some(Value::String(value)) = value {
        if let Some((serial, temporal_kind)) =
            excel_temporal_serial(value, column_type.map(String::as_str), date_time_format)
        {
            let reference = cell_ref(row_index, col_index);
            let style = match temporal_kind {
                ExcelTemporalKind::Date => XLSX_DATE_STYLE,
                ExcelTemporalKind::DateTime => XLSX_DATETIME_STYLE,
            };
            return format!("<c r=\"{reference}\" s=\"{style}\"><v>{serial}</v></c>");
        }
    }
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

fn write_worksheet_xml<W: Write>(writer: &mut W, segment: &WorksheetSegment) -> Result<(), String> {
    let total_rows = segment.rows.len() + 1;
    let range = sheet_range(segment.columns.len(), total_rows);
    let widths = estimate_column_widths(segment.columns, segment.column_comments, segment.rows);

    writer
        .write_all(
            format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
            "<dimension ref=\"{range}\"/>",
            "<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>",
            "<sheetFormatPr defaultRowHeight=\"15\"/>",
            "<cols>{cols}</cols>",
            "<sheetData>"
        ),
        range = range,
        cols = cols_xml(&widths),
    )
            .as_bytes(),
        )
        .map_err(|err| err.to_string())?;
    writer
        .write_all(header_row_xml(segment.columns, segment.column_comments).as_bytes())
        .map_err(|err| err.to_string())?;

    for (row_index, row) in segment.rows.iter().enumerate() {
        let excel_row = row_index + 2;
        writer
            .write_all(
                data_row_xml_with_date_time_format(
                    excel_row,
                    segment.columns,
                    segment.column_types,
                    row,
                    None,
                    segment.numeric_column_right_align,
                )
                .as_bytes(),
            )
            .map_err(|err| err.to_string())?;
    }

    writer
        .write_all(format!("</sheetData><autoFilter ref=\"{range}\"/></worksheet>").as_bytes())
        .map_err(|err| err.to_string())
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

fn dayjs_to_excel_number_format(pattern: &str) -> Option<(String, bool, bool)> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.len() > 100 || pattern.contains('%') {
        return None;
    }
    let tokens = [
        ("YYYY", "yyyy", true, false),
        ("SSS", "000", false, true),
        ("ZZ", "", false, true),
        ("MM", "mm", true, false),
        ("DD", "dd", true, false),
        ("HH", "hh", false, true),
        ("mm", "mm", false, true),
        ("ss", "ss", false, true),
        ("M", "m", true, false),
        ("D", "d", true, false),
        ("H", "h", false, true),
        ("m", "m", false, true),
        ("s", "s", false, true),
        ("Z", "", false, true),
    ];
    let mut output = String::with_capacity(pattern.len());
    let mut has_date = false;
    let mut has_time = false;
    let mut index = 0;
    while index < pattern.len() {
        let remaining = &pattern[index..];
        if remaining.starts_with('[') {
            let close = remaining.find(']')?;
            let literal = &remaining[1..close];
            output.push('"');
            output.push_str(&literal.replace('"', "\"\""));
            output.push('"');
            index += close + 1;
            continue;
        }
        if let Some((token, replacement, is_date, is_time)) =
            tokens.iter().find(|(token, ..)| remaining.starts_with(token))
        {
            if replacement.is_empty() {
                return None;
            }
            output.push_str(replacement);
            has_date |= *is_date;
            has_time |= *is_time;
            index += token.len();
            continue;
        }
        let character = remaining.chars().next()?;
        if character.is_ascii_alphabetic() {
            // Keep the accepted Day.js token set aligned with temporal_format.rs;
            // unsupported tokens must not silently alter the exported display.
            return None;
        }
        output.push(character);
        index += character.len_utf8();
    }
    (has_date && !output.is_empty()).then_some((output, has_date, has_time))
}

fn styles_xml(date_time_format: Option<&str>) -> String {
    let default_date = "yyyy-mm-dd".to_string();
    let default_datetime = "yyyy-mm-dd hh:mm:ss".to_string();
    let (date_format, datetime_format) = date_time_format
        .and_then(dayjs_to_excel_number_format)
        .map(|(format, has_date, has_time)| {
            if has_time {
                (default_date.clone(), format)
            } else if has_date {
                (format.clone(), format)
            } else {
                (default_date.clone(), default_datetime.clone())
            }
        })
        .unwrap_or((default_date, default_datetime));
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
            "<numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"{}\"/><numFmt numFmtId=\"165\" formatCode=\"{}\"/></numFmts>",
            "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>",
            "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>",
            "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>",
            "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>",
            "<cellXfs count=\"6\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/><xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/><xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment horizontal=\"right\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment horizontal=\"left\"/></xf></cellXfs>",
            "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>",
            "</styleSheet>"
        ),
        escape_xml(&date_format),
        escape_xml(&datetime_format)
    )
}

/// A borrow-only view of a worksheet's schema plus a row range, produced by
/// [`split_sheets_for_max_rows`] and consumed by [`write_worksheet_xml`]. Rows are
/// referenced as slices of the original [`XlsxWorksheetData`] rather than
/// deep-copied, so splitting an oversized worksheet into multiple sheets does
/// not duplicate cell data in memory.
struct WorksheetSegment<'a> {
    /// Sheet name before cross-sheet deduplication. `None` signals a missing
    /// name, which [`normalize_unique_sheet_names`] falls back on with
    /// "Sheet{index}" like the original data.
    name: Option<String>,
    columns: &'a [String],
    column_types: &'a [String],
    column_comments: &'a [Option<String>],
    rows: &'a [Vec<Value>],
    numeric_column_right_align: bool,
}

fn normalize_unique_sheet_names(segments: &[WorksheetSegment]) -> Vec<String> {
    let mut names = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        let base = normalize_sheet_name(segment.name.as_deref().or(Some(&format!("Sheet{}", index + 1))));
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

/// Split any worksheet whose `rows.len() > max_data_rows_per_sheet` into
/// multiple segments, each borrowing the columns / column_types /
/// column_comments / numeric_column_right_align of the original sheet. The
/// first chunk keeps the original sheet name; subsequent chunks get
/// "name (2)", "name (3)", etc. Sheets that do not overflow are passed through
/// as a single segment. No row data is copied.
fn split_sheets_for_max_rows<'a>(
    sheets: &'a [XlsxWorksheetData],
    max_data_rows_per_sheet: usize,
) -> Vec<WorksheetSegment<'a>> {
    // `slice::chunks` panics on a zero chunk size. No caller passes 0 today
    // (production uses XLSX_MAX_DATA_ROWS), but this is pub(crate)-reachable
    // through build_xlsx_workbook_multi_with_max_rows, so guard defensively.
    let max_data_rows_per_sheet = max_data_rows_per_sheet.max(1);
    let mut expanded = Vec::with_capacity(sheets.len());
    for sheet in sheets {
        if sheet.rows.len() <= max_data_rows_per_sheet {
            expanded.push(WorksheetSegment {
                name: sheet.sheet_name.clone(),
                columns: &sheet.columns,
                column_types: &sheet.column_types,
                column_comments: &sheet.column_comments,
                rows: &sheet.rows,
                numeric_column_right_align: sheet.numeric_column_right_align,
            });
            continue;
        }
        let base_name = normalize_sheet_name(sheet.sheet_name.as_deref());
        for (chunk_index, chunk) in sheet.rows.chunks(max_data_rows_per_sheet).enumerate() {
            let chunk_name = if chunk_index == 0 {
                base_name.clone()
            } else {
                let suffix = chunk_index + 1;
                let suffix_text = format!(" ({suffix})");
                let max_base_len = 31usize.saturating_sub(suffix_text.chars().count());
                if max_base_len > 0 {
                    format!("{}{}", base_name.chars().take(max_base_len).collect::<String>(), suffix_text)
                } else {
                    suffix_text.clone()
                }
            };
            expanded.push(WorksheetSegment {
                name: Some(chunk_name),
                columns: &sheet.columns,
                column_types: &sheet.column_types,
                column_comments: &sheet.column_comments,
                rows: chunk,
                numeric_column_right_align: sheet.numeric_column_right_align,
            });
        }
    }
    expanded
}

pub fn build_xlsx_workbook(data: &XlsxWorksheetData) -> Result<Vec<u8>, String> {
    build_xlsx_workbook_multi(std::slice::from_ref(data))
}

pub fn build_xlsx_workbook_multi(sheets: &[XlsxWorksheetData]) -> Result<Vec<u8>, String> {
    build_xlsx_workbook_multi_with_max_rows(sheets, XLSX_MAX_DATA_ROWS)
}

/// Build an in-memory XLSX workbook with an explicit per-sheet data-row limit.
/// Any worksheet whose data rows exceed `max_data_rows_per_sheet` is split into
/// multiple worksheets (each with a header row, column widths, frozen pane,
/// and autoFilter).
pub(crate) fn build_xlsx_workbook_multi_with_max_rows(
    sheets: &[XlsxWorksheetData],
    max_data_rows_per_sheet: usize,
) -> Result<Vec<u8>, String> {
    if sheets.is_empty() {
        return Err("At least one worksheet is required".to_string());
    }
    let segments = split_sheets_for_max_rows(sheets, max_data_rows_per_sheet);
    let sheet_names = normalize_unique_sheet_names(&segments);
    let files = vec![
        ("[Content_Types].xml", content_types_xml_for_sheet_count(segments.len())),
        ("_rels/.rels", root_rels_xml().to_string()),
        ("xl/workbook.xml", workbook_xml_for_sheets(&sheet_names)),
        ("xl/_rels/workbook.xml.rels", workbook_rels_xml_for_sheet_count(segments.len())),
        ("xl/styles.xml", styles_xml(None)),
    ];

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = xlsx_zip_options();

    for (path, content) in files {
        zip.start_file(path, options).map_err(|err| err.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|err| err.to_string())?;
    }
    for (index, segment) in segments.iter().enumerate() {
        zip.start_file(format!("xl/worksheets/sheet{}.xml", index + 1), options).map_err(|err| err.to_string())?;
        write_worksheet_xml(&mut zip, segment)?;
    }

    let output = zip.finish().map_err(|err| err.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{
        build_xlsx_workbook, build_xlsx_workbook_multi, build_xlsx_workbook_multi_with_max_rows,
        is_numeric_column_type, start_streaming_xlsx_workbook, start_streaming_xlsx_workbook_with_max_rows,
        start_streaming_xlsx_workbook_with_options, start_streaming_xlsx_workbook_with_trailing_sheets,
        write_worksheet_xml, WorksheetSegment, XlsxWorksheetData,
    };
    use calamine::{open_workbook_auto, Reader};
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};

    #[derive(Default)]
    struct WriteStats {
        bytes_written: usize,
        largest_write: usize,
        write_calls: usize,
    }

    impl Write for WriteStats {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.bytes_written += buffer.len();
            self.largest_write = self.largest_write.max(buffer.len());
            self.write_calls += 1;
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

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
            column_comments: vec![],
            rows: vec![vec![json!(1), json!("Ada & Bob"), json!(true)], vec![json!(2), json!(null), json!(false)]],
            numeric_column_right_align: false,
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
            column_comments: vec![],
            rows: vec![vec![json!("1.00000"), json!("2800.000000"), json!("00123")]],
            numeric_column_right_align: false,
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<c r=\"A2\" s=\"5\"><v>1.00000</v></c>"));
        assert!(sheet.contains("<c r=\"B2\" s=\"5\"><v>2800.000000</v></c>"));
        assert!(sheet.contains("<c r=\"C2\" t=\"inlineStr\"><is><t>00123</t></is></c>"));
    }

    #[test]
    fn ignores_fractional_trailing_zeros_when_checking_excel_numeric_precision() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Numeric precision".to_string()),
            columns: vec![
                "reported".to_string(),
                "negative_boundary".to_string(),
                "safe_boundary".to_string(),
                "unsafe_integer".to_string(),
                "precise_fraction".to_string(),
                "fallback".to_string(),
            ],
            column_types: vec!["numeric".to_string(); 6],
            column_comments: vec![],
            rows: vec![vec![
                json!("-100000.0000000000"),
                json!("-999999999999999.0000"),
                json!("123456789012345.0000000000"),
                json!("1234567890123456.0000"),
                json!("100000.0000000001"),
                json!("not-a-number"),
            ]],
            numeric_column_right_align: true,
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<c r=\"A2\" s=\"4\"><v>-100000.0000000000</v></c>"));
        assert!(sheet.contains("<c r=\"B2\" s=\"4\"><v>-999999999999999.0000</v></c>"));
        assert!(sheet.contains("<c r=\"C2\" s=\"4\"><v>123456789012345.0000000000</v></c>"));
        assert!(sheet.contains("<c r=\"D2\" t=\"inlineStr\" s=\"4\"><is><t>1234567890123456.0000</t></is></c>"));
        assert!(sheet.contains("<c r=\"E2\" t=\"inlineStr\" s=\"4\"><is><t>100000.0000000001</t></is></c>"));
        assert!(sheet.contains("<c r=\"F2\" t=\"inlineStr\" s=\"4\"><is><t>not-a-number</t></is></c>"));
    }

    #[test]
    fn writes_temporal_columns_as_excel_dates_without_retyping_other_values() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Typed values".to_string()),
            columns: vec![
                "day".to_string(),
                "created_at".to_string(),
                "label".to_string(),
                "invalid_day".to_string(),
                "amount".to_string(),
                "zoned_at".to_string(),
            ],
            column_types: vec![
                "date".to_string(),
                "timestamp without time zone".to_string(),
                "text".to_string(),
                "date".to_string(),
                "numeric".to_string(),
                "timestamp with time zone".to_string(),
            ],
            column_comments: vec![],
            rows: vec![vec![
                json!("2024-02-25"),
                json!("2024-02-25 13:02:15"),
                json!("2024-02-25"),
                json!("not-a-date"),
                json!("2800.000000"),
                json!("2024-02-25T13:02:15+08:00"),
            ]],
            numeric_column_right_align: false,
        })
        .expect("build workbook");

        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        let styles = read_zip_entry(&workbook, "xl/styles.xml");
        assert!(sheet.contains("<c r=\"A2\" s=\"2\"><v>45347</v></c>"));
        assert!(sheet.contains("<c r=\"B2\" s=\"3\"><v>45347.543229166666</v></c>"));
        assert!(sheet.contains("<c r=\"C2\" t=\"inlineStr\"><is><t>2024-02-25</t></is></c>"));
        assert!(sheet.contains("<c r=\"D2\" t=\"inlineStr\"><is><t>not-a-date</t></is></c>"));
        assert!(sheet.contains("<c r=\"E2\" s=\"5\"><v>2800.000000</v></c>"));
        assert!(sheet.contains("<c r=\"F2\" t=\"inlineStr\"><is><t>2024-02-25T13:02:15+08:00</t></is></c>"));
        assert!(styles.contains("numFmtId=\"164\" formatCode=\"yyyy-mm-dd\""));
        assert!(styles.contains("numFmtId=\"165\" formatCode=\"yyyy-mm-dd hh:mm:ss\""));
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
            column_comments: vec![],
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
            numeric_column_right_align: false,
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
            assert!(sheet.contains(&format!("<c r=\"{reference}\" s=\"5\"><v>{value}</v></c>")), "sheet={sheet}");
        }
    }

    #[test]
    fn preserves_high_precision_numeric_strings_as_text() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Precision".to_string()),
            columns: vec!["large_id".to_string(), "precise_amount".to_string()],
            column_types: vec!["bigint".to_string(), "decimal(30,10)".to_string()],
            column_comments: vec![],
            rows: vec![vec![json!("9223372036854775807"), json!("123456789012345.6789000000")]],
            numeric_column_right_align: false,
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
            column_comments: vec![],
            rows: vec![vec![json!("ok")]],
            numeric_column_right_align: false,
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
                column_comments: vec![],
                rows: vec![vec![json!(1)]],
                numeric_column_right_align: false,
            },
            XlsxWorksheetData {
                sheet_name: Some("Result 2".to_string()),
                columns: vec!["name".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows: vec![vec![json!("Ada")]],
                numeric_column_right_align: false,
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
        assert!(sheet.contains("<c r=\"A2\" s=\"5\"><v>42</v></c>"));
        assert!(sheet.contains("<c r=\"B2\" s=\"5\"><v>123.5</v></c>"));
        assert!(sheet.contains("<c r=\"C2\" s=\"5\"><v>2800.000000</v></c>"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn streaming_temporal_cells_keep_the_configured_excel_display_format() {
        let path = std::env::temp_dir().join(format!("dbx-temporal-stream-test-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let columns = ["created_at".to_string()];
            let column_types = ["timestamp without time zone".to_string()];
            let mut writer = start_streaming_xlsx_workbook_with_options(
                file,
                Some("Temporal"),
                &columns,
                &column_types,
                &[],
                &[],
                Some("YYYY/MM/DD HH:mm:ss.SSS"),
                false,
            )
            .expect("start workbook");
            writer.write_row(&[json!("2024/02/25 13:02:15.125")]).expect("write temporal row");
            drop(writer.finish().expect("finish workbook"));
        }

        let bytes = fs::read(&path).expect("read workbook");
        let sheet = read_zip_entry(&bytes, "xl/worksheets/sheet1.xml");
        let styles = read_zip_entry(&bytes, "xl/styles.xml");
        assert!(sheet.contains("<c r=\"A2\" s=\"3\"><v>"), "sheet={sheet}");
        assert!(styles.contains("numFmtId=\"165\" formatCode=\"yyyy/mm/dd hh:mm:ss.000\""));
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
                column_comments: vec![],
                rows: vec![vec![json!("SELECT id, name FROM users")]],
                numeric_column_right_align: false,
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

    #[test]
    fn numeric_right_align_enabled_applies_style_4() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Aligned".to_string()),
            columns: vec!["amount".to_string(), "label".to_string()],
            column_types: vec!["decimal(10,2)".to_string(), "varchar(50)".to_string()],
            column_comments: vec![],
            rows: vec![vec![json!(1.5), json!("row")]],
            numeric_column_right_align: true,
        })
        .expect("build workbook");
        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains(r#"<c r="A2" s="4"><v>1.5</v></c>"#), "sheet={sheet}");
        // Text column B should NOT have right-align style s="4"
        assert!(!sheet.contains(r#"<c r="B2" s="4""#));
    }

    #[test]
    fn numeric_right_align_disabled_applies_left_align_style_5() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Disabled".to_string()),
            columns: vec!["amount".to_string(), "label".to_string()],
            column_types: vec!["decimal(10,2)".to_string(), "varchar(50)".to_string()],
            column_comments: vec![],
            rows: vec![vec![json!(1.5), json!("row")]],
            numeric_column_right_align: false,
        })
        .expect("build workbook");
        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        // Numeric column A should have left-align style (s="5"), not right-align (s="4"),
        // to override Excel's default right alignment for number cells.
        assert!(sheet.contains(r#"<c r="A2" s="5"><v>1.5</v></c>"#), "sheet={sheet}");
        assert!(!sheet.contains(r#"s="4""#));
    }

    #[test]
    fn numeric_right_align_applies_across_database_numeric_types() {
        // Ensures the Rust classifier covers the same cross-database numeric
        // types as the frontend isNumericColumnType (ClickHouse wide integers,
        // Oracle/Dameng binary floats, SQL Server internal type names, etc.).
        let column_types = vec![
            "Int16".to_string(),
            "Int32".to_string(),
            "Int64".to_string(),
            "Int128".to_string(),
            "UInt256".to_string(),
            "Decimal128(18, 2)".to_string(),
            "Float16".to_string(),
            "BINARY_FLOAT".to_string(),
            "BINARY_DOUBLE".to_string(),
            "decimaln".to_string(),
            "numericn".to_string(),
            "intn".to_string(),
            "floatn".to_string(),
            "moneyn".to_string(),
            "smallmoneyn".to_string(),
            "varchar(50)".to_string(),
        ];
        let row: Vec<Value> = column_types.iter().map(|_| json!(1)).collect::<Vec<_>>();
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("CrossDb".to_string()),
            columns: column_types.iter().map(|t| t.to_lowercase()).collect(),
            column_types: column_types.clone(),
            column_comments: vec![],
            rows: vec![row],
            numeric_column_right_align: true,
        })
        .expect("build workbook");
        let sheet = read_zip_entry(&workbook, "xl/worksheets/sheet1.xml");
        for (index, column_type) in column_types.iter().take(column_types.len() - 1).enumerate() {
            let col_letter = (b'A' + index as u8) as char;
            let cell = format!(r#"<c r="{col_letter}2" s="4"><v>1</v></c>"#);
            assert!(sheet.contains(&cell), "missing right-align style for {column_type} (cell={cell})");
        }
        // Text column (last) must not receive the numeric right-align style.
        let last_letter = (b'A' + column_types.len() as u8 - 1) as char;
        assert!(!sheet.contains(&format!(r#"<c r="{last_letter}2" s="4""#)));
    }

    #[test]
    fn numeric_type_classifier_matches_shared_backend_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/data-grid-numeric-column-types.json"))
                .expect("parse numeric column type fixtures");
        for fixture in fixtures["numeric"].as_array().expect("numeric fixtures") {
            let column_type = fixture["type"].as_str().expect("numeric fixture type").to_string();
            assert!(is_numeric_column_type(Some(&column_type)), "expected numeric backend type: {column_type}");
        }
        for fixture in fixtures["nonNumeric"].as_array().expect("non-numeric fixtures") {
            let column_type = fixture["type"].as_str().expect("non-numeric fixture type").to_string();
            assert!(!is_numeric_column_type(Some(&column_type)), "expected non-numeric backend type: {column_type}");
        }
    }

    // -----------------------------------------------------------------------
    // Multi-sheet splitting tests
    // -----------------------------------------------------------------------

    fn build_multi_sheet_xlsx(rows: &[Vec<Value>], max_rows: usize) -> Vec<u8> {
        let path = std::env::temp_dir().join(format!("dbx-multi-split-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let mut writer = start_streaming_xlsx_workbook_with_max_rows(
                file,
                Some("Result"),
                &["id".to_string(), "name".to_string()],
                &[],
                &[],
                max_rows,
            )
            .expect("start workbook");
            for row in rows {
                writer.write_row(row).expect("write row");
            }
            drop(writer.finish().expect("finish workbook"));
        }
        let data = fs::read(&path).expect("read workbook");
        let _ = fs::remove_file(&path);
        data
    }

    #[test]
    fn splits_rows_across_multiple_sheets() {
        // 5 rows, max 2 per sheet -> 3 data sheets
        let rows: Vec<Vec<Value>> = (1..=5).map(|i| vec![json!(i), json!(format!("row_{i}"))]).collect();
        let data = build_multi_sheet_xlsx(&rows, 2);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Result\""));
        assert!(workbook_xml.contains("name=\"Result (2)\""));
        assert!(workbook_xml.contains("name=\"Result (3)\""));

        // Verify three data sheets exist
        let sheet1 = read_zip_entry(&data, "xl/worksheets/sheet1.xml");
        let sheet2 = read_zip_entry(&data, "xl/worksheets/sheet2.xml");
        let sheet3 = read_zip_entry(&data, "xl/worksheets/sheet3.xml");

        // Each sheet has header row; rows are numbered starting at 1
        assert!(sheet1.contains("row_1") && sheet1.contains("row_2"));
        assert!(sheet2.contains("row_3") && sheet2.contains("row_4"));
        assert!(sheet3.contains("row_5"));

        // Each sheet has exactly the header + up to 2 data rows
        assert_eq!(sheet1.matches("<row r=\"").count(), 3); // header + 2 rows
        assert_eq!(sheet2.matches("<row r=\"").count(), 3); // header + 2 rows
        assert_eq!(sheet3.matches("<row r=\"").count(), 2); // header + 1 row
    }

    #[test]
    fn single_sheet_when_under_limit() {
        let rows: Vec<Vec<Value>> = vec![vec![json!(1), json!("Ada")]];
        let data = build_multi_sheet_xlsx(&rows, 2);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Result\""));
        assert!(!workbook_xml.contains("Result (2)"));

        // Only one sheet exists.
        assert!(read_zip_entry(&data, "xl/worksheets/sheet1.xml").contains("Ada"));
        // sheet2 should not exist.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).expect("open xlsx");
        assert!(archive.by_name("xl/worksheets/sheet2.xml").is_err());
    }

    #[test]
    fn trailing_sheet_placed_after_data_sheets() {
        let path = std::env::temp_dir().join(format!("dbx-trailing-split-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let sql_sheet = XlsxWorksheetData {
                sheet_name: Some("SQL".to_string()),
                columns: vec!["SQL".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows: vec![vec![json!("SELECT 1")]],
                numeric_column_right_align: false,
            };
            let mut writer = start_streaming_xlsx_workbook_with_max_rows(
                file,
                Some("Result"),
                &["id".to_string(), "name".to_string()],
                &[],
                &[sql_sheet],
                2,
            )
            .expect("start workbook");
            // Write 5 rows -> 3 data sheets + 1 trailing = 4 total sheets
            for i in 1..=5 {
                writer.write_row(&[json!(i), json!(format!("row_{i}"))]).expect("write row");
            }
            drop(writer.finish().expect("finish workbook"));
        }
        let data = fs::read(&path).expect("read workbook");
        let _ = fs::remove_file(&path);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        // SQL sheet should appear last
        assert!(workbook_xml.contains("name=\"Result\""));
        assert!(workbook_xml.contains("name=\"Result (2)\""));
        assert!(workbook_xml.contains("name=\"Result (3)\""));
        assert!(workbook_xml.contains("name=\"SQL\""));

        // SQL is the 4th sheet (sheet4.xml)
        let sql_sheet = read_zip_entry(&data, "xl/worksheets/sheet4.xml");
        assert!(sql_sheet.contains("SELECT 1"));

        // All ZIP entries should be Deflate-compressed.
        assert_all_entries_deflated(&data);
    }

    #[test]
    fn varchar_leading_zeros_preserved_across_sheets() {
        let path = std::env::temp_dir().join(format!("dbx-leading-zeros-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let mut writer = start_streaming_xlsx_workbook_with_max_rows(
                file,
                Some("Codes"),
                &["code".to_string()],
                &["varchar".to_string()],
                &[],
                1,
            )
            .expect("start workbook");
            writer.write_row(&[json!("00123")]).expect("write row on sheet 1");
            writer.write_row(&[json!("04567")]).expect("write row on sheet 2");
            drop(writer.finish().expect("finish workbook"));
        }
        let data = fs::read(&path).expect("read workbook");
        let _ = fs::remove_file(&path);

        // Both values must use inlineStr (not numeric `<v>`) to preserve leading zeros.
        let sheet2 = read_zip_entry(&data, "xl/worksheets/sheet2.xml");
        assert!(sheet2.contains("t=\"inlineStr\""), "sheet2 should use inlineStr for varchar: {sheet2}");
        assert!(sheet2.contains("04567"), "sheet2 should contain 04567: {sheet2}");
    }

    #[test]
    fn exactly_at_limit_does_not_create_extra_sheet() {
        // max 2 rows, write exactly 2 rows -> 1 data sheet
        let rows: Vec<Vec<Value>> = vec![vec![json!(1), json!("A")], vec![json!(2), json!("B")]];
        let data = build_multi_sheet_xlsx(&rows, 2);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(!workbook_xml.contains("Result (2)"));
        assert!(read_zip_entry(&data, "xl/worksheets/sheet1.xml").contains("A"));
    }

    #[test]
    fn deduplicates_identically_named_trailing_sheets() {
        let path = std::env::temp_dir().join(format!("dbx-trailing-dedup-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let sql_sheet_a = XlsxWorksheetData {
                sheet_name: Some("SQL".to_string()),
                columns: vec!["SQL".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows: vec![vec![json!("SELECT 1")]],
                numeric_column_right_align: false,
            };
            let sql_sheet_b = XlsxWorksheetData {
                sheet_name: Some("SQL".to_string()),
                columns: vec!["SQL".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows: vec![vec![json!("SELECT 2")]],
                numeric_column_right_align: false,
            };
            let mut writer = start_streaming_xlsx_workbook_with_max_rows(
                file,
                Some("Result"),
                &["id".to_string()],
                &[],
                &[sql_sheet_a, sql_sheet_b],
                100,
            )
            .expect("start workbook");
            writer.write_row(&[json!(42)]).expect("write row");
            drop(writer.finish().expect("finish workbook"));
        }
        let data = fs::read(&path).expect("read workbook");
        let _ = fs::remove_file(&path);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"SQL\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"SQL (2)\""), "workbook: {workbook_xml}");
        // No duplicate names — each appears exactly once.
        assert_eq!(workbook_xml.matches("name=\"SQL\"").count(), 1, "only one sheet named \"SQL\": {workbook_xml}");
    }

    #[test]
    fn streaming_continuation_names_use_original_base_when_first_data_name_collides_with_trailing() {
        // Regression: allocate_next used to derive the base from the first
        // *allocated* data name, which could already carry a de-dup suffix.
        // When the data sheet name ("SQL") collides with a trailing sheet
        // named "SQL", the first data name becomes "SQL (2)".  The second
        // data name should be "SQL (3)" — NOT "SQL (2) (2)".
        let path = std::env::temp_dir().join(format!("dbx-collision-base-{}.xlsx", uuid::Uuid::new_v4()));
        {
            let file = fs::File::create(&path).expect("create temp xlsx");
            let sql_sheet = XlsxWorksheetData {
                sheet_name: Some("SQL".to_string()),
                columns: vec!["SQL".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows: vec![vec![json!("SELECT 1")]],
                numeric_column_right_align: false,
            };
            let mut writer = start_streaming_xlsx_workbook_with_max_rows(
                file,
                Some("SQL"),
                &["id".to_string()],
                &[],
                &[sql_sheet],
                1, // force split: 2 data rows → 2 data sheets
            )
            .expect("start workbook");
            writer.write_row(&[json!(1)]).expect("write row 1");
            writer.write_row(&[json!(2)]).expect("write row 2");
            drop(writer.finish().expect("finish workbook"));
        }
        let data = fs::read(&path).expect("read workbook");
        let _ = fs::remove_file(&path);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        // Trailing "SQL" stays; data sheets: "SQL (2)", "SQL (3)" (NOT "SQL (2) (2)").
        assert!(workbook_xml.contains("name=\"SQL\""), "trailing SQL sheet must exist: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"SQL (2)\""), "first data sheet must be SQL (2): {workbook_xml}");
        assert!(workbook_xml.contains("name=\"SQL (3)\""), "second data sheet must be SQL (3): {workbook_xml}");
        assert!(!workbook_xml.contains("SQL (2) (2)"), "must not have nested de-dup suffix: {workbook_xml}");
        // Exactly 3 sheets total: tail, data1, data2.
        assert_eq!(workbook_xml.matches("name=\"").count(), 3, "expected exactly 3 sheets: {workbook_xml}");
    }

    #[test]
    fn build_xlsx_workbook_splits_rows_over_limit() {
        // 5 data rows, max 2 per sheet → 3 sheets: "Result", "Result (2)", "Result (3)".
        let rows: Vec<Vec<Value>> = (1..=5).map(|i| vec![json!(i), json!(format!("row_{i}"))]).collect();
        let data = build_xlsx_workbook_multi_with_max_rows(
            &[XlsxWorksheetData {
                sheet_name: Some("Result".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows,
                numeric_column_right_align: false,
            }],
            2,
        )
        .expect("build workbook");

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Result\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"Result (2)\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"Result (3)\""), "workbook: {workbook_xml}");
        // Exactly 3 sheet entries.
        assert_eq!(workbook_xml.matches("name=\"").count(), 3, "expected 3 sheets: {workbook_xml}");

        let sheet1 = read_zip_entry(&data, "xl/worksheets/sheet1.xml");
        let sheet2 = read_zip_entry(&data, "xl/worksheets/sheet2.xml");
        let sheet3 = read_zip_entry(&data, "xl/worksheets/sheet3.xml");

        // Each sheet has header row; data rows are split consecutively.
        assert!(sheet1.contains("row_1") && sheet1.contains("row_2"));
        assert!(!sheet1.contains("row_3"));
        assert!(sheet2.contains("row_3") && sheet2.contains("row_4"));
        assert!(!sheet2.contains("row_1") && !sheet2.contains("row_5"));
        assert!(sheet3.contains("row_5"));
        assert!(!sheet3.contains("row_1"));
        // 1 header + up to 2 data rows per sheet.
        let row_elems = |xml: &str| xml.matches("<row r=\"").count();
        assert_eq!(row_elems(&sheet1), 3, "sheet1: {sheet1}");
        assert_eq!(row_elems(&sheet2), 3, "sheet2: {sheet2}");
        assert_eq!(row_elems(&sheet3), 2, "sheet3: {sheet3}");
    }

    #[test]
    fn large_in_memory_worksheet_is_written_in_bounded_chunks() {
        let rows: Vec<Vec<Value>> = (1..=25_000)
            .map(|index| {
                vec![
                    json!(index),
                    json!(format!("user_{index}")),
                    json!(format!("user_{index}@example.com")),
                    json!(index % 2 == 0),
                    json!(format!("note-{index:06}-{}", "x".repeat(128))),
                ]
            })
            .collect();
        let worksheet = XlsxWorksheetData {
            sheet_name: Some("Users".to_string()),
            columns: vec![
                "id".to_string(),
                "name".to_string(),
                "email".to_string(),
                "active".to_string(),
                "notes".to_string(),
            ],
            column_types: vec![
                "integer".to_string(),
                "text".to_string(),
                "text".to_string(),
                "boolean".to_string(),
                "text".to_string(),
            ],
            column_comments: vec![],
            rows,
            numeric_column_right_align: true,
        };
        let segment = WorksheetSegment {
            name: worksheet.sheet_name.clone(),
            columns: &worksheet.columns,
            column_types: &worksheet.column_types,
            column_comments: &worksheet.column_comments,
            rows: &worksheet.rows,
            numeric_column_right_align: worksheet.numeric_column_right_align,
        };
        let mut stats = WriteStats::default();

        write_worksheet_xml(&mut stats, &segment).expect("write large worksheet");

        assert!(stats.bytes_written > 10_000_000, "expected realistic worksheet size, got {}", stats.bytes_written);
        assert!(
            stats.largest_write < 16 * 1024,
            "worksheet should be streamed row-by-row, largest write was {}",
            stats.largest_write
        );
        assert!(stats.write_calls >= worksheet.rows.len(), "expected at least one bounded write per row");
    }

    #[test]
    fn build_xlsx_workbook_multi_splits_only_overflowing_sheets() {
        // Sheet A: 7 rows, max 3 → "A", "A (2)", "A (3)".
        // Sheet B: 2 rows, max 3 → stays "B". Total 4 sheets.
        let sheet_a = XlsxWorksheetData {
            sheet_name: Some("A".to_string()),
            columns: vec!["val".to_string()],
            column_types: vec![],
            column_comments: vec![],
            rows: (0..7).map(|i| vec![json!(i)]).collect(),
            numeric_column_right_align: false,
        };
        let sheet_b = XlsxWorksheetData {
            sheet_name: Some("B".to_string()),
            columns: vec!["val".to_string()],
            column_types: vec![],
            column_comments: vec![],
            rows: (100..102).map(|i| vec![json!(i)]).collect(),
            numeric_column_right_align: false,
        };
        let data = build_xlsx_workbook_multi_with_max_rows(&[sheet_a, sheet_b], 3).expect("build workbook");

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"A\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"A (2)\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"A (3)\""), "workbook: {workbook_xml}");
        assert!(workbook_xml.contains("name=\"B\""), "workbook: {workbook_xml}");
        assert_eq!(workbook_xml.matches("name=\"").count(), 4, "expected 4 sheets: {workbook_xml}");

        // Sheet B should be the 4th entry (after A's 3 chunks).
        let sheet_b_xml = read_zip_entry(&data, "xl/worksheets/sheet4.xml");
        assert!(sheet_b_xml.contains(">100<"), "sheet B must contain 100: {sheet_b_xml}");
        assert!(sheet_b_xml.contains(">101<"), "sheet B must contain 101: {sheet_b_xml}");

        // A's chunks: sheet1 (rows 0-2), sheet2 (rows 3-5), sheet3 (row 6).
        let sheet1 = read_zip_entry(&data, "xl/worksheets/sheet1.xml");
        assert_eq!(sheet1.matches("<row r=\"").count(), 4); // header + 3 rows
        let sheet3 = read_zip_entry(&data, "xl/worksheets/sheet3.xml");
        assert_eq!(sheet3.matches("<row r=\"").count(), 2); // header + 1 row
    }

    #[test]
    fn build_xlsx_workbook_under_limit_single_sheet() {
        let rows: Vec<Vec<Value>> = vec![vec![json!(1), json!("Ada")]];
        let data = build_xlsx_workbook_multi_with_max_rows(
            &[XlsxWorksheetData {
                sheet_name: Some("MySheet".to_string()),
                columns: vec!["id".to_string(), "name".to_string()],
                column_types: vec![],
                column_comments: vec![],
                rows,
                numeric_column_right_align: false,
            }],
            100,
        )
        .expect("build workbook");

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"MySheet\""), "workbook: {workbook_xml}");
        assert!(!workbook_xml.contains("MySheet (2)"), "should not split: {workbook_xml}");
        assert_eq!(workbook_xml.matches("name=\"").count(), 1, "expected exactly 1 sheet: {workbook_xml}");

        let sheet = read_zip_entry(&data, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("Ada"), "sheet should contain data: {sheet}");
        // sheet2 must not exist.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).expect("open xlsx");
        assert!(archive.by_name("xl/worksheets/sheet2.xml").is_err(), "sheet2 must not exist");
    }

    #[test]
    fn build_xlsx_workbook_zero_rows_produces_header_only_sheet() {
        let data = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Empty".to_string()),
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: vec![],
            column_comments: vec![],
            rows: vec![],
            numeric_column_right_align: false,
        })
        .expect("build workbook");

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Empty\""), "workbook: {workbook_xml}");
        let sheet = read_zip_entry(&data, "xl/worksheets/sheet1.xml");
        // Header row present, no data rows.
        assert!(sheet.contains("id"), "header must contain 'id': {sheet}");
        assert!(sheet.contains("name"), "header must contain 'name': {sheet}");
        // Exactly one <row> element (header row).
        let row_count = sheet.matches("<row r=\"").count();
        assert_eq!(row_count, 1, "expected 1 row (header only), got {row_count}: {sheet}");
    }

    #[test]
    fn one_over_limit_creates_new_sheet() {
        // max 2 rows, write 3 rows -> 2 data sheets
        let rows: Vec<Vec<Value>> = (1..=3).map(|i| vec![json!(i), json!(format!("row_{i}"))]).collect();
        let data = build_multi_sheet_xlsx(&rows, 2);

        let workbook_xml = read_zip_entry(&data, "xl/workbook.xml");
        assert!(workbook_xml.contains("name=\"Result\""));
        assert!(workbook_xml.contains("name=\"Result (2)\""));

        let sheet2 = read_zip_entry(&data, "xl/worksheets/sheet2.xml");
        assert!(sheet2.contains("row_3"), "row 3 should be on sheet 2: {sheet2}");
    }
}
