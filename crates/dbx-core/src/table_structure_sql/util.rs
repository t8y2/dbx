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
        StructureDialect::Mysql | StructureDialect::ManticoreSearch | StructureDialect::Questdb => {
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

pub(super) fn clean(value: &str) -> String {
    value.trim().to_string()
}

pub(super) fn is_protected_manticore_id_column(dialect: StructureDialect, column_name: &str) -> bool {
    dialect == StructureDialect::ManticoreSearch && column_name.trim().eq_ignore_ascii_case("id")
}

pub(super) fn is_temporal_type_for_default(dialect: StructureDialect, base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    match dialect {
        StructureDialect::Mysql => matches!(normalized.as_str(), "date" | "datetime" | "timestamp" | "time" | "year"),
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

pub(super) fn format_default_for_sql(dialect: StructureDialect, data_type: &str, default_value: &str) -> String {
    if default_value.is_empty() {
        return String::new();
    }
    let base_type = data_type.split('(').next().unwrap_or(data_type).trim();
    if is_temporal_type_for_default(dialect, base_type) && !is_temporal_expression(default_value) {
        quote_string(default_value)
    } else {
        default_value.to_string()
    }
}

pub(super) fn normalize_default(value: Option<&String>) -> String {
    let trimmed = value.map(|value| value.trim()).unwrap_or("");
    if trimmed.eq_ignore_ascii_case("null") {
        String::new()
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
