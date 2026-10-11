use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::types::QueryMessage;

pub const MAX_QUERY_MESSAGES: usize = 1000;
pub const MAX_QUERY_MESSAGE_BYTES: usize = 1024 * 1024;

pub type QueryMessageSink = Arc<dyn Fn(QueryMessage) + Send + Sync>;
pub type QueryMessagesCallback = Arc<dyn Fn(Vec<QueryMessage>) + Send + Sync>;

tokio::task_local! {
    static QUERY_MESSAGE_SINK: QueryMessageSink;
}

pub fn current_query_message_sink() -> Option<QueryMessageSink> {
    QUERY_MESSAGE_SINK.try_with(Arc::clone).ok()
}

#[derive(Default)]
pub struct QueryMessageBuffer {
    messages: Vec<QueryMessage>,
    count: usize,
    bytes: usize,
    truncated: bool,
}

impl QueryMessageBuffer {
    pub fn push(&mut self, message: QueryMessage) -> Option<QueryMessage> {
        if self.truncated {
            return None;
        }
        let bytes = message.severity.len()
            + message.message.len()
            + message.code.as_ref().map_or(0, String::len)
            + message.detail.as_ref().map_or(0, String::len)
            + message.hint.as_ref().map_or(0, String::len);
        let message = if self.count >= MAX_QUERY_MESSAGES || bytes > MAX_QUERY_MESSAGE_BYTES.saturating_sub(self.bytes)
        {
            self.truncated = true;
            QueryMessage {
                severity: "WARNING".to_string(),
                message: "Server output limit reached; further messages are not retained.".to_string(),
                code: None,
                detail: None,
                hint: None,
            }
        } else {
            self.count += 1;
            self.bytes += bytes;
            message
        };
        self.messages.push(message.clone());
        Some(message)
    }

    pub fn drain(&mut self) -> Vec<QueryMessage> {
        std::mem::take(&mut self.messages)
    }

    pub fn take(&mut self) -> Vec<QueryMessage> {
        let messages = self.drain();
        *self = Self::default();
        messages
    }
}

pub async fn with_query_messages<F: Future>(emit: Option<QueryMessagesCallback>, run: F) -> F::Output {
    let Some(emit) = emit else {
        return run.await;
    };
    let pending = Arc::new(Mutex::new(QueryMessageBuffer::default()));
    let sink: QueryMessageSink = {
        let pending = Arc::clone(&pending);
        Arc::new(move |message| {
            pending.lock().unwrap_or_else(|error| error.into_inner()).push(message);
        })
    };
    let run = QUERY_MESSAGE_SINK.scope(sink, run);
    let mut run = std::pin::pin!(run);
    loop {
        let output = tokio::time::timeout(Duration::from_millis(100), run.as_mut()).await;
        let messages = pending.lock().unwrap_or_else(|error| error.into_inner()).drain();
        if !messages.is_empty() {
            emit(messages);
        }
        if let Ok(output) = output {
            return output;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(message: &str) -> QueryMessage {
        QueryMessage { severity: "NOTICE".into(), message: message.into(), code: None, detail: None, hint: None }
    }

    #[tokio::test(start_paused = true)]
    async fn query_messages_stream_before_completion_and_flush_on_error() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&emitted);
        let callback: QueryMessagesCallback = Arc::new(move |messages| output.lock().unwrap().extend(messages));
        let result = with_query_messages(Some(callback), async {
            let sink = current_query_message_sink().unwrap();
            sink(notice("first"));
            tokio::time::sleep(Duration::from_millis(250)).await;
            assert_eq!(emitted.lock().unwrap().len(), 1);
            sink(notice("second"));
            Err::<(), _>("failed")
        })
        .await;
        assert_eq!(result, Err("failed"));
        assert_eq!(
            emitted.lock().unwrap().iter().map(|message| message.message.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert!(current_query_message_sink().is_none());
    }

    #[test]
    fn query_message_buffer_caps_count_and_bytes_without_resetting_on_flush() {
        let mut buffer = QueryMessageBuffer::default();
        for _ in 0..MAX_QUERY_MESSAGES {
            assert!(buffer.push(notice("same")).is_some());
            buffer.drain();
        }
        assert_eq!(buffer.push(notice("overflow")).unwrap().severity, "WARNING");
        assert!(buffer.push(notice("overflow again")).is_none());
        buffer.take();
        assert!(buffer.push(notice("next statement")).is_some());
        buffer.take();
        assert_eq!(buffer.push(notice(&"x".repeat(MAX_QUERY_MESSAGE_BYTES))).unwrap().severity, "WARNING");
    }
}
