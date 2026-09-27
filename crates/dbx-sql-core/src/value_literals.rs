pub fn format_pg_array_sql_literal(arr: &[serde_json::Value]) -> String {
    if arr.is_empty() {
        return "'{}'".to_string();
    }
    let elements: Vec<String> = arr.iter().map(format_pg_array_element).collect();
    let inner = format!("{{{}}}", elements.join(","));
    format!("'{}'", inner.replace('\\', "\\\\").replace('\'', "''"))
}

pub fn format_pg_array_element(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return "{}".to_string();
            }
            let elements: Vec<String> = arr.iter().map(format_pg_array_element).collect();
            format!("{{{}}}", elements.join(","))
        }
        serde_json::Value::String(s) => {
            let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Object(o) => {
            let json = serde_json::to_string(o).unwrap_or_default();
            let escaped = json.replace('\\', "\\\\").replace('"', "\\\"");
            format!("\"{}\"", escaped)
        }
    }
}

pub fn format_ch_array_sql_literal(arr: &[serde_json::Value]) -> String {
    if arr.is_empty() {
        return "[]".to_string();
    }
    let elements: Vec<String> = arr.iter().map(format_ch_array_element).collect();
    format!("[{}]", elements.join(","))
}

pub fn format_ch_array_element(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Array(arr) => {
            if arr.is_empty() {
                return "[]".to_string();
            }
            let elements: Vec<String> = arr.iter().map(format_ch_array_element).collect();
            format!("[{}]", elements.join(","))
        }
        serde_json::Value::String(s) => {
            let escaped = s.replace('\\', "\\\\").replace('\'', "''");
            format!("'{}'", escaped)
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Object(o) => {
            let json = serde_json::to_string(o).unwrap_or_default();
            format!("'{}'", json.replace('\\', "\\\\").replace('\'', "''"))
        }
    }
}

pub fn quote_postgres_string_literal(value: &str) -> String {
    if !value.contains('\\') && !value.chars().any(|character| character.is_ascii_control()) {
        return quote_string_literal(value);
    }

    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\x08' => escaped.push_str("\\b"),
            '\x0c' => escaped.push_str("\\f"),
            '\'' => escaped.push_str("''"),
            character if character.is_ascii_control() => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                let byte = character as u8;
                escaped.push_str("\\x");
                escaped.push(HEX[(byte >> 4) as usize] as char);
                escaped.push(HEX[(byte & 0x0F) as usize] as char);
            }
            character => escaped.push(character),
        }
    }

    // Escape string constants keep control characters out of the physical
    // script and remain correct regardless of standard_conforming_strings.
    format!("E'{escaped}'")
}

pub fn is_postgres_vector_type(column_type: Option<&str>) -> bool {
    column_type
        .map(|column_type| {
            let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
            if normalized.trim_end().ends_with("[]") {
                return false;
            }
            let base = normalized.split(['(', ' ', '\t', '\n']).next().unwrap_or("").trim_matches('"');
            matches!(base, "vector" | "halfvec") || base.ends_with(".vector") || base.ends_with(".halfvec")
        })
        .unwrap_or(false)
}

pub fn format_postgres_vector_sql_literal(value: &serde_json::Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    let text = match value {
        // pgvector vector/halfvec are scalar extension types whose importable
        // literal grammar uses square brackets, unlike PostgreSQL arrays.
        serde_json::Value::Array(arr) => {
            let elements = arr.iter().map(format_postgres_vector_element).collect::<Vec<_>>();
            format!("[{}]", elements.join(","))
        }
        serde_json::Value::String(text) => text.to_string(),
        _ => value.to_string(),
    };
    quote_postgres_string_literal(&text)
}

pub fn format_postgres_vector_element(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Null => "NULL".to_string(),
        _ => value.to_string(),
    }
}

pub fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
