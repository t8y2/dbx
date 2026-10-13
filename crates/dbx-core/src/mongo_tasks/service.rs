use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::{fs::OpenOptions, path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

use super::{models::*, store::Store};
use crate::{
    connection::{AppState, PoolKind},
    models::connection::DatabaseType,
};

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum MongoTaskCommand {
    Snapshot,
    Save { task: MongoTask },
    Delete { id: String, revision: String },
    Run { id: String, revision: String },
    Cancel { id: String },
}

#[derive(Clone)]
pub struct MongoTaskService {
    state: Arc<AppState>,
    store: Store,
}

impl MongoTaskService {
    pub fn new(state: Arc<AppState>, data_dir: &Path) -> Self {
        Self { state, store: Store::new(data_dir) }
    }

    pub fn start(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move { service.serve(stop).await })
    }

    pub async fn command(&self, command: MongoTaskCommand) -> Result<Value, String> {
        if !self.state.storage.inspect_data_migration().await?.is_ready() {
            return Err("Wait for data migration before using Mongo tasks".into());
        }
        match command {
            MongoTaskCommand::Snapshot => {
                serde_json::to_value(self.store.snapshot().await?).map_err(|e| e.to_string())
            }
            MongoTaskCommand::Save { task } => {
                task.validate()?;
                self.validate_connections(&task).await?;
                serde_json::to_value(self.store.save(task).await?).map_err(|e| e.to_string())
            }
            MongoTaskCommand::Delete { id, revision } => {
                self.store.delete(id, revision).await?;
                Ok(Value::Null)
            }
            MongoTaskCommand::Run { id, revision } => {
                serde_json::to_value(self.store.run(id, revision).await?).map_err(|e| e.to_string())
            }
            MongoTaskCommand::Cancel { id } => {
                self.store.cancel(id).await?;
                Ok(Value::Null)
            }
        }
    }

    async fn validate_connections(&self, task: &MongoTask) -> Result<(), String> {
        let connections = self.state.storage.load_connections().await?;
        for step in &task.steps {
            let connection = connections
                .iter()
                .find(|c| c.id == step.connection_id)
                .ok_or_else(|| format!("Saved connection is unavailable for step {}", step.name))?;
            if connection.db_type != DatabaseType::MongoDb || connection.one_time {
                return Err("Mongo tasks require saved MongoDB connections, not temporary connections".into());
            }
            if !connection.save_password {
                return Err("Backend tasks require saved credentials (enable Save password on the connection); session-only credentials cannot survive restart".into());
            }
        }
        Ok(())
    }

    async fn serve(&self, stop: CancellationToken) {
        let mut leader = None;
        while !stop.is_cancelled() {
            let ready = self.state.storage.inspect_data_migration().await.is_ok_and(|s| s.is_ready());
            if ready && leader.is_none() {
                let file = std::fs::create_dir_all(&self.store.directory)
                    .and_then(|_| {
                        OpenOptions::new()
                            .create(true)
                            .truncate(false)
                            .read(true)
                            .write(true)
                            .open(self.store.directory.join("worker.lock"))
                    })
                    .ok()
                    .filter(|f| fs2::FileExt::try_lock_exclusive(f).is_ok());
                if let Some(file) = file {
                    match self.store.recover().await {
                        Ok(()) => leader = Some(file),
                        Err(e) => log::error!("[mongo-tasks] recovery failed: {e}"),
                    }
                }
            }
            if ready && leader.is_some() {
                if let Err(error) = self.tick(&stop).await {
                    log::error!("[mongo-tasks] scheduler failed: {error}");
                    // A persistence failure may have left a claimed job. Reacquire
                    // leadership and mark it interrupted before claiming more work.
                    drop(leader.take());
                }
            }
            tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
        }
        drop(leader);
    }

    async fn tick(&self, stop: &CancellationToken) -> Result<(), String> {
        self.store.heartbeat().await?;
        self.store.enqueue_due().await?;
        let Some(mut job) = self.store.claim().await? else {
            return Ok(());
        };
        // Never share or mutate interactive pools/session credentials. Read saved
        // connection definitions for each run, including after a backend restart.
        let state = Arc::new(AppState::new_with_plugin_dir(
            self.state.storage.clone(),
            self.state.storage.data_dir().join("plugins"),
        ));
        let result = self.execute(&mut job, &state, stop).await;
        state.shutdown(Duration::from_secs(3)).await;
        job.run.status = if stop.is_cancelled() || self.store.cancelled(job.run.id.clone()).await? {
            "cancelled"
        } else if result.is_ok() {
            "success"
        } else {
            "failed"
        }
        .into();
        job.run.error = result.err();
        job.run.completed_at = Some(Utc::now().to_rfc3339());
        self.store.progress(job.run).await
    }

    async fn execute(&self, job: &mut Job, state: &AppState, stop: &CancellationToken) -> Result<(), String> {
        job.task.validate()?;
        self.validate_connections(&job.task).await?;
        for connection in state.storage.load_connections().await? {
            if job.task.steps.iter().any(|step| step.connection_id == connection.id) {
                state.configs.write().await.insert(connection.id.clone(), connection);
            }
        }
        let mut remaining_sample_bytes: usize = 65536;
        for step in &job.task.steps {
            if stop.is_cancelled() || self.store.cancelled(job.run.id.clone()).await? {
                return Err("Cancelled; no further steps were started".into());
            }
            let future = self.execute_step(state, step, remaining_sample_bytes);
            tokio::pin!(future);
            let deadline = tokio::time::sleep(Duration::from_secs(step.timeout_seconds));
            tokio::pin!(deadline);
            let result = loop {
                tokio::select! {
                    _ = stop.cancelled() => return Err("Backend is shutting down; no further steps were started".into()),
                    _ = &mut deadline => return Err(format!("Step '{}' exceeded its {} second timeout", step.name, step.timeout_seconds)),
                    value = &mut future => break value?,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        self.store.heartbeat().await?;
                        if self.store.cancelled(job.run.id.clone()).await? { return Err("Cancelled; no further steps were started".into()); }
                    }
                }
            };
            for sample in &result.sample {
                remaining_sample_bytes =
                    remaining_sample_bytes.saturating_sub(serde_json::to_vec(sample).map_err(|e| e.to_string())?.len());
            }
            job.run.results.push(result);
            self.store.progress(job.run.clone()).await?;
        }
        Ok(())
    }

    async fn execute_step(
        &self,
        state: &AppState,
        step: &MongoTaskStep,
        sample_budget: usize,
    ) -> Result<MongoStepResult, String> {
        let pipeline: Value = serde_json::from_str(&step.pipeline()?).map_err(|e| e.to_string())?;
        let pool_key = state.get_or_create_pool(&step.connection_id, None).await?;
        let pool = state.pool_handle(&pool_key).await.ok_or("Mongo connection is unavailable")?;
        let PoolKind::MongoDb(client) = pool else {
            return Err("Mongo tasks require the native MongoDB driver; Legacy Agent is not supported because bounded cursors and cancellation cannot be guaranteed".into());
        };
        let stages = pipeline
            .as_array()
            .ok_or("Pipeline must be an array")?
            .iter()
            .map(crate::db::mongo_driver::json_object_to_document_extended_json)
            .collect::<Result<Vec<_>, _>>()?;
        let command = mongodb::bson::doc! {
            "aggregate": &step.collection,
            "pipeline": stages,
            // The appended $limit bounds the result to max_rows. Asking for one
            // more document than the limit lets the server exhaust the
            // cursor before replying in the normal case. This also prevents an
            // orphaned cursor if cancellation drops an in-flight aggregate
            // before the client receives the first response.
            "cursor": {"batchSize": step.max_rows as i32 + 1},
            "maxTimeMS": (step.timeout_seconds * 1000) as i64,
            "allowDiskUse": false,
        };
        let mut cursor = client.database(&step.database).run_cursor_command(command).await.map_err(|e| e.to_string())?;
        let mut result = MongoStepResult {
            name: step.name.clone(),
            returned_rows: 0,
            sample: vec![],
            sample_truncated: false,
            row_limit_reached: false,
        };
        let mut sample_bytes = 0;
        while result.returned_rows < step.max_rows && cursor.advance().await.map_err(|e| e.to_string())? {
            let document = cursor.deserialize_current().map_err(|e| e.to_string())?;
            result.returned_rows += 1;
            if result.sample.len() < 5 {
                let value = mongodb::bson::Bson::Document(document).into_canonical_extjson();
                let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?.len();
                if sample_bytes + bytes <= sample_budget {
                    result.sample.push(value);
                    sample_bytes += bytes;
                } else {
                    result.sample_truncated = true;
                }
            } else {
                result.sample_truncated = true;
            }
        }
        result.row_limit_reached = result.returned_rows == step.max_rows;
        // A batch may still be split at the server's byte limit, so drain to
        // exhaustion even after reaching the row cap. The $limit above ensures
        // this cannot yield more than max_rows documents.
        while cursor.advance().await.map_err(|e| e.to_string())? {}
        Ok(result)
    }
}
