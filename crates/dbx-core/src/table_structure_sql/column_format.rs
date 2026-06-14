use super::dialect::{is_oracle_like, StructureDialect};
use super::types::EditableStructureColumn;
use super::util::{clean, format_default_for_sql, normalize_default, quote_ident, quote_string};

pub(super) fn column_definition(dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    let data_type = column_data_type(dialect, column);
    let mut parts = vec![quote_ident(dialect, &column.name), data_type];
    if !column.is_nullable && !is_oracle_like(dialect) && dialect != StructureDialect::ClickHouse {
        parts.push("NOT NULL".to_string());
    }
    if let Some(extra_clause) = column_extra_clause(dialect, column) {
        parts.push(extra_clause);
    }
    let default_value = normalize_default(Some(&column.default_value));
    if !default_value.is_empty() {
        parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
    }
    if let Some(on_update) = column.extra.as_ref().and_then(|e| e.on_update_current_timestamp).filter(|v| *v) {
        if on_update && dialect == StructureDialect::Mysql {
            parts.push("ON UPDATE CURRENT_TIMESTAMP".to_string());
        }
    }
    if dialect == StructureDialect::Mysql && !clean(&column.comment).is_empty() {
        parts.push(format!("COMMENT {}", quote_string(&clean(&column.comment))));
    }
    parts.join(" ")
}

pub(super) fn column_extra_clause(dialect: StructureDialect, column: &EditableStructureColumn) -> Option<String> {
    let extra = column.extra.as_ref()?;
    match dialect {
        StructureDialect::Mysql => {
            let mut clauses = Vec::new();
            if extra.auto_increment.unwrap_or(false) {
                clauses.push("AUTO_INCREMENT".to_string());
            }
            if clauses.is_empty() {
                None
            } else {
                Some(clauses.join(" "))
            }
        }
        StructureDialect::Postgres | StructureDialect::H2 => {
            if let Some(identity) = &extra.identity {
                let generation = identity.generation.as_deref().unwrap_or("BY DEFAULT");
                let mut clause = format!("GENERATED {generation} AS IDENTITY");
                if identity.seed.is_some() || identity.increment.is_some() {
                    let start = identity.seed.unwrap_or(1);
                    let inc = identity.increment.unwrap_or(1);
                    clause.push_str(&format!(" (START WITH {start} INCREMENT BY {inc})"));
                }
                Some(clause)
            } else {
                None
            }
        }
        StructureDialect::SqlServer => {
            if extra.auto_increment.unwrap_or(false) || extra.identity.is_some() {
                let seed = extra.identity.as_ref().and_then(|i| i.seed).unwrap_or(1);
                let increment = extra.identity.as_ref().and_then(|i| i.increment).unwrap_or(1);
                Some(format!("IDENTITY({seed}, {increment})"))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn column_data_type(dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    if dialect == StructureDialect::ClickHouse {
        return clickhouse_column_type(column);
    }
    if dialect == StructureDialect::ManticoreSearch {
        return manticore_column_type(column);
    }
    normalize_column_data_type(dialect, &column.data_type)
}

fn manticore_column_type(column: &EditableStructureColumn) -> String {
    let data_type = normalize_column_data_type(StructureDialect::ManticoreSearch, &column.data_type);
    let normalized = data_type.trim().to_ascii_lowercase();
    if normalized == "json" {
        let Some(extra) = column.extra.as_ref() else {
            return data_type;
        };
        if extra.manticore_secondary_index.unwrap_or(false) {
            return format!("{data_type} secondary_index='1'");
        }
        return data_type;
    }
    if !matches!(normalized.as_str(), "text" | "string") {
        return data_type;
    }

    let Some(extra) = column.extra.as_ref() else {
        return data_type;
    };
    let mut parts = vec![data_type];
    if extra.manticore_stored.unwrap_or(false) {
        parts.push("stored".to_string());
    }
    if extra.manticore_attribute.unwrap_or(false) {
        parts.push("attribute".to_string());
    }
    if extra.manticore_indexed.unwrap_or(false) {
        parts.push("indexed".to_string());
    }
    parts.join(" ")
}

pub(super) fn normalize_column_data_type(dialect: StructureDialect, data_type: &str) -> String {
    let trimmed = data_type.trim();
    let Some(open_index) = trimmed.find('(') else {
        return trimmed.to_string();
    };
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }

    let base_type = trimmed[..open_index].trim();
    let params = trimmed[open_index + 1..trimmed.len() - 1].trim();
    if base_type.is_empty() || params.is_empty() {
        return trimmed.to_string();
    }

    if is_temporal_precision_type(dialect, base_type) {
        return if is_valid_temporal_precision(params, dialect) {
            format!("{base_type}({params})")
        } else {
            base_type.to_string()
        };
    }

    trimmed.to_string()
}

pub(super) fn is_temporal_precision_type(dialect: StructureDialect, base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    match dialect {
        StructureDialect::Mysql => matches!(normalized.as_str(), "time" | "datetime" | "timestamp"),
        StructureDialect::Postgres => matches!(
            normalized.as_str(),
            "time"
                | "time without time zone"
                | "time with time zone"
                | "timestamp"
                | "timestamp without time zone"
                | "timestamp with time zone"
        ),
        StructureDialect::SqlServer => matches!(normalized.as_str(), "time" | "datetime2" | "datetimeoffset"),
        StructureDialect::Oracle => {
            matches!(normalized.as_str(), "timestamp" | "timestamp with time zone" | "timestamp with local time zone")
        }
        _ => false,
    }
}

pub(super) fn is_valid_temporal_precision(params: &str, dialect: StructureDialect) -> bool {
    let Ok(value) = params.parse::<u8>() else {
        return false;
    };
    let max = if dialect == StructureDialect::Oracle { 9 } else { 6 };
    value <= max && params == value.to_string()
}

pub(super) fn clickhouse_column_type(column: &EditableStructureColumn) -> String {
    let data_type = column.data_type.trim();
    if column.is_nullable {
        if data_type.to_ascii_lowercase().starts_with("nullable") {
            data_type.to_string()
        } else {
            format!("Nullable({data_type})")
        }
    } else {
        unwrap_clickhouse_nullable_type(data_type)
    }
}

pub(super) fn unwrap_clickhouse_nullable_type(data_type: &str) -> String {
    let trimmed = data_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("nullable(") && trimmed.ends_with(')') {
        trimmed[trimmed.find('(').unwrap_or(0) + 1..trimmed.len() - 1].trim().to_string()
    } else {
        trimmed.to_string()
    }
}
