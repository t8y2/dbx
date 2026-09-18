use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MysqlEventInfo {
    pub name: String,
    pub schema: String,
    pub definer: Option<String>,
    pub time_zone: Option<String>,
    pub event_type: Option<String>,
    pub execute_at: Option<String>,
    pub interval_value: Option<String>,
    pub interval_field: Option<String>,
    pub starts: Option<String>,
    pub ends: Option<String>,
    pub status: Option<String>,
    pub on_completion: Option<String>,
    pub comment: Option<String>,
    pub event_body: Option<String>,
    pub event_definition: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_executed: Option<String>,
    pub source: Option<String>,
}
