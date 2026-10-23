//! Opt-in authentication checks; no persistent database objects are created.
//! Set DBX_LIVE_SQLSERVER_HOST and optionally PORT (1433) / DATABASE (tempdb).
//! SQL authentication also requires PASSWORD; USER defaults to sa. Windows
//! authentication uses the process identity and optionally checks it against
//! DBX_LIVE_SQLSERVER_EXPECT_WINDOWS_LOGIN (DOMAIN\\user).
//! Run the intended test by name:
//! cargo test -p dbx-driver-sqlserver --test live_sqlserver_authentication <test_name> -- --ignored
use dbx_driver_sqlserver as native;
use std::time::Duration;

struct Endpoint {
    host: String,
    port: u16,
    port_explicit: bool,
    database: String,
}

impl Endpoint {
    fn from_env() -> Self {
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok();
        Self {
            host: std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("explicit SQL Server test host"),
            port: port.as_deref().unwrap_or("1433").parse().expect("valid DBX_LIVE_SQLSERVER_PORT"),
            port_explicit: port.is_some(),
            database: std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_owned()),
        }
    }

    async fn connect(&self, user: &str, password: &str, params: Option<&str>) -> native::SqlServerClient {
        native::connect_with_port_explicit(
            &self.host,
            self.port,
            self.port_explicit,
            user,
            password,
            Some(&self.database),
            params,
            Duration::from_secs(15),
        )
        .await
        .expect("connect to SQL Server with the selected authentication mode")
    }
}

#[derive(Debug, PartialEq, Eq)]
struct LoginIdentity {
    auth_scheme: String,
    original_login: String,
    current_login: String,
}

async fn login_identity(client: &mut native::SqlServerClient) -> LoginIdentity {
    let result = native::execute_query(
        client,
        "SELECT CAST(CONNECTIONPROPERTY('auth_scheme') AS nvarchar(128)) AS auth_scheme, \
         ORIGINAL_LOGIN() AS original_login, SUSER_SNAME() AS current_login",
    )
    .await
    .expect("query the server-reported authentication scheme and identity");
    assert_eq!(result.rows.len(), 1);
    let row = &result.rows[0];
    let identity = LoginIdentity {
        auth_scheme: row[0].as_str().expect("authentication scheme").trim().to_ascii_uppercase(),
        original_login: row[1].as_str().expect("original login").to_owned(),
        current_login: row[2].as_str().expect("current login").to_owned(),
    };
    assert!(!identity.original_login.trim().is_empty());
    assert!(!identity.current_login.trim().is_empty());
    identity
}

async fn assert_transaction_rollback(client: &mut native::SqlServerClient) {
    assert_eq!(native::manual_transaction_status(client).await.expect("initial transaction state").count, 0);
    native::execute_simple_batch_with_max_rows(client, "BEGIN TRANSACTION", Some(1))
        .await
        .expect("begin a transaction");
    let active = native::manual_transaction_status(client).await.expect("active transaction state");
    native::execute_simple_batch_with_max_rows(client, "ROLLBACK TRANSACTION", Some(1))
        .await
        .expect("roll back the transaction");
    assert_eq!(active.count, 1);
    assert_eq!(native::manual_transaction_status(client).await.expect("rolled-back transaction state").count, 0);
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires a SQL Server authorizing the current Windows account"]
async fn live_sqlserver_windows_authentication_uses_current_identity() {
    let endpoint = Endpoint::from_env();
    // SQL credentials must be ignored, even when stale values remain in a saved connection.
    let invalid_user = format!("dbx_invalid_sql_login_{}", uuid::Uuid::new_v4().simple());
    let invalid_password = "not-a-valid-sql-password";
    let mut previous_identity = None;
    for _ in 0..2 {
        let mut client = endpoint.connect(&invalid_user, invalid_password, Some("sqlserverAuth=windows")).await;
        let identity = login_identity(&mut client).await;
        assert!(matches!(identity.auth_scheme.as_str(), "NTLM" | "KERBEROS"), "unexpected identity: {identity:?}");
        assert_ne!(identity.auth_scheme, "SQL");
        assert_ne!(identity.original_login, invalid_user);
        if let Ok(expected) = std::env::var("DBX_LIVE_SQLSERVER_EXPECT_WINDOWS_LOGIN") {
            assert!(identity.original_login.eq_ignore_ascii_case(expected.trim()), "unexpected identity: {identity:?}");
            assert!(identity.current_login.eq_ignore_ascii_case(expected.trim()), "unexpected identity: {identity:?}");
        }
        if let Some(previous) = &previous_identity {
            assert_eq!(&identity, previous, "reconnecting must preserve the Windows identity");
        }
        assert_transaction_rollback(&mut client).await;
        previous_identity = Some(identity);
        drop(client);
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PASSWORD for SQL authentication"]
async fn live_sqlserver_sql_authentication_default_and_explicit() {
    let endpoint = Endpoint::from_env();
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_owned());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut previous_identity = None;
    for params in [None, Some("sqlserverAuth=sql")] {
        for _ in 0..2 {
            let mut client = endpoint.connect(&user, &password, params).await;
            let identity = login_identity(&mut client).await;
            assert_eq!(identity.auth_scheme, "SQL");
            if let Some(previous) = &previous_identity {
                assert_eq!(&identity, previous, "default, explicit SQL authentication and reconnects must agree");
            }
            assert_transaction_rollback(&mut client).await;
            previous_identity = Some(identity);
            drop(client);
        }
    }
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires valid SQL credentials and an endpoint rejecting the current Windows account, such as Linux SQL Server without AD"]
async fn live_sqlserver_rejected_windows_identity_does_not_fall_back_to_valid_sql_credentials() {
    let endpoint = Endpoint::from_env();
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_owned());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut sql_client = endpoint.connect(&user, &password, Some("sqlserverAuth=sql")).await;
    assert_eq!(login_identity(&mut sql_client).await.auth_scheme, "SQL");
    drop(sql_client);

    // A password fallback would succeed because these SQL credentials were just verified.
    // This rejection test does not demonstrate a successful Windows-authenticated login.
    let result = native::connect_with_port_explicit(
        &endpoint.host,
        endpoint.port,
        endpoint.port_explicit,
        &user,
        &password,
        Some(&endpoint.database),
        Some("sqlserverAuth=windows"),
        Duration::from_secs(15),
    )
    .await;
    assert!(result.is_err(), "the rejected Windows identity must not fall back to the valid SQL credentials");

    // Exclude an unavailable endpoint as the reason the Windows attempt failed.
    let mut sql_client = endpoint.connect(&user, &password, Some("sqlserverAuth=sql")).await;
    assert_eq!(login_identity(&mut sql_client).await.auth_scheme, "SQL");
}
