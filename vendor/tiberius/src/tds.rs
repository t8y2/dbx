pub mod codec;
mod collation;
mod context;
pub mod numeric;
pub mod stream;
pub mod time;
pub mod xml;

pub(crate) use collation::*;
pub(crate) use context::*;
pub(crate) use numeric::*;

/// The amount of bytes a packet header consists of
pub(crate) const HEADER_BYTES: usize = 8;

uint_enum! {
    /// The configured encryption level specifying if encryption is required
    #[repr(u8)]
    pub enum EncryptionLevel {
        /// Only use encryption for the login procedure
        Off = 0,
        /// Encrypt everything if possible
        On = 1,
        /// Do not encrypt anything
        NotSupported = 2,
        /// Encrypt everything and fail if not possible
        Required = 3,
    }

}
