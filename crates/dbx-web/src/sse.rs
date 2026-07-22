use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use tokio::sync::broadcast::{self, error::RecvError};

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
