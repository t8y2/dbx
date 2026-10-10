// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use mysql_common::row::convert::FromRowError;

use std::{borrow::Cow, fmt, marker::PhantomData, result::Result as StdResult, sync::Arc};

use crate::{
    conn::{routines::NextSetRoutine, PendingResult},
    connection_like::Connection,
    error::*,
    prelude::{FromRow, Protocol},
    Column, Row,
};

pub mod result_set_stream;

/// Result set metadata.
#[derive(Debug, Clone, Eq, PartialEq)]
pub enum ResultSetMeta {
    /// Text result set, that may contain rows.
    Text(Arc<[Column]>),
    /// Binary result set, that may contain rows.
    Binary(Arc<[Column]>),
}

impl ResultSetMeta {
    fn columns(&self) -> &Arc<[Column]> {
        match self {
            ResultSetMeta::Text(cols) | ResultSetMeta::Binary(cols) => cols,
        }
    }
}

/// Result of a query or statement execution.
///
/// Represents an asynchronous query result, that may not be fully consumed.
///
/// # Note
///
/// Unconsumed query results are dropped implicitly when corresponding connection
/// is dropped or queried. Also note, that in this case all remaining errors will be
/// emitted to the caller:
///
/// ```rust
/// # use mysql_async::test_misc::get_opts;
/// # #[tokio::main]
/// # async fn main() -> mysql_async::Result<()> {
/// use mysql_async::*;
/// use mysql_async::prelude::*;
/// let mut conn = Conn::new(get_opts()).await?;
///
/// // second result set will contain an error,
/// // but the first result set is ok, so this line will pass
/// conn.query_iter("DO 1; BLABLA;").await?;
/// // `QueryResult` was dropped without being consumed
///
/// // driver must cleanup any unconsumed result to perform another query on `conn`,
/// // so this operation will be performed implicitly, but the unconsumed result
/// // contains an error claiming about 'BLABLA', so this error will be emitted here:
/// assert!(conn.query_iter("DO 1").await.unwrap_err().to_string().contains("BLABLA"));
///
/// # conn.disconnect().await }
/// ```
pub struct QueryResult<'a, 't: 'a, P> {
    conn: Connection<'a, 't>,
    __phantom: PhantomData<P>,
}

impl<'a, 't: 'a, P> fmt::Debug for QueryResult<'a, 't, P> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QueryResult")
            .field("conn", &self.conn)
            .field("__phantom", &"PhantomData<P>")
            .finish()
    }
}

impl<'a, 't: 'a, P> QueryResult<'a, 't, P>
where
    P: Protocol,
{
    pub fn new<T: Into<Connection<'a, 't>>>(conn: T) -> Self {
        QueryResult {
            conn: conn.into(),
            __phantom: PhantomData,
        }
    }

    /// Returns `true` if this query result may contain rows.
    ///
    /// If `false` then no rows possible for this query result (e.g. result of an UPDATE query).
    fn has_rows(&self) -> bool {
        self.conn
            .get_pending_result()
            .map(|pending_result| match pending_result {
                Some(PendingResult::Pending(meta)) => !meta.columns().is_empty(),
                Some(PendingResult::Taken(meta)) => !meta.columns().is_empty(),
                None => false,
            })
            .unwrap_or(false)
    }

    /// `true` if there are no more rows nor result sets in this query.
    ///
    /// This function will return `false` if the last result set was taken
    /// by the [`QueryResult::stream`] that was dropped before being fully consumed
    /// (i.e. caller will get `false` even if QueryResult data is reachable only for library internals).
    pub fn is_empty(&self) -> bool {
        !self.has_rows() && !self.conn.more_results_exists()
    }

    /// Low-level function that reads a result set row.
    ///
    /// Returns `None` if there are no more rows in the current set.
    async fn next_row(&mut self, columns: Arc<[Column]>) -> crate::Result<Option<Row>> {
        let mut row = None;

        if columns.is_empty() {
            // Empty, but not yet consumed result set.
            self.conn.as_mut().set_pending_result(None)?;
        } else {
            // Not yet consumed non-empty result set.
            let packet = match self.conn.as_mut().read_packet().await {
                Ok(packet) => packet,
                Err(err) => {
                    // Next row contained an error. No more data will follow.
                    self.conn.as_mut().set_pending_result(None)?;
                    return Err(err);
                }
            };

            if P::is_last_result_set_packet(self.conn.capabilities(), &packet) {
                // `packet` is a result set terminator.
                self.conn.as_mut().set_pending_result(None)?;
            } else {
                // `packet` is a result set row.
                row = Some(P::read_result_set_row(&packet, columns)?);
            }
        }

        Ok(row)
    }

    /// Low-level function that jumps to the next result set.
    ///
    /// Returns `false` if there are no more result sets.
    async fn next_set(&mut self) -> crate::Result<bool> {
        if self.conn.more_results_exists() {
            // More data will follow.
            self.conn
                .as_mut()
                .routine(NextSetRoutine::<P>::new())
                .await?;
        }
        Ok(self.conn.has_pending_result())
    }

    /// Low-level function that reads a next row and tries to jump
    /// to the next result set if the current one is exhausted.
    async fn next_row_or_next_set(&mut self, meta: ResultSetMeta) -> crate::Result<Option<Row>> {
        let columns = meta.columns().clone();

        self.next_row_or_next_set2(columns).await
    }

    /// Low-level function that reads a next row and tries to jump
    /// to the next result set if the current one is exhausted.
    async fn next_row_or_next_set2(
        &mut self,
        columns: Arc<[Column]>,
    ) -> crate::Result<Option<Row>> {
        if let Some(row) = self.next_row(columns).await? {
            Ok(Some(row))
        } else {
            self.next_set().await?;
            Ok(None)
        }
    }

    /// Skips the taken result set.
    async fn skip_taken(&mut self, meta: Arc<ResultSetMeta>) -> crate::Result<()> {
        while (self.next_row_or_next_set((*meta).clone()).await?).is_some() {}
        Ok(())
    }

    #[doc(hidden)]
    pub async fn next(&mut self) -> Result<Option<Row>> {
        loop {
            match self.conn.as_mut().use_pending_result()?.cloned() {
                Some(PendingResult::Pending(meta)) => return self.next_row_or_next_set(meta).await,
                Some(PendingResult::Taken(meta)) => self.skip_taken(meta).await?,
                None => return Ok(None),
            }
        }
    }

    /// Last insert id, if any.
    pub fn last_insert_id(&self) -> Option<u64> {
        self.conn.last_insert_id()
    }

    /// Number of affected rows as reported by the server, or `0`.
    pub fn affected_rows(&self) -> u64 {
        self.conn.affected_rows()
    }

    /// Text information as reported by the server, or an empty string.
    pub fn info(&self) -> Cow<'_, str> {
        self.conn.info()
    }

    /// Number of warnings as reported by the server, or `0`.
    pub fn warnings(&self) -> u16 {
        self.conn.get_warnings()
    }

    /// Collects the current result set of this query result.
    ///
    /// It is parametrized by `R` and internally calls `R::from_row(Row)` on each row.
    ///
    /// It will collect rows up to a nearest result set boundary. This means that you should call
    /// `collect` as many times as result sets in your query result. For example query
    /// `SELECT 'foo'; SELECT 'foo', 'bar';` will produce `QueryResult` with two result sets in it.
    /// One can use `QueryResult::is_empty` to make sure that there is no more result sets.
    ///
    /// # Panic
    ///
    /// It'll panic if any row isn't convertible to `R` (i.e. programmer error or unknown schema).
    /// * In case of programmer error see [`FromRow`] docs;
    /// * In case of unknown schema use [`QueryResult::try_collect`].
    pub async fn collect<R>(&mut self) -> Result<Vec<R>>
    where
        R: FromRow + Send + 'static,
    {
        self.reduce(Vec::new(), |mut acc, row| {
            acc.push(FromRow::from_row(row));
            acc
        })
        .await
    }

    /// Collects the current result set of this query result.
    ///
    /// It works the same way as [`QueryResult::collect`] but won't panic if row isn't convertible
    /// to `R`.
    pub async fn try_collect<R>(&mut self) -> Result<Vec<StdResult<R, FromRowError>>>
    where
        R: FromRow + Send + 'static,
    {
        self.reduce(Vec::new(), |mut acc, row| {
            acc.push(FromRow::from_row_opt(row));
            acc
        })
        .await
    }

    /// Collects the current result set of this query result and drops everything else.
    ///
    /// # Panic
    ///
    /// It'll panic if any row isn't convertible to `R` (i.e. programmer error or unknown schema).
    /// * In case of programmer error see `FromRow` docs;
    /// * In case of unknown schema use [`QueryResult::try_collect`].
    pub async fn collect_and_drop<R>(mut self) -> Result<Vec<R>>
    where
        R: FromRow + Send + 'static,
    {
        let output = self.collect::<R>().await?;
        self.drop_result().await?;
        Ok(output)
    }

    /// Collects the current result set of this query result and drops everything else.
    ///
    /// It works the same way as [`QueryResult::collect_and_drop`] but won't panic if row isn't
    /// convertible to `R`.
    pub async fn try_collect_and_drop<R>(mut self) -> Result<Vec<StdResult<R, FromRowError>>>
    where
        R: FromRow + Send + 'static,
    {
        let output = self.try_collect().await?;
        self.drop_result().await?;
        Ok(output)
    }

    /// Executes `fun` on every row of the current result set.
    ///
    /// It will stop on the nearest result set boundary (see `QueryResult::collect` docs).
    pub async fn for_each<F>(&mut self, mut fun: F) -> Result<()>
    where
        F: FnMut(Row),
    {
        if self.is_empty() {
            Ok(())
        } else {
            while let Some(row) = self.next().await? {
                fun(row);
            }
            Ok(())
        }
    }

    /// Executes `fun` on every row of the current result set and drops everything else.
    pub async fn for_each_and_drop<F>(mut self, fun: F) -> Result<()>
    where
        F: FnMut(Row),
    {
        self.for_each(fun).await?;
        self.drop_result().await?;
        Ok(())
    }

    /// Maps every row of the current result set to `U` using `fun`.
    ///
    /// It will stop on the nearest result set boundary (see `QueryResult::collect` docs).
    pub async fn map<F, U>(&mut self, mut fun: F) -> Result<Vec<U>>
    where
        F: FnMut(Row) -> U,
    {
        let mut acc = Vec::new();
        while let Some(row) = self.next().await? {
            acc.push(fun(crate::from_row(row)));
        }
        Ok(acc)
    }

    /// Map every row of the current result set to `U` using `fun` and drops everything else.
    pub async fn map_and_drop<F, U>(mut self, fun: F) -> Result<Vec<U>>
    where
        F: FnMut(Row) -> U,
    {
        let rows = self.map(fun).await?;
        self.drop_result().await?;
        Ok(rows)
    }

    /// Reduces rows of the current result set to `U` using `fun`.
    ///
    /// It will stop on the nearest result set boundary (see `QueryResult::collect` docs).
    pub async fn reduce<T, F, U>(&mut self, mut init: U, mut fun: F) -> Result<U>
    where
        F: FnMut(U, T) -> U,
        T: FromRow + Send + 'static,
    {
        while let Some(row) = self.next().await? {
            init = fun(init, crate::from_row(row));
        }
        Ok(init)
    }

    /// Reduces rows of the current result set to `U` using `fun` and drops everything else.
    pub async fn reduce_and_drop<T, F, U>(mut self, init: U, fun: F) -> Result<U>
    where
        F: FnMut(U, T) -> U,
        T: FromRow + Send + 'static,
    {
        let acc = self.reduce(init, fun).await?;
        self.drop_result().await?;
        Ok(acc)
    }

    /// Drops this query result.
    pub async fn drop_result(mut self) -> Result<()> {
        loop {
            while self.next().await?.is_some() {}
            if !self.conn.has_pending_result() {
                break Ok(());
            }
        }
    }

    /// Returns a reference to a columns list of this query result.
    ///
    /// Empty list means that this result set was never meant to contain rows.
    pub fn columns_ref(&self) -> &[Column] {
        self.conn
            .get_pending_result()
            .ok()
            .flatten()
            .map(|meta| match meta {
                PendingResult::Pending(meta) => &meta.columns()[..],
                PendingResult::Taken(meta) => &meta.columns()[..],
            })
            .unwrap_or_default()
    }

    /// Returns a copy of a columns list of this query result.
    pub fn columns(&self) -> Option<Arc<[Column]>> {
        self.conn
            .get_pending_result()
            .ok()
            .flatten()
            .map(|meta| match meta {
                PendingResult::Pending(meta) => meta.columns(),
                PendingResult::Taken(meta) => meta.columns(),
            })
            .cloned()
    }
}
