use serde::{Deserialize, Serialize};

/// Common result shape returned by document-store queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentQueryResult {
    pub documents: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_documents: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extended_documents: Option<Vec<serde_json::Value>>,
    pub total: u64,
    // Older document stores always return an exact total. Keep that wire shape
    // unchanged and only send the flag when Elasticsearch reports a lower bound.
    #[serde(default = "default_total_is_exact", skip_serializing_if = "is_true")]
    pub total_is_exact: bool,
}

fn default_total_is_exact() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

#[cfg(test)]
mod tests {
    use super::DocumentQueryResult;

    #[test]
    fn exact_results_keep_the_existing_wire_shape() {
        let result = DocumentQueryResult {
            documents: Vec::new(),
            raw_documents: None,
            extended_documents: None,
            total: 1,
            total_is_exact: true,
        };

        let serialized = serde_json::to_value(result).unwrap();
        assert!(serialized.get("total_is_exact").is_none());

        let deserialized: DocumentQueryResult = serde_json::from_value(serde_json::json!({
            "documents": [],
            "total": 1,
        }))
        .unwrap();
        assert!(deserialized.total_is_exact);
    }
}
