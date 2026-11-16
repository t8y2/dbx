use super::{params, Deserialize, OptionalExtension, Serialize, Storage};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeRecoveryContext {
    pub plan_id: String,
    pub step_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeExecutionBinding {
    pub execution_id: String,
    #[serde(flatten)]
    pub context: TypeRecoveryContext,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub sql: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    binding: TypeExecutionBinding,
    database_terminal: bool,
}

fn key(execution_id: &str) -> String {
    format!("type_execution_receipt:{execution_id}")
}

impl Storage {
    pub async fn claim_type_execution(&self, binding: &TypeExecutionBinding) -> Result<(), String> {
        if [&binding.execution_id, &binding.context.plan_id, &binding.context.step_id, &binding.connection_id]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err("TYPE recovery binding is incomplete; execution outcome is unknown".into());
        }
        let key = key(&binding.execution_id);
        let value = serde_json::to_string(&Receipt { binding: binding.clone(), database_terminal: false })
            .map_err(|error| error.to_string())?;
        self.with_conn(move |conn| {
            let inserted = conn
                .execute("INSERT OR IGNORE INTO app_state (key, value_json) VALUES (?1, ?2)", params![key, value])
                .map_err(|error| error.to_string())?;
            if inserted != 1 {
                return Err(
                    "TYPE execution ID already has a recovery record; inspect the original outcome, do not replay"
                        .into(),
                );
            }
            Ok(())
        })
        .await
    }

    pub async fn type_execution_terminal(&self, binding: &TypeExecutionBinding) -> Result<Option<bool>, String> {
        let key = key(&binding.execution_id);
        let json: Option<String> = self
            .with_conn(move |conn| {
                conn.query_row("SELECT value_json FROM app_state WHERE key = ?1", [key], |row| row.get(0))
                    .optional()
                    .map_err(|error| error.to_string())
            })
            .await?;
        let Some(json) = json else { return Ok(None) };
        let receipt: Receipt = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        if receipt.binding != *binding {
            return Err("TYPE execution recovery binding does not match the original request".into());
        }
        Ok(Some(receipt.database_terminal))
    }

    pub async fn finish_type_execution(&self, binding: &TypeExecutionBinding) -> Result<(), String> {
        let key = key(&binding.execution_id);
        let pending = serde_json::to_string(&Receipt { binding: binding.clone(), database_terminal: false })
            .map_err(|error| error.to_string())?;
        let terminal = serde_json::to_string(&Receipt { binding: binding.clone(), database_terminal: true })
            .map_err(|error| error.to_string())?;
        self.with_conn(move |conn| {
            let updated = conn
                .execute(
                    "UPDATE app_state SET value_json = ?1 WHERE key = ?2 AND value_json = ?3",
                    params![terminal, key, pending],
                )
                .map_err(|error| error.to_string())?;
            if updated != 1 {
                return Err("TYPE terminal receipt could not be saved for the original request; do not replay".into());
            }
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> TypeExecutionBinding {
        TypeExecutionBinding {
            execution_id: "execution".into(),
            context: TypeRecoveryContext { plan_id: "plan".into(), step_id: "step".into() },
            connection_id: "connection".into(),
            database: "service".into(),
            schema: Some("APP".into()),
            sql: "CREATE OR REPLACE TYPE APP.T AS OBJECT (ID NUMBER)".into(),
        }
    }

    async fn storage() -> (Storage, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("dbx-type-receipt-{}.db", uuid::Uuid::new_v4()));
        (crate::persistence::test_storage::open(&path).await.unwrap(), path)
    }

    #[tokio::test]
    async fn terminal_receipt_survives_reopen_and_does_not_allow_reclaim() {
        let (storage, path) = storage().await;
        let binding = binding();
        storage.claim_type_execution(&binding).await.unwrap();
        assert_eq!(storage.type_execution_terminal(&binding).await.unwrap(), Some(false));
        storage.finish_type_execution(&binding).await.unwrap();
        drop(storage);
        let reopened = crate::persistence::test_storage::open(&path).await.unwrap();
        assert_eq!(reopened.type_execution_terminal(&binding).await.unwrap(), Some(true));
        assert!(reopened.claim_type_execution(&binding).await.is_err());
    }

    #[tokio::test]
    async fn concurrent_claim_has_one_winner_and_every_binding_field_is_checked() {
        let (storage, _) = storage().await;
        let binding = binding();
        let (first, second) =
            tokio::join!(storage.claim_type_execution(&binding), storage.claim_type_execution(&binding));
        assert_ne!(first.is_ok(), second.is_ok());
        for field in ["planId", "stepId", "connectionId", "database", "schema", "sql"] {
            let mut changed = serde_json::to_value(&binding).unwrap();
            changed[field] = serde_json::json!("other");
            let changed = serde_json::from_value(changed).unwrap();
            assert!(storage.type_execution_terminal(&changed).await.is_err(), "{field}");
            assert!(storage.finish_type_execution(&changed).await.is_err(), "{field}");
        }
        let mut missing = binding.clone();
        missing.execution_id = "missing".into();
        assert_eq!(storage.type_execution_terminal(&missing).await.unwrap(), None);
        assert_eq!(storage.type_execution_terminal(&binding).await.unwrap(), Some(false));
    }

    #[tokio::test]
    async fn failed_terminal_write_preserves_pending_receipt() {
        let (storage, _) = storage().await;
        let binding = binding();
        storage.claim_type_execution(&binding).await.unwrap();
        storage.with_conn(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_receipt_update BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;")
                .map_err(|error| error.to_string())
        }).await.unwrap();
        let running = crate::query_cancel::RunningQueries::default();
        let registered =
            running.register_task_for_terminal_confirmation(binding.execution_id.clone(), Default::default());
        let error = crate::query_cancel::finish_conditional_update(registered, &storage, Some(&binding), Ok(()))
            .await
            .unwrap_err();
        let envelope = serde_json::to_value(error).unwrap();
        assert_eq!(envelope["operationOutcome"], "unknown");
        assert_eq!(envelope["code"], "DBX-LEGACY-0001");
        assert_eq!(storage.type_execution_terminal(&binding).await.unwrap(), Some(false));
    }

    #[tokio::test]
    async fn observation_requires_durable_binding_even_when_memory_reports_completion() {
        use crate::query_cancel::{observe_type_execution, RunningQueries};
        let (storage, path) = storage().await;
        let binding = binding();
        let running = RunningQueries::default();
        let registered =
            running.register_task_for_terminal_confirmation(binding.execution_id.clone(), Default::default());
        assert!(registered.finish_with_database_result(&Ok::<_, crate::query::QueryExecutionError>(())));
        let observe = || observe_type_execution(&storage, &running, &binding, std::time::Duration::ZERO);
        assert!(!observe().await.unwrap().terminal);
        storage.claim_type_execution(&binding).await.unwrap();
        assert!(!observe().await.unwrap().terminal);
        storage.finish_type_execution(&binding).await.unwrap();
        let mut wrong = binding.clone();
        wrong.sql.push(';');
        assert!(observe_type_execution(&storage, &running, &wrong, std::time::Duration::ZERO).await.is_err());
        drop(storage);
        let reopened = crate::persistence::test_storage::open(&path).await.unwrap();
        let result = observe_type_execution(&reopened, &RunningQueries::default(), &binding, std::time::Duration::ZERO)
            .await
            .unwrap();
        assert!(result.terminal && result.database_terminal == Some(true));
    }

    #[tokio::test]
    async fn failed_claim_does_not_create_a_receipt() {
        let (storage, _) = storage().await;
        storage.with_conn(|conn| {
            conn.execute_batch("CREATE TRIGGER reject_receipt_insert BEFORE INSERT ON app_state BEGIN SELECT RAISE(ABORT, 'receipt claim failed'); END;")
                .map_err(|error| error.to_string())
        }).await.unwrap();
        assert!(storage.claim_type_execution(&binding()).await.is_err());
        assert_eq!(storage.type_execution_terminal(&binding()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn completion_persists_only_database_terminal_results_before_reply() {
        use crate::db::agent_driver::{AgentErrorStage, AgentOperationOutcome};
        use crate::query::QueryExecutionError;
        use crate::query_cancel::{finish_conditional_update, RunningQueries};
        let (storage, _) = storage().await;
        let running = RunningQueries::default();
        for (index, (result, terminal)) in [
            (Ok(()), true),
            (Err(QueryExecutionError::Timeout("timeout".into())), false),
            (Err(QueryExecutionError::Sql("legacy transport failure".into())), false),
            (
                Err(QueryExecutionError::Canceled {
                    stage: AgentErrorStage::Execute,
                    operation_outcome: AgentOperationOutcome::Unknown,
                }),
                false,
            ),
            (
                Err(QueryExecutionError::Canceled {
                    stage: AgentErrorStage::Execute,
                    operation_outcome: AgentOperationOutcome::NotStarted,
                }),
                true,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let mut binding = binding();
            binding.execution_id = format!("case-{index}");
            storage.claim_type_execution(&binding).await.unwrap();
            let registered =
                running.register_task_for_terminal_confirmation(binding.execution_id.clone(), Default::default());
            let reply = finish_conditional_update(registered, &storage, Some(&binding), result).await;
            if !terminal {
                let envelope = serde_json::to_value(reply.unwrap_err()).unwrap();
                assert_eq!(envelope["operationOutcome"], "unknown");
                assert_eq!(envelope["code"], "DBX-LEGACY-0001");
            }
            assert_eq!(storage.type_execution_terminal(&binding).await.unwrap(), Some(terminal));
        }
    }
}
