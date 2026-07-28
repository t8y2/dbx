use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::watch;

const TRANSFER_REPLAY_MAX_FAILURES: usize = 256;
const TRANSFER_REPLAY_MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
pub enum TransferReplayEventKind {
    Progress,
    Failure,
    Terminal,
}

#[derive(Default)]
struct TransferReplayHistory {
    failures: VecDeque<String>,
    failure_bytes: usize,
    latest: Option<String>,
    omitted_failures: usize,
}

pub struct TransferProgressChannel {
    tx: broadcast::Sender<String>,
    history: Mutex<TransferReplayHistory>,
}

impl TransferProgressChannel {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx, history: Mutex::new(TransferReplayHistory::default()) }
    }

    pub fn send(&self, data: String, kind: TransferReplayEventKind) {
        let mut history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match kind {
            TransferReplayEventKind::Progress => {
                history.latest = Some(data.clone());
            }
            TransferReplayEventKind::Terminal => {
                history.latest = Some(data.clone());
            }
            TransferReplayEventKind::Failure => {
                // The failure itself is the current progress until a newer event arrives.
                history.latest = None;
                while !history.failures.is_empty()
                    && (history.failures.len() >= TRANSFER_REPLAY_MAX_FAILURES
                        || history.failure_bytes.saturating_add(data.len()) > TRANSFER_REPLAY_MAX_BYTES)
                {
                    if let Some(removed) = history.failures.pop_front() {
                        history.failure_bytes = history.failure_bytes.saturating_sub(removed.len());
                        history.omitted_failures = history.omitted_failures.saturating_add(1);
                    }
                }
                if data.len() <= TRANSFER_REPLAY_MAX_BYTES {
                    history.failure_bytes += data.len();
                    history.failures.push_back(data.clone());
                } else {
                    history.omitted_failures = history.omitted_failures.saturating_add(1);
                }
            }
        }
        let _ = self.tx.send(data);
    }

    fn subscribe(&self) -> (Vec<String>, usize, broadcast::Receiver<String>) {
        // Subscribe while holding the history lock so an event is either in the
        // replay snapshot or in the live receiver, with no gap between them.
        let history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let rx = self.tx.subscribe();
        let mut replay = history.failures.iter().cloned().collect::<Vec<_>>();
        if let Some(latest) = &history.latest {
            replay.push(latest.clone());
        }
        (replay, history.omitted_failures, rx)
    }
}

fn attach_omitted_failure_count(data: &mut String, omitted_failures: usize) -> bool {
    if omitted_failures == 0 {
        return false;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    object.insert("transferFailuresOmitted".to_string(), Value::from(omitted_failures as u64));
    let Ok(serialized) = serde_json::to_string(&value) else {
        return false;
    };
    *data = serialized;
    true
}

pub fn sse_from_channel(
    rx: broadcast::Receiver<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    sse_from_channel_with_lag_policy(rx, false)
}

pub fn sse_from_lossy_channel(
    rx: broadcast::Receiver<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    sse_from_channel_with_lag_policy(rx, true)
}

fn sse_from_channel_with_lag_policy(
    mut rx: broadcast::Receiver<String>,
    recover_from_lag: bool,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(data) => yield Ok(Event::default().data(data)),
                // Only cumulative progress streams may skip stale snapshots; token and
                // data streams retain the previous fail-closed behavior on message loss.
                Err(RecvError::Lagged(_)) if recover_from_lag => continue,
                Err(RecvError::Lagged(_)) => break,
                Err(RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub fn sse_from_watch(
    mut rx: watch::Receiver<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    // A watch channel stores the latest state, so late subscribers immediately receive the
    // current progress, including a terminal result, instead of waiting for a new event.
    let stream = async_stream::stream! {
        let initial = rx.borrow().clone();
        if !initial.is_empty() {
            yield Ok(Event::default().data(initial));
        }
        while rx.changed().await.is_ok() {
            let update = rx.borrow().clone();
            yield Ok(Event::default().data(update));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub fn sse_from_transfer_channel(
    channel: Arc<TransferProgressChannel>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let (mut replay, mut pending_omitted_failures, mut rx) = channel.subscribe();
    if pending_omitted_failures > 0 {
        for data in replay.iter_mut().rev() {
            if attach_omitted_failure_count(data, pending_omitted_failures) {
                pending_omitted_failures = 0;
                break;
            }
        }
    }
    let stream = async_stream::stream! {
        for data in replay {
            yield Ok(Event::default().data(data));
        }
        loop {
            match rx.recv().await {
                Ok(mut data) => {
                    if pending_omitted_failures > 0 && attach_omitted_failure_count(&mut data, pending_omitted_failures) {
                        pending_omitted_failures = 0;
                    }
                    yield Ok(Event::default().data(data));
                }
                Err(RecvError::Lagged(_)) => break,
                Err(RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;

    fn failure_event(index: usize) -> String {
        format!(
            r#"{{"transferId":"transfer-1","table":"table-{index}","status":"error","error":"failure {index}","terminal":false}}"#
        )
    }

    fn terminal_event() -> String {
        r#"{"transferId":"transfer-1","status":"done","terminal":true}"#.to_string()
    }

    #[tokio::test]
    async fn delayed_transfer_subscription_replays_failure_and_terminal_events() {
        let channel = Arc::new(TransferProgressChannel::new());
        channel.send("early failure".to_string(), TransferReplayEventKind::Failure);
        channel.send("terminal result".to_string(), TransferReplayEventKind::Terminal);

        let response = sse_from_transfer_channel(channel).into_response();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();

        assert!(body.contains("data: early failure"));
        assert!(body.contains("data: terminal result"));
        assert!(body.find("early failure") < body.find("terminal result"));
    }

    #[tokio::test]
    async fn delayed_transfer_subscription_reports_evicted_failure_count() {
        let channel = Arc::new(TransferProgressChannel::new());
        for index in 0..=TRANSFER_REPLAY_MAX_FAILURES {
            channel.send(failure_event(index), TransferReplayEventKind::Failure);
        }
        channel.send(terminal_event(), TransferReplayEventKind::Terminal);

        let response = sse_from_transfer_channel(channel).into_response();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();

        assert_eq!(body.matches(r#""transferFailuresOmitted":1"#).count(), 1);
        let terminal = body.lines().find(|line| line.contains(r#""status":"done""#)).unwrap();
        assert!(terminal.contains(r#""transferFailuresOmitted":1"#));
    }

    #[tokio::test]
    async fn live_transfer_subscription_does_not_report_replay_omissions() {
        let channel = Arc::new(TransferProgressChannel::new());
        let (replay, omitted_failures, mut rx) = channel.subscribe();
        assert!(replay.is_empty());
        assert_eq!(omitted_failures, 0);

        for index in 0..=TRANSFER_REPLAY_MAX_FAILURES {
            let failure = failure_event(index);
            channel.send(failure.clone(), TransferReplayEventKind::Failure);
            assert_eq!(rx.recv().await.unwrap(), failure);
        }

        let terminal = terminal_event();
        channel.send(terminal.clone(), TransferReplayEventKind::Terminal);
        assert_eq!(rx.recv().await.unwrap(), terminal);
    }

    #[tokio::test]
    async fn mid_transfer_subscription_reports_only_pre_subscription_evictions() {
        let channel = Arc::new(TransferProgressChannel::new());
        for index in 0..=TRANSFER_REPLAY_MAX_FAILURES {
            channel.send(failure_event(index), TransferReplayEventKind::Failure);
        }

        let response = sse_from_transfer_channel(channel.clone()).into_response();
        let terminal = terminal_event();
        channel.send(terminal.clone(), TransferReplayEventKind::Terminal);
        drop(channel);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();

        assert_eq!(body.matches(r#""transferFailuresOmitted":1"#).count(), 1);
        let terminal_line = body.lines().find(|line| line.contains(r#""status":"done""#)).unwrap();
        assert_eq!(terminal_line, format!("data: {terminal}"));
    }

    #[tokio::test]
    async fn omitted_failure_without_replay_is_reported_on_the_next_live_event() {
        let channel = Arc::new(TransferProgressChannel::new());
        let oversized_failure = format!(
            r#"{{"transferId":"transfer-1","table":"large","status":"error","error":"{}","terminal":false}}"#,
            "x".repeat(TRANSFER_REPLAY_MAX_BYTES)
        );
        channel.send(oversized_failure, TransferReplayEventKind::Failure);

        let response = sse_from_transfer_channel(channel.clone()).into_response();
        channel.send(terminal_event(), TransferReplayEventKind::Terminal);
        drop(channel);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();

        assert!(body.contains(r#""transferFailuresOmitted":1"#));
    }
}
