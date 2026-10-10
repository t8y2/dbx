// Copyright (c) 2016 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

mod native_tls_opts;
mod rustls_opts;

use mysql_common::constants::MariadbCapabilities;
#[cfg(feature = "native-tls-tls")]
pub use native_tls_opts::ClientIdentity;

#[cfg(feature = "rustls-tls")]
pub use rustls_opts::ClientIdentity;

use percent_encoding::percent_decode;
use rand::RngExt as _;
use tokio::sync::OnceCell;
use url::{Host, Url};

use std::{
    borrow::Cow,
    fmt, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
    vec,
};

use crate::{
    consts::CapabilityFlags,
    error::*,
    local_infile_handler::{GlobalHandler, GlobalHandlerObject},
};

/// Default pool constraints.
pub const DEFAULT_POOL_CONSTRAINTS: PoolConstraints = PoolConstraints { min: 10, max: 100 };

//
const_assert!(
    _DEFAULT_POOL_CONSTRAINTS_ARE_CORRECT,
    DEFAULT_POOL_CONSTRAINTS.min <= DEFAULT_POOL_CONSTRAINTS.max
        && 0 < DEFAULT_POOL_CONSTRAINTS.max,
);

/// Each connection will cache up to this number of statements by default.
pub const DEFAULT_STMT_CACHE_SIZE: usize = 32;

/// Default server port.
pub const DEFAULT_PORT: u16 = 3306;

/// Default `inactive_connection_ttl` of a pool.
///
/// `0` value means, that connection will be dropped immediately
/// if it is outside of the pool's lower bound.
pub const DEFAULT_INACTIVE_CONNECTION_TTL: Duration = Duration::from_secs(0);

/// Default `ttl_check_interval` of a pool.
///
/// It isn't used if `inactive_connection_ttl` is `0`.
pub const DEFAULT_TTL_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Represents information about a host and port combination that can be converted
/// into socket addresses using to_socket_addrs.
#[derive(Clone, Eq, PartialEq, Debug)]
pub(crate) enum HostPortOrUrl {
    HostPort {
        host: String,
        port: u16,
        /// The resolved IP addresses to use for the TCP connection. If empty,
        /// DNS resolution of `host` will be performed.
        resolved_ips: Option<Vec<IpAddr>>,
    },
    Url(Url),
}

impl Default for HostPortOrUrl {
    fn default() -> Self {
        HostPortOrUrl::HostPort {
            host: "127.0.0.1".to_string(),
            port: DEFAULT_PORT,
            resolved_ips: None,
        }
    }
}

impl HostPortOrUrl {
    pub fn get_ip_or_hostname(&self) -> &str {
        match self {
            Self::HostPort { host, .. } => host,
            Self::Url(url) => url.host_str().unwrap_or("127.0.0.1"),
        }
    }

    pub fn get_tcp_port(&self) -> u16 {
        match self {
            Self::HostPort { port, .. } => *port,
            Self::Url(url) => url.port().unwrap_or(DEFAULT_PORT),
        }
    }

    pub fn get_resolved_ips(&self) -> &Option<Vec<IpAddr>> {
        match self {
            Self::HostPort { resolved_ips, .. } => resolved_ips,
            Self::Url(_) => &None,
        }
    }

    pub fn is_loopback(&self) -> bool {
        match self {
            Self::HostPort {
                host, resolved_ips, ..
            } => {
                let v4addr: Option<Ipv4Addr> = FromStr::from_str(host).ok();
                let v6addr: Option<Ipv6Addr> = FromStr::from_str(host).ok();
                if resolved_ips
                    .as_ref()
                    .is_some_and(|s| s.iter().any(|ip| ip.is_loopback()))
                {
                    true
                } else if let Some(addr) = v4addr {
                    addr.is_loopback()
                } else if let Some(addr) = v6addr {
                    addr.is_loopback()
                } else {
                    host == "localhost"
                }
            }
            Self::Url(url) => match url.host() {
                Some(Host::Ipv4(ip)) => ip.is_loopback(),
                Some(Host::Ipv6(ip)) => ip.is_loopback(),
                Some(Host::Domain(s)) => s == "localhost",
                _ => false,
            },
        }
    }
}

/// Represents data that is either on-disk or in the buffer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PathOrBuf<'a> {
    Path(Cow<'a, Path>),
    Buf(Cow<'a, [u8]>),
}

impl<'a> PathOrBuf<'a> {
    /// Will either read data from disk or return the buffered data.
    pub async fn read(&self) -> io::Result<Cow<'_, [u8]>> {
        match self {
            PathOrBuf::Path(x) => tokio::fs::read(x.as_ref()).await.map(Cow::Owned),
            PathOrBuf::Buf(x) => Ok(Cow::Borrowed(x.as_ref())),
        }
    }

    /// Borrows `self`.
    pub fn borrow(&self) -> PathOrBuf<'_> {
        match self {
            PathOrBuf::Path(path) => PathOrBuf::Path(Cow::Borrowed(path.as_ref())),
            PathOrBuf::Buf(data) => PathOrBuf::Buf(Cow::Borrowed(data.as_ref())),
        }
    }
}

impl From<PathBuf> for PathOrBuf<'static> {
    fn from(value: PathBuf) -> Self {
        Self::Path(Cow::Owned(value))
    }
}

impl<'a> From<&'a Path> for PathOrBuf<'a> {
    fn from(value: &'a Path) -> Self {
        Self::Path(Cow::Borrowed(value))
    }
}

impl From<Vec<u8>> for PathOrBuf<'static> {
    fn from(value: Vec<u8>) -> Self {
        Self::Buf(Cow::Owned(value))
    }
}

impl<'a> From<&'a [u8]> for PathOrBuf<'a> {
    fn from(value: &'a [u8]) -> Self {
        Self::Buf(Cow::Borrowed(value))
    }
}

/// Ssl Options.
///
/// ```
/// # use mysql_async::SslOpts;
/// # use std::path::Path;
/// # #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
/// # use mysql_async::ClientIdentity;
/// // With native-tls
/// # #[cfg(feature = "native-tls-tls")]
/// let ssl_opts = SslOpts::default()
///     .with_client_identity(Some(ClientIdentity::new(Path::new("/path").into())
///         .with_password("******")
///     ));
///
/// // With rustls
/// # #[cfg(feature = "rustls-tls")]
/// let ssl_opts = SslOpts::default()
///     .with_client_identity(Some(ClientIdentity::new(
///         Path::new("/path/to/chain").into(),
///         Path::new("/path/to/priv_key").into(),
/// )));
/// ```
#[derive(Debug, Clone, Eq, PartialEq, Hash, Default)]
pub struct SslOpts {
    #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
    client_identity: Option<ClientIdentity>,
    root_certs: Vec<PathOrBuf<'static>>,
    disable_built_in_roots: bool,
    skip_domain_validation: bool,
    accept_invalid_certs: bool,
    tls_hostname_override: Option<Cow<'static, str>>,
    #[cfg(feature = "rustls-tls")]
    disable_tls_resumption: bool,
}

impl SslOpts {
    #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
    pub fn with_client_identity(mut self, identity: Option<ClientIdentity>) -> Self {
        self.client_identity = identity;
        self
    }

    /// Sets path to a `pem` or `der` certificate of the root that connector will trust.
    ///
    /// Multiple certs are allowed in .pem files.
    ///
    /// All the elements in `root_certs` will be merged.
    pub fn with_root_certs(mut self, root_certs: Vec<PathOrBuf<'static>>) -> Self {
        self.root_certs = root_certs;
        self
    }

    /// If `true`, use only the root certificates configured via [`SslOpts::with_root_certs`],
    /// not any system or built-in certs. By default system built-in certs _will be_ used.
    ///
    /// # Connection URL
    ///
    /// Use `built_in_roots` URL parameter to set this value:
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?require_ssl=true&built_in_roots=false")?;
    /// assert_eq!(opts.ssl_opts().unwrap().disable_built_in_roots(), true);
    /// # Ok(()) }
    /// ```
    pub fn with_disable_built_in_roots(mut self, disable_built_in_roots: bool) -> Self {
        self.disable_built_in_roots = disable_built_in_roots;
        self
    }

    /// The way to not validate the server's domain name against its certificate.
    /// By default domain name _will be_ validated.
    ///
    /// # Connection URL
    ///
    /// Use `verify_identity` URL parameter to set this value:
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?require_ssl=true&verify_identity=false")?;
    /// assert_eq!(opts.ssl_opts().unwrap().skip_domain_validation(), true);
    /// # Ok(()) }
    /// ```
    pub fn with_danger_skip_domain_validation(mut self, value: bool) -> Self {
        self.skip_domain_validation = value;
        self
    }

    /// If `true` then client will accept invalid certificate (expired, not trusted, ..).
    /// Invalid certificates _won't get_ accepted by default.
    ///
    /// # Connection URL
    ///
    /// Use `verify_ca` URL parameter to set this value:
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?require_ssl=true&verify_ca=false")?;
    /// assert_eq!(opts.ssl_opts().unwrap().accept_invalid_certs(), true);
    /// # Ok(()) }
    /// ```
    pub fn with_danger_accept_invalid_certs(mut self, value: bool) -> Self {
        self.accept_invalid_certs = value;
        self
    }

    /// If set, will override the hostname used to verify the server's certificate.
    ///
    /// This is useful when connecting to a server via a tunnel, where the server hostname is
    /// different from the hostname used to connect to the tunnel.
    pub fn with_danger_tls_hostname_override<T: Into<Cow<'static, str>>>(
        mut self,
        domain: Option<T>,
    ) -> Self {
        self.tls_hostname_override = domain.map(Into::into);
        self
    }

    /// If `true`, disables TLS session resumption.
    /// By default TLS session resumption is enabled.
    ///
    /// # Connection URL
    ///
    /// Use `disable_tls_resumption` URL parameter to set this value:
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?require_ssl=true&disable_tls_resumption=true")?;
    /// assert_eq!(opts.ssl_opts().unwrap().disable_tls_resumption(), true);
    /// # Ok(()) }
    /// ```
    #[cfg(feature = "rustls-tls")]
    pub fn with_disable_tls_resumption(mut self, disable_tls_resumption: bool) -> Self {
        self.disable_tls_resumption = disable_tls_resumption;
        self
    }

    #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
    pub fn client_identity(&self) -> Option<&ClientIdentity> {
        self.client_identity.as_ref()
    }

    pub fn root_certs(&self) -> &[PathOrBuf<'static>] {
        &self.root_certs
    }

    pub fn disable_built_in_roots(&self) -> bool {
        self.disable_built_in_roots
    }

    pub fn skip_domain_validation(&self) -> bool {
        self.skip_domain_validation
    }

    pub fn accept_invalid_certs(&self) -> bool {
        self.accept_invalid_certs
    }

    pub fn tls_hostname_override(&self) -> Option<&str> {
        self.tls_hostname_override.as_deref()
    }

    /// Returns `true` if TLS session resumption is disabled.
    #[cfg(feature = "rustls-tls")]
    pub fn disable_tls_resumption(&self) -> bool {
        self.disable_tls_resumption
    }
}

/// Connection pool options.
///
/// ```
/// # use mysql_async::{PoolOpts, PoolConstraints};
/// # use std::time::Duration;
/// let pool_opts = PoolOpts::default()
///     .with_constraints(PoolConstraints::new(15, 30).unwrap())
///     .with_inactive_connection_ttl(Duration::from_secs(60));
/// ```
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub struct PoolOpts {
    constraints: PoolConstraints,
    inactive_connection_ttl: Duration,
    ttl_check_interval: Duration,
    abs_conn_ttl: Option<Duration>,
    abs_conn_ttl_jitter: Option<Duration>,
    reset_connection: bool,
}

impl PoolOpts {
    /// Calls `Self::default`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates the default [`PoolOpts`] with the given constraints.
    pub fn with_constraints(mut self, constraints: PoolConstraints) -> Self {
        self.constraints = constraints;
        self
    }

    /// Returns pool constraints.
    pub fn constraints(&self) -> PoolConstraints {
        self.constraints
    }

    /// Sets whether to reset connection upon returning it to a pool (defaults to `true`).
    ///
    /// Default behavior increases reliability but comes with cons:
    ///
    /// * reset procedure removes all prepared statements, i.e. kills prepared statements cache
    /// * connection reset is quite fast but requires additional client-server roundtrip
    ///   (might also requires reauthentication for older servers)
    ///
    /// The purpose of the reset procedure is to:
    ///
    /// * rollback any opened transactions (`mysql_async` is able to do this without explicit reset)
    /// * reset transaction isolation level
    /// * reset session variables
    /// * delete user variables
    /// * remove temporary tables
    /// * remove all PREPARE statement (this action kills prepared statements cache)
    ///
    /// So to increase overall performance you can safely opt-out of the default behavior
    /// if you are not willing to change the session state in an unpleasant way.
    ///
    /// It is also possible to selectively opt-in/out using [`Conn::reset_connection`][1].
    ///
    /// # Connection URL
    ///
    /// You can use `reset_connection` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?reset_connection=false")?;
    /// assert_eq!(opts.pool_opts().reset_connection(), false);
    /// # Ok(()) }
    /// ```
    ///
    /// [1]: crate::Conn::reset_connection
    pub fn with_reset_connection(mut self, reset_connection: bool) -> Self {
        self.reset_connection = reset_connection;
        self
    }

    /// Returns the `reset_connection` value (see [`PoolOpts::with_reset_connection`]).
    pub fn reset_connection(&self) -> bool {
        self.reset_connection
    }

    /// Sets an absolute TTL after which a connection is removed from the pool.
    /// This may push the pool below the requested minimum pool size and is independent of the
    /// idle TTL.
    /// The absolute TTL is disabled by default.
    /// Fractions of seconds are ignored.
    pub fn with_abs_conn_ttl(mut self, ttl: Option<Duration>) -> Self {
        self.abs_conn_ttl = ttl;
        self
    }

    /// Optionally, the absolute TTL can be extended by a per-connection random amount
    /// bounded by `jitter`.
    /// Setting `abs_conn_ttl_jitter` without `abs_conn_ttl` has no effect.
    /// Fractions of seconds are ignored.
    pub fn with_abs_conn_ttl_jitter(mut self, jitter: Option<Duration>) -> Self {
        self.abs_conn_ttl_jitter = jitter;
        self
    }

    /// Returns the absolute TTL, if set.
    pub fn abs_conn_ttl(&self) -> Option<Duration> {
        self.abs_conn_ttl
    }

    /// Returns the absolute TTL's jitter bound, if set.
    pub fn abs_conn_ttl_jitter(&self) -> Option<Duration> {
        self.abs_conn_ttl_jitter
    }

    /// Returns a new deadline that's TTL (+ random jitter) in the future.
    pub(crate) fn new_connection_ttl_deadline(&self) -> Option<Instant> {
        if let Some(ttl) = self.abs_conn_ttl {
            let jitter = if let Some(jitter) = self.abs_conn_ttl_jitter {
                Duration::from_secs(rand::rng().random_range(0..=jitter.as_secs()))
            } else {
                Duration::ZERO
            };
            Some(Instant::now() + ttl + jitter)
        } else {
            None
        }
    }

    /// Pool will recycle inactive connection if it is outside of the lower bound of the pool
    /// and if it is idling longer than this value (defaults to
    /// [`DEFAULT_INACTIVE_CONNECTION_TTL`]).
    ///
    /// Note that it may, actually, idle longer because of [`PoolOpts::ttl_check_interval`].
    ///
    /// # Connection URL
    ///
    /// You can use `inactive_connection_ttl` URL parameter to set this value (in seconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?inactive_connection_ttl=60")?;
    /// assert_eq!(opts.pool_opts().inactive_connection_ttl(), Duration::from_secs(60));
    /// # Ok(()) }
    /// ```
    pub fn with_inactive_connection_ttl(mut self, ttl: Duration) -> Self {
        self.inactive_connection_ttl = ttl;
        self
    }

    /// Returns a `inactive_connection_ttl` value.
    pub fn inactive_connection_ttl(&self) -> Duration {
        self.inactive_connection_ttl
    }

    /// Pool will check idling connection for expiration with this interval
    /// (defaults to [`DEFAULT_TTL_CHECK_INTERVAL`]).
    ///
    /// If `interval` is less than one second, then [`DEFAULT_TTL_CHECK_INTERVAL`] will be used.
    ///
    /// # Connection URL
    ///
    /// You can use `ttl_check_interval` URL parameter to set this value (in seconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?ttl_check_interval=60")?;
    /// assert_eq!(opts.pool_opts().ttl_check_interval(), Duration::from_secs(60));
    /// # Ok(()) }
    /// ```
    pub fn with_ttl_check_interval(mut self, interval: Duration) -> Self {
        if interval < Duration::from_secs(1) {
            self.ttl_check_interval = DEFAULT_TTL_CHECK_INTERVAL
        } else {
            self.ttl_check_interval = interval;
        }
        self
    }

    /// Returns a `ttl_check_interval` value.
    pub fn ttl_check_interval(&self) -> Duration {
        self.ttl_check_interval
    }

    /// Returns active bound for this `PoolOpts`.
    ///
    /// This value controls how many connections will be returned to an idle queue of a pool.
    ///
    /// Active bound is either:
    /// * `min` bound of the pool constraints, if this [`PoolOpts`] defines
    ///   `inactive_connection_ttl` to be `0`. This means, that pool will hold no more than `min`
    ///   number of idling connections and other connections will be immediately disconnected.
    /// * `max` bound of the pool constraints, if this [`PoolOpts`] defines
    ///   `inactive_connection_ttl` to be non-zero. This means, that pool will hold up to `max`
    ///   number of idling connections and this number will be eventually reduced to `min`
    ///   by a handler of `ttl_check_interval`.
    pub(crate) fn active_bound(&self) -> usize {
        if self.inactive_connection_ttl > Duration::from_secs(0) {
            self.constraints.max
        } else {
            self.constraints.min
        }
    }
}

impl Default for PoolOpts {
    fn default() -> Self {
        Self {
            constraints: DEFAULT_POOL_CONSTRAINTS,
            inactive_connection_ttl: DEFAULT_INACTIVE_CONNECTION_TTL,
            ttl_check_interval: DEFAULT_TTL_CHECK_INTERVAL,
            abs_conn_ttl: None,
            abs_conn_ttl_jitter: None,
            reset_connection: true,
        }
    }
}

#[derive(Clone, Eq, PartialEq, Default, Debug)]
pub(crate) struct InnerOpts {
    mysql_opts: MysqlOpts,
    address: HostPortOrUrl,
}

/// This type alias is added to make clippy happy.
type AfterConnectCallback =
    Arc<dyn for<'a> Fn(&'a mut crate::Conn) -> crate::BoxFuture<'a, ()> + Send + Sync + 'static>;

#[derive(Clone)]
pub(crate) struct AfterConnectCallbackWrapper(AfterConnectCallback);

impl Eq for AfterConnectCallbackWrapper {}

impl PartialEq for AfterConnectCallbackWrapper {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for AfterConnectCallbackWrapper {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("AfterConnectCallbackWrapper").finish()
    }
}

/// Mysql connection options.
///
/// Build one with [`OptsBuilder`].
#[derive(Clone, Eq, PartialEq, Debug)]
pub(crate) struct MysqlOpts {
    /// User (defaults to `None`).
    user: Option<String>,

    /// Password (defaults to `None`).
    pass: Option<String>,

    /// Database name (defaults to `None`).
    db_name: Option<String>,

    /// TCP keep alive timeout (defaults to `None`).
    tcp_keepalive: Option<Duration>,

    /// Whether to enable `TCP_NODELAY` (defaults to `true`).
    ///
    /// This option disables Nagle's algorithm, which can cause unusually high latency (~40ms) at
    /// some cost to maximum throughput. See blackbeam/rust-mysql-simple#132.
    tcp_nodelay: bool,

    /// Local infile handler
    local_infile_handler: Option<GlobalHandlerObject>,

    /// Connection pool options (defaults to [`PoolOpts::default`]).
    pool_opts: PoolOpts,

    /// Pool will close a connection if time since last IO exceeds this number of seconds
    /// (defaults to `wait_timeout`).
    conn_ttl: Option<Duration>,

    /// Callback to execute once a new connection is established.
    after_connect: Option<AfterConnectCallbackWrapper>,

    /// Callback run after every setup, including reset and change_user.
    setup_callback: Option<AfterConnectCallbackWrapper>,

    /// Commands to execute once new connection is established.
    init: Vec<String>,

    /// Commands to execute on new connection and every time
    /// [`Conn::reset`] or [`Conn::change_user`] is invoked.
    setup: Vec<String>,

    /// Number of prepared statements cached on the client side (per connection). Defaults to `10`.
    stmt_cache_size: usize,

    /// Driver will require SSL connection if this option isn't `None` (default to `None`).
    ssl_opts: Option<SslOptsAndCachedConnector>,

    /// Prefer socket connection (defaults to `true`).
    ///
    /// Will reconnect via socket (or named pipe on Windows) after TCP connection to `127.0.0.1`
    /// if `true`.
    ///
    /// Will fall back to TCP on error. Use `socket` option to enforce socket connection.
    ///
    /// # Note
    ///
    /// Library will query the `@@socket` server variable to get socket address,
    /// and this address may be incorrect in some cases (i.e. docker).
    prefer_socket: bool,

    /// Path to unix socket (or named pipe on Windows) (defaults to `None`).
    socket: Option<String>,

    /// If not `None`, then client will ask for compression if server supports it
    /// (defaults to `None`).
    ///
    /// Can be defined using `compress` connection url parameter with values:
    /// * `fast` - for compression level 1;
    /// * `best` - for compression level 9;
    /// * `on`, `true` - for default compression level;
    /// * `0`, ..., `9`.
    ///
    /// Note that compression level defined here will affect only outgoing packets.
    compression: Option<crate::Compression>,

    /// Client side `max_allowed_packet` value (defaults to `None`).
    ///
    /// By default `Conn` will query this value from the server. One can avoid this step
    /// by explicitly specifying it.
    max_allowed_packet: Option<usize>,

    /// Client side `wait_timeout` value (defaults to `None`).
    ///
    /// By default `Conn` will query this value from the server. One can avoid this step
    /// by explicitly specifying it.
    wait_timeout: Option<usize>,

    /// Disables `mysql_old_password` plugin (defaults to `true`).
    ///
    /// Available via `secure_auth` connection url parameter.
    secure_auth: bool,

    /// Enables `CLIENT_FOUND_ROWS` capability (defaults to `false`).
    ///
    /// Changes the behavior of the affected count returned for writes (UPDATE/INSERT etc).
    /// It makes MySQL return the FOUND rows instead of the AFFECTED rows.
    client_found_rows: bool,

    /// Enables `CLIENT_DEPRECATE_EOF` capability (defaults to `true`).
    ///
    /// This can be disabled for compatibility with proxies that advertise the capability but
    /// still send legacy EOF packets.
    deprecate_eof: bool,

    /// Enables Client-Side Cleartext Pluggable Authentication (defaults to `false`).
    ///
    /// Enables client to send passwords to the server as cleartext, without hashing or encryption
    /// (consult MySql documentation for more info).
    ///
    /// # Security Notes
    ///
    /// Sending passwords as cleartext may be a security problem in some configurations. Please
    /// consider using TLS or encrypted tunnels for server connection.
    enable_cleartext_plugin: bool,

    /// Connection attributes to send in handshake and COM_CHANGE_USER (defaults to `None`).
    ///
    /// When set, the client will advertise `CLIENT_CONNECT_ATTRS` and send the provided
    /// key-value attributes to the server.
    connect_attributes: Option<std::collections::HashMap<String, String>>,
}

/// Mysql connection options.
///
/// Build one with [`OptsBuilder`].
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct Opts {
    inner: Arc<InnerOpts>,
}

impl Opts {
    #[doc(hidden)]
    pub fn addr_is_loopback(&self) -> bool {
        self.inner.address.is_loopback()
    }

    pub fn from_url(url: &str) -> std::result::Result<Opts, UrlError> {
        let mut url = Url::parse(url)?;

        // We use the URL for socket address resolution later, so make
        // sure it has a port set.
        if url.port().is_none() {
            url.set_port(Some(DEFAULT_PORT))
                .map_err(|_| UrlError::Invalid)?;
        }

        let mysql_opts = mysql_opts_from_url(&url)?;
        let address = HostPortOrUrl::Url(url);

        let inner_opts = InnerOpts {
            mysql_opts,
            address,
        };

        Ok(Opts {
            inner: Arc::new(inner_opts),
        })
    }

    /// Address of mysql server (defaults to `127.0.0.1`). Host names should also work.
    pub fn ip_or_hostname(&self) -> &str {
        self.inner.address.get_ip_or_hostname()
    }

    pub(crate) fn hostport_or_url(&self) -> &HostPortOrUrl {
        &self.inner.address
    }

    /// TCP port of mysql server (defaults to `3306`).
    pub fn tcp_port(&self) -> u16 {
        self.inner.address.get_tcp_port()
    }

    /// The resolved IPs for the mysql server, if provided.
    pub fn resolved_ips(&self) -> &Option<Vec<IpAddr>> {
        self.inner.address.get_resolved_ips()
    }

    /// User (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// Can be defined in connection URL. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://user@localhost/database_name")?;
    /// assert_eq!(opts.user(), Some("user"));
    /// # Ok(()) }
    /// ```
    pub fn user(&self) -> Option<&str> {
        self.inner.mysql_opts.user.as_ref().map(AsRef::as_ref)
    }

    /// Password (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// Can be defined in connection URL. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://user:pass%20word@localhost/database_name")?;
    /// assert_eq!(opts.pass(), Some("pass word"));
    /// # Ok(()) }
    /// ```
    pub fn pass(&self) -> Option<&str> {
        self.inner.mysql_opts.pass.as_ref().map(AsRef::as_ref)
    }

    /// Database name (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// Database name can be defined in connection URL. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/database_name")?;
    /// assert_eq!(opts.db_name(), Some("database_name"));
    /// # Ok(()) }
    /// ```
    pub fn db_name(&self) -> Option<&str> {
        self.inner.mysql_opts.db_name.as_ref().map(AsRef::as_ref)
    }

    /// Callback to execute after opening a new connection to the database. Runs
    /// before the [`init`][Self::init] queries.
    ///
    /// If this returns an error, the connection attempt will also fail.
    ///
    /// ```no_run
    /// use futures_util::FutureExt;
    /// use mysql_async::OptsBuilder;
    ///
    /// let opts_builder: OptsBuilder = todo!();
    ///
    /// opts_builder.after_connect(|conn| {
    ///     async move {
    ///         // do something with `conn`
    ///         Ok(())
    ///     }.boxed()
    /// });
    /// ```
    pub fn after_connect(&self) -> Option<AfterConnectCallback> {
        self.inner
            .mysql_opts
            .after_connect
            .as_ref()
            .map(|cb| cb.0.clone())
    }

    /// Commands to execute once new a connection is established.
    pub fn init(&self) -> &[String] {
        self.inner.mysql_opts.init.as_ref()
    }

    /// Commands to execute on new connection and every time
    /// [`Conn::reset`][1] or [`Conn::change_user`][2] is invoked.
    ///
    /// [1]: crate::Conn::reset
    /// [2]: crate::Conn::change_user
    pub fn setup(&self) -> &[String] {
        self.inner.mysql_opts.setup.as_ref()
    }

    /// Callback executed after setup queries on every new connection, reset,
    /// and change_user. An error prevents the connection from being reused.
    pub fn setup_callback(&self) -> Option<AfterConnectCallback> {
        self.inner
            .mysql_opts
            .setup_callback
            .as_ref()
            .map(|cb| cb.0.clone())
    }

    /// TCP keep alive timeout in milliseconds (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// You can use `tcp_keepalive` URL parameter to set this value (in milliseconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?tcp_keepalive=10000")?;
    /// assert_eq!(opts.tcp_keepalive(), Some(std::time::Duration::from_secs(10)));
    /// # Ok(()) }
    /// ```
    pub fn tcp_keepalive(&self) -> Option<Duration> {
        self.inner.mysql_opts.tcp_keepalive
    }

    /// Set the `TCP_NODELAY` option for the mysql connection (defaults to `true`).
    ///
    /// Setting this option to false re-enables Nagle's algorithm, which can cause unusually high
    /// latency (~40ms) but may increase maximum throughput. See #132.
    ///
    /// # Connection URL
    ///
    /// You can use `tcp_nodelay` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?tcp_nodelay=false")?;
    /// assert_eq!(opts.tcp_nodelay(), false);
    /// # Ok(()) }
    /// ```
    pub fn tcp_nodelay(&self) -> bool {
        self.inner.mysql_opts.tcp_nodelay
    }

    /// Handler for local infile requests (defaults to `None`).
    pub fn local_infile_handler(&self) -> Option<Arc<dyn GlobalHandler>> {
        self.inner
            .mysql_opts
            .local_infile_handler
            .as_ref()
            .map(|x| x.clone_inner())
    }

    /// Connection pool options (defaults to [`Default::default`]).
    pub fn pool_opts(&self) -> &PoolOpts {
        &self.inner.mysql_opts.pool_opts
    }

    /// Pool will close connection if time since last IO exceeds this number of seconds
    /// (defaults to `wait_timeout`. `None` to reset to default).
    ///
    /// # Connection URL
    ///
    /// You can use `conn_ttl` URL parameter to set this value (in seconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?conn_ttl=360")?;
    /// assert_eq!(opts.conn_ttl(), Some(Duration::from_secs(360)));
    /// # Ok(()) }
    /// ```
    pub fn conn_ttl(&self) -> Option<Duration> {
        self.inner.mysql_opts.conn_ttl
    }

    /// The pool will close a connection when this absolute TTL has elapsed.
    /// Disabled by default.
    ///
    /// Enables forced recycling and migration of connections in a guaranteed timeframe.
    /// This TTL bypasses pool constraints and an idle pool can go below the min size.
    ///
    /// # Connection URL
    ///
    /// You can use `abs_conn_ttl` URL parameter to set this value (in seconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?abs_conn_ttl=86400")?;
    /// assert_eq!(opts.abs_conn_ttl(), Some(Duration::from_secs(24 * 60 * 60)));
    /// # Ok(()) }
    /// ```
    pub fn abs_conn_ttl(&self) -> Option<Duration> {
        self.inner.mysql_opts.pool_opts.abs_conn_ttl
    }

    /// Upper bound of a random value added to the absolute TTL, if enabled.
    /// Disabled by default.
    ///
    /// Should be used to prevent connections from closing at the same time.
    ///
    /// # Connection URL
    ///
    /// You can use `abs_conn_ttl_jitter` URL parameter to set this value (in seconds). E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # use std::time::Duration;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?abs_conn_ttl=7200&abs_conn_ttl_jitter=3600")?;
    /// assert_eq!(opts.abs_conn_ttl_jitter(), Some(Duration::from_secs(60 * 60)));
    /// # Ok(()) }
    /// ```
    pub fn abs_conn_ttl_jitter(&self) -> Option<Duration> {
        self.inner.mysql_opts.pool_opts.abs_conn_ttl_jitter
    }

    /// Number of prepared statements cached on the client side (per connection). Defaults to
    /// [`DEFAULT_STMT_CACHE_SIZE`].
    ///
    /// Call with `None` to reset to default. Set to `0` to disable statement cache.
    ///
    /// # Caveats
    ///
    /// If statement cache is disabled (`stmt_cache_size` is `0`), then you must close statements
    /// manually.
    ///
    /// # Connection URL
    ///
    /// You can use `stmt_cache_size` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?stmt_cache_size=128")?;
    /// assert_eq!(opts.stmt_cache_size(), 128);
    /// # Ok(()) }
    /// ```
    pub fn stmt_cache_size(&self) -> usize {
        self.inner.mysql_opts.stmt_cache_size
    }

    /// Driver will require SSL connection if this opts isn't `None` (defaults to `None`).
    ///
    /// # Connection URL parameters
    ///
    /// Note that for security reasons:
    ///
    /// * CA and IDENTITY verifications are opt-out
    /// * there is no way to give an identity or root certs via query URL
    ///
    /// URL Parameters:
    ///
    /// *   `require_ssl: bool` (defaults to `false`) – requires SSL with default [`SslOpts`]
    /// *   `verify_ca: bool` (defaults to `true`) – requires server Certificate Authority (CA)
    ///     certificate validation against the configured CA certificates.
    ///     Makes no sense if  `require_ssl` equals `false`.
    /// *   `verify_identity: bool` (defaults to `true`) – perform host name identity verification
    ///     by checking the host name the client uses for connecting to the server against
    ///     the identity in the certificate that the server sends to the client.
    ///     Makes no sense if  `require_ssl` equals `false`.
    ///
    ///
    pub fn ssl_opts(&self) -> Option<&SslOpts> {
        self.inner.mysql_opts.ssl_opts.as_ref().map(|o| &o.ssl_opts)
    }

    /// Prefer socket connection (defaults to `true` **temporary `false` on Windows platform**).
    ///
    /// Will reconnect via socket (or named pipe on Windows) after TCP connection to `127.0.0.1`
    /// if `true`.
    ///
    /// Will fall back to TCP on error. Use `socket` option to enforce socket connection.
    ///
    /// # Note
    ///
    /// Library will query the `@@socket` server variable to get socket address,
    /// and this address may be incorrect in some cases (e.g. docker).
    ///
    /// # Connection URL
    ///
    /// You can use `prefer_socket` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?prefer_socket=false")?;
    /// assert_eq!(opts.prefer_socket(), false);
    /// # Ok(()) }
    /// ```
    pub fn prefer_socket(&self) -> bool {
        self.inner.mysql_opts.prefer_socket
    }

    /// Path to unix socket (or named pipe on Windows) (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// You can use `socket` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?socket=%2Fpath%2Fto%2Fsocket")?;
    /// assert_eq!(opts.socket(), Some("/path/to/socket"));
    /// # Ok(()) }
    /// ```
    pub fn socket(&self) -> Option<&str> {
        self.inner.mysql_opts.socket.as_deref()
    }

    /// If not `None`, then client will ask for compression if server supports it
    /// (defaults to `None`).
    ///
    /// # Connection URL
    ///
    /// You can use `compression` URL parameter to set this value:
    ///
    /// * `fast` - for compression level 1;
    /// * `best` - for compression level 9;
    /// * `on`, `true` - for default compression level;
    /// * `0`, ..., `9`.
    ///
    /// Note that compression level defined here will affect only outgoing packets.
    pub fn compression(&self) -> Option<crate::Compression> {
        self.inner.mysql_opts.compression
    }

    /// Client side `max_allowed_packet` value (defaults to `None`).
    ///
    /// By default `Conn` will query this value from the server. One can avoid this step
    /// by explicitly specifying it. Server side default is 4MB.
    ///
    /// Available in connection URL via `max_allowed_packet` parameter.
    pub fn max_allowed_packet(&self) -> Option<usize> {
        self.inner.mysql_opts.max_allowed_packet
    }

    /// Client side `wait_timeout` value (defaults to `None`).
    ///
    /// By default `Conn` will query this value from the server. One can avoid this step
    /// by explicitly specifying it. Server side default is 28800.
    ///
    /// Available in connection URL via `wait_timeout` parameter.
    pub fn wait_timeout(&self) -> Option<usize> {
        self.inner.mysql_opts.wait_timeout
    }

    /// Disables `mysql_old_password` plugin (defaults to `true`).
    ///
    /// Available via `secure_auth` connection url parameter.
    pub fn secure_auth(&self) -> bool {
        self.inner.mysql_opts.secure_auth
    }

    /// Returns `true` if `CLIENT_FOUND_ROWS` capability is enabled (defaults to `false`).
    ///
    /// `CLIENT_FOUND_ROWS` changes the behavior of the affected count returned for writes
    /// (UPDATE/INSERT etc). It makes MySQL return the FOUND rows instead of the AFFECTED rows.
    ///
    /// # Connection URL
    ///
    /// Use `client_found_rows` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?client_found_rows=true")?;
    /// assert!(opts.client_found_rows());
    /// # Ok(()) }
    /// ```
    pub fn client_found_rows(&self) -> bool {
        self.inner.mysql_opts.client_found_rows
    }

    /// Returns `true` if `CLIENT_DEPRECATE_EOF` capability is enabled (defaults to `true`).
    pub fn deprecate_eof(&self) -> bool {
        self.inner.mysql_opts.deprecate_eof
    }

    /// Returns `true` if `mysql_clear_password` plugin support is enabled (defaults to `false`).
    ///
    /// `mysql_clear_password` enables client to send passwords to the server as cleartext, without
    /// hashing or encryption (consult MySql documentation for more info).
    ///
    /// # Security Notes
    ///
    /// Sending passwords as cleartext may be a security problem in some configurations. Please
    /// consider using TLS or encrypted tunnels for server connection.
    ///
    /// # Connection URL
    ///
    /// Use `enable_cleartext_plugin` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?enable_cleartext_plugin=true")?;
    /// assert!(opts.enable_cleartext_plugin());
    /// # Ok(()) }
    /// ```
    pub fn enable_cleartext_plugin(&self) -> bool {
        self.inner.mysql_opts.enable_cleartext_plugin
    }

    /// Connection attributes to send to the server, if any.
    pub fn connect_attributes(&self) -> Option<&std::collections::HashMap<String, String>> {
        self.inner.mysql_opts.connect_attributes.as_ref()
    }

    pub(crate) fn get_capabilities(&self) -> CapabilityFlags {
        let mut out = CapabilityFlags::CLIENT_PROTOCOL_41
            | CapabilityFlags::CLIENT_SECURE_CONNECTION
            | CapabilityFlags::CLIENT_LONG_PASSWORD
            | CapabilityFlags::CLIENT_TRANSACTIONS
            | CapabilityFlags::CLIENT_LOCAL_FILES
            | CapabilityFlags::CLIENT_MULTI_STATEMENTS
            | CapabilityFlags::CLIENT_MULTI_RESULTS
            | CapabilityFlags::CLIENT_PS_MULTI_RESULTS
            | CapabilityFlags::CLIENT_PLUGIN_AUTH;

        if self.deprecate_eof() {
            out |= CapabilityFlags::CLIENT_DEPRECATE_EOF;
        }
        if self.inner.mysql_opts.db_name.is_some() {
            out |= CapabilityFlags::CLIENT_CONNECT_WITH_DB;
        }
        if self.inner.mysql_opts.ssl_opts.is_some() {
            out |= CapabilityFlags::CLIENT_SSL;
        }
        if self.inner.mysql_opts.compression.is_some() {
            out |= CapabilityFlags::CLIENT_COMPRESS;
        }
        if self.client_found_rows() {
            out |= CapabilityFlags::CLIENT_FOUND_ROWS;
        }

        out
    }

    pub(crate) fn get_mariadb_capabilities(&self) -> MariadbCapabilities {
        MariadbCapabilities::MARIADB_CLIENT_STMT_BULK_OPERATIONS
            | MariadbCapabilities::MARIADB_CLIENT_CACHE_METADATA
            | MariadbCapabilities::MARIADB_CLIENT_BULK_UNIT_RESULTS
    }

    pub(crate) fn ssl_opts_and_connector(&self) -> Option<&SslOptsAndCachedConnector> {
        self.inner.mysql_opts.ssl_opts.as_ref()
    }
}

impl Default for MysqlOpts {
    fn default() -> MysqlOpts {
        MysqlOpts {
            user: None,
            pass: None,
            db_name: None,
            after_connect: None,
            setup_callback: None,
            init: vec![],
            setup: vec![],
            tcp_keepalive: None,
            tcp_nodelay: true,
            local_infile_handler: None,
            pool_opts: Default::default(),
            conn_ttl: None,
            stmt_cache_size: DEFAULT_STMT_CACHE_SIZE,
            ssl_opts: None,
            prefer_socket: cfg!(not(target_os = "windows")),
            socket: None,
            compression: None,
            max_allowed_packet: None,
            wait_timeout: None,
            secure_auth: true,
            client_found_rows: false,
            deprecate_eof: true,
            enable_cleartext_plugin: false,
            connect_attributes: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct SslOptsAndCachedConnector {
    ssl_opts: SslOpts,
    tls_connector: Arc<OnceCell<crate::io::TlsConnector>>,
}

impl fmt::Debug for SslOptsAndCachedConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SslOptsAndCachedConnector")
            .field("ssl_opts", &self.ssl_opts)
            .finish()
    }
}

impl SslOptsAndCachedConnector {
    fn new(ssl_opts: SslOpts) -> Self {
        Self {
            ssl_opts,
            tls_connector: Arc::new(OnceCell::new()),
        }
    }

    pub(crate) fn ssl_opts(&self) -> &SslOpts {
        &self.ssl_opts
    }

    pub(crate) async fn build_tls_connector(&self) -> Result<crate::io::TlsConnector> {
        self.tls_connector
            .get_or_try_init(move || self.ssl_opts.build_tls_connector())
            .await
            .cloned()
    }
}

impl PartialEq for SslOptsAndCachedConnector {
    fn eq(&self, other: &Self) -> bool {
        self.ssl_opts == other.ssl_opts
    }
}
impl Eq for SslOptsAndCachedConnector {}

/// Connection pool constraints.
///
/// This type stores `min` and `max` constraints for [`crate::Pool`] and ensures that `min <= max`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct PoolConstraints {
    min: usize,
    max: usize,
}

impl PoolConstraints {
    /// Creates new [`PoolConstraints`] if constraints are valid (`min <= max`).
    ///
    /// # Connection URL
    ///
    /// You can use `pool_min` and `pool_max` URL parameters to define pool constraints.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?pool_min=0&pool_max=151")?;
    /// assert_eq!(opts.pool_opts().constraints(), PoolConstraints::new(0, 151).unwrap());
    /// # Ok(()) }
    /// ```
    pub const fn new(min: usize, max: usize) -> Option<PoolConstraints> {
        if min <= max && max > 0 {
            Some(PoolConstraints { min, max })
        } else {
            None
        }
    }

    /// Lower bound of this pool constraints.
    pub fn min(&self) -> usize {
        self.min
    }

    /// Upper bound of this pool constraints.
    pub fn max(&self) -> usize {
        self.max
    }
}

impl Default for PoolConstraints {
    fn default() -> Self {
        DEFAULT_POOL_CONSTRAINTS
    }
}

impl From<PoolConstraints> for (usize, usize) {
    /// Transforms constraints to a pair of `(min, max)`.
    fn from(PoolConstraints { min, max }: PoolConstraints) -> Self {
        (min, max)
    }
}

/// Provides a way to build [`Opts`].
///
/// ```
/// # use mysql_async::OptsBuilder;
/// // You can use the default builder
/// let existing_opts = OptsBuilder::default()
///     .ip_or_hostname("foo")
///     .db_name(Some("bar"))
///     // ..
/// # ;
///
/// // Or use existing T: Into<Opts>
/// let builder = OptsBuilder::from(existing_opts)
///     .ip_or_hostname("baz")
///     .tcp_port(33306)
///     // ..
/// # ;
/// ```
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct OptsBuilder {
    opts: MysqlOpts,
    ip_or_hostname: String,
    tcp_port: u16,
    resolved_ips: Option<Vec<IpAddr>>,
}

impl Default for OptsBuilder {
    fn default() -> Self {
        let address = HostPortOrUrl::default();
        Self {
            opts: MysqlOpts::default(),
            ip_or_hostname: address.get_ip_or_hostname().into(),
            tcp_port: address.get_tcp_port(),
            resolved_ips: None,
        }
    }
}

impl OptsBuilder {
    /// Creates new builder from the given `Opts`.
    ///
    /// # Panic
    ///
    /// It'll panic if `Opts::try_from(opts)` returns error.
    pub fn from_opts<T>(opts: T) -> Self
    where
        Opts: TryFrom<T>,
        <Opts as TryFrom<T>>::Error: std::error::Error,
    {
        let opts = Opts::try_from(opts).unwrap();

        OptsBuilder {
            tcp_port: opts.inner.address.get_tcp_port(),
            ip_or_hostname: opts.inner.address.get_ip_or_hostname().to_string(),
            resolved_ips: opts.inner.address.get_resolved_ips().clone(),
            opts: opts.inner.mysql_opts.clone(),
        }
    }

    /// Defines server IP or hostname. See [`Opts::ip_or_hostname`].
    pub fn ip_or_hostname<T: Into<String>>(mut self, ip_or_hostname: T) -> Self {
        self.ip_or_hostname = ip_or_hostname.into();
        self
    }

    /// Defines TCP port. See [`Opts::tcp_port`].
    pub fn tcp_port(mut self, tcp_port: u16) -> Self {
        self.tcp_port = tcp_port;
        self
    }

    /// Defines already-resolved IPs to use for the connection. When provided
    /// the connection will not perform DNS resolution and the hostname will be
    /// used only for TLS identity verification purposes.
    pub fn resolved_ips<T: Into<Vec<IpAddr>>>(mut self, ips: Option<T>) -> Self {
        self.resolved_ips = ips.map(Into::into);
        self
    }

    /// Defines user name. See [`Opts::user`].
    pub fn user<T: Into<String>>(mut self, user: Option<T>) -> Self {
        self.opts.user = user.map(Into::into);
        self
    }

    /// Defines password. See [`Opts::pass`].
    pub fn pass<T: Into<String>>(mut self, pass: Option<T>) -> Self {
        self.opts.pass = pass.map(Into::into);
        self
    }

    /// Defines database name. See [`Opts::db_name`].
    pub fn db_name<T: Into<String>>(mut self, db_name: Option<T>) -> Self {
        self.opts.db_name = db_name.map(Into::into);
        self
    }

    /// Defines a callback that runs after connection. See [`Opts::after_connect`].
    pub fn after_connect<F>(mut self, callback: F) -> Self
    where
        F: for<'a> Fn(&'a mut crate::Conn) -> crate::BoxFuture<'a, ()> + Send + Sync + 'static,
    {
        self.opts.after_connect = Some(AfterConnectCallbackWrapper(Arc::new(callback)));
        self
    }

    /// Defines the callback run after every setup, including pool resets.
    /// See [`Opts::setup_callback`].
    pub fn setup_callback<F>(mut self, callback: F) -> Self
    where
        F: for<'a> Fn(&'a mut crate::Conn) -> crate::BoxFuture<'a, ()> + Send + Sync + 'static,
    {
        self.opts.setup_callback = Some(AfterConnectCallbackWrapper(Arc::new(callback)));
        self
    }

    /// Defines initial queries. See [`Opts::init`].
    pub fn init<T: Into<String>>(mut self, init: Vec<T>) -> Self {
        self.opts.init = init.into_iter().map(Into::into).collect();
        self
    }

    /// Defines setup queries. See [`Opts::setup`].
    pub fn setup<T: Into<String>>(mut self, setup: Vec<T>) -> Self {
        self.opts.setup = setup.into_iter().map(Into::into).collect();
        self
    }

    /// Defines `tcp_keepalive` option. See [`Opts::tcp_keepalive`].
    pub fn tcp_keepalive(mut self, tcp_keepalive: Option<Duration>) -> Self {
        self.opts.tcp_keepalive = tcp_keepalive;
        self
    }

    /// Defines `tcp_nodelay` option. See [`Opts::tcp_nodelay`].
    pub fn tcp_nodelay(mut self, nodelay: bool) -> Self {
        self.opts.tcp_nodelay = nodelay;
        self
    }

    /// Defines _global_ LOCAL INFILE handler (see crate-level docs).
    pub fn local_infile_handler<T>(mut self, handler: Option<T>) -> Self
    where
        T: GlobalHandler,
    {
        self.opts.local_infile_handler = handler.map(GlobalHandlerObject::new);
        self
    }

    /// Defines pool options. See [`Opts::pool_opts`].
    pub fn pool_opts<T: Into<Option<PoolOpts>>>(mut self, pool_opts: T) -> Self {
        self.opts.pool_opts = pool_opts.into().unwrap_or_default();
        self
    }

    /// Defines connection TTL. See [`Opts::conn_ttl`].
    pub fn conn_ttl<T: Into<Option<Duration>>>(mut self, conn_ttl: T) -> Self {
        self.opts.conn_ttl = conn_ttl.into();
        self
    }

    /// Defines statement cache size. See [`Opts::stmt_cache_size`].
    pub fn stmt_cache_size<T>(mut self, cache_size: T) -> Self
    where
        T: Into<Option<usize>>,
    {
        self.opts.stmt_cache_size = cache_size.into().unwrap_or(DEFAULT_STMT_CACHE_SIZE);
        self
    }

    /// Defines SSL options. See [`Opts::ssl_opts`].
    pub fn ssl_opts<T: Into<Option<SslOpts>>>(mut self, ssl_opts: T) -> Self {
        self.opts.ssl_opts = ssl_opts.into().map(SslOptsAndCachedConnector::new);
        self
    }

    /// Defines `prefer_socket` option. See [`Opts::prefer_socket`].
    pub fn prefer_socket<T: Into<Option<bool>>>(mut self, prefer_socket: T) -> Self {
        self.opts.prefer_socket = prefer_socket.into().unwrap_or(true);
        self
    }

    /// Defines socket path. See [`Opts::socket`].
    pub fn socket<T: Into<String>>(mut self, socket: Option<T>) -> Self {
        self.opts.socket = socket.map(Into::into);
        self
    }

    /// Defines compression. See [`Opts::compression`].
    pub fn compression<T: Into<Option<crate::Compression>>>(mut self, compression: T) -> Self {
        self.opts.compression = compression.into();
        self
    }

    /// Defines `max_allowed_packet` option. See [`Opts::max_allowed_packet`].
    ///
    /// Note that it'll saturate to proper minimum and maximum values
    /// for this parameter (see MySql documentation).
    pub fn max_allowed_packet(mut self, max_allowed_packet: Option<usize>) -> Self {
        self.opts.max_allowed_packet = max_allowed_packet.map(|x| x.clamp(1024, 1073741824));
        self
    }

    /// Defines `wait_timeout` option. See [`Opts::wait_timeout`].
    ///
    /// Note that it'll saturate to proper minimum and maximum values
    /// for this parameter (see MySql documentation).
    pub fn wait_timeout(mut self, wait_timeout: Option<usize>) -> Self {
        self.opts.wait_timeout = wait_timeout.map(|x| {
            #[cfg(windows)]
            let val = std::cmp::min(2147483, x);
            #[cfg(not(windows))]
            let val = std::cmp::min(31536000, x);

            val
        });
        self
    }

    /// Disables `mysql_old_password` plugin (defaults to `true`).
    ///
    /// Available via `secure_auth` connection url parameter.
    pub fn secure_auth(mut self, secure_auth: bool) -> Self {
        self.opts.secure_auth = secure_auth;
        self
    }

    /// Enables or disables `CLIENT_FOUND_ROWS` capability. See [`Opts::client_found_rows`].
    pub fn client_found_rows(mut self, client_found_rows: bool) -> Self {
        self.opts.client_found_rows = client_found_rows;
        self
    }

    /// Enables or disables `CLIENT_DEPRECATE_EOF` capability. See [`Opts::deprecate_eof`].
    pub fn deprecate_eof(mut self, deprecate_eof: bool) -> Self {
        self.opts.deprecate_eof = deprecate_eof;
        self
    }

    /// Enables Client-Side Cleartext Pluggable Authentication (defaults to `false`).
    ///
    /// Enables client to send passwords to the server as cleartext, without hashing or encryption
    /// (consult MySql documentation for more info).
    ///
    /// # Security Notes
    ///
    /// Sending passwords as cleartext may be a security problem in some configurations. Please
    /// consider using TLS or encrypted tunnels for server connection.
    ///
    /// # Connection URL
    ///
    /// Use `enable_cleartext_plugin` URL parameter to set this value. E.g.
    ///
    /// ```
    /// # use mysql_async::*;
    /// # fn main() -> Result<()> {
    /// let opts = Opts::from_url("mysql://localhost/db?enable_cleartext_plugin=true")?;
    /// assert!(opts.enable_cleartext_plugin());
    /// # Ok(()) }
    /// ```
    pub fn enable_cleartext_plugin(mut self, enable_cleartext_plugin: bool) -> Self {
        self.opts.enable_cleartext_plugin = enable_cleartext_plugin;
        self
    }

    /// Replaces connection attributes with the given map. See [`Opts::connect_attributes`].
    pub fn connect_attributes(mut self, attrs: std::collections::HashMap<String, String>) -> Self {
        self.opts.connect_attributes = Some(attrs);
        self
    }

    /// Adds or updates a single connection attribute key-value pair.
    pub fn connect_attribute<K: Into<String>, V: Into<String>>(mut self, key: K, value: V) -> Self {
        let map = self
            .opts
            .connect_attributes
            .get_or_insert_with(Default::default);
        map.insert(key.into(), value.into());
        self
    }
}

impl From<OptsBuilder> for Opts {
    fn from(builder: OptsBuilder) -> Opts {
        let address = HostPortOrUrl::HostPort {
            host: builder.ip_or_hostname,
            port: builder.tcp_port,
            resolved_ips: builder.resolved_ips,
        };
        let inner_opts = InnerOpts {
            mysql_opts: builder.opts,
            address,
        };

        Opts {
            inner: Arc::new(inner_opts),
        }
    }
}

/// [`COM_CHANGE_USER`][1] options.
///
/// Connection [`Opts`] are going to be updated accordingly upon `COM_CHANGE_USER`.
///
/// [`Opts`] won't be updated by default, because default `ChangeUserOpts` will reuse
/// connection's `user`, `pass` and `db_name`.
///
/// [1]: https://dev.mysql.com/doc/c-api/5.7/en/mysql-change-user.html
#[derive(Clone, Eq, PartialEq)]
pub struct ChangeUserOpts {
    user: Option<Option<String>>,
    pass: Option<Option<String>>,
    db_name: Option<Option<String>>,
}

impl ChangeUserOpts {
    pub(crate) fn update_opts(self, opts: &mut Opts) {
        if self.user.is_none() && self.pass.is_none() && self.db_name.is_none() {
            return;
        }

        let mut builder = OptsBuilder::from_opts(opts.clone());

        if let Some(user) = self.user {
            builder = builder.user(user);
        }

        if let Some(pass) = self.pass {
            builder = builder.pass(pass);
        }

        if let Some(db_name) = self.db_name {
            builder = builder.db_name(db_name);
        }

        *opts = Opts::from(builder);
    }

    /// Creates change user options that'll reuse connection options.
    pub fn new() -> Self {
        Self {
            user: None,
            pass: None,
            db_name: None,
        }
    }

    /// Set [`Opts::user`] to the given value.
    pub fn with_user(mut self, user: Option<String>) -> Self {
        self.user = Some(user);
        self
    }

    /// Set [`Opts::pass`] to the given value.
    pub fn with_pass(mut self, pass: Option<String>) -> Self {
        self.pass = Some(pass);
        self
    }

    /// Set [`Opts::db_name`] to the given value.
    pub fn with_db_name(mut self, db_name: Option<String>) -> Self {
        self.db_name = Some(db_name);
        self
    }

    /// Returns user.
    ///
    /// * if `None` then `self` does not meant to change user
    /// * if `Some(None)` then `self` will clear user
    /// * if `Some(Some(_))` then `self` will change user
    pub fn user(&self) -> Option<Option<&str>> {
        self.user.as_ref().map(|x| x.as_deref())
    }

    /// Returns password.
    ///
    /// * if `None` then `self` does not meant to change password
    /// * if `Some(None)` then `self` will clear password
    /// * if `Some(Some(_))` then `self` will change password
    pub fn pass(&self) -> Option<Option<&str>> {
        self.pass.as_ref().map(|x| x.as_deref())
    }

    /// Returns database name.
    ///
    /// * if `None` then `self` does not meant to change database name
    /// * if `Some(None)` then `self` will clear database name
    /// * if `Some(Some(_))` then `self` will change database name
    pub fn db_name(&self) -> Option<Option<&str>> {
        self.db_name.as_ref().map(|x| x.as_deref())
    }
}

impl Default for ChangeUserOpts {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for ChangeUserOpts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChangeUserOpts")
            .field("user", &self.user)
            .field(
                "pass",
                &self.pass.as_ref().map(|x| x.as_ref().map(|_| "...")),
            )
            .field("db_name", &self.db_name)
            .finish()
    }
}

fn get_opts_user_from_url(url: &Url) -> Option<String> {
    let user = url.username();
    if !user.is_empty() {
        Some(
            percent_decode(user.as_ref())
                .decode_utf8_lossy()
                .into_owned(),
        )
    } else {
        None
    }
}

fn get_opts_pass_from_url(url: &Url) -> Option<String> {
    url.password().map(|pass| {
        percent_decode(pass.as_ref())
            .decode_utf8_lossy()
            .into_owned()
    })
}

fn get_opts_db_name_from_url(url: &Url) -> Option<String> {
    if let Some(mut segments) = url.path_segments() {
        segments
            .next()
            .map(|db_name| {
                percent_decode(db_name.as_ref())
                    .decode_utf8_lossy()
                    .into_owned()
            })
            .filter(|db| !db.is_empty())
    } else {
        None
    }
}

fn from_url_basic(url: &Url) -> std::result::Result<(MysqlOpts, Vec<(String, String)>), UrlError> {
    if url.scheme() != "mysql" {
        return Err(UrlError::UnsupportedScheme {
            scheme: url.scheme().to_string(),
        });
    }
    if url.cannot_be_a_base() || !url.has_host() {
        return Err(UrlError::Invalid);
    }
    let user = get_opts_user_from_url(url);
    let pass = get_opts_pass_from_url(url);
    let db_name = get_opts_db_name_from_url(url);

    let query_pairs = url.query_pairs().into_owned().collect();
    let opts = MysqlOpts {
        user,
        pass,
        db_name,
        ..MysqlOpts::default()
    };

    Ok((opts, query_pairs))
}

fn mysql_opts_from_url(url: &Url) -> std::result::Result<MysqlOpts, UrlError> {
    let (mut opts, query_pairs): (MysqlOpts, _) = from_url_basic(url)?;
    let mut pool_min = DEFAULT_POOL_CONSTRAINTS.min;
    let mut pool_max = DEFAULT_POOL_CONSTRAINTS.max;

    let mut ssl_opts = None;
    let mut skip_domain_validation = false;
    let mut accept_invalid_certs = false;
    let mut disable_built_in_roots = false;
    #[cfg(feature = "rustls-tls")]
    let mut disable_tls_resumption = false;

    for (key, value) in query_pairs {
        if key == "pool_min" {
            match usize::from_str(&value) {
                Ok(value) => pool_min = value,
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "pool_min".into(),
                        value,
                    });
                }
            }
        } else if key == "pool_max" {
            match usize::from_str(&value) {
                Ok(value) => pool_max = value,
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "pool_max".into(),
                        value,
                    });
                }
            }
        } else if key == "inactive_connection_ttl" {
            match u64::from_str(&value) {
                Ok(value) => {
                    opts.pool_opts = opts
                        .pool_opts
                        .with_inactive_connection_ttl(Duration::from_secs(value))
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "inactive_connection_ttl".into(),
                        value,
                    });
                }
            }
        } else if key == "ttl_check_interval" {
            match u64::from_str(&value) {
                Ok(value) => {
                    opts.pool_opts = opts
                        .pool_opts
                        .with_ttl_check_interval(Duration::from_secs(value))
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "ttl_check_interval".into(),
                        value,
                    });
                }
            }
        } else if key == "conn_ttl" {
            match u64::from_str(&value) {
                Ok(value) => opts.conn_ttl = Some(Duration::from_secs(value)),
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "conn_ttl".into(),
                        value,
                    });
                }
            }
        } else if key == "abs_conn_ttl" {
            match u64::from_str(&value) {
                Ok(value) => {
                    opts.pool_opts = opts
                        .pool_opts
                        .with_abs_conn_ttl(Some(Duration::from_secs(value)))
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "abs_conn_ttl".into(),
                        value,
                    });
                }
            }
        } else if key == "abs_conn_ttl_jitter" {
            match u64::from_str(&value) {
                Ok(value) => {
                    opts.pool_opts = opts
                        .pool_opts
                        .with_abs_conn_ttl_jitter(Some(Duration::from_secs(value)))
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "abs_conn_ttl_jitter".into(),
                        value,
                    });
                }
            }
        } else if key == "tcp_keepalive" {
            match u32::from_str(&value) {
                Ok(value) => opts.tcp_keepalive = Some(Duration::from_millis(value.into())),
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "tcp_keepalive".into(),
                        value,
                    });
                }
            }
        } else if key == "max_allowed_packet" {
            match usize::from_str(&value) {
                Ok(value) => opts.max_allowed_packet = Some(value.clamp(1024, 1073741824)),
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "max_allowed_packet".into(),
                        value,
                    });
                }
            }
        } else if key == "wait_timeout" {
            match usize::from_str(&value) {
                #[cfg(windows)]
                Ok(value) => opts.wait_timeout = Some(std::cmp::min(2147483, value)),
                #[cfg(not(windows))]
                Ok(value) => opts.wait_timeout = Some(std::cmp::min(31536000, value)),
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "wait_timeout".into(),
                        value,
                    });
                }
            }
        } else if key == "enable_cleartext_plugin" {
            match bool::from_str(&value) {
                Ok(parsed) => opts.enable_cleartext_plugin = parsed,
                Err(_) => {
                    return Err(UrlError::InvalidParamValue {
                        param: key.to_string(),
                        value,
                    });
                }
            }
        } else if key == "reset_connection" {
            match bool::from_str(&value) {
                Ok(parsed) => opts.pool_opts = opts.pool_opts.with_reset_connection(parsed),
                Err(_) => {
                    return Err(UrlError::InvalidParamValue {
                        param: key.to_string(),
                        value,
                    });
                }
            }
        } else if key == "tcp_nodelay" {
            match bool::from_str(&value) {
                Ok(value) => opts.tcp_nodelay = value,
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "tcp_nodelay".into(),
                        value,
                    });
                }
            }
        } else if key == "stmt_cache_size" {
            match usize::from_str(&value) {
                Ok(stmt_cache_size) => {
                    opts.stmt_cache_size = stmt_cache_size;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "stmt_cache_size".into(),
                        value,
                    });
                }
            }
        } else if key == "prefer_socket" {
            match bool::from_str(&value) {
                Ok(prefer_socket) => {
                    opts.prefer_socket = prefer_socket;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "prefer_socket".into(),
                        value,
                    });
                }
            }
        } else if key == "secure_auth" {
            match bool::from_str(&value) {
                Ok(secure_auth) => {
                    opts.secure_auth = secure_auth;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "secure_auth".into(),
                        value,
                    });
                }
            }
        } else if key == "client_found_rows" {
            match bool::from_str(&value) {
                Ok(client_found_rows) => {
                    opts.client_found_rows = client_found_rows;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "client_found_rows".into(),
                        value,
                    });
                }
            }
        } else if key == "socket" {
            opts.socket = Some(value)
        } else if key == "compression" {
            if value == "fast" {
                opts.compression = Some(crate::Compression::fast());
            } else if value == "on" || value == "true" {
                opts.compression = Some(crate::Compression::default());
            } else if value == "best" {
                opts.compression = Some(crate::Compression::best());
            } else if value.len() == 1 && 0x30 <= value.as_bytes()[0] && value.as_bytes()[0] <= 0x39
            {
                opts.compression =
                    Some(crate::Compression::new((value.as_bytes()[0] - 0x30) as u32));
            } else {
                return Err(UrlError::InvalidParamValue {
                    param: "compression".into(),
                    value,
                });
            }
        } else if key == "require_ssl" {
            match bool::from_str(&value) {
                Ok(x) => {
                    ssl_opts = x.then(SslOpts::default);
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "require_ssl".into(),
                        value,
                    });
                }
            }
        } else if key == "verify_ca" {
            match bool::from_str(&value) {
                Ok(x) => {
                    accept_invalid_certs = !x;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "verify_ca".into(),
                        value,
                    });
                }
            }
        } else if key == "verify_identity" {
            match bool::from_str(&value) {
                Ok(x) => {
                    skip_domain_validation = !x;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "verify_identity".into(),
                        value,
                    });
                }
            }
        } else if key == "built_in_roots" {
            match bool::from_str(&value) {
                Ok(x) => {
                    disable_built_in_roots = !x;
                }
                _ => {
                    return Err(UrlError::InvalidParamValue {
                        param: "built_in_roots".into(),
                        value,
                    });
                }
            }
        } else if key == "disable_tls_resumption" {
            #[cfg(feature = "rustls-tls")]
            {
                match bool::from_str(&value) {
                    Ok(x) => {
                        disable_tls_resumption = x;
                    }
                    _ => {
                        return Err(UrlError::InvalidParamValue {
                            param: "disable_tls_resumption".into(),
                            value,
                        });
                    }
                }
            }
            #[cfg(not(feature = "rustls-tls"))]
            {
                return Err(UrlError::UnknownParameter { param: key });
            }
        } else {
            return Err(UrlError::UnknownParameter { param: key });
        }
    }

    if let Some(pool_constraints) = PoolConstraints::new(pool_min, pool_max) {
        opts.pool_opts = opts.pool_opts.with_constraints(pool_constraints);
    } else {
        return Err(UrlError::InvalidPoolConstraints {
            min: pool_min,
            max: pool_max,
        });
    }

    if let Some(ref mut ssl_opts) = ssl_opts {
        ssl_opts.accept_invalid_certs = accept_invalid_certs;
        ssl_opts.skip_domain_validation = skip_domain_validation;
        ssl_opts.disable_built_in_roots = disable_built_in_roots;
        #[cfg(feature = "rustls-tls")]
        {
            ssl_opts.disable_tls_resumption = disable_tls_resumption;
        }
    }

    opts.ssl_opts = ssl_opts.map(SslOptsAndCachedConnector::new);

    Ok(opts)
}

impl FromStr for Opts {
    type Err = UrlError;

    fn from_str(s: &str) -> std::result::Result<Self, <Self as FromStr>::Err> {
        Opts::from_url(s)
    }
}

impl TryFrom<&str> for Opts {
    type Error = UrlError;

    fn try_from(s: &str) -> std::result::Result<Self, UrlError> {
        Opts::from_url(s)
    }
}

#[cfg(test)]
mod test {
    use super::{HostPortOrUrl, MysqlOpts, Opts, Url};
    use crate::{consts::CapabilityFlags, error::UrlError::InvalidParamValue, SslOpts};

    use std::{net::IpAddr, net::Ipv4Addr, net::Ipv6Addr, str::FromStr};

    #[test]
    fn test_builder_eq_url() {
        const URL: &str = "mysql://iq-controller@localhost/iq_controller";

        let url_opts = super::Opts::from_str(URL).unwrap();
        let builder = super::OptsBuilder::default()
            .user(Some("iq-controller"))
            .ip_or_hostname("localhost")
            .db_name(Some("iq_controller"));
        let builder_opts = Opts::from(builder);

        assert_eq!(url_opts.addr_is_loopback(), builder_opts.addr_is_loopback());
        assert_eq!(url_opts.ip_or_hostname(), builder_opts.ip_or_hostname());
        assert_eq!(url_opts.tcp_port(), builder_opts.tcp_port());
        assert_eq!(url_opts.user(), builder_opts.user());
        assert_eq!(url_opts.pass(), builder_opts.pass());
        assert_eq!(url_opts.db_name(), builder_opts.db_name());
        assert_eq!(url_opts.init(), builder_opts.init());
        assert_eq!(url_opts.setup(), builder_opts.setup());
        assert_eq!(url_opts.tcp_keepalive(), builder_opts.tcp_keepalive());
        assert_eq!(url_opts.tcp_nodelay(), builder_opts.tcp_nodelay());
        assert_eq!(url_opts.pool_opts(), builder_opts.pool_opts());
        assert_eq!(url_opts.conn_ttl(), builder_opts.conn_ttl());
        assert_eq!(url_opts.abs_conn_ttl(), builder_opts.abs_conn_ttl());
        assert_eq!(
            url_opts.abs_conn_ttl_jitter(),
            builder_opts.abs_conn_ttl_jitter()
        );
        assert_eq!(url_opts.stmt_cache_size(), builder_opts.stmt_cache_size());
        assert_eq!(url_opts.ssl_opts(), builder_opts.ssl_opts());
        assert_eq!(url_opts.prefer_socket(), builder_opts.prefer_socket());
        assert_eq!(url_opts.socket(), builder_opts.socket());
        assert_eq!(url_opts.compression(), builder_opts.compression());
        assert_eq!(
            url_opts.hostport_or_url().get_ip_or_hostname(),
            builder_opts.hostport_or_url().get_ip_or_hostname()
        );
        assert_eq!(
            url_opts.hostport_or_url().get_tcp_port(),
            builder_opts.hostport_or_url().get_tcp_port()
        );
    }

    #[test]
    fn deprecate_eof_capability_can_be_disabled() {
        let default_opts = Opts::default();
        assert!(default_opts.deprecate_eof());
        assert!(default_opts
            .get_capabilities()
            .contains(CapabilityFlags::CLIENT_DEPRECATE_EOF));

        let legacy_eof_opts = Opts::from(super::OptsBuilder::default().deprecate_eof(false));
        assert!(!legacy_eof_opts.deprecate_eof());
        assert!(!legacy_eof_opts
            .get_capabilities()
            .contains(CapabilityFlags::CLIENT_DEPRECATE_EOF));
    }

    #[test]
    fn should_convert_url_into_opts() {
        let url = "mysql://usr:pw@192.168.1.1:3309/dbname?prefer_socket=true";
        let parsed_url =
            Url::parse("mysql://usr:pw@192.168.1.1:3309/dbname?prefer_socket=true").unwrap();

        let mysql_opts = MysqlOpts {
            user: Some("usr".to_string()),
            pass: Some("pw".to_string()),
            db_name: Some("dbname".to_string()),
            prefer_socket: true,
            ..MysqlOpts::default()
        };
        let host = HostPortOrUrl::Url(parsed_url);

        let opts = Opts::from_url(url).unwrap();

        assert_eq!(opts.inner.mysql_opts, mysql_opts);
        assert_eq!(opts.hostport_or_url(), &host);
    }

    #[test]
    fn should_convert_ipv6_url_into_opts() {
        let url = "mysql://usr:pw@[::1]:3309/dbname";

        let opts = Opts::from_url(url).unwrap();

        assert_eq!(opts.ip_or_hostname(), "[::1]");
    }

    #[test]
    fn should_parse_ssl_params() {
        const URL1: &str = "mysql://localhost/foo?require_ssl=false";
        let opts = Opts::from_url(URL1).unwrap();
        assert_eq!(opts.ssl_opts(), None);

        const URL2: &str = "mysql://localhost/foo?require_ssl=true";
        let opts = Opts::from_url(URL2).unwrap();
        assert_eq!(opts.ssl_opts(), Some(&SslOpts::default()));

        const URL3: &str = "mysql://localhost/foo?require_ssl=true&verify_ca=false";
        let opts = Opts::from_url(URL3).unwrap();
        assert_eq!(
            opts.ssl_opts(),
            Some(&SslOpts::default().with_danger_accept_invalid_certs(true))
        );

        const URL4: &str =
            "mysql://localhost/foo?require_ssl=true&verify_ca=false&verify_identity=false&built_in_roots=false";
        let opts = Opts::from_url(URL4).unwrap();
        assert_eq!(
            opts.ssl_opts(),
            Some(
                &SslOpts::default()
                    .with_danger_accept_invalid_certs(true)
                    .with_danger_skip_domain_validation(true)
                    .with_disable_built_in_roots(true)
            )
        );

        const URL5: &str =
            "mysql://localhost/foo?require_ssl=false&verify_ca=false&verify_identity=false";
        let opts = Opts::from_url(URL5).unwrap();
        assert_eq!(opts.ssl_opts(), None);

        #[cfg(feature = "rustls-tls")]
        {
            const URL_RESUMPTION: &str =
                "mysql://localhost/foo?require_ssl=true&disable_tls_resumption=true";
            let opts = Opts::from_url(URL_RESUMPTION).unwrap();
            assert_eq!(
                opts.ssl_opts(),
                Some(&SslOpts::default().with_disable_tls_resumption(true))
            );
        }
    }

    #[test]
    #[should_panic]
    fn should_panic_on_invalid_url() {
        let opts = "42";
        let _: Opts = Opts::from_str(opts).unwrap();
    }

    #[test]
    #[should_panic]
    fn should_panic_on_invalid_scheme() {
        let opts = "postgres://localhost";
        let _: Opts = Opts::from_str(opts).unwrap();
    }

    #[test]
    #[should_panic]
    fn should_panic_on_unknown_query_param() {
        let opts = "mysql://localhost/foo?bar=baz";
        let _: Opts = Opts::from_str(opts).unwrap();
    }

    #[test]
    fn should_parse_compression() {
        let err = Opts::from_url("mysql://localhost/foo?compression=").unwrap_err();
        assert_eq!(
            err,
            InvalidParamValue {
                param: "compression".into(),
                value: "".into()
            }
        );

        let err = Opts::from_url("mysql://localhost/foo?compression=a").unwrap_err();
        assert_eq!(
            err,
            InvalidParamValue {
                param: "compression".into(),
                value: "a".into()
            }
        );

        let opts = Opts::from_url("mysql://localhost/foo?compression=fast").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::fast()));

        let opts = Opts::from_url("mysql://localhost/foo?compression=on").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::default()));

        let opts = Opts::from_url("mysql://localhost/foo?compression=true").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::default()));

        let opts = Opts::from_url("mysql://localhost/foo?compression=best").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::best()));

        let opts = Opts::from_url("mysql://localhost/foo?compression=0").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::new(0)));

        let opts = Opts::from_url("mysql://localhost/foo?compression=9").unwrap();
        assert_eq!(opts.compression(), Some(crate::Compression::new(9)));
    }

    #[test]
    fn test_builder_eq_url_empty_db() {
        let builder = super::OptsBuilder::default();
        let builder_opts = Opts::from(builder);

        let url: &str = "mysql://iq-controller@localhost";
        let url_opts = super::Opts::from_str(url).unwrap();
        assert_eq!(url_opts.db_name(), builder_opts.db_name());

        let url: &str = "mysql://iq-controller@localhost/";
        let url_opts = super::Opts::from_str(url).unwrap();
        assert_eq!(url_opts.db_name(), builder_opts.db_name());
    }

    #[test]
    fn test_builder_update_port_host_resolved_ips() {
        let builder = super::OptsBuilder::default()
            .ip_or_hostname("foo")
            .tcp_port(33306);

        let resolved = vec![
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 7)),
            IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xc00a, 0x2ff)),
        ];
        let builder2 = builder
            .clone()
            .tcp_port(55223)
            .resolved_ips(Some(resolved.clone()));

        let builder_opts = Opts::from(builder);
        assert_eq!(builder_opts.ip_or_hostname(), "foo");
        assert_eq!(builder_opts.tcp_port(), 33306);
        assert_eq!(
            builder_opts.hostport_or_url(),
            &HostPortOrUrl::HostPort {
                host: "foo".to_string(),
                port: 33306,
                resolved_ips: None
            }
        );

        let builder_opts2 = Opts::from(builder2);
        assert_eq!(builder_opts2.ip_or_hostname(), "foo");
        assert_eq!(builder_opts2.tcp_port(), 55223);
        assert_eq!(
            builder_opts2.hostport_or_url(),
            &HostPortOrUrl::HostPort {
                host: "foo".to_string(),
                port: 55223,
                resolved_ips: Some(resolved),
            }
        );
    }
}
