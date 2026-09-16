mod ado_net;
mod jdbc;

use std::collections::HashMap;
use std::path::PathBuf;

use super::AuthMethod;
use crate::EncryptionLevel;
use ado_net::*;
use jdbc::*;

#[derive(Clone, Debug)]
/// The `Config` struct contains all configuration information
/// required for connecting to the database with a [`Client`]. It also provides
/// the server address when connecting to a `TcpStream` via the
/// [`get_addr`] method.
///
/// When using an [ADO.NET connection string], it can be
/// constructed using the [`from_ado_string`] function.
///
/// [`Client`]: struct.Client.html
/// [ADO.NET connection string]: https://docs.microsoft.com/en-us/dotnet/framework/data/adonet/connection-strings
/// [`from_ado_string`]: struct.Config.html#method.from_ado_string
/// [`get_addr`]: struct.Config.html#method.get_addr
pub struct Config {
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) database: Option<String>,
    pub(crate) instance_name: Option<String>,
    pub(crate) application_name: Option<String>,
    pub(crate) encryption: EncryptionLevel,
    pub(crate) trust: TrustConfig,
    pub(crate) auth: AuthMethod,
    pub(crate) readonly: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum TrustConfig {
    #[allow(dead_code)]
    CaCertificateLocation(PathBuf),
    TrustAll,
    Default,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: None,
            port: None,
            database: None,
            instance_name: None,
            application_name: None,
            #[cfg(any(
                feature = "rustls",
                feature = "native-tls",
                feature = "vendored-openssl"
            ))]
            encryption: EncryptionLevel::Required,
            #[cfg(not(any(
                feature = "rustls",
                feature = "native-tls",
                feature = "vendored-openssl"
            )))]
            encryption: EncryptionLevel::NotSupported,
            trust: TrustConfig::Default,
            auth: AuthMethod::None,
            readonly: false,
        }
    }
}

impl Config {
    /// Create a new `Config` with the default settings.
    pub fn new() -> Self {
        Self::default()
    }

    /// A host or ip address to connect to.
    ///
    /// - Defaults to `localhost`.
    pub fn host(&mut self, host: impl ToString) {
        self.host = Some(host.to_string());
    }

    /// The server port.
    ///
    /// - Defaults to `1433`.
    pub fn port(&mut self, port: u16) {
        self.port = Some(port);
    }

    /// The database to connect to.
    ///
    /// - Defaults to `master`.
    pub fn database(&mut self, database: impl ToString) {
        self.database = Some(database.to_string())
    }

    /// The instance name as defined in the SQL Browser. Only available on
    /// Windows platforms.
    ///
    /// If specified, the port is replaced with the value returned from the
    /// browser.
    ///
    /// - Defaults to no name specified.
    pub fn instance_name(&mut self, name: impl ToString) {
        self.instance_name = Some(name.to_string());
    }

    /// Sets the application name to the connection, queryable with the
    /// `APP_NAME()` command.
    ///
    /// - Defaults to no name specified.
    pub fn application_name(&mut self, name: impl ToString) {
        self.application_name = Some(name.to_string());
    }

    /// Set the preferred encryption level.
    ///
    /// - With `tls` feature, defaults to `Required`.
    /// - Without `tls` feature, defaults to `NotSupported`.
    pub fn encryption(&mut self, encryption: EncryptionLevel) {
        self.encryption = encryption;
    }

    /// If set, the server certificate will not be validated and it is accepted
    /// as-is.
    ///
    /// On production setting, the certificate should be added to the local key
    /// storage (or use `trust_cert_ca` instead), using this setting is potentially dangerous.
    ///
    /// # Panics
    /// Will panic in case `trust_cert_ca` was called before.
    ///
    /// - Defaults to `default`, meaning server certificate is validated against system-truststore.
    pub fn trust_cert(&mut self) {
        if let TrustConfig::CaCertificateLocation(_) = &self.trust {
            panic!("'trust_cert' and 'trust_cert_ca' are mutual exclusive! Only use one.")
        }
        self.trust = TrustConfig::TrustAll;
    }

    /// If set, the server certificate will be validated against the given CA certificate in
    /// in addition to the system-truststore.
    /// Useful when using self-signed certificates on the server without having to disable the
    /// trust-chain.
    ///
    /// # Panics
    /// Will panic in case `trust_cert` was called before.
    ///
    /// - Defaults to validating the server certificate is validated against system's certificate storage.
    pub fn trust_cert_ca(&mut self, path: impl ToString) {
        if let TrustConfig::TrustAll = &self.trust {
            panic!("'trust_cert' and 'trust_cert_ca' are mutual exclusive! Only use one.")
        } else {
            self.trust = TrustConfig::CaCertificateLocation(PathBuf::from(path.to_string()))
        }
    }

    /// Sets the authentication method.
    ///
    /// - Defaults to `None`.
    pub fn authentication(&mut self, auth: AuthMethod) {
        self.auth = auth;
    }

    /// Sets ApplicationIntent readonly.
    ///
    /// - Defaults to `false`.
    pub fn readonly(&mut self, readnoly: bool) {
        self.readonly = readnoly;
    }

    pub(crate) fn get_host(&self) -> &str {
        self.host
            .as_deref()
            .filter(|v| v != &".")
            .unwrap_or("localhost")
    }

    pub(crate) fn get_port(&self) -> u16 {
        match (self.port, self.instance_name.as_ref()) {
            // A user-defined port, we must use that.
            (Some(port), _) => port,
            // If using a named instance, we'll give the default port of SQL
            // Browser.
            (None, Some(_)) => 1434,
            // Otherwise the defaulting to the default SQL Server port.
            (None, None) => 1433,
        }
    }

    /// Get the host address including port
    pub fn get_addr(&self) -> String {
        format!("{}:{}", self.get_host(), self.get_port())
    }

    /// Creates a new `Config` from an [ADO.NET connection string].
    ///
    /// # Supported parameters
    ///
    /// All parameter keys are handled case-insensitive.
    ///
    /// |Parameter|Allowed values|Description|
    /// |--------|--------|--------|
    /// |`server`|`<string>`|The name or network address of the instance of SQL Server to which to connect. The port number can be specified after the server name. The correct form of this parameter is either `tcp:host,port` or `tcp:host\\instance`|
    /// |`IntegratedSecurity`|`true`,`false`,`yes`,`no`|Toggle between Windows/Kerberos authentication and SQL authentication.|
    /// |`uid`,`username`,`user`,`user id`|`<string>`|The SQL Server login account.|
    /// |`password`,`pwd`|`<string>`|The password for the SQL Server account logging on.|
    /// |`database`|`<string>`|The name of the database.|
    /// |`TrustServerCertificate`|`true`,`false`,`yes`,`no`|Specifies whether the driver trusts the server certificate when connecting using TLS. Cannot be used toghether with `TrustServerCertificateCA`|
    /// |`TrustServerCertificateCA`|`<path>`|Path to a `pem`, `crt` or `der` certificate file. Cannot be used together with `TrustServerCertificate`|
    /// |`encrypt`|`true`,`false`,`yes`,`no`,`DANGER_PLAINTEXT`|Specifies whether the driver uses TLS to encrypt communication.|
    /// |`Application Name`, `ApplicationName`|`<string>`|Sets the application name for the connection.|
    ///
    /// [ADO.NET connection string]: https://docs.microsoft.com/en-us/dotnet/framework/data/adonet/connection-strings
    pub fn from_ado_string(s: &str) -> crate::Result<Self> {
        let ado: AdoNetConfig = s.parse()?;
        Self::from_config_string(ado)
    }

    /// Creates a new `Config` from a [JDBC connection string].
    ///
    /// See [`from_ado_string`] method for supported parameters.
    ///
    /// [JDBC connection string]: https://docs.microsoft.com/en-us/sql/connect/jdbc/building-the-connection-url?view=sql-server-ver15
    /// [`from_ado_string`]: #method.from_ado_string
    pub fn from_jdbc_string(s: &str) -> crate::Result<Self> {
        let jdbc: JdbcConfig = s.parse()?;
        Self::from_config_string(jdbc)
    }

    fn from_config_string(s: impl ConfigString) -> crate::Result<Self> {
        let mut builder = Self::new();

        let server = s.server()?;

        if let Some(host) = server.host {
            builder.host(host);
        }

        if let Some(port) = server.port {
            builder.port(port);
        }

        if let Some(instance) = server.instance {
            builder.instance_name(instance);
        }

        builder.authentication(s.authentication()?);

        if let Some(database) = s.database() {
            builder.database(database);
        }

        if let Some(name) = s.application_name() {
            builder.application_name(name);
        }

        if s.trust_cert()? {
            builder.trust_cert();
        }

        if let Some(ca) = s.trust_cert_ca() {
            builder.trust_cert_ca(ca);
        }

        builder.encryption(s.encrypt()?);

        builder.readonly(s.readonly());

        Ok(builder)
    }
}

pub(crate) struct ServerDefinition {
    host: Option<String>,
    port: Option<u16>,
    instance: Option<String>,
}

pub(crate) trait ConfigString {
    fn dict(&self) -> &HashMap<String, String>;

    fn server(&self) -> crate::Result<ServerDefinition>;

    fn authentication(&self) -> crate::Result<AuthMethod> {
        let user = self
            .dict()
            .get("uid")
            .or_else(|| self.dict().get("username"))
            .or_else(|| self.dict().get("user"))
            .or_else(|| self.dict().get("user id"))
            .map(|s| s.as_str());

        let pw = self
            .dict()
            .get("password")
            .or_else(|| self.dict().get("pwd"))
            .map(|s| s.as_str());

        match self
            .dict()
            .get("integratedsecurity")
            .or_else(|| self.dict().get("integrated security"))
        {
            #[cfg(all(windows, feature = "winauth"))]
            Some(val) if val.to_lowercase() == "sspi" || Self::parse_bool(val)? => match (user, pw)
            {
                (None, None) => Ok(AuthMethod::Integrated),
                _ => Ok(AuthMethod::windows(user.unwrap_or(""), pw.unwrap_or(""))),
            },
            #[cfg(feature = "integrated-auth-gssapi")]
            Some(val) if val.to_lowercase() == "sspi" || Self::parse_bool(val)? => {
                Ok(AuthMethod::Integrated)
            }
            _ => Ok(AuthMethod::sql_server(user.unwrap_or(""), pw.unwrap_or(""))),
        }
    }

    fn database(&self) -> Option<String> {
        self.dict()
            .get("database")
            .or_else(|| self.dict().get("initial catalog"))
            .or_else(|| self.dict().get("databasename"))
            .map(|db| db.to_string())
    }

    fn application_name(&self) -> Option<String> {
        self.dict()
            .get("application name")
            .or_else(|| self.dict().get("applicationname"))
            .map(|name| name.to_string())
    }

    fn trust_cert(&self) -> crate::Result<bool> {
        self.dict()
            .get("trustservercertificate")
            .map(Self::parse_bool)
            .unwrap_or(Ok(false))
    }

    fn trust_cert_ca(&self) -> Option<String> {
        self.dict()
            .get("trustservercertificateca")
            .map(|ca| ca.to_string())
    }

    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    fn encrypt(&self) -> crate::Result<EncryptionLevel> {
        self.dict()
            .get("encrypt")
            .map(|val| match Self::parse_bool(val) {
                Ok(true) => Ok(EncryptionLevel::Required),
                Ok(false) => Ok(EncryptionLevel::Off),
                Err(_) if val == "DANGER_PLAINTEXT" => Ok(EncryptionLevel::NotSupported),
                Err(e) => Err(e),
            })
            .unwrap_or(Ok(EncryptionLevel::Off))
    }

    #[cfg(not(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    )))]
    fn encrypt(&self) -> crate::Result<EncryptionLevel> {
        Ok(EncryptionLevel::NotSupported)
    }

    fn parse_bool<T: AsRef<str>>(v: T) -> crate::Result<bool> {
        match v.as_ref().trim().to_lowercase().as_str() {
            "true" | "yes" => Ok(true),
            "false" | "no" => Ok(false),
            _ => Err(crate::Error::Conversion(
                "Connection string: Not a valid boolean".into(),
            )),
        }
    }

    fn readonly(&self) -> bool {
        self.dict()
            .get("applicationintent")
            .filter(|val| *val == "ReadOnly")
            .is_some()
    }
}
