#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoGridFsFileInfo {
    pub id: String,
    pub filename: Option<String>,
    pub length: i64,
    pub chunk_size: i32,
    pub upload_date: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub md5: Option<String>,
    pub content_type: Option<String>,
    pub aliases: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoGridFsBucketInfo {
    pub name: String,
    pub file_count: u64,
    pub total_bytes: i64,
}
