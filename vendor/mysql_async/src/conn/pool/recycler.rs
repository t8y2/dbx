// Copyright (c) 2019 mysql_async contributors
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_core::stream::Stream;
use futures_util::{stream::futures_unordered::FuturesUnordered, FutureExt};
use tokio::sync::mpsc;

use std::{
    future::Future,
    pin::Pin,
    sync::{atomic::Ordering, Arc},
    task::{Context, Poll},
};

use super::{IdlingConn, Inner};
use crate::{queryable::transaction::TxStatus, BoxFuture, Conn, PoolOpts};
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Debug)]
#[must_use = "futures do nothing unless you `.await` or poll them"]
pub(crate) struct Recycler {
    inner: Arc<Inner>,
    discard: FuturesUnordered<BoxFuture<'static, ()>>,
    discarded: usize,
    cleaning: FuturesUnordered<BoxFuture<'static, Conn>>,
    reset: FuturesUnordered<BoxFuture<'static, Conn>>,

    // Option<Conn> so that we have a way to send a "I didn't make a Conn after all" signal
    dropped: mpsc::UnboundedReceiver<Option<Conn>>,
    /// Pool options.
    pool_opts: PoolOpts,
    eof: bool,
}

impl Recycler {
    pub fn new(
        pool_opts: PoolOpts,
        inner: Arc<Inner>,
        dropped: UnboundedReceiver<Option<Conn>>,
    ) -> Self {
        Self {
            inner,
            discard: FuturesUnordered::new(),
            discarded: 0,
            cleaning: FuturesUnordered::new(),
            reset: FuturesUnordered::new(),
            dropped,
            pool_opts,
            eof: false,
        }
    }

    fn conn_return(&mut self, conn: Conn, pool_is_closed: bool) {
        let mut exchange = self.inner.exchange.lock().unwrap();
        if pool_is_closed || exchange.available.len() >= self.pool_opts.active_bound() {
            drop(exchange);
            self.inner
                .metrics
                .discarded_superfluous_connection
                .fetch_add(1, Ordering::Relaxed);
            self.discard.push(conn.close_conn().boxed());
        } else {
            self.inner
                .metrics
                .connection_returned_to_pool
                .fetch_add(1, Ordering::Relaxed);
            #[cfg(feature = "hdrhistogram")]
            self.inner
                .metrics
                .connection_active_duration
                .lock()
                .unwrap()
                .record(conn.inner.active_since.elapsed().as_micros() as u64)
                .ok();
            exchange.available.push_back(conn.into());
            self.inner
                .metrics
                .connections_in_pool
                .store(exchange.available.len(), Ordering::Relaxed);
            exchange.waiting.wake();
        }
    }

    fn conn_decision(&mut self, conn: Conn, close: bool) {
        if conn.inner.stream.is_none() || conn.inner.disconnected {
            // drop unestablished connection
            self.inner
                .metrics
                .discarded_unestablished_connection
                .fetch_add(1, Ordering::Relaxed);
            self.discard.push(futures_util::future::ok(()).boxed());
        } else if conn.inner.tx_status != TxStatus::None || conn.has_pending_result() {
            self.inner
                .metrics
                .dirty_connection_return
                .fetch_add(1, Ordering::Relaxed);
            self.cleaning.push(conn.cleanup_for_pool().boxed());
        } else if conn.expired() || close {
            self.inner
                .metrics
                .discarded_expired_connection
                .fetch_add(1, Ordering::Relaxed);
            self.discard.push(conn.close_conn().boxed());
        } else if conn.inner.reset_upon_returning_to_a_pool {
            self.inner
                .metrics
                .resetting_connection
                .fetch_add(1, Ordering::Relaxed);
            self.reset.push(conn.reset_for_pool().boxed());
        } else {
            self.conn_return(conn, false);
        }
    }
}

impl Future for Recycler {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut close = self.inner.close.load(Ordering::Acquire);

        while !self.eof {
            // see if there are more connections for us to recycle
            match Pin::new(&mut self.dropped).poll_recv(cx) {
                Poll::Ready(Some(Some(conn))) => {
                    assert!(conn.inner.pool.is_none());
                    self.conn_decision(conn, close);
                }
                Poll::Ready(Some(None)) => {
                    // someone signaled us that it's exit time
                    close = self.inner.close.load(Ordering::Acquire);
                    assert!(close);
                    continue;
                }
                Poll::Ready(None) => {
                    // no more connections are coming -- time to exit!
                    self.inner.close.store(true, Ordering::Release);
                    self.eof = true;
                    close = true;
                }
                Poll::Pending => {
                    // nope -- but let's still make progress on the ones we have
                    break;
                }
            }
        }

        // if we've been asked to close, reclaim any idle connections
        if close || self.eof {
            loop {
                let Some(IdlingConn { conn, .. }) =
                    self.inner.exchange.lock().unwrap().available.pop_front()
                else {
                    break;
                };
                assert!(conn.inner.pool.is_none());
                self.conn_decision(conn, close);
            }
        }

        // are any dirty connections ready for us to reclaim?
        loop {
            match Pin::new(&mut self.cleaning).poll_next(cx) {
                Poll::Pending | Poll::Ready(None) => break,
                Poll::Ready(Some(Ok(conn))) => self.conn_decision(conn, close),
                Poll::Ready(Some(Err(e))) => {
                    // an error occurred while cleaning a connection.
                    // what do we do? replace it with a new connection?
                    // for a conn to end up in cleaning, it must have come through .dropped.
                    // anything that comes through .dropped we know has .pool.is_none().
                    // therefore, dropping the conn won't decrement .exist, so we need to do that.
                    self.discarded += 1;
                    self.inner
                        .metrics
                        .discarded_error_during_cleanup
                        .fetch_add(1, Ordering::Relaxed);
                    // NOTE: we're discarding the error here
                    let _ = e;
                }
            }
        }

        // let's iterate through connections being successfully reset
        loop {
            match Pin::new(&mut self.reset).poll_next(cx) {
                Poll::Pending | Poll::Ready(None) => break,
                Poll::Ready(Some(Ok(conn))) => self.conn_return(conn, close),
                Poll::Ready(Some(Err(e))) => {
                    // an error during reset.
                    // replace with a new connection
                    self.discarded += 1;
                    self.inner
                        .metrics
                        .discarded_error_during_cleanup
                        .fetch_add(1, Ordering::Relaxed);
                    // NOTE: we're discarding the error here
                    let _ = e;
                }
            }
        }

        // are there any torn-down connections for us to deal with?
        loop {
            match Pin::new(&mut self.discard).poll_next(cx) {
                Poll::Pending | Poll::Ready(None) => break,
                Poll::Ready(Some(Ok(()))) => {
                    // yes! count it.
                    // note that we must decrement .exist since the connection does not have a
                    // .pool, and therefore won't do anything useful when it is dropped.
                    self.discarded += 1
                }
                Poll::Ready(Some(Err(e))) => {
                    // an error occurred while closing a connection.
                    // what do we do? we still replace it with a new connection..
                    self.discarded += 1;
                    self.inner
                        .metrics
                        .discarded_error_during_cleanup
                        .fetch_add(1, Ordering::Relaxed);
                    // NOTE: we're discarding the error here
                    let _ = e;
                }
            }
        }

        if self.discarded != 0 {
            // we need to open up slots for new connctions to be established!
            let mut exchange = self.inner.exchange.lock().unwrap();
            exchange.exist -= self.discarded;
            self.inner
                .metrics
                .connection_count
                .store(exchange.exist, Ordering::Relaxed);
            for _ in 0..self.discarded {
                exchange.waiting.wake();
            }
            drop(exchange);
            self.discarded = 0;
        }

        // NOTE: we are asserting here that no more connections will ever be returned to
        // us. see the explanation in Pool::poll_new_conn for why this is okay, even during
        // races on .exist
        let effectively_eof = close && self.inner.exchange.lock().unwrap().exist == 0;

        if (self.eof || effectively_eof)
            && self.cleaning.is_empty()
            && self.discard.is_empty()
            && self.reset.is_empty()
        {
            // we know that all Pool handles have been dropped (self.dropped.poll returned None).

            // if this assertion fails, where are the remaining connections?
            assert_eq!(self.inner.exchange.lock().unwrap().available.len(), 0);

            // NOTE: it is _necessary_ that we set this _before_ we call .wake
            // otherwise, the following may happen to the DisconnectPool future:
            //
            //  - We wake all in .wake
            //  - DisconnectPool::poll adds to .wake
            //  - DisconnectPool::poll reads .closed == false
            //  - We set .closed = true
            //
            // At this point, DisconnectPool::poll will never be notified again.
            self.inner.closed.store(true, Ordering::Release);
        }

        if self.inner.closed.load(Ordering::Acquire) {
            // `DisconnectPool` might still wait to be woken up.
            let mut exchange = self.inner.exchange.lock().unwrap();
            while exchange.waiting.wake() {}
            // we're about to exit, so there better be no outstanding connections
            assert_eq!(exchange.exist, 0);
            assert_eq!(exchange.available.len(), 0);
            drop(exchange);

            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

impl Drop for Recycler {
    fn drop(&mut self) {
        if !self.inner.closed.load(Ordering::Acquire) {
            // user did not wait for outstanding connections to finish!
            // this is not good -- we won't be able to shut down our connections cleanly
            // all we can do is try to ensure a clean shutdown
            self.inner.close.store(true, Ordering::SeqCst);
        }
    }
}
