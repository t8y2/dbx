//! Application-level protection for explicitly interpreted MySQL text.
//! SQL classification is not an authorization sandbox; use SELECT-only grants.
use crate::{
    connection::AppState,
    models::connection::{ConnectionConfig, DatabaseType},
};

pub const READ_ONLY: &str = "MYSQL_DATA_CHARSET_READ_ONLY";
pub const EXPORT_UNSUPPORTED: &str = "MYSQL_DATA_CHARSET_EXPORT_UNSUPPORTED";
pub const TRANSFER_UNSUPPORTED: &str = "MYSQL_DATA_CHARSET_TRANSFER_UNSUPPORTED";
pub const SESSION_CHANGE_UNSUPPORTED: &str = "MYSQL_DATA_CHARSET_SESSION_CHANGE_UNSUPPORTED";

pub fn enabled(config: &ConnectionConfig) -> Result<bool, String> {
    crate::db::mysql::data_charset_for_config(config).map(|charset| charset.is_some())
}

pub async fn enabled_for_connection(state: &AppState, key: &str) -> Result<bool, String> {
    let connection_id = {
        let configs = state.configs.read().await;
        match crate::connection::config_for_pool_key(key, &configs) {
            Some(config) => {
                if enabled(config)? {
                    return Ok(true);
                }
                config.id.clone()
            }
            None => key.to_owned(),
        }
    };
    // Saving a new configuration must not unlock an old, still-running decoded
    // connection. Keep the stricter policy until every old pool/session closes.
    if state
        .with_connection_pools(|pools| {
            pools.iter().any(|(pool_key, pool)| {
                crate::connection::pool_key_belongs_to_connection(pool_key, &connection_id)
                    && matches!(pool, crate::connection::PoolKind::Mysql(pool, _) if pool.data_charset().is_some())
            })
        })
        .await
    {
        return Ok(true);
    }
    Ok(state.transaction_sessions.read().await.values().any(|session| {
        (session.connection_id == connection_id || session.pool_key == key) && session.mysql_data_charset.is_some()
    }))
}

pub async fn reject_operation(state: &AppState, key: &str, error: &str) -> Result<(), String> {
    if enabled_for_connection(state, key).await? {
        return Err(format!(
            "{error}: MySQL dataCharset interpretation is read-only; disable it and reconnect for this operation."
        ));
    }
    Ok(())
}

pub async fn check_export(state: &AppState, key: &str, format: &str) -> Result<(), String> {
    if !matches!(format.to_ascii_lowercase().as_str(), "csv" | "json" | "xlsx") {
        reject_operation(state, key, EXPORT_UNSUPPORTED).await?;
    }
    Ok(())
}

pub fn check_sql(sql: &str, name: &str) -> Result<(), String> {
    for statement in crate::sql::split_sql_statements_for_database(sql, DatabaseType::Mysql) {
        let stripped = crate::query_execution_sql::strip_sql_comments_and_literals(&statement);
        // All manual SET statements are disallowed: aliases, session variables and
        // prepared session changes must not invalidate the UTF8 carrier invariant.
        if stripped
            .trim_start()
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("set"))
        {
            return Err(format!(
                "{SESSION_CHANGE_UNSUPPORTED}: session changes are unavailable with MySQL dataCharset."
            ));
        }
        crate::query_execution_sql::check_read_only(&statement, name, DatabaseType::Mysql)
            .map_err(|error| format!("{READ_ONLY}: {error}"))?;
    }
    // Check the original text as well as split statements: executable MySQL
    // comments must not disappear during statement splitting.
    crate::query_execution_sql::check_read_only(sql, name, DatabaseType::Mysql)
        .map_err(|error| format!("{READ_ONLY}: {error}"))
}
