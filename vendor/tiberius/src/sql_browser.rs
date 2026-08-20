#[cfg(feature = "sql-browser-tokio")]
mod tokio;

#[cfg(feature = "sql-browser-async-std")]
mod async_std;

#[cfg(feature = "sql-browser-smol")]
mod smol;

use crate::client::Config;
use async_trait::async_trait;

/// An extension trait to a `TcpStream` to find a port and connecting to a
/// named database instance.
///
/// Only needed on Windows platforms, where the server port is not known and the
/// address is in the form of `hostname\\INSTANCE`.
#[async_trait]
pub trait SqlBrowser {
    /// If the given builder defines a named instance, finds the correct port
    /// and returns a `TcpStream` to be used in the [`Client`]. If instance name
    /// is not defined, connects directly to the given host and port.
    ///
    /// [`Client`]: struct.Client.html
    async fn connect_named(builder: &Config) -> crate::Result<Self>
    where
        Self: Sized + Send + Sync;
}

#[cfg(any(
    feature = "sql-browser-async-std",
    feature = "sql-browser-tokio",
    feature = "sql-browser-smol"
))]
fn get_port_from_sql_browser_reply(
    mut buf: Vec<u8>,
    len: usize,
    instance_name: &str,
) -> crate::Result<u16> {
    const DELIMITER: &[u8] = b"tcp;";

    buf.truncate(len);

    let err = crate::Error::Conversion(
        format!("Could not resolve SQL browser instance {}", instance_name).into(),
    );

    if len == 0 {
        return Err(err);
    }

    let rsp = &buf[3..len];

    let port: u16 = rsp
        .windows(DELIMITER.len())
        .rev()
        .position(|window| window == DELIMITER)
        .and_then(|pos| rsp[(rsp.len() - pos)..].split(|item| *item == b';').next())
        .ok_or(err)
        .and_then(|val| Ok(std::str::from_utf8(val)?.parse()?))?;

    Ok(port)
}
