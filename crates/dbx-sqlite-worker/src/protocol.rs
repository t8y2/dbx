use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerRequest {
    pub id: u64,
    #[serde(flatten)]
    pub op: WorkerOp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WorkerOp {
    Open { path: String },
    Query { sql: String, max_rows: Option<usize> },
    Backup { dest: String },
    Restore { src: String },
    Ping,
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerResponse {
    pub id: u64,
    #[serde(flatten)]
    pub body: WorkerBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum WorkerBody {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        columns: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        column_types: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<Vec<Vec<serde_json::Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        affected_rows: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pong: Option<bool>,
    },
    Err {
        error: String,
    },
}

impl WorkerBody {
    pub fn ok() -> Self {
        Self::Ok { columns: None, column_types: None, rows: None, affected_rows: None, truncated: None, pong: None }
    }

    pub fn pong() -> Self {
        Self::Ok {
            columns: None,
            column_types: None,
            rows: None,
            affected_rows: None,
            truncated: None,
            pong: Some(true),
        }
    }

    pub fn query(
        columns: Vec<String>,
        column_types: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        affected_rows: u64,
        truncated: bool,
    ) -> Self {
        Self::Ok {
            columns: Some(columns),
            column_types: if column_types.iter().any(|ty| !ty.is_empty()) { Some(column_types) } else { None },
            rows: Some(rows),
            affected_rows: Some(affected_rows),
            truncated: Some(truncated),
            pong: None,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self::Err { error: error.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let request = WorkerRequest { id: 7, op: WorkerOp::Query { sql: "SELECT 1".into(), max_rows: Some(10) } };
        let encoded = serde_json::to_string(&request).unwrap();
        assert!(encoded.contains("\"op\":\"query\""));
        let decoded: WorkerRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, request);
    }
}
