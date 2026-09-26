use serde_json::Value;

use super::*;
use crate::models::connection::DatabaseType;

pub(super) fn build_neo4j_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_meta.table_name);
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
                Some(format!(
                    "n.{} = {}",
                    quote_ident(Some(DatabaseType::Neo4j), column),
                    format_grid_sql_literal(value, Some(DatabaseType::Neo4j), None)
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        statements
            .push(format!("MATCH (n:{label}) WHERE {} SET {sets};", neo4j_element_id_predicate(&options.columns, row)));
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        statements.push(format!(
            "MATCH (n:{label}) WHERE {} DETACH DELETE n;",
            neo4j_element_id_predicate(&options.columns, row)
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
                Some(format!(
                    "{}: {}",
                    quote_ident(Some(DatabaseType::Neo4j), column),
                    format_grid_sql_literal(value, Some(DatabaseType::Neo4j), None)
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(if props.is_empty() {
            format!("CREATE (n:{label});")
        } else {
            format!("CREATE (n:{label} {{{props}}});")
        });
    }

    statements
}

pub(super) fn build_neo4j_data_grid_rollback_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let label = quote_ident(Some(DatabaseType::Neo4j), &options.table_meta.table_name);
    let mut statements = Vec::new();

    for row in &options.new_rows {
        let where_clause = neo4j_row_property_where(&options.columns, row);
        statements.push(if where_clause.is_empty() {
            format!("MATCH (n:{label}) DETACH DELETE n;")
        } else {
            format!("MATCH (n:{label}) WHERE {where_clause} DETACH DELETE n;")
        });
    }

    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
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
                Some(format!(
                    "{}: {}",
                    quote_ident(Some(DatabaseType::Neo4j), column),
                    format_grid_sql_literal(value, Some(DatabaseType::Neo4j), None)
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(if props.is_empty() {
            format!("CREATE (n:{label});")
        } else {
            format!("CREATE (n:{label} {{{props}}});")
        });
    }

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
                Some(format!(
                    "n.{} = {}",
                    quote_ident(Some(DatabaseType::Neo4j), column),
                    format_grid_sql_literal(
                        row.get(*column_index).unwrap_or(&Value::Null),
                        Some(DatabaseType::Neo4j),
                        None
                    )
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        statements
            .push(format!("MATCH (n:{label}) WHERE {} SET {sets};", neo4j_element_id_predicate(&options.columns, row)));
    }

    statements
}

fn neo4j_element_id_predicate(columns: &[String], row: &[Value]) -> String {
    let index = columns.iter().position(|column| column == DBX_NEO4J_ELEMENT_ID_COLUMN).unwrap_or(usize::MAX);
    format!(
        "elementId(n) = {}",
        format_grid_sql_literal(row.get(index).unwrap_or(&Value::Null), Some(DatabaseType::Neo4j), None)
    )
}

fn neo4j_row_property_where(columns: &[String], row: &[Value]) -> String {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            if is_neo4j_element_id(Some(DatabaseType::Neo4j), Some(column)) {
                return None;
            }
            let value = row.get(index).unwrap_or(&Value::Null);
            let ident = format!("n.{}", quote_ident(Some(DatabaseType::Neo4j), column));
            if value.is_null() {
                Some(format!("{ident} IS NULL"))
            } else {
                Some(format!("{ident} = {}", format_grid_sql_literal(value, Some(DatabaseType::Neo4j), None)))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}
