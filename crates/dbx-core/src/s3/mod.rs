pub mod agent_protocol;
mod client;
mod config;
mod connect;
mod ops;
mod sigv4;
mod xml;

pub use client::S3Client;
pub use config::default_aws_endpoint;
pub use config::S3Config;
pub use connect::connect_s3_client;
pub use ops::{
    s3_copy_object_core, s3_copy_object_with_client, s3_create_bucket_core, s3_create_bucket_with_client,
    s3_delete_bucket_core, s3_delete_bucket_with_client, s3_delete_object_core, s3_delete_object_with_client,
    s3_download_object_core, s3_download_object_with_client, s3_head_object_core, s3_head_object_with_client,
    s3_list_buckets_core, s3_list_buckets_with_client, s3_list_objects_core, s3_list_objects_with_client,
    s3_move_object_core, s3_preview_object_core, s3_preview_object_with_client, s3_put_object_core,
    s3_put_object_with_client, s3_upload_object_core, S3Bucket, S3ListObjectsResponse, S3ObjectHead, S3ObjectPreview,
    S3ObjectSummary, S3Prefix, PREVIEW_MAX_BYTES,
};
