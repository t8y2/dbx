use mongodb::options::ClientOptions;
use std::time::Duration;

use dbx_core::db::mongo_driver;

#[tokio::test]
async fn parses_socks5_proxy_host_and_port() {
    let options = ClientOptions::parse("mongodb://localhost/?proxyHost=127.0.0.1&proxyPort=1080")
        .await
        .expect("MongoDB connection strings should accept SOCKS5 proxy options");

    let proxy = options.socks5_proxy.expect("SOCKS5 proxy options");
    assert_eq!(proxy.host, "127.0.0.1");
    assert_eq!(proxy.port, Some(1080));
    assert_eq!(proxy.authentication, None);
}

#[tokio::test]
async fn parses_socks5_proxy_credentials() {
    let options =
        ClientOptions::parse("mongodb://localhost/?proxyHost=proxy.example.com&proxyUsername=dbx&proxyPassword=secret")
            .await
            .expect("MongoDB connection strings should accept SOCKS5 proxy credentials");

    let proxy = options.socks5_proxy.expect("SOCKS5 proxy options");
    assert_eq!(proxy.host, "proxy.example.com");
    assert_eq!(proxy.port, None);
    assert_eq!(proxy.authentication, Some(("dbx".to_string(), "secret".to_string())));
}

#[tokio::test]
async fn rejects_socks5_proxy_port_without_host() {
    let error = ClientOptions::parse("mongodb://localhost/?proxyPort=1080")
        .await
        .expect_err("proxyPort without proxyHost should remain invalid");

    let message = error.to_string();
    assert!(
        message.to_ascii_lowercase().contains("proxyport cannot be set if proxyhost is unspecified"),
        "unexpected error: {message}"
    );
}

#[tokio::test]
async fn leaves_direct_connections_without_a_proxy() {
    let options = ClientOptions::parse("mongodb://localhost:27017/dbx")
        .await
        .expect("ordinary MongoDB connection strings should remain valid");

    assert!(options.socks5_proxy.is_none());
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_SOCKS5_URL routed through a SOCKS5 proxy"]
async fn connects_to_mongodb_through_socks5_proxy() {
    let url = std::env::var("DBX_LIVE_MONGODB_SOCKS5_URL").expect("DBX_LIVE_MONGODB_SOCKS5_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(5), Duration::from_secs(60))
        .await
        .expect("connect to MongoDB through SOCKS5");

    mongo_driver::test_connection(&client, Duration::from_secs(5), Some("admin"))
        .await
        .expect("ping MongoDB through SOCKS5");
    let version = mongo_driver::server_version(&client, "admin").await.expect("MongoDB buildInfo through SOCKS5");
    if let Ok(expected) = std::env::var("DBX_LIVE_MONGODB_EXPECTED_VERSION") {
        assert_eq!(version, expected);
    }
}
