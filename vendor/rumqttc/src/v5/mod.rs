use bytes::Bytes;
use std::fmt::{self, Debug, Formatter};
use std::time::Duration;
#[cfg(feature = "websocket")]
use std::{
    future::{Future, IntoFuture},
    pin::Pin,
    sync::Arc,
};

mod client;
mod eventloop;
mod framed;
pub mod mqttbytes;
mod state;

use crate::Outgoing;
use crate::{NetworkOptions, Transport};

use mqttbytes::v5::*;

pub use client::{AsyncClient, Client, ClientError, Connection, Iter};
pub use eventloop::{ConnectionError, Event, EventLoop};
pub use state::{MqttState, StateError};

#[cfg(feature = "use-rustls")]
pub use crate::tls::Error as TlsError;

#[cfg(feature = "proxy")]
pub use crate::proxy::{Proxy, ProxyAuth, ProxyType};

pub type Incoming = Packet;

/// Requests by the client to mqtt event loop. Request are
/// handled one by one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Publish(Publish),
    PubAck(PubAck),
    PubRec(PubRec),
    PubComp(PubComp),
    PubRel(PubRel),
    PingReq,
    PingResp,
    Subscribe(Subscribe),
    SubAck(SubAck),
    Unsubscribe(Unsubscribe),
    UnsubAck(UnsubAck),
    Disconnect,
}

#[cfg(feature = "websocket")]
type RequestModifierFn = Arc<
    dyn Fn(http::Request<()>) -> Pin<Box<dyn Future<Output = http::Request<()>> + Send>>
        + Send
        + Sync,
>;

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
    /// keep alive time to send pingreq to broker when the connection is idle
    keep_alive: Duration,
    /// clean (or) persistent session
    clean_start: bool,
    /// client identifier
    client_id: String,
    /// username and password
    credentials: Option<(String, String)>,
    /// request (publish, subscribe) channel capacity
    request_channel_capacity: usize,
    /// Max internal request batching
    max_request_batch: usize,
    /// Minimum delay time between consecutive outgoing packets
    /// while retransmitting pending packets
    pending_throttle: Duration,
    /// Last will that will be issued on unexpected disconnect
    last_will: Option<LastWill>,
    /// Connection timeout
    conn_timeout: u64,
    /// Default value of for maximum incoming packet size.
    /// Used when `max_incomming_size` in `connect_properties` is NOT available.
    default_max_incoming_size: usize,
    /// Connect Properties
    connect_properties: Option<ConnectProperties>,
    /// If set to `true` MQTT acknowledgements are not sent automatically.
    /// Every incoming publish packet must be manually acknowledged with `client.ack(...)` method.
    manual_acks: bool,
    network_options: NetworkOptions,
    #[cfg(feature = "proxy")]
    /// Proxy configuration.
    proxy: Option<Proxy>,
    /// Upper limit on maximum number of inflight requests.
    /// The server may set its own maximum inflight limit, the smaller of the two will be used.
    outgoing_inflight_upper_limit: Option<u16>,
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
    /// # use rumqttc::v5::MqttOptions;
    /// let options = MqttOptions::new("123", "localhost", 1883);
    /// ```
    pub fn new<S: Into<String>, T: Into<String>>(id: S, host: T, port: u16) -> MqttOptions {
        MqttOptions {
            broker_addr: host.into(),
            port,
            transport: Transport::tcp(),
            keep_alive: Duration::from_secs(60),
            clean_start: true,
            client_id: id.into(),
            credentials: None,
            request_channel_capacity: 10,
            max_request_batch: 0,
            pending_throttle: Duration::from_micros(0),
            last_will: None,
            conn_timeout: 5,
            default_max_incoming_size: 10 * 1024,
            connect_properties: None,
            manual_acks: false,
            network_options: NetworkOptions::new(),
            #[cfg(feature = "proxy")]
            proxy: None,
            outgoing_inflight_upper_limit: None,
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

    pub fn set_transport(&mut self, transport: Transport) -> &mut Self {
        self.transport = transport;
        self
    }

    pub fn transport(&self) -> Transport {
        self.transport.clone()
    }

    /// Set number of seconds after which client should ping the broker
    /// if there is no other data exchange
    pub fn set_keep_alive(&mut self, duration: Duration) -> &mut Self {
        assert!(duration.as_secs() >= 5, "Keep alives should be >= 5 secs");

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

    /// `clean_start = true` removes all the state from queues & instructs the broker
    /// to clean all the client state when client disconnects.
    ///
    /// When set `false`, broker will hold the client state and performs pending
    /// operations on the client when reconnection with same `client_id`
    /// happens. Local queue state is also held to retransmit packets after reconnection.
    pub fn set_clean_start(&mut self, clean_start: bool) -> &mut Self {
        self.clean_start = clean_start;
        self
    }

    /// Clean session
    pub fn clean_start(&self) -> bool {
        self.clean_start
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

    /// set connection timeout in secs
    pub fn set_connection_timeout(&mut self, timeout: u64) -> &mut Self {
        self.conn_timeout = timeout;
        self
    }

    /// get timeout in secs
    pub fn connection_timeout(&self) -> u64 {
        self.conn_timeout
    }

    /// set connection properties
    pub fn set_connect_properties(&mut self, properties: ConnectProperties) -> &mut Self {
        self.connect_properties = Some(properties);
        self
    }

    /// get connection properties
    pub fn connect_properties(&self) -> Option<ConnectProperties> {
        self.connect_properties.clone()
    }

    /// set receive maximum on connection properties
    pub fn set_receive_maximum(&mut self, recv_max: Option<u16>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.receive_maximum = recv_max;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.receive_maximum = recv_max;
            self.set_connect_properties(conn_props)
        }
    }

    /// get receive maximum from connection properties
    pub fn receive_maximum(&self) -> Option<u16> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.receive_maximum
        } else {
            None
        }
    }

    /// set max packet size on connection properties
    pub fn set_max_packet_size(&mut self, max_size: Option<u32>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.max_packet_size = max_size;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.max_packet_size = max_size;
            self.set_connect_properties(conn_props)
        }
    }

    /// get max packet size from connection properties
    pub fn max_packet_size(&self) -> Option<u32> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.max_packet_size
        } else {
            None
        }
    }

    /// set max topic alias on connection properties
    pub fn set_topic_alias_max(&mut self, topic_alias_max: Option<u16>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.topic_alias_max = topic_alias_max;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.topic_alias_max = topic_alias_max;
            self.set_connect_properties(conn_props)
        }
    }

    /// get max topic alias from connection properties
    pub fn topic_alias_max(&self) -> Option<u16> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.topic_alias_max
        } else {
            None
        }
    }

    /// set request response info on connection properties
    pub fn set_request_response_info(&mut self, request_response_info: Option<u8>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.request_response_info = request_response_info;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.request_response_info = request_response_info;
            self.set_connect_properties(conn_props)
        }
    }

    /// get request response info from connection properties
    pub fn request_response_info(&self) -> Option<u8> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.request_response_info
        } else {
            None
        }
    }

    /// set request problem info on connection properties
    pub fn set_request_problem_info(&mut self, request_problem_info: Option<u8>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.request_problem_info = request_problem_info;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.request_problem_info = request_problem_info;
            self.set_connect_properties(conn_props)
        }
    }

    /// get request problem info from connection properties
    pub fn request_problem_info(&self) -> Option<u8> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.request_problem_info
        } else {
            None
        }
    }

    /// set user properties on connection properties
    pub fn set_user_properties(&mut self, user_properties: Vec<(String, String)>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.user_properties = user_properties;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.user_properties = user_properties;
            self.set_connect_properties(conn_props)
        }
    }

    /// get user properties from connection properties
    pub fn user_properties(&self) -> Vec<(String, String)> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.user_properties.clone()
        } else {
            Vec::new()
        }
    }

    /// set authentication method on connection properties
    pub fn set_authentication_method(
        &mut self,
        authentication_method: Option<String>,
    ) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.authentication_method = authentication_method;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.authentication_method = authentication_method;
            self.set_connect_properties(conn_props)
        }
    }

    /// get authentication method from connection properties
    pub fn authentication_method(&self) -> Option<String> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.authentication_method.clone()
        } else {
            None
        }
    }

    /// set authentication data on connection properties
    pub fn set_authentication_data(&mut self, authentication_data: Option<Bytes>) -> &mut Self {
        if let Some(conn_props) = &mut self.connect_properties {
            conn_props.authentication_data = authentication_data;
            self
        } else {
            let mut conn_props = ConnectProperties::new();
            conn_props.authentication_data = authentication_data;
            self.set_connect_properties(conn_props)
        }
    }

    /// get authentication data from connection properties
    pub fn authentication_data(&self) -> Option<Bytes> {
        if let Some(conn_props) = &self.connect_properties {
            conn_props.authentication_data.clone()
        } else {
            None
        }
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

    pub fn network_options(&self) -> NetworkOptions {
        self.network_options.clone()
    }

    pub fn set_network_options(&mut self, network_options: NetworkOptions) -> &mut Self {
        self.network_options = network_options;
        self
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

    /// Get the upper limit on maximum number of inflight outgoing publishes.
    /// The server may set its own maximum inflight limit, the smaller of the two will be used.
    pub fn set_outgoing_inflight_upper_limit(&mut self, limit: u16) -> &mut Self {
        self.outgoing_inflight_upper_limit = Some(limit);
        self
    }

    /// Set the upper limit on maximum number of inflight outgoing publishes.
    /// The server may set its own maximum inflight limit, the smaller of the two will be used.
    pub fn get_outgoing_inflight_upper_limit(&self) -> Option<u16> {
        self.outgoing_inflight_upper_limit
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

    #[error("Invalid clean-start value.")]
    CleanStart,

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

    #[error("Invalid conn-timeout value.")]
    ConnTimeout,

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
        let mut connect_props = ConnectProperties::new();
        options.set_transport(transport);

        if let Some(keep_alive) = queries
            .remove("keep_alive_secs")
            .map(|v| v.parse::<u64>().map_err(|_| OptionError::KeepAlive))
            .transpose()?
        {
            options.set_keep_alive(Duration::from_secs(keep_alive));
        }

        if let Some(clean_start) = queries
            .remove("clean_start")
            .map(|v| v.parse::<bool>().map_err(|_| OptionError::CleanStart))
            .transpose()?
        {
            options.set_clean_start(clean_start);
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

        connect_props.max_packet_size = queries
            .remove("max_incoming_packet_size_bytes")
            .map(|v| {
                v.parse::<u32>()
                    .map_err(|_| OptionError::MaxIncomingPacketSize)
            })
            .transpose()?;

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

        connect_props.receive_maximum = queries
            .remove("inflight_num")
            .map(|v| v.parse::<u16>().map_err(|_| OptionError::Inflight))
            .transpose()?;

        if let Some(conn_timeout) = queries
            .remove("conn_timeout_secs")
            .map(|v| v.parse::<u64>().map_err(|_| OptionError::ConnTimeout))
            .transpose()?
        {
            options.set_connection_timeout(conn_timeout);
        }

        if let Some((opt, _)) = queries.into_iter().next() {
            return Err(OptionError::Unknown(opt.into_owned()));
        }

        options.connect_properties = Some(connect_props);
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
            .field("keep_alive", &self.keep_alive)
            .field("clean_start", &self.clean_start)
            .field("client_id", &self.client_id)
            .field("credentials", &self.credentials)
            .field("request_channel_capacity", &self.request_channel_capacity)
            .field("max_request_batch", &self.max_request_batch)
            .field("pending_throttle", &self.pending_throttle)
            .field("last_will", &self.last_will)
            .field("conn_timeout", &self.conn_timeout)
            .field("manual_acks", &self.manual_acks)
            .field("connect properties", &self.connect_properties)
            .finish()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    #[cfg(all(feature = "use-rustls", feature = "websocket"))]
    fn no_scheme() {
        use crate::{TlsConfiguration, Transport};
        let mut mqttoptions = MqttOptions::new("client_a", "a3f8czas.iot.eu-west-1.amazonaws.com/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=MyCreds%2F20201001%2Feu-west-1%2Fiotdevicegateway%2Faws4_request&X-Amz-Date=20201001T130812Z&X-Amz-Expires=7200&X-Amz-Signature=9ae09b49896f44270f2707551581953e6cac71a4ccf34c7c3415555be751b2d1&X-Amz-SignedHeaders=host", 443);

        mqttoptions.set_transport(Transport::wss(Vec::from("Test CA"), None, None));

        if let Transport::Wss(TlsConfiguration::Simple {
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
            err("mqtt://host:42?client_id=foo&clean_start=foo"),
            OptionError::CleanStart
        );
        assert_eq!(
            err("mqtt://host:42?client_id=foo&max_incoming_packet_size_bytes=foo"),
            OptionError::MaxIncomingPacketSize
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
        assert_eq!(
            err("mqtt://host:42?client_id=foo&conn_timeout_secs=foo"),
            OptionError::ConnTimeout
        );
    }

    #[test]
    fn allow_empty_client_id() {
        let _mqtt_opts = MqttOptions::new("", "127.0.0.1", 1883).set_clean_start(true);
    }
}
