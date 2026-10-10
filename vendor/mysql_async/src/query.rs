// Copyright (c) 2020 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use std::borrow::Cow;

use futures_util::FutureExt;

use crate::{
    from_row,
    prelude::{FromRow, StatementLike, ToConnection},
    tracing_utils::LevelInfo,
    BinaryProtocol, BoxFuture, Params, QueryResult, ResultSetStream, TextProtocol,
};

/// Types that can be treated as a MySQL query.
///
/// This trait is implemented by all "string-ish" standard library types, like `String`, `&str`,
/// `Cow<str>`, but also all types that can be treated as a slice of bytes (such as `Vec<u8>` and
/// `&[u8]`), since MySQL does not require queries to be valid UTF-8.
pub trait AsQuery: Send + Sync {
    fn as_query(&self) -> Cow<'_, [u8]>;
}

impl AsQuery for &'_ [u8] {
    fn as_query(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(self)
    }
}

macro_rules! impl_as_query_as_ref {
    ($type: ty) => {
        impl AsQuery for $type {
            fn as_query(&self) -> Cow<'_, [u8]> {
                Cow::Borrowed(self.as_ref())
            }
        }
    };
}

impl_as_query_as_ref!(Vec<u8>);
impl_as_query_as_ref!(&Vec<u8>);
impl_as_query_as_ref!(Box<[u8]>);
impl_as_query_as_ref!(Cow<'_, [u8]>);
impl_as_query_as_ref!(std::sync::Arc<[u8]>);

macro_rules! impl_as_query_as_bytes {
    ($type: ty) => {
        impl AsQuery for $type {
            fn as_query(&self) -> Cow<'_, [u8]> {
                Cow::Borrowed(self.as_bytes())
            }
        }
    };
}

impl_as_query_as_bytes!(String);
impl_as_query_as_bytes!(&String);
impl_as_query_as_bytes!(&str);
impl_as_query_as_bytes!(Box<str>);
impl_as_query_as_bytes!(Cow<'_, str>);
impl_as_query_as_bytes!(std::sync::Arc<str>);

/// MySql text query.
///
/// This trait covers the set of `query*` methods on the `Queryable` trait.
///
/// Example:
///
/// ```rust
/// # use mysql_async::test_misc::get_opts;
/// # #[tokio::main]
/// # async fn main() -> mysql_async::Result<()> {
/// use mysql_async::*;
/// use mysql_async::prelude::*;
/// let pool = Pool::new(get_opts());
///
/// // text protocol query
/// let num: Option<u32> = "SELECT 42".first(&pool).await?;
/// assert_eq!(num, Some(42));
///
/// // binary protocol query (prepared statement)
/// let row: Option<(u32, String)> = "SELECT ?, ?".with((42, "foo")).first(&pool).await?;
/// assert_eq!(row.unwrap(), (42, "foo".into()));
///
/// # Ok(()) }
/// ```
pub trait Query: Send + Sized {
    /// Query protocol.
    type Protocol: crate::prelude::Protocol;

    /// This method corresponds to [`Queryable::query_iter`][query_iter].
    ///
    /// [query_iter]: crate::prelude::Queryable::query_iter
    fn run<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, QueryResult<'a, 't, Self::Protocol>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a;

    /// This methods corresponds to [`Queryable::query_first`][query_first].
    ///
    /// [query_first]: crate::prelude::Queryable::query_first
    fn first<'a, 't: 'a, T, C>(self, conn: C) -> BoxFuture<'a, Option<T>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
        T: FromRow + Send + 'static,
    {
        async move {
            let mut result = self.run(conn).await?;
            let output = if result.is_empty() {
                None
            } else {
                result.next().await?.map(from_row)
            };
            result.drop_result().await?;
            Ok(output)
        }
        .boxed()
    }

    /// This methods corresponds to [`Queryable::query`][query].
    ///
    /// [query]: crate::prelude::Queryable::query
    fn fetch<'a, 't: 'a, T, C>(self, conn: C) -> BoxFuture<'a, Vec<T>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
        T: FromRow + Send + 'static,
    {
        async move { self.run(conn).await?.collect_and_drop::<T>().await }.boxed()
    }

    /// This methods corresponds to [`Queryable::query_fold`][query_fold].
    ///
    /// [query_fold]: crate::prelude::Queryable::query_fold
    fn reduce<'a, 't: 'a, T, U, F, C>(self, conn: C, init: U, next: F) -> BoxFuture<'a, U>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
        F: FnMut(U, T) -> U + Send + 'a,
        T: FromRow + Send + 'static,
        U: Send + 'a,
    {
        async move { self.run(conn).await?.reduce_and_drop(init, next).await }.boxed()
    }

    /// This methods corresponds to [`Queryable::query_map`][query_map].
    ///
    /// [query_map]: crate::prelude::Queryable::query_map
    fn map<'a, 't: 'a, T, U, F, C>(self, conn: C, mut map: F) -> BoxFuture<'a, Vec<U>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
        F: FnMut(T) -> U + Send + 'a,
        T: FromRow + Send + 'static,
        U: Send + 'a,
    {
        async move {
            self.run(conn)
                .await?
                .map_and_drop(|row| map(from_row(row)))
                .await
        }
        .boxed()
    }

    /// Returns a stream over the first result set.
    ///
    /// This method corresponds to [`QueryResult::stream_and_drop`][stream_and_drop].
    ///
    /// [stream_and_drop]: crate::QueryResult::stream_and_drop
    fn stream<'a, 't: 'a, T, C>(
        self,
        conn: C,
    ) -> BoxFuture<'a, ResultSetStream<'a, 'a, 't, T, Self::Protocol>>
    where
        Self: 'a,
        Self::Protocol: Unpin,
        T: Unpin + FromRow + Send + 'static,
        C: ToConnection<'a, 't> + 'a,
    {
        async move {
            self.run(conn)
                .await?
                .stream_and_drop()
                .await
                .transpose()
                .expect("At least one result set is expected")
        }
        .boxed()
    }

    /// This method corresponds to [`Queryable::query_drop`][query_drop].
    ///
    /// [query_drop]: crate::prelude::Queryable::query_drop
    fn ignore<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, ()>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
    {
        async move { self.run(conn).await?.drop_result().await }.boxed()
    }
}

impl<Q: AsQuery> Query for Q {
    type Protocol = TextProtocol;

    fn run<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, QueryResult<'a, 't, TextProtocol>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
    {
        async move {
            let mut conn = conn.to_connection().resolve().await?;
            conn.as_mut().raw_query::<'_, _, LevelInfo>(self).await?;
            Ok(QueryResult::new(conn))
        }
        .boxed()
    }
}

/// Representation of a prepared statement query.
///
/// See `BinQuery` for details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryWithParams<Q, P> {
    pub query: Q,
    pub params: P,
}

/// Helper, that constructs [`QueryWithParams`].
pub trait WithParams: Sized {
    fn with<P>(self, params: P) -> QueryWithParams<Self, P>;
}

impl<T: StatementLike> WithParams for T {
    fn with<P>(self, params: P) -> QueryWithParams<Self, P> {
        QueryWithParams {
            query: self,
            params,
        }
    }
}

impl<Q, P> Query for QueryWithParams<Q, P>
where
    Q: StatementLike,
    P: Into<Params> + Send,
{
    type Protocol = BinaryProtocol;

    fn run<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, QueryResult<'a, 't, BinaryProtocol>>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
    {
        async move {
            let mut conn = conn.to_connection().resolve().await?;

            let statement = conn.as_mut().get_statement(self.query).await?;

            conn.as_mut()
                .execute_statement(&statement, self.params.into())
                .await?;

            Ok(QueryResult::new(conn))
        }
        .boxed()
    }
}

/// Helper trait for batch statement execution.
///
/// This trait covers the [`Queryable::exec_batch`][exec_batch] method.
///
/// Example:
///
/// ```rust
/// # use mysql_async::test_misc::get_opts;
/// # #[tokio::main]
/// # async fn main() -> mysql_async::Result<()> {
/// use mysql_async::*;
/// use mysql_async::prelude::*;
///
/// let pool = Pool::new(get_opts());
///
/// // This will prepare `DO ?` and execute `DO 0`, `DO 1`, `DO 2` and so on.
/// "DO ?"
///     .with((0..10).map(|x| (x,)))
///     .batch(&pool)
///     .await?;
/// # Ok(()) }
/// ```
///
/// [exec_batch]: crate::prelude::Queryable::exec_batch
pub trait BatchQuery {
    fn batch<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, ()>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a;
}

impl<Q, I, P> BatchQuery for QueryWithParams<Q, I>
where
    Q: StatementLike,
    I: IntoIterator<Item = P> + Send,
    I::IntoIter: Send,
    P: Into<Params> + Send,
{
    fn batch<'a, 't: 'a, C>(self, conn: C) -> BoxFuture<'a, ()>
    where
        Self: 'a,
        C: ToConnection<'a, 't> + 'a,
    {
        async move {
            let mut conn = conn.to_connection().resolve().await?;

            let statement = conn.as_mut().get_statement(self.query).await?;

            for params in self.params {
                conn.as_mut().execute_statement(&statement, params).await?;
            }

            Ok(())
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use crate::{prelude::*, test_misc::get_opts, *};

    #[tokio::test]
    async fn should_run_text_query() -> Result<()> {
        let query_static = "SELECT 1, 2 UNION ALL SELECT 3, 4; SELECT 5, 6;";
        let query_string = String::from(query_static);

        macro_rules! test {
            ($query:expr, $conn:expr) => {{
                let mut result = $query.run($conn).await?;
                let result1: Vec<(u8, u8)> = result.collect().await?;
                let result2: Vec<(u8, u8)> = result.collect().await?;
                assert_eq!(result1, vec![(1, 2), (3, 4)]);
                assert_eq!(result2, vec![(5, 6)]);

                $query.ignore($conn).await?;

                let result: Option<(u8, u8)> = $query.first($conn).await?;
                assert_eq!(result, Some((1, 2)));

                let result: Vec<(u8, u8)> = $query.fetch($conn).await?;
                assert_eq!(result, vec![(1, 2), (3, 4)]);

                let result = $query
                    .map($conn, |row: (u8, u8)| format!("{:?}", row))
                    .await?;
                assert_eq!(result, vec![String::from("(1, 2)"), String::from("(3, 4)")]);

                let result = $query
                    .reduce($conn, 0_u8, |acc, row: (u8, u8)| acc + row.0 + row.1)
                    .await?;
                assert_eq!(result, 10);
            }};
        }

        let mut conn = Conn::new(get_opts()).await?;
        test!(query_static, &mut conn);
        test!(query_string.as_str(), &mut conn);

        let mut tx = conn.start_transaction(Default::default()).await?;
        test!(query_static, &mut tx);
        test!(query_string.as_str(), &mut tx);
        tx.rollback().await?;

        conn.disconnect().await?;

        let pool = Pool::new(get_opts());
        test!(query_static, &pool);
        test!(query_string.as_str(), &pool);

        let mut tx = pool.start_transaction(Default::default()).await?;
        test!(query_static, &mut tx);
        test!(query_string.as_str(), &mut tx);
        tx.rollback().await?;

        pool.disconnect().await?;

        Ok(())
    }

    #[tokio::test]
    async fn should_run_bin_query() -> Result<()> {
        macro_rules! query {
            (@static) => {
                "SELECT ?, ? UNION ALL SELECT ?, ?"
            };
            (@string) => {
                String::from("SELECT ?, ? UNION ALL SELECT ?, ?")
            };
            (@boxed) => {
                query!(@string).into_boxed_str()
            };
            (@arc) => {
                std::sync::Arc::<str>::from(query!(@boxed))
            };
        }

        let query_string = query!(@string);
        let params_static = ("1", "2", "3", "4");
        let params_string = (
            "1".to_owned(),
            "2".to_owned(),
            "3".to_owned(),
            "4".to_owned(),
        );

        macro_rules! test {
            ($query:expr, $params:expr, $conn:expr) => {{
                let query = { $query.with($params) };
                let mut result = query.run($conn).await?;
                let result1: Vec<(u8, u8)> = result.collect().await?;
                assert_eq!(result1, vec![(1, 2), (3, 4)]);

                $query.with($params).ignore($conn).await?;

                let result: Option<(u8, u8)> = $query.with($params).first($conn).await?;
                assert_eq!(result, Some((1, 2)));

                let result: Vec<(u8, u8)> = $query.with($params).fetch($conn).await?;
                assert_eq!(result, vec![(1, 2), (3, 4)]);

                let result = $query
                    .with($params)
                    .map($conn, |row: (u8, u8)| format!("{:?}", row))
                    .await?;
                assert_eq!(result, vec![String::from("(1, 2)"), String::from("(3, 4)")]);

                let result = $query
                    .with($params)
                    .reduce($conn, 0_u8, |acc, row: (u8, u8)| acc + row.0 + row.1)
                    .await?;
                assert_eq!(result, 10);

                $query
                    .with(vec![$params, $params, $params, $params])
                    .batch($conn)
                    .await?;
            }};
        }

        let mut conn = Conn::new(get_opts()).await?;
        let statement = conn.prep(query!(@static)).await?;
        test!(query!(@static), params_static, &mut conn);
        test!(query!(@string), params_string.clone(), &mut conn);
        test!(query!(@boxed), params_string.clone(), &mut conn);
        test!(query!(@arc), params_string.clone(), &mut conn);
        test!(&query_string, params_string.clone(), &mut conn);
        test!(&statement, params_string.clone(), &mut conn);
        test!(statement.clone(), params_string.clone(), &mut conn);

        let mut tx = conn.start_transaction(Default::default()).await?;
        test!(query!(@static), params_string.clone(), &mut tx);
        test!(query!(@string), params_static, &mut tx);
        test!(&query_string, params_static, &mut tx);
        test!(&statement, params_string.clone(), &mut tx);
        test!(statement.clone(), params_string.clone(), &mut tx);
        tx.rollback().await?;

        conn.disconnect().await?;

        let pool = Pool::new(get_opts());
        test!(query!(@static), params_static, &pool);
        test!(query!(@string), params_string.clone(), &pool);
        test!(&query_string, params_string.clone(), &pool);

        let mut tx = pool.start_transaction(Default::default()).await?;
        test!(query!(@static), params_string.clone(), &mut tx);
        test!(query!(@string), params_static, &mut tx);
        test!(&query_string, params_static, &mut tx);
        tx.rollback().await?;

        pool.disconnect().await?;

        Ok(())
    }
}
