//! Persisted object metadata shared by Web and SQL execution entry points.
//!
//! These keys are also produced by the frontend's encodeURIComponent-based
//! caches. Keep the encoding and namespace stable when invalidating snapshots.

use crate::models::connection::DatabaseType;
use crate::storage::Storage;

pub const OBJECT_METADATA_CACHE_PREFIX: &str = "object-meta:v1";
const OBJECT_DDL_CACHE_PREFIX: &str = "object-ddl:v1";

pub fn metadata_cache_segment(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                encoded.push(byte as char)
            }
            _ => {
                encoded.push('%');
                encoded.push(HEX[(byte >> 4) as usize] as char);
                encoded.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    encoded
}

pub fn object_metadata_cache_prefix(connection_id: &str, database: &str) -> String {
    format!(
        "{}:{}:{}:",
        OBJECT_METADATA_CACHE_PREFIX,
        metadata_cache_segment(connection_id),
        metadata_cache_segment(database)
    )
}

/// Conservative cache policy, separate from SQL authorization. A failed DDL
/// attempt may already have committed, so callers apply this even on errors.
pub(crate) fn sql_may_change_object_metadata(sql: &str, db_type: Option<DatabaseType>) -> bool {
    let statements = match db_type {
        Some(db_type) => crate::sql::split_sql_statements_for_database(sql, db_type),
        None => crate::sql::split_sql_statements(sql),
    };
    statements.iter().any(|statement| {
        let risk = match db_type {
            Some(db_type) => crate::sql_risk::classify_sql_risk_for_database(statement, db_type),
            None => crate::sql_risk::classify_sql_risk(statement, "generic"),
        };
        if matches!(risk, Ok(crate::sql_risk::SqlRisk::Ddl)) {
            return true;
        }
        // Include transaction completion: a previous DDL call may have run
        // before commit, while another connection cached the old structure.
        let keywords = [
            "CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT", "GRANT", "REVOKE", "RENAME", "COMMIT", "END", "ROLLBACK",
            "ABORT",
        ];
        match db_type {
            Some(db_type) => crate::sql::starts_with_executable_sql_keyword_for_database(statement, &keywords, db_type),
            None => crate::sql::starts_with_executable_sql_keyword(statement, &keywords),
        }
    })
}

/// Connection scope also covers qualified cross-database DDL and session USE.
/// Await before returning the SQL result; cache failures must not turn an
/// already committed database operation into an apparent execution failure.
pub(crate) async fn invalidate_connection_object_cache(storage: &Storage, connection_id: &str) {
    let connection = metadata_cache_segment(connection_id);
    for namespace in [OBJECT_METADATA_CACHE_PREFIX, OBJECT_DDL_CACHE_PREFIX] {
        let prefix = format!("{namespace}:{connection}:");
        if let Err(error) = storage.delete_schema_cache_prefix(&prefix).await {
            log::warn!(
                "failed to invalidate object cache: connection_id={connection_id} namespace={namespace} error={error}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddl_schema_cache_classifies_scripts_without_changing_permissions() {
        for sql in [
            "ALTER TABLE users ADD COLUMN test4 INTEGER",
            "BEGIN; ALTER TABLE users ADD COLUMN test4 INTEGER; COMMIT;",
            "-- leading comment\nCOMMENT ON COLUMN users.test4 IS 'new'",
            "CREATE SOMETHING dialect_specific",
            "COMMIT",
            "END",
            "ROLLBACK",
            "ABORT",
        ] {
            assert!(sql_may_change_object_metadata(sql, Some(DatabaseType::Postgres)), "{sql}");
        }
        for sql in [
            "SELECT 'ALTER TABLE users'",
            "-- DROP TABLE users\nSELECT 1",
            "INSERT INTO users VALUES (1)",
            "UPDATE users SET id = 1",
            "DELETE FROM users",
            "BEGIN",
            "",
            "/* ALTER TABLE */",
        ] {
            assert!(!sql_may_change_object_metadata(sql, Some(DatabaseType::Postgres)), "{sql}");
        }
    }

    #[tokio::test]
    async fn ddl_schema_cache_encoding_and_connection_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.unwrap();
        let id = "conn:% 中文";
        assert_eq!(metadata_cache_segment(id), "conn%3A%25%20%E4%B8%AD%E6%96%87");
        let prefix = object_metadata_cache_prefix(id, "db% name");
        assert_eq!(prefix, "object-meta:v1:conn%3A%25%20%E4%B8%AD%E6%96%87:db%25%20name:");
        let removed = [
            format!("{prefix}public:users::backend-columns:"),
            format!("object-ddl:v1:{}:other-db:public:users::TABLE:", metadata_cache_segment(id)),
        ];
        let kept = format!("{}columns:", object_metadata_cache_prefix(&format!("{id}2"), "db% name"));
        for key in removed.iter().chain(std::iter::once(&kept)) {
            storage.save_schema_cache(key, &serde_json::json!([])).await.unwrap();
        }
        invalidate_connection_object_cache(&storage, id).await;
        for key in removed {
            assert!(storage.load_schema_cache(&key).await.unwrap().is_none());
        }
        assert!(storage.load_schema_cache(&kept).await.unwrap().is_some());
    }
}
