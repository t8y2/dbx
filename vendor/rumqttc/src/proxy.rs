use crate::eventloop::socket_connect;
use crate::framed::N;
use crate::NetworkOptions;

use std::io;

#[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
use crate::{tls, TlsConfiguration};

#[derive(Clone, Debug)]
pub struct Proxy {
    pub ty: ProxyType,
    pub auth: ProxyAuth,
    pub addr: String,
    pub port: u16,
}

#[derive(Clone, Debug)]
pub enum ProxyType {
    Http,
    #[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
    Https(TlsConfiguration),
}

#[derive(Clone, Debug)]
pub enum ProxyAuth {
    None,
    Basic { username: String, password: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("Socket connect: {0}.")]
    Io(#[from] io::Error),
    #[error("Proxy connect: {0}.")]
    Proxy(#[from] async_http_proxy::HttpError),

    #[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
    #[error("Tls connect: {0}.")]
    Tls(#[from] tls::Error),
}

impl Proxy {
    pub(crate) async fn connect(
        self,
        broker_addr: &str,
        broker_port: u16,
        network_options: NetworkOptions,
    ) -> Result<Box<dyn N>, ProxyError> {
        let proxy_addr = format!("{}:{}", self.addr, self.port);

        let tcp: Box<dyn N> = Box::new(socket_connect(proxy_addr, network_options).await?);
        let mut tcp = match self.ty {
            ProxyType::Http => tcp,
            #[cfg(any(feature = "use-rustls", feature = "use-native-tls"))]
            ProxyType::Https(tls_config) => {
                tls::tls_connect(&self.addr, self.port, &tls_config, tcp).await?
            }
        };
        self.auth.auth(broker_addr, broker_port, &mut tcp).await?;
        Ok(tcp)
    }
}

impl ProxyAuth {
    async fn auth(
        self,
        host: &str,
        port: u16,
        tcp_stream: &mut Box<dyn N>,
    ) -> Result<(), ProxyError> {
        match self {
            Self::None => async_http_proxy::http_connect_tokio(tcp_stream, host, port).await?,
            Self::Basic { username, password } => {
                async_http_proxy::http_connect_tokio_with_basic_auth(
                    tcp_stream, host, port, &username, &password,
                )
                .await?
            }
        }
        Ok(())
    }
}
