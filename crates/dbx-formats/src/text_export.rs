use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultTextExportData {
    #[serde(default)]
    pub title: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

pub fn format_json(data: &QueryResultTextExportData) -> Result<String, String> {
    let rows = data
        .rows
        .iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in data.columns.iter().enumerate() {
                if let Some(value) = row.get(index) {
                    object.insert(column.clone(), value.clone());
                }
            }
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    serde_json::to_string_pretty(&rows).map_err(|err| err.to_string())
}

pub fn format_markdown(data: &QueryResultTextExportData) -> String {
    let normalized_columns = data.columns.iter().map(|column| markdown_cell(column)).collect::<Vec<_>>();
    let normalized_rows = data
        .rows
        .iter()
        .map(|row| row.iter().map(|cell| markdown_cell(&display_cell(cell))).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let widths = normalized_columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let row_width = normalized_rows
                .iter()
                .map(|row| row.get(index).map(|cell| cell.chars().count()).unwrap_or(0))
                .max()
                .unwrap_or(0);
            column.chars().count().max(row_width).max(3)
        })
        .collect::<Vec<_>>();

    let header = format!(
        "| {} |",
        normalized_columns
            .iter()
            .enumerate()
            .map(|(index, column)| pad(column, widths[index]))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    let separator = format!("| {} |", widths.iter().map(|width| "-".repeat(*width)).collect::<Vec<_>>().join(" | "));
    let body = normalized_rows
        .iter()
        .map(|row| {
            format!(
                "| {} |",
                row.iter()
                    .enumerate()
                    .map(|(index, cell)| pad(cell, widths.get(index).copied().unwrap_or(3)))
                    .collect::<Vec<_>>()
                    .join(" | ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    [header, separator, body].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n") + "\n"
}

fn display_cell(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn markdown_cell(value: &str) -> String {
    value.replace('|', "\\|").replace("\r\n", "<br>").replace('\n', "<br>")
}

fn pad(value: &str, width: usize) -> String {
    let current = value.chars().count();
    if current >= width {
        return value.to_string();
    }
    format!("{value}{}", " ".repeat(width - current))
}

pub fn format_html(data: &QueryResultTextExportData) -> String {
    let now = chrono_local_now();
    let heading = data.title.as_deref().unwrap_or("Query Result");
    let row_count = data.rows.len();
    let col_count = data.columns.len();

    let mut html = String::with_capacity(4096 + col_count * 64 + row_count * col_count * 48);

    html.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    html.push_str("  <meta charset=\"UTF-8\">\n");
    html.push_str("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n");
    html.push_str(&format!("  <title>{}</title>\n", html_escape(heading)));
    html.push_str(
        r#"  <style>
    :root {
      --surface: #ffffff; --bg: #f6f8fa;
      --text: #1f2328; --text-2: #59636e; --muted: #818b98;
      --border: #d1d9e0; --border-2: #e7ecf0;
      --hover: #eef2f6; --stripe: #f9fbfc;
      --th-bg: #f0f3f6;
      --ok: #1a7f37; --danger: #cf222e;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #1c2128; --bg: #0d1117;
        --text: #e6edf3; --text-2: #9198a1; --muted: #6e7681;
        --border: #3d444d; --border-2: #2a3038;
        --hover: #202830; --stripe: #161b22;
        --th-bg: #22272e;
        --ok: #3fb950; --danger: #f85149;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC",
                   "Microsoft YaHei", sans-serif;
      background: var(--bg); color: var(--text);
      padding: 16px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      height: 100vh; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .page {
      flex: 1; min-height: 0; width: 100%;
      display: flex; flex-direction: column;
    }
    .hdr { flex-shrink: 0; margin-bottom: 12px; }
    .hdr h1 { font-size: 16px; font-weight: 600; }
    .hdr .meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .tbl-wrap {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .tbl-scroll {
      flex: 1; min-height: 0;
      overflow: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--muted) transparent;
    }
    .tbl-scroll::-webkit-scrollbar { height: 10px; width: 10px; }
    .tbl-scroll::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 8px; }
    .tbl-scroll::-webkit-scrollbar-thumb:hover { background: var(--text-2); }
    .tbl-scroll::-webkit-scrollbar-track { background: transparent; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      padding: 8px 12px;
      background: var(--th-bg); color: var(--text);
      font-weight: 600; font-size: 12px; text-align: left;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    tbody td {
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 380px;
      color: var(--text); vertical-align: middle;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:nth-child(even) td { background: var(--stripe); }
    tbody tr:hover td { background: var(--hover); }
    td.null { color: var(--muted); font-style: italic; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, Consolas, "Liberation Mono", monospace; }
    td.boolean { text-align: center; }
    td.boolean.true  { color: var(--ok); }
    td.boolean.false { color: var(--danger); }
    .ftr { flex-shrink: 0; margin-top: 12px; font-size: 11px; color: var(--muted); text-align: center; }
    @media print {
      html, body { height: auto; overflow: visible; }
      body { display: block; background: #fff; padding: 0; }
      .page, .tbl-wrap { display: block; }
      .tbl-scroll { max-height: none; overflow: visible; }
      thead th { position: static; }
    }
  </style>
</head>
<body>
  <div class="page">
"#
    );

    // Header
    html.push_str("    <div class=\"hdr\">\n");
    html.push_str(&format!("      <h1>{}</h1>\n", html_escape(heading)));
    html.push_str(&format!(
        "      <div class=\"meta\">{} rows &middot; {} columns &middot; {} &middot; DBX</div>\n",
        row_count,
        col_count,
        html_escape(&now)
    ));
    html.push_str("    </div>\n");

    // Table card
    html.push_str("    <div class=\"tbl-wrap\">\n");
    html.push_str("      <div class=\"tbl-scroll\">\n");
    html.push_str("        <table>\n          <thead>\n            <tr>\n");
    for col in &data.columns {
        html.push_str(&format!("              <th>{}</th>\n", html_escape(col)));
    }
    html.push_str("            </tr>\n          </thead>\n          <tbody>\n");

    for row in &data.rows {
        html.push_str("            <tr>\n");
        for cell in row {
            let (text, css_class) = html_cell_value(cell);
            if css_class.is_empty() {
                html.push_str(&format!("              <td>{}</td>\n", html_escape(&text)));
            } else {
                html.push_str(&format!("              <td class=\"{}\">{}</td>\n", css_class, html_escape(&text)));
            }
        }
        html.push_str("            </tr>\n");
    }

    html.push_str("          </tbody>\n        </table>\n      </div>\n    </div>\n");
    html.push_str("    <div class=\"ftr\">Exported by DBX</div>\n");
    html.push_str("  </div>\n</body>\n</html>\n");
    html
}

fn html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '\n' => out.push_str("<br>"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

fn html_cell_value(value: &Value) -> (String, &'static str) {
    match value {
        Value::Null => ("NULL".to_string(), "null"),
        Value::Bool(true) => ("true".to_string(), "boolean true"),
        Value::Bool(false) => ("false".to_string(), "boolean false"),
        Value::Number(n) => (n.to_string(), "number"),
        Value::String(s) => (s.clone(), ""),
        other => (other.to_string(), ""),
    }
}

fn chrono_local_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{format_html, format_json, format_markdown, QueryResultTextExportData};

    #[test]
    fn formats_json_rows_as_objects() {
        let out = format_json(&QueryResultTextExportData {
            title: None,
            columns: vec!["id".to_string(), "name".to_string(), "active".to_string(), "note".to_string()],
            rows: vec![vec![json!(1), json!("Ada"), json!(true), Value::Null]],
        })
        .unwrap();

        assert_eq!(
            out,
            r#"[
  {
    "id": 1,
    "name": "Ada",
    "active": true,
    "note": null
  }
]"#
        );
    }

    #[test]
    fn formats_markdown_with_escaped_pipes_and_newlines() {
        let out = format_markdown(&QueryResultTextExportData {
            title: None,
            columns: vec!["id".to_string(), "payload|kind".to_string()],
            rows: vec![vec![json!(1), json!("a|b")], vec![json!(2), json!("line one\nline two")]],
        });

        assert_eq!(
            out,
            [
                "| id  | payload\\|kind        |",
                "| --- | -------------------- |",
                "| 1   | a\\|b                 |",
                "| 2   | line one<br>line two |",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn formats_html_document_structure() {
        let out = format_html(&QueryResultTextExportData {
            title: None,
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![vec![json!(1), json!("Ada")]],
        });

        assert!(out.starts_with("<!DOCTYPE html>"), "must start with doctype");
        assert!(out.ends_with("</html>\n"), "must end with closing html tag");
        assert!(out.contains("<meta charset=\"UTF-8\">"));
        assert!(out.contains("<style>"), "CSS must be embedded");
        assert!(out.contains("<h1>Query Result</h1>"), "default heading when no title");
        assert!(out.contains("<th>id</th>"), "column headers must be rendered");
        assert!(out.contains("<th>name</th>"));
        assert!(out.contains("1 rows &middot; 2 columns"), "row/column counts in meta line");
        assert!(out.contains("Exported by DBX"), "footer watermark");
    }

    #[test]
    fn formats_html_uses_custom_title() {
        let out = format_html(&QueryResultTextExportData {
            title: Some("public.users".to_string()),
            columns: vec!["id".to_string()],
            rows: vec![vec![json!(1)]],
        });

        assert!(out.contains("<title>public.users</title>"), "document title must use table name");
        assert!(out.contains("<h1>public.users</h1>"), "heading must use table name");
        assert!(!out.contains("<h1>Query Result</h1>"), "default heading must not appear");
    }

    #[test]
    fn formats_html_escapes_title() {
        let out = format_html(&QueryResultTextExportData {
            title: Some("<b>users & more</b>".to_string()),
            columns: vec!["id".to_string()],
            rows: vec![],
        });

        assert!(out.contains("&lt;b&gt;users &amp; more&lt;/b&gt;"), "title must be escaped");
        assert!(!out.contains("<b>users"), "raw markup must never appear in heading");
    }

    #[test]
    fn formats_html_with_typed_cell_classes() {
        let out = format_html(&QueryResultTextExportData {
            title: None,
            columns: vec!["n".to_string(), "flag".to_string(), "off".to_string(), "note".to_string()],
            rows: vec![vec![json!(42), json!(true), json!(false), Value::Null]],
        });

        assert!(out.contains("<td class=\"number\">42</td>"));
        assert!(out.contains("<td class=\"boolean true\">true</td>"));
        assert!(out.contains("<td class=\"boolean false\">false</td>"));
        assert!(out.contains("<td class=\"null\">NULL</td>"));
    }

    #[test]
    fn formats_html_escapes_special_characters() {
        let out = format_html(&QueryResultTextExportData {
            title: None,
            columns: vec!["col<a>".to_string()],
            rows: vec![vec![json!("<script>alert('x');</script> & \"quoted\"")]],
        });

        assert!(out.contains("<th>col&lt;a&gt;</th>"), "header must be escaped");
        assert!(!out.contains("<script>alert"), "raw script tag must never appear");
        assert!(out.contains("&lt;script&gt;"));
        assert!(out.contains("&amp; &quot;quoted&quot;"));
        assert!(out.contains("&#39;x&#39;"), "single quotes must be escaped");
    }

    #[test]
    fn formats_html_empty_result_set() {
        let out =
            format_html(&QueryResultTextExportData { title: None, columns: vec!["id".to_string()], rows: vec![] });

        assert!(out.contains("0 rows &middot; 1 columns"));
        assert!(out.contains("<tbody>\n          </tbody>"), "empty tbody");
    }

    #[test]
    fn local_now_matches_expected_format() {
        let stamp = super::chrono_local_now();
        // e.g. 2026-09-17 14:30:59
        let parts: Vec<&str> = stamp.split(['-', ' ', ':']).collect();
        assert_eq!(parts.len(), 6, "timestamp must have 6 parts: {stamp}");
        assert_eq!(stamp.len(), 19, "timestamp must be 19 chars: {stamp}");
        let year: i32 = parts[0].parse().unwrap();
        let month: u32 = parts[1].parse().unwrap();
        let day: u32 = parts[2].parse().unwrap();
        assert!((2020..=2100).contains(&year), "year out of range: {year}");
        assert!((1..=12).contains(&month), "month out of range: {month}");
        assert!((1..=31).contains(&day), "day out of range: {day}");
    }
}
