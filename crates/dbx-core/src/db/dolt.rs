use mysql_async::prelude::Queryable;
use std::collections::HashSet;

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::types::DatabaseInfo;

use super::mysql::{get_conn_with_timeout, quote_identifier, MySqlPool};

const ENABLE_BRANCH_DATABASES_SQL: &str = "SET @@dolt_show_branch_databases = 1";
const SHOW_DATABASES_SQL: &str = "SHOW DATABASES";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
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
    Ok(database_infos(query_database_names(&mut conn).await?))
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
                log::debug!("Dolt branch discovery skipped database `{database}`: {error}");
                continue;
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
        .map(|name| DatabaseInfo { name })
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

    #[test]
    fn profile_is_isolated_from_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("Dolt")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::Postgres, Some("dolt")));
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
