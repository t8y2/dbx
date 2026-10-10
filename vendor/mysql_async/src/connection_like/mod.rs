// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_util::FutureExt;

use crate::{BoxFuture, Pool};

/// Inner [`Connection`] representation.
#[derive(Debug)]
pub(crate) enum ConnectionInner<'a, 't: 'a> {
    /// Just a connection.
    Conn(crate::Conn),
    /// Mutable reference to a connection.
    ConnMut(&'a mut crate::Conn),
    /// Connection wrapped in a transaction.
    Tx(&'a mut crate::Transaction<'t>),
}

impl std::ops::Deref for ConnectionInner<'_, '_> {
    type Target = crate::Conn;

    fn deref(&self) -> &Self::Target {
        match self {
            ConnectionInner::Conn(ref conn) => conn,
            ConnectionInner::ConnMut(conn) => conn,
            ConnectionInner::Tx(tx) => tx.0.deref(),
        }
    }
}

impl std::ops::DerefMut for ConnectionInner<'_, '_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match self {
            ConnectionInner::Conn(conn) => conn,
            ConnectionInner::ConnMut(conn) => conn,
            ConnectionInner::Tx(tx) => tx.0.inner.deref_mut(),
        }
    }
}

/// Some connection.
///
/// This could at least be queried.
#[derive(Debug)]
pub struct Connection<'a, 't: 'a> {
    pub(crate) inner: ConnectionInner<'a, 't>,
}

impl Connection<'_, '_> {
    #[inline]
    pub(crate) fn as_mut(&mut self) -> &mut crate::Conn {
        &mut self.inner
    }
}

impl<'a, 't: 'a> Connection<'a, 't> {
    /// Borrows a [`Connection`] rather than consuming it.
    ///
    /// This is useful to allow calling [`Query`] methods while still retaining
    /// ownership of the original connection.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// # use mysql_async::Connection;
    /// # use mysql_async::prelude::Query;
    /// async fn connection_by_ref(mut connection: Connection<'_, '_>) {
    ///     // Perform some query
    ///     "SELECT 1".ignore(connection.by_ref()).await.unwrap();
    ///     // Perform another query.
    ///     // We can only do this because we used `by_ref` earlier.
    ///     "SELECT 2".ignore(connection).await.unwrap();
    /// }
    /// ```
    ///
    /// [`Query`]: crate::prelude::Query
    pub fn by_ref(&mut self) -> Connection<'_, '_> {
        Connection {
            inner: ConnectionInner::ConnMut(self.as_mut()),
        }
    }
}

impl From<crate::Conn> for Connection<'static, 'static> {
    fn from(conn: crate::Conn) -> Self {
        Self {
            inner: ConnectionInner::Conn(conn),
        }
    }
}

impl<'a> From<&'a mut crate::Conn> for Connection<'a, 'static> {
    fn from(conn: &'a mut crate::Conn) -> Self {
        Self {
            inner: ConnectionInner::ConnMut(conn),
        }
    }
}

impl<'a, 't> From<&'a mut crate::Transaction<'t>> for Connection<'a, 't> {
    fn from(tx: &'a mut crate::Transaction<'t>) -> Self {
        Self {
            inner: ConnectionInner::Tx(tx),
        }
    }
}

impl std::ops::Deref for Connection<'_, '_> {
    type Target = crate::Conn;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// Result of a [`ToConnection::to_connection`] call.
pub enum ToConnectionResult<'a, 't: 'a> {
    /// Connection is immediately available.
    Immediate(Connection<'a, 't>),
    /// We need some time to get a connection and the operation itself may fail.
    Mediate(BoxFuture<'a, Connection<'a, 't>>),
}

impl<'a, 't: 'a> ToConnectionResult<'a, 't> {
    /// Resolves `self` to a connection.
    #[inline]
    pub async fn resolve(self) -> crate::Result<Connection<'a, 't>> {
        match self {
            ToConnectionResult::Immediate(immediate) => Ok(immediate),
            ToConnectionResult::Mediate(mediate) => mediate.await,
        }
    }
}

/// Everything that can be given in exchange to a connection.
///
/// Note that you could obtain a `'static` connection by giving away `Conn` or `Pool`.
pub trait ToConnection<'a, 't: 'a>: Send {
    /// Converts self to a connection.
    fn to_connection(self) -> ToConnectionResult<'a, 't>;
}

impl<'a, 't: 'a, T: Into<Connection<'a, 't>> + Send> ToConnection<'a, 't> for T {
    fn to_connection(self) -> ToConnectionResult<'a, 't> {
        ToConnectionResult::Immediate(self.into())
    }
}

impl ToConnection<'static, 'static> for Pool {
    fn to_connection(self) -> ToConnectionResult<'static, 'static> {
        let fut = async move {
            let conn = self.get_conn().await?;
            Ok(conn.into())
        }
        .boxed();
        ToConnectionResult::Mediate(fut)
    }
}

impl<'a> ToConnection<'a, 'static> for &'a Pool {
    fn to_connection(self) -> ToConnectionResult<'a, 'static> {
        let fut = async move {
            let conn = self.get_conn().await?;
            Ok(conn.into())
        }
        .boxed();
        ToConnectionResult::Mediate(fut)
    }
}
