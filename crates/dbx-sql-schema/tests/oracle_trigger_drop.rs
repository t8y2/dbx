use dbx_sql_schema::db_admin_sql::{build_drop_object_sql, DatabaseObjectType, DropObjectSqlOptions};
use dbx_sql_schema::models::connection::DatabaseType;

#[test]
fn oracle_trigger_drop_uses_the_trigger_namespace() {
    assert_eq!(
        build_drop_object_sql(DropObjectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            object_type: DatabaseObjectType::Trigger,
            schema: Some("HR".to_string()),
            name: "EMP_AUDIT".to_string(),
            signature: None,
            identifier_quote: None,
        }),
        "DROP TRIGGER \"HR\".\"EMP_AUDIT\";"
    );
}
