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
    source_dialect: Option<dbx_core::sql_dialect::descriptor::DialectKind>,
    field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    source_database_type: Option<dbx_core::models::connection::DatabaseType>,
    source_schema: Option<String>,
) -> Result<String, String> {
    let mut plan = dbx_core::schema_diff::generate_schema_sync_sql_plan(
        &diffs,
        function_diffs.as_deref().unwrap_or_default(),
        sequence_diffs.as_deref().unwrap_or_default(),
        rule_diffs.as_deref().unwrap_or_default(),
        owner_diffs.as_deref().unwrap_or_default(),
        database_type,
        target_schema.as_deref(),
        cascade_delete.unwrap_or(false),
        source_dialect,
        &field_mappings.unwrap_or_default(),
        false,
    );
    dbx_core::schema_diff::add_oracle_routines_to_plan(&mut plan, function_diffs.as_deref().unwrap_or_default(), database_type, target_schema.as_deref(), source_database_type, source_schema.as_deref());
    Ok(plan.sync_sql)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_plan(
    diffs: Vec<dbx_core::schema_diff::TableDiff>,
    function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    database_type: dbx_core::models::connection::DatabaseType,
    target_schema: Option<String>,
    cascade_delete: Option<bool>,
    source_dialect: Option<dbx_core::sql_dialect::descriptor::DialectKind>,
    field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    enable_rollback: Option<bool>,
    source_database_type: Option<dbx_core::models::connection::DatabaseType>,
    source_schema: Option<String>,
) -> Result<dbx_core::schema_diff::SchemaSyncSqlPlan, String> {
    let mut plan = dbx_core::schema_diff::generate_schema_sync_sql_plan(
        &diffs,
        function_diffs.as_deref().unwrap_or_default(),
        sequence_diffs.as_deref().unwrap_or_default(),
        rule_diffs.as_deref().unwrap_or_default(),
        owner_diffs.as_deref().unwrap_or_default(),
        database_type,
        target_schema.as_deref(),
        cascade_delete.unwrap_or(false),
        source_dialect,
        &field_mappings.unwrap_or_default(),
        enable_rollback.unwrap_or(false),
    );
    dbx_core::schema_diff::add_oracle_routines_to_plan(&mut plan, function_diffs.as_deref().unwrap_or_default(), database_type, target_schema.as_deref(), source_database_type, source_schema.as_deref());
    Ok(plan)
}

#[tauri::command]
pub async fn validate_schema_diff_routines(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    expected: Vec<dbx_core::schema_diff::FunctionDiff>,
) -> Result<Vec<dbx_core::schema::RoutineValidation>, String> {
    dbx_core::schema::validate_schema_diff_routines(&state, &connection_id, &database, &schema, &expected).await
}
