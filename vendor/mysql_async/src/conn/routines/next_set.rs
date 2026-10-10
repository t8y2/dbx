use std::marker::PhantomData;

use futures_core::future::BoxFuture;
use futures_util::FutureExt;
#[cfg(feature = "tracing")]
use tracing::debug_span;

use crate::{queryable::Protocol, Conn};

use super::Routine;

/// A routine that handles subsequent result of a mutlti-result set.
#[derive(Debug, Clone, Copy)]
pub struct NextSetRoutine<P>(PhantomData<P>);

impl<P> NextSetRoutine<P> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
}

impl<P> Routine<()> for NextSetRoutine<P>
where
    P: Protocol,
{
    fn call<'a>(self, conn: &'a mut Conn) -> BoxFuture<'a, crate::Result<()>>
    where
        Self: 'a,
    {
        #[cfg(feature = "tracing")]
        let span = debug_span!(
            "mysql_async::next_set",
            mysql_async.connection.id = conn.id()
        );
        conn.sync_seq_id();
        let fut = async move {
            // Cached metadata can be for binary protocol only. With binary we can't have a batch prepared. Multiple results
            // are only possible with SP call. But with them we won't have metadata skipped(on 2nd or more result).
            conn.read_result_set::<P>(false, None).await?;
            Ok(())
        };

        #[cfg(feature = "tracing")]
        let fut = instrument_result!(fut, span);

        fut.boxed()
    }
}
