use quick_xml::events::Event;
use quick_xml::Reader;

use super::ops::{S3Bucket, S3ListObjectsResponse, S3ObjectSummary, S3Prefix};

pub fn parse_list_buckets(body: &str) -> Result<Vec<S3Bucket>, String> {
    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(true);
    let mut buckets = Vec::new();
    let mut buf = Vec::new();
    let mut in_bucket = false;
    let mut current_name = String::new();
    let mut current_created = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(tag)) if tag.name().as_ref() == b"Bucket" => {
                in_bucket = true;
                current_name.clear();
                current_created = None;
            }
            Ok(Event::End(tag)) if tag.name().as_ref() == b"Bucket" => {
                if !current_name.is_empty() {
                    buckets.push(S3Bucket { name: current_name.clone(), creation_date: current_created.clone() });
                }
                in_bucket = false;
            }
            Ok(Event::Start(tag)) if in_bucket && tag.name().as_ref() == b"Name" => {
                current_name = read_text(&mut reader, &mut buf)?;
            }
            Ok(Event::Start(tag)) if in_bucket && tag.name().as_ref() == b"CreationDate" => {
                current_created = Some(read_text(&mut reader, &mut buf)?);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Failed to parse S3 bucket list: {error}")),
        }
        buf.clear();
    }

    Ok(buckets)
}

pub fn parse_list_objects(body: &str) -> Result<S3ListObjectsResponse, String> {
    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(true);
    let mut response = S3ListObjectsResponse {
        objects: Vec::new(),
        prefixes: Vec::new(),
        is_truncated: false,
        next_continuation_token: None,
    };
    let mut buf = Vec::new();
    let mut in_contents = false;
    let mut in_common_prefix = false;
    let mut current_key = String::new();
    let mut current_size = 0u64;
    let mut current_last_modified = None;
    let mut current_etag = None;
    let mut current_prefix = String::new();
    let mut current_field = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(tag)) => match tag.name().as_ref() {
                b"Contents" => {
                    in_contents = true;
                    current_key.clear();
                    current_size = 0;
                    current_last_modified = None;
                    current_etag = None;
                }
                b"CommonPrefixes" => in_common_prefix = true,
                b"Key" if in_contents => current_field = Some("key"),
                b"Size" if in_contents => current_field = Some("size"),
                b"LastModified" if in_contents => current_field = Some("last_modified"),
                b"ETag" if in_contents => current_field = Some("etag"),
                b"Prefix" if in_common_prefix => current_field = Some("prefix"),
                _ => current_field = None,
            },
            Ok(Event::Text(text)) => {
                let value = text.unescape().map_err(|error| error.to_string())?.into_owned();
                match current_field.as_deref() {
                    Some("key") => current_key = value,
                    Some("size") => current_size = value.parse().unwrap_or(0),
                    Some("last_modified") => current_last_modified = Some(value),
                    Some("etag") => current_etag = Some(value.trim_matches('"').to_string()),
                    Some("prefix") => current_prefix = value,
                    _ => {}
                }
            }
            Ok(Event::End(tag)) => match tag.name().as_ref() {
                b"Contents" => {
                    if !current_key.is_empty() {
                        response.objects.push(S3ObjectSummary {
                            key: current_key.clone(),
                            size: current_size,
                            last_modified: current_last_modified.clone(),
                            etag: current_etag.clone(),
                        });
                    }
                    in_contents = false;
                    current_field = None;
                }
                b"CommonPrefixes" => {
                    if !current_prefix.is_empty() {
                        response.prefixes.push(S3Prefix { prefix: current_prefix.clone() });
                    }
                    in_common_prefix = false;
                    current_prefix.clear();
                    current_field = None;
                }
                _ => current_field = None,
            },
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Failed to parse S3 object list: {error}")),
        }
        buf.clear();
    }

    if let Some(value) = extract_scalar(body, "IsTruncated") {
        response.is_truncated = value == "true";
    }
    response.next_continuation_token = extract_scalar(body, "NextContinuationToken");
    Ok(response)
}

fn extract_scalar(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open)? + open.len();
    let end = body[start..].find(&close)? + start;
    Some(body[start..end].trim().to_string())
}

fn read_text(reader: &mut Reader<&[u8]>, buf: &mut Vec<u8>) -> Result<String, String> {
    match reader.read_event_into(buf) {
        Ok(Event::Text(text)) => text.unescape().map(|value| value.into_owned()).map_err(|error| error.to_string()),
        Ok(Event::CData(text)) => Ok(String::from_utf8_lossy(text.as_ref()).into_owned()),
        Ok(_) => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bucket_list() {
        let body = r#"<ListAllMyBucketsResult><Buckets><Bucket><Name>lake</Name><CreationDate>2026-08-18T07:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>"#;
        let buckets = parse_list_buckets(body).expect("buckets");
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].name, "lake");
    }

    #[test]
    fn parses_object_list() {
        let body = r#"<ListBucketResult><Contents><Key>data/file.txt</Key><Size>12</Size><LastModified>2026-08-18T07:00:00.000Z</LastModified><ETag>"abc"</ETag></Contents><CommonPrefixes><Prefix>logs/</Prefix></CommonPrefixes><IsTruncated>false</IsTruncated></ListBucketResult>"#;
        let response = parse_list_objects(body).expect("objects");
        assert_eq!(response.objects.len(), 1);
        assert_eq!(response.objects[0].key, "data/file.txt");
        assert_eq!(response.prefixes.len(), 1);
        assert_eq!(response.prefixes[0].prefix, "logs/");
    }
}
