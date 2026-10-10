// Copyright (c) 2019 Anatoly Ikorsky
//
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0> or the MIT
// license <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. All files in the project carrying such notice may not be copied,
// modified, or distributed except according to those terms.

#![cfg(unix)]

use tokio::io::{Error, ErrorKind::Interrupted, ReadBuf};

use std::{
    io,
    path::Path,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite};

/// Unix domain socket connection on unix, or named pipe connection on windows.
#[derive(Debug)]
pub(crate) struct Socket {
    #[cfg(unix)]
    inner: tokio::net::UnixStream,
}

impl Socket {
    /// Connects a new socket.
    #[cfg(unix)]
    pub async fn new<P: AsRef<Path>>(path: P) -> Result<Socket, io::Error> {
        Ok(Socket {
            inner: tokio::net::UnixStream::connect(path).await?,
        })
    }
}

impl AsyncRead for Socket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<Result<(), Error>> {
        with_interrupted!(Pin::new(&mut self.inner).poll_read(cx, buf))
    }
}

impl AsyncWrite for Socket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context,
        buf: &[u8],
    ) -> Poll<Result<usize, Error>> {
        with_interrupted!(Pin::new(&mut self.inner).poll_write(cx, buf))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), Error>> {
        with_interrupted!(Pin::new(&mut self.inner).poll_flush(cx))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), Error>> {
        with_interrupted!(Pin::new(&mut self.inner).poll_shutdown(cx))
    }
}
