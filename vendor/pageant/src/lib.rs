//! # Pageant SSH agent transport protocol implementation
//!
//! This crate provides a [PageantStream] type that implements [AsyncRead] and [AsyncWrite] traits and can be used to talk to a running Pageant instance.
//!
//! This crate only implements the transport, not the actual SSH agent protocol.

#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

#[cfg(all(windows, target_vendor = "win7"))]
pub(crate) use windows_win7 as windows;
#[cfg(all(windows, not(target_vendor = "win7")))]
pub(crate) use windows_modern as windows;

mod error;
pub use error::*;

#[cfg(all(windows, feature = "wmmessage"))]
pub mod wmmessage;

#[cfg(all(windows, feature = "namedpipes"))]
pub mod namedpipes;

#[cfg(windows)]
mod interface;

#[cfg(windows)]
pub use interface::*;
