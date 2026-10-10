// Copyright (c) 2016 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

pub use url::ParseError;

pub mod tls;

use mysql_common::{
    auth::plugins::{self, PluginInitError},
    named_params::MixedParamsError,
    packets::{BulkExecuteRequestBuilderError, BulkExecuteRequestError},
    params::{MissingNamedParameterError, ParamsError},
    proto::codec::error::PacketCodecError,
    row::Row,
    value::Value,
};
use thiserror::Error;

use std::{io, result};

/// Result type alias for this library.
pub type Result<T> = result::Result<T, Error>;

/// The maximum number of bind variables supported by MySQL.
/// https://stackoverflow.com/questions/4922345/how-many-bind-variables-can-i-use-in-a-sql-query-in-mysql-5#comment136409462_11131824
pub(crate) const MAX_STATEMENT_PARAMS: usize = u16::MAX as usize;

/// This type enumerates library errors.
#[derive(Debug, Error)]
pub enum Error {
    #[error("Driver error: `{}'", _0)]
    Driver(#[source] DriverError),

    #[error("Input/output error: {}", _0)]
    Io(#[source] IoError),

    #[error("Other error: {}", _0)]
    Other(#[source] Box<dyn std::error::Error + Send + Sync + 'static>),

    #[error("Server error: `{}'", _0)]
    Server(#[source] ServerError),

    #[error("URL error: `{}'", _0)]
    Url(#[source] UrlError),
}

impl Error {
    /// Returns true if the error means that connection is broken.
    pub fn is_fatal(&self) -> bool {
        match self {
            Error::Driver(_) | Error::Io(_) | Error::Other(_) | Error::Url(_) => true,
            Error::Server(_) => false,
        }
    }
}

/// This type enumerates IO errors.
#[derive(Debug, Error)]
pub enum IoError {
    #[error("Input/output error: {}", _0)]
    Io(#[source] io::Error),
    #[cfg(any(feature = "native-tls-tls", feature = "rustls-tls"))]
    #[error("TLS error: `{}'", _0)]
    Tls(#[source] tls::TlsError),
}

/// This type represents MySql server error.
#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("ERROR {} ({}): {}", code, state, message)]
pub struct ServerError {
    pub code: u16,
    pub message: String,
    pub state: String,
}

/// This type enumerates connection URL errors.
#[derive(Debug, Error, Clone, Eq, PartialEq)]
pub enum UrlError {
    #[error("Connection URL parameter `{}' requires feature `{}'", param, feature)]
    FeatureRequired { feature: String, param: String },

    #[error("Invalid or incomplete connection URL")]
    Invalid,

    #[error("Invalid value `{}' for connection URL parameter `{}'", value, param)]
    InvalidParamValue { param: String, value: String },

    #[error("Invalid pool constraints: pool_min ({}) > pool_max ({}).", min, max)]
    InvalidPoolConstraints { min: usize, max: usize },

    #[error("URL parse error: {}", _0)]
    Parse(#[source] ParseError),

    #[error("Unknown connection URL parameter `{}'", param)]
    UnknownParameter { param: String },

    #[error("Unsupported connection URL scheme `{}'", scheme)]
    UnsupportedScheme { scheme: String },
}

/// This type enumerates driver errors.
#[derive(Debug, Error)]
pub enum DriverError {
    #[error("Can't parse server version from string `{}'.", version_string)]
    CantParseServerVersion { version_string: String },

    #[error("Connection to the server is closed.")]
    ConnectionClosed,

    #[error("Error converting from mysql value.")]
    FromValue { value: Value },

    #[error("Error converting from mysql row.")]
    FromRow { row: Row },

    #[error(transparent)]
    Params(ParamsError),

    #[error("Named and positional parameters mixed in one statement.")]
    MixedParams,

    #[error("Transactions couldn't be nested.")]
    NestedTransaction,

    #[error("Packet out of order.")]
    PacketOutOfOrder,

    #[error("Pool was disconnected.")]
    PoolDisconnected,

    #[error("`SET TRANSACTION READ (ONLY|WRITE)' is not supported in your MySQL version.")]
    ReadOnlyTransNotSupported,

    #[error(
        "Statement takes {} parameters but {} was supplied.",
        required,
        supplied
    )]
    StmtParamsMismatch { required: u16, supplied: usize },

    #[error(
        "MySQL supports up to {} parameters but {} was supplied.",
        MAX_STATEMENT_PARAMS,
        supplied
    )]
    StmtParamsNumberExceedsLimit { supplied: usize },

    #[error("Unexpected packet.")]
    UnexpectedPacket { payload: Vec<u8> },

    #[error("Unknown authentication plugin `{}'.", name)]
    UnknownAuthPlugin { name: String },

    #[error("Packet too large.")]
    PacketTooLarge,

    #[error("Bad compressed packet header.")]
    BadCompressedPacketHeader,

    #[error("Named pipe connections temporary disabled (see tokio-rs/tokio#3118)")]
    NamedPipesDisabled,

    #[error("`mysql_old_password` plugin is insecure and disabled by default")]
    MysqlOldPasswordDisabled,

    #[error("LOCAL INFILE error: {}", _0)]
    LocalInfile(#[from] LocalInfileError),

    #[error("No private key found in the file specified")]
    NoKeyFound,

    #[error("Client asked for SSL but server does not have this capability")]
    NoClientSslFlagFromServer,

    #[error("mysql_clear_password must be enabled on the client side")]
    CleartextPluginDisabled,
    #[error("Invalid parsec ext-salt packet received from server")]
    InvalidParsecSalt,

    #[error("Authentication plugin error: {}", _0)]
    AuthPlugin(#[source] plugins::Error),

    #[error("Bulk execute error: {}", _0)]
    BulkExecute(BulkExecuteRequestError),
}

impl From<PluginInitError> for DriverError {
    fn from(value: PluginInitError) -> Self {
        match value {
            PluginInitError::UnsupportedPlugin(name) => Self::UnknownAuthPlugin {
                name: String::from_utf8_lossy(&name).into_owned(),
            },
        }
    }
}

impl From<plugins::Error> for DriverError {
    fn from(value: plugins::Error) -> Self {
        Self::AuthPlugin(value)
    }
}

impl From<BulkExecuteRequestBuilderError> for DriverError {
    fn from(value: BulkExecuteRequestBuilderError) -> Self {
        match value {
            BulkExecuteRequestBuilderError::Request(x) => Self::from(x),
            BulkExecuteRequestBuilderError::Params(x) => Self::from(x),
        }
    }
}

impl From<BulkExecuteRequestError> for DriverError {
    fn from(value: BulkExecuteRequestError) -> Self {
        Self::BulkExecute(value)
    }
}

#[derive(Debug, Error)]
pub enum LocalInfileError {
    #[error("The given path is not in the while list: {}", _0)]
    PathIsNotInTheWhiteList(String),
    #[error("Error reading `INFILE` data: {}", _0)]
    ReadError(#[from] io::Error),
    #[error("Can't handle local infile request. Handler is not specified.")]
    NoHandler,
    #[error(transparent)]
    OtherError(Box<dyn std::error::Error + Send + Sync + 'static>),
}

impl LocalInfileError {
    pub fn other<T>(err: T) -> Self
    where
        T: std::error::Error + Send + Sync + 'static,
    {
        Self::OtherError(Box::new(err))
    }
}

impl From<LocalInfileError> for Error {
    fn from(err: LocalInfileError) -> Self {
        Self::Driver(err.into())
    }
}

impl From<DriverError> for Error {
    fn from(err: DriverError) -> Self {
        Error::Driver(err)
    }
}

impl From<IoError> for Error {
    fn from(io: IoError) -> Self {
        Error::Io(io)
    }
}

impl From<io::Error> for IoError {
    fn from(err: io::Error) -> Self {
        IoError::Io(err)
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err.into())
    }
}

impl From<ServerError> for Error {
    fn from(err: ServerError) -> Self {
        Error::Server(err)
    }
}

impl From<UrlError> for Error {
    fn from(err: UrlError) -> Self {
        Error::Url(err)
    }
}

#[cfg(feature = "native-tls-tls")]
impl From<native_tls::Error> for IoError {
    fn from(err: native_tls::Error) -> Self {
        IoError::Tls(tls::TlsError::TlsError(err))
    }
}

impl From<mysql_common::packets::ServerError<'_>> for ServerError {
    fn from(packet: mysql_common::packets::ServerError<'_>) -> Self {
        ServerError {
            code: packet.error_code(),
            message: packet.message_str().into(),
            state: packet
                .sql_state_ref()
                .map(|s| s.as_str().into_owned())
                .unwrap_or_else(|| "HY000".to_owned()),
        }
    }
}

impl From<mysql_common::packets::ServerError<'_>> for Error {
    fn from(packet: mysql_common::packets::ServerError<'_>) -> Self {
        Error::Server(packet.into())
    }
}

// For convenience
impl From<(Error, crate::io::Stream)> for Error {
    fn from((err, _): (Error, crate::io::Stream)) -> Self {
        err
    }
}

impl From<MissingNamedParameterError> for DriverError {
    fn from(err: MissingNamedParameterError) -> Self {
        DriverError::Params(ParamsError::Missing(err))
    }
}

impl From<MissingNamedParameterError> for Error {
    fn from(err: MissingNamedParameterError) -> Self {
        Error::Driver(err.into())
    }
}

impl From<MixedParamsError> for DriverError {
    fn from(_err: MixedParamsError) -> Self {
        DriverError::MixedParams
    }
}

impl From<MixedParamsError> for Error {
    fn from(err: MixedParamsError) -> Self {
        Error::Driver(err.into())
    }
}

impl From<ParamsError> for DriverError {
    fn from(value: ParamsError) -> Self {
        Self::Params(value)
    }
}

impl From<ParamsError> for Error {
    fn from(value: ParamsError) -> Self {
        DriverError::Params(value).into()
    }
}

impl From<ParseError> for UrlError {
    fn from(err: ParseError) -> Self {
        UrlError::Parse(err)
    }
}

impl From<ParseError> for Error {
    fn from(err: ParseError) -> Self {
        Error::Url(err.into())
    }
}

impl From<PacketCodecError> for IoError {
    fn from(err: PacketCodecError) -> Self {
        match err {
            PacketCodecError::Io(err) => err.into(),
            err => io::Error::other(err).into(),
        }
    }
}

impl From<PacketCodecError> for Error {
    fn from(err: PacketCodecError) -> Self {
        Error::Io(err.into())
    }
}
