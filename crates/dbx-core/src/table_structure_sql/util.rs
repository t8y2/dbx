use super::dialect::StructureDialect;
use super::types::EditableStructureColumn;

pub(super) fn qualified_table(dialect: StructureDialect, schema: Option<&str>, table_name: &str) -> String {
    if matches!(
        dialect,
        StructureDialect::Postgres
            | StructureDialect::Oracle
            | StructureDialect::SqlServer
            | StructureDialect::H2
            | StructureDialect::Informix
    ) && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        return format!("{}.{}", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, table_name));
    }
    quote_ident(dialect, table_name)
}

pub(super) fn quote_ident(dialect: StructureDialect, name: &str) -> String {
    match dialect {
        StructureDialect::Mysql
        | StructureDialect::Doris
        | StructureDialect::ManticoreSearch
        | StructureDialect::Questdb => {
            format!("`{}`", name.replace('`', "``"))
        }
        StructureDialect::SqlServer => format!("[{}]", name.replace(']', "]]")),
        StructureDialect::Informix if is_simple_informix_identifier(name) => name.to_string(),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn is_simple_informix_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

pub(super) fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn is_sql_string_literal(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(inner) = trimmed.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')) else {
        return false;
    };

    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' && chars.next_if_eq(&'\'').is_none() {
            return false;
        }
    }
    true
}

fn postgres_string_default_literal(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    let inner = trimmed.strip_prefix('\'')?;
    let mut literal_end = 1;
    let mut chars = inner.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if ch == '\'' {
            if chars.next_if(|(_, next)| *next == '\'').is_some() {
                continue;
            }
            literal_end += index + ch.len_utf8();
            break;
        }
    }
    if literal_end == 1 {
        return None;
    }

    let literal = &trimmed[..literal_end];
    if !is_sql_string_literal(literal) {
        return None;
    }
    let cast_type = trimmed[literal_end..].trim().strip_prefix("::")?.trim();
    if is_postgres_textual_cast_type(cast_type) {
        Some(literal)
    } else {
        None
    }
}

fn is_postgres_textual_cast_type(value: &str) -> bool {
    let normalized =
        value.trim().trim_matches('"').split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    let base_type = normalized.split('(').next().unwrap_or(&normalized).trim();
    matches!(
        base_type,
        "char"
            | "character"
            | "varchar"
            | "character varying"
            | "text"
            | "bpchar"
            | "name"
            | "json"
            | "jsonb"
            | "xml"
            | "bytea"
            | "uuid"
    )
}

pub(super) fn clean(value: &str) -> String {
    value.trim().to_string()
}

pub(super) fn is_protected_manticore_id_column(dialect: StructureDialect, column_name: &str) -> bool {
    dialect == StructureDialect::ManticoreSearch && column_name.trim().eq_ignore_ascii_case("id")
}

pub(super) fn is_temporal_type_for_default(dialect: StructureDialect, base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    match dialect {
        StructureDialect::Mysql | StructureDialect::Doris => {
            matches!(normalized.as_str(), "date" | "datetime" | "timestamp" | "time" | "year")
        }
        StructureDialect::Postgres => {
            matches!(
                normalized.as_str(),
                "date"
                    | "time"
                    | "time without time zone"
                    | "time with time zone"
                    | "timestamp"
                    | "timestamp without time zone"
                    | "timestamp with time zone"
                    | "interval"
                    | "timetz"
                    | "timestamptz"
            ) || normalized.starts_with("interval ")
        }
        StructureDialect::SqlServer => matches!(
            normalized.as_str(),
            "date" | "time" | "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset"
        ),
        StructureDialect::Oracle => matches!(
            normalized.as_str(),
            "date"
                | "timestamp"
                | "timestamp with time zone"
                | "timestamp with local time zone"
                | "interval year to month"
                | "interval day to second"
        ),
        StructureDialect::H2 => {
            matches!(
                normalized.as_str(),
                "date"
                    | "time"
                    | "time without time zone"
                    | "time with time zone"
                    | "timestamp"
                    | "timestamp without time zone"
                    | "timestamp with time zone"
            ) || normalized.starts_with("interval ")
        }
        StructureDialect::ClickHouse => {
            matches!(normalized.as_str(), "date" | "date32" | "datetime" | "datetime64")
        }
        StructureDialect::Sqlite => {
            matches!(normalized.as_str(), "date" | "datetime" | "timestamp" | "time")
        }
        StructureDialect::Informix => matches!(normalized.as_str(), "date" | "datetime"),
        _ => false,
    }
}

pub(super) fn is_temporal_expression(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains('(') || trimmed.contains(')') {
        return true;
    }
    trimmed.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
}

pub(super) fn is_string_type_for_default(dialect: StructureDialect, base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    match dialect {
        StructureDialect::Mysql | StructureDialect::Doris => matches!(
            normalized.as_str(),
            "char"
                | "varchar"
                | "tinytext"
                | "text"
                | "mediumtext"
                | "longtext"
                | "binary"
                | "varbinary"
                | "tinyblob"
                | "blob"
                | "mediumblob"
                | "longblob"
                | "enum"
                | "set"
                | "json"
                | "nvarchar"
                | "nchar"
                | "long"
        ),
        StructureDialect::Postgres => matches!(
            normalized.as_str(),
            "char"
                | "character"
                | "varchar"
                | "character varying"
                | "text"
                | "bpchar"
                | "name"
                | "json"
                | "jsonb"
                | "xml"
                | "bytea"
                | "uuid"
        ),
        StructureDialect::SqlServer => matches!(
            normalized.as_str(),
            "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "xml" | "uniqueidentifier" | "sysname"
        ),
        StructureDialect::Oracle => matches!(
            normalized.as_str(),
            "char" | "nchar" | "varchar2" | "nvarchar2" | "clob" | "nclob" | "long" | "raw" | "long raw" | "bfile"
        ),
        StructureDialect::H2 => matches!(
            normalized.as_str(),
            "char"
                | "character"
                | "varchar"
                | "character varying"
                | "text"
                | "clob"
                | "binary"
                | "varbinary"
                | "blob"
                | "uuid"
                | "json"
        ),
        StructureDialect::ClickHouse => matches!(normalized.as_str(), "string" | "fixedstring" | "uuid" | "json"),
        StructureDialect::Sqlite => {
            matches!(normalized.as_str(), "text" | "varchar" | "char" | "character" | "clob" | "nvarchar" | "nchar")
        }
        StructureDialect::Informix => matches!(
            normalized.as_str(),
            "char"
                | "character"
                | "varchar"
                | "character varying"
                | "nvarchar"
                | "nchar"
                | "text"
                | "clob"
                | "lvarchar"
                | "byte"
                | "blob"
        ),
        _ => false,
    }
}

pub(super) fn format_default_for_sql(dialect: StructureDialect, data_type: &str, default_value: &str) -> String {
    if default_value.is_empty() {
        return String::new();
    }
    let base_type = data_type.split('(').next().unwrap_or(data_type).trim();
    if is_temporal_type_for_default(dialect, base_type) {
        if is_temporal_expression(default_value) {
            return default_value.to_string();
        }
        return quote_string(default_value);
    }
    if is_string_type_for_default(dialect, base_type) {
        // Only skip quoting for function-call expressions like `gen_random_uuid()`.
        // Simple identifiers like `CURRENT_TIMESTAMP` are not valid defaults for string columns.
        if is_sql_string_literal(default_value)
            || (dialect == StructureDialect::Postgres && postgres_string_default_literal(default_value).is_some())
            || default_value.contains('(')
            || default_value.contains(')')
        {
            return default_value.to_string();
        }
        return quote_string(default_value);
    }
    default_value.to_string()
}

pub(super) fn normalize_default(value: Option<&String>) -> String {
    let trimmed = value.map(|value| value.trim()).unwrap_or("");
    if trimmed.eq_ignore_ascii_case("null") {
        String::new()
    } else if let Some(literal) = postgres_string_default_literal(trimmed) {
        literal.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn original_default(column: &EditableStructureColumn) -> String {
    normalize_default(column.original.as_ref().and_then(|original| original.column_default.as_ref()))
}

pub(super) fn original_comment(column: &EditableStructureColumn) -> String {
    clean(column.original.as_ref().and_then(|original| original.comment.as_deref()).unwrap_or(""))
}
