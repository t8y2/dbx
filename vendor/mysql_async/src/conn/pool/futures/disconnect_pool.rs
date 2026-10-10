// Copyright (c) 2016 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use std::{
    future::poll_fn,
    sync::atomic,
    task::{Context, Poll},
};

use crate::{
    conn::pool::{waitlist::QUEUE_END_ID, Pool},
    error::Error,
};

/// Disconnect this pool from a server and resolves to `()`.
///
/// **Note:** This won't resolve until all active connections, taken from the poll,
/// are dropped or disonnected. Also all pending and new `GetConn`'s will resolve to error.
pub(crate) async fn disconnect_pool(pool: Pool) -> Result<(), Error> {
    let inner = pool.inner;
    let drop = pool.drop;

    inner.close.store(true, atomic::Ordering::Release);

    let f = |cx: &mut Context| {
        let mut exchange = inner.exchange.lock().unwrap();
        exchange.spawn_futures_if_needed(&inner);
        exchange.waiting.push(cx.waker().clone(), QUEUE_END_ID);
        Poll::Ready(())
    };
    poll_fn(f).await;

    if !inner.closed.load(atomic::Ordering::Acquire) && drop.send(None).is_ok() {
        // Recycler is alive. Wait for it to finish.
        drop.closed().await;
    }

    Ok(())
}
