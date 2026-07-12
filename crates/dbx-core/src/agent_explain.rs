use serde_json::Value;

use crate::connection::{AppState, PoolKind};
use crate::query_execution_sql::{is_safe_dameng_autotrace_sql, is_safe_explain_sql};

pub async fn get_agent_explain_info_core(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
    schema: Option<&str>,
    sql: &str,
    mode: Option<&str>,
) -> Result<String, String> {
    let mode = mode.unwrap_or("explain");
    let safe = if mode.eq_ignore_ascii_case("autotrace") {
        is_safe_dameng_autotrace_sql(sql)
    } else {
        is_safe_explain_sql(sql)
    };
    if !safe {
        return Err("unsafe".to_string());
    }

    let database_for_pool = database.filter(|value| !value.trim().is_empty());
    state.get_or_create_pool(connection_id, database_for_pool).await?;

    let client = {
        let connections = state.connections.read().await;
        let pool = connections.get(connection_id).ok_or_else(|| "Connection not found".to_string())?;
        match pool {
            PoolKind::Agent(client) => client.clone(),
            _ => return Err("Connection is not an agent-based connection".to_string()),
        }
    };

    let timeout_secs = {
        let configs = state.configs.read().await;
        configs.get(connection_id).ok_or_else(|| "Connection config not found".to_string())?.query_timeout_secs
    };

    let params = serde_json::json!({
        "sql": sql,
        "database": database.unwrap_or_default(),
        "schema": schema.unwrap_or_default(),
        "timeoutSecs": timeout_secs as i64,
        "mode": mode,
    });
    let mut client = client.lock().await;
    let result: Value = client.get_explain_info(params).await?;
    decode_agent_explain_result(result)
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
}
