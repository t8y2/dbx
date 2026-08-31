use mysql_async::prelude::Queryable;
use std::collections::HashSet;

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::types::{DatabaseInfo, TableInfo};

use super::mysql::{get_conn_with_timeout, list_table_names_show_filtered_with_conn, quote_identifier, MySqlPool};

const ENABLE_BRANCH_DATABASES_SQL: &str = "SET @@dolt_show_branch_databases = 1";
// 与设置对称地复位 session 变量：连接从池中取出后是单条会被复用的 session 连接，
// 若不在归还前复位，后续无关的 SHOW DATABASES（其他元数据路径复用同一条连接时）
// 会意外看到 branch 数据库。复位是 best-effort，失败不应让 list_databases 整体失败。
const DISABLE_BRANCH_DATABASES_SQL: &str = "SET @@dolt_show_branch_databases = 0";
const SHOW_DATABASES_SQL: &str = "SHOW DATABASES";
const ENABLE_SYSTEM_TABLES_SQL: &str = "SET @@dolt_show_system_tables = 1";
const DISABLE_SYSTEM_TABLES_SQL: &str = "SET @@dolt_show_system_tables = 0";
const SHOW_SYSTEM_TABLES_CONFIG_KEY: &str = "doltShowSystemTables";
const SYSTEM_TABLE_PREFIX: &str = "dolt";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn system_tables_visible(config: &ConnectionConfig) -> bool {
    is_config(config)
        && config
            .external_config
            .as_ref()
            .and_then(|value| value.get(SHOW_SYSTEM_TABLES_CONFIG_KEY))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

pub fn requests_system_tables(include_patterns: Option<&[String]>) -> bool {
    include_patterns.is_some_and(|patterns| patterns.iter().any(|pattern| pattern.trim().eq_ignore_ascii_case("dolt%")))
}

fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case("dolt"))
}

pub async fn list_databases(pool: &MySqlPool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    if let Err(error) = conn.query_drop(ENABLE_BRANCH_DATABASES_SQL).await {
        log::debug!("Dolt branch database system variable is unavailable; falling back to dolt_branches: {error}");
        return list_databases_from_branches(&mut conn).await;
    }
    let databases = query_database_names(&mut conn).await?;
    // 主路径成功读完 SHOW DATABASES 后，归还连接前复位 session 变量，
    // 避免该连接被复用于无关元数据查询时仍残留 branch 数据库可见性。
    if let Err(error) = conn.query_drop(DISABLE_BRANCH_DATABASES_SQL).await {
        log::warn!("Failed to reset Dolt branch database session variable before returning connection: {error}");
    }
    Ok(database_infos(databases))
}

pub async fn list_system_tables(
    pool: &MySqlPool,
    database: &str,
    filter: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    // The visibility flag is session-scoped, so setup, metadata lookup, and
    // cleanup must use the same pooled connection.
    let mut conn = get_conn_with_timeout(pool, super::connection_timeout()).await?;
    conn.query_drop(ENABLE_SYSTEM_TABLES_SQL).await.map_err(|error| error.to_string())?;
    let server_filter = filter.map(str::trim).filter(|filter| !filter.is_empty()).unwrap_or(SYSTEM_TABLE_PREFIX);
    let tables = list_table_names_show_filtered_with_conn(&mut conn, database, Some(server_filter), &[])
        .await
        .map(retain_system_tables);
    if let Err(error) = conn.query_drop(DISABLE_SYSTEM_TABLES_SQL).await {
        log::warn!("Failed to reset Dolt system table session variable before returning connection: {error}");
    }
    tables
}

fn retain_system_tables(mut tables: Vec<TableInfo>) -> Vec<TableInfo> {
    tables.retain(|table| table.name.to_ascii_lowercase().starts_with(SYSTEM_TABLE_PREFIX));
    tables
}

async fn list_databases_from_branches(conn: &mut mysql_async::Conn) -> Result<Vec<DatabaseInfo>, String> {
    let base_names = query_database_names(conn).await?;
    let discovery_names: Vec<String> =
        base_names.iter().filter(|name| is_branch_discovery_database(name)).cloned().collect();
    let mut seen: HashSet<String> = base_names.iter().cloned().collect();
    let mut names = base_names;

    for database in discovery_names {
        let branches: Vec<String> = match conn.query(list_branches_sql(&database)).await {
            Ok(branches) => branches,
            Err(error) => {
                // fallback 进入这里说明实例不支持 dolt_show_branch_databases 系统变量。
                // 首个非系统库的 dolt_branches 查询报错即可判定该实例并非 Dolt
                // （可能是同一实例上混用的纯 MySQL 库），逐库试探只会对每个普通库
                // 产生一次无效报错噪音。首次失败即整体降级为纯 SHOW DATABASES 结果，
                // 不再继续试探剩余库。注意区分「查询报错（非 Dolt）」与「查询成功但为空
                // （是 Dolt 但无 branch）」：只有前者触发降级，后者继续遍历后续库。
                log::debug!(
                    "Dolt branch discovery failed on `{database}`, treating instance as non-Dolt and falling back to plain SHOW DATABASES: {error}"
                );
                return Ok(database_infos(names));
            }
        };
        for branch in branches {
            let revision = format!("{database}/{}", branch.trim());
            if !branch.trim().is_empty() && seen.insert(revision.clone()) {
                names.push(revision);
            }
        }
    }

    Ok(database_infos(names))
}

async fn query_database_names(conn: &mut mysql_async::Conn) -> Result<Vec<String>, String> {
    conn.query(SHOW_DATABASES_SQL).await.map_err(|error| error.to_string())
}

fn database_infos(names: Vec<String>) -> Vec<DatabaseInfo> {
    names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .map(|name| DatabaseInfo { name, ..Default::default() })
        .collect()
}

fn is_branch_discovery_database(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    !normalized.is_empty()
        && !normalized.contains('/')
        && !matches!(normalized.as_str(), "information_schema" | "mysql" | "performance_schema" | "sys")
}

fn list_branches_sql(database: &str) -> String {
    format!("SELECT name FROM {}.dolt_branches ORDER BY name", quote_identifier(database))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dolt_config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "dolt",
            "name": "Dolt",
            "db_type": "mysql",
            "driver_profile": "dolt",
            "host": "127.0.0.1",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": "app"
        }))
        .unwrap()
    }

    #[test]
    fn profile_is_isolated_from_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("Dolt")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::Postgres, Some("dolt")));
    }

    #[test]
    fn system_table_visibility_uses_dolt_profile_config_only() {
        let mut config = dolt_config();
        assert!(!system_tables_visible(&config));

        config.external_config = Some(serde_json::json!({ "doltShowSystemTables": true }));
        assert!(system_tables_visible(&config));

        config.driver_profile = Some("mysql".to_string());
        assert!(!system_tables_visible(&config));
    }

    #[test]
    fn system_table_requests_require_the_dedicated_include_pattern() {
        assert!(requests_system_tables(Some(&["dolt%".to_string()])));
        assert!(requests_system_tables(Some(&[" DOLT% ".to_string()])));
        assert!(!requests_system_tables(Some(&["%dolt%".to_string()])));
        assert!(!requests_system_tables(Some(&[])));
        assert!(!requests_system_tables(None));
    }

    #[test]
    fn system_table_results_exclude_ordinary_tables_after_show_fallbacks() {
        let tables = vec![
            TableInfo {
                name: "dolt_log".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "DOLT_BRANCHES".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "orders".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("ordinary".to_string()),
                parent_schema: None,
                parent_name: None,
            },
        ];

        assert_eq!(
            retain_system_tables(tables).into_iter().map(|table| table.name).collect::<Vec<_>>(),
            vec!["dolt_log", "DOLT_BRANCHES"]
        );
    }

    #[test]
    fn fallback_only_discovers_base_user_databases() {
        assert!(is_branch_discovery_database("inventory"));
        assert!(!is_branch_discovery_database("inventory/main"));
        assert!(!is_branch_discovery_database("information_schema"));
        assert!(!is_branch_discovery_database("mysql"));
    }

    #[test]
    fn fallback_quotes_database_identifier() {
        assert_eq!(
            list_branches_sql("inventory`archive"),
            "SELECT name FROM `inventory``archive`.dolt_branches ORDER BY name"
        );
    }
}
