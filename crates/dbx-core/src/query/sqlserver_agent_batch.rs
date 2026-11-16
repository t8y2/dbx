//! SQL Server Agent batches keep their variable scope and consume every JDBC
//! response. A cursor session still owns a single SELECT's pagination.
use super::*;

pub(super) fn requires_complete_results(sql: &str, options: &QueryExecutionOptions) -> bool {
    if options.result_session_id.is_some() {
        return false;
    }
    if options.page_size.is_none() {
        return true;
    }
    // Cursor fallback can also be requested for scripts that the pagination
    // parser cannot rewrite. Only a single query can safely own that cursor;
    // DECLARE/EXEC/GO and multiple SELECTs must collect the whole batch instead.
    !matches!(Parser::parse_sql(&MsSqlDialect {}, sql).as_deref(), Ok([Statement::Query(_)]))
}

/// Agents released before `returnAllResults` existed ignore the flag and
/// reply with the first result set as a single object instead of a list.
fn batch_results(value: serde_json::Value) -> Result<Vec<db::QueryResult>, AgentCallError> {
    let message = if value.is_object() {
        "The installed sqlserver-legacy driver is too old to return every result of a batch. \
         Update it in the Driver Manager and run the query again."
            .to_string()
    } else {
        match serde_json::from_value(value) {
            Ok(results) => return Ok(results),
            Err(error) => format!("Failed to deserialize agent result: {error}"),
        }
    };
    Err(AgentCallError::ContractViolation {
        rpc_code: None,
        message,
        reason: crate::db::agent_driver::ContractViolationReason::InvalidResult,
    })
}

pub(super) async fn execute(
    state: &AppState,
    pool_key: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<db::QueryResult>, QueryExecutionError> {
    check_read_only_for_connection(state, pool_key, sql).await?;
    let client = match state.pool_handle(pool_key).await {
        Some(PoolKind::Agent(client)) => client,
        _ => return Err("SQL Server Agent connection is no longer available".into()),
    };
    let execution_sql = sql_for_execution_context_with_identifier_quote(
        Some(DatabaseType::SqlServer),
        sql,
        schema,
        client.identifier_quote(),
    );
    let mut params = agent_execute_query_params(
        &execution_sql,
        Some(database),
        schema_for_execution_context(Some(DatabaseType::SqlServer), schema),
        options.clone(),
    );
    params["returnAllResults"] = serde_json::json!(true);
    let result: Result<Vec<db::QueryResult>, AgentCallError> = async {
        let lock_started = std::time::Instant::now();
        let mut locked = match cancel_token.as_ref() {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(AgentCallError::Canceled {
                        stage: AgentErrorStage::Cancel,
                        operation_outcome: AgentOperationOutcome::Unknown,
                    }),
                    guard = client.lock() => guard,
                }
            }
            None => client.lock().await,
        };
        let lock_ms = lock_started.elapsed().as_secs_f64() * 1000.0;
        let results: serde_json::Value = locked
            .execute_query_typed_with_timeout_and_cancel(
                params,
                resolve_query_timeout(options.timeout_secs),
                cancel_token.clone(),
            )
            .await?;
        let results = batch_results(results)?;
        Ok(results
            .into_iter()
            .map(|mut result| {
                if let Some(timings) = result.query_timings_ms.as_mut() {
                    timings.insert("core_lock".into(), lock_ms);
                }
                truncate_result_with_max_rows(result, options.max_rows)
            })
            .collect())
    }
    .await;
    if let Err(error) = result.as_ref() {
        discard_agent_pool_after_typed_error(state, pool_key, &client, error, RecoveryScope::UserOperation).await;
    }
    result.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlserver_agent_complete_results_keeps_single_query_cursors() {
        let options = QueryExecutionOptions { page_size: Some(100), ..Default::default() };
        for sql in ["SELECT id FROM users;", "WITH t AS (SELECT 1 AS n) SELECT n FROM t;", "SELECT ';' AS text;"] {
            assert!(!requires_complete_results(sql, &options), "{sql}");
        }
        for sql in [
            "SELECT 1; SELECT 2;",
            "DECLARE @n INT; SET @n=1; SELECT @n;",
            "EXEC dbo.multi_results;",
            "SELECT 1\nGO\nSELECT 2",
        ] {
            assert!(requires_complete_results(sql, &options), "{sql}");
        }
        assert!(requires_complete_results("SELECT 1", &QueryExecutionOptions::default()));
        let fetch = QueryExecutionOptions { result_session_id: Some("cursor".into()), ..options };
        assert!(!requires_complete_results("SELECT 1; SELECT 2;", &fetch));
    }

    #[test]
    fn sqlserver_agent_batch_reports_outdated_agent_single_result() {
        let single = serde_json::json!({"columns": ["n"], "rows": [[1]], "affected_rows": 0, "execution_time_ms": 1});
        let all = batch_results(serde_json::json!([single.clone(), single.clone()])).unwrap();
        assert_eq!(all.len(), 2);

        match batch_results(single) {
            Err(AgentCallError::ContractViolation { message, .. }) => {
                assert!(message.contains("Driver Manager"), "{message}");
            }
            other => panic!("expected an outdated driver error, got {:?}", other.map(|results| results.len())),
        }
        match batch_results(serde_json::json!("unexpected")) {
            Err(AgentCallError::ContractViolation { message, .. }) => {
                assert!(message.starts_with("Failed to deserialize agent result"), "{message}");
            }
            other => panic!("expected a deserialize error, got {:?}", other.map(|results| results.len())),
        }
    }
}
