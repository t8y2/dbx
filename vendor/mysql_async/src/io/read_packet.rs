// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_core::{ready, stream::Stream};

use std::{
    future::Future,
    io::{Error, ErrorKind},
    pin::Pin,
    task::{Context, Poll},
};

use crate::{buffer_pool::PooledBuf, connection_like::Connection, error::IoError};

/// Reads a packet.
#[derive(Debug)]
#[must_use = "futures do nothing unless you `.await` or poll them"]
pub struct ReadPacket<'a, 't>(pub(crate) Connection<'a, 't>);

impl<'a, 't> ReadPacket<'a, 't> {
    pub(crate) fn new<T: Into<Connection<'a, 't>>>(conn: T) -> Self {
        Self(conn.into())
    }

    #[cfg(feature = "binlog")]
    pub(crate) fn conn_ref(&self) -> &crate::Conn {
        &self.0
    }
}

impl Future for ReadPacket<'_, '_> {
    type Output = std::result::Result<PooledBuf, IoError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let packet_opt = match self.0.as_mut().stream_mut() {
            Ok(stream) => ready!(Pin::new(stream).poll_next(cx)).transpose()?,
            // `ConnectionClosed` error.
            Err(_) => None,
        };

        match packet_opt {
            Some(packet) => {
                self.0.as_mut().touch();
                Poll::Ready(Ok(packet))
            }
            None => Poll::Ready(Err(Error::new(
                ErrorKind::UnexpectedEof,
                "connection closed",
            )
            .into())),
        }
    }
}
