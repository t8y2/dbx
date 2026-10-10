// Copyright (c) 2016 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_util::FutureExt;

use mysql_common::{
    auth::{self, plugins::ChallengeResponsePlugin as _},
    constants::{
        MariadbCapabilities, DEFAULT_MAX_ALLOWED_PACKET, UTF8MB4_GENERAL_CI, UTF8_GENERAL_CI,
    },
    io::ParseBuf,
    packets::{
        AuthPlugin, AuthSwitchRequest, CommonOkPacket, ErrPacket, HandshakePacket,
        HandshakeResponse, OkPacket, OkPacketDeserializer, OldAuthSwitchRequest, OldEofPacket,
        ResultSetTerminator, SslRequest,
    },
    proto::MySerialize,
    row::Row,
};

use std::{
    borrow::Cow,
    fmt,
    future::Future,
    mem::{self, replace},
    pin::Pin,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    buffer_pool::PooledBuf,
    conn::{pool::Pool, stmt_cache::StmtCache},
    consts::{CapabilityFlags, Command, StatusFlags},
    error::*,
    io::Stream,
    opts::Opts,
    queryable::{
        query_result::{QueryResult, ResultSetMeta},
        transaction::TxStatus,
        BinaryProtocol, Queryable, TextProtocol,
    },
    ChangeUserOpts, InfileData, OptsBuilder,
};

use self::routines::Routine;

#[cfg(feature = "binlog")]
pub mod binlog_stream;
pub mod pool;
pub mod routines;
pub mod stmt_cache;

const DEFAULT_WAIT_TIMEOUT: usize = 28800;

type AuthState = (
    AuthContext,
    auth::plugins::AuthProc,
    auth::plugins::Response,
);

struct AuthContext {
    pass: Vec<u8>,
    is_ipc_transport: bool,
    is_tls_transport: bool,
    scramble: Vec<u8>,
    server_key_pem: Option<Vec<u8>>,
}

impl auth::plugins::Context for &'_ AuthContext {
    fn pass(&self) -> &[u8] {
        &self.pass
    }

    fn is_ipc_transport(&self) -> bool {
        self.is_ipc_transport
    }

    fn is_tls_transport(&self) -> bool {
        self.is_tls_transport
    }

    fn scramble(&self) -> &[u8] {
        &self.scramble
    }

    fn server_key_pem(&self) -> Option<&[u8]> {
        self.server_key_pem.as_deref()
    }
}

/// Helper that asynchronously disconnects the given connection on the default tokio executor.
fn disconnect(mut conn: Conn) {
    let disconnected = conn.inner.disconnected;

    // Mark conn as disconnected.
    conn.inner.disconnected = true;

    if !disconnected {
        // We shouldn't call tokio::spawn if unwinding
        if std::thread::panicking() {
            return;
        }

        // Server will report broken connection if spawn fails.
        // this might fail if, say, the runtime is shutting down, but we've done what we could
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Ok(conn) = conn.cleanup_for_pool().await {
                    let _ = conn.disconnect().await;
                }
            });
        }
    }
}

/// Pending result set.
#[derive(Debug, Clone)]
pub(crate) enum PendingResult {
    /// There is a pending result set.
    Pending(ResultSetMeta),
    /// Result set metadata was taken but not yet consumed.
    Taken(Arc<ResultSetMeta>),
}

/// Mysql connection
struct ConnInner {
    stream: Option<Stream>,
    id: u32,
    is_mariadb: bool,
    version: (u16, u16, u16),
    socket: Option<String>,
    capabilities: CapabilityFlags,
    mariadb_capabilities: MariadbCapabilities,
    status: StatusFlags,
    last_ok_packet: Option<OkPacket<'static>>,
    last_err_packet: Option<mysql_common::packets::ServerError<'static>>,
    handshake_complete: bool,
    pool: Option<Pool>,
    pending_result: std::result::Result<Option<PendingResult>, ServerError>,
    tx_status: TxStatus,
    reset_upon_returning_to_a_pool: bool,
    opts: Opts,
    ttl_deadline: Option<Instant>,
    last_io: Instant,
    wait_timeout: Duration,
    stmt_cache: StmtCache,
    nonce: Vec<u8>,
    auth_plugin: AuthPlugin<'static>,
    server_key: Option<Vec<u8>>,
    active_since: Instant,
    /// Connection is already disconnected.
    pub(crate) disconnected: bool,
    /// One-time connection-level infile handler.
    infile_handler:
        Option<Pin<Box<dyn Future<Output = crate::Result<InfileData>> + Send + Sync + 'static>>>,
}

impl fmt::Debug for ConnInner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Conn")
            .field("connection id", &self.id)
            .field("server version", &self.version)
            .field("pool", &self.pool)
            .field("pending_result", &self.pending_result)
            .field("tx_status", &self.tx_status)
            .field("stream", &self.stream)
            .field("options", &self.opts)
            .field("server_key", &self.server_key)
            .field("auth_plugin", &self.auth_plugin)
            .field("capabilities", &self.capabilities)
            .field("mariadb_capabilities", &self.mariadb_capabilities)
            .finish()
    }
}

impl ConnInner {
    /// Constructs an empty connection.
    fn empty(opts: Opts) -> ConnInner {
        let ttl_deadline = opts.pool_opts().new_connection_ttl_deadline();
        ConnInner {
            capabilities: CapabilityFlags::empty(),
            mariadb_capabilities: MariadbCapabilities::empty(),
            status: StatusFlags::empty(),
            last_ok_packet: None,
            last_err_packet: None,
            handshake_complete: false,
            stream: None,
            is_mariadb: false,
            version: (0, 0, 0),
            id: 0,
            pending_result: Ok(None),
            pool: None,
            tx_status: TxStatus::None,
            last_io: Instant::now(),
            wait_timeout: Duration::from_secs(0),
            stmt_cache: StmtCache::new(opts.stmt_cache_size()),
            socket: opts.socket().map(Into::into),
            opts,
            ttl_deadline,
            nonce: Vec::default(),
            auth_plugin: AuthPlugin::MysqlNativePassword,
            disconnected: false,
            server_key: None,
            infile_handler: None,
            reset_upon_returning_to_a_pool: false,
            active_since: Instant::now(),
        }
    }

    /// Returns mutable reference to a connection stream.
    ///
    /// Returns `DriverError::ConnectionClosed` if there is no stream.
    fn stream_mut(&mut self) -> Result<&mut Stream> {
        self.stream
            .as_mut()
            .ok_or_else(|| DriverError::ConnectionClosed.into())
    }

    fn stream_ref(&self) -> Result<&Stream> {
        self.stream
            .as_ref()
            .ok_or_else(|| DriverError::ConnectionClosed.into())
    }
}

/// MySql server connection.
#[derive(Debug)]
pub struct Conn {
    inner: Box<ConnInner>,
}

impl Conn {
    /// Returns connection identifier.
    pub fn id(&self) -> u32 {
        self.inner.id
    }

    /// Returns the disconnected state of the connection.
    pub fn is_disconnected(&self) -> bool {
        self.inner.disconnected
    }

    /// Returns the ID generated by a query (usually `INSERT`) on a table with a column having the
    /// `AUTO_INCREMENT` attribute. Returns `None` if there was no previous query on the connection
    /// or if the query did not update an AUTO_INCREMENT value.
    pub fn last_insert_id(&self) -> Option<u64> {
        self.inner
            .last_ok_packet
            .as_ref()
            .and_then(|ok| ok.last_insert_id())
    }

    /// Returns the number of rows affected by the last `INSERT`, `UPDATE`, `REPLACE` or `DELETE`
    /// query.
    pub fn affected_rows(&self) -> u64 {
        self.inner
            .last_ok_packet
            .as_ref()
            .map(|ok| ok.affected_rows())
            .unwrap_or_default()
    }

    /// Text information, as reported by the server in the last OK packet, or an empty string.
    pub fn info(&self) -> Cow<'_, str> {
        self.inner
            .last_ok_packet
            .as_ref()
            .and_then(|ok| ok.info_str())
            .unwrap_or_else(|| "".into())
    }

    /// Number of warnings, as reported by the server in the last OK packet, or `0`.
    pub fn get_warnings(&self) -> u16 {
        self.inner
            .last_ok_packet
            .as_ref()
            .map(|ok| ok.warnings())
            .unwrap_or_default()
    }

    /// Returns a reference to the last OK packet.
    pub fn last_ok_packet(&self) -> Option<&OkPacket<'static>> {
        self.inner.last_ok_packet.as_ref()
    }

    /// Turns on/off automatic connection reset (see [`crate::PoolOpts::with_reset_connection`]).
    ///
    /// Only makes sense for pooled connections.
    pub fn reset_connection(&mut self, reset_connection: bool) {
        self.inner.reset_upon_returning_to_a_pool = reset_connection;
    }

    pub(crate) fn stream_ref(&self) -> Result<&Stream> {
        self.inner.stream_ref()
    }

    pub(crate) fn stream_mut(&mut self) -> Result<&mut Stream> {
        self.inner.stream_mut()
    }

    pub(crate) fn capabilities(&self) -> CapabilityFlags {
        self.inner.capabilities
    }

    pub(crate) fn has_capabilities(&self, c: CapabilityFlags) -> bool {
        self.inner.capabilities.contains(c)
    }

    pub(crate) fn has_mariadb_capabilities(&self, c: MariadbCapabilities) -> bool {
        self.inner.mariadb_capabilities.contains(c)
    }

    /// Will update last IO time for this connection.
    pub(crate) fn touch(&mut self) {
        self.inner.last_io = Instant::now();
    }

    /// Will set packet sequence id to `0`.
    pub(crate) fn reset_seq_id(&mut self) {
        if let Some(stream) = self.inner.stream.as_mut() {
            stream.reset_seq_id();
        }
    }

    /// Will synchronize sequence ids between compressed and uncompressed codecs.
    pub(crate) fn sync_seq_id(&mut self) {
        if let Some(stream) = self.inner.stream.as_mut() {
            stream.sync_seq_id();
        }
    }

    /// Handles OK packet.
    pub(crate) fn handle_ok(&mut self, ok_packet: OkPacket<'static>) {
        self.inner.status = ok_packet.status_flags();
        self.inner.last_err_packet = None;
        self.inner.last_ok_packet = Some(ok_packet);
    }

    /// Handles ERR packet.
    pub(crate) fn handle_err(&mut self, err_packet: ErrPacket<'_>) -> Result<()> {
        match err_packet {
            ErrPacket::Error(err) => {
                self.inner.status = StatusFlags::empty();
                self.inner.last_ok_packet = None;
                self.inner.last_err_packet = Some(err.clone().into_owned());
                Err(Error::from(err))
            }
            ErrPacket::Progress(_) => Ok(()),
        }
    }

    /// Returns the current transaction status.
    pub(crate) fn get_tx_status(&self) -> TxStatus {
        self.inner.tx_status
    }

    /// Sets the given transaction status for this connection.
    pub(crate) fn set_tx_status(&mut self, tx_status: TxStatus) {
        self.inner.tx_status = tx_status;
    }

    /// Returns pending result metadata, if any.
    ///
    /// If `Some(_)`, then result is not yet consumed.
    pub(crate) fn use_pending_result(
        &mut self,
    ) -> std::result::Result<Option<&PendingResult>, ServerError> {
        if let Err(ref e) = self.inner.pending_result {
            let e = e.clone();
            self.inner.pending_result = Ok(None);
            Err(e)
        } else {
            Ok(self.inner.pending_result.as_ref().unwrap().as_ref())
        }
    }

    pub(crate) fn get_pending_result(
        &self,
    ) -> std::result::Result<Option<&PendingResult>, &ServerError> {
        self.inner.pending_result.as_ref().map(|x| x.as_ref())
    }

    pub(crate) fn has_pending_result(&self) -> bool {
        self.inner.pending_result.is_err() || matches!(self.inner.pending_result, Ok(Some(_)))
    }

    /// Sets the given pending result metadata for this connection. Returns the previous value.
    pub(crate) fn set_pending_result(
        &mut self,
        meta: Option<ResultSetMeta>,
    ) -> std::result::Result<Option<PendingResult>, ServerError> {
        replace(
            &mut self.inner.pending_result,
            Ok(meta.map(PendingResult::Pending)),
        )
    }

    pub(crate) fn set_pending_result_error(
        &mut self,
        error: ServerError,
    ) -> std::result::Result<Option<PendingResult>, ServerError> {
        replace(&mut self.inner.pending_result, Err(error))
    }

    /// Gives the currently pending result to a caller for consumption.
    pub(crate) fn take_pending_result(
        &mut self,
    ) -> std::result::Result<Option<Arc<ResultSetMeta>>, ServerError> {
        let mut output = None;

        self.inner.pending_result = match replace(&mut self.inner.pending_result, Ok(None))? {
            Some(PendingResult::Pending(x)) => {
                let meta = Arc::new(x);
                output = Some(meta.clone());
                Ok(Some(PendingResult::Taken(meta)))
            }
            x => Ok(x),
        };

        Ok(output)
    }

    /// Returns current status flags.
    pub(crate) fn status(&self) -> StatusFlags {
        self.inner.status
    }

    pub(crate) async fn routine<'a, F, T>(&mut self, f: F) -> crate::Result<T>
    where
        F: Routine<T> + 'a,
    {
        self.inner.disconnected = true;
        let result = f.call(&mut *self).await;
        match result {
            result @ Ok(_) | result @ Err(crate::Error::Server(_)) => {
                // either OK or non-fatal error
                self.inner.disconnected = false;
                result
            }
            Err(err) => {
                if self.inner.stream.is_some() {
                    self.take_stream().close().await?;
                }
                Err(err)
            }
        }
    }

    /// Returns server version.
    pub fn server_version(&self) -> (u16, u16, u16) {
        self.inner.version
    }

    /// Returns connection options.
    pub fn opts(&self) -> &Opts {
        &self.inner.opts
    }

    /// Setup _local_ `LOCAL INFILE` handler (see ["LOCAL INFILE Handlers"][2] section
    /// of the crate-level docs).
    ///
    /// It'll overwrite existing _local_ handler, if any.
    ///
    /// [2]: ../mysql_async/#local-infile-handlers
    pub fn set_infile_handler<T>(&mut self, handler: T)
    where
        T: Future<Output = crate::Result<InfileData>>,
        T: Send + Sync + 'static,
    {
        self.inner.infile_handler = Some(Box::pin(handler));
    }

    fn take_stream(&mut self) -> Stream {
        self.inner.stream.take().unwrap()
    }

    /// Disconnects this connection from server.
    pub async fn disconnect(mut self) -> Result<()> {
        if !self.inner.disconnected {
            self.inner.disconnected = true;
            self.write_command_data(Command::COM_QUIT, &[]).await?;
            let stream = self.take_stream();
            stream.close().await?;
        }
        Ok(())
    }

    /// Closes the connection.
    async fn close_conn(mut self) -> Result<()> {
        self = self.cleanup_for_pool().await?;
        self.disconnect().await
    }

    /// Returns true if io stream is encrypted.
    fn is_secure(&self) -> bool {
        #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
        {
            self.inner
                .stream
                .as_ref()
                .map(|x| x.is_secure())
                .unwrap_or_default()
        }

        #[cfg(not(any(feature = "native-tls-tls", feature = "rustls-tls")))]
        false
    }

    /// Returns true if io stream is socket.
    fn is_socket(&self) -> bool {
        #[cfg(unix)]
        {
            self.inner
                .stream
                .as_ref()
                .map(|x| x.is_socket())
                .unwrap_or_default()
        }

        #[cfg(not(unix))]
        false
    }

    /// Hacky way to move connection through &mut. `self` becomes unusable.
    fn take(&mut self) -> Conn {
        mem::replace(self, Conn::empty(Default::default()))
    }

    fn empty(opts: Opts) -> Self {
        Self {
            inner: Box::new(ConnInner::empty(opts)),
        }
    }

    /// Set `io::Stream` options as defined in the `Opts` of the connection.
    ///
    /// Requires that self.inner.stream is Some
    fn setup_stream(&mut self) -> Result<()> {
        debug_assert!(self.inner.stream.is_some());
        if let Some(stream) = self.inner.stream.as_mut() {
            stream.set_tcp_nodelay(self.inner.opts.tcp_nodelay())?;
        }
        Ok(())
    }

    async fn handle_handshake(&mut self) -> Result<()> {
        let packet = self.read_packet().await?;
        let handshake = ParseBuf(&packet).parse::<HandshakePacket>(())?;

        // Handshake scramble is always 21 bytes length (20 + zero terminator)
        self.inner.nonce = {
            let mut nonce = Vec::from(handshake.scramble_1_ref());
            nonce.extend_from_slice(handshake.scramble_2_ref().unwrap_or(&[][..]));
            // Trim zero terminator. Fill with zeroes if nonce
            // is somehow smaller than 20 bytes (this matches the server behavior).
            nonce.resize(20, 0);
            nonce
        };

        self.inner.capabilities = handshake.capabilities() & self.inner.opts.get_capabilities();
        self.inner.version = handshake
            .maria_db_server_version_parsed()
            .inspect(|_| self.inner.is_mariadb = true)
            .or_else(|| handshake.server_version_parsed())
            .unwrap_or((0, 0, 0));
        self.inner.id = handshake.connection_id();
        self.inner.status = handshake.status_flags();

        // If we have a MariaDB server version, we are using mariadb extended capabilities from the handshake packet.
        // MariaDB does not set the first standard capability flag bit to indicate that it supports extended capabilities.
        if self.inner.is_mariadb && !self.has_capabilities(CapabilityFlags::CLIENT_LONG_PASSWORD) {
            self.inner.mariadb_capabilities =
                handshake.mariadb_ext_capabilities() & self.inner.opts.get_mariadb_capabilities();
        }

        // Only plugins that MySQL may advertise in the initial handshake are
        // accepted here. Other supported plugins are negotiated by auth switch.
        self.inner.auth_plugin = match handshake.auth_plugin() {
            Some(AuthPlugin::CachingSha2Password) => AuthPlugin::CachingSha2Password,
            Some(AuthPlugin::Sha256Password) => AuthPlugin::Sha256Password,
            _ => AuthPlugin::MysqlNativePassword,
        };

        Ok(())
    }

    async fn switch_to_ssl_if_needed(&mut self) -> Result<()> {
        if self
            .inner
            .opts
            .get_capabilities()
            .contains(CapabilityFlags::CLIENT_SSL)
        {
            if !self.has_capabilities(CapabilityFlags::CLIENT_SSL) {
                return Err(DriverError::NoClientSslFlagFromServer.into());
            }

            let collation = if self.inner.version >= (5, 5, 3) {
                UTF8MB4_GENERAL_CI
            } else {
                UTF8_GENERAL_CI
            };

            let ssl_request = SslRequest::new(
                self.inner.capabilities,
                DEFAULT_MAX_ALLOWED_PACKET as u32,
                collation as u8,
            )
            .with_mariadb_capabilities(self.inner.mariadb_capabilities);
            self.write_struct(&ssl_request).await?;
            let conn = self;
            let ssl_opts = conn.opts().ssl_opts_and_connector().expect("unreachable");
            let domain = ssl_opts
                .ssl_opts()
                .tls_hostname_override()
                .unwrap_or_else(|| conn.opts().ip_or_hostname())
                .into();
            let tls_connector = ssl_opts.build_tls_connector().await?;
            conn.stream_mut()?
                .make_secure(domain, &tls_connector)
                .await?;
            Ok(())
        } else {
            Ok(())
        }
    }

    fn auth_context(&self) -> AuthContext {
        AuthContext {
            pass: self
                .inner
                .opts
                .pass()
                .map(str::as_bytes)
                .unwrap_or_default()
                .to_vec(),
            is_ipc_transport: self.is_socket(),
            is_tls_transport: self.is_secure(),
            scramble: self.inner.nonce.clone(),
            server_key_pem: self.inner.server_key.clone(),
        }
    }

    fn start_auth(&self, plugin: &AuthPlugin<'_>, challenge: &[u8]) -> Result<AuthState> {
        if matches!(plugin, AuthPlugin::MysqlOldPassword) && self.inner.opts.secure_auth() {
            return Err(DriverError::MysqlOldPasswordDisabled.into());
        }
        if matches!(plugin, AuthPlugin::MysqlClearPassword)
            && !self.inner.opts.enable_cleartext_plugin()
        {
            return Err(DriverError::CleartextPluginDisabled.into());
        }

        let context = self.auth_context();
        let mut procedure = plugin.init().map_err(DriverError::from)?;
        let response = procedure
            .run(&context, challenge)
            .map_err(DriverError::from)?;
        Ok((context, procedure, response))
    }

    async fn do_handshake_response(&mut self) -> Result<AuthState> {
        let plugin = self.inner.auth_plugin.clone();
        let nonce = self.inner.nonce.clone();
        let state = self.start_auth(&plugin, &nonce)?;

        let handshake_response = HandshakeResponse::new(
            state.2.data(),
            self.inner.version,
            self.inner.opts.user().map(|x| x.as_bytes()),
            self.inner.opts.db_name().map(|x| x.as_bytes()),
            Some(self.inner.auth_plugin.borrow()),
            self.capabilities(),
            self.inner.opts.connect_attributes().cloned(),
            self.inner
                .opts
                .max_allowed_packet()
                .unwrap_or(DEFAULT_MAX_ALLOWED_PACKET) as u32,
        )
        .with_mariadb_ext_capabilities(self.inner.mariadb_capabilities);

        let mut buf = crate::buffer_pool().get();
        handshake_response.serialize(buf.as_mut());

        self.write_packet(buf).await?;
        self.inner.handshake_complete = true;
        Ok(state)
    }

    async fn perform_auth_switch(
        &mut self,
        auth_switch_request: AuthSwitchRequest<'_>,
    ) -> Result<AuthState> {
        self.inner.nonce = auth_switch_request.plugin_data().to_vec();
        self.inner.auth_plugin = auth_switch_request.auth_plugin().clone().into_owned();

        let plugin = self.inner.auth_plugin.clone();
        let nonce = self.inner.nonce.clone();
        let state = self.start_auth(&plugin, &nonce)?;
        if let Some(data) = state.2.data() {
            self.write_bytes(data).await?;
        }
        Ok(state)
    }

    async fn continue_auth(
        &mut self,
        mut auth_switched: bool,
        mut context: AuthContext,
        mut procedure: auth::plugins::AuthProc,
        mut previous_response: auth::plugins::Response,
    ) -> Result<()> {
        loop {
            let packet = self.read_packet().await?;

            if packet.first() == Some(&0xfe) && !auth_switched {
                let auth_switch = if packet.len() > 1 {
                    ParseBuf(&packet)
                        .parse::<AuthSwitchRequest>(())?
                        .into_owned()
                } else {
                    let _ = ParseBuf(&packet).parse::<OldAuthSwitchRequest>(())?;
                    AuthSwitchRequest::new(
                        "mysql_old_password".as_bytes(),
                        self.inner.nonce.clone(),
                    )
                };
                (context, procedure, previous_response) =
                    self.perform_auth_switch(auth_switch).await?;
                auth_switched = true;
                continue;
            }

            let challenge = packet.strip_prefix(b"\x01").unwrap_or(&packet);
            if challenge.starts_with(b"-----BEGIN PUBLIC KEY-----") {
                self.inner.server_key = Some(challenge.to_vec());
            }

            match previous_response {
                auth::plugins::Response::Next { .. } => {
                    let response = procedure
                        .run(&context, challenge)
                        .map_err(DriverError::from)?;
                    if let Some(data) = response.data() {
                        self.write_bytes(data).await?;
                    }
                    previous_response = response;
                }
                auth::plugins::Response::Last { .. } => {
                    if packet.first() == Some(&0x00) {
                        return Ok(());
                    }
                    return Err(DriverError::UnexpectedPacket {
                        payload: packet.to_vec(),
                    }
                    .into());
                }
            }
        }
    }

    fn switch_to_compression(&mut self) -> Result<()> {
        if self.has_capabilities(CapabilityFlags::CLIENT_COMPRESS) {
            if let Some(compression) = self.inner.opts.compression() {
                if let Some(stream) = self.inner.stream.as_mut() {
                    stream.compress(compression);
                }
            }
        }
        Ok(())
    }

    /// Returns `true` for ProgressReport packet.
    fn handle_packet(&mut self, packet: &PooledBuf) -> Result<bool> {
        let ok_packet = if self.has_pending_result() {
            if self.has_capabilities(CapabilityFlags::CLIENT_DEPRECATE_EOF) {
                ParseBuf(packet)
                    .parse::<OkPacketDeserializer<ResultSetTerminator>>(self.capabilities())
                    .map(|x| x.into_inner())
            } else {
                ParseBuf(packet)
                    .parse::<OkPacketDeserializer<OldEofPacket>>(self.capabilities())
                    .map(|x| x.into_inner())
            }
        } else {
            ParseBuf(packet)
                .parse::<OkPacketDeserializer<CommonOkPacket>>(self.capabilities())
                .map(|x| x.into_inner())
        };

        if let Ok(ok_packet) = ok_packet {
            self.handle_ok(ok_packet.into_owned());
        } else {
            // If we haven't completed the handshake the server will not be aware of our
            // capabilities and so it will behave as if we have none. In particular, the error
            // packet will not contain a SQL State field even if our capabilities do contain the
            // `CLIENT_PROTOCOL_41` flag. Therefore it is necessary to parse an incoming packet
            // with no capability assumptions if we have not completed the handshake.
            //
            // https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase.html
            let capabilities = if self.inner.handshake_complete {
                self.capabilities()
            } else {
                CapabilityFlags::empty()
            };
            let err_packet = ParseBuf(packet).parse::<ErrPacket>(capabilities);
            if let Ok(err_packet) = err_packet {
                self.handle_err(err_packet)?;
                return Ok(true);
            }
        }

        Ok(false)
    }

    pub(crate) async fn read_packet(&mut self) -> Result<PooledBuf> {
        loop {
            let packet = crate::io::ReadPacket::new(&mut *self)
                .await
                .map_err(|io_err| {
                    self.inner.stream.take();
                    self.inner.disconnected = true;
                    Error::from(io_err)
                })?;
            if self.handle_packet(&packet)? {
                // ignore progress report
                continue;
            } else {
                return Ok(packet);
            }
        }
    }

    /// Returns future that reads packets from a server.
    pub(crate) async fn read_packets(&mut self, n: usize) -> Result<Vec<PooledBuf>> {
        let mut packets = Vec::with_capacity(n);
        for _ in 0..n {
            packets.push(self.read_packet().await?);
        }
        Ok(packets)
    }

    pub(crate) async fn write_packet(&mut self, data: PooledBuf) -> Result<()> {
        crate::io::WritePacket::new(&mut *self, data)
            .await
            .map_err(|io_err| {
                self.inner.stream.take();
                self.inner.disconnected = true;
                From::from(io_err)
            })
    }

    /// Writes bytes to a server.
    pub(crate) async fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        let buf = crate::buffer_pool().get_with(bytes);
        self.write_packet(buf).await
    }

    /// Sends a serializable structure to a server.
    pub(crate) async fn write_struct<T: MySerialize>(&mut self, x: &T) -> Result<()> {
        let mut buf = crate::buffer_pool().get();
        x.serialize(buf.as_mut());
        self.write_packet(buf).await
    }

    /// Sends a command to a server.
    pub(crate) async fn write_command<T: MySerialize>(&mut self, cmd: &T) -> Result<()> {
        self.clean_dirty().await?;
        self.reset_seq_id();
        self.write_struct(cmd).await
    }

    /// Returns future that sends full command body to a server.
    pub(crate) async fn write_command_raw(&mut self, body: PooledBuf) -> Result<()> {
        debug_assert!(!body.is_empty());
        self.clean_dirty().await?;
        self.reset_seq_id();
        self.write_packet(body).await
    }

    /// Returns future that writes command to a server.
    pub(crate) async fn write_command_data<T>(&mut self, cmd: Command, cmd_data: T) -> Result<()>
    where
        T: AsRef<[u8]>,
    {
        let cmd_data = cmd_data.as_ref();
        let mut buf = crate::buffer_pool().get();
        let body = buf.as_mut();
        body.push(cmd as u8);
        body.extend_from_slice(cmd_data);
        self.write_command_raw(buf).await
    }

    async fn run_init_commands(&mut self) -> Result<()> {
        if let Some(callback) = self.inner.opts.after_connect() {
            callback(self).await?;
        }

        let mut init = self.inner.opts.init().to_vec();

        while let Some(query) = init.pop() {
            self.query_drop(query).await?;
        }

        Ok(())
    }

    async fn run_setup_commands(&mut self) -> Result<()> {
        let mut setup = self.inner.opts.setup().to_vec();

        while let Some(query) = setup.pop() {
            self.query_drop(query).await?;
        }

        if let Some(callback) = self.inner.opts.setup_callback() {
            callback(self).await?;
        }

        Ok(())
    }

    /// Returns a future that resolves to [`Conn`].
    pub fn new<T: Into<Opts>>(opts: T) -> crate::BoxFuture<'static, Conn> {
        let opts = opts.into();
        async move {
            let mut conn = Conn::empty(opts.clone());

            let stream = if let Some(_path) = opts.socket() {
                #[cfg(unix)]
                {
                    Stream::connect_socket(_path.to_owned()).await?
                }
                #[cfg(not(unix))]
                return Err(crate::DriverError::NamedPipesDisabled.into());
            } else {
                let keepalive = opts.tcp_keepalive();
                Stream::connect_tcp(opts.hostport_or_url(), keepalive).await?
            };

            conn.inner.stream = Some(stream);
            conn.setup_stream()?;
            conn.handle_handshake().await?;
            conn.switch_to_ssl_if_needed().await?;
            let (context, procedure, response) = conn.do_handshake_response().await?;
            conn.continue_auth(false, context, procedure, response)
                .await?;
            conn.switch_to_compression()?;
            conn.read_settings().await?;
            conn.reconnect_via_socket_if_needed().await?;
            conn.run_init_commands().await?;
            conn.run_setup_commands().await?;

            Ok(conn)
        }
        .boxed()
    }

    /// Returns a future that resolves to [`Conn`].
    pub async fn from_url<T: AsRef<str>>(url: T) -> Result<Conn> {
        Conn::new(Opts::from_str(url.as_ref())?).await
    }

    /// Will try to reconnect via socket using socket address in `self.inner.socket`.
    ///
    /// Won't try to reconnect if socket connection is already enforced in [`Opts`].
    async fn reconnect_via_socket_if_needed(&mut self) -> Result<()> {
        if let Some(socket) = self.inner.socket.as_ref() {
            let opts = self.inner.opts.clone();
            if opts.socket().is_none() {
                let opts = OptsBuilder::from_opts(opts).socket(Some(&**socket));
                if let Ok(conn) = Conn::new(opts).await {
                    let old_conn = std::mem::replace(self, conn);
                    // tidy up the old connection
                    old_conn.close_conn().await?;
                }
            }
        }
        Ok(())
    }

    /// Configures the connection based on server settings. In particular:
    ///
    /// * It reads and stores socket address inside the connection unless if socket address is
    ///   already in [`Opts`] or if `prefer_socket` is `false`.
    ///
    /// * It reads and stores `max_allowed_packet` in the connection unless it's already in [`Opts`]
    ///
    /// * It reads and stores `wait_timeout` in the connection unless it's already in [`Opts`]
    ///
    async fn read_settings(&mut self) -> Result<()> {
        enum Action {
            Load(Cfg),
            Apply(CfgData),
        }

        enum CfgData {
            MaxAllowedPacket(usize),
            WaitTimeout(usize),
        }

        impl CfgData {
            fn apply(&self, conn: &mut Conn) {
                match self {
                    Self::MaxAllowedPacket(value) => {
                        if let Some(stream) = conn.inner.stream.as_mut() {
                            stream.set_max_allowed_packet(*value);
                        }
                    }
                    Self::WaitTimeout(value) => {
                        conn.inner.wait_timeout = Duration::from_secs(*value as u64);
                    }
                }
            }
        }

        enum Cfg {
            Socket,
            MaxAllowedPacket,
            WaitTimeout,
        }

        impl Cfg {
            const fn name(&self) -> &'static str {
                match self {
                    Self::Socket => "@@socket",
                    Self::MaxAllowedPacket => "@@max_allowed_packet",
                    Self::WaitTimeout => "@@wait_timeout",
                }
            }

            fn apply(&self, conn: &mut Conn, value: Option<crate::Value>) {
                match self {
                    Cfg::Socket => {
                        conn.inner.socket = value.and_then(crate::from_value);
                    }
                    Cfg::MaxAllowedPacket => {
                        if let Some(stream) = conn.inner.stream.as_mut() {
                            stream.set_max_allowed_packet(
                                value
                                    .and_then(crate::from_value)
                                    .unwrap_or(DEFAULT_MAX_ALLOWED_PACKET),
                            );
                        }
                    }
                    Cfg::WaitTimeout => {
                        conn.inner.wait_timeout = Duration::from_secs(
                            value
                                .and_then(crate::from_value)
                                .unwrap_or(DEFAULT_WAIT_TIMEOUT) as u64,
                        );
                    }
                }
            }
        }

        let mut actions = vec![
            if let Some(x) = self.opts().max_allowed_packet() {
                Action::Apply(CfgData::MaxAllowedPacket(x))
            } else {
                Action::Load(Cfg::MaxAllowedPacket)
            },
            if let Some(x) = self.opts().wait_timeout() {
                Action::Apply(CfgData::WaitTimeout(x))
            } else {
                Action::Load(Cfg::WaitTimeout)
            },
        ];

        if self.inner.opts.prefer_socket() && self.inner.socket.is_none() {
            actions.push(Action::Load(Cfg::Socket))
        }

        let loads = actions
            .iter()
            .filter_map(|x| match x {
                Action::Load(x) => Some(x),
                Action::Apply(_) => None,
            })
            .collect::<Vec<_>>();

        let loaded = if !loads.is_empty() {
            let query = loads
                .iter()
                .zip(std::iter::once(' ').chain(std::iter::repeat(',')))
                .fold("SELECT".to_owned(), |mut acc, (cfg, prefix)| {
                    acc.push(prefix);
                    acc.push_str(cfg.name());
                    acc
                });

            self.query_internal::<Row, String>(query)
                .await?
                .map(|row| row.unwrap())
                .unwrap_or_else(|| vec![crate::Value::NULL; loads.len()])
        } else {
            vec![]
        };
        let mut loaded = loaded.into_iter();

        for action in actions {
            match action {
                Action::Load(cfg) => cfg.apply(self, loaded.next()),
                Action::Apply(cfg) => cfg.apply(self),
            }
        }

        Ok(())
    }

    /// Returns true if time since last IO exceeds `wait_timeout`
    /// (or `conn_ttl` if specified in opts).
    fn expired(&self) -> bool {
        if let Some(deadline) = self.inner.ttl_deadline {
            if Instant::now() > deadline {
                return true;
            }
        }
        let ttl = self
            .inner
            .opts
            .conn_ttl()
            .unwrap_or(self.inner.wait_timeout);
        !ttl.is_zero() && self.idling() > ttl
    }

    /// Returns duration since last IO.
    fn idling(&self) -> Duration {
        self.inner.last_io.elapsed()
    }

    /// Executes [`COM_RESET_CONNECTION`][1].
    ///
    /// Returns `false` if command is not supported (requires MySql >5.7.2, MariaDb >10.2.3).
    /// For older versions consider using [`Conn::change_user`].
    ///
    /// [1]: https://dev.mysql.com/doc/c-api/5.7/en/mysql-reset-connection.html
    pub async fn reset(&mut self) -> Result<bool> {
        let supports_com_reset_connection = if self.inner.is_mariadb {
            self.inner.version >= (10, 2, 4)
        } else {
            // assuming mysql
            self.inner.version > (5, 7, 2)
        };

        if supports_com_reset_connection {
            self.routine(routines::ResetRoutine).await?;
            self.inner.stmt_cache.clear();
            self.inner.infile_handler = None;
            self.run_setup_commands().await?;
        }

        Ok(supports_com_reset_connection)
    }

    /// Executes [`COM_CHANGE_USER`][1].
    ///
    /// This might be used as an older and slower alternative to `COM_RESET_CONNECTION` that
    /// works on MySql prior to 5.7.3 (MariaDb prior ot 10.2.4).
    ///
    /// ## Note
    ///
    /// * Using non-default `opts` for a pooled connection is discouraging.
    /// * Connection options will be permanently updated.
    ///
    /// [1]: https://dev.mysql.com/doc/c-api/5.7/en/mysql-change-user.html
    pub async fn change_user(&mut self, opts: ChangeUserOpts) -> Result<()> {
        // We'll kick this connection from a pool if opts are changed.
        if opts != ChangeUserOpts::default() {
            let mut opts_changed = false;
            if let Some(user) = opts.user() {
                opts_changed |= user != self.opts().user()
            };
            if let Some(pass) = opts.pass() {
                opts_changed |= pass != self.opts().pass()
            };
            if let Some(db_name) = opts.db_name() {
                opts_changed |= db_name != self.opts().db_name()
            };
            if opts_changed {
                if let Some(pool) = self.inner.pool.take() {
                    pool.cancel_connection();
                }
            }
        }

        let conn_opts = &mut self.inner.opts;
        opts.update_opts(conn_opts);
        self.routine(routines::ChangeUser).await?;
        self.inner.stmt_cache.clear();
        self.inner.infile_handler = None;
        self.run_setup_commands().await?;
        Ok(())
    }

    /// Resets the connection upon returning it to a pool.
    ///
    /// Will invoke `COM_CHANGE_USER` if `COM_RESET_CONNECTION` is not supported.
    async fn reset_for_pool(mut self) -> Result<Self> {
        if !self.reset().await? {
            self.change_user(Default::default()).await?;
        }
        Ok(self)
    }

    /// Requires that `self.inner.tx_status != TxStatus::None`
    pub(crate) async fn rollback_transaction(&mut self) -> Result<()> {
        debug_assert_ne!(self.inner.tx_status, TxStatus::None);
        let tx_status = mem::replace(&mut self.inner.tx_status, TxStatus::None);
        if let Err(e) = self.query_drop("ROLLBACK").await {
            // Reset tx_status if ROLLBACK fails so that the connection is considered dirty
            self.inner.tx_status = tx_status;
            return Err(e);
        }
        Ok(())
    }

    /// Returns `true` if `SERVER_MORE_RESULTS_EXISTS` flag is contained
    /// in status flags of the connection.
    pub(crate) fn more_results_exists(&self) -> bool {
        self.status()
            .contains(StatusFlags::SERVER_MORE_RESULTS_EXISTS)
    }

    /// The purpose of this function is to cleanup a pending result set
    /// for prematurely dropped connection or query result.
    ///
    /// Requires that there are no other references to the pending result.
    pub(crate) async fn drop_result(&mut self) -> Result<()> {
        // Map everything into `PendingResult::Pending`
        let meta = match self.set_pending_result(None)? {
            Some(PendingResult::Pending(meta)) => Some(meta),
            Some(PendingResult::Taken(meta)) => {
                // This also asserts that there is only one reference left to the taken ResultSetMeta,
                // therefore this result set must be dropped here since it won't be dropped anywhere else.
                Some(Arc::try_unwrap(meta).expect("Conn::drop_result call on a pending result that may still be dropped by someone else"))
            }
            None => None,
        };

        let _ = self.set_pending_result(meta);

        match self.use_pending_result() {
            Ok(Some(PendingResult::Pending(ResultSetMeta::Text(_)))) => {
                QueryResult::<'_, '_, TextProtocol>::new(self)
                    .drop_result()
                    .await
            }
            Ok(Some(PendingResult::Pending(ResultSetMeta::Binary(_)))) => {
                QueryResult::<'_, '_, BinaryProtocol>::new(self)
                    .drop_result()
                    .await
            }
            Ok(None) => Ok((/* this case does not require an action */)),
            Ok(Some(PendingResult::Taken(_))) | Err(_) => {
                unreachable!("this case must be handled earlier in this function")
            }
        }
    }

    /// This function will drop pending result and rollback a transaction, if needed.
    ///
    /// The purpose of this function, is to cleanup the connection while returning it to a [`Pool`].
    async fn cleanup_for_pool(mut self) -> Result<Self> {
        loop {
            if self.has_pending_result() {
                // The connection was dropped and we assume that it was dropped intentionally,
                // so we'll ignore non-fatal errors during cleanup (also there is no direct caller
                // to return this error to).
                if let Err(err) = self.drop_result().await {
                    if err.is_fatal() {
                        // This means that connection is completely broken
                        // and shouldn't return to a pool.
                        return Err(err);
                    }
                }
            } else if self.inner.tx_status != TxStatus::None {
                // If an error occurs during rollback, don't reuse the connection.
                self.rollback_transaction().await?;
            } else {
                break;
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod test {
    use bytes::Bytes;
    use futures_util::{
        stream::{self, StreamExt},
        FutureExt,
    };
    use mysql_common::constants::{MariadbCapabilities, MAX_PAYLOAD_LEN};
    use rand::RngExt as _;
    use tokio::{io::AsyncWriteExt, net::TcpListener};

    use crate::{
        from_row, params, prelude::*, test_misc::get_opts, ChangeUserOpts, Conn, Error,
        OptsBuilder, Pool, ServerError, Value, WhiteListFsHandler,
    };

    #[tokio::test]
    async fn should_return_found_rows_if_flag_is_set() -> super::Result<()> {
        let opts = get_opts().client_found_rows(true);
        let mut conn = Conn::new(opts).await.unwrap();

        "CREATE TEMPORARY TABLE mysql.found_rows (id INT PRIMARY KEY AUTO_INCREMENT, val INT)"
            .ignore(&mut conn)
            .await?;

        "INSERT INTO mysql.found_rows (val) VALUES (1)"
            .ignore(&mut conn)
            .await?;

        // Inserted one row, affected should be one.
        assert_eq!(conn.affected_rows(), 1);

        "UPDATE mysql.found_rows SET val = 1 WHERE val = 1"
            .ignore(&mut conn)
            .await?;

        // The query doesn't affect any rows, but due to us wanting FOUND rows,
        // this has to return one.
        assert_eq!(conn.affected_rows(), 1);

        Ok(())
    }

    #[tokio::test]
    async fn should_not_return_found_rows_if_flag_is_not_set() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await.unwrap();

        "CREATE TEMPORARY TABLE mysql.found_rows (id INT PRIMARY KEY AUTO_INCREMENT, val INT)"
            .ignore(&mut conn)
            .await?;

        "INSERT INTO mysql.found_rows (val) VALUES (1)"
            .ignore(&mut conn)
            .await?;

        // Inserted one row, affected should be one.
        assert_eq!(conn.affected_rows(), 1);

        "UPDATE mysql.found_rows SET val = 1 WHERE val = 1"
            .ignore(&mut conn)
            .await?;

        // The query doesn't affect any rows.
        assert_eq!(conn.affected_rows(), 0);

        Ok(())
    }

    #[test]
    fn opts_should_satisfy_send_and_sync() {
        struct A<T: Sync + Send>(T);
        #[allow(clippy::unnecessary_operation)]
        A(get_opts());
    }

    #[tokio::test]
    async fn should_connect_without_database() -> super::Result<()> {
        // no database name
        let mut conn: Conn = Conn::new(get_opts().db_name(None::<String>)).await?;
        conn.ping().await?;
        conn.disconnect().await?;

        // empty database name
        let mut conn: Conn = Conn::new(get_opts().db_name(Some(""))).await?;
        conn.ping().await?;
        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_clean_state_if_wrapper_is_dropped() -> super::Result<()> {
        let mut conn: Conn = Conn::new(get_opts()).await?;

        conn.query_drop("CREATE TEMPORARY TABLE mysql.foo (id SERIAL)")
            .await?;

        // dropped query:
        conn.query_iter("SELECT 1").await?;
        conn.ping().await?;

        // dropped query in dropped transaction:
        let mut tx = conn.start_transaction(Default::default()).await?;
        tx.query_drop("INSERT INTO mysql.foo (id) VALUES (42)")
            .await?;
        tx.exec_iter("SELECT COUNT(*) FROM mysql.foo", ()).await?;
        drop(tx);
        conn.ping().await?;

        let count: u8 = conn
            .query_first("SELECT COUNT(*) FROM mysql.foo")
            .await?
            .unwrap_or_default();

        assert_eq!(count, 0);

        Ok(())
    }

    #[tokio::test]
    async fn should_connect() -> super::Result<()> {
        let mut conn: Conn = Conn::new(get_opts()).await?;
        conn.ping().await?;
        let plugins: Vec<String> = conn
            .query_map("SHOW PLUGINS", |mut row: crate::Row| {
                row.take("Name").unwrap()
            })
            .await?;

        // Should connect with any combination of supported plugin and empty-nonempty password.
        let variants = vec![
            ("caching_sha2_password", 2_u8, "non-empty"),
            ("caching_sha2_password", 2_u8, ""),
            ("mysql_native_password", 0_u8, "non-empty"),
            ("mysql_native_password", 0_u8, ""),
        ]
        .into_iter()
        .filter(|variant| plugins.iter().any(|p| p == variant.0));

        for (plug, val, pass) in variants {
            dbg!((plug, val, pass, conn.inner.version));

            if plug == "mysql_native_password" && conn.inner.version >= (8, 4, 0) {
                continue;
            }

            let _ = conn.query_drop("DROP USER 'test_user'@'%'").await;

            let query = format!("CREATE USER 'test_user'@'%' IDENTIFIED WITH {}", plug);
            conn.query_drop(query).await.unwrap();

            if conn.inner.version < (8, 0, 11) {
                conn.query_drop(format!("SET old_passwords = {}", val))
                    .await
                    .unwrap();
                conn.query_drop(format!(
                    "SET PASSWORD FOR 'test_user'@'%' = PASSWORD('{}')",
                    pass
                ))
                .await
                .unwrap();
            } else {
                conn.query_drop(format!("SET PASSWORD FOR 'test_user'@'%' = '{}'", pass))
                    .await
                    .unwrap();
            };

            let opts = get_opts()
                .user(Some("test_user"))
                .pass(Some(pass))
                .db_name(None::<String>);
            let result = Conn::new(opts).await;

            conn.query_drop("DROP USER 'test_user'@'%'").await.unwrap();

            result?.disconnect().await?;
        }

        if crate::test_misc::test_compression() {
            assert!(format!("{:?}", conn).contains("Compression"));
        }

        if crate::test_misc::test_ssl() {
            assert!(format!("{:?}", conn).contains("Tls"));
        }

        conn.disconnect().await?;
        Ok(())
    }

    #[test]
    fn should_not_panic_if_dropped_without_tokio_runtime() {
        let fut = Conn::new(get_opts());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            fut.await.unwrap();
        });
        // connection will drop here
    }

    #[tokio::test]
    async fn should_execute_init_queries_on_new_connection() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts()).init(vec!["SET @a = 42", "SET @b = 'foo'"]);
        let mut conn = Conn::new(opts).await?;
        let result: Vec<(u8, String)> = conn.query("SELECT @a, @b").await?;
        conn.disconnect().await?;
        assert_eq!(result, vec![(42, "foo".into())]);
        Ok(())
    }

    #[tokio::test]
    async fn should_execute_after_connect_callback_on_new_connection() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts()).after_connect(|conn| {
            async move {
                conn.query_drop("SET @a = 42").await?;
                conn.query_drop("SET @b = 'foo'").await?;
                Ok(())
            }
            .boxed()
        });
        let mut conn = Conn::new(opts).await?;
        let result: Vec<(u8, String)> = conn.query("SELECT @a, @b").await?;
        conn.disconnect().await?;
        assert_eq!(result, vec![(42, "foo".into())]);
        Ok(())
    }

    #[tokio::test]
    async fn should_propagate_after_connect_callback_error() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts())
            .after_connect(|_conn| async move { Err(Error::Other("rejected".into())) }.boxed());
        let e = Conn::new(opts).await.unwrap_err();
        match e {
            Error::Other(e) => assert_eq!(e.to_string(), "rejected"),
            e => panic!("expected error from after_connect(), got {e:?}"),
        }
        Ok(())
    }

    #[tokio::test]
    async fn should_execute_setup_queries_on_reset() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts()).setup(vec!["SET @a = 42", "SET @b = 'foo'"]);
        let mut conn = Conn::new(opts).await?;

        // initial run
        let mut result: Vec<(u8, String)> = conn.query("SELECT @a, @b").await?;
        assert_eq!(result, vec![(42, "foo".into())]);

        // after reset
        if conn.reset().await? {
            result = conn.query("SELECT @a, @b").await?;
            assert_eq!(result, vec![(42, "foo".into())]);
        }

        // after change user
        conn.change_user(Default::default()).await?;
        result = conn.query("SELECT @a, @b").await?;
        assert_eq!(result, vec![(42, "foo".into())]);

        conn.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_reset_the_connection() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;

        assert_eq!(
            conn.query_first::<Value, _>("SELECT @foo").await?.unwrap(),
            Value::NULL
        );

        conn.query_drop("SET @foo = 'foo'").await?;

        assert_eq!(
            conn.query_first::<String, _>("SELECT @foo").await?.unwrap(),
            "foo",
        );

        if conn.reset().await? {
            assert_eq!(
                conn.query_first::<Value, _>("SELECT @foo").await?.unwrap(),
                Value::NULL
            );
        } else {
            assert_eq!(
                conn.query_first::<String, _>("SELECT @foo").await?.unwrap(),
                "foo",
            );
        }

        conn.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_change_user() -> super::Result<()> {
        /// Whether particular authentication plugin should be tested on the current database.
        type ShouldRunFn = fn(bool, (u16, u16, u16)) -> bool;
        /// Generates `CREATE USER` and `SET PASSWORD` statements
        type CreateUserFn = fn(bool, (u16, u16, u16), &str) -> Vec<String>;

        #[allow(clippy::type_complexity)]
        const TEST_MATRIX: [(&str, ShouldRunFn, CreateUserFn); 6] = [
            (
                "mysql_old_password",
                |is_mariadb, version| is_mariadb || version < (5, 7, 0),
                |is_mariadb, version, pass| {
                    if is_mariadb {
                        vec![
                            "CREATE USER '__mats'@'%' IDENTIFIED WITH mysql_old_password".into(),
                            "SET old_passwords=1".into(),
                            format!("ALTER USER '__mats'@'%' IDENTIFIED BY '{pass}'"),
                            "SET old_passwords=0".into(),
                        ]
                    } else if matches!(version, (5, 6, _)) {
                        vec![
                            "CREATE USER '__mats'@'%' IDENTIFIED WITH mysql_old_password".into(),
                            format!("SET PASSWORD FOR '__mats'@'%' = OLD_PASSWORD('{pass}')"),
                        ]
                    } else {
                        vec![
                            "CREATE USER '__mats'@'%'".into(),
                            format!("SET PASSWORD FOR '__mats'@'%' = PASSWORD('{pass}')"),
                        ]
                    }
                },
            ),
            (
                "mysql_native_password",
                |is_mariadb, version| is_mariadb || version < (8, 4, 0),
                |is_mariadb, version, pass| {
                    if is_mariadb {
                        vec![
                            format!("CREATE USER '__mats'@'%' IDENTIFIED WITH mysql_native_password AS PASSWORD('{pass}')")
                        ]
                    } else if version < (8, 0, 0) {
                        vec![
                            format!(
                                "CREATE USER '__mats'@'%' IDENTIFIED WITH mysql_native_password"
                            ),
                            format!("SET old_passwords = 0"),
                            format!("SET PASSWORD FOR '__mats'@'%' = PASSWORD('{pass}')"),
                        ]
                    } else {
                        vec![
                            format!("CREATE USER '__mats'@'%' IDENTIFIED WITH mysql_native_password BY '{pass}'")
                        ]
                    }
                },
            ),
            (
                "caching_sha2_password",
                |is_mariadb, version| !is_mariadb && version >= (5, 8, 0),
                |_is_mariadb, _version, pass| {
                    vec![
                        format!("CREATE USER '__mats'@'%' IDENTIFIED WITH caching_sha2_password BY '{pass}'")
                    ]
                },
            ),
            (
                "sha256_password",
                |is_mariadb, version| !is_mariadb && version >= (5, 7, 0) && version < (8, 4, 0),
                |_is_mariadb, _version, pass| {
                    vec![format!(
                        "CREATE USER '__mats'@'%' IDENTIFIED WITH sha256_password BY '{pass}'"
                    )]
                },
            ),
            (
                "client_ed25519",
                |is_mariadb, version| is_mariadb && version >= (11, 6, 2),
                |_is_mariadb, _version, pass| {
                    vec![format!(
                        "CREATE USER '__mats'@'%' IDENTIFIED WITH ed25519 AS PASSWORD('{pass}')"
                    )]
                },
            ),
            (
                "parsec",
                |is_mariadb, version| is_mariadb && version >= (11, 4, 1),
                |_is_mariadb, _version, pass| {
                    vec![format!(
                        "CREATE USER '__mats'@'%' IDENTIFIED WITH parsec AS PASSWORD('{pass}')"
                    )]
                },
            ),
        ];

        fn random_pass() -> String {
            let mut rng = rand::rng();
            let pass: [u8; 10] = rng.random();

            IntoIterator::into_iter(pass)
                .map(|x| ((x % (123 - 97)) + 97) as char)
                .collect()
        }

        let mut conn = Conn::new(get_opts()).await?;

        assert_eq!(
            conn.query_first::<Value, _>("SELECT @foo").await?.unwrap(),
            Value::NULL
        );

        conn.query_drop("SET @foo = 'foo'").await?;

        assert_eq!(
            conn.query_first::<String, _>("SELECT @foo").await?.unwrap(),
            "foo",
        );

        conn.change_user(Default::default()).await?;
        assert_eq!(
            conn.query_first::<Value, _>("SELECT @foo").await?.unwrap(),
            Value::NULL
        );

        for (i, (plugin, should_run, create_statements)) in TEST_MATRIX.iter().enumerate() {
            dbg!(plugin);
            let is_mariadb = conn.inner.is_mariadb;
            let version = conn.server_version();

            if should_run(is_mariadb, version) {
                let pass = random_pass();

                let result = conn
                    .query_drop("DROP USER /*!50700 IF EXISTS */ /*M!100103 IF EXISTS */ __mats")
                    .await;

                if matches!(version, (5, 6, _)) && i == 0 {
                    // IF EXISTS is not supported on 5.6 so the query will fail on the first iteration
                    drop(result);
                } else {
                    result.unwrap();
                }

                for statement in create_statements(is_mariadb, version, &pass) {
                    conn.query_drop(dbg!(statement)).await.unwrap();
                }

                let mut conn2 = Conn::new(get_opts().secure_auth(false)).await.unwrap();
                conn2
                    .change_user(
                        ChangeUserOpts::default()
                            .with_db_name(None)
                            .with_user(Some("__mats".into()))
                            .with_pass(Some(pass)),
                    )
                    .await
                    .unwrap();

                let (db, user) = conn2
                    .query_first::<(Option<String>, String), _>("SELECT DATABASE(), USER();")
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(db, None);
                assert!(user.starts_with("__mats"));

                conn2.disconnect().await.unwrap();
            }
        }

        Ok(())
    }

    // Test for exec_batch method.
    #[tokio::test]
    async fn test_exec_batch() {
        let mut conn = Conn::new(get_opts()).await.unwrap();

        conn.query_drop(
            "CREATE TEMPORARY TABLE t_exec_batch (\
                    id INT NOT NULL PRIMARY KEY,\
                    val VARCHAR(32),\
                    num BIGINT UNSIGNED)",
        )
        .await
        .unwrap();

        // Populating table with some data to verify that data still fetched correctly with cached metadata use
        let insert_stmt = "INSERT INTO t_exec_batch (id,val,num) VALUES (?,?,?)";

        let params = [
            (1, Some("First"), None),
            (3, None, Some(1)),
            (4, Some("Third"), Some(u64::MAX)),
        ];

        conn.exec_batch(insert_stmt, params.iter().copied())
            .await
            .unwrap();

        conn.exec_batch(insert_stmt, [(8, None::<String>, None::<u64>)])
            .await
            .unwrap();

        let fetched_rows: Vec<(i32, Option<String>, Option<u64>)> = conn
            .query_iter("SELECT id, val, num FROM t_exec_batch")
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let expected_rows: Vec<(i32, Option<String>, Option<u64>)> = vec![
            (1, Some("First".to_string()), None),
            (3, None, Some(1)),
            (4, Some("Third".to_string()), Some(u64::MAX)),
            (8, None, None),
        ];
        assert_eq!(fetched_rows, expected_rows);

        if conn.has_mariadb_capabilities(MariadbCapabilities::MARIADB_CLIENT_STMT_BULK_OPERATIONS) {
            let select_stmt = "SELECT ?";
            let err = conn
                .exec_batch(select_stmt, [(1_u64,), (2_u64,), (3_u64,)])
                .await
                .unwrap_err();
            assert!(matches!(err, crate::Error::Server(e) if e.code == 1295));
        }
    }

    #[tokio::test]
    async fn test_exec_batch_large() {
        const CLIENT_MAX_PACKET_SIZE: usize = 1024; // 1K
        let opts = get_opts().max_allowed_packet(Some(CLIENT_MAX_PACKET_SIZE));
        let mut conn = Conn::new(opts).await.unwrap();
        conn.query_drop(
            "CREATE TEMPORARY TABLE t_large_batch (id BIGINT NOT NULL PRIMARY KEY,
                val VARCHAR(1024) NOT NULL)",
        )
        .await
        .unwrap();

        // Calculate a row size that will make the total packet size > max_allowed_packet
        // Packet will have 4 byte header and 7 bytes COM_STMT_BULK_EXECUTE fields + 4 bytes for parameter types
        // 8 bytes per row for id + 2 bytes for indicators + 3 bytes for length encoding of val.
        let num_rows = 3;
        let row_chunk_size = CLIENT_MAX_PACKET_SIZE / num_rows;
        let mut row_data_1 = "a".repeat(row_chunk_size);
        let row_data_2 = "b".repeat(row_chunk_size);
        let row_data_3 = "c".repeat(row_chunk_size);

        let evaluated_packet_len = 4 + 7 + 4 + (1 + 8 + 1 + 3 + row_chunk_size * num_rows);

        assert!(
            evaluated_packet_len > CLIENT_MAX_PACKET_SIZE,
            "Data size must be greater than max packet size"
        );

        let params: Vec<(u64, &str)> = vec![
            (1, &row_data_1[..]),
            (7, &row_data_2[..]),
            (22, &row_data_3[..]),
        ];

        let query = "INSERT INTO t_large_batch (id, val) VALUES (?,?)";
        conn.exec_batch(query, params)
            .await
            .expect("Batch execution should succeed");

        // MySql compression does not respect max_allowed_packet, so we're going to query
        // one by one
        let mut inserted_rows: Vec<(u64, String)> = vec![];
        inserted_rows.extend(
            conn.query("SELECT id, val FROM t_large_batch ORDER BY id LIMIT 1 OFFSET 0")
                .await
                .unwrap(),
        );
        inserted_rows.extend(
            conn.query("SELECT id, val FROM t_large_batch ORDER BY id LIMIT 1 OFFSET 1")
                .await
                .unwrap(),
        );
        inserted_rows.extend(
            conn.query("SELECT id, val FROM t_large_batch ORDER BY id LIMIT 65536 OFFSET 2")
                .await
                .unwrap(),
        );

        assert_eq!(
            inserted_rows.len(),
            num_rows,
            "The number of inserted rows ({}) does not match the expected number ({})",
            inserted_rows.len(),
            num_rows
        );

        assert_eq!(inserted_rows[0], (1, row_data_1));
        assert_eq!(inserted_rows[1], (7, row_data_2));
        assert_eq!(inserted_rows[2], (22, row_data_3));

        // Some corner cases: single row exceeding max_allowed_packet and
        // empty batch
        row_data_1 = "x".repeat(CLIENT_MAX_PACKET_SIZE);
        let params: Vec<(u64, &str)> = vec![(33, &row_data_1[..])];
        let result = conn.exec_batch(query, params).await;
        assert!(
            result.is_err(),
            "Batch execution should fail due to packet size exceeding max_allowed_packet"
        );
    }

    #[tokio::test]
    async fn test_exec_batch_no_params() -> crate::Result<()> {
        let mut conn = Conn::new(get_opts()).await.unwrap();
        conn.query_drop("CREATE TEMPORARY TABLE t_counter (counter INTEGER NOT NULL)")
            .await
            .unwrap();
        conn.query_drop("INSERT INTO t_counter (counter) VALUES (0)")
            .await
            .unwrap();

        const COUNT: usize = 10;
        conn.exec_batch("UPDATE t_counter SET counter = counter+1", vec![(); COUNT])
            .await
            .expect("Batch execution should succeed");
        let rows: Vec<(usize,)> = conn.query("SELECT counter FROM t_counter").await.unwrap();
        assert_eq!(rows, vec![(COUNT,)]);
        Ok(())
    }

    #[tokio::test]
    async fn should_not_cache_statements_if_stmt_cache_size_is_zero() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts()).stmt_cache_size(0);

        let mut conn = Conn::new(opts).await?;
        conn.exec_drop("DO ?", (1_u8,)).await?;

        let stmt = conn.prep("DO 2").await?;
        conn.exec_drop(&stmt, ()).await?;
        conn.exec_drop(&stmt, ()).await?;
        conn.close(stmt).await?;

        conn.exec_drop("DO 3", ()).await?;
        conn.exec_batch("DO 4", vec![(), ()]).await?;
        conn.exec_first::<u8, _, _>("DO 5", ()).await?;
        let row: Option<(crate::Value, usize)> = conn
            .query_first("SHOW SESSION STATUS LIKE 'Com_stmt_close';")
            .await?;

        assert_eq!(row.unwrap().1, 1);
        assert_eq!(conn.inner.stmt_cache.len(), 0);

        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_hold_stmt_cache_size_bound() -> super::Result<()> {
        let opts = OptsBuilder::from_opts(get_opts()).stmt_cache_size(3);
        let mut conn = Conn::new(opts).await?;
        conn.exec_drop("DO 1", ()).await?;
        conn.exec_drop("DO 2", ()).await?;
        conn.exec_drop("DO 3", ()).await?;
        conn.exec_drop("DO 1", ()).await?;
        conn.exec_drop("DO 4", ()).await?;
        conn.exec_drop("DO 3", ()).await?;
        conn.exec_drop("DO 5", ()).await?;
        conn.exec_drop("DO 6", ()).await?;
        let row_opt = conn
            .query_first("SHOW SESSION STATUS LIKE 'Com_stmt_close';")
            .await?;
        let (_, count): (String, usize) = row_opt.unwrap();
        assert_eq!(count, 3);
        let order = conn
            .stmt_cache_ref()
            .iter()
            .map(|item| item.1.query.0.as_ref())
            .collect::<Vec<&[u8]>>();
        assert_eq!(order, &[b"DO 6", b"DO 5", b"DO 3"]);
        conn.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_perform_queries() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        for x in (MAX_PAYLOAD_LEN - 2)..=(MAX_PAYLOAD_LEN + 2) {
            let long_string = "A".repeat(x);
            let result: Vec<(String, u8)> = conn
                .query(format!(r"SELECT '{}', 231", long_string))
                .await?;
            assert_eq!((long_string, 231_u8), result[0]);
        }
        conn.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_query_drop() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        conn.query_drop("CREATE TEMPORARY TABLE tmp (id int DEFAULT 10, name text)")
            .await?;
        conn.query_drop("INSERT INTO tmp VALUES (1, 'foo')").await?;
        let result: Option<u8> = conn.query_first("SELECT COUNT(*) FROM tmp").await?;
        conn.disconnect().await?;
        assert_eq!(result, Some(1_u8));
        Ok(())
    }

    #[tokio::test]
    async fn should_prepare_statement() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        let stmt = conn.prep(r"SELECT ?").await?;
        conn.close(stmt).await?;
        conn.disconnect().await?;

        let mut conn = Conn::new(get_opts()).await?;
        let stmt = conn.prep(r"SELECT :foo").await?;

        {
            let query = String::from("SELECT ?, ?");
            let stmt = conn.prep(&*query).await?;
            conn.close(stmt).await?;
            {
                let mut conn = Conn::new(get_opts()).await?;
                let stmt = conn.prep(&*query).await?;
                conn.close(stmt).await?;
                conn.disconnect().await?;
            }
        }

        conn.close(stmt).await?;
        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_execute_statement() -> super::Result<()> {
        let long_string = "A".repeat(18 * 1024 * 1024);
        let mut conn = Conn::new(get_opts()).await?;
        let stmt = conn.prep(r"SELECT ?").await?;
        let result = conn.exec_iter(&stmt, (&long_string,)).await?;
        let mut mapped = result.map_and_drop(from_row::<(String,)>).await?;
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped.pop(), Some((long_string,)));
        let result = conn.exec_iter(&stmt, (42_u8,)).await?;
        let collected = result.collect_and_drop::<(u8,)>().await?;
        assert_eq!(collected, vec![(42u8,)]);
        let result = conn.exec_iter(&stmt, (8_u8,)).await?;
        let reduced = result
            .reduce_and_drop(2, |mut acc, row| {
                acc += from_row::<i32>(row);
                acc
            })
            .await?;
        conn.close(stmt).await?;
        conn.disconnect().await?;
        assert_eq!(reduced, 10);

        let mut conn = Conn::new(get_opts()).await?;
        let stmt = conn.prep(r"SELECT :foo, :bar, :foo, 3").await?;
        let result = conn
            .exec_iter(&stmt, params! { "foo" => "quux", "bar" => "baz" })
            .await?;
        let mut mapped = result
            .map_and_drop(from_row::<(String, String, String, u8)>)
            .await?;
        assert_eq!(mapped.len(), 1);
        assert_eq!(
            mapped.pop(),
            Some(("quux".into(), "baz".into(), "quux".into(), 3))
        );
        let result = conn
            .exec_iter(&stmt, params! { "foo" => 2, "bar" => 3 })
            .await?;
        let collected = result.collect_and_drop::<(u8, u8, u8, u8)>().await?;
        assert_eq!(collected, vec![(2, 3, 2, 3)]);
        let result = conn
            .exec_iter(&stmt, params! { "foo" => 2, "bar" => 3 })
            .await?;
        let reduced = result
            .reduce_and_drop(0, |acc, row| {
                let (a, b, c, d): (u8, u8, u8, u8) = from_row(row);
                acc + a + b + c + d
            })
            .await?;
        conn.close(stmt).await?;
        conn.disconnect().await?;
        assert_eq!(reduced, 10);
        Ok(())
    }

    #[tokio::test]
    async fn should_prep_exec_statement() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        let result = conn
            .exec_iter(r"SELECT :a, :b, :a", params! { "a" => 2, "b" => 3 })
            .await?;
        let output = result
            .map_and_drop(|row| {
                let (a, b, c): (u8, u8, u8) = from_row(row);
                a * b * c
            })
            .await?;
        conn.disconnect().await?;
        assert_eq!(output[0], 12u8);
        Ok(())
    }

    #[tokio::test]
    async fn should_first_exec_statement() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        let output = conn
            .exec_first(
                r"SELECT :a UNION ALL SELECT :b",
                params! { "a" => 2, "b" => 3 },
            )
            .await?;
        conn.disconnect().await?;
        assert_eq!(output, Some(2u8));
        Ok(())
    }

    #[tokio::test]
    async fn issue_107() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        conn.query_drop(
            r"CREATE TEMPORARY TABLE mysql.issue (
                    a BIGINT(20) UNSIGNED,
                    b VARBINARY(16),
                    c BINARY(32),
                    d BIGINT(20) UNSIGNED,
                    e BINARY(32)
                )",
        )
        .await?;
        conn.query_drop(
            r"INSERT INTO mysql.issue VALUES (
                    0,
                    0xC066F966B0860000,
                    0x7939DA98E524C5F969FC2DE8D905FD9501EBC6F20001B0A9C941E0BE6D50CF44,
                    0,
                    ''
                ), (
                    1,
                    '',
                    0x076311DF4D407B0854371BA13A5F3FB1A4555AC22B361375FD47B263F31822F2,
                    0,
                    ''
                )",
        )
        .await?;

        let q = "SELECT b, c, d, e FROM mysql.issue";
        let result = conn.query_iter(q).await?;

        let loaded_structs = result
            .map_and_drop(crate::from_row::<(Vec<u8>, Vec<u8>, u64, Vec<u8>)>)
            .await?;

        conn.disconnect().await?;

        assert_eq!(loaded_structs.len(), 2);

        Ok(())
    }

    #[tokio::test]
    async fn should_run_transactions() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await?;
        conn.query_drop("CREATE TEMPORARY TABLE tmp (id INT, name TEXT)")
            .await?;
        let mut transaction = conn.start_transaction(Default::default()).await?;
        transaction
            .query_drop("INSERT INTO tmp VALUES (1, 'foo'), (2, 'bar')")
            .await?;
        assert_eq!(transaction.last_insert_id(), None);
        assert_eq!(transaction.affected_rows(), 2);
        assert_eq!(transaction.get_warnings(), 0);
        assert_eq!(transaction.info(), "Records: 2  Duplicates: 0  Warnings: 0");
        transaction.commit().await?;
        let output_opt = conn.query_first("SELECT COUNT(*) FROM tmp").await?;
        assert_eq!(output_opt, Some((2u8,)));
        let mut transaction = conn.start_transaction(Default::default()).await?;
        transaction
            .query_drop("INSERT INTO tmp VALUES (3, 'baz'), (4, 'quux')")
            .await?;
        let output_opt = transaction
            .exec_first("SELECT COUNT(*) FROM tmp", ())
            .await?;
        assert_eq!(output_opt, Some((4u8,)));
        transaction.rollback().await?;
        let output_opt = conn.query_first("SELECT COUNT(*) FROM tmp").await?;
        assert_eq!(output_opt, Some((2u8,)));

        let mut transaction = conn.start_transaction(Default::default()).await?;
        transaction
            .query_drop("INSERT INTO tmp VALUES (3, 'baz')")
            .await?;
        drop(transaction); // implicit rollback
        let output_opt = conn.query_first("SELECT COUNT(*) FROM tmp").await?;
        assert_eq!(output_opt, Some((2u8,)));

        conn.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_handle_multiresult_set_with_error() -> super::Result<()> {
        const QUERY_FIRST: &str = "SELECT * FROM tmp; SELECT 1; SELECT 2;";
        const QUERY_MIDDLE: &str = "SELECT 1; SELECT * FROM tmp; SELECT 2";
        let mut conn = Conn::new(get_opts()).await.unwrap();

        // if error is in the first result set, then query should return it immediately.
        let result = QUERY_FIRST.run(&mut conn).await;
        assert!(matches!(result, Err(Error::Server(_))));

        let mut result = QUERY_MIDDLE.run(&mut conn).await.unwrap();

        // first result set will contain one row
        let result_set: Vec<u8> = result.collect().await.unwrap();
        assert_eq!(result_set, vec![1]);

        // second result set will contain an error.
        let result_set: super::Result<Vec<u8>> = result.collect().await;
        assert!(matches!(result_set, Err(Error::Server(_))));

        // there will be no third result set
        assert!(result.is_empty());

        conn.ping().await?;
        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_handle_binary_multiresult_set_with_error() -> super::Result<()> {
        const PROC_DEF_FIRST: &str =
            r#"CREATE PROCEDURE err_first() BEGIN SELECT * FROM tmp; SELECT 1; END"#;
        const PROC_DEF_MIDDLE: &str =
            r#"CREATE PROCEDURE err_middle() BEGIN SELECT 1; SELECT * FROM tmp; SELECT 2; END"#;

        let mut conn = Conn::new(get_opts()).await.unwrap();

        conn.query_drop("DROP PROCEDURE IF EXISTS err_first")
            .await?;
        conn.query_iter(PROC_DEF_FIRST).await?;

        conn.query_drop("DROP PROCEDURE IF EXISTS err_middle")
            .await?;
        conn.query_iter(PROC_DEF_MIDDLE).await?;

        // if error is in the first result set, then query should return it immediately.
        let result = conn.query_iter("CALL err_first()").await;
        assert!(matches!(result, Err(Error::Server(_))));

        let mut result = conn.query_iter("CALL err_middle()").await?;

        // first result set will contain one row
        let result_set: Vec<u8> = result.collect().await.unwrap();
        assert_eq!(result_set, vec![1]);

        // second result set will contain an error.
        let result_set: super::Result<Vec<u8>> = result.collect().await;
        assert!(matches!(result_set, Err(Error::Server(_))));

        // there will be no third result set
        assert!(result.is_empty());

        conn.ping().await?;
        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_handle_multiresult_set_with_local_infile() -> super::Result<()> {
        use std::fs::write;

        let file_path = tempfile::Builder::new().tempfile_in("").unwrap();
        let file_path = file_path.path();
        let file_name = file_path.file_name().unwrap();

        write(file_name, b"AAAAAA\nBBBBBB\nCCCCCC\n")?;

        let opts = get_opts().local_infile_handler(Some(WhiteListFsHandler::new(&[file_name][..])));

        // LOCAL INFILE in the middle of a multi-result set should not break anything.
        let mut conn = Conn::new(opts).await.unwrap();
        "CREATE TEMPORARY TABLE tmp (a TEXT)".run(&mut conn).await?;

        let query = format!(
            r#"SELECT * FROM tmp;
            LOAD DATA LOCAL INFILE "{}" INTO TABLE tmp;
            LOAD DATA LOCAL INFILE "{}" INTO TABLE tmp;
            SELECT * FROM tmp"#,
            file_name.to_str().unwrap(),
            file_name.to_str().unwrap(),
        );

        let mut result = query.run(&mut conn).await?;

        let result_set = result.collect::<String>().await?;
        assert_eq!(result_set.len(), 0);

        let mut no_local_infile = false;

        for _ in 0..2 {
            match result.collect::<String>().await {
                Ok(result_set) => {
                    assert_eq!(result.affected_rows(), 3);
                    assert!(result_set.is_empty())
                }
                Err(Error::Server(ref err)) if err.code == 1148 => {
                    // The used command is not allowed with this MySQL version
                    no_local_infile = true;
                    break;
                }
                Err(Error::Server(ref err)) if err.code == 3948 => {
                    // Loading local data is disabled;
                    // this must be enabled on both the client and server sides
                    no_local_infile = true;
                    break;
                }
                Err(err) => return Err(err),
            }
        }

        if no_local_infile {
            assert!(result.is_empty());
            assert_eq!(result_set.len(), 0);
        } else {
            let result_set = result.collect::<String>().await?;
            assert_eq!(result_set.len(), 6);
            assert_eq!(result_set[0], "AAAAAA");
            assert_eq!(result_set[1], "BBBBBB");
            assert_eq!(result_set[2], "CCCCCC");
            assert_eq!(result_set[3], "AAAAAA");
            assert_eq!(result_set[4], "BBBBBB");
            assert_eq!(result_set[5], "CCCCCC");
        }

        conn.ping().await?;
        conn.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_provide_multiresult_set_metadata() -> super::Result<()> {
        let mut c = Conn::new(get_opts()).await?;
        c.query_drop("CREATE TEMPORARY TABLE tmp (id INT, foo TEXT)")
            .await?;

        let mut result = c
            .query_iter("SELECT 1; SELECT id, foo FROM tmp WHERE 1 = 2; DO 42; SELECT 2;")
            .await?;
        assert_eq!(result.columns().map(|x| x.len()).unwrap_or_default(), 1);

        result.for_each(drop).await?;
        assert_eq!(result.columns().map(|x| x.len()).unwrap_or_default(), 2);

        result.for_each(drop).await?;
        assert_eq!(result.columns().map(|x| x.len()).unwrap_or_default(), 0);

        result.for_each(drop).await?;
        assert_eq!(result.columns().map(|x| x.len()).unwrap_or_default(), 1);

        c.disconnect().await?;
        Ok(())
    }

    #[tokio::test]
    async fn should_expose_query_result_metadata() -> super::Result<()> {
        let pool = Pool::new(get_opts());
        let mut c = pool.get_conn().await?;

        c.query_drop(
            r"
            CREATE TEMPORARY TABLE `foo`
                ( `id` SERIAL
                , `bar_id` varchar(36) NOT NULL
                , `baz_id` varchar(36) NOT NULL
                , `ctime` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP()
                , PRIMARY KEY (`id`)
                , KEY `bar_idx` (`bar_id`)
                , KEY `baz_idx` (`baz_id`)
            );",
        )
        .await?;

        const QUERY: &str = "INSERT INTO foo (bar_id, baz_id) VALUES (?, ?)";
        let params = ("qwerty", "data.employee_id");

        let query_result = c.exec_iter(QUERY, params).await?;
        assert_eq!(query_result.last_insert_id(), Some(1));
        query_result.drop_result().await?;

        c.exec_drop(QUERY, params).await?;
        assert_eq!(c.last_insert_id(), Some(2));

        let mut tx = c.start_transaction(Default::default()).await?;

        tx.exec_drop(QUERY, params).await?;
        assert_eq!(tx.last_insert_id(), Some(3));

        Ok(())
    }

    #[tokio::test]
    async fn should_handle_local_infile_locally() -> super::Result<()> {
        let mut conn = Conn::new(get_opts()).await.unwrap();
        conn.query_drop("CREATE TEMPORARY TABLE tmp (a TEXT);")
            .await
            .unwrap();

        conn.set_infile_handler(async move {
            Ok(
                stream::iter([Bytes::from("AAAAAA\n"), Bytes::from("BBBBBB\nCCCCCC\n")])
                    .map(Ok)
                    .boxed(),
            )
        });

        match conn
            .query_drop(r#"LOAD DATA LOCAL INFILE "dummy" INTO TABLE tmp;"#)
            .await
        {
            Ok(_) => (),
            Err(super::Error::Server(ref err)) if err.code == 1148 => {
                // The used command is not allowed with this MySQL version
                return Ok(());
            }
            Err(super::Error::Server(ref err)) if err.code == 3948 => {
                // Loading local data is disabled;
                // this must be enabled on both the client and server sides
                return Ok(());
            }
            e @ Err(_) => e.unwrap(),
        };

        let result: Vec<String> = conn.query("SELECT * FROM tmp").await?;
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], "AAAAAA");
        assert_eq!(result[1], "BBBBBB");
        assert_eq!(result[2], "CCCCCC");

        Ok(())
    }

    #[tokio::test]
    async fn should_handle_local_infile_globally() -> super::Result<()> {
        use std::fs::write;

        let file_path = tempfile::Builder::new().tempfile_in("").unwrap();
        let file_path = file_path.path();
        let file_name = file_path.file_name().unwrap();

        write(file_name, b"AAAAAA\nBBBBBB\nCCCCCC\n")?;

        let opts = get_opts().local_infile_handler(Some(WhiteListFsHandler::new(&[file_name][..])));

        let mut conn = Conn::new(opts).await.unwrap();
        conn.query_drop("CREATE TEMPORARY TABLE tmp (a TEXT);")
            .await
            .unwrap();

        match conn
            .query_drop(format!(
                r#"LOAD DATA LOCAL INFILE "{}" INTO TABLE tmp;"#,
                file_name.to_str().unwrap(),
            ))
            .await
        {
            Ok(_) => (),
            Err(super::Error::Server(ref err)) if err.code == 1148 => {
                // The used command is not allowed with this MySQL version
                return Ok(());
            }
            Err(super::Error::Server(ref err)) if err.code == 3948 => {
                // Loading local data is disabled;
                // this must be enabled on both the client and server sides
                return Ok(());
            }
            e @ Err(_) => e.unwrap(),
        };

        let result: Vec<String> = conn.query("SELECT * FROM tmp").await?;
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], "AAAAAA");
        assert_eq!(result[1], "BBBBBB");
        assert_eq!(result[2], "CCCCCC");

        Ok(())
    }

    #[tokio::test]
    async fn should_handle_initial_error_packet() {
        let header = [
            0x68, 0x00, 0x00, // packet_length
            0x00, // sequence
            0xff, // error_header
            0x69, 0x04, // error_code
        ];
        let error_message = "Host '172.17.0.1' is blocked because of many connection errors; unblock with 'mysqladmin flush-hosts'";

        // Create a fake MySQL server that immediately replies with an error packet.
        let listener = TcpListener::bind("127.0.0.1:0000").await.unwrap();

        let listen_addr = listener.local_addr().unwrap();

        tokio::task::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(&header).await.unwrap();
            stream.write_all(error_message.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let opts = OptsBuilder::default()
            .ip_or_hostname(listen_addr.ip().to_string())
            .tcp_port(listen_addr.port());
        let server_err = match Conn::new(opts).await {
            Err(Error::Server(server_err)) => server_err,
            other => panic!("expected server error but got: {:?}", other),
        };
        assert_eq!(
            server_err,
            ServerError {
                code: 1129,
                state: "HY000".to_owned(),
                message: error_message.to_owned(),
            }
        );
    }

    #[cfg_attr(docsrs, doc(cfg(feature = "client_parsec")))]
    #[tokio::test]
    #[cfg(feature = "client_parsec")]
    async fn parsec_connect() {
        let mut conn = Conn::new(get_opts()).await.unwrap();
        let is_mariadb = conn.inner.is_mariadb;
        let version = conn.server_version();
        if is_mariadb && version >= (11, 4, 1) {
            // Creating random password so in case of test failure user won't have
            // known password left behind.
            let mut rng = rand::rng();
            let mut pass_bytes = [0u8; 16];
            rng.fill(&mut pass_bytes);
            pass_bytes.iter_mut().for_each(|b| {
                *b = match *b % 3 {
                    0 => b'A' + (*b % 26),
                    1 => b'a' + (*b % 26),
                    _ => b'0' + (*b % 10),
                }
            });
            let pass = String::from_utf8_lossy(&pass_bytes).to_string();

            conn.query_drop("DROP USER IF EXISTS 'parsec_test_user'@'%'")
                .await
                .unwrap();
            let create_user_query = format!(
                "CREATE USER 'parsec_test_user'@'%' IDENTIFIED VIA 'parsec' USING PASSWORD('{}')",
                pass
            );
            conn.query_drop(create_user_query).await.unwrap();
            let mut conn_parsec = Conn::new(
                get_opts()
                    .user(Some("parsec_test_user"))
                    .pass(Some(pass))
                    .db_name(None::<String>)
                    .init(vec![] as Vec<String>),
            )
            .await
            .unwrap();
            assert!(conn_parsec.ping().await.is_ok());
            conn.query_drop("DROP USER 'parsec_test_user'@'%'")
                .await
                .unwrap();
        }
    }

    // This test verifies that the metadata is correct with or without metadata caching, and that protocol
    // is not broken afterwards and data is read correctly. It doesn't test that the metadata is really cached
    // (if that is possible) and not received twice.
    #[tokio::test]
    async fn test_metadata_caching() {
        use crate::consts::ColumnType;
        let mut conn = Conn::new(get_opts()).await.unwrap();
        if !conn.inner.is_mariadb {
            return;
        }

        conn.query_drop(
            r"CREATE TEMPORARY TABLE t_metadata_caching (
                id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
                val VARCHAR(32) NOT NULL)",
        )
        .await
        .unwrap();

        // Populating table with some data to verify that data still fetched correctly with cached metadata use
        let insert_stmt = conn
            .prep("INSERT INTO t_metadata_caching (val) VALUES (?)")
            .await
            .unwrap();
        let _ = conn.exec_drop(&insert_stmt, ("AAA",)).await;
        let _ = conn.exec_drop(&insert_stmt, ("BB",)).await;
        let mut ps = conn
            .prep("SELECT id, val FROM t_metadata_caching")
            .await
            .unwrap();

        let mut columns_from_prep = ps.columns();
        let mut metadata_from_prep: Vec<(String, ColumnType)> = columns_from_prep
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect();

        let mut query_result = conn.exec_iter(&ps, ()).await.unwrap();
        let mut columns_from_exec1 = query_result.columns().unwrap();
        let mut metadata_from_exec1: Vec<(String, ColumnType)> = columns_from_exec1
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect();

        // Comparing and verifying metadata.
        assert_eq!(metadata_from_prep, metadata_from_exec1);
        assert_eq!(metadata_from_prep.len(), 2);
        assert_eq!(metadata_from_prep[0].0, "id");
        assert_eq!(metadata_from_prep[0].1, ColumnType::MYSQL_TYPE_LONG);
        assert_eq!(metadata_from_prep[1].0, "val");
        assert_eq!(metadata_from_prep[1].1, ColumnType::MYSQL_TYPE_VAR_STRING);

        let fetched_rows: Vec<(i32, String)> = query_result.collect().await.unwrap();

        let expected_rows = [(1, "AAA".to_string()), (2, "BB".to_string())];
        assert_eq!(fetched_rows.len(), expected_rows.len());

        for (fetched, expected) in fetched_rows.iter().zip(expected_rows.iter()) {
            assert_eq!(fetched, expected);
        }

        // Doing the same for exec_first. Technically it's internally the same as exec_iter,
        // but the test isn't supposed to know that and to test it
        ps = conn
            .prep("SELECT val FROM t_metadata_caching WHERE id = ?")
            .await
            .unwrap();
        columns_from_prep = ps.columns();
        metadata_from_prep = columns_from_prep
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect();
        let single_row: Option<String> = conn.exec_first(&ps, (1,)).await.unwrap();
        if let Some(val) = single_row {
            assert_eq!(metadata_from_prep.len(), 1);
            assert_eq!(metadata_from_prep[0].0, "val");
            assert_eq!(metadata_from_prep[0].1, ColumnType::MYSQL_TYPE_VAR_STRING);

            assert_eq!(val, "AAA".to_string());
        }
        // Testing the case when metadata is changed after execution
        ps = conn.prep("SELECT ?").await.unwrap();

        columns_from_prep = ps.columns();
        metadata_from_prep = columns_from_prep
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect();

        // First query — server sends metadata because the type has changed
        query_result = conn.exec_iter(&ps, (12,)).await.unwrap();
        columns_from_exec1 = query_result.columns().unwrap();
        metadata_from_exec1 = columns_from_exec1
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect();
        let fetched_rows: Vec<i32> = query_result.collect().await.unwrap();

        // Second query — server skips metadata packets
        query_result = conn.exec_iter(&ps, (42,)).await.unwrap();
        let columns_from_exec2 = query_result.columns().unwrap();
        let metadata_from_exec2 = columns_from_exec2
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect::<Vec<_>>();
        let fetched_rows2: Vec<i32> = query_result.collect().await.unwrap();

        // Third query — server sends metadata because the type has changed
        query_result = conn.exec_iter(&ps, ("foo",)).await.unwrap();
        let columns_from_exec3 = query_result.columns().unwrap();
        let metadata_from_exec3 = columns_from_exec3
            .iter()
            .map(|column| (column.name_str().to_string(), column.column_type()))
            .collect::<Vec<_>>();
        let fetched_rows3: Vec<String> = query_result.collect().await.unwrap();

        // Comparing and verifying metadata.
        assert_eq!(metadata_from_exec1.len(), 1);
        assert_eq!(metadata_from_exec2.len(), 1);
        assert_eq!(metadata_from_exec3.len(), 1);
        assert_eq!(metadata_from_prep.len(), 1);
        assert_eq!(metadata_from_prep[0].0, "?");
        assert!(
            metadata_from_prep[0].1 == ColumnType::MYSQL_TYPE_NULL
                || metadata_from_prep[0].1 == ColumnType::MYSQL_TYPE_VAR_STRING,
            "Expected MYSQL_TYPE_NULL(MariaDB) or MYSQL_TYPE_VAR_STRING(MySQL), got {:?}",
            metadata_from_prep[0].1
        );
        assert_eq!(metadata_from_exec1[0].0, "?");
        assert_eq!(metadata_from_exec1[0].1, ColumnType::MYSQL_TYPE_LONGLONG);
        assert_eq!(metadata_from_exec2[0].0, "?");
        assert_eq!(metadata_from_exec2[0].1, ColumnType::MYSQL_TYPE_LONGLONG);
        assert_eq!(metadata_from_exec3[0].0, "?");
        assert_eq!(metadata_from_exec3[0].1, ColumnType::MYSQL_TYPE_VAR_STRING);

        assert_eq!(fetched_rows[0], 12);
        assert_eq!(fetched_rows2[0], 42);
        assert_eq!(fetched_rows3[0], "foo".to_owned());
    }

    #[cfg(feature = "nightly")]
    mod bench {
        use crate::{conn::Conn, queryable::Queryable, test_misc::get_opts};

        #[bench]
        fn simple_exec(bencher: &mut test::Bencher) {
            let mut runtime = tokio::runtime::Runtime::new().unwrap();
            let mut conn = runtime.block_on(Conn::new(get_opts())).unwrap();

            bencher.iter(|| {
                runtime.block_on(conn.query_drop("DO 1")).unwrap();
            });

            runtime.block_on(conn.disconnect()).unwrap();
        }

        #[bench]
        fn select_large_string(bencher: &mut test::Bencher) {
            let mut runtime = tokio::runtime::Runtime::new().unwrap();
            let mut conn = runtime.block_on(Conn::new(get_opts())).unwrap();

            bencher.iter(|| {
                runtime
                    .block_on(conn.query_drop("SELECT REPEAT('A', 10000)"))
                    .unwrap();
            });

            runtime.block_on(conn.disconnect()).unwrap();
        }

        #[bench]
        fn prepared_exec(bencher: &mut test::Bencher) {
            let mut runtime = tokio::runtime::Runtime::new().unwrap();
            let mut conn = runtime.block_on(Conn::new(get_opts())).unwrap();
            let stmt = runtime.block_on(conn.prep("DO 1")).unwrap();

            bencher.iter(|| {
                runtime.block_on(conn.exec_drop(&stmt, ())).unwrap();
            });

            runtime.block_on(conn.close(stmt)).unwrap();
            runtime.block_on(conn.disconnect()).unwrap();
        }

        #[bench]
        fn prepare_and_exec(bencher: &mut test::Bencher) {
            let mut runtime = tokio::runtime::Runtime::new().unwrap();
            let mut conn = runtime.block_on(Conn::new(get_opts())).unwrap();

            bencher.iter(|| {
                runtime.block_on(conn.exec_drop("SELECT ?", (0,))).unwrap();
            });

            runtime.block_on(conn.disconnect()).unwrap();
        }
    }
}
