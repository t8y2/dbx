pub use crate::tds::stream::{QueryItem, ResultMetadata};
use crate::{
    client::Connection,
    tds::stream::{ReceivedToken, TokenStream},
};
use futures_util::io::{AsyncRead, AsyncWrite};
use futures_util::stream::TryStreamExt;
use std::fmt::Debug;

/// A result from a query execution, listing the number of affected rows.
///
/// If executing multiple queries, the resulting counts will be come separately,
/// marking the rows affected for each query.
///
/// # Example
///
/// ```no_run
/// # use tiberius::Config;
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
/// let result = client
///     .execute(
///         "INSERT INTO #Test (id) VALUES (@P1); INSERT INTO #Test (id) VALUES (@P2, @P3)",
///         &[&1i32, &2i32, &3i32],
///     )
///     .await?;
///
/// assert_eq!(&[1, 2], result.rows_affected());
/// # Ok(())
/// # }
/// ```
///
/// [`Client`]: struct.Client.html
/// [`Rows`]: struct.Row.html
/// [`next_resultset`]: #method.next_resultset
#[derive(Debug)]
pub struct ExecuteResult {
    rows_affected: Vec<u64>,
}

impl<'a> ExecuteResult {
    pub(crate) async fn new<S: AsyncRead + AsyncWrite + Unpin + Send>(
        connection: &'a mut Connection<S>,
    ) -> crate::Result<Self> {
        let mut token_stream = TokenStream::new(connection).try_unfold();
        let mut rows_affected = Vec::new();

        while let Some(token) = token_stream.try_next().await? {
            match token {
                ReceivedToken::DoneProc(done) if done.is_final() => (),
                ReceivedToken::DoneProc(done) => rows_affected.push(done.rows()),
                ReceivedToken::DoneInProc(done) => rows_affected.push(done.rows()),
                ReceivedToken::Done(done) => rows_affected.push(done.rows()),
                _ => (),
            }
        }

        Ok(Self { rows_affected })
    }

    /// A slice of numbers of rows affected in the same order as the given
    /// queries.
    pub fn rows_affected(&self) -> &[u64] {
        self.rows_affected.as_slice()
    }

    /// Aggregates all resulting row counts into a sum.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use tiberius::Config;
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
    /// let rows_affected = client
    ///     .execute(
    ///         "INSERT INTO #Test (id) VALUES (@P1); INSERT INTO #Test (id) VALUES (@P2, @P3)",
    ///         &[&1i32, &2i32, &3i32],
    ///     )
    ///     .await?;
    ///
    /// assert_eq!(3, rows_affected.total());
    /// # Ok(())
    /// # }
    pub fn total(self) -> u64 {
        self.rows_affected.into_iter().sum()
    }
}

impl IntoIterator for ExecuteResult {
    type Item = u64;
    type IntoIter = std::vec::IntoIter<Self::Item>;

    fn into_iter(self) -> Self::IntoIter {
        self.rows_affected.into_iter()
    }
}
