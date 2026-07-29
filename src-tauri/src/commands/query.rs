use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;
use dbx_core::db;
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_cancel::RunningTaskMetadata;
use dbx_core::sql::split_sql_statements;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteMultiProgress {
    execution_id: String,
    completed: usize,
    total: usize,
    success: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    schema: Option<String>,
    catalog: Option<String>,
    execution_id: Option<String>,
    max_rows: Option<usize>,
    fetch_size: Option<usize>,
    page_size: Option<usize>,
    result_session_id: Option<String>,
    client_session_id: Option<String>,
    timeout_secs: Option<u64>,
    execution_mode: Option<dbx_core::query::QueryExecutionMode>,
) -> Result<db::QueryResult, String> {
    let execution_id = execution_id.filter(|id| !id.trim().is_empty());
    let registered_query = execution_id.as_ref().map(|id| {
        state.running_queries.register_task(
            id.clone(),
            RunningTaskMetadata::query(connection_id.clone(), database.clone(), client_session_id.clone()),
        )
    });
    let cancel_token = registered_query.as_ref().map(|query| query.token());

    dbx_core::query::execute_sql_statement_with_options(
        &state,
        &connection_id,
        &database,
        &sql,
        schema.as_deref(),
        cancel_token,
        dbx_core::query::QueryExecutionOptions {
            max_rows,
            fetch_size,
            page_size,
            catalog,
            result_session_id,
            client_session_id,
            timeout_secs,
            execution_id,
            execution_mode: execution_mode.unwrap_or_default(),
            ..Default::default()
        },
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_multi(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    schema: Option<String>,
    catalog: Option<String>,
    execution_id: Option<String>,
    max_rows: Option<usize>,
    fetch_size: Option<usize>,
    page_size: Option<usize>,
    result_session_id: Option<String>,
    client_session_id: Option<String>,
    timeout_secs: Option<u64>,
    use_transaction: Option<bool>,
    continue_on_error: Option<bool>,
    execution_mode: Option<dbx_core::query::QueryExecutionMode>,
) -> Result<Vec<dbx_core::query::ExecuteMultiResult>, String> {
    let execution_id = execution_id.filter(|id| !id.trim().is_empty());
    let registered_query = execution_id.as_ref().map(|id| {
        state.running_queries.register_task(
            id.clone(),
            RunningTaskMetadata::query(connection_id.clone(), database.clone(), client_session_id.clone()),
        )
    });
    let cancel_token = registered_query.as_ref().map(|query| query.token());
    let progress = execution_id.as_ref().map(|execution_id| {
        let app = app.clone();
        let execution_id = execution_id.clone();
        Arc::new(move |completed, total, success| {
            let _ = app.emit(
                "query-batch-progress",
                ExecuteMultiProgress { execution_id: execution_id.clone(), completed, total, success },
            );
        }) as dbx_core::query::ExecuteMultiProgressCallback
    });
    let trace_id = execution_id.as_deref().unwrap_or("no-execution-id").to_string();
    let started_at = Instant::now();
    dbx_core::sql_diagnostics::debug_sql("query:execute_multi:start", &sql);
    log::info!(
        "[query][execute_multi:start] trace_id={} connection_id={} database={} schema={:?}",
        trace_id,
        connection_id,
        database,
        schema
    );

    let result = dbx_core::query::execute_multi_core_with_options_for_client_and_progress(
        &state,
        &connection_id,
        &database,
        &sql,
        schema.as_deref(),
        cancel_token,
        dbx_core::query::QueryExecutionOptions {
            max_rows,
            fetch_size,
            page_size,
            catalog,
            result_session_id,
            client_session_id,
            timeout_secs,
            execution_id,
            use_transaction,
            continue_on_error: continue_on_error.unwrap_or(false),
            execution_mode: execution_mode.unwrap_or_default(),
        },
        progress,
    )
    .await;
    match &result {
        Ok(results) => log::info!(
            "[query][execute_multi:done] trace_id={} elapsed_ms={} result_count={} row_counts={:?} backend_execution_times_ms={:?}",
            trace_id,
            started_at.elapsed().as_millis(),
            results.len(),
            results.iter().map(|result| result.result.rows.len()).collect::<Vec<_>>(),
            results.iter().map(|result| result.result.execution_time_ms).collect::<Vec<_>>()
        ),
        Err(error) => log::error!(
            "[query][execute_multi:error] trace_id={} elapsed_ms={} error={}",
            trace_id,
            started_at.elapsed().as_millis(),
            error
        ),
    }
    result
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, Arc<AppState>>, execution_id: String) -> Result<bool, String> {
    Ok(state.running_queries.cancel(&execution_id))
}

#[tauri::command]
pub async fn close_query_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    session_id: String,
    client_session_id: Option<String>,
    catalog: Option<String>,
) -> Result<bool, String> {
    dbx_core::query::close_query_session(
        &state,
        &connection_id,
        &database,
        &session_id,
        client_session_id.as_deref(),
        catalog.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn close_client_connection_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    client_session_id: String,
    catalog: Option<String>,
) -> Result<bool, String> {
    let database = query_session_database(&database, catalog.as_deref());
    state.close_client_session_pool(&connection_id, database, &client_session_id).await
}

fn query_session_database<'a>(database: &'a str, catalog: Option<&str>) -> Option<&'a str> {
    if database.trim().is_empty() || catalog.is_some() {
        None
    } else {
        Some(database)
    }
}

#[tauri::command]
pub async fn execute_batch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
    schema: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<db::QueryResult, String> {
    dbx_core::query::execute_statements(&state, &connection_id, &database, &statements, schema.as_deref(), timeout_secs)
        .await
}

#[tauri::command]
pub async fn execute_script(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    schema: Option<String>,
) -> Result<db::QueryResult, String> {
    let db_type = {
        let configs = state.configs.read().await;
        configs.get(&connection_id).map(|config| config.db_type)
    };

    dbx_core::query::execute_statements(
        &state,
        &connection_id,
        &database,
        &db_type.map_or_else(
            || split_sql_statements(&sql),
            |db_type| dbx_core::sql::split_sql_statements_for_database(&sql, db_type),
        ),
        schema.as_deref(),
        None,
    )
    .await
}

#[tauri::command]
pub async fn execute_in_transaction(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
    schema: Option<String>,
    catalog: Option<String>,
) -> Result<db::QueryResult, String> {
    dbx_core::query::execute_statements_in_transaction(
        &state,
        &connection_id,
        &database,
        &statements,
        schema.as_deref(),
        catalog.as_deref(),
    )
    .await
}

/// Schema Diff deploy entrypoint (legacy command name kept for API compatibility).
///
/// Executes as one single-connection transaction via [`execute_schema_diff_deploy`].
/// On failure, status is `rolled_back` when DDL/DML atomicity is guaranteed for the
/// target, otherwise `mixed` with a best-effort `executed_count` (e.g. MySQL/Oracle DDL).
pub async fn execute_script_with_2pc_core(
    app: Arc<AppState>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
    schema: Option<String>,
) -> dbx_core::query::SchemaDiffDeployResult {
    dbx_core::query::execute_schema_diff_deploy(&app, &connection_id, &database, &statements, schema.as_deref()).await
}

#[tauri::command]
pub async fn execute_script_with_2pc(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
    schema: Option<String>,
) -> Result<dbx_core::query::SchemaDiffDeployResult, String> {
    let app: Arc<AppState> = (*state).clone();
    Ok(execute_script_with_2pc_core(app, connection_id, database, statements, schema).await)
}

#[tauri::command]
pub async fn begin_manual_transaction(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    catalog: Option<String>,
) -> Result<String, String> {
    dbx_core::query::begin_manual_transaction(&state, &connection_id, &database, schema.as_deref(), catalog.as_deref())
        .await
}

#[tauri::command]
pub async fn execute_in_manual_transaction(
    state: State<'_, Arc<AppState>>,
    txn_session_id: String,
    sql: String,
    database: String,
    schema: Option<String>,
    max_rows: Option<usize>,
) -> Result<Vec<db::QueryResult>, String> {
    dbx_core::query::execute_in_manual_transaction(
        &state,
        &txn_session_id,
        &sql,
        &database,
        schema.as_deref(),
        max_rows,
    )
    .await
}

#[tauri::command]
pub async fn commit_manual_transaction(
    state: State<'_, Arc<AppState>>,
    txn_session_id: String,
) -> Result<db::QueryResult, String> {
    dbx_core::query::commit_manual_transaction(&state, &txn_session_id).await
}

#[tauri::command]
pub async fn rollback_manual_transaction(
    state: State<'_, Arc<AppState>>,
    txn_session_id: String,
) -> Result<db::QueryResult, String> {
    dbx_core::query::rollback_manual_transaction(&state, &txn_session_id).await
}

#[tauri::command]
pub async fn analyze_sql_references(
    sql: String,
    dialect: Option<String>,
) -> Result<dbx_core::sql_analysis::SqlReferenceAnalysis, String> {
    dbx_core::sql_analysis::analyze_sql_references(&sql, dialect.as_deref())
}

#[tauri::command]
pub fn find_statement_at_cursor(
    sql: String,
    cursor_pos: usize,
    database_type: Option<DatabaseType>,
) -> Result<String, String> {
    Ok(database_type
        .map(|db_type| dbx_core::sql::find_statement_at_cursor_for_database(&sql, cursor_pos, db_type))
        .unwrap_or_else(|| dbx_core::sql::find_statement_at_cursor(&sql, cursor_pos)))
}

#[tauri::command]
pub fn prepare_query_pagination_execution_plan(
    options: dbx_core::query_result_sql::QueryPaginationExecutionPlanOptions,
) -> Result<dbx_core::query_result_sql::QueryPaginationExecutionPlan, String> {
    Ok(dbx_core::query_result_sql::build_query_pagination_execution_plan(options))
}

#[tauri::command]
pub fn build_sorted_query_sql(
    options: dbx_core::query_result_sql::SortedQuerySqlOptions,
) -> Result<dbx_core::query_result_sql::QuerySqlBuildResult, String> {
    Ok(dbx_core::query_result_sql::build_sorted_query_sql(options))
}

#[tauri::command]
pub fn build_explain_sql(
    options: dbx_core::query_execution_sql::ExplainSqlOptions,
) -> Result<dbx_core::query_execution_sql::ExplainSqlBuildResult, String> {
    Ok(dbx_core::query_execution_sql::build_explain_sql(options))
}

#[tauri::command]
pub fn build_dropped_file_preview_sql(
    options: dbx_core::query_execution_sql::DroppedFilePreviewSqlOptions,
) -> Result<Option<String>, String> {
    Ok(dbx_core::query_execution_sql::build_dropped_file_preview_sql(options))
}

#[tauri::command]
pub fn build_table_select_sql(options: dbx_core::sql_dialect::TableDataSelectSqlOptions) -> Result<String, String> {
    Ok(dbx_core::sql_dialect::build_table_data_select_sql(options))
}

#[tauri::command]
pub fn build_database_search_sql(
    options: dbx_core::database_search_sql::DatabaseSearchSqlOptions,
) -> Result<Option<dbx_core::database_search_sql::DatabaseSearchSql>, String> {
    Ok(dbx_core::database_search_sql::build_database_search_sql(options))
}

#[tauri::command]
pub fn build_search_result_where(
    options: dbx_core::database_search_sql::SearchResultWhereOptions,
) -> Result<String, String> {
    Ok(dbx_core::database_search_sql::build_search_result_where(options))
}

#[tauri::command]
pub fn build_rename_object_sql(options: dbx_core::db_admin_sql::RenameObjectSqlOptions) -> Result<String, String> {
    dbx_core::db_admin_sql::build_rename_object_sql(options)
}

#[tauri::command]
pub fn build_create_database_sql(options: dbx_core::db_admin_sql::CreateDatabaseSqlOptions) -> Result<String, String> {
    dbx_core::db_admin_sql::build_create_database_sql(options)
}

#[cfg(feature = "duckdb-bundled")]
#[tauri::command]
pub fn build_duckdb_attach_database_sql(
    options: dbx_core::db_admin_sql::DuckDbAttachDatabaseSqlOptions,
) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_duckdb_attach_database_sql(options))
}

#[tauri::command]
pub fn build_sqlite_attach_database_sql(
    options: dbx_core::db_admin_sql::SqliteAttachDatabaseSqlOptions,
) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_sqlite_attach_database_sql(options))
}

#[tauri::command]
pub fn build_drop_object_sql(options: dbx_core::db_admin_sql::DropObjectSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_drop_object_sql(options))
}

#[tauri::command]
pub fn build_drop_table_sql(options: dbx_core::db_admin_sql::TableAdminSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_drop_table_sql(options))
}

#[tauri::command]
pub fn build_drop_table_child_object_sql(
    options: dbx_core::db_admin_sql::DropTableChildObjectSqlOptions,
) -> Result<String, String> {
    dbx_core::db_admin_sql::build_drop_table_child_object_sql(options)
}

#[tauri::command]
pub fn build_empty_table_sql(options: dbx_core::db_admin_sql::TableAdminSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_empty_table_sql(options))
}

#[tauri::command]
pub fn build_truncate_table_sql(options: dbx_core::db_admin_sql::TableAdminSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_truncate_table_sql(options))
}

#[tauri::command]
pub fn build_drop_database_sql(options: dbx_core::db_admin_sql::DatabaseNameSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_drop_database_sql(options))
}

#[tauri::command]
pub fn build_create_schema_sql(options: dbx_core::db_admin_sql::SchemaNameSqlOptions) -> Result<String, String> {
    dbx_core::db_admin_sql::build_create_schema_sql(options)
}

#[tauri::command]
pub fn build_update_database_properties_sql(
    options: dbx_core::db_admin_sql::DatabasePropertyEditSqlOptions,
) -> Result<String, String> {
    dbx_core::db_admin_sql::build_update_database_properties_sql(options)
}

#[tauri::command]
pub fn build_drop_schema_sql(options: dbx_core::db_admin_sql::SchemaNameSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_drop_schema_sql(options))
}

#[tauri::command]
pub fn build_duplicate_table_structure_sql(
    options: dbx_core::db_admin_sql::DuplicateTableStructureSqlOptions,
) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_duplicate_table_structure_sql(options))
}

#[tauri::command]
pub fn build_copy_table_data_sql(options: dbx_core::db_admin_sql::CopyTableDataSqlOptions) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_copy_table_data_sql(options))
}

#[tauri::command]
pub fn build_executable_object_source_statements(
    input: dbx_core::object_source_sql::EditableObjectSourceSqlInput,
) -> Result<Vec<String>, String> {
    dbx_core::object_source_sql::build_executable_object_source_statements(input)
}

#[tauri::command]
pub fn build_executable_object_source_sql(
    input: dbx_core::object_source_sql::EditableObjectSourceSqlInput,
) -> Result<String, String> {
    dbx_core::object_source_sql::build_executable_object_source_sql(input)
}

#[tauri::command]
pub fn build_editable_object_source(
    input: dbx_core::object_source_sql::EditableObjectSourceSqlInput,
) -> Result<String, String> {
    Ok(dbx_core::object_source_sql::build_editable_object_source(input))
}

#[tauri::command]
pub fn build_routine_rename_object_source_statements(
    input: dbx_core::object_source_sql::RoutineRenameObjectSourceInput,
) -> Result<Vec<String>, String> {
    dbx_core::object_source_sql::build_routine_rename_object_source_statements(input)
}

#[tauri::command]
pub fn build_view_ddl_sql(input: dbx_core::object_source_sql::BuildViewDdlInput) -> Result<String, String> {
    Ok(dbx_core::object_source_sql::build_view_ddl_sql(input))
}

#[tauri::command]
pub fn build_table_structure_change_sql(
    options: dbx_core::table_structure_sql::TableStructureSqlOptions,
) -> Result<dbx_core::table_structure_sql::TableStructureSqlResult, String> {
    Ok(dbx_core::table_structure_sql::build_table_structure_change_sql(options))
}

#[tauri::command]
pub async fn preview_sqlite_table_structure_change(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    options: dbx_core::table_structure_sql::TableStructureSqlOptions,
) -> Result<dbx_core::table_structure_sql::SqliteTableStructurePreview, String> {
    dbx_core::table_structure_sql::preview_sqlite_table_structure_change(&state, &connection_id, &database, options)
        .await
}

#[tauri::command]
pub async fn apply_sqlite_table_structure_change(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    options: dbx_core::table_structure_sql::TableStructureSqlOptions,
    schema_revision: String,
) -> Result<db::QueryResult, String> {
    dbx_core::table_structure_sql::apply_sqlite_table_structure_change(
        &state,
        &connection_id,
        &database,
        options,
        &schema_revision,
    )
    .await
}

#[tauri::command]
pub fn build_create_table_sql(
    options: dbx_core::table_structure_sql::TableStructureSqlOptions,
) -> Result<dbx_core::table_structure_sql::TableStructureSqlResult, String> {
    Ok(dbx_core::table_structure_sql::build_create_table_sql(options))
}

#[tauri::command]
pub fn build_single_column_alter_sql(
    options: dbx_core::table_structure_sql::SingleColumnAlterSqlOptions,
) -> Result<dbx_core::table_structure_sql::TableStructureSqlResult, String> {
    Ok(dbx_core::table_structure_sql::build_single_column_alter_sql(options))
}

#[tauri::command]
pub fn analyze_editable_query_editability(sql: String) -> Result<dbx_core::sql_editability::QueryEditability, String> {
    Ok(dbx_core::sql_editability::analyze_editable_query_editability(&sql))
}

#[tauri::command]
pub fn prepare_data_grid_save(
    options: dbx_core::data_grid_sql::DataGridSaveStatementOptions,
) -> Result<dbx_core::data_grid_sql::DataGridSavePreparation, String> {
    Ok(dbx_core::data_grid_sql::prepare_data_grid_save(options))
}

#[tauri::command]
pub async fn extract_data_grid_selection(
    request: dbx_core::data_grid_extractors::DataGridExtractRequest,
) -> Result<dbx_core::data_grid_extractors::DataGridExtractResult, dbx_core::data_grid_extractors::DataGridExtractError>
{
    tauri::async_runtime::spawn_blocking(move || dbx_core::data_grid_extractors::extract_data_grid_selection(request))
        .await
        .map_err(|error| {
            dbx_core::data_grid_extractors::DataGridExtractError::new(
                dbx_core::data_grid_extractors::DataGridExtractErrorCode::ExecutionFailed,
                format!("Data grid extractor worker failed: {error}"),
            )
        })?
}

#[tauri::command]
pub fn build_data_grid_copy_update_statements(
    options: dbx_core::data_grid_sql::DataGridCopyUpdateStatementOptions,
) -> Result<Vec<String>, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_copy_update_statements(options))
}

#[tauri::command]
pub fn build_data_grid_copy_insert_statement(
    options: dbx_core::data_grid_sql::DataGridCopyInsertStatementOptions,
) -> Result<Option<String>, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_copy_insert_statement(options))
}

#[tauri::command]
pub fn build_data_grid_context_filter_condition(
    options: dbx_core::data_grid_sql::DataGridContextFilterConditionOptions,
) -> Result<Option<String>, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_context_filter_condition(options))
}

#[tauri::command]
pub fn build_data_grid_column_value_filter_condition(
    options: dbx_core::data_grid_sql::DataGridColumnValueFilterConditionOptions,
) -> Result<Option<String>, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_column_value_filter_condition(options))
}

#[tauri::command]
pub fn build_data_grid_column_values_filter_condition(
    options: dbx_core::data_grid_sql::DataGridColumnValuesFilterConditionOptions,
) -> Result<Option<String>, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_column_values_filter_condition(options))
}

#[tauri::command]
pub fn build_data_grid_column_distinct_values_sql(
    options: dbx_core::data_grid_sql::DataGridColumnDistinctValuesSqlOptions,
) -> Result<String, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_column_distinct_values_sql(options))
}

#[tauri::command]
pub fn build_data_grid_count_sql(options: dbx_core::data_grid_sql::DataGridCountSqlOptions) -> Result<String, String> {
    Ok(dbx_core::data_grid_sql::build_data_grid_count_sql(options))
}

#[tauri::command]
pub fn build_hive_table_properties_sql(
    options: dbx_core::data_grid_sql::HiveTablePropertiesSqlOptions,
) -> Result<String, String> {
    Ok(dbx_core::data_grid_sql::build_hive_table_properties_sql(options))
}

#[tauri::command]
pub fn build_export_insert_statements(
    options: dbx_core::database_export::BuildExportInsertStatementsOptions,
) -> Result<Vec<String>, String> {
    dbx_core::database_export::build_export_insert_statements(options)
}

#[tauri::command]
pub fn build_export_sql_insert(
    options: dbx_core::database_export::BuildExportSqlInsertOptions,
) -> Result<String, String> {
    dbx_core::database_export::build_export_sql_insert(options)
}

#[tauri::command]
pub async fn build_database_sql_export(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
    mut options: dbx_core::database_export::BuildDatabaseSqlExportOptions,
) -> Result<String, String> {
    // Sort tables by FK dependency when connection info is available.
    if let (Some(ref conn_id), Some(ref database), Some(ref schema)) =
        (&options.connection_id, &options.database, &options.schema)
    {
        if options.tables.len() > 1 {
            let table_names: Vec<String> = options.tables.iter().filter_map(|t| t.table_name.clone()).collect();
            if table_names.len() > 1 {
                if let Ok(sorted_names) = dbx_core::transfer::sort_tables_by_fk_dependency(
                    &state,
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
    dbx_core::database_export::build_database_sql_export(options)
}

#[tauri::command]
pub async fn get_explain_info(
    state: tauri::State<'_, std::sync::Arc<dbx_core::connection::AppState>>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    sql: String,
    mode: Option<String>,
) -> Result<String, String> {
    dbx_core::agent_explain::get_agent_explain_info_core(
        &state,
        &connection_id,
        database.as_deref(),
        schema.as_deref(),
        &sql,
        mode.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn build_create_user_sql(username: String, password: String, tablespace: String) -> Result<String, String> {
    Ok(dbx_core::db_admin_sql::build_create_user_sql(&username, &password, &tablespace))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::storage::Storage;
    use std::sync::Arc;

    async fn test_app_state() -> Arc<AppState> {
        let dir = std::env::temp_dir().join(format!("dbx-query-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")))
    }

    #[tokio::test]
    async fn execute_script_with_2pc_returns_structured_result() {
        let state = test_app_state().await;
        let result = execute_script_with_2pc_core(
            state,
            "conn-1".to_string(),
            "testdb".to_string(),
            vec!["SELECT 1".to_string()],
            None,
        )
        .await;

        assert!(!result.transaction_id.is_empty());
        assert!(!result.participants.is_empty());
        // No real connection: rolled_back with error, not silent auto-commit success.
        assert_eq!(result.status, "rolled_back");
        assert!(result.error.as_ref().is_some_and(|e| !e.is_empty()));
        assert_eq!(result.statement_count, 1);
        assert_eq!(result.executed_count, 0);
    }

    #[tokio::test]
    async fn execute_script_with_2pc_empty_statements_succeeds() {
        let state = test_app_state().await;
        let result =
            execute_script_with_2pc_core(state, "conn-empty".to_string(), "testdb".to_string(), vec![], None).await;

        assert_eq!(result.status, "committed");
        assert_eq!(result.statement_count, 0);
        assert_eq!(result.executed_count, 0);
        assert!(result.error.is_none());
        assert_eq!(result.participants.len(), 1);
    }

    #[tokio::test]
    async fn execute_script_with_2pc_comment_only_is_empty_success() {
        let state = test_app_state().await;
        let result = execute_script_with_2pc_core(
            state,
            "conn-comment".to_string(),
            "testdb".to_string(),
            vec!["-- WARNING: incomplete\n-- manual only".to_string()],
            None,
        )
        .await;

        assert_eq!(result.status, "committed");
        assert_eq!(result.statement_count, 0);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn execute_script_with_2pc_propagates_structured_failure_fields() {
        let state = test_app_state().await;
        let result = execute_script_with_2pc_core(
            state,
            "missing-conn".to_string(),
            "testdb".to_string(),
            vec!["CREATE TABLE t1 (id INT)".to_string(), "CREATE TABLE t2 (id INT)".to_string()],
            None,
        )
        .await;

        assert!(result.status == "rolled_back" || result.status == "mixed", "status={}", result.status);
        assert_eq!(result.statement_count, 2);
        assert!(result.error.as_ref().is_some_and(|e| !e.is_empty()));
        assert_eq!(result.executed_count, 0);
    }
}
