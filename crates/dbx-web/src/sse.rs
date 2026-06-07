use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use tokio::sync::broadcast;

pub fn sse_from_channel(
    mut rx: broadcast::Receiver<String>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream = async_stream::stream! {
        while let Ok(data) = rx.recv().await {
            yield Ok(Event::default().data(data));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}
