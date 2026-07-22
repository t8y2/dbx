use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::watch;

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
