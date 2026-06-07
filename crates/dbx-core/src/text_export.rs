use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultTextExportData {
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

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{format_json, format_markdown, QueryResultTextExportData};

    #[test]
    fn formats_json_rows_as_objects() {
        let out = format_json(&QueryResultTextExportData {
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
}
