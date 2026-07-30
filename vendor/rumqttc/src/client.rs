//! This module offers a high level synchronous and asynchronous abstraction to
//! async eventloop.
use std::time::Duration;

use crate::mqttbytes::{v4::*, QoS};
use crate::{valid_topic, ConnectionError, Event, EventLoop, MqttOptions, Request};

use bytes::Bytes;
use flume::{SendError, Sender, TrySendError};
use futures_util::FutureExt;
use tokio::runtime::{self, Runtime};
use tokio::time::timeout;

/// Client Error
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Failed to send mqtt requests to eventloop")]
    Request(Request),
    #[error("Failed to send mqtt requests to eventloop")]
    TryRequest(Request),
}

impl From<SendError<Request>> for ClientError {
    fn from(e: SendError<Request>) -> Self {
        Self::Request(e.into_inner())
    }
}

impl From<TrySendError<Request>> for ClientError {
    fn from(e: TrySendError<Request>) -> Self {
        Self::TryRequest(e.into_inner())
    }
}

/// An asynchronous client, communicates with MQTT `EventLoop`.
///
/// This is cloneable and can be used to asynchronously [`publish`](`AsyncClient::publish`),
/// [`subscribe`](`AsyncClient::subscribe`) through the `EventLoop`, which is to be polled parallelly.
///
/// **NOTE**: The `EventLoop` must be regularly polled in order to send, receive and process packets
/// from the broker, i.e. move ahead.
#[derive(Clone, Debug)]
pub struct AsyncClient {
    request_tx: Sender<Request>,
}

impl AsyncClient {
    /// Create a new `AsyncClient`.
    ///
    /// `cap` specifies the capacity of the bounded async channel.
    pub fn new(options: MqttOptions, cap: usize) -> (AsyncClient, EventLoop) {
        let eventloop = EventLoop::new(options, cap);
        let request_tx = eventloop.requests_tx.clone();

        let client = AsyncClient { request_tx };

        (client, eventloop)
    }

    /// Create a new `AsyncClient` from a channel `Sender`.
    ///
    /// This is mostly useful for creating a test instance where you can
    /// listen on the corresponding receiver.
    pub fn from_senders(request_tx: Sender<Request>) -> AsyncClient {
        AsyncClient { request_tx }
    }

    /// Sends a MQTT Publish to the `EventLoop`.
    pub async fn publish<S, V>(
        &self,
        topic: S,
        qos: QoS,
        retain: bool,
        payload: V,
    ) -> Result<(), ClientError>
    where
        S: Into<String>,
        V: Into<Vec<u8>>,
    {
        let topic = topic.into();
        let mut publish = Publish::new(&topic, qos, payload);
        publish.retain = retain;
        let publish = Request::Publish(publish);
        if !valid_topic(&topic) {
            return Err(ClientError::Request(publish));
        }
        self.request_tx.send_async(publish).await?;
        Ok(())
    }

    /// Attempts to send a MQTT Publish to the `EventLoop`.
    pub fn try_publish<S, V>(
        &self,
        topic: S,
        qos: QoS,
        retain: bool,
        payload: V,
    ) -> Result<(), ClientError>
    where
        S: Into<String>,
        V: Into<Vec<u8>>,
    {
        let topic = topic.into();
        let mut publish = Publish::new(&topic, qos, payload);
        publish.retain = retain;
        let publish = Request::Publish(publish);
        if !valid_topic(&topic) {
            return Err(ClientError::TryRequest(publish));
        }
        self.request_tx.try_send(publish)?;
        Ok(())
    }

    /// Sends a MQTT PubAck to the `EventLoop`. Only needed in if `manual_acks` flag is set.
    pub async fn ack(&self, publish: &Publish) -> Result<(), ClientError> {
        let ack = get_ack_req(publish);

        if let Some(ack) = ack {
            self.request_tx.send_async(ack).await?;
        }
        Ok(())
    }

    /// Attempts to send a MQTT PubAck to the `EventLoop`. Only needed in if `manual_acks` flag is set.
    pub fn try_ack(&self, publish: &Publish) -> Result<(), ClientError> {
        let ack = get_ack_req(publish);
        if let Some(ack) = ack {
            self.request_tx.try_send(ack)?;
        }
        Ok(())
    }

    /// Sends a MQTT Publish to the `EventLoop`
    pub async fn publish_bytes<S>(
        &self,
        topic: S,
        qos: QoS,
        retain: bool,
        payload: Bytes,
    ) -> Result<(), ClientError>
    where
        S: Into<String>,
    {
        let mut publish = Publish::from_bytes(topic, qos, payload);
        publish.retain = retain;
        let publish = Request::Publish(publish);
        self.request_tx.send_async(publish).await?;
        Ok(())
    }

    /// Sends a MQTT Subscribe to the `EventLoop`
    pub async fn subscribe<S: Into<String>>(&self, topic: S, qos: QoS) -> Result<(), ClientError> {
        let subscribe = Subscribe::new(topic.into(), qos);
        let request = Request::Subscribe(subscribe);
        self.request_tx.send_async(request).await?;
        Ok(())
    }

    /// Attempts to send a MQTT Subscribe to the `EventLoop`
    pub fn try_subscribe<S: Into<String>>(&self, topic: S, qos: QoS) -> Result<(), ClientError> {
        let subscribe = Subscribe::new(topic.into(), qos);
        let request = Request::Subscribe(subscribe);
        self.request_tx.try_send(request)?;
        Ok(())
    }

    /// Sends a MQTT Subscribe for multiple topics to the `EventLoop`
    pub async fn subscribe_many<T>(&self, topics: T) -> Result<(), ClientError>
    where
        T: IntoIterator<Item = SubscribeFilter>,
    {
        let subscribe = Subscribe::new_many(topics);
        let request = Request::Subscribe(subscribe);
        self.request_tx.send_async(request).await?;
        Ok(())
    }

    /// Attempts to send a MQTT Subscribe for multiple topics to the `EventLoop`
    pub fn try_subscribe_many<T>(&self, topics: T) -> Result<(), ClientError>
    where
        T: IntoIterator<Item = SubscribeFilter>,
    {
        let subscribe = Subscribe::new_many(topics);
        let request = Request::Subscribe(subscribe);
        self.request_tx.try_send(request)?;
        Ok(())
    }

    /// Sends a MQTT Unsubscribe to the `EventLoop`
    pub async fn unsubscribe<S: Into<String>>(&self, topic: S) -> Result<(), ClientError> {
        let unsubscribe = Unsubscribe::new(topic.into());
        let request = Request::Unsubscribe(unsubscribe);
        self.request_tx.send_async(request).await?;
        Ok(())
    }

    /// Attempts to send a MQTT Unsubscribe to the `EventLoop`
    pub fn try_unsubscribe<S: Into<String>>(&self, topic: S) -> Result<(), ClientError> {
        let unsubscribe = Unsubscribe::new(topic.into());
        let request = Request::Unsubscribe(unsubscribe);
        self.request_tx.try_send(request)?;
        Ok(())
    }

    /// Sends a MQTT disconnect to the `EventLoop`
    pub async fn disconnect(&self) -> Result<(), ClientError> {
        let request = Request::Disconnect(Disconnect);
        self.request_tx.send_async(request).await?;
        Ok(())
    }

    /// Attempts to send a MQTT disconnect to the `EventLoop`
    pub fn try_disconnect(&self) -> Result<(), ClientError> {
        let request = Request::Disconnect(Disconnect);
        self.request_tx.try_send(request)?;
        Ok(())
    }
}

fn get_ack_req(publish: &Publish) -> Option<Request> {
    let ack = match publish.qos {
        QoS::AtMostOnce => return None,
        QoS::AtLeastOnce => Request::PubAck(PubAck::new(publish.pkid)),
        QoS::ExactlyOnce => Request::PubRec(PubRec::new(publish.pkid)),
    };
    Some(ack)
}

/// A synchronous client, communicates with MQTT `EventLoop`.
///
/// This is cloneable and can be used to synchronously [`publish`](`AsyncClient::publish`),
/// [`subscribe`](`AsyncClient::subscribe`) through the `EventLoop`/`Connection`, which is to be polled in parallel
/// by iterating over the object returned by [`Connection.iter()`](Connection::iter) in a separate thread.
///
/// **NOTE**: The `EventLoop`/`Connection` must be regularly polled(`.next()` in case of `Connection`) in order
/// to send, receive and process packets from the broker, i.e. move ahead.
///
/// An asynchronous channel handle can also be extracted if necessary.
#[derive(Clone)]
pub struct Client {
    client: AsyncClient,
}

impl Client {
    /// Create a new `Client`
    ///
    /// `cap` specifies the capacity of the bounded async channel.
    pub fn new(options: MqttOptions, cap: usize) -> (Client, Connection) {
        let (client, eventloop) = AsyncClient::new(options, cap);
        let client = Client { client };
        let runtime = runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let connection = Connection::new(eventloop, runtime);
        (client, connection)
    }

    /// Create a new `Client` from a channel `Sender`.
    ///
    /// This is mostly useful for creating a test instance where you can
    /// listen on the corresponding receiver.
    pub fn from_sender(request_tx: Sender<Request>) -> Client {
        Client {
            client: AsyncClient::from_senders(request_tx),
        }
    }

    /// Sends a MQTT Publish to the `EventLoop`
    pub fn publish<S, V>(
        &self,
        topic: S,
        qos: QoS,
        retain: bool,
        payload: V,
    ) -> Result<(), ClientError>
    where
        S: Into<String>,
        V: Into<Vec<u8>>,
    {
        let topic = topic.into();
        let mut publish = Publish::new(&topic, qos, payload);
        publish.retain = retain;
        let publish = Request::Publish(publish);
        if !valid_topic(&topic) {
            return Err(ClientError::Request(publish));
        }
        self.client.request_tx.send(publish)?;
        Ok(())
    }

    pub fn try_publish<S, V>(
        &self,
        topic: S,
        qos: QoS,
        retain: bool,
        payload: V,
    ) -> Result<(), ClientError>
    where
        S: Into<String>,
        V: Into<Vec<u8>>,
    {
        self.client.try_publish(topic, qos, retain, payload)?;
        Ok(())
    }

    /// Sends a MQTT PubAck to the `EventLoop`. Only needed in if `manual_acks` flag is set.
    pub fn ack(&self, publish: &Publish) -> Result<(), ClientError> {
        let ack = get_ack_req(publish);

        if let Some(ack) = ack {
            self.client.request_tx.send(ack)?;
        }
        Ok(())
    }

    /// Sends a MQTT PubAck to the `EventLoop`. Only needed in if `manual_acks` flag is set.
    pub fn try_ack(&self, publish: &Publish) -> Result<(), ClientError> {
        self.client.try_ack(publish)?;
        Ok(())
    }

    /// Sends a MQTT Subscribe to the `EventLoop`
    pub fn subscribe<S: Into<String>>(&self, topic: S, qos: QoS) -> Result<(), ClientError> {
        let subscribe = Subscribe::new(topic.into(), qos);
        let request = Request::Subscribe(subscribe);
        self.client.request_tx.send(request)?;
        Ok(())
    }

    /// Sends a MQTT Subscribe to the `EventLoop`
    pub fn try_subscribe<S: Into<String>>(&self, topic: S, qos: QoS) -> Result<(), ClientError> {
        self.client.try_subscribe(topic, qos)?;
        Ok(())
    }

    /// Sends a MQTT Subscribe for multiple topics to the `EventLoop`
    pub fn subscribe_many<T>(&self, topics: T) -> Result<(), ClientError>
    where
        T: IntoIterator<Item = SubscribeFilter>,
    {
        let subscribe = Subscribe::new_many(topics);
        let request = Request::Subscribe(subscribe);
        self.client.request_tx.send(request)?;
        Ok(())
    }

    pub fn try_subscribe_many<T>(&self, topics: T) -> Result<(), ClientError>
    where
        T: IntoIterator<Item = SubscribeFilter>,
    {
        self.client.try_subscribe_many(topics)
    }

    /// Sends a MQTT Unsubscribe to the `EventLoop`
    pub fn unsubscribe<S: Into<String>>(&self, topic: S) -> Result<(), ClientError> {
        let unsubscribe = Unsubscribe::new(topic.into());
        let request = Request::Unsubscribe(unsubscribe);
        self.client.request_tx.send(request)?;
        Ok(())
    }

    /// Sends a MQTT Unsubscribe to the `EventLoop`
    pub fn try_unsubscribe<S: Into<String>>(&self, topic: S) -> Result<(), ClientError> {
        self.client.try_unsubscribe(topic)?;
        Ok(())
    }

    /// Sends a MQTT disconnect to the `EventLoop`
    pub fn disconnect(&self) -> Result<(), ClientError> {
        let request = Request::Disconnect(Disconnect);
        self.client.request_tx.send(request)?;
        Ok(())
    }

    /// Sends a MQTT disconnect to the `EventLoop`
    pub fn try_disconnect(&self) -> Result<(), ClientError> {
        self.client.try_disconnect()?;
        Ok(())
    }
}

/// Error type returned by [`Connection::recv`]
#[derive(Debug, Eq, PartialEq)]
pub struct RecvError;

/// Error type returned by [`Connection::try_recv`]
#[derive(Debug, Eq, PartialEq)]
pub enum TryRecvError {
    /// User has closed requests channel
    Disconnected,
    /// Did not resolve
    Empty,
}

/// Error type returned by [`Connection::recv_timeout`]
#[derive(Debug, Eq, PartialEq)]
pub enum RecvTimeoutError {
    /// User has closed requests channel
    Disconnected,
    /// Recv request timedout
    Timeout,
}

///  MQTT connection. Maintains all the necessary state
pub struct Connection {
    pub eventloop: EventLoop,
    runtime: Runtime,
}
impl Connection {
    fn new(eventloop: EventLoop, runtime: Runtime) -> Connection {
        Connection { eventloop, runtime }
    }

    /// Returns an iterator over this connection. Iterating over this is all that's
    /// necessary to make connection progress and maintain a robust connection.
    /// Just continuing to loop will reconnect
    /// **NOTE** Don't block this while iterating
    // ideally this should be named iter_mut because it requires a mutable reference
    // Also we can implement IntoIter for this to make it easy to iterate over it
    #[must_use = "Connection should be iterated over a loop to make progress"]
    pub fn iter(&mut self) -> Iter<'_> {
        Iter { connection: self }
    }

    /// Attempt to fetch an incoming [`Event`] on the [`EvenLoop`], returning an error
    /// if all clients/users have closed requests channel.
    ///
    /// [`EvenLoop`]: super::EventLoop
    pub fn recv(&mut self) -> Result<Result<Event, ConnectionError>, RecvError> {
        let f = self.eventloop.poll();
        let event = self.runtime.block_on(f);

        resolve_event(event).ok_or(RecvError)
    }

    /// Attempt to fetch an incoming [`Event`] on the [`EvenLoop`], returning an error
    /// if none immediately present or all clients/users have closed requests channel.
    ///
    /// [`EvenLoop`]: super::EventLoop
    pub fn try_recv(&mut self) -> Result<Result<Event, ConnectionError>, TryRecvError> {
        let f = self.eventloop.poll();
        // Enters the runtime context so we can poll the future, as required by `now_or_never()`.
        // ref: https://docs.rs/tokio/latest/tokio/runtime/struct.Runtime.html#method.enter
        let _guard = self.runtime.enter();
        let event = f.now_or_never().ok_or(TryRecvError::Empty)?;

        resolve_event(event).ok_or(TryRecvError::Disconnected)
    }

    /// Attempt to fetch an incoming [`Event`] on the [`EvenLoop`], returning an error
    /// if all clients/users have closed requests channel or the timeout has expired.
    ///
    /// [`EvenLoop`]: super::EventLoop
    pub fn recv_timeout(
        &mut self,
        duration: Duration,
    ) -> Result<Result<Event, ConnectionError>, RecvTimeoutError> {
        let f = self.eventloop.poll();
        let event = self
            .runtime
            .block_on(async { timeout(duration, f).await })
            .map_err(|_| RecvTimeoutError::Timeout)?;

        resolve_event(event).ok_or(RecvTimeoutError::Disconnected)
    }
}

fn resolve_event(event: Result<Event, ConnectionError>) -> Option<Result<Event, ConnectionError>> {
    match event {
        Ok(v) => Some(Ok(v)),
        // closing of request channel should stop the iterator
        Err(ConnectionError::RequestsDone) => {
            trace!("Done with requests");
            None
        }
        Err(e) => Some(Err(e)),
    }
}

/// Iterator which polls the `EventLoop` for connection progress
pub struct Iter<'a> {
    connection: &'a mut Connection,
}

impl Iterator for Iter<'_> {
    type Item = Result<Event, ConnectionError>;

    fn next(&mut self) -> Option<Self::Item> {
        self.connection.recv().ok()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn calling_iter_twice_on_connection_shouldnt_panic() {
        use std::time::Duration;

        let mut mqttoptions = MqttOptions::new("test-1", "localhost", 1883);
        let will = LastWill::new("hello/world", "good bye", QoS::AtMostOnce, false);
        mqttoptions
            .set_keep_alive(Duration::from_secs(5))
            .set_last_will(will);

        let (_, mut connection) = Client::new(mqttoptions, 10);
        let _ = connection.iter();
        let _ = connection.iter();
    }

    #[test]
    fn should_be_able_to_build_test_client_from_channel() {
        let (tx, rx) = flume::bounded(1);
        let client = Client::from_sender(tx);
        client
            .publish("hello/world", QoS::ExactlyOnce, false, "good bye")
            .expect("Should be able to publish");
        let _ = rx.try_recv().expect("Should have message");
    }
}
