use serde::{Deserialize, Serialize};

pub const S3_AGENT_METHOD_LIST_BUCKETS: &str = "s3_list_buckets";
pub const S3_AGENT_METHOD_CREATE_BUCKET: &str = "s3_create_bucket";
pub const S3_AGENT_METHOD_LIST_OBJECTS: &str = "s3_list_objects";
pub const S3_AGENT_METHOD_HEAD_OBJECT: &str = "s3_head_object";
pub const S3_AGENT_METHOD_PREVIEW_OBJECT: &str = "s3_preview_object";
pub const S3_AGENT_METHOD_DOWNLOAD_OBJECT: &str = "s3_download_object";
pub const S3_AGENT_METHOD_UPLOAD_OBJECT: &str = "s3_upload_object";
pub const S3_AGENT_METHOD_DELETE_OBJECT: &str = "s3_delete_object";

pub const S3_AGENT_CAPABILITY_OBJECT_STORAGE: &str = "s3_object_storage";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ListObjectsParams {
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    pub max_keys: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3ObjectParams {
    pub bucket: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3BucketParams {
    pub bucket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3PreviewObjectParams {
    pub bucket: String,
    pub key: String,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3UploadObjectParams {
    pub bucket: String,
    pub key: String,
    pub payload_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}
