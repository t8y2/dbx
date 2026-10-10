#[cfg(feature = "native-tls-tls")]
mod native_tls_io;
#[cfg(not(any(feature = "rustls-tls", feature = "native-tls-tls")))]
mod no_tls;
#[cfg(feature = "rustls-tls")]
mod rustls_io;

#[cfg(feature = "native-tls-tls")]
pub(crate) use self::native_tls_io::TlsConnector;
#[cfg(not(any(feature = "rustls-tls", feature = "native-tls-tls")))]
pub(crate) use self::no_tls::TlsConnector;
#[cfg(feature = "rustls-tls")]
pub(crate) use self::rustls_io::TlsConnector;
