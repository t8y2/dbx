use std::collections::HashMap;

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use reqwest::Method;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub struct SignedRequest {
    pub headers: HashMap<String, String>,
}

pub fn sign_request(
    method: &Method,
    url: &reqwest::Url,
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    session_token: Option<&str>,
    payload: &[u8],
    extra_signed_headers: &[(&str, &str)],
    now: DateTime<Utc>,
) -> Result<SignedRequest, String> {
    let host = signing_host(url)?;
    let canonical_uri = canonical_uri(url.path());
    let canonical_query = canonical_query(url);
    let payload_hash = sha256_hex(payload);
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let mut canonical_headers = vec![
        ("host".to_string(), host.clone()),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    for (name, value) in extra_signed_headers {
        if value.is_empty() {
            continue;
        }
        canonical_headers.push((name.to_ascii_lowercase(), (*value).to_string()));
    }
    if let Some(token) = session_token.filter(|value| !value.is_empty()) {
        canonical_headers.push(("x-amz-security-token".to_string(), token.to_string()));
    }
    canonical_headers.sort_by(|left, right| left.0.cmp(&right.0));

    let canonical_headers_text =
        canonical_headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect::<String>();
    let signed_headers = canonical_headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>().join(";");

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers_text}\n{signed_headers}\n{payload_hash}",
        method = method.as_str(),
    );
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let signing_key = signing_key(secret_access_key, &date_stamp, region)?;
    let signature = hex_hmac(&signing_key, string_to_sign.as_bytes())?;
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
    );

    let mut headers = HashMap::new();
    headers.insert("host".to_string(), host);
    headers.insert("x-amz-content-sha256".to_string(), payload_hash);
    headers.insert("x-amz-date".to_string(), amz_date);
    for (name, value) in extra_signed_headers {
        if !value.is_empty() {
            headers.insert(name.to_ascii_lowercase(), (*value).to_string());
        }
    }
    headers.insert("authorization".to_string(), authorization);
    if let Some(token) = session_token.filter(|value| !value.is_empty()) {
        headers.insert("x-amz-security-token".to_string(), token.to_string());
    }
    Ok(SignedRequest { headers })
}

pub(crate) fn signing_host(url: &reqwest::Url) -> Result<String, String> {
    let host = url.host_str().ok_or("S3 request URL has no host")?;
    match url.port() {
        Some(port) if !is_default_port(url.scheme(), port) => Ok(format!("{host}:{port}")),
        _ => Ok(host.to_string()),
    }
}

fn is_default_port(scheme: &str, port: u16) -> bool {
    matches!((scheme, port), ("http", 80) | ("https", 443))
}

fn canonical_uri(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

fn canonical_query(url: &reqwest::Url) -> String {
    let mut pairs = url
        .query_pairs()
        .map(|(key, value)| (percent_encode(key.as_ref()), percent_encode(value.as_ref())))
        .collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    pairs
        .into_iter()
        .map(|(key, value)| if value.is_empty() { key } else { format!("{key}={value}") })
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => encoded.push(*byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn sha256_hex(payload: &[u8]) -> String {
    let digest = Sha256::digest(payload);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn signing_key(secret_access_key: &str, date_stamp: &str, region: &str) -> Result<Vec<u8>, String> {
    let k_date = hmac_bytes(format!("AWS4{secret_access_key}").as_bytes(), date_stamp.as_bytes())?;
    let k_region = hmac_bytes(&k_date, region.as_bytes())?;
    let k_service = hmac_bytes(&k_region, b"s3")?;
    hmac_bytes(&k_service, b"aws4_request")
}

fn hmac_bytes(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|error| format!("Failed to initialize HMAC: {error}"))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hex_hmac(key: &[u8], data: &[u8]) -> Result<String, String> {
    Ok(hmac_bytes(key, data)?.into_iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn signing_host_includes_non_default_port() {
        let url = reqwest::Url::parse("http://127.0.0.1:9000/test").unwrap();
        assert_eq!(signing_host(&url).expect("host"), "127.0.0.1:9000");
    }

    #[test]
    fn signing_host_omits_default_https_port() {
        let url = reqwest::Url::parse("https://s3.us-east-1.amazonaws.com/").unwrap();
        assert_eq!(signing_host(&url).expect("host"), "s3.us-east-1.amazonaws.com");
    }

    #[test]
    fn signs_get_bucket_request() {
        let url = reqwest::Url::parse("https://s3.us-east-1.amazonaws.com/").unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 18, 10, 0, 0).unwrap();
        let signed = sign_request(
            &Method::GET,
            &url,
            "us-east-1",
            "AKIAEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            None,
            b"",
            &[],
            now,
        )
        .expect("signed");
        assert!(signed.headers.contains_key("authorization"));
        assert_eq!(signed.headers.get("x-amz-content-sha256"), Some(&sha256_hex(b"")));
    }

    #[test]
    fn canonical_query_encodes_delimiter_slash_once() {
        let mut url = reqwest::Url::parse("http://127.0.0.1:9000/demo-bucket").unwrap();
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("delimiter", "/");
            pairs.append_pair("list-type", "2");
            pairs.append_pair("max-keys", "200");
        }
        assert_eq!(canonical_query(&url), "delimiter=%2F&list-type=2&max-keys=200");
    }

    #[test]
    fn canonical_uri_keeps_existing_percent_encoding_for_path_style_urls() {
        let url =
            reqwest::Url::parse("https://s3.us-east-1.amazonaws.com/demo-bucket/folder/space%20%E4%B8%AD%25%3F.txt")
                .unwrap();
        assert_eq!(canonical_uri(url.path()), "/demo-bucket/folder/space%20%E4%B8%AD%25%3F.txt");
    }

    #[test]
    fn canonical_uri_keeps_existing_percent_encoding_for_virtual_hosted_urls() {
        let url =
            reqwest::Url::parse("https://demo-bucket.s3.us-east-1.amazonaws.com/folder/space%20%E4%B8%AD%25%3F.txt")
                .unwrap();
        assert_eq!(canonical_uri(url.path()), "/folder/space%20%E4%B8%AD%25%3F.txt");
    }
}
