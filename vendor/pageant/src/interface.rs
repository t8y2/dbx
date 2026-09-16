use std::pin::Pin;

use log::debug;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::Error;
#[cfg(all(windows, feature = "namedpipes"))]
use crate::namedpipes;
#[cfg(all(windows, feature = "wmmessage"))]
use crate::wmmessage;

/// Pageant transport stream (using one of the available transport implementations).
/// Implements [AsyncRead] and [AsyncWrite].
pub enum PageantStream {
    #[cfg(all(windows, feature = "wmmessage"))]
    WmMessage(wmmessage::PageantStream),
    #[cfg(all(windows, feature = "namedpipes"))]
    NamedPipes(namedpipes::PageantStream),
}

impl PageantStream {
    pub async fn new() -> Result<Self, Error> {
        let mut errors = vec![];
        // if compiled in, try the more modern named pipes approach first:
        #[cfg(all(windows, feature = "namedpipes"))]
        {
            match namedpipes::PageantStream::new().await {
                Ok(s) => {
                    return Ok(Self::NamedPipes(s));
                }
                Err(e) => {
                    debug!("Pageant NamedPipes connection failed: {e}");
                    errors.push(e);
                }
            }
        }

        #[cfg(all(windows, feature = "wmmessage"))]
        {
            match wmmessage::PageantStream::new().await {
                Ok(s) => {
                    return Ok(Self::WmMessage(s));
                }
                Err(e) => {
                    debug!("Pageant WM_Message connection failed: {e}");
                    errors.push(e);
                }
            }
        }

        if errors.len() == 1
            && let Some(err) = errors.pop()
        {
            Err(err)
        } else {
            Err(Error::Multiple(errors))
        }
    }
}

impl AsyncRead for PageantStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match &mut *self {
            #[cfg(all(windows, feature = "wmmessage"))]
            Self::WmMessage(i) => wmmessage::PageantStream::poll_read(Pin::new(i), cx, buf),
            #[cfg(all(windows, feature = "namedpipes"))]
            Self::NamedPipes(i) => namedpipes::PageantStream::poll_read(Pin::new(i), cx, buf),
        }
    }
}

impl AsyncWrite for PageantStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match &mut *self {
            #[cfg(all(windows, feature = "wmmessage"))]
            Self::WmMessage(i) => wmmessage::PageantStream::poll_write(Pin::new(i), cx, buf),
            #[cfg(all(windows, feature = "namedpipes"))]
            Self::NamedPipes(i) => namedpipes::PageantStream::poll_write(Pin::new(i), cx, buf),
        }
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match &mut *self {
            #[cfg(all(windows, feature = "wmmessage"))]
            Self::WmMessage(i) => wmmessage::PageantStream::poll_flush(Pin::new(i), cx),
            #[cfg(all(windows, feature = "namedpipes"))]
            Self::NamedPipes(i) => namedpipes::PageantStream::poll_flush(Pin::new(i), cx),
        }
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match &mut *self {
            #[cfg(all(windows, feature = "wmmessage"))]
            Self::WmMessage(i) => wmmessage::PageantStream::poll_shutdown(Pin::new(i), cx),
            #[cfg(all(windows, feature = "namedpipes"))]
            Self::NamedPipes(i) => namedpipes::PageantStream::poll_shutdown(Pin::new(i), cx),
        }
    }
}
