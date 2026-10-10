use tokio_native_tls::native_tls::{self, Certificate};

use crate::io::Endpoint;
use crate::{Result, SslOpts};

pub use tokio_native_tls::TlsConnector;

impl SslOpts {
    async fn load_root_certs(&self) -> crate::Result<Vec<Certificate>> {
        let mut output = Vec::new();

        for root_cert in self.root_certs() {
            let root_cert_data = root_cert.read().await?;
            output.extend(parse_certs(root_cert_data.as_ref())?);
        }

        Ok(output)
    }

    pub(crate) async fn build_tls_connector(&self) -> Result<TlsConnector> {
        let mut builder = native_tls::TlsConnector::builder();
        for root_cert in self.load_root_certs().await? {
            builder.add_root_certificate(root_cert);
        }

        if let Some(client_identity) = self.client_identity() {
            builder.identity(client_identity.load().await?);
        }
        builder.danger_accept_invalid_hostnames(self.skip_domain_validation());
        builder.danger_accept_invalid_certs(self.accept_invalid_certs());
        builder.disable_built_in_roots(self.disable_built_in_roots());
        let tls_connector: TlsConnector = builder.build()?.into();
        Ok(tls_connector)
    }
}

impl Endpoint {
    pub async fn make_secure(
        &mut self,
        domain: String,
        tls_connector: &TlsConnector,
    ) -> Result<()> {
        #[cfg(unix)]
        if self.is_socket() {
            // won't secure socket connection
            return Ok(());
        }

        *self = match self {
            Endpoint::Plain(ref mut stream) => {
                let stream = stream.take().unwrap();
                let tls_stream = tls_connector.connect(&domain, stream).await?;
                Endpoint::Secure(tls_stream)
            }
            Endpoint::Secure(_) => unreachable!(),
            #[cfg(unix)]
            Endpoint::Socket(_) => unreachable!(),
        };

        Ok(())
    }
}

fn parse_certs(buf: &[u8]) -> Result<Vec<Certificate>> {
    Ok(Certificate::from_der(buf).map(|x| vec![x]).or_else(|_| {
        pem::parse_many(buf)
            .unwrap_or_default()
            .iter()
            .map(pem::encode)
            .map(|s| Certificate::from_pem(s.as_bytes()))
            .collect()
    })?)
}
