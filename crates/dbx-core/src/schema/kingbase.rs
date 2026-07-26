use crate::db;
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
use std::sync::Arc;
use std::time::Duration;

use super::{query_result_cell_string, sql_string};

#[derive(Clone, Copy)]
enum ExtensionCatalog {
    Sys,
    Pg,
}

impl ExtensionCatalog {
    fn catalog_name(self) -> &'static str {
        match self {
            Self::Sys => "sys_catalog",
            Self::Pg => "pg_catalog",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Sys => "sys",
            Self::Pg => "pg",
        }
    }
}

pub(super) fn object_statistics_sql(schema: &str) -> String {
    format!(
        "SELECT c.relname, n.nspname, \
                CAST(CASE WHEN c.reltuples < 0 THEN 0 ELSE c.reltuples END AS BIGINT) AS estimated_rows, \
                CAST(sys_total_relation_size(c.oid) AS BIGINT) AS total_bytes \
         FROM sys_catalog.sys_class c \
         JOIN sys_catalog.sys_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relkind IN ('r','m','f','p') \
         ORDER BY c.relname",
        sql_string(schema),
    )
}

fn list_extensions_sql(schema: Option<&str>, catalog: ExtensionCatalog) -> String {
    let catalog_name = catalog.catalog_name();
    let prefix = catalog.prefix();
    let schema_filter = schema
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|schema| format!("WHERE n.nspname = {}", sql_string(schema)))
        .unwrap_or_default();
    let order_by = if schema_filter.is_empty() { "n.nspname, e.extname" } else { "e.extname" };
    format!(
        "SELECT e.extname, COALESCE(e.extversion, '') AS extversion, d.description, n.nspname \
         FROM {catalog_name}.{prefix}_extension e \
         JOIN {catalog_name}.{prefix}_namespace n ON n.oid = e.extnamespace \
         LEFT JOIN {catalog_name}.{prefix}_description d ON d.objoid = e.oid AND d.objsubid = 0 \
         {schema_filter} \
         ORDER BY {order_by}"
    )
}

fn list_available_extensions_sql(catalog: ExtensionCatalog) -> String {
    let catalog_name = catalog.catalog_name();
    let prefix = catalog.prefix();
    format!(
        "SELECT name, default_version, comment \
         FROM {catalog_name}.{prefix}_available_extensions \
         WHERE installed_version IS NULL \
         ORDER BY name"
    )
}

async fn query_result(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
    database: &str,
    sql: &str,
    max_rows: usize,
    timeout_duration: Option<Duration>,
) -> Result<db::QueryResult, String> {
    let params = agent_execute_query_params(
        sql,
        if database.is_empty() { None } else { Some(database) },
        None,
        QueryExecutionOptions { max_rows: Some(max_rows), ..Default::default() },
    );
    let mut client = client.lock().await;
    client.execute_query_with_timeout(params, timeout_duration).await
}

async fn query_result_with_catalog_fallback(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
    database: &str,
    sys_sql: String,
    pg_sql: String,
    max_rows: usize,
    timeout_duration: Option<Duration>,
) -> Result<db::QueryResult, String> {
    match query_result(client.clone(), database, &sys_sql, max_rows, timeout_duration).await {
        Ok(result) => Ok(result),
        Err(sys_error) => query_result(client, database, &pg_sql, max_rows, timeout_duration)
            .await
            .map_err(|pg_error| format!("{sys_error}; pg_catalog fallback failed: {pg_error}")),
    }
}

pub(super) async fn list_extensions(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
    database: &str,
    schema: Option<&str>,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        list_extensions_sql(schema, ExtensionCatalog::Sys),
        list_extensions_sql(schema, ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(extension_infos_from_query_result(result, true))
}

pub(super) async fn list_available_extensions(
    client: Arc<tokio::sync::Mutex<db::agent_driver::AgentDriverClient>>,
    database: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        list_available_extensions_sql(ExtensionCatalog::Sys),
        list_available_extensions_sql(ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(extension_infos_from_query_result(result, false))
}

fn extension_infos_from_query_result(result: db::QueryResult, include_schema: bool) -> Vec<db::ExtensionInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            let version = query_result_cell_string(&row, 1).unwrap_or_default();
            let comment = query_result_cell_string(&row, 2).filter(|value| !value.trim().is_empty());
            let schema = include_schema.then(|| query_result_cell_string(&row, 3)).flatten();
            Some(db::ExtensionInfo { name, version, comment, schema })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_statistics_sql_uses_native_catalogs() {
        let sql = object_statistics_sql("core's");

        assert!(sql.contains("sys_catalog.sys_class"));
        assert!(sql.contains("sys_catalog.sys_namespace"));
        assert!(sql.contains("sys_total_relation_size"));
        assert!(sql.contains("n.nspname = 'core''s'"));
    }

    #[test]
    fn extension_sql_uses_sys_catalog_and_escapes_schema() {
        let sql = list_extensions_sql(Some("app's"), ExtensionCatalog::Sys);

        assert!(sql.contains("FROM sys_catalog.sys_extension e"));
        assert!(sql.contains("JOIN sys_catalog.sys_namespace n"));
        assert!(sql.contains("LEFT JOIN sys_catalog.sys_description d"));
        assert!(sql.contains("WHERE n.nspname = 'app''s'"));
    }

    #[test]
    fn available_extension_sql_supports_pg_catalog_fallback() {
        let sql = list_available_extensions_sql(ExtensionCatalog::Pg);

        assert!(sql.contains("FROM pg_catalog.pg_available_extensions"));
        assert!(sql.contains("WHERE installed_version IS NULL"));
    }

    #[test]
    fn extension_infos_map_installed_extensions() {
        let result = db::QueryResult {
            columns: vec![
                "extname".to_string(),
                "extversion".to_string(),
                "description".to_string(),
                "nspname".to_string(),
            ],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![vec![
                serde_json::json!("kdb_utils"),
                serde_json::json!("1.0"),
                serde_json::json!("KingBase utilities"),
                serde_json::json!("public"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
        };

        let extensions = extension_infos_from_query_result(result, true);

        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].name, "kdb_utils");
        assert_eq!(extensions[0].version, "1.0");
        assert_eq!(extensions[0].comment.as_deref(), Some("KingBase utilities"));
        assert_eq!(extensions[0].schema.as_deref(), Some("public"));
    }
}
