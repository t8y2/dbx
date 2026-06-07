#[tauri::command]
pub fn prepare_schema_diff(
    options: dbx_core::schema_diff::SchemaDiffPreparationOptions,
) -> Result<dbx_core::schema_diff::SchemaDiffPreparation, String> {
    Ok(dbx_core::schema_diff::prepare_schema_diff(options))
}

#[tauri::command]
pub fn generate_schema_sync_sql(
    diffs: Vec<dbx_core::schema_diff::TableDiff>,
    database_type: dbx_core::models::connection::DatabaseType,
    target_schema: Option<String>,
) -> Result<String, String> {
    Ok(dbx_core::schema_diff::generate_schema_sync_sql(&diffs, database_type, target_schema.as_deref()))
}
