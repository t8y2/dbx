use std::sync::Arc;
use std::time::Instant;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_cancel::RunningTaskMetadata;
use dbx_core::sql::split_sql_statements;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    schema: Option<String>,
    execution_id: Option<String>,
    max_rows: Option<usize>,
    fetch_size: Option<usize>,
    page_size: Option<usize>,
    result_session_id: Option<String>,
    client_session_id: Option<String>,
    timeout_secs: Option<u64>,
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
            result_session_id,
            client_session_id,
            timeout_secs,
            execution_id,
            ..Default::default()
        },
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_multi(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    schema: Option<String>,
    execution_id: Option<String>,
    max_rows: Option<usize>,
    fetch_size: Option<usize>,
    page_size: Option<usize>,
    result_session_id: Option<String>,
    client_session_id: Option<String>,
    timeout_secs: Option<u64>,
    use_transaction: Option<bool>,
) -> Result<Vec<db::QueryResult>, String> {
    let execution_id = execution_id.filter(|id| !id.trim().is_empty());
    let registered_query = execution_id.as_ref().map(|id| {
        state.running_queries.register_task(
            id.clone(),
            RunningTaskMetadata::query(connection_id.clone(), database.clone(), client_session_id.clone()),
        )
    });
    let cancel_token = registered_query.as_ref().map(|query| query.token());
    let trace_id = execution_id.as_deref().unwrap_or("no-execution-id").to_string();
    let started_at = Instant::now();
    log::info!(
        "[query][execute_multi:start] trace_id={} connection_id={} database={} schema={:?} sql={}",
        trace_id,
        connection_id,
        database,
        schema,
        sql
    );

    let result = dbx_core::query::execute_multi_core_with_options(
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
            result_session_id,
            client_session_id,
            timeout_secs,
            execution_id,
            use_transaction,
        },
    )
    .await;
    match &result {
        Ok(results) => log::info!(
            "[query][execute_multi:done] trace_id={} elapsed_ms={} result_count={} row_counts={:?} backend_execution_times_ms={:?}",
            trace_id,
            started_at.elapsed().as_millis(),
            results.len(),
            results.iter().map(|result| result.rows.len()).collect::<Vec<_>>(),
            results.iter().map(|result| result.execution_time_ms).collect::<Vec<_>>()
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
) -> Result<bool, String> {
    dbx_core::query::close_query_session(&state, &connection_id, &database, &session_id, client_session_id.as_deref())
        .await
}

#[tauri::command]
pub async fn close_client_connection_session(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    client_session_id: String,
) -> Result<bool, String> {
    let database = if database.trim().is_empty() { None } else { Some(database.as_str()) };
    state.close_client_session_pool(&connection_id, database, &client_session_id).await
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
) -> Result<db::QueryResult, String> {
    dbx_core::query::execute_statements_in_transaction(
        &state,
        &connection_id,
        &database,
        &statements,
        schema.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn begin_manual_transaction(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<String, String> {
    dbx_core::query::begin_manual_transaction(&state, &connection_id, &database, schema.as_deref()).await
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
