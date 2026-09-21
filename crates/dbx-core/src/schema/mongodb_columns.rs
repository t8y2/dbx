use std::collections::{BTreeMap, BTreeSet};

use mongodb::bson::Bson;
use serde_json::{json, Value};

use crate::connection::AppState;
use crate::db::mongo_driver::MongoDocumentResult;
use crate::db::ColumnInfo;

const SAMPLE_SIZE: usize = 100;
const MAX_FIELDS: usize = 512;

pub(super) async fn get_columns(
    state: &AppState,
    connection_id: &str,
    database: &str,
    collection: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let command = json!({
        "find": collection,
        "filter": {},
        "limit": SAMPLE_SIZE,
        "batchSize": SAMPLE_SIZE,
        "singleBatch": true,
        "maxTimeMS": 5000,
    });
    let result = crate::mongo_ops::mongo_run_command_core(state, connection_id, database, &command.to_string()).await?;
    columns_from_sample(&result)
}

fn columns_from_sample(result: &MongoDocumentResult) -> Result<Vec<ColumnInfo>, String> {
    let documents = result
        .extended_documents
        .as_ref()
        .and_then(|documents| documents.first())
        .and_then(|response| response.get("cursor"))
        .and_then(|cursor| cursor.get("firstBatch"))
        .and_then(Value::as_array)
        .ok_or("MongoDB field sampling returned no Extended JSON cursor batch")?;
    let sample_count = documents.len().min(SAMPLE_SIZE);
    let mut fields: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for document in documents.iter().take(SAMPLE_SIZE) {
        let document = Bson::try_from(document.clone()).map_err(|error| format!("Invalid MongoDB sample: {error}"))?;
        let Bson::Document(document) = document else {
            return Err("MongoDB field sampling returned a non-document value".to_string());
        };
        for (name, value) in document {
            if fields.len() < MAX_FIELDS || fields.contains_key(&name) {
                fields.entry(name).or_default().insert(sample_type(&value));
            }
        }
    }
    Ok(fields
        .into_iter()
        .map(|(name, types)| ColumnInfo {
            is_primary_key: name == "_id",
            name,
            data_type: types.into_iter().collect::<Vec<_>>().join(" | "),
            resolved_schema: None,
            is_nullable: true,
            column_default: None,
            is_unique: false,
            extra: Some(format!("sampled from {sample_count} document(s); schema may be incomplete")),
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        })
        .collect())
}

fn sample_type(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) | Bson::Int32(_) | Bson::Int64(_) => "number",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "boolean",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal128",
        Bson::Undefined => "undefined",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(documents: Vec<Value>) -> MongoDocumentResult {
        serde_json::from_value(json!({
            "documents": [],
            "extended_documents": [{ "cursor": { "firstBatch": documents } }],
            "total": 1,
        }))
        .unwrap()
    }

    #[test]
    fn mongodb_sample_preserves_special_types_and_mixed_optional_fields() {
        let columns = columns_from_sample(&result(vec![
            json!({
                "_id": {"$oid": "000000000000000000000001"},
                "amount": {"$numberLong": "42"},
                "created": {"$date": "2026-01-01T00:00:00Z"},
                "profile": {"city": "sample"},
                "tags": ["one", 2],
                "optional": null,
            }),
            json!({"amount": "unknown", "optional": true, "late": 1}),
        ]))
        .unwrap();
        let types =
            columns.iter().map(|column| (column.name.as_str(), column.data_type.as_str())).collect::<BTreeMap<_, _>>();
        assert_eq!(types["_id"], "objectId");
        assert_eq!(types["amount"], "number | string");
        assert_eq!(types["created"], "date");
        assert_eq!(types["profile"], "object");
        assert_eq!(types["tags"], "array");
        assert_eq!(types["optional"], "boolean | null");
        assert_eq!(types["late"], "number");
        assert!(columns.iter().all(|column| column.is_nullable && column.column_default.is_none()));
    }

    #[test]
    fn mongodb_sample_handles_empty_and_rejects_malformed_batches() {
        assert!(columns_from_sample(&result(vec![])).unwrap().is_empty());
        assert!(columns_from_sample(&result(vec![json!("not a document")])).is_err());
        let mut response = result(vec![]);
        response.extended_documents = None;
        assert!(columns_from_sample(&response).is_err());
    }

    #[test]
    fn mongodb_sample_limits_documents_and_fields() {
        let mut documents = vec![json!({"included": 1}); SAMPLE_SIZE];
        documents.push(json!({"outside_sample": 1}));
        let columns = columns_from_sample(&result(documents)).unwrap();
        assert_eq!(columns.len(), 1);
        assert_eq!(columns[0].name, "included");
        let fields = (0..MAX_FIELDS + 1)
            .map(|index| (format!("field_{index}"), json!(index)))
            .collect::<serde_json::Map<_, _>>();
        assert_eq!(columns_from_sample(&result(vec![Value::Object(fields)])).unwrap().len(), MAX_FIELDS);
    }
}
