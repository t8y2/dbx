use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::connection::{AppState, PoolKind};

use super::client::{ensure_writable_core, S3Client};
use super::xml::{parse_list_buckets, parse_list_objects};

pub const PREVIEW_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3Bucket {
    pub name: String,
    pub creation_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3Prefix {
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectSummary {
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ListObjectsResponse {
    pub objects: Vec<S3ObjectSummary>,
    pub prefixes: Vec<S3Prefix>,
    pub is_truncated: bool,
    pub next_continuation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectHead {
    pub key: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectPreview {
    pub key: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub preview_encoding: String,
    pub preview_text: Option<String>,
    pub preview_base64: Option<String>,
    pub truncated: bool,
}

pub async fn s3_list_buckets_core(state: &AppState, connection_id: &str) -> Result<Vec<S3Bucket>, String> {
    s3_list_buckets_with_client(&connection_client(state, connection_id).await?).await
}

pub async fn s3_create_bucket_core(state: &AppState, connection_id: &str, bucket: &str) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "create bucket").await?;
    s3_create_bucket_with_client(&connection_client(state, connection_id).await?, bucket).await
}

pub async fn s3_delete_bucket_core(state: &AppState, connection_id: &str, bucket: &str) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "delete bucket").await?;
    s3_delete_bucket_with_client(&connection_client(state, connection_id).await?, bucket).await
}

pub async fn s3_list_objects_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    continuation_token: Option<&str>,
) -> Result<S3ListObjectsResponse, String> {
    s3_list_objects_with_client(
        &connection_client(state, connection_id).await?,
        bucket,
        prefix,
        delimiter,
        max_keys,
        continuation_token,
    )
    .await
}

pub async fn s3_head_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
) -> Result<S3ObjectHead, String> {
    s3_head_object_with_client(&connection_client(state, connection_id).await?, bucket, key).await
}

pub async fn s3_preview_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
    max_bytes: usize,
) -> Result<S3ObjectPreview, String> {
    s3_preview_object_with_client(
        &connection_client(state, connection_id).await?,
        bucket,
        key,
        max_bytes.min(PREVIEW_MAX_BYTES),
    )
    .await
}

pub async fn s3_download_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
) -> Result<Vec<u8>, String> {
    s3_download_object_with_client(&connection_client(state, connection_id).await?, bucket, key).await
}

pub async fn s3_put_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
    payload: &[u8],
    content_type: Option<&str>,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "upload object").await?;
    s3_put_object_with_client(&connection_client(state, connection_id).await?, bucket, key, payload, content_type).await
}

pub async fn s3_upload_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
    payload_base64: &str,
    content_type: Option<&str>,
) -> Result<(), String> {
    let payload = STANDARD
        .decode(payload_base64.trim())
        .map_err(|error| format!("S3 upload payload is not valid base64: {error}"))?;
    s3_put_object_core(state, connection_id, bucket, key, &payload, content_type).await
}

pub async fn s3_delete_object_core(
    state: &AppState,
    connection_id: &str,
    bucket: &str,
    key: &str,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "delete object").await?;
    s3_delete_object_with_client(&connection_client(state, connection_id).await?, bucket, key).await
}

pub async fn s3_copy_object_core(
    state: &AppState,
    connection_id: &str,
    source_bucket: &str,
    source_key: &str,
    destination_bucket: &str,
    destination_key: &str,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "copy object").await?;
    s3_copy_object_with_client(
        &connection_client(state, connection_id).await?,
        source_bucket,
        source_key,
        destination_bucket,
        destination_key,
    )
    .await
}

pub async fn s3_move_object_core(
    state: &AppState,
    connection_id: &str,
    source_bucket: &str,
    source_key: &str,
    destination_bucket: &str,
    destination_key: &str,
) -> Result<(), String> {
    ensure_writable_core(state, connection_id, "move object").await?;
    let client = connection_client(state, connection_id).await?;
    s3_copy_object_with_client(&client, source_bucket, source_key, destination_bucket, destination_key).await?;
    s3_delete_object_with_client(&client, source_bucket, source_key).await
}

async fn connection_client(state: &AppState, connection_id: &str) -> Result<S3Client, String> {
    state.get_or_create_pool(connection_id, None).await?;
    let connections = state.connections.read().await;
    match connections.get(connection_id) {
        Some(PoolKind::S3(client)) => Ok(client.clone()),
        Some(_) => Err("Connection is not an S3 connection".to_string()),
        None => Err("Connection not found".to_string()),
    }
}

pub async fn s3_list_buckets_with_client(client: &S3Client) -> Result<Vec<S3Bucket>, String> {
    let response = client.request(Method::GET, client.root_url()?, None, None, None, &[]).await?;
    parse_list_buckets(std::str::from_utf8(&response.body).map_err(|error| error.to_string())?)
}

pub async fn s3_create_bucket_with_client(client: &S3Client, bucket: &str) -> Result<(), String> {
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return Err("S3 bucket name is required".to_string());
    }
    let (payload, content_type) = create_bucket_request_body(client.config());
    client.request(Method::PUT, client.bucket_url(bucket)?, None, Some(payload.as_slice()), content_type, &[]).await?;
    Ok(())
}

pub async fn s3_delete_bucket_with_client(client: &S3Client, bucket: &str) -> Result<(), String> {
    let bucket = bucket.trim();
    if bucket.is_empty() {
        return Err("S3 bucket name is required".to_string());
    }
    client.request(Method::DELETE, client.bucket_url(bucket)?, None, None, None, &[]).await?;
    Ok(())
}

fn create_bucket_request_body(config: &super::config::S3Config) -> (Vec<u8>, Option<&'static str>) {
    let host = config.endpoint.host_str().unwrap_or_default();
    if !super::config::is_aws_endpoint_host(host) || config.region == "us-east-1" {
        return (Vec::new(), None);
    }
    let constraint = if config.region == "eu-west-1" { "EU" } else { config.region.as_str() };
    let payload = format!(
        "<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><LocationConstraint>{constraint}</LocationConstraint></CreateBucketConfiguration>"
    );
    (payload.into_bytes(), Some("application/xml"))
}

pub async fn s3_list_objects_with_client(
    client: &S3Client,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    continuation_token: Option<&str>,
) -> Result<S3ListObjectsResponse, String> {
    let mut query = vec![
        ("list-type".to_string(), "2".to_string()),
        ("max-keys".to_string(), max_keys.max(1).min(1000).to_string()),
    ];
    if !prefix.is_empty() {
        query.push(("prefix".to_string(), prefix.to_string()));
    }
    if let Some(delimiter) = delimiter.filter(|value| !value.is_empty()) {
        query.push(("delimiter".to_string(), delimiter.to_string()));
    }
    if let Some(token) = continuation_token.filter(|value| !value.is_empty()) {
        query.push(("continuation-token".to_string(), token.to_string()));
    }
    let refs = query.iter().map(|(key, value)| (key.as_str(), value.clone())).collect::<Vec<_>>();
    let response = client.request(Method::GET, client.bucket_url(bucket)?, Some(&refs), None, None, &[]).await?;
    parse_list_objects(std::str::from_utf8(&response.body).map_err(|error| error.to_string())?)
}

pub async fn s3_download_object_with_client(client: &S3Client, bucket: &str, key: &str) -> Result<Vec<u8>, String> {
    let response = client.request(Method::GET, client.object_url(bucket, key)?, None, None, None, &[]).await?;
    Ok(response.body)
}

pub async fn s3_head_object_with_client(client: &S3Client, bucket: &str, key: &str) -> Result<S3ObjectHead, String> {
    head_object(client, bucket, key).await
}

pub async fn s3_preview_object_with_client(
    client: &S3Client,
    bucket: &str,
    key: &str,
    max_bytes: usize,
) -> Result<S3ObjectPreview, String> {
    preview_object(client, bucket, key, max_bytes).await
}

pub async fn s3_put_object_with_client(
    client: &S3Client,
    bucket: &str,
    key: &str,
    payload: &[u8],
    content_type: Option<&str>,
) -> Result<(), String> {
    client.request(Method::PUT, client.object_url(bucket, key)?, None, Some(payload), content_type, &[]).await?;
    Ok(())
}

pub async fn s3_delete_object_with_client(client: &S3Client, bucket: &str, key: &str) -> Result<(), String> {
    client.request(Method::DELETE, client.object_url(bucket, key)?, None, None, None, &[]).await?;
    Ok(())
}

pub async fn s3_copy_object_with_client(
    client: &S3Client,
    source_bucket: &str,
    source_key: &str,
    destination_bucket: &str,
    destination_key: &str,
) -> Result<(), String> {
    let destination_url = client.object_url(destination_bucket, destination_key)?;
    let copy_source = client.copy_source_header(source_bucket, source_key)?;
    let signed_headers = [("x-amz-copy-source", copy_source.as_str())];
    client.request(Method::PUT, destination_url, None, None, None, &signed_headers).await?;
    Ok(())
}

async fn head_object(client: &S3Client, bucket: &str, key: &str) -> Result<S3ObjectHead, String> {
    let response = client.request(Method::HEAD, client.object_url(bucket, key)?, None, None, None, &[]).await?;
    Ok(S3ObjectHead {
        key: key.trim_start_matches('/').to_string(),
        size: response.content_length.unwrap_or(0),
        content_type: response.content_type,
        etag: response.etag,
        last_modified: response.last_modified,
    })
}

async fn preview_object(
    client: &S3Client,
    bucket: &str,
    key: &str,
    max_bytes: usize,
) -> Result<S3ObjectPreview, String> {
    let head = head_object(client, bucket, key).await?;
    let max_bytes = max_bytes.max(1);
    let range_header = if head.size as usize > max_bytes { Some(format!("bytes=0-{}", max_bytes - 1)) } else { None };
    let signed_headers = range_header.as_ref().map(|value| [("range", value.as_str())]).unwrap_or_default();
    let response =
        client.request(Method::GET, client.object_url(bucket, key)?, None, None, None, &signed_headers).await?;
    let truncated = head.size as usize > response.body.len();
    let content_type = response.content_type.or(head.content_type.clone());
    let (preview_encoding, preview_text, preview_base64) = preview_payload(&response.body, content_type.as_deref());
    Ok(S3ObjectPreview {
        key: key.trim_start_matches('/').to_string(),
        size: head.size,
        content_type,
        etag: response.etag.or(head.etag),
        preview_encoding: preview_encoding.to_string(),
        preview_text,
        preview_base64,
        truncated,
    })
}

fn preview_payload(body: &[u8], content_type: Option<&str>) -> (&'static str, Option<String>, Option<String>) {
    let looks_text = content_type
        .is_some_and(|value| value.starts_with("text/") || value.contains("json") || value.contains("xml"))
        || body
            .iter()
            .all(|byte| byte.is_ascii() && (*byte == b'\n' || *byte == b'\r' || *byte == b'\t' || *byte >= 0x20));
    if looks_text {
        ("text", Some(String::from_utf8_lossy(body).into_owned()), None)
    } else {
        ("base64", None, Some(STANDARD.encode(body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_payload_detects_text_and_binary() {
        let (encoding, text, base64) = preview_payload(b"hello", Some("text/plain"));
        assert_eq!(encoding, "text");
        assert_eq!(text.as_deref(), Some("hello"));
        assert!(base64.is_none());

        let (encoding, text, base64) = preview_payload(&[0, 159, 146, 150], None);
        assert_eq!(encoding, "base64");
        assert!(text.is_none());
        assert!(base64.is_some());
    }
}
