#![cfg(feature = "native-tls-tls")]

use std::borrow::Cow;

use native_tls::Identity;

use super::PathOrBuf;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ClientIdentity {
    pkcs12_archive: PathOrBuf<'static>,
    password: Option<Cow<'static, str>>,
}

impl ClientIdentity {
    /// Creates new identity with the given pkcs12 archive.
    pub fn new(pkcs12_archive: PathOrBuf<'static>) -> Self {
        Self {
            pkcs12_archive,
            password: None,
        }
    }

    /// Sets the pkcs12 archive.
    pub fn with_pkcs12_archive(mut self, pkcs12_archive: PathOrBuf<'static>) -> Self {
        self.pkcs12_archive = pkcs12_archive;
        self
    }

    /// Sets the archive password.
    pub fn with_password<T>(mut self, pass: T) -> Self
    where
        T: Into<Cow<'static, str>>,
    {
        self.password = Some(pass.into());
        self
    }

    /// Returns the pkcs12 archive.
    pub fn pkcs12_archive(&self) -> PathOrBuf<'_> {
        self.pkcs12_archive.borrow()
    }

    /// Returns the archive password.
    pub fn password(&self) -> Option<&str> {
        self.password.as_ref().map(AsRef::as_ref)
    }

    pub(crate) async fn load(&self) -> crate::Result<Identity> {
        let der = self.pkcs12_archive.read().await?;
        let password = self.password().unwrap_or_default();
        Ok(Identity::from_pkcs12(der.as_ref(), password)?)
    }
}
