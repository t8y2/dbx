use std::{borrow::Cow, sync::Arc};

use futures_core::future::BoxFuture;
use futures_util::FutureExt;
use mysql_common::constants::Command;
#[cfg(feature = "tracing")]
use tracing::{field, info_span, Level, Span};

use crate::{queryable::stmt::StmtInner, Conn};

use super::Routine;

/// A routine that performs `COM_STMT_PREPARE`.
#[derive(Debug, Clone)]
pub struct PrepareRoutine {
    query: Arc<[u8]>,
}

impl PrepareRoutine {
    pub fn new(raw_query: Cow<'_, [u8]>) -> Self {
        Self {
            query: raw_query.into_owned().into_boxed_slice().into(),
        }
    }
}

impl Routine<Arc<StmtInner>> for PrepareRoutine {
    fn call<'a>(self, conn: &'a mut Conn) -> BoxFuture<'a, crate::Result<Arc<StmtInner>>>
    where
        Self: 'a,
    {
        #[cfg(feature = "tracing")]
        let span = info_span!(
            "mysql_async::prepare",
            mysql_async.connection.id = conn.id(),
            mysql_async.statement.id = field::Empty,
            mysql_async.query.sql = field::Empty,
        );
        #[cfg(feature = "tracing")]
        if tracing::span_enabled!(Level::DEBUG) {
            // The statement may contain sensitive data. Restrict to DEBUG.
            span.record(
                "mysql_async.query.sql",
                String::from_utf8_lossy(&self.query).as_ref(),
            );
        }

        let fut = async move {
            conn.write_command_data(Command::COM_STMT_PREPARE, &self.query)
                .await?;

            let packet = conn.read_packet().await?;
            let mut inner_stmt = StmtInner::from_payload(&packet, conn.id(), self.query.clone())?;

            #[cfg(feature = "tracing")]
            Span::current().record("mysql_async.statement.id", inner_stmt.id());

            if inner_stmt.num_params() > 0 {
                let params = conn.read_column_defs(inner_stmt.num_params()).await?;
                inner_stmt = inner_stmt.with_params(params);
            }

            if inner_stmt.num_columns() > 0 {
                let columns = conn.read_column_defs(inner_stmt.num_columns()).await?;
                inner_stmt = inner_stmt.with_columns(columns);
            }

            Ok(Arc::new(inner_stmt))
        };

        #[cfg(feature = "tracing")]
        let fut = instrument_result!(fut, span);

        fut.boxed()
    }
}
