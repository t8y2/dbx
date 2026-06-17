use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorksheetData {
    pub sheet_name: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
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
    // Safety: all pushed chars are ASCII, so reversing by bytes is correct
    unsafe {
        out.as_mut_vec().reverse();
    }
    out
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
                .map(|(col_index, _)| cell_xml(row.get(col_index), excel_row - 1, col_index, None))
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

fn content_types_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
        "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
        "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>",
        "</Types>"
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

fn workbook_xml(sheet_name: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
            "<sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets>",
            "</workbook>"
        ),
        escape_xml(sheet_name)
    )
}

fn workbook_rels_xml() -> &'static str {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>",
        "</Relationships>"
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

pub fn build_xlsx_workbook(data: &XlsxWorksheetData) -> Result<Vec<u8>, String> {
    let sheet_name = normalize_sheet_name(data.sheet_name.as_deref());
    let files = vec![
        ("[Content_Types].xml", content_types_xml().to_string()),
        ("_rels/.rels", root_rels_xml().to_string()),
        ("xl/workbook.xml", workbook_xml(&sheet_name)),
        ("xl/_rels/workbook.xml.rels", workbook_rels_xml().to_string()),
        ("xl/styles.xml", styles_xml().to_string()),
        ("xl/worksheets/sheet1.xml", worksheet_xml(data)),
    ];

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for (path, content) in files {
        zip.start_file(path, options).map_err(|err| err.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|err| err.to_string())?;
    }

    let output = zip.finish().map_err(|err| err.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{build_xlsx_workbook, XlsxWorksheetData};
    use serde_json::json;

    #[test]
    fn builds_xlsx_zip_with_sheet_data() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("Users".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string()],
            rows: vec![vec![json!(1), json!("Ada & Bob"), json!(true)], vec![json!(2), json!(null), json!(false)]],
        })
        .expect("build workbook");
        let text = String::from_utf8_lossy(&workbook);

        assert_eq!(workbook[0], 0x50);
        assert_eq!(workbook[1], 0x4b);
        assert!(text.contains("[Content_Types].xml"));
        assert!(text.contains("xl/worksheets/sheet1.xml"));
        assert!(text.contains("name=\"Users\""));
        assert!(text.contains("<c r=\"A2\"><v>1</v></c>"));
        assert!(text.contains("Ada &amp; Bob"));
        assert!(text.contains("<c r=\"C2\" t=\"b\"><v>1</v></c>"));
    }

    #[test]
    fn sanitizes_invalid_sheet_name() {
        let workbook = build_xlsx_workbook(&XlsxWorksheetData {
            sheet_name: Some("bad/name:with*chars?and-a-very-long-tail".to_string()),
            columns: vec!["value".to_string()],
            rows: vec![vec![json!("ok")]],
        })
        .expect("build workbook");
        let text = String::from_utf8_lossy(&workbook);
        assert!(text.contains("name=\"bad name with chars and-a-very-\""));
    }
}
