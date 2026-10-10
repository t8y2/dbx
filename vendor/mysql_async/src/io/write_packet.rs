// Copyright (c) 2017 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

use futures_core::ready;
use futures_sink::Sink;

use std::{
    future::Future,
    io::{Error, ErrorKind::UnexpectedEof},
    pin::Pin,
    task::{Context, Poll},
};

use crate::{buffer_pool::PooledBuf, connection_like::Connection, error::IoError};

/// Writes a packet.
#[derive(Debug)]
#[must_use = "futures do nothing unless you `.await` or poll them"]
pub struct WritePacket<'a, 't> {
    conn: Connection<'a, 't>,
    data: Option<PooledBuf>,
}

impl<'a, 't> WritePacket<'a, 't> {
    pub(crate) fn new<T: Into<Connection<'a, 't>>>(conn: T, data: PooledBuf) -> Self {
        Self {
            conn: conn.into(),
            data: Some(data),
        }
    }
}

impl Future for WritePacket<'_, '_> {
    type Output = std::result::Result<(), IoError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let Self {
            ref mut conn,
            ref mut data,
        } = *self;

        match conn.as_mut().stream_mut() {
            Ok(stream) => {
                if data.is_some() {
                    let codec = Pin::new(stream.codec.as_mut().expect("must be here"));
                    ready!(codec.poll_ready(cx))?;
                }

                if let Some(data) = data.take() {
                    let codec = Pin::new(stream.codec.as_mut().expect("must be here"));
                    // to get here, stream must be ready
                    codec.start_send(data)?;
                }

                let codec = Pin::new(stream.codec.as_mut().expect("must be here"));

                ready!(codec.poll_flush(cx))?;

                Poll::Ready(Ok(()))
            }
            Err(err) => Poll::Ready(Err(Error::new(UnexpectedEof, err).into())),
        }
    }
}
