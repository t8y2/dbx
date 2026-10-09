use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSchemaSyncSqlRequest {
    pub source_database_type: Option<dbx_core::models::connection::DatabaseType>,
    pub source_schema: Option<String>,
    pub diffs: Vec<dbx_core::schema_diff::TableDiff>,
    pub function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    pub sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    pub rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    pub owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    pub database_type: dbx_core::models::connection::DatabaseType,
    pub target_schema: Option<String>,
    pub cascade_delete: Option<bool>,
    pub source_dialect: Option<String>,
    pub field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    pub enable_rollback: Option<bool>,
}

pub async fn generate_schema_sync_plan(
    Json(req): Json<GenerateSchemaSyncSqlRequest>,
) -> Json<dbx_core::schema_diff::SchemaSyncSqlPlan> {
    let mut plan = dbx_core::schema_diff::generate_schema_sync_sql_plan(
        &req.diffs,
        req.function_diffs.as_deref().unwrap_or_default(),
        req.sequence_diffs.as_deref().unwrap_or_default(),
        req.rule_diffs.as_deref().unwrap_or_default(),
        req.owner_diffs.as_deref().unwrap_or_default(),
        req.database_type,
        req.target_schema.as_deref(),
        req.cascade_delete.unwrap_or(false),
        req.source_dialect.as_deref().and_then(dbx_core::sql_dialect::descriptor::DialectKind::from_label),
        req.field_mappings.as_deref().unwrap_or(&[]),
        req.enable_rollback.unwrap_or(false),
    );
    dbx_core::schema_diff::add_oracle_routines_to_plan(&mut plan, req.function_diffs.as_deref().unwrap_or_default(), req.database_type, req.target_schema.as_deref(), req.source_database_type, req.source_schema.as_deref());
    Json(plan)
}

pub async fn prepare_schema_diff(
    Json(options): Json<dbx_core::schema_diff::SchemaDiffPreparationOptions>,
) -> Json<dbx_core::schema_diff::SchemaDiffPreparation> {
    Json(dbx_core::schema_diff::prepare_schema_diff(options))
}

pub async fn generate_schema_sync_sql(Json(req): Json<GenerateSchemaSyncSqlRequest>) -> Json<String> {
    Json(generate_schema_sync_plan(Json(req)).await.0.sync_sql)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRoutinesRequest {
    connection_id: String,
    database: String,
    schema: String,
    expected: Vec<dbx_core::schema_diff::FunctionDiff>,
}

pub async fn validate_schema_diff_routines(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::WebState>>,
    Json(req): Json<ValidateRoutinesRequest>,
) -> Result<Json<Vec<dbx_core::schema::RoutineValidation>>, crate::error::AppError> {
    let results = dbx_core::schema::validate_schema_diff_routines(&state.app, &req.connection_id, &req.database, &req.schema, &req.expected).await?;
    Ok(Json(results))
}
