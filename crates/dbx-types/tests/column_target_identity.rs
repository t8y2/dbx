use dbx_types::types::ColumnInfo;
use serde_json::json;

#[test]
fn column_metadata_preserves_synonym_target_identity_across_rpc() {
    let payload = json!({
        "name": "Amount", "data_type": "NUMBER(12,2)", "is_nullable": true,
        "column_default": null, "is_primary_key": false, "extra": null,
        "comment": null, "numeric_precision": 12, "numeric_scale": 2,
        "character_maximum_length": null,
        "resolved_schema": "MixedOwner", "resolved_table": "OrderView",
        "resolved_object_type": "VIEW"
    });
    let column: ColumnInfo = serde_json::from_value(payload.clone()).unwrap();
    let forwarded = serde_json::to_value(column).unwrap();
    for key in ["resolved_schema", "resolved_table", "resolved_object_type"] {
        assert_eq!(forwarded.get(key), payload.get(key), "lost {key} in Core metadata forwarding");
    }
}

#[test]
fn older_column_metadata_does_not_invent_a_target_type() {
    let payload = json!({
        "name": "ID", "data_type": "NUMBER", "is_nullable": false,
        "column_default": null, "is_primary_key": true, "extra": null,
        "comment": null, "numeric_precision": null, "numeric_scale": null,
        "character_maximum_length": null
    });
    let column: ColumnInfo = serde_json::from_value(payload).unwrap();
    let forwarded = serde_json::to_value(column).unwrap();
    assert!(forwarded.get("resolved_table").is_none());
    assert!(forwarded.get("resolved_object_type").is_none());
}
