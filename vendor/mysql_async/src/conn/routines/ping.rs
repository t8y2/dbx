use futures_core::future::BoxFuture;
use futures_util::FutureExt;
use mysql_common::constants::Command;
#[cfg(feature = "tracing")]
use tracing::debug_span;

use crate::Conn;

use super::Routine;

/// A routine that executes `COM_PING`.
#[derive(Debug, Copy, Clone)]
pub struct PingRoutine;

impl Routine<()> for PingRoutine {
    fn call<'a>(self, conn: &'a mut Conn) -> BoxFuture<'a, crate::Result<()>>
    where
        Self: 'a,
    {
        #[cfg(feature = "tracing")]
        let span = debug_span!("mysql_async::ping", mysql_async.connection.id = conn.id());

        let fut = async move {
            conn.write_command_data(Command::COM_PING, &[]).await?;
            conn.read_packet().await?;
            Ok(())
        };

        #[cfg(feature = "tracing")]
        let fut = instrument_result!(fut, span);

        fut.boxed()
    }
}
