use super::{quote_string_literal, should_copy_data, DatabaseType, TransferMode, TransferRequest};

const LITERAL_CHUNK_BYTES: usize = 16_000;

pub(super) fn map_column_type(source_type: &str, source_db: &DatabaseType) -> Option<String> {
    let normalized = source_type.trim().to_ascii_lowercase();
    let type_name = normalized.split('(').next().unwrap_or("").trim();
    let base = match type_name {
        "character varying" => "varchar",
        "character large object" => "clob",
        "binary varying" => "varbinary",
        "binary large object" => "blob",
        _ => type_name.split(' ').next().unwrap_or(""),
    };
    let parameters = normalized.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(value, _)| value);
    let unsigned = normalized.split_whitespace().any(|part| part == "unsigned");
    if super::is_sqlite_transfer_dialect(source_db) && normalized.contains("int") {
        return Some("BIGINT".to_string());
    }
    let mapped = match base {
        "tinyint" => "SMALLINT".to_string(),
        "smallint" if unsigned => "INTEGER".to_string(),
        "int" | "integer" if unsigned => "BIGINT".to_string(),
        "bigint" if unsigned => "DECIMAL(20,0)".to_string(),
        "bigserial" => "BIGINT".to_string(),
        "smallserial" => "SMALLINT".to_string(),
        "datetime" | "datetime2" | "smalldatetime" => match parameters {
            Some(precision) => format!("TIMESTAMP({precision})"),
            None => "TIMESTAMP".to_string(),
        },
        "bit" if *source_db == DatabaseType::SqlServer => "BOOLEAN".to_string(),
        "bit" | "varbit" => "CLOB".to_string(),
        "varchar" | "nvarchar" | "varchar2" => match parameters.and_then(|length| length.trim().parse::<u64>().ok()) {
            Some(length) if (1..=32672).contains(&length) => format!("VARCHAR({length})"),
            _ => "CLOB".to_string(),
        },
        "clob" => "CLOB".to_string(),
        "varbinary" | "blob" => "BLOB".to_string(),
        "decimal" | "numeric" | "number" => match parameters {
            Some(parameters) => {
                let precision = parameters.split(',').next()?.trim().parse::<u32>().ok()?;
                if precision > 31 {
                    "CLOB".to_string()
                } else {
                    format!("DECIMAL({parameters})")
                }
            }
            None => "CLOB".to_string(),
        },
        _ => return None,
    };
    Some(mapped)
}

pub(super) fn numeric_literal(value: &str, column_type: Option<&str>) -> String {
    let normalized = column_type.unwrap_or("").trim().to_ascii_lowercase();
    let base = normalized.split('(').next().unwrap_or("").trim();
    if matches!(base, "decimal" | "numeric" | "number") {
        let precision = normalized
            .split_once('(')
            .and_then(|(_, parameters)| parameters.split([',', ')']).next())
            .and_then(|precision| precision.trim().parse::<u32>().ok());
        if precision.is_none_or(|precision| precision > 31) {
            return quote_string_literal(value);
        }
    }
    value.to_string()
}

pub(super) fn string_literal(value: &str, column_type: Option<&str>) -> String {
    if column_type.is_some_and(super::is_binary_transfer_column_type) {
        if let Some(hex) = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")) {
            if hex.len() % 2 == 0 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                if hex.len() <= LITERAL_CHUNK_BYTES {
                    return format!("BX'{hex}'");
                }
                return hex
                    .as_bytes()
                    .chunks(LITERAL_CHUNK_BYTES)
                    .map(|chunk| format!("BLOB(BX'{}')", std::str::from_utf8(chunk).expect("validated hexadecimal")))
                    .collect::<Vec<_>>()
                    .join(" || ");
            }
        }
    }
    if value.len() <= LITERAL_CHUNK_BYTES {
        return quote_string_literal(value);
    }
    let mut chunks = Vec::new();
    let mut remaining = value;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(LITERAL_CHUNK_BYTES);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(format!("CLOB({})", quote_string_literal(&remaining[..end])));
        remaining = &remaining[end..];
    }
    chunks.join(" || ")
}

pub(super) fn validate_request(request: &TransferRequest) -> Result<(), String> {
    if request.drop_target_before_create {
        return Err("DB2 transfer does not support rebuilding target tables".to_string());
    }
    if should_copy_data(&request.content) && request.mode == TransferMode::Upsert {
        return Err("DB2 transfer does not support upsert; choose append or overwrite".to_string());
    }
    Ok(())
}

pub(super) fn generated_columns_sql(schema: &str, table: &str, columns: &[String]) -> String {
    let schema = if schema.trim().is_empty() { "CURRENT SCHEMA".to_string() } else { quote_string_literal(schema) };
    let columns = columns.iter().map(|column| quote_string_literal(column)).collect::<Vec<_>>().join(", ");
    format!(
        "SELECT COLNAME FROM SYSCAT.COLUMNS WHERE TABSCHEMA = {schema} AND TABNAME = {} AND GENERATED = 'A' AND COLNAME IN ({columns})",
        quote_string_literal(table)
    )
}

pub(super) fn validate_generated_columns(rows: &[Vec<serde_json::Value>]) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let columns = rows.iter().filter_map(|row| row.first()?.as_str()).collect::<Vec<_>>().join(", ");
    Err(format!(
        "DB2 transfer cannot write GENERATED ALWAYS target columns ({columns}); target data has not been cleared"
    ))
}

#[cfg(test)]
#[path = "db2_tests.rs"]
mod tests;
