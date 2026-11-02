//! Stable result pages on existing workers, without requiring a new worker protocol.
//! A temporary table lets DuckDB spill large results instead of keeping JSON rows
//! in the application. Only the configured result limit (plus one probe) is captured.

use super::*;
use std::time::Instant;

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct QuerySession {
    table: String,
    database: Option<String>,
    columns: Vec<String>,
    offset: usize,
    row_limit: usize,
    generation: u64,
    last_activity: Instant,
    expiry: CancellationToken,
}

impl QuerySession {
    fn qualified_table(&self) -> String {
        format!("\"temp\".\"main\".\"{}\"", self.table)
    }
}

impl DuckDbWorkerClient {
    /// All pages refer to one execution, even for an unordered query or an
    /// ORDER BY with ties. Never silently rerun an expired session's SQL.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_query_page(
        &self,
        database: Option<String>,
        sql: String,
        max_rows: Option<usize>,
        page_size: usize,
        session_id: Option<&str>,
        cancel: Option<CancellationToken>,
        timeout: Option<Duration>,
    ) -> Result<db::QueryResult, String> {
        let id = session_id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let mut session = if session_id.is_some() {
            self.inner
                .query_sessions
                .lock()
                .await
                .remove(&id)
                .ok_or("DuckDB result session expired; rerun the query")?
        } else {
            let statements = dbx_sql_core::sql::split_sql_statements_for_database(
                &sql,
                crate::models::connection::DatabaseType::DuckDb,
            );
            if statements.len() != 1 {
                return Err("DuckDB result sessions require a single query".into());
            }
            let sql = &statements[0];
            // SHOW/DESCRIBE/EXPLAIN return rows, but are not legal subqueries.
            // Execute such metadata statements once using the normal row cap.
            let inspected = dbx_sql_core::query_execution_sql::strip_sql_comments_and_literals(sql);
            let keyword = inspected.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
            if !matches!(keyword.as_str(), "SELECT" | "WITH" | "FROM" | "VALUES" | "TABLE" | "PIVOT" | "UNPIVOT") {
                return self.execute(database, sql.to_string(), max_rows, cancel, timeout).await;
            }
            let metadata = self
                .execute(
                    database.clone(),
                    format!("DESCRIBE (\n{sql}\n)"),
                    Some(i32::MAX as usize),
                    cancel.clone(),
                    timeout,
                )
                .await?;
            let columns = metadata
                .rows
                .iter()
                .map(|row| {
                    row.first()
                        .and_then(|cell| cell.as_str())
                        .map(str::to_string)
                        .ok_or_else(|| "DuckDB returned invalid result metadata".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if metadata.truncated || columns.is_empty() {
                return Err("DuckDB returned incomplete result metadata".into());
            }
            let table = format!("__dbx_result_{id}");
            let row_limit = max_rows.unwrap_or(10_000).max(1);
            let aliases = (0..columns.len()).map(|i| format!("\"__dbx_column_{i}\"")).collect::<Vec<_>>().join(", ");
            let create = format!(
                "CREATE TEMP TABLE \"{table}\" (\"__dbx_row_number\", {aliases}) AS \
                 SELECT row_number() OVER (), * FROM (\n{sql}\n) AS \"__dbx_source\" LIMIT {}",
                row_limit.saturating_add(1),
            );
            self.execute(database.clone(), create, Some(1), cancel.clone(), timeout).await?;
            QuerySession {
                table,
                database: database.clone(),
                columns,
                offset: 0,
                row_limit,
                generation: self.inner.state.lock().await.generation,
                last_activity: Instant::now(),
                expiry: CancellationToken::new(),
            }
        };
        // Retire the previous idle timer before reading a page. It must not
        // expire a session while that page is temporarily outside the map.
        session.expiry.cancel();
        let process = self.inner.state.lock().await;
        let alive = process.connected && process.generation == session.generation;
        drop(process);
        if !alive || session.database != database || session.last_activity.elapsed() >= IDLE_TIMEOUT {
            self.drop_query_snapshot(&session).await;
            return Err("DuckDB result session expired; rerun the query".into());
        }
        let page_size = page_size.max(1).min(session.row_limit.saturating_sub(session.offset));
        let projection = session
            .columns
            .iter()
            .enumerate()
            .map(|(i, name)| format!("\"__dbx_column_{i}\" AS \"{}\"", name.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        let page_sql = format!(
            "SELECT {projection} FROM {} WHERE \"__dbx_row_number\" > {} \
             AND \"__dbx_row_number\" <= {} ORDER BY \"__dbx_row_number\"",
            session.qualified_table(),
            session.offset,
            session.offset.saturating_add(page_size).saturating_add(1),
        );
        let result = self.execute(database, page_sql, Some(page_size.saturating_add(1)), cancel, timeout).await;
        let mut result = match result {
            Ok(result) => result,
            Err(error) => {
                self.drop_query_snapshot(&session).await;
                return Err(error);
            }
        };
        let extra = result.rows.len() > page_size;
        result.rows.truncate(page_size);
        session.offset = session.offset.saturating_add(result.rows.len());
        result.has_more = extra && session.offset < session.row_limit;
        result.truncated = extra && !result.has_more;
        if result.has_more {
            session.last_activity = Instant::now();
            session.expiry = CancellationToken::new();
            let expiry = session.expiry.clone();
            self.inner.query_sessions.lock().await.insert(id.clone(), session);
            result.session_id = Some(id.clone());
            self.expire_query_session(id, expiry);
        } else {
            self.drop_query_snapshot(&session).await;
            result.session_id = None;
        }
        Ok(result)
    }

    pub async fn close_query_session(&self, id: &str) -> Result<bool, String> {
        let session = self.inner.query_sessions.lock().await.remove(id);
        if let Some(session) = session {
            self.drop_query_snapshot(&session).await;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn drop_query_snapshot(&self, session: &QuerySession) {
        session.expiry.cancel();
        let process = self.inner.state.lock().await;
        let alive = process.connected && process.generation == session.generation;
        drop(process);
        if !alive {
            return;
        }
        let sql = format!("DROP TABLE IF EXISTS {}", session.qualified_table());
        if let Err(error) = self.execute_interrupt_only(session.database.clone(), sql, Some(1), CLEANUP_TIMEOUT).await {
            log::error!("Failed to remove DuckDB result snapshot {}: {error}", session.table);
        }
    }

    fn expire_query_session(&self, id: String, expiry: CancellationToken) {
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = expiry.cancelled() => return,
                _ = tokio::time::sleep(IDLE_TIMEOUT) => {},
            }
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let client = DuckDbWorkerClient { inner };
            let expired = {
                let mut sessions = client.inner.query_sessions.lock().await;
                if expiry.is_cancelled() {
                    return;
                }
                sessions.remove(&id)
            };
            if let Some(session) = expired {
                client.drop_query_snapshot(&session).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued_client() -> DuckDbWorkerClient {
        DuckDbWorkerClient::new_unconnected_with_timeouts(
            PathBuf::from("must-not-start"),
            vec![],
            ":memory:".into(),
            vec![],
            None,
            1,
            Duration::from_secs(60),
            Duration::from_secs(5),
        )
    }

    #[tokio::test]
    async fn cancelling_a_queued_read_does_not_interrupt_the_lock_owner() {
        let client = queued_client();
        let _owner = client.inner.query_lock.lock().await;
        let cancel = CancellationToken::new();
        let read = client.execute(None, "SELECT 1".into(), Some(1), Some(cancel.clone()), None);
        tokio::pin!(read);
        tokio::select! {
            _ = &mut read => panic!("read must wait for the owner"),
            _ = tokio::task::yield_now() => {},
        }
        cancel.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), read).await.unwrap().unwrap_err();
        assert_eq!(error, crate::execution::canceled_error());
        assert_eq!(client.inner.state.lock().await.generation, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_result_sessions_expire_without_starting_a_worker() {
        let client = queued_client();
        let expiry = CancellationToken::new();
        client.inner.query_sessions.lock().await.insert(
            "idle".into(),
            QuerySession {
                table: "__dbx_result_idle".into(),
                database: None,
                columns: vec!["id".into()],
                offset: 1,
                row_limit: 100,
                generation: 0,
                last_activity: Instant::now(),
                expiry: expiry.clone(),
            },
        );
        client.expire_query_session("idle".into(), expiry);
        tokio::task::yield_now().await;
        tokio::time::advance(IDLE_TIMEOUT + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(client.inner.query_sessions.lock().await.is_empty());
        assert_eq!(client.inner.state.lock().await.generation, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn cleanup_wait_is_bounded_even_while_the_worker_is_busy() {
        let client = queued_client();
        let _owner = client.inner.query_lock.lock().await;
        let error = tokio::time::timeout(
            CLEANUP_TIMEOUT + Duration::from_secs(1),
            client.execute_interrupt_only(None, "DROP TABLE unused".into(), Some(1), CLEANUP_TIMEOUT),
        )
        .await
        .expect("queued cleanup must stop waiting")
        .unwrap_err();
        assert_eq!(error, crate::execution::timeout_error_for(CLEANUP_TIMEOUT));
        assert_eq!(client.inner.state.lock().await.generation, 0);
    }
}
