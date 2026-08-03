use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Pageant not found")]
    NotFound,

    #[error("Buffer overflow")]
    Overflow,

    #[error("No response from Pageant")]
    NoResponse,

    #[error("Invalid Cookie")]
    InvalidCookie,

    #[error("NamedPipe keeps returning Busy")]
    PipeBusy,

    #[error("Invalid Username")]
    InvalidUsername,

    #[cfg(windows)]
    #[error(transparent)]
    WindowsError(#[from] windows::core::Error),

    #[error(transparent)]
    IoError(#[from] std::io::Error),

    #[error("Multiple Errors")]
    Multiple(Vec<Self>),
}

impl Error {
    #[cfg(windows)]
    pub(crate) fn from_win32() -> Self {
        Self::WindowsError(windows::core::Error::from_thread())
    }
}
