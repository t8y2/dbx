use super::{ConfigString, ServerDefinition};
use crate::error::Error;
use connection_string::JdbcString;
use std::str::FromStr;

pub(crate) struct JdbcConfig {
    config: JdbcString,
}

impl FromStr for JdbcConfig {
    type Err = Error;

    fn from_str(s: &str) -> crate::Result<Self> {
        let config = s.parse()?;
        Ok(Self { config })
    }
}

impl ConfigString for JdbcConfig {
    fn dict(&self) -> &std::collections::HashMap<String, String> {
        self.config.properties()
    }

    fn server(&self) -> crate::Result<ServerDefinition> {
        let def = ServerDefinition {
            host: self.config.server_name().map(|s| s.to_string()),
            port: self.config.port(),
            instance: self.config.instance_name().map(|s| s.to_string()),
        };

        Ok(def)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::AuthMethod;

    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    use crate::EncryptionLevel;

    #[test]
    fn server_parsing_no_browser() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200";
        let jdbc: JdbcConfig = test_str.parse()?;
        let server = jdbc.server()?;

        assert_eq!(Some("my-server.com".to_string()), server.host);
        assert_eq!(Some(4200), server.port);
        assert_eq!(None, server.instance);

        Ok(())
    }

    #[test]
    fn server_parsing_no_jdbc_no_browser() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200";
        let jdbc: JdbcConfig = test_str.parse()?;
        let server = jdbc.server()?;

        assert_eq!(Some("my-server.com".to_string()), server.host);
        assert_eq!(Some(4200), server.port);
        assert_eq!(None, server.instance);

        Ok(())
    }

    #[test]
    fn server_parsing_with_browser() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com\\TIBERIUS";
        let jdbc: JdbcConfig = test_str.parse()?;
        let server = jdbc.server()?;

        assert_eq!(Some("my-server.com".to_string()), server.host);
        assert_eq!(None, server.port);
        assert_eq!(Some("TIBERIUS".to_string()), server.instance);

        Ok(())
    }

    #[test]
    fn server_parsing_with_browser_and_port() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com\\TIBERIUS:666";
        let jdbc: JdbcConfig = test_str.parse()?;
        let server = jdbc.server()?;

        assert_eq!(Some("my-server.com".to_string()), server.host);
        assert_eq!(Some(666), server.port);
        assert_eq!(Some("TIBERIUS".to_string()), server.instance);

        Ok(())
    }

    #[test]
    fn database_parsing() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://myserver.com:4200;database=Foo";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("Foo".to_string()), jdbc.database());

        let test_str = "jdbc:sqlserver://myserver.com:4200;databaseName=Foo";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("Foo".to_string()), jdbc.database());

        let test_str = "jdbc:sqlserver://myserver.com:4200;Initial Catalog=Foo";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("Foo".to_string()), jdbc.database());

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_true() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificate=true;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(jdbc.trust_cert()?);

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_false() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificate=false;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(!jdbc.trust_cert()?);

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_yes() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificate=yes;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(jdbc.trust_cert()?);

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_no() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificate=no;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(!jdbc.trust_cert()?);

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_missing() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(!jdbc.trust_cert()?);

        Ok(())
    }

    #[test]
    fn trust_cert_parsing_faulty() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificate=musti;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert!(jdbc.trust_cert().is_err());

        Ok(())
    }

    #[test]
    fn trust_cert_ca_parsing_ok() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;TrustServerCertificateCA=someca.crt;";
        let ado: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("someca.crt".to_string()), ado.trust_cert_ca());

        Ok(())
    }

    #[test]
    fn parsing_sql_server_authentication() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;User ID=Musti;pwd=Naukio;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(
            AuthMethod::sql_server("Musti", "Naukio"),
            jdbc.authentication()?
        );

        Ok(())
    }

    #[test]
    #[cfg(windows)]
    fn parsing_sspi_authentication() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;IntegratedSecurity=SSPI;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(AuthMethod::Integrated, jdbc.authentication()?);

        Ok(())
    }

    #[test]
    #[cfg(all(feature = "integrated-auth-gssapi", unix))]
    fn parsing_sspi_authentication() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;IntegratedSecurity=true;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(AuthMethod::Integrated, jdbc.authentication()?);

        Ok(())
    }

    #[test]
    #[cfg(windows)]
    fn parsing_windows_authentication() -> crate::Result<()> {
        let test_str =
            "jdbc:sqlserver://my-server.com:4200;uid=Musti;pwd=Naukio;IntegratedSecurity=SSPI;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(
            AuthMethod::windows("Musti", "Naukio"),
            jdbc.authentication()?
        );

        Ok(())
    }

    #[test]
    fn parsing_database() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;database=Cats;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("Cats".to_string()), jdbc.database());

        Ok(())
    }

    #[test]
    fn parsing_login_credentials_escaping() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;User ID=musti;Password={abc;}}45}";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(
            AuthMethod::sql_server("musti", "abc;}45}"),
            jdbc.authentication()?
        );

        Ok(())
    }

    #[test]
    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    fn encryption_parsing_on() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;encrypt=true;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(EncryptionLevel::Required, jdbc.encrypt()?);

        Ok(())
    }

    #[test]
    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    fn encryption_parsing_off() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;encrypt=false;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(EncryptionLevel::Off, jdbc.encrypt()?);

        Ok(())
    }

    #[test]
    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    fn encryption_parsing_plaintext() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;encrypt=DANGER_PLAINTEXT;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(EncryptionLevel::NotSupported, jdbc.encrypt()?);

        Ok(())
    }

    #[test]
    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    fn encryption_parsing_missing() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(EncryptionLevel::Off, jdbc.encrypt()?);

        Ok(())
    }

    #[test]
    fn application_name_parsing() -> crate::Result<()> {
        let test_str = "jdbc:sqlserver://my-server.com:4200;Application Name=meow";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("meow".into()), jdbc.application_name());

        let test_str = "jdbc:sqlserver://my-server.com:4200;ApplicationName=meow";
        let jdbc: JdbcConfig = test_str.parse()?;

        assert_eq!(Some("meow".into()), jdbc.application_name());

        Ok(())
    }
}
