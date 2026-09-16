//! An asynchronous, runtime-independent, pure-rust Tabular Data Stream (TDS)
//! implementation for Microsoft SQL Server.
//!
//! # Connecting with async-std
//!
//! Being not bound to any single runtime, a `TcpStream` must be created
//! separately and injected to the [`Client`].
//!
//! ```no_run
//! use tiberius::{Client, Config, Query, AuthMethod};
//! use async_std::net::TcpStream;
//!
//! #[async_std::main]
//! async fn main() -> anyhow::Result<()> {
//!     // Using the builder method to construct the options.
//!     let mut config = Config::new();
//!
//!     config.host("localhost");
//!     config.port(1433);
//!
//!     // Using SQL Server authentication.
//!     config.authentication(AuthMethod::sql_server("SA", "<YourStrong@Passw0rd>"));
//!
//!     // on production, it is not a good idea to do this
//!     config.trust_cert();
//!
//!     // Taking the address from the configuration, using async-std's
//!     // TcpStream to connect to the server.
//!     let tcp = TcpStream::connect(config.get_addr()).await?;
//!
//!     // We'll disable the Nagle algorithm. Buffering is handled
//!     // internally with a `Sink`.
//!     tcp.set_nodelay(true)?;
//!
//!     // Handling TLS, login and other details related to the SQL Server.
//!     let mut client = Client::connect(config, tcp).await?;
//!
//!     // Constructing a query object with one parameter annotated with `@P1`.
//!     // This requires us to bind a parameter that will then be used in
//!     // the statement.
//!     let mut select = Query::new("SELECT @P1");
//!     select.bind(-4i32);
//!
//!     // A response to a query is a stream of data, that must be
//!     // polled to the end before querying again. Using streams allows
//!     // fetching data in an asynchronous manner, if needed.
//!     let stream = select.query(&mut client).await?;
//!
//!     // In this case, we know we have only one query, returning one row
//!     // and one column, so calling `into_row` will consume the stream
//!     // and return us the first row of the first result.
//!     let row = stream.into_row().await?;
//!
//!     assert_eq!(Some(-4i32), row.unwrap().get(0));
//!
//!     Ok(())
//! }
//! ```
//!
//! # Connecting with Tokio
//!
//! Tokio is using their own version of `AsyncRead` and `AsyncWrite` traits,
//! meaning that when wanting to use Tiberius with Tokio, their `TcpStream`
//! needs to be wrapped in Tokio's `Compat` module.
//!
//! ```no_run
//! use tiberius::{Client, Config, AuthMethod};
//! use tokio::net::TcpStream;
//! use tokio_util::compat::TokioAsyncWriteCompatExt;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let mut config = Config::new();
//!
//!     config.host("localhost");
//!     config.port(1433);
//!     config.authentication(AuthMethod::sql_server("SA", "<YourStrong@Passw0rd>"));
//!     config.trust_cert(); // on production, it is not a good idea to do this
//!
//!     let tcp = TcpStream::connect(config.get_addr()).await?;
//!     tcp.set_nodelay(true)?;
//!
//!     // To be able to use Tokio's tcp, we're using the `compat_write` from
//!     // the `TokioAsyncWriteCompatExt` to get a stream compatible with the
//!     // traits from the `futures` crate.
//!     let mut client = Client::connect(config, tcp.compat_write()).await?;
//!     # client.query("SELECT @P1", &[&-4i32]).await?;
//!
//!     Ok(())
//! }
//! ```
//!
//! # Ways of querying
//!
//! Tiberius offers two ways to query the database: directly from the [`Client`]
//! with the [`Client#query`] and [`Client#execute`], or additionally through
//! the [`Query`] object.
//!
//! ### With the client methods
//!
//! When the query parameters are known when writing the code, the client methods
//! are easy to use.
//!
//! ```no_run
//! # use tiberius::{Client, Config, AuthMethod};
//! # use tokio::net::TcpStream;
//! # use tokio_util::compat::TokioAsyncWriteCompatExt;
//! # #[tokio::main]
//! # async fn main() -> anyhow::Result<()> {
//! # let mut config = Config::new();
//! # config.host("localhost");
//! # config.port(1433);
//! # config.authentication(AuthMethod::sql_server("SA", "<YourStrong@Passw0rd>"));
//! # config.trust_cert();
//! # let tcp = TcpStream::connect(config.get_addr()).await?;
//! # tcp.set_nodelay(true)?;
//! # let mut client = Client::connect(config, tcp.compat_write()).await?;
//! let _res = client.query("SELECT @P1", &[&-4i32]).await?;
//! # Ok(())
//! # }
//! ```
//!
//! ### With the Query object
//!
//! In case of needing to pass the parameters from a dynamic collection, or if
//! wanting to pass them by-value, use the [`Query`] object.
//!
//! ```no_run
//! # use tiberius::{Client, Query, Config, AuthMethod};
//! # use tokio::net::TcpStream;
//! # use tokio_util::compat::TokioAsyncWriteCompatExt;
//! # #[tokio::main]
//! # async fn main() -> anyhow::Result<()> {
//! # let mut config = Config::new();
//! # config.host("localhost");
//! # config.port(1433);
//! # config.authentication(AuthMethod::sql_server("SA", "<YourStrong@Passw0rd>"));
//! # config.trust_cert();
//! # let tcp = TcpStream::connect(config.get_addr()).await?;
//! # tcp.set_nodelay(true)?;
//! # let mut client = Client::connect(config, tcp.compat_write()).await?;
//! let params = vec![String::from("foo"), String::from("bar")];
//! let mut select = Query::new("SELECT @P1, @P2, @P3");
//!
//! for param in params.into_iter() {
//!     select.bind(param);
//! }
//!
//! let _res = select.query(&mut client).await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Authentication
//!
//! Tiberius supports different [ways of authentication] to the SQL Server:
//!
//! - SQL Server authentication uses the facilities of the database to
//! authenticate the user.
//! - On Windows, you can authenticate using the currently logged in user or
//! specified Windows credentials.
//! - If enabling the `integrated-auth-gssapi` feature, it is possible to login
//! with the currently active Kerberos credentials.
//!
//! ## AAD(Azure Active Directory) Authentication
//!
//! Tiberius supports AAD authentication by taking an AAD token. Suggest using
//! [azure_identity](https://crates.io/crates/azure_identity) crate to retrieve
//! the token, and config tiberius with token. There is an example in examples
//! folder on how to setup this.
//!
//! # TLS
//!
//! When compiled using the default features, a TLS encryption will be available
//! and by default, used for all traffic. TLS is handled with the given
//! `TcpStream`. Please see the documentation for [`EncryptionLevel`] for
//! details.
//!
//! # SQL Browser
//!
//! On Windows platforms, connecting to the SQL Server might require going through
//! the SQL Browser service to get the correct port for the named instance. This
//! feature requires either the `sql-browser-async-std` or `sql-browser-tokio` feature
//! flag to be enabled and has a bit different way of connecting:
//!
//! ```no_run
//! # #[cfg(any(feature = "sql-browser-async-std", feature = "sql-browser-tokio"))]
//! use tiberius::{Client, Config, AuthMethod};
//! # #[cfg(any(feature = "sql-browser-async-std", feature = "sql-browser-tokio"))]
//! use async_std::net::TcpStream;
//!
//! // An extra trait that allows connecting to a named instance with the given
//! // `TcpStream`.
//! # #[cfg(any(feature = "sql-browser-async-std", feature = "sql-browser-tokio"))]
//! use tiberius::SqlBrowser;
//!
//! #[async_std::main]
//! # #[cfg(any(feature = "sql-browser-async-std", feature = "sql-browser-tokio"))]
//! async fn main() -> anyhow::Result<()> {
//!     let mut config = Config::new();
//!
//!     config.authentication(AuthMethod::sql_server("SA", "<password>"));
//!     config.host("localhost");
//!
//!     // The default port of SQL Browser
//!     config.port(1434);
//!
//!     // The name of the database server instance.
//!     config.instance_name("INSTANCE");
//!
//!     // on production, it is not a good idea to do this
//!     config.trust_cert();
//!
//!     // This will create a new `TcpStream` from `async-std`, connected to the
//!     // right port of the named instance.
//!     let tcp = TcpStream::connect_named(&config).await?;
//!
//!     // And from here on continue the connection process in a normal way.
//!     let mut client = Client::connect(config, tcp).await?;
//!     # client.query("SELECT @P1", &[&-4i32]).await?;
//!     Ok(())
//! }
//! # #[cfg(any(not(feature = "sql-browser-async-std"), not(feature = "sql-browser-tokio")))]
//! # fn main() {}
//! ```
//!
//! # Other features
//!
//! - If using an [ADO.NET connection string], it is possible to create a
//!   [`Config`] from one. Please see the documentation for
//!   [`from_ado_string`] for details.
//! - If wanting to use Tiberius with SQL Server version 2005, one must
//!   disable the `tds73` feature.
//!
//! [`EncryptionLevel`]: enum.EncryptionLevel.html
//! [`Client`]: struct.Client.html
//! [`Client#query`]: struct.Client.html#method.query
//! [`Client#execute`]: struct.Client.html#method.execute
//! [`Query`]: struct.Query.html
//! [`Query#bind`]: struct.Query.html#method.bind
//! [`Config`]: struct.Config.html
//! [`from_ado_string`]: struct.Config.html#method.from_ado_string
//! [`time`]: time/index.html
//! [ways of authentication]: enum.AuthMethod.html
//! [ADO.NET connection string]: https://docs.microsoft.com/en-us/dotnet/framework/data/adonet/connection-strings
#![cfg_attr(feature = "docs", feature(doc_cfg))]
#![recursion_limit = "512"]
#![warn(missing_docs)]
#![warn(missing_debug_implementations, rust_2018_idioms)]
#![doc(test(attr(deny(rust_2018_idioms, warnings))))]
#![doc(test(attr(allow(unused_extern_crates, unused_variables))))]

#[cfg(feature = "bigdecimal")]
pub(crate) extern crate bigdecimal_ as bigdecimal;

#[macro_use]
mod macros;

mod client;
mod from_sql;
mod query;
mod sql_read_bytes;
mod to_sql;

pub mod error;
mod result;
mod row;
mod tds;

mod sql_browser;

pub use client::{AuthMethod, Client, Config};
pub(crate) use error::Error;
pub use from_sql::{FromSql, FromSqlOwned};
pub use query::Query;
pub use result::*;
pub use row::{Column, ColumnType, Row};
pub use sql_browser::SqlBrowser;
pub use tds::{
    codec::{BulkLoadRequest, ColumnData, ColumnFlag, IntoRow, TokenRow, TypeLength},
    numeric,
    stream::QueryStream,
    time, xml, EncryptionLevel,
};
pub use to_sql::{IntoSql, ToSql};
pub use uuid::Uuid;

use sql_read_bytes::*;
use tds::codec::*;

/// An alias for a result that holds crate's error type as the error.
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn get_driver_version() -> u64 {
    env!("CARGO_PKG_VERSION")
        .splitn(6, '.')
        .enumerate()
        .fold(0u64, |acc, part| match part.1.parse::<u64>() {
            Ok(num) => acc | num << (part.0 * 8),
            _ => acc | 0 << (part.0 * 8),
        })
}
