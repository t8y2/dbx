use mysql_async::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::types::{ObjectInfo, TableInfo};

use super::mysql::{
    get_conn_with_timeout, get_str_by_name, list_routine_objects, list_tables_show_with_status, quote_value,
    table_infos_to_objects, MySqlPool, TableStatusMeta,
};

pub const DRIVER_PROFILE: &str = "oceanbase";

fn materialized_views_sql(database: &str) -> String {
    format!("SELECT MVIEW_NAME FROM oceanbase.DBA_MVIEWS WHERE OWNER = {}", quote_value(database))
}

async fn list_materialized_view_names(pool: &MySqlPool, database: &str) -> Result<HashSet<String>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(materialized_views_sql(database)).await.map_err(|error| error.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|error| error.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "MVIEW_NAME").trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .collect())
}

fn is_materialized_view_type(table_type: &str) -> bool {
    let normalized = table_type.to_ascii_uppercase().replace('_', " ");
    normalized.contains("MATERIALIZED") && normalized.contains("VIEW")
}

fn merge_materialized_views(
    tables: &mut Vec<TableInfo>,
    materialized_view_names: Result<HashSet<String>, String>,
    database: &str,
) {
    let materialized_view_names = match materialized_view_names {
        Ok(names) => names,
        Err(error) => {
            log::warn!("Skipping materialized view classification for OceanBase database `{database}`: {error}");
            HashSet::new()
        }
    };

    for table in tables.iter_mut() {
        if is_materialized_view_type(&table.table_type)
            || materialized_view_names.iter().any(|name| name.eq_ignore_ascii_case(&table.name))
        {
            table.table_type = "VIEW".to_string();
        }
    }

    let mut known_names: HashSet<String> = tables.iter().map(|table| table.name.to_ascii_lowercase()).collect();
    let mut missing_names = materialized_view_names.into_iter().collect::<Vec<_>>();
    missing_names.sort();
    for name in missing_names {
        if known_names.insert(name.to_ascii_lowercase()) {
            tables.push(TableInfo {
                name,
                table_type: "VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            });
        }
    }
    tables.sort_by(|left, right| left.name.cmp(&right.name));
}

async fn list_tables_with_status(
    pool: &MySqlPool,
    database: &str,
) -> Result<(Vec<TableInfo>, HashMap<String, TableStatusMeta>), String> {
    let (tables, materialized_view_names) =
        tokio::join!(list_tables_show_with_status(pool, database), list_materialized_view_names(pool, database));
    let (mut tables, status) = tables?;
    merge_materialized_views(&mut tables, materialized_view_names, database);
    Ok((tables, status))
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_with_status(pool, database).await.map(|(tables, _)| tables)
}

pub async fn list_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let (tables, routines) =
        tokio::join!(list_tables_with_status(pool, database), list_routine_objects(pool, database));
    let (tables, status) = tables?;
    let mut objects = table_infos_to_objects(tables, &status, database);

    match routines {
        Ok(routines) => objects.extend(routines),
        Err(error) => log::warn!("Skipping routines for OceanBase database `{database}` in object browser: {error}"),
    }

    Ok(objects)
}

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql
        && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(DRIVER_PROFILE))
}

pub fn query_timeout_sql(config: &ConnectionConfig, timeout_secs: u64) -> Option<String> {
    if !is_config(config) || timeout_secs == 0 {
        return None;
    }
    Some(format!("SET ob_query_timeout = {}", timeout_secs.saturating_mul(1_000_000)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_isolated_from_oracle_mode_and_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("OceanBase")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::OceanbaseOracle, Some("oceanbase")));
    }

    #[test]
    fn query_timeout_uses_microseconds_and_saturates() {
        let mut config = test_config();
        assert_eq!(query_timeout_sql(&config, 30), Some("SET ob_query_timeout = 30000000".to_string()));
        assert_eq!(query_timeout_sql(&config, u64::MAX), Some(format!("SET ob_query_timeout = {}", u64::MAX)));

        config.driver_profile = None;
        assert_eq!(query_timeout_sql(&config, 30), None);
    }

    #[test]
    fn materialized_views_are_visible_as_mysql_views_without_retyping_regular_objects() {
        let mut tables =
            vec![table("orders", "BASE TABLE"), table("orders_view", "VIEW"), table("orders_mv", "BASE TABLE")];

        merge_materialized_views(
            &mut tables,
            Ok(HashSet::from(["orders_mv".to_string(), "daily_orders_mv".to_string()])),
            "analytics",
        );

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("daily_orders_mv", "VIEW"), ("orders", "BASE TABLE"), ("orders_mv", "VIEW"), ("orders_view", "VIEW"),]
        );

        let objects = table_infos_to_objects(tables, &HashMap::new(), "analytics");
        assert_eq!(
            objects.iter().map(|object| (object.name.as_str(), object.object_type.as_str())).collect::<Vec<_>>(),
            vec![("daily_orders_mv", "VIEW"), ("orders", "TABLE"), ("orders_mv", "VIEW"), ("orders_view", "VIEW"),]
        );
    }

    #[test]
    fn materialized_view_names_are_case_insensitive_and_not_duplicated() {
        let mut tables = vec![table("Orders_MV", "BASE TABLE")];

        merge_materialized_views(
            &mut tables,
            Ok(HashSet::from(["orders_mv".to_string(), "daily_mv".to_string()])),
            "analytics",
        );

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("Orders_MV", "VIEW"), ("daily_mv", "VIEW")]
        );
    }

    #[test]
    fn materialized_view_catalog_failures_preserve_show_rows() {
        let mut tables = vec![table("orders", "BASE TABLE"), table("orders_mv", "MATERIALIZED VIEW")];

        merge_materialized_views(&mut tables, Err("permission denied".to_string()), "analytics");

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("orders", "BASE TABLE"), ("orders_mv", "VIEW")]
        );
    }

    #[test]
    fn empty_materialized_view_metadata_does_not_retype_regular_objects() {
        let mut tables = vec![table("orders", "BASE TABLE"), table("orders_view", "VIEW")];

        merge_materialized_views(&mut tables, Ok(HashSet::new()), "analytics");

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("orders", "BASE TABLE"), ("orders_view", "VIEW")]
        );
    }

    #[test]
    fn materialized_view_catalog_sql_escapes_database_names() {
        assert_eq!(
            materialized_views_sql("tenant's analytics"),
            "SELECT MVIEW_NAME FROM oceanbase.DBA_MVIEWS WHERE OWNER = 'tenant\\'s analytics'"
        );
    }

    fn test_config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "oceanbase",
            "name": "OceanBase",
            "db_type": "mysql",
            "driver_profile": "oceanbase",
            "host": "127.0.0.1",
            "port": 2883,
            "username": "root",
            "password": "",
            "database": "test"
        }))
        .unwrap()
    }

    fn table(name: &str, table_type: &str) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }
}
