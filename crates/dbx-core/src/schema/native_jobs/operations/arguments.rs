use super::*;
use dbx_sql::native_job_arguments::{civil_date_query, normalize_civil_date};

fn values(request: &mut NativeJobRequest) -> Vec<&mut Value> {
    match request {
        NativeJobRequest::Create { definition: NativeJobCreateDefinition::Scheduler(definition), .. } => definition
            .arguments
            .iter_mut()
            .filter_map(|argument| match &mut argument.value {
                NativeJobArgumentValue::Value { value } => Some(value),
                _ => None,
            })
            .collect(),
        NativeJobRequest::Mutation(NativeJobMutation {
            change: NativeJobChange::Update { arguments, argument_target, .. },
            ..
        }) => {
            let mut result = arguments
                .iter_mut()
                .filter_map(|argument| match &mut argument.value {
                    NativeJobArgumentValue::Value { value } => Some(value),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if let Some(target) = argument_target {
                result.extend(target.arguments.iter_mut().filter_map(|argument| match &mut argument.value {
                    NativeJobArgumentValue::Value { value } => Some(value),
                    _ => None,
                }));
            }
            result
        }
        _ => Vec::new(),
    }
}

async fn normalize_with<Q, F>(pending: Vec<(&mut Value, String)>, mut query: Q) -> Result<(), &'static str>
where
    Q: FnMut(String) -> F,
    F: Future<Output = Result<NativeJobRow, &'static str>>,
{
    for (value, sql) in pending {
        let row = query(sql).await?;
        *value = normalize_civil_date(value, &row)?;
    }
    Ok(())
}

pub(super) async fn normalize_core(state: &AppState, request: &mut NativeJobRequest) -> Result<(), &'static str> {
    let scope = match &*request {
        NativeJobRequest::Create { scope, .. } => scope.clone(),
        NativeJobRequest::Mutation(mutation) => mutation.target.scope().clone(),
    };
    let mut pending = Vec::new();
    for value in values(request) {
        if let Some(sql) = civil_date_query(value)? {
            pending.push((value, sql));
        }
    }
    if pending.is_empty() {
        return Ok(());
    }
    let bound = state.native_jobs.context(state, &scope)?;
    if bound.context.engine != NativeJobEngine::Oracle {
        return Err("native_job_argument_value_invalid");
    }
    let timeout = super::super::super::agent_metadata_timeout(state.configs.read().await.get(&scope.connection_id));
    let (session, pool) = super::super::service::open_pool(state, &scope).await?;
    let result = async {
        super::super::service::validate_runtime_context(state, &bound, &pool).await?;
        let pool = &pool;
        let database = scope.database.as_str();
        let engine = bound.context.engine;
        tokio::select! {
            biased;
            _ = bound.lifecycle.cancellation().cancelled() => Err("native_job_context_changed"),
            result = normalize_with(pending, |sql| async move {
                let raw = execute_catalog_query(engine, pool, database, NativeJobCatalogQuery {
                    source: "oracle-native-job-civil-date", coverage: NativeJobCatalogCoverage::CurrentUser, sql, limit: 1,
                }, timeout).await.map_err(|_| "native_job_argument_date_conversion_failed")?;
                let rows = rows_from_result(decode_query_result(engine, raw).map_err(|_| "native_job_argument_date_read_failed")?, 1, |_| Ok(())).map_err(|_| "native_job_argument_date_read_failed")?;
                match rows {
                    NativeJobMetadata::Available { mut value } if value.len() == 1 => Ok(value.remove(0)),
                    _ => Err("native_job_argument_date_read_failed"),
                }
            }) => result,
        }?;
        state.native_jobs.context(state, &scope)?;
        Ok(())
    }.await;
    session.finish(state, &scope.connection_id, (!scope.database.is_empty()).then_some(scope.database.as_str())).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn normalizes_only_new_civil_inputs_before_the_request_can_be_prepared() {
        let typed = json!({"$dbx":"oracle-anydata-v1","scalarType":"timestamp","value":{"civilDate":"-0001-12-31","seconds":"1.123456789"}});
        let mut request: NativeJobRequest = serde_json::from_value(json!({"target":{"kind":"scheduler","owner":"Owner","name":"Job","scope":{"connectionId":"c","database":"","contextId":"ctx"}},"baseline":"read","action":"update","attributes":[],"arguments":[{"position":1,"value":{"kind":"value","value":"literal text"}},{"position":2,"value":{"kind":"value","value":typed}}]})).unwrap();
        let mut pending = Vec::new();
        for value in values(&mut request) {
            if let Some(sql) = civil_date_query(value).unwrap() {
                pending.push((value, sql));
            }
        }
        assert_eq!(pending.len(), 1);
        let mut calls = 0;
        normalize_with(pending, |sql| {
            calls += 1;
            assert!(sql.contains("NLS_CALENDAR=GREGORIAN"));
            std::future::ready(Ok(serde_json::from_value(
                json!({"DBX_DAY":"1234567","DBX_CIVIL":"-0001-12-31","DBX_REBUILT":"-0001-12-31"}),
            )
            .unwrap()))
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        let payload = serde_json::to_value(&request).unwrap();
        assert_eq!(payload["arguments"][0]["value"]["value"], "literal text");
        assert_eq!(
            payload["arguments"][1]["value"]["value"]["value"],
            json!({"day":"1234567","seconds":"1.123456789"})
        );
        for value in values(&mut request) {
            assert!(civil_date_query(value).unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn conversion_failure_is_returned_instead_of_producing_an_executable_value() {
        let mut value =
            json!({"$dbx":"oracle-anydata-v1","scalarType":"date","value":{"civilDate":"1582-10-05","seconds":"0"}});
        let original = value.clone();
        let sql = civil_date_query(&value).unwrap().unwrap();
        let error =
            normalize_with(vec![(&mut value, sql)], |_| std::future::ready(Err("native_job_context_changed"))).await;
        assert_eq!(error, Err("native_job_context_changed"));
        assert_eq!(value, original);
    }
}
