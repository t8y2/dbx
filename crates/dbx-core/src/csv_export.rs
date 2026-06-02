use serde_json::Value;

pub(crate) fn escape_csv(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn value_to_csv_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => v.clone(),
        other => other.to_string(),
    }
}

pub fn format_csv(columns: &[String], rows: &[Vec<Value>]) -> String {
    let header = columns.iter().map(|col| escape_csv(col)).collect::<Vec<_>>().join(",");
    let body = rows
        .iter()
        .map(|row| row.iter().map(|cell| escape_csv(&value_to_csv_text(cell))).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}\n{body}")
}

#[cfg(test)]
mod tests {
    use super::format_csv;
    use serde_json::json;

    #[test]
    fn formats_csv_with_header_and_escaped_values() {
        let out = format_csv(&["id".to_string(), "name".to_string()], &[vec![json!(1), json!("Ada \"Lovelace\"")]]);
        assert_eq!(out, "\"id\",\"name\"\n\"1\",\"Ada \"\"Lovelace\"\"\"");
    }

    #[test]
    fn formats_null_as_empty_cell() {
        let out = format_csv(&["id".to_string(), "note".to_string()], &[vec![json!(1), Value::Null]]);
        assert_eq!(out, "\"id\",\"note\"\n\"1\",\"\"");
    }

    use serde_json::Value;
}
