use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(super) struct ConsulKvEntry {
    pub(super) create_index: u64,
    pub(super) modify_index: u64,
    pub(super) lock_index: u64,
    pub(super) key: String,
    pub(super) flags: u64,
    pub(super) value: Option<String>,
    pub(super) session: Option<String>,
}
