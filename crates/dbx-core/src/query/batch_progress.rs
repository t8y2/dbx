use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::{ExecuteMultiProgress, ExecuteMultiProgressCallback};

/// Same cadence as the SQL file import progress.
const EXECUTE_MULTI_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Runs a SQL batch while forwarding its per-statement progress to `emit` at
/// most once per interval.
///
/// The core reports every completed statement, but forwarding each one across
/// the desktop event bridge floods the webview on scripts with thousands of
/// statements, and the UI re-derives the whole batch on every event. Successful
/// statements are therefore coalesced into the latest one: statements complete
/// in order, so the UI settles every statement up to it. A failure cannot be
/// inferred from a later event, so it is forwarded immediately, after the
/// successes that preceded it. Whatever is still pending when `run` finishes is
/// forwarded before returning, so the UI knows the last completed statement
/// before the caller reports the batch outcome.
pub async fn with_coalesced_execute_multi_progress<F, Fut, T>(emit: Option<ExecuteMultiProgressCallback>, run: F) -> T
where
    F: FnOnce(Option<ExecuteMultiProgressCallback>) -> Fut,
    Fut: Future<Output = T>,
{
    let Some(emit) = emit else {
        return run(None).await;
    };
    let coalescer = Arc::new(ProgressCoalescer { emit, pending: Mutex::new(None) });
    let progress: ExecuteMultiProgressCallback = {
        let coalescer = Arc::clone(&coalescer);
        Arc::new(move |progress| coalescer.report(progress))
    };
    let mut run = std::pin::pin!(run(Some(progress)));
    loop {
        let output = tokio::time::timeout(EXECUTE_MULTI_PROGRESS_EMIT_INTERVAL, run.as_mut()).await;
        coalescer.flush();
        if let Ok(output) = output {
            return output;
        }
    }
}

struct ProgressCoalescer {
    emit: ExecuteMultiProgressCallback,
    pending: Mutex<Option<ExecuteMultiProgress>>,
}

impl ProgressCoalescer {
    // Both paths emit while holding the lock so forwarded events stay in
    // statement order.
    fn report(&self, progress: ExecuteMultiProgress) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if progress.success {
            *pending = Some(progress);
            return;
        }
        if let Some(previous) = pending.take() {
            (self.emit)(previous);
        }
        (self.emit)(progress);
    }

    fn flush(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(progress) = pending.take() {
            (self.emit)(progress);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend_error::BackendError;
    use tokio::time::{sleep, Instant};

    type Emitted = Arc<Mutex<Vec<(ExecuteMultiProgress, Duration)>>>;

    fn recorder() -> (ExecuteMultiProgressCallback, Emitted) {
        let emitted: Emitted = Arc::new(Mutex::new(Vec::new()));
        let started_at = Instant::now();
        let callback: ExecuteMultiProgressCallback = {
            let emitted = Arc::clone(&emitted);
            Arc::new(move |progress| emitted.lock().unwrap().push((progress, started_at.elapsed())))
        };
        (callback, emitted)
    }

    fn statement(statement_index: usize, total: usize, success: bool) -> ExecuteMultiProgress {
        ExecuteMultiProgress {
            statement_index,
            completed: statement_index + 1,
            total,
            success,
            execution_time_ms: 1,
            affected_rows: 1,
            error: (!success).then(|| BackendError::from_sql_detail("Duplicate entry")),
        }
    }

    fn completed(emitted: &Emitted) -> Vec<usize> {
        emitted.lock().unwrap().iter().map(|(progress, _)| progress.completed).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn forwards_at_most_one_success_per_interval() {
        let (emit, emitted) = recorder();

        with_coalesced_execute_multi_progress(Some(emit), |progress| async move {
            let progress = progress.unwrap();
            for index in 0..1000 {
                progress(statement(index, 1000, true));
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await;

        let completed = completed(&emitted);
        assert!(completed.len() <= 11, "forwarded {} events for one second of statements", completed.len());
        assert!(completed.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(completed.last(), Some(&1000));
    }

    #[tokio::test(start_paused = true)]
    async fn forwards_failures_immediately_after_pending_successes() {
        let (emit, emitted) = recorder();

        with_coalesced_execute_multi_progress(Some(emit), |progress| async move {
            let progress = progress.unwrap();
            progress(statement(0, 4, true));
            progress(statement(1, 4, true));
            progress(statement(2, 4, false));
            progress(statement(3, 4, false));
            sleep(Duration::from_millis(30)).await;
        })
        .await;

        let emitted = emitted.lock().unwrap();
        assert_eq!(
            emitted.iter().map(|(progress, at)| (progress.completed, progress.success, *at)).collect::<Vec<_>>(),
            vec![(2, true, Duration::ZERO), (3, false, Duration::ZERO), (4, false, Duration::ZERO)]
        );
        assert_eq!(emitted[1].0.error, Some(BackendError::from_sql_detail("Duplicate entry")));
    }

    #[tokio::test(start_paused = true)]
    async fn forwards_pending_progress_while_a_later_statement_is_still_running() {
        let (emit, emitted) = recorder();

        with_coalesced_execute_multi_progress(Some(emit), |progress| async move {
            let progress = progress.unwrap();
            progress(statement(0, 2, true));
            sleep(Duration::from_secs(30)).await;
            progress(statement(1, 2, true));
        })
        .await;

        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 2);
        assert_eq!((emitted[0].0.completed, emitted[0].1), (1, EXECUTE_MULTI_PROGRESS_EMIT_INTERVAL));
        assert_eq!((emitted[1].0.completed, emitted[1].1), (2, Duration::from_secs(30)));
    }

    #[tokio::test(start_paused = true)]
    async fn forwards_the_last_completed_statement_before_returning() {
        let (emit, emitted) = recorder();

        let result: Result<(), &str> = with_coalesced_execute_multi_progress(Some(emit), |progress| async move {
            let progress = progress.unwrap();
            progress(statement(0, 3, true));
            progress(statement(1, 3, true));
            Err("connection lost")
        })
        .await;

        assert_eq!(result, Err("connection lost"));
        assert_eq!(completed(&emitted), vec![2]);
    }

    #[tokio::test]
    async fn runs_without_a_progress_callback_when_nobody_listens() {
        let received_callback =
            with_coalesced_execute_multi_progress(None, |progress| async move { progress.is_some() }).await;

        assert!(!received_callback);
    }
}
