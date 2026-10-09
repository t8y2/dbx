use serde_json::Value;

use super::*;
use crate::models::connection::DatabaseType;
use crate::sql_dialect::{neo4j_element_id_function, NEO4J_LEGACY_ELEMENT_ID_FUNCTION};

pub(super) fn build_neo4j_data_grid_save_statements(
    options: &DataGridSaveStatementOptions,
) -> Result<Vec<String>, String> {
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_meta.table_name);
    let element_id_function = neo4j_element_id_function(options.server_version.as_deref());
    let mut statements = Vec::new();

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let sets = changes
            .iter()
            .filter_map(|(column_index, value)| {
                let column = options.columns.get(*column_index)?;
                if is_neo4j_element_id(Some(DatabaseType::Neo4j), Some(column)) {
                    return None;
                }
                Some(
                    property_literal(options, column, value)
                        .map(|literal| format!("n.{} = {}", quote_ident(Some(DatabaseType::Neo4j), column), literal)),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        statements.push(format!(
            "MATCH (n:{label}) WHERE {} SET {sets};",
            neo4j_element_id_predicate(&options.columns, row, element_id_function)
        ));
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        statements.push(format!(
            "MATCH (n:{label}) WHERE {} DETACH DELETE n;",
            neo4j_element_id_predicate(&options.columns, row, element_id_function)
        ));
    }

    for row in &options.new_rows {
        let props = options
            .columns
            .iter()
            .enumerate()
            .filter(|(_, column)| !is_neo4j_element_id(Some(DatabaseType::Neo4j), Some(column)))
            .filter_map(|(index, column)| {
                let value = row.get(index).unwrap_or(&Value::Null);
                if value.is_null() {
                    return None;
                }
                Some(
                    property_literal(options, column, value)
                        .map(|literal| format!("{}: {}", quote_ident(Some(DatabaseType::Neo4j), column), literal)),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        statements.push(if props.is_empty() {
            format!("CREATE (n:{label});")
        } else {
            format!("CREATE (n:{label} {{{props}}});")
        });
    }

    Ok(statements)
}

pub(super) fn build_neo4j_data_grid_rollback_statements(
    options: &DataGridSaveStatementOptions,
) -> Result<Vec<String>, String> {
    // Matching inserted properties can delete other nodes, and recreating a
    // detached node cannot restore its identity or relationships.
    if !options.new_rows.is_empty() || !options.deleted_rows.is_empty() {
        return Ok(Vec::new());
    }
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_meta.table_name);
    let element_id_function = neo4j_element_id_function(options.server_version.as_deref());
    let mut statements = Vec::new();

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let sets = changes
            .iter()
            .filter_map(|(column_index, _)| {
                let column = options.columns.get(*column_index)?;
                if is_neo4j_element_id(Some(DatabaseType::Neo4j), Some(column)) {
                    return None;
                }
                Some(
                    property_literal(options, column, row.get(*column_index).unwrap_or(&Value::Null))
                        .map(|literal| format!("n.{} = {}", quote_ident(Some(DatabaseType::Neo4j), column), literal)),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        statements.push(format!(
            "MATCH (n:{label}) WHERE {} SET {sets};",
            neo4j_element_id_predicate(&options.columns, row, element_id_function)
        ));
    }

    Ok(statements)
}

fn neo4j_element_id_predicate(columns: &[String], row: &[Value], element_id_function: &str) -> String {
    let index = columns.iter().position(|column| column == DBX_NEO4J_ELEMENT_ID_COLUMN).unwrap_or(usize::MAX);
    let value = row.get(index).unwrap_or(&Value::Null);
    // The legacy `id()` returns an Integer while a grid cell always carries text. Comparing the two
    // with a quoted literal matches nothing, so a user edit would quietly update zero rows; the
    // identity has to be written as a number there. `elementId()` keeps its string form.
    if element_id_function == NEO4J_LEGACY_ELEMENT_ID_FUNCTION {
        if let Some(identity) = neo4j_legacy_element_id_literal(value) {
            return format!("{element_id_function}(n) = {identity}");
        }
    }
    format!("{element_id_function}(n) = {}", format_grid_sql_literal(value, Some(DatabaseType::Neo4j), None))
}

/// Renders a legacy `id()` value as a Cypher number so it matches the server's Integer. Anything
/// that is not an integral id is left to the caller's normal literal formatting.
fn neo4j_legacy_element_id_literal(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => number.as_i64().map(|identity| identity.to_string()),
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty() && trimmed.chars().all(|character| character.is_ascii_digit()))
                .then(|| trimmed.to_string())
        }
        _ => None,
    }
}

fn property_literal(options: &DataGridSaveStatementOptions, column: &str, value: &Value) -> Result<String, String> {
    // Cypher property names are case-sensitive, unlike relational metadata lookups.
    let data_type = options
        .table_meta
        .columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find(|info| info.name == column)
        .map(|info| info.data_type.as_str())
        .unwrap_or("");
    typed_property_literal(value, data_type)
        .map_err(|error| format!("Cannot save Neo4j property `{column}` ({data_type}): {error}"))
}

fn typed_property_literal(value: &Value, data_type: &str) -> Result<String, &'static str> {
    if value.is_null() {
        return Ok("NULL".to_string());
    }
    let kind = data_type.trim().to_ascii_lowercase();
    if let Some(element_type) = kind.strip_suffix("array").or_else(|| kind.strip_suffix("[]")) {
        let parsed;
        let items = if let Some(items) = value.as_array() {
            items
        } else {
            parsed = serde_json::from_str::<Value>(value.as_str().ok_or("expected a JSON array")?)
                .map_err(|_| "expected a JSON array")?;
            parsed.as_array().ok_or("expected a JSON array")?
        };
        let values = items
            .iter()
            .map(|item| {
                if item.is_null() {
                    return Err("property arrays cannot contain null");
                }
                typed_property_literal(item, element_type)
            })
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(format!("[{}]", values.join(", ")));
    }
    let text = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
    let quoted = || format_grid_sql_literal(&Value::String(text.clone()), Some(DatabaseType::Neo4j), None);
    match kind.as_str() {
        "long" | "integer" | "int" => {
            let number = text.trim().parse::<i64>().map_err(|_| "expected a signed 64-bit integer")?;
            // Keep exact integers out of JavaScript floating-point conversions and
            // support the full signed range, including the minimum integer literal.
            Ok(format!("toInteger('{number}')"))
        }
        "double" | "float" => {
            let number = text.trim().parse::<f64>().map_err(|_| "expected a finite float")?;
            if !number.is_finite() {
                return Err("expected a finite float");
            }
            Ok(format!("toFloat({})", quoted()))
        }
        "boolean" | "bool" => match text.trim().to_ascii_lowercase().as_str() {
            "true" => Ok("true".to_string()),
            "false" => Ok("false".to_string()),
            _ => Err("expected true or false"),
        },
        "string" => {
            if !value.is_string() {
                return Err("expected a string");
            }
            Ok(quoted())
        }
        "date" => Ok(format!("date({})", quoted())),
        "duration" => Ok(format!("duration({})", quoted())),
        // A mixed or unsupported property type must not silently become a string.
        _ => Err("this property type requires an explicit Cypher query"),
    }
}
