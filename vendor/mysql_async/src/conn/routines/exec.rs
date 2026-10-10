use futures_core::future::BoxFuture;
use futures_util::FutureExt;
use mysql_common::{
    packets::{ComStmtBulkExecuteRequestBuilder, ComStmtExecuteRequestBuilder},
    params::Params,
};
#[cfg(feature = "tracing")]
use tracing::{field, info_span, Level, Span};

use crate::{
    conn::MAX_STATEMENT_PARAMS, BinaryProtocol, Conn, DriverError, QueryResult, Statement,
};

use super::Routine;

/// A routine that executes `COM_STMT_EXECUTE`.
#[derive(Debug, Clone)]
pub struct ExecRoutine<'a> {
    stmt: &'a Statement,
    params: Params,
}

impl<'a> ExecRoutine<'a> {
    pub fn new(stmt: &'a Statement, params: Params) -> Self {
        Self { stmt, params }
    }
}

impl Routine<()> for ExecRoutine<'_> {
    fn call<'a>(self, conn: &'a mut Conn) -> BoxFuture<'a, crate::Result<()>>
    where
        Self: 'a,
    {
        #[cfg(feature = "tracing")]
        let span = info_span!(
            "mysql_async::exec",
            mysql_async.connection.id = conn.id(),
            mysql_async.statement.id = self.stmt.id(),
            mysql_async.query.params = field::Empty,
        );

        let stmt_id = self.stmt.id();
        let expected_num_params = self.stmt.num_params();
        let params = self
            .params
            .into_values(Some(self.stmt.named_params.as_slice()).filter(|x| !x.is_empty()));

        let fut = async move {
            let params = params?;
            #[cfg(feature = "tracing")]
            if tracing::span_enabled!(Level::DEBUG) {
                // The params may contain sensitive data. Restrict to DEBUG.
                // TODO: make more efficient
                // TODO: use intersperse() once stable
                let sep = std::iter::repeat(", ");
                let ps = params
                    .iter()
                    .map(|p| p.as_sql(true))
                    .zip(sep)
                    .map(|(val, sep)| val + sep)
                    .collect::<String>();
                Span::current().record("mysql_async.query.params", ps);
            }

            if params.len() > MAX_STATEMENT_PARAMS {
                Err(DriverError::StmtParamsNumberExceedsLimit {
                    supplied: params.len(),
                })?
            }

            if expected_num_params as usize != params.len() {
                Err(DriverError::StmtParamsMismatch {
                    required: expected_num_params,
                    supplied: params.len(),
                })?
            }

            let (body, as_long_data) = ComStmtExecuteRequestBuilder::new(stmt_id).build(&params);

            if as_long_data {
                conn.send_long_data(stmt_id, params.iter()).await?;
            }

            conn.write_command(&body).await?;
            conn.read_result_set::<BinaryProtocol>(true, Some(self.stmt))
                .await?;

            Ok(())
        };

        #[cfg(feature = "tracing")]
        let fut = instrument_result!(fut, span);

        fut.boxed()
    }
}

/// A routine that executes `COM_STMT_BULK_EXECUTE` (MariaDb feature).
#[derive(Debug, Clone)]
pub struct ExecBulkRoutine<'a, I> {
    stmt: &'a Statement,
    params_iter: I,
}

impl<'a, I> ExecBulkRoutine<'a, I> {
    pub fn new(stmt: &'a Statement, params: I) -> Self {
        Self {
            stmt,
            params_iter: params,
        }
    }
}

impl<P: Into<Params>, I: IntoIterator<Item = P> + Send> Routine<()> for ExecBulkRoutine<'_, I>
where
    <I as IntoIterator>::IntoIter: Send,
{
    fn call<'a>(self, conn: &'a mut Conn) -> BoxFuture<'a, crate::Result<()>>
    where
        Self: 'a,
    {
        let Self {
            stmt,
            params_iter: params,
        } = self;

        #[cfg(feature = "tracing")]
        let span = info_span!(
            "mysql_async::exec",
            mysql_async.connection.id = conn.id(),
            mysql_async.statement.id = stmt.id(),
            mysql_async.query.params = field::Empty,
        );

        // TODO: MariadbCapabilities::MARIADB_CLIENT_BULK_UNIT_RESULTS

        let fut = async move {
            let stmt_id = stmt.id();
            let max_allowed_packet = conn.stream_ref()?.get_max_allowed_packet();
            let mut builder = ComStmtBulkExecuteRequestBuilder::new(stmt_id, max_allowed_packet)
                .with_named_params(Some(stmt.named_params.as_slice()).filter(|x| !x.is_empty()));

            for command in builder.build_params_iter(params) {
                let command = command.map_err(crate::DriverError::from)?;
                conn.write_command(&command).await?;
                conn.read_result_set::<BinaryProtocol>(true, Some(stmt))
                    .await?;
                let query_result = QueryResult::<'_, '_, BinaryProtocol>::new(&mut *conn);
                query_result.drop_result().await?;
            }

            Ok(())
        };

        #[cfg(feature = "tracing")]
        let fut = instrument_result!(fut, span);

        fut.boxed()
    }
}
