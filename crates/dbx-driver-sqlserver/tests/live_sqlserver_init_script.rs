//! Opt-in live check that the connection init script runs on every new session.
use dbx_driver_sqlserver as native;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn init_script_applies_session_options_before_the_first_query() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());

    let mut client = native::connect_with_port_explicit_and_init_script(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        None,
        Some("SET ARITHABORT ON;\nSET ANSI_NULLS ON;"),
        Duration::from_secs(15),
    )
    .await
    .expect("connect with an init script");

    let results = native::execute_simple_batch_with_max_rows(&mut client, "DBCC USEROPTIONS", None)
        .await
        .expect("DBCC USEROPTIONS");
    let options = results.first().expect("DBCC USEROPTIONS returns a result set");
    let value_of = |name: &str| {
        options.rows.iter().find_map(|row| {
            (row.first()
                .and_then(|value| value.as_str())
                .is_some_and(|option| option.trim().eq_ignore_ascii_case(name)))
            .then(|| row.get(1).and_then(|value| value.as_str()).map(str::to_string))
            .flatten()
        })
    };
    assert_eq!(value_of("arithabort").as_deref(), Some("SET"));
    assert_eq!(value_of("ansi_nulls").as_deref(), Some("SET"));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn init_script_failure_rejects_the_connection() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());

    let error = match native::connect_with_port_explicit_and_init_script(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        None,
        Some("SELECT * FROM dbx_missing_table_for_init_script"),
        Duration::from_secs(15),
    )
    .await
    {
        Ok(_) => panic!("a failing init script must reject the connection"),
        Err(error) => error,
    };

    assert!(error.starts_with("Connection init script batch 1 failed:"), "{error}");
}
