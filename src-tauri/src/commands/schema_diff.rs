#[tauri::command]
pub fn prepare_schema_diff(
    options: dbx_core::schema_diff::SchemaDiffPreparationOptions,
) -> Result<dbx_core::schema_diff::SchemaDiffPreparation, String> {
    Ok(dbx_core::schema_diff::prepare_schema_diff(options))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_sql(
    diffs: Vec<dbx_core::schema_diff::TableDiff>,
    function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    database_type: dbx_core::models::connection::DatabaseType,
    target_schema: Option<String>,
    cascade_delete: Option<bool>,
) -> Result<String, String> {
    Ok(dbx_core::schema_diff::generate_schema_sync_sql(
        &diffs,
        function_diffs.as_deref().unwrap_or_default(),
        sequence_diffs.as_deref().unwrap_or_default(),
        rule_diffs.as_deref().unwrap_or_default(),
        owner_diffs.as_deref().unwrap_or_default(),
        database_type,
        target_schema.as_deref(),
        cascade_delete.unwrap_or(false),
    ))
}
