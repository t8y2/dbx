use std::borrow::Cow;

use futures_util::io::{AsyncRead, AsyncWrite};

use crate::{
    tds::{codec::RpcProcId, stream::TokenStream},
    Client, ColumnData, ExecuteResult, IntoSql, QueryStream,
};

/// A query object with bind parameters.
#[derive(Debug)]
pub struct Query<'a> {
    sql: Cow<'a, str>,
    params: Vec<ColumnData<'a>>,
}

impl<'a> Query<'a> {
    /// Construct a new query object with the given SQL. If the SQL is
    /// parameterized, the given number of parameters must be bound to the
    /// object before executing.
    ///
    /// The `sql` can define the parameter placement by annotating them with
    /// `@PN`, where N is the index of the parameter, starting from `1`.
    pub fn new(sql: impl Into<Cow<'a, str>>) -> Self {
        Self {
            sql: sql.into(),
            params: Vec::new(),
        }
    }

    /// Bind a new parameter to the query. Must be called exactly as many times
    /// as there are parameters in the given SQL. Otherwise the query will fail
    /// on execution.
    pub fn bind(&mut self, param: impl IntoSql<'a> + 'a) {
        self.params.push(param.into_sql());
    }

    /// Executes SQL statements in the SQL Server, returning the number rows
    /// affected. Useful for `INSERT`, `UPDATE` and `DELETE` statements. See
    /// [`Client#execute`] for a simpler API if the parameters are statically
    /// known.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use tiberius::{Config, Query};
    /// # use tokio_util::compat::TokioAsyncWriteCompatExt;
    /// # use std::env;
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// # let c_str = env::var("TIBERIUS_TEST_CONNECTION_STRING").unwrap_or(
    /// #     "server=tcp:localhost,1433;integratedSecurity=true;TrustServerCertificate=true".to_owned(),
    /// # );
    /// # let config = Config::from_ado_string(&c_str)?;
    /// # let tcp = tokio::net::TcpStream::connect(config.get_addr()).await?;
    /// # tcp.set_nodelay(true)?;
    /// # let mut client = tiberius::Client::connect(config, tcp.compat_write()).await?;
    /// let mut query = Query::new("INSERT INTO ##Test (id) VALUES (@P1), (@P2), (@P3)");
    ///
    /// query.bind("foo");
    /// query.bind(2i32);
    /// query.bind(String::from("bar"));
    ///
    /// let results = query.execute(&mut client).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// [`ToSql`]: trait.ToSql.html
    /// [`FromSql`]: trait.FromSql.html
    /// [`Client#execute`]: struct.Client.html#method.execute
    pub async fn execute<'b, S>(self, client: &'b mut Client<S>) -> crate::Result<ExecuteResult>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        client.connection.flush_stream().await?;

        let rpc_params = Client::<S>::rpc_params(self.sql);

        client
            .rpc_perform_query(RpcProcId::ExecuteSQL, rpc_params, self.params.into_iter())
            .await?;

        ExecuteResult::new(&mut client.connection).await
    }

    /// Executes SQL statements in the SQL Server, returning resulting rows.
    /// Useful for `SELECT` statements. See [`Client#query`] for a simpler API
    /// if the parameters are statically known.
    ///
    /// # Example
    ///
    /// ```
    /// # use tiberius::{Config, Query};
    /// # use tokio_util::compat::TokioAsyncWriteCompatExt;
    /// # use std::env;
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// # let c_str = env::var("TIBERIUS_TEST_CONNECTION_STRING").unwrap_or(
    /// #     "server=tcp:localhost,1433;integratedSecurity=true;TrustServerCertificate=true".to_owned(),
    /// # );
    /// # let config = Config::from_ado_string(&c_str)?;
    /// # let tcp = tokio::net::TcpStream::connect(config.get_addr()).await?;
    /// # tcp.set_nodelay(true)?;
    /// # let mut client = tiberius::Client::connect(config, tcp.compat_write()).await?;
    /// let mut query = Query::new("SELECT @P1, @P2, @P3");
    ///
    /// query.bind(1i32);
    /// query.bind(2i32);
    /// query.bind(3i32);
    ///
    /// let stream = query.query(&mut client).await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// [`QueryStream`]: struct.QueryStream.html
    /// [`ToSql`]: trait.ToSql.html
    /// [`FromSql`]: trait.FromSql.html
    /// [`Client#query`]: struct.Client.html#method.query
    pub async fn query<'b, S>(self, client: &'b mut Client<S>) -> crate::Result<QueryStream<'b>>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        client.connection.flush_stream().await?;
        let rpc_params = Client::<S>::rpc_params(self.sql);

        client
            .rpc_perform_query(RpcProcId::ExecuteSQL, rpc_params, self.params.into_iter())
            .await?;

        let ts = TokenStream::new(&mut client.connection);
        let mut result = QueryStream::new(ts.try_unfold());
        result.forward_to_metadata().await?;

        Ok(result)
    }
}
