use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;
use dbx_core::query_cancel::RunningTaskMetadata;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteQueryRequest {
    pub connection_id: String,
    pub database: String,
    pub sql: String,
    pub schema: Option<String>,
    pub catalog: Option<String>,
    pub execution_id: Option<String>,
    pub max_rows: Option<usize>,
    pub fetch_size: Option<usize>,
    pub page_size: Option<usize>,
    pub row_offset: Option<usize>,
    pub max_result_bytes: Option<usize>,
    #[serde(default)]
    pub result_key_columns: Vec<String>,
    #[serde(default)]
    pub table_data_preview: bool,
    pub result_session_id: Option<String>,
    pub client_session_id: Option<String>,
    pub timeout_secs: Option<u64>,
    pub use_transaction: Option<bool>,
    pub continue_on_error: Option<bool>,
    pub execution_mode: Option<dbx_core::query::QueryExecutionMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub execution_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub connection_id: String,
    pub database: String,
    pub session_id: String,
    pub catalog: Option<String>,
    pub client_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseClientConnectionSessionRequest {
    pub connection_id: String,
    pub database: String,
    pub catalog: Option<String>,
    pub client_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteBatchRequest {
    pub connection_id: String,
    pub database: String,
    pub statements: Vec<String>,
    pub schema: Option<String>,
    pub catalog: Option<String>,
    pub timeout_secs: Option<u64>,
    pub destructive_confirmed: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSqlReferencesRequest {
    pub sql: String,
    pub dialect: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeEditableQueryRequest {
    pub sql: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindStatementAtCursorRequest {
    pub sql: String,
    pub cursor_pos: usize,
    pub database_type: Option<dbx_core::models::connection::DatabaseType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareQueryPaginationExecutionPlanRequest {
    pub options: dbx_core::query_result_sql::QueryPaginationExecutionPlanOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSortedQuerySqlRequest {
    pub options: dbx_core::query_result_sql::SortedQuerySqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExplainSqlRequest {
    pub options: dbx_core::query_execution_sql::ExplainSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDroppedFilePreviewSqlRequest {
    pub options: dbx_core::query_execution_sql::DroppedFilePreviewSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableSelectSqlRequest {
    pub options: dbx_core::sql_dialect::TableDataSelectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSearchSqlRequest {
    pub options: dbx_core::database_search_sql::DatabaseSearchSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSearchResultWhereRequest {
    pub options: dbx_core::database_search_sql::SearchResultWhereOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRenameObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::RenameObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCreateDatabaseSqlRequest {
    pub options: dbx_core::db_admin_sql::CreateDatabaseSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "duckdb-sidecar")]
pub struct BuildDuckDbAttachDatabaseSqlRequest {
    pub options: dbx_core::db_admin_sql::DuckDbAttachDatabaseSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSqliteAttachDatabaseSqlRequest {
    pub options: dbx_core::db_admin_sql::SqliteAttachDatabaseSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDropObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::DropObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableAdminSqlRequest {
    pub options: dbx_core::db_admin_sql::TableAdminSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDropTableChildObjectSqlRequest {
    pub options: dbx_core::db_admin_sql::DropTableChildObjectSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseNameSqlRequest {
    pub options: dbx_core::db_admin_sql::DatabaseNameSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSchemaNameSqlRequest {
    pub options: dbx_core::db_admin_sql::SchemaNameSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabasePropertyEditSqlRequest {
    pub options: dbx_core::db_admin_sql::DatabasePropertyEditSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDuplicateTableStructureSqlRequest {
    pub options: dbx_core::db_admin_sql::DuplicateTableStructureSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCopyTableDataSqlRequest {
    pub options: dbx_core::db_admin_sql::CopyTableDataSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExecutableObjectSourceRequest {
    pub input: dbx_core::object_source_sql::EditableObjectSourceSqlInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRoutineRenameObjectSourceRequest {
    pub input: dbx_core::object_source_sql::RoutineRenameObjectSourceInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildViewDdlRequest {
    pub input: dbx_core::object_source_sql::BuildViewDdlInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTableStructureSqlRequest {
    pub options: dbx_core::table_structure_sql::TableStructureSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSqliteTableStructureChangeRequest {
    pub connection_id: String,
    pub database: String,
    pub options: dbx_core::table_structure_sql::TableStructureSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySqliteTableStructureChangeRequest {
    pub connection_id: String,
    pub database: String,
    pub options: dbx_core::table_structure_sql::TableStructureSqlOptions,
    pub schema_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSingleColumnAlterSqlRequest {
    pub options: dbx_core::table_structure_sql::SingleColumnAlterSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDataGridSaveRequest {
    pub options: dbx_core::data_grid_sql::DataGridSaveStatementOptions,
    #[serde(default)]
    pub driver_profile: Option<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtractDataGridSelectionRequest {
    pub request: dbx_core::data_grid_extractors::DataGridExtractRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCopyUpdateStatementsRequest {
    pub options: dbx_core::data_grid_sql::DataGridCopyUpdateStatementOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCopyInsertStatementRequest {
    pub options: dbx_core::data_grid_sql::DataGridCopyInsertStatementOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridContextFilterConditionRequest {
    pub options: dbx_core::data_grid_sql::DataGridContextFilterConditionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridColumnValueFilterConditionRequest {
    pub options: dbx_core::data_grid_sql::DataGridColumnValueFilterConditionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridColumnValuesFilterConditionRequest {
    pub options: dbx_core::data_grid_sql::DataGridColumnValuesFilterConditionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridColumnDistinctValuesSqlRequest {
    pub options: dbx_core::data_grid_sql::DataGridColumnDistinctValuesSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDataGridCountSqlRequest {
    pub options: dbx_core::data_grid_sql::DataGridCountSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildHiveTablePropertiesSqlRequest {
    pub options: dbx_core::data_grid_sql::HiveTablePropertiesSqlOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportInsertStatementsRequest {
    pub options: dbx_core::database_export::BuildExportInsertStatementsOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportSqlInsertRequest {
    pub options: dbx_core::database_export::BuildExportSqlInsertOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSqlExportRequest {
    pub options: dbx_core::database_export::BuildDatabaseSqlExportOptions,
}

pub async fn execute_query(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<dbx_core::db::QueryResult>, AppError> {
    let allow_database_switch = req.client_session_id.as_deref().is_some_and(|id| !id.trim().is_empty());
    super::mcp_policy::ensure_sql(&state, &headers, &req.connection_id, &req.database, &req.sql, allow_database_switch)
        .await?;
    let execution_id = req.execution_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let registered = state.app.running_queries.register_task(
        execution_id.clone(),
        RunningTaskMetadata::query(req.connection_id.clone(), req.database.clone(), req.client_session_id.clone()),
    );
    let cancel_token = registered.token();

    tracing::debug!(connection_id = %req.connection_id, "execute_query");

    let result = dbx_core::query::execute_sql_statement_with_options_typed(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.sql,
        req.schema.as_deref(),
        Some(cancel_token),
        dbx_core::query::QueryExecutionOptions {
            max_rows: req.max_rows,
            fetch_size: req.fetch_size,
            page_size: req.page_size,
            row_offset: req.row_offset,
            max_result_bytes: req.max_result_bytes,
            result_key_columns: req.result_key_columns,
            table_data_preview: req.table_data_preview,
            catalog: req.catalog,
            result_session_id: req.result_session_id,
            client_session_id: req.client_session_id,
            timeout_secs: req.timeout_secs,
            execution_id: Some(execution_id),
            use_transaction: req.use_transaction,
            execution_mode: req.execution_mode.unwrap_or_default(),
            ..Default::default()
        },
    )
    .await
    .map_err(|error| AppError::from(error.into_backend_error()))?;

    drop(registered);
    Ok(Json(result))
}

pub async fn execute_multi(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<Vec<dbx_core::query::ExecuteMultiResult>>, AppError> {
    let allow_database_switch = req.client_session_id.as_deref().is_some_and(|id| !id.trim().is_empty());
    super::mcp_policy::ensure_sql(&state, &headers, &req.connection_id, &req.database, &req.sql, allow_database_switch)
        .await?;
    let execution_id = req.execution_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let registered = state.app.running_queries.register_task(
        execution_id.clone(),
        RunningTaskMetadata::query(req.connection_id.clone(), req.database.clone(), req.client_session_id.clone()),
    );
    let cancel_token = registered.token();

    tracing::debug!(connection_id = %req.connection_id, "execute_multi");

    let result = dbx_core::query::execute_multi_core_with_options_for_client_typed(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.sql,
        req.schema.as_deref(),
        Some(cancel_token),
        dbx_core::query::QueryExecutionOptions {
            max_rows: req.max_rows,
            fetch_size: req.fetch_size,
            page_size: req.page_size,
            row_offset: req.row_offset,
            max_result_bytes: req.max_result_bytes,
            result_key_columns: req.result_key_columns,
            table_data_preview: req.table_data_preview,
            catalog: req.catalog,
            result_session_id: req.result_session_id,
            client_session_id: req.client_session_id,
            timeout_secs: req.timeout_secs,
            execution_id: Some(execution_id),
            use_transaction: req.use_transaction,
            continue_on_error: req.continue_on_error.unwrap_or(false),
            execution_mode: req.execution_mode.unwrap_or_default(),
        },
    )
    .await
    .map_err(|error| AppError::from(error.into_backend_error()))?;

    drop(registered);
    Ok(execute_multi_response(result))
}

fn execute_multi_response(
    result: Vec<dbx_core::query::ExecuteMultiResult>,
) -> Json<Vec<dbx_core::query::ExecuteMultiResult>> {
    Json(result)
}

pub async fn execute_batch(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ExecuteBatchRequest>,
) -> Result<Json<dbx_core::db::QueryResult>, AppError> {
    for statement in &req.statements {
        super::mcp_policy::ensure_sql(&state, &headers, &req.connection_id, &req.database, statement, false).await?;
    }
    tracing::debug!(connection_id = %req.connection_id, "execute_batch");
    let result = dbx_core::query::execute_statements(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.statements,
        req.schema.as_deref(),
        req.timeout_secs,
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(result))
}

pub async fn cancel_query(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CancelRequest>,
) -> Json<serde_json::Value> {
    let cancelled = state.app.running_queries.cancel(&req.execution_id);
    Json(serde_json::json!({ "cancelled": cancelled }))
}

pub async fn close_query_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CloseSessionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let closed = dbx_core::query::close_query_session(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.session_id,
        req.client_session_id.as_deref(),
        req.catalog.as_deref(),
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(serde_json::json!(closed)))
}

pub async fn close_client_connection_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CloseClientConnectionSessionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = query_session_database(&req.database, req.catalog.as_deref());
    let closed = state
        .app
        .close_client_session_pool(&req.connection_id, database, &req.client_session_id)
        .await
        .map_err(AppError::from)?;

    Ok(Json(serde_json::json!(closed)))
}
fn query_session_database<'a>(database: &'a str, catalog: Option<&str>) -> Option<&'a str> {
    if database.trim().is_empty() || catalog.is_some() {
        None
    } else {
        Some(database)
    }
}

pub async fn execute_script(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteQueryRequest>,
) -> Result<Json<dbx_core::db::QueryResult>, AppError> {
    tracing::debug!(connection_id = %req.connection_id, "execute_script");
    let db_type = {
        let configs = state.app.configs.read().await;
        configs.get(&req.connection_id).map(|config| config.db_type)
    };
    let statements = db_type
        .map(|db_type| dbx_core::sql::split_sql_statements_for_database(&req.sql, db_type))
        .unwrap_or_else(|| dbx_core::sql::split_sql_statements(&req.sql));
    let result = dbx_core::query::execute_statements(
        &state.app,
        &req.connection_id,
        &req.database,
        &statements,
        req.schema.as_deref(),
        None,
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(result))
}

pub async fn execute_in_transaction(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteBatchRequest>,
) -> Result<Json<dbx_core::db::QueryResult>, AppError> {
    tracing::debug!(connection_id = %req.connection_id, "execute_in_transaction");
    let result = dbx_core::query::execute_statements_in_transaction(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.statements,
        req.schema.as_deref(),
        req.catalog.as_deref(),
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(result))
}

pub async fn execute_script_with_2pc(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ExecuteBatchRequest>,
) -> Result<Json<dbx_core::query::SchemaDiffDeployResult>, AppError> {
    tracing::debug!(connection_id = %req.connection_id, "execute_script_with_2pc");
    // Single-connection real transaction (not per-statement auto-commit 2PC).
    let result = dbx_core::query::execute_schema_diff_deploy(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.statements,
        req.schema.as_deref(),
        req.destructive_confirmed.unwrap_or(false),
    )
    .await;
    Ok(Json(result))
}

pub async fn analyze_sql_references(
    Json(req): Json<AnalyzeSqlReferencesRequest>,
) -> Result<Json<dbx_core::sql_analysis::SqlReferenceAnalysis>, AppError> {
    dbx_core::sql_analysis::analyze_sql_references(&req.sql, req.dialect.as_deref()).map(Json).map_err(AppError::from)
}

pub async fn find_statement_at_cursor(Json(req): Json<FindStatementAtCursorRequest>) -> Json<String> {
    Json(
        req.database_type
            .map(|db_type| dbx_core::sql::find_statement_at_cursor_for_database(&req.sql, req.cursor_pos, db_type))
            .unwrap_or_else(|| dbx_core::sql::find_statement_at_cursor(&req.sql, req.cursor_pos)),
    )
}

pub async fn prepare_query_pagination_execution_plan(
    Json(req): Json<PrepareQueryPaginationExecutionPlanRequest>,
) -> Json<dbx_core::query_result_sql::QueryPaginationExecutionPlan> {
    Json(dbx_core::query_result_sql::build_query_pagination_execution_plan(req.options))
}

pub async fn build_sorted_query_sql(
    Json(req): Json<BuildSortedQuerySqlRequest>,
) -> Json<dbx_core::query_result_sql::QuerySqlBuildResult> {
    Json(dbx_core::query_result_sql::build_sorted_query_sql(req.options))
}

pub async fn build_explain_sql(
    Json(req): Json<BuildExplainSqlRequest>,
) -> Json<dbx_core::query_execution_sql::ExplainSqlBuildResult> {
    Json(dbx_core::query_execution_sql::build_explain_sql(req.options))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetExplainInfoRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
    pub mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildCreateUserSqlRequest {
    pub username: String,
    pub password: String,
    pub tablespace: String,
}

pub async fn get_explain_info(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GetExplainInfoRequest>,
) -> Result<Json<String>, AppError> {
    let plan = dbx_core::agent_explain::get_agent_explain_info_core(
        &state.app,
        &req.connection_id,
        req.database.as_deref(),
        req.schema.as_deref(),
        &req.sql,
        req.mode.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(plan))
}

pub async fn build_create_user_sql(Json(req): Json<BuildCreateUserSqlRequest>) -> Result<Json<String>, AppError> {
    Ok(Json(dbx_core::db_admin_sql::build_create_user_sql(&req.username, &req.password, &req.tablespace)))
}

pub async fn build_dropped_file_preview_sql(
    Json(req): Json<BuildDroppedFilePreviewSqlRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::query_execution_sql::build_dropped_file_preview_sql(req.options))
}

pub async fn build_table_select_sql(Json(req): Json<BuildTableSelectSqlRequest>) -> Json<String> {
    Json(dbx_core::sql_dialect::build_table_data_select_sql(req.options))
}

pub async fn build_database_search_sql(
    Json(req): Json<BuildDatabaseSearchSqlRequest>,
) -> Json<Option<dbx_core::database_search_sql::DatabaseSearchSql>> {
    Json(dbx_core::database_search_sql::build_database_search_sql(req.options))
}

pub async fn build_search_result_where(Json(req): Json<BuildSearchResultWhereRequest>) -> Json<String> {
    Json(dbx_core::database_search_sql::build_search_result_where(req.options))
}

pub async fn build_rename_object_sql(Json(req): Json<BuildRenameObjectSqlRequest>) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_rename_object_sql(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_create_database_sql(
    Json(req): Json<BuildCreateDatabaseSqlRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_create_database_sql(req.options).map(Json).map_err(AppError::from)
}

#[cfg(feature = "duckdb-sidecar")]
pub async fn build_duckdb_attach_database_sql(Json(req): Json<BuildDuckDbAttachDatabaseSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_duckdb_attach_database_sql(req.options))
}

pub async fn build_sqlite_attach_database_sql(Json(req): Json<BuildSqliteAttachDatabaseSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_sqlite_attach_database_sql(req.options))
}

pub async fn build_drop_object_sql(Json(req): Json<BuildDropObjectSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_object_sql(req.options))
}

pub async fn build_drop_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_table_sql(req.options))
}

pub async fn build_drop_table_child_object_sql(
    Json(req): Json<BuildDropTableChildObjectSqlRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_drop_table_child_object_sql(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_empty_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_empty_table_sql(req.options))
}

pub async fn build_truncate_table_sql(Json(req): Json<BuildTableAdminSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_truncate_table_sql(req.options))
}

pub async fn build_drop_database_sql(Json(req): Json<BuildDatabaseNameSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_database_sql(req.options))
}

pub async fn build_create_schema_sql(Json(req): Json<BuildSchemaNameSqlRequest>) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_create_schema_sql(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_update_database_properties_sql(
    Json(req): Json<BuildDatabasePropertyEditSqlRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::db_admin_sql::build_update_database_properties_sql(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_drop_schema_sql(Json(req): Json<BuildSchemaNameSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_drop_schema_sql(req.options))
}

pub async fn build_duplicate_table_structure_sql(
    Json(req): Json<BuildDuplicateTableStructureSqlRequest>,
) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_duplicate_table_structure_sql(req.options))
}

pub async fn build_copy_table_data_sql(Json(req): Json<BuildCopyTableDataSqlRequest>) -> Json<String> {
    Json(dbx_core::db_admin_sql::build_copy_table_data_sql(req.options))
}

pub async fn build_executable_object_source_statements(
    Json(req): Json<BuildExecutableObjectSourceRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::object_source_sql::build_executable_object_source_statements(req.input).map(Json).map_err(AppError::from)
}

pub async fn build_executable_object_source_sql(
    Json(req): Json<BuildExecutableObjectSourceRequest>,
) -> Result<Json<String>, AppError> {
    dbx_core::object_source_sql::build_executable_object_source_sql(req.input).map(Json).map_err(AppError::from)
}

pub async fn build_editable_object_source(Json(req): Json<BuildExecutableObjectSourceRequest>) -> Json<String> {
    Json(dbx_core::object_source_sql::build_editable_object_source(req.input))
}

pub async fn build_routine_rename_object_source_statements(
    Json(req): Json<BuildRoutineRenameObjectSourceRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::object_source_sql::build_routine_rename_object_source_statements(req.input)
        .map(Json)
        .map_err(AppError::from)
}

pub async fn build_view_ddl_sql(Json(req): Json<BuildViewDdlRequest>) -> Json<String> {
    Json(dbx_core::object_source_sql::build_view_ddl_sql(req.input))
}

pub async fn build_table_structure_change_sql(
    Json(req): Json<BuildTableStructureSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_table_structure_change_sql(req.options))
}

pub async fn preview_sqlite_table_structure_change(
    State(state): State<Arc<WebState>>,
    Json(req): Json<PreviewSqliteTableStructureChangeRequest>,
) -> Result<Json<dbx_core::table_structure_sql::SqliteTableStructurePreview>, AppError> {
    dbx_core::table_structure_sql::preview_sqlite_table_structure_change(
        &state.app,
        &req.connection_id,
        &req.database,
        req.options,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

pub async fn apply_sqlite_table_structure_change(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ApplySqliteTableStructureChangeRequest>,
) -> Result<Json<dbx_core::db::QueryResult>, AppError> {
    dbx_core::table_structure_sql::apply_sqlite_table_structure_change(
        &state.app,
        &req.connection_id,
        &req.database,
        req.options,
        &req.schema_revision,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

pub async fn build_create_table_sql(
    Json(req): Json<BuildTableStructureSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_create_table_sql(req.options))
}

pub async fn build_single_column_alter_sql(
    Json(req): Json<BuildSingleColumnAlterSqlRequest>,
) -> Json<dbx_core::table_structure_sql::TableStructureSqlResult> {
    Json(dbx_core::table_structure_sql::build_single_column_alter_sql(req.options))
}

pub async fn analyze_editable_query_editability(
    Json(req): Json<AnalyzeEditableQueryRequest>,
) -> Json<dbx_core::sql_editability::QueryEditability> {
    Json(dbx_core::sql_editability::analyze_editable_query_editability(&req.sql))
}

pub async fn prepare_data_grid_save(
    Json(req): Json<PrepareDataGridSaveRequest>,
) -> Json<dbx_core::data_grid_sql::DataGridSavePreparation> {
    Json(dbx_core::data_grid_sql::prepare_data_grid_save_for_driver_profile(req.options, req.driver_profile.as_deref()))
}

#[utoipa::path(
    post,
    path = "/api/query/extract-data-grid-selection",
    request_body = ExtractDataGridSelectionRequest,
    responses(
        (status = 200, description = "Selection extracted successfully", body = dbx_core::data_grid_extractors::DataGridExtractResult),
        (status = 400, description = "Invalid selection or extractor configuration", body = dbx_core::data_grid_extractors::DataGridExtractError),
        (status = 413, description = "Request body exceeds the extractor upload limit"),
        (status = 422, description = "Request body does not match the extractor contract"),
        (status = 500, description = "Extractor worker failed", body = dbx_core::data_grid_extractors::DataGridExtractError)
    ),
    tag = "data-grid"
)]
pub async fn extract_data_grid_selection(
    Json(req): Json<ExtractDataGridSelectionRequest>,
) -> Result<
    Json<dbx_core::data_grid_extractors::DataGridExtractResult>,
    (axum::http::StatusCode, Json<dbx_core::data_grid_extractors::DataGridExtractError>),
> {
    tokio::task::spawn_blocking(move || dbx_core::data_grid_extractors::extract_data_grid_selection(req.request))
        .await
        .map_err(|error| {
            let error = dbx_core::data_grid_extractors::DataGridExtractError::new(
                dbx_core::data_grid_extractors::DataGridExtractErrorCode::ExecutionFailed,
                format!("Data grid extractor worker failed: {error}"),
            );
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(error))
        })?
        .map(Json)
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, Json(error)))
}

pub async fn build_data_grid_copy_update_statements(
    Json(req): Json<BuildDataGridCopyUpdateStatementsRequest>,
) -> Json<Vec<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_copy_update_statements(req.options))
}

pub async fn build_data_grid_copy_insert_statement(
    Json(req): Json<BuildDataGridCopyInsertStatementRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_copy_insert_statement(req.options))
}

pub async fn build_data_grid_context_filter_condition(
    Json(req): Json<BuildDataGridContextFilterConditionRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_context_filter_condition(req.options))
}

pub async fn build_data_grid_column_value_filter_condition(
    Json(req): Json<BuildDataGridColumnValueFilterConditionRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_column_value_filter_condition(req.options))
}

pub async fn build_data_grid_column_values_filter_condition(
    Json(req): Json<BuildDataGridColumnValuesFilterConditionRequest>,
) -> Json<Option<String>> {
    Json(dbx_core::data_grid_sql::build_data_grid_column_values_filter_condition(req.options))
}

pub async fn build_data_grid_column_distinct_values_sql(
    Json(req): Json<BuildDataGridColumnDistinctValuesSqlRequest>,
) -> Json<String> {
    Json(dbx_core::data_grid_sql::build_data_grid_column_distinct_values_sql(req.options))
}

pub async fn build_data_grid_count_sql(Json(req): Json<BuildDataGridCountSqlRequest>) -> Json<String> {
    Json(dbx_core::data_grid_sql::build_data_grid_count_sql(req.options))
}

pub async fn build_hive_table_properties_sql(Json(req): Json<BuildHiveTablePropertiesSqlRequest>) -> Json<String> {
    Json(dbx_core::data_grid_sql::build_hive_table_properties_sql(req.options))
}

pub async fn build_export_insert_statements(
    Json(req): Json<BuildExportInsertStatementsRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    dbx_core::database_export::build_export_insert_statements(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_export_sql_insert(Json(req): Json<BuildExportSqlInsertRequest>) -> Result<Json<String>, AppError> {
    dbx_core::database_export::build_export_sql_insert(req.options).map(Json).map_err(AppError::from)
}

pub async fn build_database_sql_export(
    State(state): State<Arc<WebState>>,
    Json(req): Json<BuildDatabaseSqlExportRequest>,
) -> Result<Json<String>, AppError> {
    let mut options = req.options;
    // Sort tables by FK dependency when connection info is available.
    if let (Some(ref conn_id), Some(ref database), Some(ref schema)) =
        (&options.connection_id, &options.database, &options.schema)
    {
        if options.tables.len() > 1 {
            let table_names: Vec<String> = options.tables.iter().filter_map(|t| t.table_name.clone()).collect();
            if table_names.len() > 1 {
                if let Ok(sorted_names) = dbx_core::transfer::sort_tables_by_fk_dependency(
                    &state.app,
                    conn_id,
                    database,
                    schema,
                    &table_names,
                    true,
                )
                .await
                {
                    options.tables.sort_by_key(|t| {
                        sorted_names
                            .iter()
                            .position(|n| Some(n.as_str()) == t.table_name.as_deref())
                            .unwrap_or(usize::MAX)
                    });
                }
            }
        }
    }
    dbx_core::database_export::build_database_sql_export(options).map(Json).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::WebState;
    use axum::extract::State as AxumState;
    use dbx_core::connection::AppState;
    use dbx_core::storage::Storage;

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-query-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        (state, dir)
    }

    #[tokio::test]
    async fn execute_script_with_2pc_returns_structured_result() {
        let (state, _dir) = test_web_state().await;
        let req = ExecuteBatchRequest {
            connection_id: "conn-1".to_string(),
            database: "testdb".to_string(),
            statements: vec!["SELECT 1".to_string()],
            schema: None,
            catalog: None,
            timeout_secs: None,
            destructive_confirmed: None,
        };

        let result = execute_script_with_2pc(AxumState(state), Json(req))
            .await
            .expect("execute_script_with_2pc should return Ok(Json(...))");
        let log = result.0;
        assert!(!log.transaction_id.is_empty());
        assert!(!log.participants.is_empty());
        assert_eq!(log.status, "rolled_back");
        assert!(log.error.as_ref().is_some_and(|e| !e.is_empty()));
        assert_eq!(log.statement_count, 1);
        assert_eq!(log.executed_count, 0);
    }

    #[tokio::test]
    async fn execute_script_with_2pc_empty_statements_succeeds() {
        let (state, _dir) = test_web_state().await;
        let req = ExecuteBatchRequest {
            connection_id: "conn-empty".to_string(),
            database: "testdb".to_string(),
            statements: vec![],
            schema: None,
            catalog: None,
            timeout_secs: None,
            destructive_confirmed: None,
        };

        let result = execute_script_with_2pc(AxumState(state), Json(req)).await.expect("empty deploy should succeed");
        let log = result.0;
        assert_eq!(log.status, "committed");
        assert_eq!(log.statement_count, 0);
        assert_eq!(log.executed_count, 0);
        assert!(log.error.is_none());
        assert_eq!(log.participants.len(), 1);
    }

    #[tokio::test]
    async fn execute_script_with_2pc_propagates_structured_failure_fields() {
        let (state, _dir) = test_web_state().await;
        let req = ExecuteBatchRequest {
            connection_id: "missing-conn".to_string(),
            database: "testdb".to_string(),
            statements: vec!["CREATE TABLE t1 (id INT)".to_string(), "CREATE TABLE t2 (id INT)".to_string()],
            schema: None,
            catalog: None,
            timeout_secs: None,
            destructive_confirmed: None,
        };

        let result = execute_script_with_2pc(AxumState(state), Json(req))
            .await
            .expect("deploy endpoint should return structured JSON even on failure");
        let log = result.0;
        assert!(log.status == "rolled_back" || log.status == "mixed", "status={}", log.status);
        assert_eq!(log.statement_count, 2);
        assert!(log.error.as_ref().is_some_and(|e| !e.is_empty()));
        // Missing connection cannot have applied statements.
        assert_eq!(log.executed_count, 0);
    }

    #[tokio::test]
    async fn execute_script_with_2pc_blocks_unconfirmed_destructive_sql() {
        let (state, _dir) = test_web_state().await;
        let req = ExecuteBatchRequest {
            connection_id: "missing-conn".to_string(),
            database: "testdb".to_string(),
            statements: vec!["DROP INDEX idx_old ON users".to_string()],
            schema: None,
            catalog: None,
            timeout_secs: None,
            destructive_confirmed: None,
        };

        let result = execute_script_with_2pc(AxumState(state), Json(req))
            .await
            .expect("destructive deploy should return a structured block result");
        let log = result.0;
        assert_eq!(log.status, "rolled_back");
        assert_eq!(log.executed_count, 0);
        assert_eq!(log.metadata["blocked"], "destructive_confirmation_required");
    }

    #[test]
    fn execute_multi_response_preserves_nested_original_error_detail() {
        let result = dbx_core::query::ExecuteMultiResult {
            result: dbx_core::db::QueryResult {
                columns: vec!["Error".to_string()],
                column_types: vec![],
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![vec![serde_json::json!("relation customer_orders does not exist")]],
                affected_rows: 0,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            },
            large_value_cells: Vec::new(),
            execution_error: true,
            statement_index: Some(1),
            error: Some(dbx_core::backend_error::BackendError::from_sql_detail(
                "relation customer_orders does not exist",
            )),
            server_message: false,
        };

        let payload = serde_json::to_value(execute_multi_response(vec![result]).0).unwrap();

        assert_eq!(payload[0]["statement_index"], 1);
        assert_eq!(payload[0]["error"]["code"], "DBX-JDBC-4001");
        assert_eq!(payload[0]["error"]["detail"], "relation customer_orders does not exist");
    }
}
