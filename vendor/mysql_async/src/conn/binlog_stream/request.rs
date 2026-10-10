use mysql_common::packets::{
    binlog_request::BinlogRequest, BinlogDumpFlags, ComRegisterSlave, Sid,
};

/// Binlog stream request builder.
pub struct BinlogStreamRequest<'a> {
    pub(crate) binlog_request: BinlogRequest<'a>,
    pub(crate) register_slave: ComRegisterSlave<'a>,
}

impl<'a> BinlogStreamRequest<'a> {
    /// Creates a new request with the given slave server id.
    pub fn new(server_id: u32) -> Self {
        Self {
            binlog_request: BinlogRequest::new(server_id),
            register_slave: ComRegisterSlave::new(server_id),
        }
    }

    /// Enables GTID-based replication (disabled by default).
    pub fn with_gtid(mut self) -> Self {
        self.binlog_request = self.binlog_request.with_use_gtid(true);
        self
    }

    /// Enables `NON_BLOCK` flag. Stream will be terminated as soon as there are no events.
    pub fn with_non_blocking(mut self) -> Self {
        self.binlog_request = self
            .binlog_request
            .with_flags(BinlogDumpFlags::BINLOG_DUMP_NON_BLOCK);
        self
    }

    /// Sets the filename of the binlog on the master (try `SHOW BINARY LOGS`).
    pub fn with_filename(mut self, filename: &'a [u8]) -> Self {
        self.binlog_request = self.binlog_request.with_filename(filename);
        self
    }

    /// Sets the start position (defaults to `4`).
    pub fn with_pos(mut self, position: u64) -> Self {
        self.binlog_request = self.binlog_request.with_pos(position);
        self
    }

    /// Adds the given set of GTIDs to the request (ignored if not GTID-based).
    pub fn with_gtid_set<T>(mut self, set: T) -> Self
    where
        T: IntoIterator<Item = Sid<'a>>,
    {
        self.binlog_request = self.binlog_request.with_sids(set);
        self
    }

    /// This hostname will be reported to the server (max len 255, default to an empty string).
    ///
    /// Usually left default.
    pub fn with_hostname(mut self, hostname: &'a [u8]) -> Self {
        self.register_slave = self.register_slave.with_hostname(hostname);
        self
    }

    /// This username will be reported to the server (max len 255, default to an empty string).
    ///
    /// Usually left default.
    pub fn with_user(mut self, user: &'a [u8]) -> Self {
        self.register_slave = self.register_slave.with_user(user);
        self
    }

    /// This password will be reported to the server (max len 255, default to an empty string).
    ///
    /// Usually left default.
    pub fn with_password(mut self, password: &'a [u8]) -> Self {
        self.register_slave = self.register_slave.with_password(password);
        self
    }

    /// This port number will be reported to the server (defaults to `0`).
    ///
    /// Usually left default.
    pub fn with_port(mut self, port: u16) -> Self {
        self.register_slave = self.register_slave.with_port(port);
        self
    }
}
