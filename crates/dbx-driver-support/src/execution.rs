use std::future::Future;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::db;
use crate::models::connection::ConnectionConfig;

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";

/// Unified database operation execution budget.
/// query_timeout = None only means SQL execution has no upper limit;
/// checkout/connect/recycle/cancel/cleanup always have hard upper limits and cannot be disabled.
#[derive(Debug, Clone)]
pub struct DbOperationBudget {
    pub checkout_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub query_timeout: Option<Duration>,
    pub cancel_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl DbOperationBudget {
    /// Build an execution budget from connection config.
    /// checkout/connect/recycle use connect_timeout_secs (clamped to 1s minimum, 300s maximum).
    /// query_timeout follows resolve_query_timeout semantics (Some(0) -> None).
    /// cancel/cleanup are fixed values and cannot be disabled.
    pub fn from_config(connect_timeout_secs: u64, query_timeout_secs: Option<u64>) -> Self {
        let infra_timeout = Duration::from_secs(connect_timeout_secs.clamp(1, 300));
        Self {
            checkout_timeout: infra_timeout,
            connect_timeout: infra_timeout,
            recycle_timeout: infra_timeout,
            query_timeout: resolve_query_timeout(query_timeout_secs),
            cancel_timeout: Duration::from_secs(5),
            cleanup_timeout: Duration::from_secs(3),
        }
    }

    pub fn from_connection_config(config: &ConnectionConfig) -> Self {
        // effective_query_timeout_secs, not the raw field: it preserves 0 ("no limit")
        // and applies the per-database-type floor Cloud Spanner needs for DDL.
        Self::from_config(config.effective_connect_timeout_secs(), Some(config.effective_query_timeout_secs()))
    }

    /// Use global default values (when no connection config is available).
    pub fn with_defaults() -> Self {
        let default_infra = db::connection_timeout();
        Self {
            checkout_timeout: default_infra,
            connect_timeout: default_infra,
            recycle_timeout: default_infra,
            query_timeout: Some(QUERY_TIMEOUT),
            cancel_timeout: Duration::from_secs(5),
            cleanup_timeout: Duration::from_secs(3),
        }
    }
}

pub struct StreamProgressClock {
    started_at: tokio::time::Instant,
    last_progress_ms: AtomicU64,
    #[cfg(any(test, feature = "test-support"))]
    marked: std::sync::atomic::AtomicBool,
}

impl Default for StreamProgressClock {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamProgressClock {
    pub fn new() -> Self {
        Self {
            started_at: tokio::time::Instant::now(),
            last_progress_ms: AtomicU64::new(0),
            #[cfg(any(test, feature = "test-support"))]
            marked: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn mark(&self) {
        self.last_progress_ms.store(self.started_at.elapsed().as_millis() as u64, Ordering::Relaxed);
        #[cfg(any(test, feature = "test-support"))]
        self.marked.store(true, Ordering::Relaxed);
    }

    /// Whether any progress has been recorded yet. Test-only: production code
    /// only needs the derived inactivity window. A row read within the first
    /// millisecond records a zero timestamp, so this cannot be derived from
    /// `last_progress_ms`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn marked(&self) -> bool {
        self.marked.load(Ordering::Relaxed)
    }

    fn elapsed_since_progress(&self) -> Duration {
        let last_progress_ms = self.last_progress_ms.load(Ordering::Relaxed);
        let elapsed_ms = self.started_at.elapsed().as_millis() as u64;
        Duration::from_millis(elapsed_ms.saturating_sub(last_progress_ms))
    }
}

pub fn timeout_error() -> String {
    timeout_error_for(QUERY_TIMEOUT)
}

pub fn timeout_error_for(timeout_duration: Duration) -> String {
    let seconds = timeout_duration.as_secs().max(1);
    format!("Query timed out after {seconds} seconds")
}

pub fn canceled_error() -> String {
    QUERY_CANCELED.to_string()
}

pub async fn await_stream_with_progress_timeout<F, T>(
    stream_future: F,
    timeout: Option<Duration>,
    progress_clock: Arc<StreamProgressClock>,
    cancel_token: Option<&CancellationToken>,
    timeout_message: String,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let Some(timeout) = timeout else {
        return match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = stream_future => result,
                }
            }
            None => stream_future.await,
        };
    };

    tokio::pin!(stream_future);
    loop {
        // Query timeout is an inactivity budget, not a cap on total stream duration.
        let remaining = timeout.saturating_sub(progress_clock.elapsed_since_progress());
        if remaining.is_zero() {
            return Err(timeout_message.clone());
        }
        let sleep = tokio::time::sleep(remaining);
        tokio::pin!(sleep);

        match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
            None => {
                tokio::select! {
                    biased;
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
        }

        if progress_clock.elapsed_since_progress() >= timeout {
            return Err(timeout_message);
        }
    }
}

pub fn is_canceled(cancel_token: &Option<CancellationToken>) -> bool {
    cancel_token.as_ref().map(|token| token.is_cancelled()).unwrap_or(false)
}

pub async fn wait_for_query<F>(cancel_token: Option<CancellationToken>, future: F) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_query_with_timeout(cancel_token, QUERY_TIMEOUT, future).await
}

pub async fn wait_for_query_with_timeout<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_result_with_timeout(cancel_token, timeout_duration, future).await
}

pub async fn wait_for_result_with_timeout<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    if let Some(token) = cancel_token {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(canceled_error()),
            result = timeout(timeout_duration, future) => result.map_err(|_| timeout_error_for(timeout_duration))?,
        }
    } else {
        timeout(timeout_duration, future).await.map_err(|_| timeout_error_for(timeout_duration))?
    }
}

/// Like `wait_for_query_with_timeout` but with an optional timeout.
/// `None` means no timeout (only cancellation can stop the query).
pub async fn wait_for_query_opt<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_result_opt(cancel_token, timeout_duration, future).await
}

pub async fn wait_for_result_opt<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match timeout_duration {
        Some(d) => wait_for_result_with_timeout(cancel_token, d, future).await,
        None => match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = future => result,
                }
            }
            None => future.await,
        },
    }
}

pub async fn wait_for_value_opt<T, F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    match timeout_duration {
        Some(timeout_duration) => {
            if let Some(token) = cancel_token {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = timeout(timeout_duration, future) => result.map_err(|_| timeout_error_for(timeout_duration)),
                }
            } else {
                timeout(timeout_duration, future).await.map_err(|_| timeout_error_for(timeout_duration))
            }
        }
        None => match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = future => Ok(result),
                }
            }
            None => Ok(future.await),
        },
    }
}

/// Locks a mutex-guarded shared connection (e.g. SQL Server's single connection
/// per pool key) and reports how long the caller waited for the lock alongside
/// the guard. Callers should fold the returned wait time into any execution-time
/// metric they report, since a driver-level timer that only starts once the lock
/// is held cannot see time spent queued behind another operation on the same
/// connection.
pub async fn lock_shared_client_with_wait<'a, T>(
    client: &'a Arc<tokio::sync::Mutex<T>>,
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
) -> Result<(tokio::sync::MutexGuard<'a, T>, u128), String> {
    let started_at = std::time::Instant::now();
    let guard = wait_for_value_opt(cancel_token, timeout_duration, client.lock()).await?;
    Ok((guard, started_at.elapsed().as_millis()))
}

pub fn query_timeout_duration(timeout_secs: Option<u64>) -> Option<Duration> {
    match timeout_secs {
        Some(0) => None,
        Some(n) => Some(Duration::from_secs(n)),
        None => Some(QUERY_TIMEOUT),
    }
}

pub fn resolve_query_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    query_timeout_duration(timeout_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn default_progress_clock_tracks_inactivity_from_creation_and_marks() {
        let clock = StreamProgressClock::default();
        assert_eq!(clock.elapsed_since_progress(), Duration::ZERO);
        assert!(!clock.marked());

        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(clock.elapsed_since_progress(), Duration::from_secs(2));

        clock.mark();
        assert!(clock.marked());
        assert_eq!(clock.elapsed_since_progress(), Duration::ZERO);

        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(clock.elapsed_since_progress(), Duration::from_secs(1));
    }
}
