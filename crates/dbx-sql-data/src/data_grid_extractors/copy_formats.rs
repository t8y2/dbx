use super::{
    write_bytes, DataGridExtractError, DataGridExtractErrorCode, DataGridExtractWarning, DataGridExtractWarningCode,
    DataGridPhpArraySyntax, ExtractContext,
};
use crate::models::connection::DatabaseType;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::Value;
use std::io::Write;

pub(super) fn write_dbunit(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    let options = &context.request.options.dbunit;
    let raw_name = context
        .request
        .source_table_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&options.table_name);
    let table_name = if options.upper_case_table_name { raw_name.to_uppercase() } else { raw_name.to_string() };
    validate_xml_name(&table_name, "table")?;
    let columns = context
        .selected_columns
        .iter()
        .map(|column| {
            let name = if options.upper_case_column_names {
                column.display_name.to_uppercase()
            } else {
                column.display_name.clone()
            };
            validate_xml_name(&name, "column")?;
            Ok(name)
        })
        .collect::<Result<Vec<_>, DataGridExtractError>>()?;
    let mut names = std::collections::HashSet::new();
    for name in &columns {
        if !names.insert(name) {
            return Err(invalid_format(format!("DbUnit column names collide after case conversion: '{name}'.")));
        }
    }
    if options.include_null_values {
        for row in &context.request.rows {
            for (column, index) in context.selected_columns.iter().zip(&context.selected_source_indexes) {
                let value = &row[*index];
                if !value.is_null()
                    && dbunit_value_text(value, is_binary_type(column.data_type.as_deref()))?
                        == options.null_value_string
                {
                    return Err(invalid_format(
                        "A selected value matches the DbUnit NULL marker after serialization. Choose another marker before copying.",
                    ));
                }
            }
        }
    }
    write_bytes(output, b"<dataset>\n")?;
    for row in &context.request.rows {
        write_bytes(output, format!("  <{table_name}").as_bytes())?;
        for ((column, name), index) in
            context.selected_columns.iter().zip(&columns).zip(&context.selected_source_indexes)
        {
            let value = &row[*index];
            if value.is_null() && !options.include_null_values {
                continue;
            }
            write_bytes(output, b" ")?;
            write_bytes(output, name.as_bytes())?;
            write_bytes(output, b"=\"")?;
            if value.is_null() {
                write_xml_attribute(output, &options.null_value_string)?;
            } else {
                write_xml_attribute(output, &dbunit_value_text(value, is_binary_type(column.data_type.as_deref()))?)?;
            }
            write_bytes(output, b"\"")?;
        }
        write_bytes(output, b" />\n")?;
    }
    write_bytes(output, b"</dataset>")
}

pub(super) fn write_php(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<Vec<DataGridExtractWarning>, DataGridExtractError> {
    let options = &context.request.options.php;
    let source_variable = context.request.source_table_name.as_deref().filter(|name| valid_php_identifier(name));
    let variable_name =
        if options.variable_name.is_empty() { source_variable.unwrap_or("data") } else { &options.variable_name };
    if !valid_php_identifier(variable_name) {
        return Err(invalid_format(
            "PHP variable name must start with a letter or underscore and contain only letters, numbers, and underscores.",
        ));
    }
    if options.row_delimiter.chars().count() > 8
        || !options.row_delimiter.chars().all(|character| character.is_ascii_whitespace())
    {
        return Err(invalid_format("PHP row delimiter must contain at most 8 whitespace characters."));
    }
    let short = options.array_syntax == DataGridPhpArraySyntax::Short;
    let (open, close) = if short { ("[", "]") } else { ("array(", ")") };
    let mut column_names = std::collections::HashSet::new();
    for column in &context.selected_columns {
        if !column_names.insert(&column.display_name) {
            return Err(invalid_format(format!(
                "PHP array keys are duplicated for column '{}'. Add distinct query aliases before copying.",
                column.display_name
            )));
        }
    }
    write_bytes(output, format!("<?php\n${} = {}{}", variable_name, open, options.row_delimiter).as_bytes())?;
    let mut invalid_date = false;
    for (row_index, row) in context.request.rows.iter().enumerate() {
        write_bytes(output, b"    ")?;
        write_bytes(output, open.as_bytes())?;
        for (column_position, (column, source_index)) in
            context.selected_columns.iter().zip(&context.selected_source_indexes).enumerate()
        {
            if column_position > 0 {
                write_bytes(output, b", ")?;
            }
            write_php_string(output, &column.display_name, options.quote_char)?;
            write_bytes(output, b" => ")?;
            let value = &row[*source_index];
            if !value.is_null() && is_binary_type(column.data_type.as_deref()) {
                write_bytes(output, format!("base64_decode('{}', true)", base64(&binary_bytes(value)?)).as_bytes())?;
            } else {
                invalid_date |= write_php_value(
                    output,
                    value,
                    column.data_type.as_deref(),
                    context.request.database_type,
                    options.quote_char,
                    options.format_date_iso,
                )?;
            }
        }
        write_bytes(output, close.as_bytes())?;
        let delimiter = if row_index + 1 == context.request.rows.len() {
            options.row_delimiter.clone()
        } else {
            format!(",{}", options.row_delimiter)
        };
        write_bytes(output, delimiter.as_bytes())?;
    }
    write_bytes(output, format!("{};{}?>", if short { "]" } else { ");" }, options.row_delimiter).as_bytes())?;
    Ok(if invalid_date {
        vec![DataGridExtractWarning {
            code: DataGridExtractWarningCode::PhpDateNotIso,
            message: "Some temporal values were not valid ISO date/time text; their original text was preserved."
                .to_string(),
        }]
    } else {
        Vec::new()
    })
}

fn write_php_value(
    output: &mut dyn Write,
    value: &Value,
    data_type: Option<&str>,
    database_type: Option<DatabaseType>,
    quote: char,
    format_date_iso: bool,
) -> Result<bool, DataGridExtractError> {
    match value {
        Value::Null => {
            write_bytes(output, b"null")?;
            Ok(false)
        }
        Value::Bool(value) => {
            write_bytes(output, if *value { b"true" } else { b"false" })?;
            Ok(false)
        }
        Value::Number(number) if number.as_i64().is_some_and(|value| value.unsigned_abs() <= 9_007_199_254_740_991) => {
            write_bytes(output, number.to_string().as_bytes())?;
            Ok(false)
        }
        Value::Number(number) if number.as_u64().is_some_and(|value| value <= 9_007_199_254_740_991) => {
            write_bytes(output, number.to_string().as_bytes())?;
            Ok(false)
        }
        Value::Number(number) if number.is_f64() && is_floating_type(data_type, database_type) => {
            write_bytes(output, number.to_string().as_bytes())?;
            Ok(false)
        }
        Value::Number(number) => {
            write_php_string(output, &number.to_string(), quote)?;
            Ok(false)
        }
        Value::String(text) => {
            let should_format = format_date_iso && is_temporal_type(data_type);
            let formatted = if should_format { iso_date(text) } else { Some(text.clone()) };
            write_php_string(output, formatted.as_deref().unwrap_or(text), quote)?;
            Ok(should_format && formatted.is_none())
        }
        Value::Array(_) | Value::Object(_) => {
            write_php_string(output, &value.to_string(), quote)?;
            Ok(false)
        }
    }
}

fn write_php_string(output: &mut dyn Write, value: &str, quote: char) -> Result<(), DataGridExtractError> {
    if quote == '\'' && (value.contains('\r') || value.contains('\n')) {
        // Clipboard line-ending normalization rewrites literal CR/LF bytes in the
        // generated source. Keep those value bytes inside PHP escape sequences.
        let mut start = 0;
        for (index, character) in value.char_indices().filter(|(_, character)| matches!(character, '\r' | '\n')) {
            write_php_string_literal(output, &value[start..index], quote)?;
            let escaped: &[u8] = if character == '\r' { br#" . "\r" . "# } else { br#" . "\n" . "# };
            write_bytes(output, escaped)?;
            start = index + character.len_utf8();
        }
        return write_php_string_literal(output, &value[start..], quote);
    }
    write_php_string_literal(output, value, quote)
}

fn write_php_string_literal(output: &mut dyn Write, value: &str, quote: char) -> Result<(), DataGridExtractError> {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push(quote);
    for character in value.chars() {
        match character {
            '\\' => encoded.push_str("\\\\"),
            '\n' if quote == '"' => encoded.push_str("\\n"),
            '\n' => encoded.push('\n'),
            '\r' if quote == '"' => encoded.push_str("\\r"),
            '\r' => encoded.push('\r'),
            '\t' if quote == '"' => encoded.push_str("\\t"),
            '\t' => encoded.push('\t'),
            control if control.is_ascii_control() && quote == '"' => {
                encoded.push_str(&format!("\\x{:02x}", control as u32))
            }
            control if control.is_ascii_control() => encoded.push(control),
            control if control.is_control() && quote == '"' => {
                let mut buffer = [0; 4];
                for byte in control.encode_utf8(&mut buffer).as_bytes() {
                    encoded.push_str(&format!("\\x{byte:02x}"));
                }
            }
            control if control.is_control() => encoded.push(control),
            '\'' if quote == '\'' => encoded.push_str("\\'"),
            '"' if quote == '"' => encoded.push_str("\\\""),
            '$' if quote == '"' => encoded.push_str("\\$"),
            _ => encoded.push(character),
        }
    }
    encoded.push(quote);
    write_bytes(output, encoded.as_bytes())
}

fn iso_date(value: &str) -> Option<String> {
    if NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok() || NaiveTime::parse_from_str(value, "%H:%M:%S%.f").is_ok() {
        return Some(value.to_owned());
    }
    let normalized = if value.len() > 10 && value.as_bytes().get(10) == Some(&b' ') {
        format!("{}T{}", &value[..10], &value[11..])
    } else {
        value.to_owned()
    };
    if DateTime::parse_from_rfc3339(&normalized).is_ok()
        || NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
    {
        Some(normalized)
    } else {
        None
    }
}

fn is_temporal_type(data_type: Option<&str>) -> bool {
    let ty = data_type.unwrap_or_default().to_ascii_lowercase();
    ["date", "time", "timestamp", "datetime"].iter().any(|part| ty.contains(part))
}

fn is_floating_type(data_type: Option<&str>, database_type: Option<DatabaseType>) -> bool {
    let ty = data_type.unwrap_or_default().trim().to_ascii_lowercase();
    if ty.starts_with("binary_float") || ty.starts_with("binary_double") {
        return true;
    }
    let Some(database_type) = database_type else { return false };
    if matches!(database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
        return false;
    }
    let first = ty
        .split(|character: char| !character.is_ascii_alphanumeric())
        .find(|token| !token.is_empty())
        .unwrap_or_default();
    matches!(first, "float" | "double" | "real")
        || ["float", "double"].iter().any(|prefix| {
            first
                .strip_prefix(prefix)
                .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit()))
        })
}

fn is_binary_type(data_type: Option<&str>) -> bool {
    let ty = data_type.unwrap_or_default().trim().to_ascii_lowercase();
    if ty.starts_with("binary_float") || ty.starts_with("binary_double") {
        return false;
    }
    ["blob", "varbinary", "bytea", "raw", "image", "bytes"].iter().any(|part| ty.starts_with(part))
        || ty.starts_with("binary")
}

fn binary_text(value: &Value) -> Result<String, DataGridExtractError> {
    Ok(base64(&binary_bytes(value)?))
}

fn dbunit_value_text(value: &Value, binary: bool) -> Result<String, DataGridExtractError> {
    if binary {
        binary_text(value)
    } else {
        Ok(value_text(value))
    }
}

fn binary_bytes(value: &Value) -> Result<Vec<u8>, DataGridExtractError> {
    let Some(text) = value.as_str() else {
        return Err(invalid_format("Binary value is not in the grid's hexadecimal representation."));
    };
    let hex = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .or_else(|| text.strip_prefix("\\x"))
        .or_else(|| text.strip_prefix("\\X"));
    let Some(hex) = hex else {
        return Ok(text.as_bytes().to_vec());
    };
    if hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_format("Binary value contains invalid hexadecimal data."));
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| invalid_format("Binary value contains invalid hexadecimal data."))
        })
        .collect()
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 { TABLE[(third & 0x3f) as usize] as char } else { '=' });
    }
    output
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn valid_php_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn validate_xml_name(value: &str, kind: &str) -> Result<(), DataGridExtractError> {
    let valid_segment = |segment: &str| {
        let mut chars = segment.chars();
        !segment.is_empty()
            && chars.next().is_some_and(|character| character != ':' && xml_name_start(character))
            && chars.all(|character| character != ':' && xml_name_char(character))
    };
    // Namespaced element/attribute names need a bound xmlns prefix. The copied
    // dataset has no namespace configuration, so reject colon names rather than
    // emit XML that only looks valid lexically.
    let valid = !value.contains(':') && valid_segment(value);
    if !valid {
        return Err(invalid_format(format!("DbUnit {kind} name '{value}' is not a valid XML name.")));
    }
    Ok(())
}

fn xml_name_start(character: char) -> bool {
    matches!(character, ':' | 'A'..='Z' | '_' | 'a'..='z' | '\u{00C0}'..='\u{00D6}' | '\u{00D8}'..='\u{00F6}' | '\u{00F8}'..='\u{02FF}' | '\u{0370}'..='\u{037D}' | '\u{037F}'..='\u{1FFF}' | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}' | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}' | '\u{10000}'..='\u{EFFFF}')
}

fn xml_name_char(character: char) -> bool {
    xml_name_start(character)
        || matches!(character, '-' | '.' | '0'..='9' | '\u{00B7}' | '\u{0300}'..='\u{036F}' | '\u{203F}'..='\u{2040}')
}

fn write_xml_attribute(output: &mut dyn Write, value: &str) -> Result<(), DataGridExtractError> {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\r' => escaped.push_str("&#13;"),
            '\n' => escaped.push_str("&#10;"),
            '\t' => escaped.push_str("&#9;"),
            c if is_xml_char(c) => escaped.push(c),
            c => {
                return Err(invalid_format(format!(
                    "DbUnit value contains XML 1.0-invalid character U+{:04X}.",
                    c as u32
                )));
            }
        }
    }
    write_bytes(output, escaped.as_bytes())
}

fn is_xml_char(c: char) -> bool {
    matches!(c as u32, 0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF)
}

fn invalid_format(message: impl Into<String>) -> DataGridExtractError {
    DataGridExtractError::new(DataGridExtractErrorCode::InvalidFormatConfiguration, message)
}

#[cfg(test)]
mod tests {
    use super::{is_temporal_type, iso_date};
    use crate::data_grid_extractors::tests::request;
    use crate::data_grid_extractors::{
        extract_data_grid_selection, DataGridExtractColumn, DataGridExtractWarningCode, DataGridExtractorId,
    };
    use crate::models::connection::DatabaseType;
    use serde_json::json;

    #[test]
    fn dbunit_writes_escaped_flat_dataset_and_distinguishes_null() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("my_table".into());
        request.columns[0].display_name = "a_b".into();
        request.columns[0].data_type = Some("VARCHAR".into());
        request.rows = vec![vec![json!("<x&>\n\t\""), json!(null)]];
        request.options.dbunit.upper_case_table_name = false;
        request.options.dbunit.upper_case_column_names = false;
        let text = extract_data_grid_selection(request).unwrap().text;
        assert_eq!(text, "<dataset>\n  <my_table a_b=\"&lt;x&amp;>&#10;&#9;&quot;\" name=\"[NULL]\" />\n</dataset>");
    }

    #[test]
    fn dbunit_writes_the_validated_column_names_in_configured_case() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("users".into());
        request.columns[0].display_name = "user_id".into();
        request.columns[1].display_name = "displayName".into();
        request.rows = vec![vec![json!(1), json!("Ada")]];

        let upper = extract_data_grid_selection(request.clone()).unwrap().text;
        assert!(upper.contains("<USERS USER_ID=\"1\" DISPLAYNAME=\"Ada\" />"));

        request.options.dbunit.upper_case_table_name = false;
        request.options.dbunit.upper_case_column_names = false;
        let original_case = extract_data_grid_selection(request).unwrap().text;
        assert!(original_case.contains("<users user_id=\"1\" displayName=\"Ada\" />"));
    }

    #[test]
    fn dbunit_rejects_invalid_names_case_collisions_and_marker_conflicts() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("bad name".into());
        assert!(extract_data_grid_selection(request.clone()).unwrap_err().message.contains("valid XML name"));
        request.source_table_name = Some("TABLE".into());
        request.columns = vec![
            DataGridExtractColumn {
                display_name: "id".into(),
                source_name: None,
                source_index: 0,
                data_type: None,
                description: None,
            },
            DataGridExtractColumn {
                display_name: "ID".into(),
                source_name: None,
                source_index: 1,
                data_type: None,
                description: None,
            },
        ];
        request.rows = vec![vec![json!("x"), json!("y")]];
        assert!(extract_data_grid_selection(request.clone()).unwrap_err().message.contains("collide"));
        request.columns.truncate(1);
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!("[NULL]")]];
        assert!(extract_data_grid_selection(request).unwrap_err().message.contains("matches the DbUnit NULL marker"));
    }

    #[test]
    fn dbunit_binary_bytes_do_not_collide_with_text_null_marker() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("T".into());
        request.columns.truncate(1);
        request.columns[0].data_type = Some("BLOB".into());
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!("[NULL]")]];

        let result = extract_data_grid_selection(request).expect("binary marker text is encoded as bytes");
        assert!(result.text.contains("W05VTExd"));
    }

    #[test]
    fn dbunit_rejects_numeric_output_matching_null_marker() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("T".into());
        request.columns.truncate(1);
        request.columns[0].data_type = Some("INTEGER".into());
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!(1)]];
        request.options.dbunit.null_value_string = "1".into();

        let error = extract_data_grid_selection(request.clone()).unwrap_err();
        assert!(error.message.contains("matches the DbUnit NULL marker"));
        request.options.dbunit.null_value_string = "[NULL]".into();
        let result = extract_data_grid_selection(request).expect("a different NULL marker permits the value");
        assert!(result.text.contains("ID=\"1\""), "{}", result.text);
    }

    #[test]
    fn dbunit_rejects_boolean_output_matching_null_marker() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("T".into());
        request.columns.truncate(1);
        request.columns[0].data_type = Some("BOOLEAN".into());
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!(true)]];
        request.options.dbunit.null_value_string = "true".into();

        let error = extract_data_grid_selection(request).unwrap_err();
        assert!(error.message.contains("matches the DbUnit NULL marker"));
    }

    #[test]
    fn dbunit_rejects_binary_output_matching_null_marker() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("T".into());
        request.columns.truncate(1);
        request.columns[0].data_type = Some("BLOB".into());
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!("0x0102")]];
        request.options.dbunit.null_value_string = "AQI=".into();

        let error = extract_data_grid_selection(request).unwrap_err();
        assert!(error.message.contains("matches the DbUnit NULL marker"));
    }

    #[test]
    fn dbunit_without_null_attributes_keeps_numeric_and_binary_text_values() {
        let mut request = request(DataGridExtractorId::Dbunit);
        request.source_table_name = Some("T".into());
        request.columns[0].data_type = Some("INTEGER".into());
        request.columns[1].data_type = Some("BLOB".into());
        request.selected_column_indexes = vec![0, 1];
        request.rows = vec![vec![json!(1), json!("[NULL]")]];
        request.options.dbunit.include_null_values = false;
        request.options.dbunit.null_value_string = "1".into();

        let result = extract_data_grid_selection(request).expect("non-NULL values do not collide after serialization");
        assert!(result.text.contains("ID=\"1\""), "{}", result.text);
        assert!(result.text.contains("NAME=\"W05VTExd\""), "{}", result.text);
    }

    #[test]
    fn php_and_dbunit_keep_oracle_binary_float_values_numeric_not_binary() {
        let columns = vec!["BINARY_FLOAT", "BINARY_DOUBLE"]
            .into_iter()
            .enumerate()
            .map(|(source_index, display_name)| DataGridExtractColumn {
                display_name: display_name.into(),
                source_name: None,
                source_index,
                data_type: Some(display_name.into()),
                description: None,
            })
            .collect::<Vec<_>>();

        let mut php = request(DataGridExtractorId::Php);
        php.columns = columns.clone();
        php.selected_column_indexes = vec![0, 1];
        php.database_type = Some(DatabaseType::Oracle);
        php.rows = vec![vec![json!(1.5), json!(2.25)]];
        let php_text = extract_data_grid_selection(php).expect("PHP binary-float extraction").text;
        assert!(php_text.contains("\"BINARY_FLOAT\" => 1.5"), "{php_text}");
        assert!(php_text.contains("\"BINARY_DOUBLE\" => 2.25"), "{php_text}");

        let mut dbunit = request(DataGridExtractorId::Dbunit);
        dbunit.source_table_name = Some("T".into());
        dbunit.columns = columns;
        dbunit.selected_column_indexes = vec![0, 1];
        dbunit.rows = vec![vec![json!(1.5), json!(2.25)]];
        let dbunit_text = extract_data_grid_selection(dbunit).expect("DbUnit binary-float extraction").text;
        assert!(dbunit_text.contains("BINARY_FLOAT=\"1.5\""), "{dbunit_text}");
        assert!(dbunit_text.contains("BINARY_DOUBLE=\"2.25\""), "{dbunit_text}");
    }

    #[test]
    fn php_and_dbunit_keep_byte_types_in_binary_encoding_path() {
        let columns = ["BINARY", "VARBINARY", "RAW", "BLOB"]
            .into_iter()
            .enumerate()
            .map(|(source_index, data_type)| DataGridExtractColumn {
                display_name: format!("C{source_index}"),
                source_name: None,
                source_index,
                data_type: Some(data_type.into()),
                description: None,
            })
            .collect::<Vec<_>>();

        let mut php = request(DataGridExtractorId::Php);
        php.columns = columns.clone();
        php.selected_column_indexes = vec![0, 1, 2, 3];
        php.rows = vec![vec![json!("0x0102"), json!("0x0102"), json!("0x0102"), json!("0x0102")]];
        let php_text = extract_data_grid_selection(php).expect("PHP byte extraction").text;
        assert_eq!(php_text.matches("base64_decode('AQI=', true)").count(), 4, "{php_text}");

        let mut dbunit = request(DataGridExtractorId::Dbunit);
        dbunit.source_table_name = Some("T".into());
        dbunit.columns = columns;
        dbunit.selected_column_indexes = vec![0, 1, 2, 3];
        dbunit.rows = vec![vec![json!("0x0102"), json!("0x0102"), json!("0x0102"), json!("0x0102")]];
        let dbunit_text = extract_data_grid_selection(dbunit).expect("DbUnit byte extraction").text;
        assert_eq!(dbunit_text.matches("AQI=").count(), 4, "{dbunit_text}");
    }

    #[test]
    fn php_uses_valid_literals_and_escapes_interpolation() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns[0].display_name = "key$".into();
        request.rows = vec![vec![json!("$x\\\"\n\u{0085}"), json!(9007199254740993_u64)]];
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.contains("\\$x\\\\\\\"\\n"));
        assert!(text.contains("\\xc2\\x85"));
        assert!(text.contains("\"9007199254740993\""));
        assert!(text.starts_with("<?php\n$data = [\n"));
    }

    #[test]
    fn php_single_quoted_line_breaks_survive_windows_clipboard_normalization() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns.truncate(1);
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!("a'b\nc\rd")]];
        request.options.php.quote_char = '\'';
        request.options.php.row_delimiter = "\r\n".into();

        let result = extract_data_grid_selection(request).expect("PHP extraction");
        let value_expression = "'a\\'b' . \"\\n\" . 'c' . \"\\r\" . 'd'";
        assert!(result.text.contains(value_expression), "{}", result.text);

        // Same transformation as clipboardLineEndings on Windows: PHP code's
        // physical line endings become CRLF, while value escapes remain intact.
        let copied_text = result.text.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
        assert!(copied_text.contains(value_expression), "{copied_text}");
        assert!(!copied_text.contains("'a\\'b\\r\\nc\\r\\nd'"), "{copied_text}");
    }

    #[test]
    fn php_preserves_floating_point_json_numbers_as_numbers_and_large_integers_as_strings() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns = vec![
            DataGridExtractColumn {
                display_name: "float".into(),
                source_name: None,
                source_index: 0,
                data_type: Some("DOUBLE".into()),
                description: None,
            },
            DataGridExtractColumn {
                display_name: "bigint".into(),
                source_name: None,
                source_index: 1,
                data_type: Some("BIGINT".into()),
                description: None,
            },
        ];
        request.selected_column_indexes = vec![0, 1];
        request.rows = vec![vec![json!(1.5), json!(9007199254740993_u64)]];
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.contains("\"float\" => 1.5"), "{text}");
        assert!(text.contains("\"bigint\" => \"9007199254740993\""), "{text}");
    }

    #[test]
    fn php_keeps_arbitrary_precision_decimal_numbers_as_strings() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns.truncate(1);
        request.selected_column_indexes = vec![0];
        request.columns[0].data_type = Some("DECIMAL".into());
        request.rows = vec![vec![serde_json::from_str("0.1234567890123456789").unwrap()]];
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.contains("\"0.1234567890123456789\""), "{text}");
    }

    #[test]
    fn php_preserves_oracle_float_numeric_precision_as_text() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns.truncate(1);
        request.selected_column_indexes = vec![0];
        request.columns[0].data_type = Some("FLOAT".into());
        request.database_type = Some(DatabaseType::Oracle);
        request.rows = vec![vec![serde_json::from_str("0.1234567890123456789").unwrap()]];
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.contains("\"0.1234567890123456789\""), "{text}");
    }

    #[test]
    fn php_keeps_float_values_as_strings_when_database_type_is_unknown() {
        let mut request = request(DataGridExtractorId::Php);
        request.columns.truncate(1);
        request.selected_column_indexes = vec![0];
        request.columns[0].data_type = Some("FLOAT".into());
        request.database_type = None;
        request.rows = vec![vec![serde_json::from_str("1.5").unwrap()]];
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.contains("\"1.5\""), "{text}");
    }

    #[test]
    fn php_rejects_non_whitespace_row_delimiters() {
        let mut invalid_request = request(DataGridExtractorId::Php);
        invalid_request.options.php.row_delimiter = ";".into();
        assert!(extract_data_grid_selection(invalid_request).unwrap_err().message.contains("whitespace"));

        let mut request = request(DataGridExtractorId::Php);
        request.options.php.row_delimiter.clear();
        let text = extract_data_grid_selection(request).unwrap().text;
        assert!(text.starts_with("<?php\n"));
        assert!(text.ends_with("?>"));
    }

    #[test]
    fn php_date_iso_preserves_valid_precision_and_warns_for_unparseable_text() {
        assert_eq!(iso_date("2026-01-02 03:04:05.123456+08:00"), Some("2026-01-02T03:04:05.123456+08:00".into()));
        assert!(is_temporal_type(Some("TIMESTAMP WITH TIME ZONE")));
        let mut request = request(DataGridExtractorId::Php);
        request.columns = vec![DataGridExtractColumn {
            display_name: "created_at".into(),
            source_name: None,
            source_index: 0,
            data_type: Some("TIMESTAMP WITH TIME ZONE".into()),
            description: None,
        }];
        request.selected_column_indexes = vec![0];
        request.rows = vec![vec![json!("2026-01-02 03:04:05.123456+08:00")], vec![json!("not a date")]];
        request.options.php.format_date_iso = true;

        let result = extract_data_grid_selection(request).expect("PHP extraction");
        assert!(result.text.contains("2026-01-02T03:04:05.123456+08:00"), "{}", result.text);
        assert!(result.text.contains("not a date"));
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.warnings[0].code, DataGridExtractWarningCode::PhpDateNotIso);
    }

    #[test]
    fn php_request_accepts_the_frontend_camel_case_date_option() {
        let request: crate::data_grid_extractors::DataGridExtractRequest = serde_json::from_value(json!({
            "version": 1,
            "extractor": "php",
            "columns": [],
            "selectedColumnIndexes": [],
            "rows": [],
            "selectionKind": "rows",
            "options": {
                "dsv": {
                    "columnSeparator": ",",
                    "rowSeparator": "\n",
                    "nullText": "",
                    "quote": "\"",
                    "quotePolicy": "minimal",
                    "quoteNumericStrings": false,
                    "includeColumnHeader": false,
                    "includeRowHeader": false,
                    "headerPosition": "legacy",
                    "headerFormat": "name",
                    "headerCase": "preserve",
                    "escapeFormulas": false,
                    "lineFeedEscapeString": "",
                    "arrayFormat": "preserve",
                    "formatNumbers": "inherit"
                },
                "sql": {
                    "skipComputedColumns": true,
                    "skipGeneratedColumns": true,
                    "insertMode": "merged",
                    "primaryKeyMode": "include",
                    "includeDatabaseName": false,
                    "quoteIdentifiers": true,
                    "temporalFormat": "native"
                },
                "json": { "pretty": true, "camelCaseFieldNames": false, "valuesOnly": false },
                "dbunit": {
                    "tableName": "",
                    "upperCaseTableName": true,
                    "upperCaseColumnNames": true,
                    "includeNullValues": true,
                    "nullValueString": "[NULL]"
                },
                "php": {
                    "arraySyntax": "short",
                    "quoteChar": "\"",
                    "formatDateIso": true,
                    "rowDelimiter": "\n",
                    "variableName": ""
                },
                "valueFormat": "default"
            }
        }))
        .expect("frontend PHP options deserialize");

        assert!(request.options.php.format_date_iso);
    }
}
