use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OracleTypeIdentity {
    pub schema: String,
    pub name: String,
    pub object_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OracleMetadataReadState {
    Available,
    Empty,
    Unknown,
    Unsupported,
    Denied,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleMetadataSection<T> {
    pub state: OracleMetadataReadState,
    pub rows: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleTypeDependency {
    pub schema: String,
    pub name: String,
    pub object_type: String,
    pub referenced_schema: Option<String>,
    pub referenced_name: String,
    pub referenced_type: String,
    pub referenced_link: Option<String>,
    pub dependency_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleTypeGrant {
    pub grantor: Option<String>,
    pub grantee: String,
    pub privilege: String,
    pub grantable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleTypeDetails {
    pub identity: OracleTypeIdentity,
    pub status: Option<String>,
    pub paired_object: Option<OracleTypeIdentity>,
    pub pairing_state: OracleMetadataReadState,
    pub dependencies: OracleMetadataSection<OracleTypeDependency>,
    pub grants: OracleMetadataSection<OracleTypeGrant>,
}
