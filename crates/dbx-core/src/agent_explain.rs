use std::time::Duration;

use serde_json::Value;

use crate::connection::{AppState, PoolKind};
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query_execution_sql::{is_safe_dameng_autotrace_sql, is_safe_explain_sql_for_database};

pub async fn get_agent_explain_info_core(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    schema: Option<&str>,
    sql: &str,
    mode: Option<&str>,
) -> Result<String, String> {
    let mode = mode.unwrap_or("explain");
    let (database_type, timeout_secs) = {
        let configs = state.configs.read().await;
        let config = configs.get(connection_id).ok_or_else(|| "Connection config not found".to_string())?.clone();
        let database_type = explain_database_type(&config);
        let timeout_secs = config.effective_query_timeout_secs();
        (database_type, timeout_secs)
    };
    if !is_safe_agent_explain_sql(sql, mode, database_type) {
        return Err("unsafe".to_string());
    }

    let database_for_pool = database.filter(|value| !value.trim().is_empty());
    let pool_key = state.get_or_create_pool(connection_id, database_for_pool).await?;

    enum ExplainTarget {
        Agent(std::sync::Arc<crate::db::agent_driver::PooledAgentClient>),
        External {
            config: std::sync::Arc<ConnectionConfig>,
            session: std::sync::Arc<crate::plugins::PluginDriverSession>,
        },
    }

    let target = {
        let connections = state.connections.read().await;
        let pool = connections.get(&pool_key).ok_or_else(|| "Connection not found".to_string())?;
        match pool {
            PoolKind::Agent(client) => ExplainTarget::Agent(client.clone()),
            PoolKind::ExternalDriver { config, session, .. } => {
                ExplainTarget::External { config: config.clone(), session: session.clone() }
            }
            _ => return Err("Connection is not an agent-based connection".to_string()),
        }
    };

    let params = serde_json::json!({
        "sql": sql,
        "database": database.unwrap_or_default(),
        "schema": schema.unwrap_or_default(),
        "timeoutSecs": timeout_secs as i64,
        "mode": mode,
    });
    let result: Value = match target {
        ExplainTarget::Agent(client) => client.lock().await.get_explain_info(params).await?,
        ExplainTarget::External { config, session } => {
            let mut params = params;
            params["connection"] = serde_json::to_value(config.as_ref()).map_err(|error| error.to_string())?;
            let timeout = (timeout_secs > 0).then(|| Duration::from_secs(timeout_secs));
            session.invoke_with_timeout("getExplainInfo", params, timeout).await?
        }
    };
    decode_agent_explain_result(result)
}

fn explain_database_type(config: &ConnectionConfig) -> DatabaseType {
    if config.db_type != DatabaseType::Jdbc {
        return config.db_type;
    }
    let oracle_hint = [
        config.connection_string.as_deref(),
        config.jdbc_driver_class.as_deref(),
        config.driver_profile.as_deref(),
        config.driver_label.as_deref(),
        config.database_info.as_ref().and_then(|info| info.product_name.as_deref()),
        config.database_info.as_ref().and_then(|info| info.server_comment.as_deref()),
        config.database_info.as_ref().and_then(|info| info.driver_name.as_deref()),
    ]
    .into_iter()
    .flatten()
    .chain(config.jdbc_driver_paths.iter().map(String::as_str))
    .any(|value| value.to_ascii_lowercase().contains("oracle"));
    if oracle_hint {
        DatabaseType::Oracle
    } else {
        DatabaseType::Jdbc
    }
}

fn is_safe_agent_explain_sql(sql: &str, mode: &str, database_type: DatabaseType) -> bool {
    if mode.eq_ignore_ascii_case("autotrace") {
        is_safe_dameng_autotrace_sql(sql)
    } else {
        is_safe_explain_sql_for_database(sql, Some(database_type))
    }
}

fn decode_agent_explain_result(result: Value) -> Result<String, String> {
    match result {
        Value::String(plan) => Ok(plan),
        Value::Object(object) => Ok(object.get("plan").and_then(Value::as_str).unwrap_or_default().to_string()),
        value => Err(format!("Unexpected result type from getExplainInfo: {value:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::connection::PoolKind;
    use crate::models::connection::DatabaseType;
    #[cfg(unix)]
    use crate::plugins::{
        InstalledPlugin, PluginDriverManifest, PluginDriverSession, PluginManifest, PluginRuntimeEnv,
    };
    #[cfg(unix)]
    use std::sync::Arc;

    #[test]
    fn allows_oracle_dml_explain_without_relaxing_autotrace() {
        let update = "UPDATE AA_PAY_VOUCHER_TEMP t SET t.AGENCY_ID = '1'";

        assert!(is_safe_agent_explain_sql(update, "explain", DatabaseType::Oracle));
        assert!(!is_safe_agent_explain_sql(update, "autotrace", DatabaseType::Oracle));
        assert!(!is_safe_agent_explain_sql(update, "explain", DatabaseType::Dameng));
        assert!(!is_safe_agent_explain_sql("DROP TABLE AA_PAY_VOUCHER_TEMP", "explain", DatabaseType::Oracle));
    }

    #[test]
    fn decodes_string_and_object_agent_explain_results() {
        assert_eq!(decode_agent_explain_result(Value::String("plan text".to_string())).unwrap(), "plan text");
        assert_eq!(
            decode_agent_explain_result(serde_json::json!({ "plan": "object plan", "has_actual_stats": false }))
                .unwrap(),
            "object plan"
        );
        assert!(decode_agent_explain_result(serde_json::json!(["unexpected"])).is_err());
    }

    #[test]
    fn infers_only_oracle_custom_jdbc_for_oracle_explain_safety() {
        let oracle: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "oracle-jdbc",
            "name": "Oracle JDBC",
            "db_type": "jdbc",
            "host": "127.0.0.1",
            "port": 1521,
            "username": "system",
            "password": "oracle",
            "connection_string": "jdbc:oracle:thin:@127.0.0.1:1521:XE"
        }))
        .unwrap();
        let unknown: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "unknown-jdbc",
            "name": "Unknown JDBC",
            "db_type": "jdbc",
            "host": "127.0.0.1",
            "port": 9000,
            "username": "user",
            "password": "secret",
            "connection_string": "jdbc:unknown://127.0.0.1:9000/app"
        }))
        .unwrap();

        assert_eq!(explain_database_type(&oracle), DatabaseType::Oracle);
        assert_eq!(explain_database_type(&unknown), DatabaseType::Jdbc);
        assert!(is_safe_agent_explain_sql("UPDATE T SET C = 1", "explain", explain_database_type(&oracle)));
        assert!(!is_safe_agent_explain_sql("UPDATE T SET C = 1", "explain", explain_database_type(&unknown)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn routes_oracle_jdbc_explain_through_the_external_driver_session() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("dbx-agent-explain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let executable = dir.join("plugin.sh");
        std::fs::write(
            &executable,
            "#!/bin/sh\nwhile IFS= read -r line; do\n  id=$(printf '%s' \"$line\" | sed -E 's/.*\"id\":([0-9]+).*/\\1/')\n  printf '{\"id\":%s,\"result\":{\"plan\":\"TABLE ACCESS FULL DUAL\"}}\\n' \"$id\"\ndone\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let plugin = InstalledPlugin {
            manifest: PluginManifest {
                id: "jdbc".to_string(),
                name: "JDBC".to_string(),
                version: "test".to_string(),
                protocol_version: 1,
                description: String::new(),
                executable: Some("plugin.sh".to_string()),
                drivers: vec![PluginDriverManifest {
                    id: "jdbc".to_string(),
                    label: "JDBC".to_string(),
                    kind: "external".to_string(),
                    database_type: Some("jdbc".to_string()),
                }],
            },
            path: dir.clone(),
        };
        let session = Arc::new(
            PluginDriverSession::start_for_test(plugin, "jdbc".to_string(), PluginRuntimeEnv::default()).await.unwrap(),
        );
        let config: crate::models::connection::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "oracle-jdbc",
            "name": "Oracle JDBC",
            "db_type": "jdbc",
            "host": "127.0.0.1",
            "port": 1521,
            "username": "system",
            "password": "oracle",
            "database": "ORCL",
            "connection_string": "jdbc:oracle:thin:@127.0.0.1:1521:ORCL",
            "jdbc_driver_class": "oracle.jdbc.OracleDriver",
            "query_timeout_secs": 30
        }))
        .unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        state.configs.write().await.insert(config.id.clone(), config.clone());
        state.connections.write().await.insert(
            "oracle-jdbc".to_string(),
            PoolKind::ExternalDriver {
                driver_id: "jdbc".to_string(),
                config: Arc::new(config),
                session: session.clone(),
            },
        );

        let plan = get_agent_explain_info_core(
            &state,
            "oracle-jdbc",
            Some("ORCL"),
            Some("SYSTEM"),
            "UPDATE T SET C = 1",
            Some("explain"),
        )
        .await
        .unwrap();

        assert_eq!(plan, "TABLE ACCESS FULL DUAL");
        session.shutdown().await;
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
