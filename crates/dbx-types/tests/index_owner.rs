use dbx_types::types::IndexInfo;

#[test]
fn index_owner_round_trips_raw_identity_and_remains_optional_for_old_metadata() {
    let payload = serde_json::json!({
        "name": " Ix(a) ", "owner": " Index Owner ", "columns": ["Id"],
        "is_unique": false, "is_primary": false,
        "filter": null, "index_type": null, "included_columns": null, "comment": null
    });
    let index: IndexInfo = serde_json::from_value(payload.clone()).unwrap();
    assert_eq!(index.owner.as_deref(), Some(" Index Owner "));
    assert_eq!(serde_json::to_value(index).unwrap()["owner"], " Index Owner ");
    let mut old = payload;
    old.as_object_mut().unwrap().remove("owner");
    let index: IndexInfo = serde_json::from_value(old).unwrap();
    assert!(index.owner.is_none());
    assert!(serde_json::to_value(index).unwrap().get("owner").is_none());
}
