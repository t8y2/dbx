// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_util::FutureExt;
use mysql_common::{
    constants::{MariadbCapabilities, MAX_PAYLOAD_LEN},
    io::ParseBuf,
    proto::{Binary, Text},
    row::RowDeserializer,
    value::ServerSide,
};

use std::{fmt, sync::Arc};

use self::{
    query_result::QueryResult,
    stmt::Statement,
    transaction::{Transaction, TxStatus},
};

use crate::{
    conn::routines::{PingRoutine, QueryRoutine},
    consts::CapabilityFlags,
    error::*,
    prelude::{FromRow, StatementLike},
    query::AsQuery,
    queryable::query_result::ResultSetMeta,
    tracing_utils::{LevelInfo, LevelTrace, TracingLevel},
    BoxFuture, Column, Conn, Connection, Params, ResultSetStream, Row,
};

pub mod query_result;
pub mod stmt;
pub mod transaction;

pub trait Protocol: fmt::Debug + Send + Sync + 'static {
    /// Returns `ResultSetMeta`, that corresponds to the current protocol.
    fn result_set_meta(columns: Arc<[Column]>) -> ResultSetMeta;
    fn read_result_set_row(packet: &[u8], columns: Arc<[Column]>) -> Result<Row>;
    fn is_last_result_set_packet(capabilities: CapabilityFlags, packet: &[u8]) -> bool {
        if capabilities.contains(CapabilityFlags::CLIENT_DEPRECATE_EOF) {
            packet[0] == 0xFE && packet.len() < MAX_PAYLOAD_LEN
        } else {
            packet[0] == 0xFE && packet.len() < 8
        }
    }
    fn metadata_skip_possible(conn: &Conn) -> bool;
}

/// Phantom struct used to specify MySql text protocol.
#[derive(Debug)]
pub struct TextProtocol;

/// Phantom struct used to specify MySql binary protocol.
#[derive(Debug)]
pub struct BinaryProtocol;

impl Protocol for TextProtocol {
    fn result_set_meta(columns: Arc<[Column]>) -> ResultSetMeta {
        ResultSetMeta::Text(columns)
    }

    fn read_result_set_row(packet: &[u8], columns: Arc<[Column]>) -> Result<Row> {
        ParseBuf(packet)
            .parse::<RowDeserializer<ServerSide, Text>>(columns)
            .map(Into::into)
            .map_err(Into::into)
    }

    fn metadata_skip_possible(_conn: &Conn) -> bool {
        false
    }
}

impl Protocol for BinaryProtocol {
    fn result_set_meta(columns: Arc<[Column]>) -> ResultSetMeta {
        ResultSetMeta::Binary(columns)
    }

    fn read_result_set_row(packet: &[u8], columns: Arc<[Column]>) -> Result<Row> {
        ParseBuf(packet)
            .parse::<RowDeserializer<ServerSide, Binary>>(columns)
            .map(Into::into)
            .map_err(Into::into)
    }

    fn metadata_skip_possible(conn: &Conn) -> bool {
        conn.has_mariadb_capabilities(MariadbCapabilities::MARIADB_CLIENT_CACHE_METADATA)
    }
}

impl Conn {
    /// The purpose of this function is to rollback a transaction or to drop query result in cases,
    /// where `Transaction` was dropped without an explicit call to `commit` or `rollback`,
    /// or where `QueryResult` was dropped without being consumed.
    ///
    /// The difference betwee this function and [`Conn::cleanup`] is that this function
    /// won't rollback existing transaction. Another difference, is that this function
    /// won't ignore non-fatal errors.
    pub(crate) async fn clean_dirty(&mut self) -> Result<()> {
        self.drop_result().await?;
        if self.get_tx_status() == TxStatus::RequiresRollback {
            self.rollback_transaction().await?;
        }
        Ok(())
    }

    /// Low level function that performs a text query.
    pub(crate) async fn raw_query<'a, Q, L: TracingLevel>(&'a mut self, query: Q) -> Result<()>
    where
        Q: AsQuery + 'a,
    {
        self.routine(QueryRoutine::<'_, L>::new(query.as_query().as_ref()))
            .await
    }

    /// Used for internal querying of connection settings,
    /// bypassing instrumentation meant for user queries.
    // This is a merge of `Queryable::query_first` and `Conn::query_iter`.
    // TODO: find a cleaner way without duplicating code.
    pub(crate) fn query_internal<'a, T, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Option<T>>
    where
        Q: AsQuery + 'a,
        T: FromRow + Send + 'static,
    {
        async move {
            self.raw_query::<'_, _, LevelTrace>(query).await?;
            Ok(QueryResult::<'_, '_, TextProtocol>::new(self)
                .collect_and_drop::<T>()
                .await?
                .pop())
        }
        .boxed()
    }
}

/// Methods of this trait are used to execute database queries.
///
/// `Conn` is a `Queryable` as well as `Transaction`.
pub trait Queryable: Send {
    /// Executes `COM_PING`.
    fn ping(&mut self) -> BoxFuture<'_, ()>;

    /// Performs the given query and returns the result.
    fn query_iter<'a, Q>(
        &'a mut self,
        query: Q,
    ) -> BoxFuture<'a, QueryResult<'a, 'static, TextProtocol>>
    where
        Q: AsQuery + 'a;

    /// Prepares the given statement.
    ///
    /// Note, that `Statement` will exist only in the context of this queryable.
    ///
    /// Also note, that this call may close the least recently used statement
    /// if statement cache is at its capacity (see. [`stmt_cache_size`][stmt_cache_size]).
    ///
    /// [stmt_cache_size]: crate::Opts::stmt_cache_size
    fn prep<'a, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Statement>
    where
        Q: AsQuery + 'a;

    /// Closes the given statement.
    ///
    /// Usually there is no need to explicitly close statements
    /// (see. [`stmt_cache_size`][stmt_cache_size]).
    ///
    /// [stmt_cache_size]: crate::Opts::stmt_cache_size
    fn close(&mut self, stmt: Statement) -> BoxFuture<'_, ()>;

    /// Executes the given statement with given params.
    ///
    /// It'll prepare `stmt`, if necessary.
    fn exec_iter<'a: 's, 's, Q, P>(
        &'a mut self,
        stmt: Q,
        params: P,
    ) -> BoxFuture<'s, QueryResult<'a, 'static, BinaryProtocol>>
    where
        Q: StatementLike + 's,
        P: Into<Params>;

    /// Performs the given query and collects the first result set.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn query<'a, T, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Vec<T>>
    where
        Q: AsQuery + 'a,
        T: FromRow + Send + 'static,
    {
        async move { self.query_iter(query).await?.collect_and_drop::<T>().await }.boxed()
    }

    /// Performs the given query and returns the first row of the first result set.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn query_first<'a, T, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Option<T>>
    where
        Q: AsQuery + 'a,
        T: FromRow + Send + 'static,
    {
        async move {
            let mut result = self.query_iter(query).await?;
            let output = if result.is_empty() {
                None
            } else {
                result.next().await?.map(crate::from_row)
            };
            result.drop_result().await?;
            Ok(output)
        }
        .boxed()
    }

    /// Performs the given query and maps each row of the first result set.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn query_map<'a, T, F, Q, U>(&'a mut self, query: Q, mut f: F) -> BoxFuture<'a, Vec<U>>
    where
        Q: AsQuery + 'a,
        T: FromRow + Send + 'static,
        F: FnMut(T) -> U + Send + 'a,
        U: Send,
    {
        async move {
            self.query_fold(query, Vec::new(), |mut acc, row| {
                acc.push(f(crate::from_row(row)));
                acc
            })
            .await
        }
        .boxed()
    }

    /// Performs the given query and folds the first result set to a single value.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn query_fold<'a, T, F, Q, U>(&'a mut self, query: Q, init: U, mut f: F) -> BoxFuture<'a, U>
    where
        Q: AsQuery + 'a,
        T: FromRow + Send + 'static,
        F: FnMut(U, T) -> U + Send + 'a,
        U: Send + 'a,
    {
        async move {
            self.query_iter(query)
                .await?
                .reduce_and_drop(init, |acc, row| f(acc, crate::from_row(row)))
                .await
        }
        .boxed()
    }

    /// Performs the given query and drops the query result.
    fn query_drop<'a, Q>(&'a mut self, query: Q) -> BoxFuture<'a, ()>
    where
        Q: AsQuery + 'a,
    {
        async move { self.query_iter(query).await?.drop_result().await }.boxed()
    }

    /// Executes the given statement for each item in the given params iterator.
    ///
    /// It'll prepare `stmt` (once), if necessary.
    ///
    /// # Note
    ///
    /// It will use `COM_STMT_BULK_EXECUTE` for MariaDb >= v10.2 if
    /// `MARIADB_CLIENT_STMT_BULK_OPERATIONS` is enabled by the server. Practically
    /// this means that the function will error with code 1295 (`ER_UNSUPPORTED_PS`)
    /// for _non-bulk execution safe_ operations, namely for all operations
    /// except UPDATE, multi-UPDATE, INSERT, DELETE and REPLACE. Consider not
    /// using exec batch for operations outside of this list.
    fn exec_batch<'a: 'b, 'b, S, P, I>(&'a mut self, stmt: S, params_iter: I) -> BoxFuture<'b, ()>
    where
        S: StatementLike + 'b,
        I: IntoIterator<Item = P> + Send + 'b,
        I::IntoIter: Send,
        P: Into<Params> + Send;

    /// Executes the given statement and collects the first result set.
    ///
    /// It'll prepare `stmt`, if necessary.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn exec<'a: 'b, 'b, T, S, P>(&'a mut self, stmt: S, params: P) -> BoxFuture<'b, Vec<T>>
    where
        S: StatementLike + 'b,
        P: Into<Params> + Send + 'b,
        T: FromRow + Send + 'static,
    {
        async move {
            self.exec_iter(stmt, params)
                .await?
                .collect_and_drop::<T>()
                .await
        }
        .boxed()
    }

    /// Executes the given statement and returns the first row of the first result set.
    ///
    /// It'll prepare `stmt`, if necessary.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn exec_first<'a: 'b, 'b, T, S, P>(&'a mut self, stmt: S, params: P) -> BoxFuture<'b, Option<T>>
    where
        S: StatementLike + 'b,
        P: Into<Params> + Send + 'b,
        T: FromRow + Send + 'static,
    {
        async move {
            let mut result = self.exec_iter(stmt, params).await?;
            let row = if result.is_empty() {
                None
            } else {
                result.next().await?
            };
            result.drop_result().await?;
            Ok(row.map(crate::from_row))
        }
        .boxed()
    }

    /// Executes the given stmt and maps each row of the first result set.
    ///
    /// It'll prepare `stmt`, if necessary.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn exec_map<'a: 'b, 'b, T, S, P, U, F>(
        &'a mut self,
        stmt: S,
        params: P,
        mut f: F,
    ) -> BoxFuture<'b, Vec<U>>
    where
        S: StatementLike + 'b,
        P: Into<Params> + Send + 'b,
        T: FromRow + Send + 'static,
        F: FnMut(T) -> U + Send + 'a,
        U: Send + 'a,
    {
        async move {
            self.exec_fold(stmt, params, Vec::new(), |mut acc, row| {
                acc.push(f(crate::from_row(row)));
                acc
            })
            .await
        }
        .boxed()
    }

    /// Executes the given stmt and folds the first result set to a signel value.
    ///
    /// It'll prepare `stmt`, if necessary.
    ///
    /// ## Conversion
    ///
    /// This stream will convert each row into `T` using [`FromRow`] implementation.
    /// If the row type is unknown please use the [`Row`] type for `T`
    /// to make this conversion infallible.
    fn exec_fold<'a: 'b, 'b, T, S, P, U, F>(
        &'a mut self,
        stmt: S,
        params: P,
        init: U,
        mut f: F,
    ) -> BoxFuture<'b, U>
    where
        S: StatementLike + 'b,
        P: Into<Params> + Send + 'b,
        T: FromRow + Send + 'static,
        F: FnMut(U, T) -> U + Send + 'a,
        U: Send + 'a,
    {
        async move {
            self.exec_iter(stmt, params)
                .await?
                .reduce_and_drop(init, |acc, row| f(acc, crate::from_row(row)))
                .await
        }
        .boxed()
    }

    /// Executes the given statement and drops the result.
    fn exec_drop<'a: 'b, 'b, S, P>(&'a mut self, stmt: S, params: P) -> BoxFuture<'b, ()>
    where
        S: StatementLike + 'b,
        P: Into<Params> + Send + 'b,
    {
        async move { self.exec_iter(stmt, params).await?.drop_result().await }.boxed()
    }

    /// Returns a stream over the first result set.
    ///
    /// Please see [`QueryResult::stream_and_drop`][stream_and_drop].
    ///
    /// [stream_and_drop]: crate::QueryResult::stream_and_drop
    fn query_stream<'a, T, Q>(
        &'a mut self,
        query: Q,
    ) -> BoxFuture<'a, ResultSetStream<'a, 'a, 'static, T, TextProtocol>>
    where
        T: Unpin + FromRow + Send + 'static,
        Q: AsQuery + 'a,
    {
        async move {
            self.query_iter(query)
                .await?
                .stream_and_drop()
                .await
                .transpose()
                .expect("At least one result set is expected")
        }
        .boxed()
    }

    /// Returns a stream over the first result set.
    ///
    /// Please see [`QueryResult::stream_and_drop`][stream_and_drop].
    ///
    /// [stream_and_drop]: crate::QueryResult::stream_and_drop
    fn exec_stream<'a: 's, 's, T, Q, P>(
        &'a mut self,
        stmt: Q,
        params: P,
    ) -> BoxFuture<'s, ResultSetStream<'a, 'a, 'static, T, BinaryProtocol>>
    where
        T: Unpin + FromRow + Send + 'static,
        Q: StatementLike + 's,
        P: Into<Params> + Send + 's,
    {
        async move {
            self.exec_iter(stmt, params)
                .await?
                .stream_and_drop()
                .await
                .transpose()
                .expect("At least one result set is expected")
        }
        .boxed()
    }
}

impl Queryable for Conn {
    fn ping(&mut self) -> BoxFuture<'_, ()> {
        async move {
            self.routine(PingRoutine).await?;
            Ok(())
        }
        .boxed()
    }

    fn query_iter<'a, Q>(
        &'a mut self,
        query: Q,
    ) -> BoxFuture<'a, QueryResult<'a, 'static, TextProtocol>>
    where
        Q: AsQuery + 'a,
    {
        async move {
            self.raw_query::<'_, _, LevelInfo>(query).await?;
            Ok(QueryResult::new(self))
        }
        .boxed()
    }

    fn prep<'a, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Statement>
    where
        Q: AsQuery + 'a,
    {
        async move { self.get_statement(query.as_query()).await }.boxed()
    }

    fn close(&mut self, stmt: Statement) -> BoxFuture<'_, ()> {
        async move {
            self.stmt_cache_mut().remove(stmt.id());
            self.close_statement(stmt.id()).await
        }
        .boxed()
    }

    fn exec_iter<'a: 's, 's, Q, P>(
        &'a mut self,
        stmt: Q,
        params: P,
    ) -> BoxFuture<'s, QueryResult<'a, 'static, BinaryProtocol>>
    where
        Q: StatementLike + 's,
        P: Into<Params>,
    {
        let params = params.into();
        async move {
            let statement = self.get_statement(stmt).await?;
            self.execute_statement(&statement, params).await?;
            Ok(QueryResult::new(self))
        }
        .boxed()
    }

    fn exec_batch<'a: 'b, 'b, S, P, I>(&'a mut self, stmt: S, params_iter: I) -> BoxFuture<'b, ()>
    where
        S: StatementLike + 'b,
        I: IntoIterator<Item = P> + Send + 'b,
        I::IntoIter: Send,
        P: Into<Params> + Send,
    {
        async move {
            let statement = self.get_statement(stmt).await?;
            if self
                .has_mariadb_capabilities(MariadbCapabilities::MARIADB_CLIENT_STMT_BULK_OPERATIONS)
                && statement.num_params() > 0
            {
                self.execute_bulk(&statement, params_iter).await?;
            } else {
                for params in params_iter {
                    self.execute_statement(&statement, params).await?;
                    QueryResult::<BinaryProtocol>::new(&mut *self)
                        .drop_result()
                        .await?;
                }
            }
            Ok(())
        }
        .boxed()
    }
}

impl Queryable for Transaction<'_> {
    fn ping(&mut self) -> BoxFuture<'_, ()> {
        self.0.as_mut().ping()
    }

    fn query_iter<'a, Q>(
        &'a mut self,
        query: Q,
    ) -> BoxFuture<'a, QueryResult<'a, 'static, TextProtocol>>
    where
        Q: AsQuery + 'a,
    {
        self.0.as_mut().query_iter(query)
    }

    fn prep<'a, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Statement>
    where
        Q: AsQuery + 'a,
    {
        self.0.as_mut().prep(query)
    }

    fn close(&mut self, stmt: Statement) -> BoxFuture<'_, ()> {
        self.0.as_mut().close(stmt)
    }

    fn exec_iter<'a: 's, 's, Q, P>(
        &'a mut self,
        stmt: Q,
        params: P,
    ) -> BoxFuture<'s, QueryResult<'a, 'static, BinaryProtocol>>
    where
        Q: StatementLike + 's,
        P: Into<Params>,
    {
        self.0.as_mut().exec_iter(stmt, params)
    }

    fn exec_batch<'a: 'b, 'b, S, P, I>(&'a mut self, stmt: S, params_iter: I) -> BoxFuture<'b, ()>
    where
        S: StatementLike + 'b,
        I: IntoIterator<Item = P> + Send + 'b,
        I::IntoIter: Send,
        P: Into<Params> + Send,
    {
        self.0.as_mut().exec_batch(stmt, params_iter)
    }
}

impl<'c, 't: 'c> Queryable for Connection<'c, 't> {
    #[inline]
    fn ping(&mut self) -> BoxFuture<'_, ()> {
        self.as_mut().ping()
    }

    #[inline]
    fn query_iter<'a, Q>(
        &'a mut self,
        query: Q,
    ) -> BoxFuture<'a, QueryResult<'a, 'static, TextProtocol>>
    where
        Q: AsQuery + 'a,
    {
        self.as_mut().query_iter(query)
    }

    fn prep<'a, Q>(&'a mut self, query: Q) -> BoxFuture<'a, Statement>
    where
        Q: AsQuery + 'a,
    {
        self.as_mut().prep(query)
    }

    fn close(&mut self, stmt: Statement) -> BoxFuture<'_, ()> {
        self.as_mut().close(stmt)
    }

    fn exec_iter<'a: 's, 's, Q, P>(
        &'a mut self,
        stmt: Q,
        params: P,
    ) -> BoxFuture<'s, QueryResult<'a, 'static, BinaryProtocol>>
    where
        Q: StatementLike + 's,
        P: Into<Params>,
    {
        self.as_mut().exec_iter(stmt, params)
    }

    fn exec_batch<'a: 'b, 'b, S, P, I>(&'a mut self, stmt: S, params_iter: I) -> BoxFuture<'b, ()>
    where
        S: StatementLike + 'b,
        I: IntoIterator<Item = P> + Send + 'b,
        I::IntoIter: Send,
        P: Into<Params> + Send,
    {
        self.as_mut().exec_batch(stmt, params_iter)
    }
}

#[cfg(test)]
mod tests {
    use crate::{prelude::*, test_misc::get_opts, Conn};

    #[tokio::test]
    async fn should_prep() {
        const NAMED: &str = "SELECT :foo, :bar, :foo";
        const POSITIONAL: &str = "SELECT ?, ?, ?";

        let mut conn = Conn::new(get_opts()).await.unwrap();

        let stmt_named = conn.prep(NAMED).await.unwrap();
        let stmt_positional = conn.prep(POSITIONAL).await.unwrap();

        let result_stmt_named: Option<(String, u8, String)> = conn
            .exec_first(&stmt_named, params! { "foo" => "bar", "bar" => 42 })
            .await
            .unwrap();
        let result_str_named: Option<(String, u8, String)> = conn
            .exec_first(NAMED, params! { "foo" => "bar", "bar" => 42 })
            .await
            .unwrap();

        let result_stmt_positional: Option<(String, u8, String)> = conn
            .exec_first(&stmt_positional, ("bar", 42, "bar"))
            .await
            .unwrap();
        let result_str_positional: Option<(String, u8, String)> = conn
            .exec_first(NAMED, params! { "foo" => "bar", "bar" => 42 })
            .await
            .unwrap();

        assert_eq!(
            Some(("bar".to_owned(), 42_u8, "bar".to_owned())),
            result_stmt_named
        );
        assert_eq!(result_stmt_named, result_str_named);
        assert_eq!(result_str_named, result_stmt_positional);
        assert_eq!(result_stmt_positional, result_str_positional);

        conn.disconnect().await.unwrap();
    }
}
