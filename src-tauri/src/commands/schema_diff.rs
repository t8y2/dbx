#[tauri::command]
pub async fn prepare_schema_diff(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
    options: dbx_core::schema_diff::SchemaDiffPreparationOptions,
) -> Result<dbx_core::schema_diff::SchemaDiffPreparation, String> {
    dbx_core::schema::prepare_schema_diff_core(&state, options).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_schema_sync_sql(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
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
    routine_endpoints: Option<dbx_core::schema_diff::RoutineEndpoints>,
) -> Result<String, String> {
    let source_objects = function_diffs.as_deref().unwrap_or_default().iter().filter_map(|diff| diff.source.clone()).collect::<Vec<_>>();
    let removed = function_diffs.as_deref().unwrap_or_default().iter().filter(|diff| diff.diff_type == "removed").filter_map(|diff| diff.target.clone()).collect::<Vec<_>>();
    let target_objects = function_diffs.as_deref().unwrap_or_default().iter().filter_map(|diff| diff.target.clone()).collect::<Vec<_>>();
    let context = dbx_core::schema::schema_diff_routine_context(&state, routine_endpoints.as_ref(), source_database_type, database_type, source_schema.as_deref(), target_schema.as_deref(), &source_objects, &removed, &target_objects).await?;
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
    dbx_core::schema_diff::add_oracle_routines_to_plan_with_context(&mut plan, function_diffs.as_deref().unwrap_or_default(), database_type, target_schema.as_deref(), source_database_type, source_schema.as_deref(), context.as_ref());
    Ok(plan.sync_sql)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_schema_sync_plan(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
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
    routine_endpoints: Option<dbx_core::schema_diff::RoutineEndpoints>,
) -> Result<dbx_core::schema_diff::SchemaSyncSqlPlan, String> {
    let source_objects = function_diffs.as_deref().unwrap_or_default().iter().filter_map(|diff| diff.source.clone()).collect::<Vec<_>>();
    let removed = function_diffs.as_deref().unwrap_or_default().iter().filter(|diff| diff.diff_type == "removed").filter_map(|diff| diff.target.clone()).collect::<Vec<_>>();
    let target_objects = function_diffs.as_deref().unwrap_or_default().iter().filter_map(|diff| diff.target.clone()).collect::<Vec<_>>();
    let context = dbx_core::schema::schema_diff_routine_context(&state, routine_endpoints.as_ref(), source_database_type, database_type, source_schema.as_deref(), target_schema.as_deref(), &source_objects, &removed, &target_objects).await?;
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
    dbx_core::schema_diff::add_oracle_routines_to_plan_with_context(&mut plan, function_diffs.as_deref().unwrap_or_default(), database_type, target_schema.as_deref(), source_database_type, source_schema.as_deref(), context.as_ref());
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
