use mysql_async::prelude::*;
use std::collections::HashSet;

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::types::{ObjectInfo, TableInfo};

use super::mysql::{
    get_conn_with_timeout, get_str_by_name, list_routine_objects, list_tables_show_with_status, quote_value,
    table_infos_to_objects, MySqlPool, TableStatusMeta,
};

pub use super::mysql_compatible::{
    get_columns_show_from as get_catalog_columns, list_catalog_indexes, list_catalogs,
    list_databases_show_from as list_catalog_databases, list_indexes_with_ddl_fallback as list_indexes,
    show_create_table_ddl_from as get_catalog_table_ddl,
};

pub async fn list_catalog_tables(pool: &MySqlPool, catalog: &str, database: &str) -> Result<Vec<TableInfo>, String> {
    match super::mysql_compatible::list_tables_show_from(pool, catalog, database).await {
        Ok(tables) => Ok(tables),
        Err(error) if should_retry_catalog_table_listing(&error) => {
            match super::mysql_compatible::list_databases_show_from(pool, catalog).await {
                Ok(databases) if catalog_database_exists(&databases, database) => {
                    log::debug!(
                        "Treating StarRocks external database `{catalog}`.`{database}` as empty after its qualified table lookup failed: {error}"
                    );
                    Ok(Vec::new())
                }
                _ => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn should_retry_catalog_table_listing(error: &str) -> bool {
    error.to_ascii_lowercase().contains("unknown database")
}

fn catalog_database_exists(databases: &[crate::types::DatabaseInfo], database: &str) -> bool {
    databases.iter().any(|candidate| candidate.name == database)
}

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::StarRocks
        || (*db_type == DatabaseType::Mysql
            && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case("starrocks")))
}

fn materialized_views_sql(database: &str) -> String {
    format!(
        "SELECT TABLE_NAME FROM information_schema.materialized_views WHERE TABLE_SCHEMA = {}",
        quote_value(database)
    )
}

pub(crate) fn materialized_view_definition_sql(database: &str, name: &str) -> String {
    format!(
        "SELECT MATERIALIZED_VIEW_DEFINITION \
         FROM information_schema.materialized_views \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
         LIMIT 1",
        quote_value(database),
        quote_value(name)
    )
}

async fn list_materialized_view_names(pool: &MySqlPool, database: &str) -> Result<HashSet<String>, String> {
    let sql = materialized_views_sql(database);
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|error| error.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|error| error.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "TABLE_NAME").trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .collect())
}

fn merge_materialized_views(
    tables: &mut Vec<TableInfo>,
    materialized_view_names: Result<HashSet<String>, String>,
    database: &str,
) {
    let materialized_view_names = match materialized_view_names {
        Ok(names) => names,
        Err(error) => {
            log::warn!("Skipping materialized view classification for StarRocks database `{database}`: {error}");
            return;
        }
    };

    let known_names: HashSet<String> = tables.iter().map(|table| table.name.clone()).collect();
    for table in tables.iter_mut() {
        if materialized_view_names.contains(&table.name) {
            table.table_type = "MATERIALIZED_VIEW".to_string();
        }
    }

    let mut sorted_names: Vec<&String> = materialized_view_names.iter().collect();
    sorted_names.sort();
    for name in sorted_names {
        if !known_names.contains(name.as_str()) {
            tables.push(TableInfo {
                name: name.clone(),
                table_type: "MATERIALIZED_VIEW".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            });
        }
    }
}

async fn list_tables_with_status(
    pool: &MySqlPool,
    database: &str,
) -> Result<(Vec<TableInfo>, std::collections::HashMap<String, TableStatusMeta>), String> {
    let (tables, materialized_view_names) =
        tokio::join!(list_tables_show_with_status(pool, database), list_materialized_view_names(pool, database));
    let (mut tables, status) = tables?;
    merge_materialized_views(&mut tables, materialized_view_names, database);
    Ok((tables, status))
}

pub async fn list_tables(pool: &MySqlPool, database: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_with_status(pool, database).await.map(|(tables, _)| tables)
}

pub async fn list_table_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let (tables, routines) =
        tokio::join!(list_tables_with_status(pool, database), list_routine_objects(pool, database));
    let (tables, status) = tables?;
    let mut objects = table_infos_to_objects(tables, &status, database);

    match routines {
        Ok(routines) => objects.extend(routines),
        Err(error) => log::warn!("Skipping routines for database `{database}` in object browser: {error}"),
    }

    Ok(objects)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_matches_starrocks_only() {
        assert!(is_profile(&DatabaseType::StarRocks, None));
        assert!(is_profile(&DatabaseType::Mysql, Some("STARROCKS")));
        assert!(!is_profile(&DatabaseType::Mysql, Some("doris")));
        assert!(!is_profile(&DatabaseType::Postgres, Some("starrocks")));
    }

    #[test]
    fn catalog_table_listing_retries_only_unknown_database_errors() {
        assert!(should_retry_catalog_table_listing(
            "ERROR 5501 (3F000): Getting analyzing error. Detail message: Unknown database 'edw_dwt'."
        ));
        assert!(!should_retry_catalog_table_listing("Access denied on database edw_dwt"));
        assert!(!should_retry_catalog_table_listing("Connection timed out"));
    }

    #[test]
    fn catalog_database_existence_requires_an_exact_name_match() {
        let databases = vec![crate::types::DatabaseInfo { name: "edw_dwt".to_string(), ..Default::default() }];

        assert!(catalog_database_exists(&databases, "edw_dwt"));
        assert!(!catalog_database_exists(&databases, "EDW_DWT"));
        assert!(!catalog_database_exists(&databases, "missing"));
    }

    #[test]
    fn materialized_views_are_classified_without_duplicates() {
        let mut tables = vec![table("orders", "BASE TABLE"), table("orders_view", "VIEW"), table("orders_mv", "VIEW")];

        merge_materialized_views(&mut tables, Ok(HashSet::from(["orders_mv".to_string()])), "analytics");

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![("orders", "BASE TABLE"), ("orders_view", "VIEW"), ("orders_mv", "MATERIALIZED_VIEW")]
        );
    }

    #[test]
    fn missing_materialized_views_are_appended_deterministically() {
        let mut tables = vec![table("orders", "BASE TABLE")];
        let names = HashSet::from(["orders_mv".to_string(), "daily_orders_mv".to_string()]);

        merge_materialized_views(&mut tables, Ok(names), "analytics");

        assert_eq!(
            tables.iter().map(|table| (table.name.as_str(), table.table_type.as_str())).collect::<Vec<_>>(),
            vec![
                ("orders", "BASE TABLE"),
                ("daily_orders_mv", "MATERIALIZED_VIEW"),
                ("orders_mv", "MATERIALIZED_VIEW"),
            ]
        );
    }

    #[test]
    fn lookup_failure_preserves_base_table_types() {
        let mut tables = vec![table("orders_mv", "VIEW")];

        merge_materialized_views(&mut tables, Err("permission denied".to_string()), "analytics");

        assert_eq!(tables[0].table_type, "VIEW");
    }

    #[test]
    fn materialized_view_queries_escape_database_and_name() {
        assert_eq!(
            materialized_views_sql("tenant's analytics"),
            "SELECT TABLE_NAME FROM information_schema.materialized_views WHERE TABLE_SCHEMA = 'tenant\\'s analytics'"
        );
        assert_eq!(
            materialized_view_definition_sql("tenant's analytics", "weird'name"),
            "SELECT MATERIALIZED_VIEW_DEFINITION FROM information_schema.materialized_views WHERE TABLE_SCHEMA = 'tenant\\'s analytics' AND TABLE_NAME = 'weird\\'name' LIMIT 1"
        );
    }

    #[test]
    fn object_conversion_preserves_materialized_view_type() {
        let objects = table_infos_to_objects(
            vec![table("orders", "BASE TABLE"), table("orders_view", "VIEW"), table("orders_mv", "MATERIALIZED_VIEW")],
            &std::collections::HashMap::new(),
            "analytics",
        );

        assert_eq!(
            objects.iter().map(|object| (object.name.as_str(), object.object_type.as_str())).collect::<Vec<_>>(),
            vec![("orders", "TABLE"), ("orders_view", "VIEW"), ("orders_mv", "MATERIALIZED_VIEW")]
        );
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
