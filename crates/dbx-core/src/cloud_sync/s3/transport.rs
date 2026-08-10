use async_trait::async_trait;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum S3TransportError {
    InvalidConfig(String),
    NotFound(String),
    Unauthorized(String),
    Network(String),
    Protocol(String),
}

impl fmt::Display for S3TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "Invalid S3 configuration: {message}"),
            Self::NotFound(message) => write!(f, "S3 resource not found: {message}"),
            Self::Unauthorized(message) => write!(f, "S3 authentication or authorization failed: {message}"),
            Self::Network(message) => write!(f, "S3 network request failed: {message}"),
            Self::Protocol(message) => write!(f, "S3 request failed: {message}"),
        }
    }
}

impl std::error::Error for S3TransportError {}

#[async_trait]
pub(crate) trait S3ObjectTransport: Send + Sync {
    async fn head_bucket(&self) -> Result<(), S3TransportError>;

    async fn put_object(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<(), S3TransportError>;

    async fn get_object(&self, key: &str) -> Result<Vec<u8>, S3TransportError>;
}
