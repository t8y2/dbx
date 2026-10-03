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
    client: Arc<db::agent_driver::PooledAgentClient>,
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
    client: Arc<db::agent_driver::PooledAgentClient>,
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
    client: Arc<db::agent_driver::PooledAgentClient>,
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
    client: Arc<db::agent_driver::PooledAgentClient>,
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

/// Lists event triggers over a Kingbase agent connection. KingbaseES ships
/// `pg_event_trigger`, so the same catalog query works; the sys/pg catalog
/// fallback mirrors `list_extensions`. `tags`/`source` are not fetched over the
/// agent path (text[] marshalling + `pg_get_eventtriggerdef` availability vary),
/// so the details dialog's field-driven DDL rebuild covers them.
pub(super) async fn list_event_triggers(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::EventTriggerInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        event_triggers_sql(ExtensionCatalog::Sys),
        event_triggers_sql(ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(event_trigger_infos_from_query_result(result))
}

fn event_triggers_sql(catalog: ExtensionCatalog) -> String {
    let cat = catalog.catalog_name();
    format!(
        "SELECT e.evtname, \
         e.evtevent, \
         COALESCE(r.rolname, '') AS owner, \
         COALESCE(format('%I.%I(%s)', pn.nspname, p.proname, pg_get_function_arguments(p.oid)), '') AS function, \
         e.evtenabled::text AS enabled, \
         COALESCE(array_to_string(e.evttags, ','), '') AS tags, \
         obj_description(e.oid, 'pg_event_trigger') AS comment, \
         NULL::text AS source \
         FROM {cat}.pg_event_trigger e \
         LEFT JOIN {cat}.pg_roles r ON r.oid = e.evtowner \
         LEFT JOIN {cat}.pg_proc p ON p.oid = e.evtfoid \
         LEFT JOIN {cat}.pg_namespace pn ON pn.oid = p.pronamespace \
         ORDER BY e.evtname"
    )
}

fn query_result_cell_string_list(row: &[serde_json::Value], index: usize) -> Option<Vec<String>> {
    let cell = row.get(index)?;
    match cell {
        serde_json::Value::Array(arr) => Some(arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
        serde_json::Value::String(s) if s.is_empty() => None,
        serde_json::Value::String(s) => {
            Some(s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect())
        }
        _ => None,
    }
}

fn event_trigger_infos_from_query_result(result: db::QueryResult) -> Vec<db::EventTriggerInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            Some(db::EventTriggerInfo {
                name,
                event: query_result_cell_string(&row, 1).unwrap_or_default(),
                owner: query_result_cell_string(&row, 2).filter(|s| !s.is_empty()),
                function: query_result_cell_string(&row, 3).filter(|s| !s.is_empty()),
                enabled: query_result_cell_string(&row, 4).filter(|s| !s.is_empty()),
                tags: query_result_cell_string_list(&row, 5).filter(|v| !v.is_empty()),
                comment: query_result_cell_string(&row, 6).filter(|s| !s.is_empty()),
                source: None,
            })
        })
        .collect()
}

/// Lists Foreign Data Wrappers over a Kingbase agent connection.
/// Reuses the sys/pg catalog fallback pattern from `list_extensions`.
pub(super) async fn list_foreign_data_wrappers(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ForeignDataWrapperInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        fdw_options_sql(ExtensionCatalog::Sys),
        fdw_options_sql(ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(fdw_infos_from_query_result(result))
}

pub(super) async fn list_foreign_servers(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ForeignServerInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        foreign_servers_sql(ExtensionCatalog::Sys),
        foreign_servers_sql(ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(server_infos_from_query_result(result))
}

pub(super) async fn list_user_mappings(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::UserMappingInfo>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        user_mappings_sql(ExtensionCatalog::Sys),
        user_mappings_sql(ExtensionCatalog::Pg),
        10_000,
        timeout_duration,
    )
    .await?;
    Ok(mapping_infos_from_query_result(result))
}

fn fdw_options_sql(catalog: ExtensionCatalog) -> String {
    let cat = catalog.catalog_name();
    format!(
        "SELECT fdw.fdwname, \
         COALESCE(r.rolname, '') AS owner, \
         COALESCE(format('%I.%I', hn.nspname, h.proname), '') AS handler, \
         COALESCE(format('%I.%I', vn.nspname, v.proname), '') AS validator, \
         fdw.fdwoptions AS options, \
         obj_description(fdw.oid, 'pg_foreign_data_wrapper') AS comment \
         FROM {cat}.pg_foreign_data_wrapper fdw \
         LEFT JOIN {cat}.pg_roles r ON r.oid = fdw.fdwowner \
         LEFT JOIN {cat}.pg_proc h ON h.oid = fdw.fdwhandler \
         LEFT JOIN {cat}.pg_namespace hn ON hn.oid = h.pronamespace \
         LEFT JOIN {cat}.pg_proc v ON v.oid = fdw.fdwvalidator \
         LEFT JOIN {cat}.pg_namespace vn ON vn.oid = v.pronamespace \
         ORDER BY fdw.fdwname"
    )
}

fn foreign_servers_sql(catalog: ExtensionCatalog) -> String {
    let cat = catalog.catalog_name();
    format!(
        "SELECT srv.srvname, \
         COALESCE(r.rolname, '') AS owner, \
         fdw.fdwname AS foreign_data_wrapper, \
         srv.srvtype AS server_type, \
         srv.srvversion AS server_version, \
         srv.srvoptions AS options, \
         obj_description(srv.oid, 'pg_foreign_server') AS comment \
         FROM {cat}.pg_foreign_server srv \
         LEFT JOIN {cat}.pg_roles r ON r.oid = srv.srvowner \
         LEFT JOIN {cat}.pg_foreign_data_wrapper fdw ON fdw.oid = srv.srvfdw \
         ORDER BY srv.srvname"
    )
}

fn user_mappings_sql(catalog: ExtensionCatalog) -> String {
    // pg_user_mappings is a public view; even on Kingbase it exists.
    // Use the same view name; the catalog prefix only affects tables.
    let _cat = catalog.catalog_name();
    "SELECT um.umid::text AS oid, \
       COALESCE(um.usename, '') AS user_name, \
       um.srvname AS server_name, \
       um.umoptions AS options \
     FROM pg_catalog.pg_user_mappings um \
     ORDER BY um.srvname, um.usename"
        .to_string()
}

fn query_result_cell_option_pairs(row: &[serde_json::Value], index: usize) -> Vec<(String, String)> {
    let cell = match row.get(index) {
        Some(v) => v,
        None => return vec![],
    };
    let strings: Vec<String> = match cell {
        serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => return vec![],
    };
    strings
        .into_iter()
        .filter_map(|option| option.split_once('=').map(|(key, value)| (key.to_string(), value.to_string())))
        .collect()
}

fn fdw_infos_from_query_result(result: db::QueryResult) -> Vec<db::ForeignDataWrapperInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            Some(db::ForeignDataWrapperInfo {
                name,
                owner: query_result_cell_string(&row, 1).filter(|s| !s.is_empty()),
                handler: query_result_cell_string(&row, 2).filter(|s| !s.is_empty()),
                validator: query_result_cell_string(&row, 3).filter(|s| !s.is_empty()),
                options: query_result_cell_option_pairs(&row, 4),
                comment: query_result_cell_string(&row, 5).filter(|s| !s.is_empty()),
            })
        })
        .collect()
}

fn server_infos_from_query_result(result: db::QueryResult) -> Vec<db::ForeignServerInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            Some(db::ForeignServerInfo {
                name,
                owner: query_result_cell_string(&row, 1).filter(|s| !s.is_empty()),
                foreign_data_wrapper: query_result_cell_string(&row, 2).unwrap_or_default(),
                server_type: query_result_cell_string(&row, 3).filter(|s| !s.is_empty()),
                server_version: query_result_cell_string(&row, 4).filter(|s| !s.is_empty()),
                options: query_result_cell_option_pairs(&row, 5),
                comment: query_result_cell_string(&row, 6).filter(|s| !s.is_empty()),
            })
        })
        .collect()
}

fn mapping_infos_from_query_result(result: db::QueryResult) -> Vec<db::UserMappingInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let oid = query_result_cell_string(&row, 0)?;
            Some(db::UserMappingInfo {
                oid,
                user_name: query_result_cell_string(&row, 1).unwrap_or_default(),
                server_name: query_result_cell_string(&row, 2).unwrap_or_default(),
                options: query_result_cell_option_pairs(&row, 3),
            })
        })
        .collect()
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
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![
                serde_json::json!("kdb_utils"),
                serde_json::json!("1.0"),
                serde_json::json!("KingBase utilities"),
                serde_json::json!("public"),
            ]],
            affected_rows: 0,
            execution_time_ms: 0,
            server_execute_time_us: None,
            query_timings_ms: None,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        let extensions = extension_infos_from_query_result(result, true);

        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].name, "kdb_utils");
        assert_eq!(extensions[0].version, "1.0");
        assert_eq!(extensions[0].comment.as_deref(), Some("KingBase utilities"));
        assert_eq!(extensions[0].schema.as_deref(), Some("public"));
    }
}
