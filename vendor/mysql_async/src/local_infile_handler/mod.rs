// Copyright (c) 2017-2022 mysql_async Contributors.
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use bytes::Bytes;
use futures_core::stream::BoxStream;

use std::{
    fmt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use crate::error::LocalInfileError;

pub mod builtin;

type BoxFuture<'a, T> = futures_core::future::BoxFuture<'a, Result<T, LocalInfileError>>;

/// LOCAL INFILE data is a stream of `std::io::Result<Bytes>`.
///
/// The driver will send this data to the server in response to a LOCAL INFILE request.
pub type InfileData = BoxStream<'static, std::io::Result<Bytes>>;

/// Global, `Opts`-level `LOCAL INFILE` handler (see ["LOCAL INFILE Handlers"][2] section
/// of the `README.md`).
///
/// **Warning:** You should be aware of [Security Considerations for LOAD DATA LOCAL][1].
///
/// The purpose of the handler is to emit infile data in response to a file name.
/// This handler will be called if there is no local handler installed for the connection.
///
/// The library will call this handler in response to a LOCAL INFILE request from the server.
/// The server, in its turn, will emit LOCAL INFILE requests in response to a `LOAD DATA LOCAL`
/// queries:
///
/// ```sql
/// LOAD DATA LOCAL INFILE '<file name>' INTO TABLE <table>;
/// ```
///
/// [1]: https://dev.mysql.com/doc/refman/8.0/en/load-data-local-security.html
/// [2]: ../#local-infile-handlers
pub trait GlobalHandler: Send + Sync + 'static {
    fn handle(&self, file_name: &[u8]) -> BoxFuture<'static, InfileData>;
}

impl<T> GlobalHandler for T
where
    T: for<'a> Fn(&'a [u8]) -> BoxFuture<'static, InfileData>,
    T: Send + Sync + 'static,
{
    fn handle(&self, file_name: &[u8]) -> BoxFuture<'static, InfileData> {
        (self)(file_name)
    }
}

static HANDLER_ID: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
pub struct GlobalHandlerObject(usize, Arc<dyn GlobalHandler>);

impl GlobalHandlerObject {
    pub(crate) fn new<T: GlobalHandler>(handler: T) -> Self {
        Self(HANDLER_ID.fetch_add(1, Ordering::SeqCst), Arc::new(handler))
    }

    pub(crate) fn clone_inner(&self) -> Arc<dyn GlobalHandler> {
        self.1.clone()
    }
}

impl PartialEq for GlobalHandlerObject {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for GlobalHandlerObject {}

impl fmt::Debug for GlobalHandlerObject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("GlobalHandlerObject").field(&"..").finish()
    }
}
