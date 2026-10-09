use super::*;
use crate::schema_diff::{comparable_oracle_routine, FunctionDiff};

fn literal(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }

async fn dictionary_query(state: &AppState, connection: &str, database: &str, schema: &str, sql: &str) -> Result<db::QueryResult, String> {
    let config = connection_config(state, connection).await.ok_or("Connection not found")?;
    if !crate::schema_diff::is_oracle_routine_database(config.db_type) {
        return Err("Routine compilation validation requires Oracle or OceanBase Oracle".to_string());
    }
    let pool = state.get_or_create_metadata_pool_for_session(connection, Some(database), None).await?;
    crate::query::do_execute(state, &pool, db::mysql::MySqlQueryDialect::for_connection(config.db_type, config.driver_profile.as_deref()), Some(database), sql, Some(schema), None, QueryExecutionOptions::default()).await
}

fn cell(row: &[serde_json::Value], index: usize) -> String {
    row.get(index).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
}

async fn status(state: &AppState, connection: &str, database: &str, schema: &str, name: &str, kind: &str) -> Result<Option<String>, String> {
    let result = dictionary_query(state, connection, database, schema, &format!("SELECT STATUS FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE = {}", literal(schema), literal(name), literal(kind))).await?;
    Ok(result.rows.first().map(|row| cell(row, 0)))
}

pub(super) async fn list_routines(state: &AppState, connection: &str, database: &str, schema: &str) -> Result<Vec<db::FunctionInfo>, String> {
    if schema.is_empty() { return Err("An explicit source or target schema is required for routine comparison".to_string()); }
    let kinds = vec!["PROCEDURE".to_string(), "FUNCTION".to_string()];
    let objects = list_objects_core(state, connection, database, schema, None, None, None, Some(&kinds), None).await?;
    let mut routines = Vec::with_capacity(objects.len());
    for object in objects {
        let (kind, source_kind) = schema_diff_routine_kind(&object.object_type).ok_or("Unexpected routine object type")?;
        let source = get_object_source_core(state, connection, database, schema, &object.name, source_kind, object.signature.as_deref(), None).await
            .map_err(|error| format!("Cannot read {schema}.{} ({kind}): {error}", object.name))?;
        if source.source.trim().is_empty() { return Err(format!("Complete source is unavailable for {schema}.{} ({kind}); comparison stopped", object.name)); }
        let object_status = status(state, connection, database, schema, &object.name, kind).await?
            .ok_or_else(|| format!("{schema}.{} disappeared during metadata collection", object.name))?;
        let dependencies = dictionary_query(state, connection, database, schema, &format!("SELECT REFERENCED_OWNER, REFERENCED_NAME FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME", literal(schema), literal(&object.name), literal(kind))).await?;
        let dependencies = dependencies.rows.iter().map(|row| format!("\"{}\".\"{}\"", cell(row, 0).replace('"', "\"\""), cell(row, 1).replace('"', "\"\""))).collect();
        routines.push(db::FunctionInfo { name: object.name, function_type: kind.to_string(), data_type: String::new(), definition: source.source, arguments: object.signature.unwrap_or_default(), schema: Some(schema.to_string()), status: Some(object_status), dependencies });
    }
    Ok(routines)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineValidation {
    pub name: String,
    pub routine_type: String,
    pub success: bool,
    pub message: String,
}

pub async fn validate_schema_diff_routines(state: &AppState, connection: &str, database: &str, schema: &str, expected: &[FunctionDiff]) -> Result<Vec<RoutineValidation>, String> {
    if schema.is_empty() { return Err("An explicit target schema is required".to_string()); }
    let mut results = Vec::with_capacity(expected.len());
    for diff in expected {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() }.ok_or("Routine metadata is missing")?;
        let (kind, source_kind) = schema_diff_routine_kind(&info.function_type).ok_or("Unsupported routine type")?;
        let current_status = status(state, connection, database, schema, &diff.name, kind).await?;
        let result = if diff.diff_type == "removed" {
            if current_status.is_none() { Ok(()) } else { Err("The dropped routine still exists".to_string()) }
        } else if current_status.as_deref() != Some("VALID") {
            let errors = dictionary_query(state, connection, database, schema, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY SEQUENCE", literal(schema), literal(&diff.name), literal(kind))).await?;
            Err(format!("Compilation status: {}. {}", current_status.as_deref().unwrap_or("MISSING"), errors.rows.iter().map(|row| cell(row, 2)).collect::<Vec<_>>().join("\n")))
        } else {
            let actual = get_object_source_core(state, connection, database, schema, &diff.name, source_kind, None, None).await?;
            if actual.source.trim().is_empty() || comparable_oracle_routine(&actual.source) != comparable_oracle_routine(&info.definition) {
                Err("The complete source read back from the target differs from the selected definition".to_string())
            } else { Ok(()) }
        };
        results.push(RoutineValidation { name: diff.name.clone(), routine_type: kind.to_string(), success: result.is_ok(), message: result.err().unwrap_or_else(|| "Dictionary status and complete source verified".to_string()) });
    }
    Ok(results)
}
