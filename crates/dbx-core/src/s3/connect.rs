use crate::models::connection::ConnectionConfig;

use super::client::S3Client;
use super::config::S3Config;

pub async fn connect_s3_client(config: &ConnectionConfig, host: &str, port: u16) -> Result<S3Client, String> {
    let mut s3_config = S3Config::from_connection(config)?;
    let original_host = s3_config.endpoint.host_str().unwrap_or_default();
    let original_port = s3_config.endpoint.port_or_known_default().unwrap_or(config.port);
    if host != original_host || port != original_port {
        s3_config = s3_config.with_connect_override(host, port);
    }
    let client = S3Client::new(s3_config).await?;
    client.probe().await?;
    Ok(client)
}
