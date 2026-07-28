use serde_json::json;

use crate::models::connection::DatabaseType;
use crate::transfer::generate_upsert_typed;

#[test]
fn uses_sqlite_upsert_syntax() {
    let sql = generate_upsert_typed(
        &[String::from("id"), String::from("name")],
        &[Some(String::from("integer")), Some(String::from("text"))],
        &[vec![json!(1), json!("Ada")]],
        "users",
        "main",
        &DatabaseType::CloudflareD1,
        &[String::from("id")],
    );

    assert!(sql.contains("ON CONFLICT (\"id\") DO UPDATE SET"));
}
