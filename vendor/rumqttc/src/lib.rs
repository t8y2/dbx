//! A pure rust MQTT client which strives to be robust, efficient and easy to use.
//! This library is backed by an async (tokio) eventloop which handles all the
//! robustness and and efficiency parts of MQTT but naturally fits into both sync
//! and async worlds as we'll see
//!
//! Let's jump into examples right away
//!
//! A simple synchronous publish and subscribe
//! ----------------------------
//!
//! ```no_run
//! use rumqttc::{MqttOptions, Client, QoS};
//! use std::time::Duration;
//! use std::thread;
//!
//! let mut mqttoptions = MqttOptions::new("rumqtt-sync", "test.mosquitto.org", 1883);
//! mqttoptions.set_keep_alive(Duration::from_secs(5));
//!
//! let (mut client, mut connection) = Client::new(mqttoptions, 10);
//! client.subscribe("hello/rumqtt", QoS::AtMostOnce).unwrap();
//! thread::spawn(move || for i in 0..10 {
//!    client.publish("hello/rumqtt", QoS::AtLeastOnce, false, vec![i; i as usize]).unwrap();
//!    thread::sleep(Duration::from_millis(100));
//! });
//!
//! // Iterate to poll the eventloop for connection progress
//! for (i, notification) in connection.iter().enumerate() {
//!     println!("Notification = {:?}", notification);
//! }
//! ```
//!
//! A simple asynchronous publish and subscribe
//! ------------------------------
//!
//! ```no_run
//! use rumqttc::{MqttOptions, AsyncClient, QoS};
//! use tokio::{task, time};
//! use std::time::Duration;
//! use std::error::Error;
//!
//! # #[tokio::main(flavor = "current_thread")]
//! # async fn main() {
//! let mut mqttoptions = MqttOptions::new("rumqtt-async", "test.mosquitto.org", 1883);
//! mqttoptions.set_keep_alive(Duration::from_secs(5));
//!
//! let (mut client, mut eventloop) = AsyncClient::new(mqttoptions, 10);
//! client.subscribe("hello/rumqtt", QoS::AtMostOnce).await.unwrap();
//!
//! task::spawn(async move {
//!     for i in 0..10 {
//!         client.publish("hello/rumqtt", QoS::AtLeastOnce, false, vec![i; i as usize]).await.unwrap();
//!         time::sleep(Duration::from_millis(100)).await;
//!     }
//! });
//!
//! loop {
//!     let notification = eventloop.poll().await.unwrap();
//!     println!("Received = {:?}", notification);
//! }
//! # }
//! ```
//!
//! Quick overview of features
//! - Eventloop orchestrates outgoing/incoming packets concurrently and handles the state
//! - Pings the broker when necessary and detects client side half open connections as well
//! - Throttling of outgoing packets (todo)
//! - Queue size based flow control on outgoing packets
//! - Automatic reconnections by just continuing the `eventloop.poll()`/`connection.iter()` loop
//! - Natural backpressure to client APIs during bad network
//!
//! In short, everything necessary to maintain a robust connection
//!
//! Since the eventloop is externally polled (with `iter()/poll()` in a loop)
//! out side the library and `Eventloop` is accessible, users can
//! - Distribute incoming messages based on topics
//! - Stop it when required
//! - Access internal state for use cases like graceful shutdown or to modify options before reconnection
//!
//! ## Important notes
//!
//! - Looping on `connection.iter()`/`eventloop.poll()` is necessary to run the
//!   event loop and make progress. It yields incoming and outgoing activity
//!   notifications which allows customization as you see fit.
//!
//! - Blocking inside the `connection.iter()`/`eventloop.poll()` loop will block
//!   connection progress.
//!
//! ## FAQ
//! **Connecting to a broker using raw ip doesn't work**
//!
//! You cannot create a TLS connection to a bare IP address with a self-signed
//! certificate. This is a [limitation of rustls](https://github.com/ctz/rustls/issues/184).
//! One workaround, which only works under *nix/BSD-like systems, is to add an
//! entry to wherever your DNS resolver looks (e.g. `/etc/hosts`) for the bare IP
//! address and use that name in your code.
#![cfg_attr(docsrs, feature(doc_cfg))]

#[macro_use]
extern crate log;

use std::fmt::{self, Debug, Formatter};

#[cfg(any(feature = "use-rustls", feature = "websocket"))]
use std::sync::Arc;

use std::time::Duration;

mod client;
mod eventloop;
mod framed;
pub mod mqttbytes;
mod state;
pub mod v5;

#[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
mod tls;

#[cfg(feature = "websocket")]
mod websockets;

#[cfg(feature = "websocket")]
use std::{
    future::{Future, IntoFuture},
    pin::Pin,
};

#[cfg(feature = "websocket")]
type RequestModifierFn = Arc<
    dyn Fn(http::Request<()>) -> Pin<Box<dyn Future<Output = http::Request<()>> + Send>>
        + Send
        + Sync,
>;

#[cfg(feature = "proxy")]
mod proxy;

pub use client::{
    AsyncClient, Client, ClientError, Connection, Iter, RecvError, RecvTimeoutError, TryRecvError,
};
pub use eventloop::{ConnectionError, Event, EventLoop};
pub use mqttbytes::v4::*;
pub use mqttbytes::*;
#[cfg(feature = "use-rustls")]
use rustls_native_certs::load_native_certs;
pub use state::{MqttState, StateError};
#[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
pub use tls::Error as TlsError;
#[cfg(feature = "use-rustls")]
pub use tokio_rustls;
#[cfg(feature = "use-rustls")]
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

#[cfg(feature = "proxy")]
pub use proxy::{Proxy, ProxyAuth, ProxyType};

pub type Incoming = Packet;

/// Current outgoing activity on the eventloop
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    /// Publish packet with packet identifier. 0 implies QoS 0
    Publish(u16),
    /// Subscribe packet with packet identifier
    Subscribe(u16),
    /// Unsubscribe packet with packet identifier
    Unsubscribe(u16),
    /// PubAck packet
    PubAck(u16),
    /// PubRec packet
    PubRec(u16),
    /// PubRel packet
    PubRel(u16),
    /// PubComp packet
    PubComp(u16),
    /// Ping request packet
    PingReq,
    /// Ping response packet
    PingResp,
    /// Disconnect packet
    Disconnect,
    /// Await for an ack for more outgoing progress
    AwaitAck(u16),
}

/// Requests by the client to mqtt event loop. Request are
/// handled one by one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Publish(Publish),
    PubAck(PubAck),
    PubRec(PubRec),
    PubComp(PubComp),
    PubRel(PubRel),
    PingReq(PingReq),
    PingResp(PingResp),
    Subscribe(Subscribe),
    SubAck(SubAck),
    Unsubscribe(Unsubscribe),
    UnsubAck(UnsubAck),
    Disconnect(Disconnect),
}

impl Request {
    fn size(&self) -> usize {
        match &self {
            Request::Publish(publish) => publish.size(),
            Request::PubAck(puback) => puback.size(),
            Request::PubRec(pubrec) => pubrec.size(),
            Request::PubComp(pubcomp) => pubcomp.size(),
            Request::PubRel(pubrel) => pubrel.size(),
            Request::PingReq(pingreq) => pingreq.size(),
            Request::PingResp(pingresp) => pingresp.size(),
            Request::Subscribe(subscribe) => subscribe.size(),
            Request::SubAck(suback) => suback.size(),
            Request::Unsubscribe(unsubscribe) => unsubscribe.size(),
            Request::UnsubAck(unsuback) => unsuback.size(),
            Request::Disconnect(disconn) => disconn.size(),
        }
    }
}

impl From<Publish> for Request {
    fn from(publish: Publish) -> Request {
        Request::Publish(publish)
    }
}

impl From<Subscribe> for Request {
    fn from(subscribe: Subscribe) -> Request {
        Request::Subscribe(subscribe)
    }
}

impl From<Unsubscribe> for Request {
    fn from(unsubscribe: Unsubscribe) -> Request {
        Request::Unsubscribe(unsubscribe)
    }
}

/// Transport methods. Defaults to TCP.
#[derive(Clone)]
pub enum Transport {
    Tcp,
    #[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
    Tls(TlsConfiguration),
    #[cfg(unix)]
    Unix,
    #[cfg(feature = "websocket")]
    #[cfg_attr(docsrs, doc(cfg(feature = "websocket")))]
    Ws,
    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    #[cfg_attr(docsrs, doc(cfg(all(feature = "use-rustls", feature = "websocket"))))]
    Wss(TlsConfiguration),
}

impl Default for Transport {
    fn default() -> Self {
        Self::tcp()
    }
}

impl Transport {
    /// Use regular tcp as transport (default)
    pub fn tcp() -> Self {
        Self::Tcp
    }

    #[cfg(feature = "use-rustls")]
    pub fn tls_with_default_config() -> Self {
        Self::tls_with_config(Default::default())
    }

    /// Use secure tcp with tls as transport
    #[cfg(feature = "use-rustls")]
    pub fn tls(
        ca: Vec<u8>,
        client_auth: Option<(Vec<u8>, Vec<u8>)>,
        alpn: Option<Vec<Vec<u8>>>,
    ) -> Self {
        let config = TlsConfiguration::Simple {
            ca,
            alpn,
            client_auth,
        };

        Self::tls_with_config(config)
    }

    #[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
    pub fn tls_with_config(tls_config: TlsConfiguration) -> Self {
        Self::Tls(tls_config)
    }

    #[cfg(unix)]
    pub fn unix() -> Self {
        Self::Unix
    }

    /// Use websockets as transport
    #[cfg(feature = "websocket")]
    #[cfg_attr(docsrs, doc(cfg(feature = "websocket")))]
    pub fn ws() -> Self {
        Self::Ws
    }

    /// Use secure websockets with tls as transport
    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    #[cfg_attr(docsrs, doc(cfg(all(feature = "use-rustls", feature = "websocket"))))]
    pub fn wss(
        ca: Vec<u8>,
        client_auth: Option<(Vec<u8>, Vec<u8>)>,
        alpn: Option<Vec<Vec<u8>>>,
    ) -> Self {
        let config = TlsConfiguration::Simple {
            ca,
            client_auth,
            alpn,
        };

        Self::wss_with_config(config)
    }

    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    #[cfg_attr(docsrs, doc(cfg(all(feature = "use-rustls", feature = "websocket"))))]
    pub fn wss_with_config(tls_config: TlsConfiguration) -> Self {
        Self::Wss(tls_config)
    }

    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    #[cfg_attr(docsrs, doc(cfg(all(feature = "use-rustls", feature = "websocket"))))]
    pub fn wss_with_default_config() -> Self {
        Self::Wss(Default::default())
    }
}

/// TLS configuration method
#[derive(Clone, Debug)]
#[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
pub enum TlsConfiguration {
    #[cfg(feature = "use-rustls")]
    Simple {
        /// connection method
        ca: Vec<u8>,
        /// alpn settings
        alpn: Option<Vec<Vec<u8>>>,
        /// tls client_authentication
        client_auth: Option<(Vec<u8>, Vec<u8>)>,
    },
    #[cfg(feature = "use-native-tls")]
    SimpleNative {
        /// ca certificate
        ca: Vec<u8>,
        /// pkcs12 binary der and
        /// password for use with der
        client_auth: Option<(Vec<u8>, String)>,
    },
    #[cfg(feature = "use-rustls")]
    /// Injected rustls ClientConfig for TLS, to allow more customisation.
    Rustls(Arc<ClientConfig>),
    #[cfg(feature = "use-native-tls")]
    Native,
}

#[cfg(feature = "use-rustls")]
impl Default for TlsConfiguration {
    fn default() -> Self {
        let mut root_cert_store = RootCertStore::empty();
        for cert in load_native_certs().expect("could not load platform certs") {
            root_cert_store.add(cert).unwrap();
        }
        let tls_config = ClientConfig::builder()
            .with_root_certificates(root_cert_store)
            .with_no_client_auth();

        Self::Rustls(Arc::new(tls_config))
    }
}

#[cfg(feature = "use-rustls")]
impl From<ClientConfig> for TlsConfiguration {
    fn from(config: ClientConfig) -> Self {
        TlsConfiguration::Rustls(Arc::new(config))
    }
}

/// Provides a way to configure low level network connection configurations
#[derive(Clone, Default)]
pub struct NetworkOptions {
    tcp_send_buffer_size: Option<u32>,
    tcp_recv_buffer_size: Option<u32>,
    conn_timeout: u64,
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    bind_device: Option<String>,
}

impl NetworkOptions {
    pub fn new() -> Self {
        NetworkOptions {
            tcp_send_buffer_size: None,
            tcp_recv_buffer_size: None,
            conn_timeout: 5,
            #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
            bind_device: None,
        }
    }

    pub fn set_tcp_send_buffer_size(&mut self, size: u32) {
        self.tcp_send_buffer_size = Some(size);
    }

    pub fn set_tcp_recv_buffer_size(&mut self, size: u32) {
        self.tcp_recv_buffer_size = Some(size);
    }

    /// set connection timeout in secs
    pub fn set_connection_timeout(&mut self, timeout: u64) -> &mut Self {
        self.conn_timeout = timeout;
        self
    }

    /// get timeout in secs
    pub fn connection_timeout(&self) -> u64 {
        self.conn_timeout
    }

    /// bind connection to a specific network device by name
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    #[cfg_attr(
        docsrs,
        doc(cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux")))
    )]
    pub fn set_bind_device(&mut self, bind_device: &str) -> &mut Self {
        self.bind_device = Some(bind_device.to_string());
        self
    }
}

// TODO: Should all the options be exposed as public? Drawback
// would be loosing the ability to panic when the user options
// are wrong (e.g empty client id) or aggressive (keep alive time)
/// Options to configure the behaviour of MQTT connection
#[derive(Clone)]
pub struct MqttOptions {
    /// broker address that you want to connect to
    broker_addr: String,
    /// broker port
    port: u16,
    // What transport protocol to use
    transport: Transport,
    /// MQTT protocol version
    protocol: Protocol,
    /// keep alive time to send pingreq to broker when the connection is idle
    keep_alive: Duration,
    /// clean (or) persistent session
    clean_session: bool,
    /// client identifier
    client_id: String,
    /// username and password
    credentials: Option<(String, String)>,
    /// maximum incoming packet size (verifies remaining length of the packet)
    max_incoming_packet_size: usize,
    /// Maximum outgoing packet size (only verifies publish payload size)
    max_outgoing_packet_size: usize,
    /// request (publish, subscribe) channel capacity
    request_channel_capacity: usize,
    /// Max internal request batching
    max_request_batch: usize,
    /// Minimum delay time between consecutive outgoing packets
    /// while retransmitting pending packets
    pending_throttle: Duration,
    /// maximum number of outgoing inflight messages
    inflight: u16,
    /// Last will that will be issued on unexpected disconnect
    last_will: Option<LastWill>,
    /// If set to `true` MQTT acknowledgements are not sent automatically.
    /// Every incoming publish packet must be manually acknowledged with `client.ack(...)` method.
    manual_acks: bool,
    #[cfg(feature = "proxy")]
    /// Proxy configuration.
    proxy: Option<Proxy>,
    #[cfg(feature = "websocket")]
    request_modifier: Option<RequestModifierFn>,
}

impl MqttOptions {
    /// Create an [`MqttOptions`] object that contains default values for all settings other than
    /// - id: A string to identify the device connecting to a broker
    /// - host: The broker's domain name or IP address
    /// - port: The port number on which broker must be listening for incoming connections
    ///
    /// ```
    /// # use rumqttc::MqttOptions;
    /// let options = MqttOptions::new("123", "localhost", 1883);
    /// ```
    pub fn new<S: Into<String>, T: Into<String>>(id: S, host: T, port: u16) -> MqttOptions {
        MqttOptions {
            broker_addr: host.into(),
            port,
            transport: Transport::tcp(),
            protocol: Protocol::V4,
            keep_alive: Duration::from_secs(60),
            clean_session: true,
            client_id: id.into(),
            credentials: None,
            max_incoming_packet_size: 10 * 1024,
            max_outgoing_packet_size: 10 * 1024,
            request_channel_capacity: 10,
            max_request_batch: 0,
            pending_throttle: Duration::from_micros(0),
            inflight: 100,
            last_will: None,
            manual_acks: false,
            #[cfg(feature = "proxy")]
            proxy: None,
            #[cfg(feature = "websocket")]
            request_modifier: None,
        }
    }

    #[cfg(feature = "url")]
    /// Creates an [`MqttOptions`] object by parsing provided string with the [url] crate's
    /// [`Url::parse(url)`](url::Url::parse) method and is only enabled when run using the "url" feature.
    ///
    /// ```
    /// # use rumqttc::MqttOptions;
    /// let options = MqttOptions::parse_url("mqtt://example.com:1883?client_id=123").unwrap();
    /// ```
    ///
    /// **NOTE:** A url must be prefixed with one of either `tcp://`, `mqtt://`, `ssl://`,`mqtts://`,
    /// `ws://` or `wss://` to denote the protocol for establishing a connection with the broker.
    ///
    /// **NOTE:** Encrypted connections(i.e. `mqtts://`, `ssl://`, `wss://`) by default use the
    /// system's root certificates. To configure with custom certificates, one may use the
    /// [`set_transport`](MqttOptions::set_transport) method.
    ///
    /// ```ignore
    /// # use rumqttc::{MqttOptions, Transport};
    /// # use tokio_rustls::rustls::ClientConfig;
    /// # let root_cert_store = rustls::RootCertStore::empty();
    /// # let client_config = ClientConfig::builder()
    /// #    .with_root_certificates(root_cert_store)
    /// #    .with_no_client_auth();
    /// let mut options = MqttOptions::parse_url("mqtts://example.com?client_id=123").unwrap();
    /// options.set_transport(Transport::tls_with_config(client_config.into()));
    /// ```
    pub fn parse_url<S: Into<String>>(url: S) -> Result<MqttOptions, OptionError> {
        let url = url::Url::parse(&url.into())?;
        let options = MqttOptions::try_from(url)?;

        Ok(options)
    }

    /// Broker address
    pub fn broker_address(&self) -> (String, u16) {
        (self.broker_addr.clone(), self.port)
    }

    pub fn set_last_will(&mut self, will: LastWill) -> &mut Self {
        self.last_will = Some(will);
        self
    }

    pub fn last_will(&self) -> Option<LastWill> {
        self.last_will.clone()
    }

    pub fn set_transport(&mut self, transport: Transport) -> &mut Self {
        self.transport = transport;
        self
    }

    pub fn transport(&self) -> Transport {
        self.transport.clone()
    }

    pub fn set_protocol(&mut self, protocol: Protocol) -> &mut Self {
        self.protocol = protocol;
        self
    }

    pub fn protocol(&self) -> Protocol {
        self.protocol
    }

    /// Set number of seconds after which client should ping the broker
    /// if there is no other data exchange
    pub fn set_keep_alive(&mut self, duration: Duration) -> &mut Self {
        assert!(
            duration.is_zero() || duration >= Duration::from_secs(1),
            "Keep alives should be specified in seconds. Durations less than \
            a second are not allowed, except for Duration::ZERO."
        );

        self.keep_alive = duration;
        self
    }

    /// Keep alive time
    pub fn keep_alive(&self) -> Duration {
        self.keep_alive
    }

    /// Client identifier
    pub fn client_id(&self) -> String {
        self.client_id.clone()
    }

    /// Set packet size limit for outgoing an incoming packets
    pub fn set_max_packet_size(&mut self, incoming: usize, outgoing: usize) -> &mut Self {
        self.max_incoming_packet_size = incoming;
        self.max_outgoing_packet_size = outgoing;
        self
    }

    /// Maximum packet size
    pub fn max_packet_size(&self) -> usize {
        self.max_incoming_packet_size
    }

    /// `clean_session = true` removes all the state from queues & instructs the broker
    /// to clean all the client state when client disconnects.
    ///
    /// When set `false`, broker will hold the client state and performs pending
    /// operations on the client when reconnection with same `client_id`
    /// happens. Local queue state is also held to retransmit packets after reconnection.
    ///
    /// # Panic
    ///
    /// Panics if `clean_session` is false when `client_id` is empty.
    ///
    /// ```should_panic
    /// # use rumqttc::MqttOptions;
    /// let mut options = MqttOptions::new("", "localhost", 1883);
    /// options.set_clean_session(false);
    /// ```
    pub fn set_clean_session(&mut self, clean_session: bool) -> &mut Self {
        assert!(
            !self.client_id.is_empty() || clean_session,
            "Cannot unset clean session when client id is empty"
        );
        self.clean_session = clean_session;
        self
    }

    /// Clean session
    pub fn clean_session(&self) -> bool {
        self.clean_session
    }

    /// Username and password
    pub fn set_credentials<U: Into<String>, P: Into<String>>(
        &mut self,
        username: U,
        password: P,
    ) -> &mut Self {
        self.credentials = Some((username.into(), password.into()));
        self
    }

    /// Security options
    pub fn credentials(&self) -> Option<(String, String)> {
        self.credentials.clone()
    }

    /// Set request channel capacity
    pub fn set_request_channel_capacity(&mut self, capacity: usize) -> &mut Self {
        self.request_channel_capacity = capacity;
        self
    }

    /// Request channel capacity
    pub fn request_channel_capacity(&self) -> usize {
        self.request_channel_capacity
    }

    /// Enables throttling and sets outoing message rate to the specified 'rate'
    pub fn set_pending_throttle(&mut self, duration: Duration) -> &mut Self {
        self.pending_throttle = duration;
        self
    }

    /// Outgoing message rate
    pub fn pending_throttle(&self) -> Duration {
        self.pending_throttle
    }

    /// Set number of concurrent in flight messages
    pub fn set_inflight(&mut self, inflight: u16) -> &mut Self {
        assert!(inflight != 0, "zero in flight is not allowed");

        self.inflight = inflight;
        self
    }

    /// Number of concurrent in flight messages
    pub fn inflight(&self) -> u16 {
        self.inflight
    }

    /// set manual acknowledgements
    pub fn set_manual_acks(&mut self, manual_acks: bool) -> &mut Self {
        self.manual_acks = manual_acks;
        self
    }

    /// get manual acknowledgements
    pub fn manual_acks(&self) -> bool {
        self.manual_acks
    }

    #[cfg(feature = "proxy")]
    pub fn set_proxy(&mut self, proxy: Proxy) -> &mut Self {
        self.proxy = Some(proxy);
        self
    }

    #[cfg(feature = "proxy")]
    pub fn proxy(&self) -> Option<Proxy> {
        self.proxy.clone()
    }

    #[cfg(feature = "websocket")]
    pub fn set_request_modifier<F, O>(&mut self, request_modifier: F) -> &mut Self
    where
        F: Fn(http::Request<()>) -> O + Send + Sync + 'static,
        O: IntoFuture<Output = http::Request<()>> + 'static,
        O::IntoFuture: Send,
    {
        self.request_modifier = Some(Arc::new(move |request| {
            let request_modifier = request_modifier(request).into_future();
            Box::pin(request_modifier)
        }));

        self
    }

    #[cfg(feature = "websocket")]
    pub fn request_modifier(&self) -> Option<RequestModifierFn> {
        self.request_modifier.clone()
    }
}

#[cfg(feature = "url")]
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum OptionError {
    #[error("Unsupported URL scheme.")]
    Scheme,

    #[error("Missing client ID.")]
    ClientId,

    #[error("Invalid keep-alive value.")]
    KeepAlive,

    #[error("Invalid clean-session value.")]
    CleanSession,

    #[error("Invalid max-incoming-packet-size value.")]
    MaxIncomingPacketSize,

    #[error("Invalid max-outgoing-packet-size value.")]
    MaxOutgoingPacketSize,

    #[error("Invalid request-channel-capacity value.")]
    RequestChannelCapacity,

    #[error("Invalid max-request-batch value.")]
    MaxRequestBatch,

    #[error("Invalid pending-throttle value.")]
    PendingThrottle,

    #[error("Invalid inflight value.")]
    Inflight,

    #[error("Unknown option: {0}")]
    Unknown(String),

    #[error("Couldn't parse option from url: {0}")]
    Parse(#[from] url::ParseError),
}

#[cfg(feature = "url")]
impl std::convert::TryFrom<url::Url> for MqttOptions {
    type Error = OptionError;

    fn try_from(url: url::Url) -> Result<Self, Self::Error> {
        use std::collections::HashMap;

        let host = url.host_str().unwrap_or_default().to_owned();

        let (transport, default_port) = match url.scheme() {
            // Encrypted connections are supported, but require explicit TLS configuration. We fall
            // back to the unencrypted transport layer, so that `set_transport` can be used to
            // configure the encrypted transport layer with the provided TLS configuration.
            #[cfg(feature = "use-rustls")]
            "mqtts" | "ssl" => (Transport::tls_with_default_config(), 8883),
            "mqtt" | "tcp" => (Transport::Tcp, 1883),
            #[cfg(feature = "websocket")]
            "ws" => (Transport::Ws, 8000),
            #[cfg(all(feature = "use-rustls", feature = "websocket"))]
            "wss" => (Transport::wss_with_default_config(), 8000),
            _ => return Err(OptionError::Scheme),
        };

        let port = url.port().unwrap_or(default_port);

        let mut queries = url.query_pairs().collect::<HashMap<_, _>>();

        let id = queries
            .remove("client_id")
            .ok_or(OptionError::ClientId)?
            .into_owned();

        let mut options = MqttOptions::new(id, host, port);
        options.set_transport(transport);

        if let Some(keep_alive) = queries
            .remove("keep_alive_secs")
            .map(|v| v.parse::<u64>().map_err(|_| OptionError::KeepAlive))
            .transpose()?
        {
            options.set_keep_alive(Duration::from_secs(keep_alive));
        }

        if let Some(clean_session) = queries
            .remove("clean_session")
            .map(|v| v.parse::<bool>().map_err(|_| OptionError::CleanSession))
            .transpose()?
        {
            options.set_clean_session(clean_session);
        }

        if let Some((username, password)) = {
            match url.username() {
                "" => None,
                username => Some((
                    username.to_owned(),
                    url.password().unwrap_or_default().to_owned(),
                )),
            }
        } {
            options.set_credentials(username, password);
        }

        if let (Some(incoming), Some(outgoing)) = (
            queries
                .remove("max_incoming_packet_size_bytes")
                .map(|v| {
                    v.parse::<usize>()
                        .map_err(|_| OptionError::MaxIncomingPacketSize)
                })
                .transpose()?,
            queries
                .remove("max_outgoing_packet_size_bytes")
                .map(|v| {
                    v.parse::<usize>()
                        .map_err(|_| OptionError::MaxOutgoingPacketSize)
                })
                .transpose()?,
        ) {
            options.set_max_packet_size(incoming, outgoing);
        }

        if let Some(request_channel_capacity) = queries
            .remove("request_channel_capacity_num")
            .map(|v| {
                v.parse::<usize>()
                    .map_err(|_| OptionError::RequestChannelCapacity)
            })
            .transpose()?
        {
            options.request_channel_capacity = request_channel_capacity;
        }

        if let Some(max_request_batch) = queries
            .remove("max_request_batch_num")
            .map(|v| v.parse::<usize>().map_err(|_| OptionError::MaxRequestBatch))
            .transpose()?
        {
            options.max_request_batch = max_request_batch;
        }

        if let Some(pending_throttle) = queries
            .remove("pending_throttle_usecs")
            .map(|v| v.parse::<u64>().map_err(|_| OptionError::PendingThrottle))
            .transpose()?
        {
            options.set_pending_throttle(Duration::from_micros(pending_throttle));
        }

        if let Some(inflight) = queries
            .remove("inflight_num")
            .map(|v| v.parse::<u16>().map_err(|_| OptionError::Inflight))
            .transpose()?
        {
            options.set_inflight(inflight);
        }

        if let Some((opt, _)) = queries.into_iter().next() {
            return Err(OptionError::Unknown(opt.into_owned()));
        }

        Ok(options)
    }
}

// Implement Debug manually because ClientConfig doesn't implement it, so derive(Debug) doesn't
// work.
impl Debug for MqttOptions {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        f.debug_struct("MqttOptions")
            .field("broker_addr", &self.broker_addr)
            .field("port", &self.port)
            .field("protocol", &self.protocol)
            .field("keep_alive", &self.keep_alive)
            .field("clean_session", &self.clean_session)
            .field("client_id", &self.client_id)
            .field("credentials", &self.credentials)
            .field("max_packet_size", &self.max_incoming_packet_size)
            .field("request_channel_capacity", &self.request_channel_capacity)
            .field("max_request_batch", &self.max_request_batch)
            .field("pending_throttle", &self.pending_throttle)
            .field("inflight", &self.inflight)
            .field("last_will", &self.last_will)
            .field("manual_acks", &self.manual_acks)
            .finish()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    fn no_scheme() {
        let mut mqttoptions = MqttOptions::new("client_a", "a3f8czas.iot.eu-west-1.amazonaws.com/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=MyCreds%2F20201001%2Feu-west-1%2Fiotdevicegateway%2Faws4_request&X-Amz-Date=20201001T130812Z&X-Amz-Expires=7200&X-Amz-Signature=9ae09b49896f44270f2707551581953e6cac71a4ccf34c7c3415555be751b2d1&X-Amz-SignedHeaders=host", 443);

        mqttoptions.set_transport(crate::Transport::wss(Vec::from("Test CA"), None, None));

        if let crate::Transport::Wss(TlsConfiguration::Simple {
            ca,
            client_auth,
            alpn,
        }) = mqttoptions.transport
        {
            assert_eq!(ca, Vec::from("Test CA"));
            assert_eq!(client_auth, None);
            assert_eq!(alpn, None);
        } else {
            panic!("Unexpected transport!");
        }

        assert_eq!(mqttoptions.broker_addr, "a3f8czas.iot.eu-west-1.amazonaws.com/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=MyCreds%2F20201001%2Feu-west-1%2Fiotdevicegateway%2Faws4_request&X-Amz-Date=20201001T130812Z&X-Amz-Expires=7200&X-Amz-Signature=9ae09b49896f44270f2707551581953e6cac71a4ccf34c7c3415555be751b2d1&X-Amz-SignedHeaders=host");
    }

    #[test]
    #[cfg(feature = "url")]
    fn from_url() {
        fn opt(s: &str) -> Result<MqttOptions, OptionError> {
            MqttOptions::parse_url(s)
        }
        fn ok(s: &str) -> MqttOptions {
            opt(s).expect("valid options")
        }
        fn err(s: &str) -> OptionError {
            opt(s).expect_err("invalid options")
        }

        let v = ok("mqtt://host:42?client_id=foo");
        assert_eq!(v.broker_address(), ("host".to_owned(), 42));
        assert_eq!(v.client_id(), "foo".to_owned());

        let v = ok("mqtt://host:42?client_id=foo&keep_alive_secs=5");
        assert_eq!(v.keep_alive, Duration::from_secs(5));

        assert_eq!(err("mqtt://host:42"), OptionError::ClientId);
        assert_eq!(
            err("mqtt://host:42?client_id=foo&foo=bar"),
            OptionError::Unknown("foo".to_owned())
        );
        assert_eq!(err("mqt://host:42?client_id=foo"), OptionError::Scheme);
        assert_eq!(
            err("mqtt://host:42?client_id=foo&keep_alive_secs=foo"),
            OptionError::KeepAlive
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&clean_session=foo"),
            OptionError::CleanSession
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&max_incoming_packet_size_bytes=foo"),
            OptionError::MaxIncomingPacketSize
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&max_outgoing_packet_size_bytes=foo"),
            OptionError::MaxOutgoingPacketSize
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&request_channel_capacity_num=foo"),
            OptionError::RequestChannelCapacity
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&max_request_batch_num=foo"),
            OptionError::MaxRequestBatch
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&pending_throttle_usecs=foo"),
            OptionError::PendingThrottle
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&inflight_num=foo"),
            OptionError::Inflight
        );
    }

    #[test]
    fn accept_empty_client_id() {
        let _mqtt_opts = MqttOptions::new("", "127.0.0.1", 1883).set_clean_session(true);
    }

    #[test]
    fn set_clean_session_when_client_id_present() {
        let mut options = MqttOptions::new("client_id", "127.0.0.1", 1883);
        options.set_clean_session(false);
        options.set_clean_session(true);
    }
}
