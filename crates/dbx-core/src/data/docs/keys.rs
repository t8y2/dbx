use crate::models::connection::DatabaseType;

/// Fold an identifier to its canonical case for note matching.
///
/// PostgreSQL folds unquoted identifiers to lower case, Oracle to upper.
/// MySQL depends on the server's `lower_case_table_names`; we fold to lower
/// unconditionally rather than pay a `SHOW VARIABLES` round-trip per
/// collection — on the rare case-sensitive configuration the only risk is
/// matching a note to a table differing solely by case, never attaching a
/// note to an unrelated table.
///
/// ClickHouse and MongoDB are genuinely case-sensitive: two identifiers
/// differing only by case are DIFFERENT objects there, so folding them
/// would let one note attach to the wrong one. They are left untouched.
///
/// The lower-case default is correct for the remaining SQL engines
/// (SQLite, SQL Server, DuckDB, rqlite, Doris, StarRocks), all of which
/// compare identifiers case-insensitively.
pub fn fold_identifier(db_type: DatabaseType, value: &str) -> String {
    match db_type {
        DatabaseType::Oracle => value.to_uppercase(),
        DatabaseType::ClickHouse | DatabaseType::MongoDb => value.to_string(),
        _ => value.to_lowercase(),
    }
}

/// `schema.table`, or bare `table` when there is no schema.
pub fn table_key(db_type: DatabaseType, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|value| !value.is_empty()) {
        Some(schema) => {
            format!("{}.{}", fold_identifier(db_type, schema), fold_identifier(db_type, table))
        }
        None => fold_identifier(db_type, table),
    }
}

/// `schema.table.column`, or `table.column` when there is no schema.
pub fn column_key(db_type: DatabaseType, schema: Option<&str>, table: &str, column: &str) -> String {
    format!("{}.{}", table_key(db_type, schema, table), fold_identifier(db_type, column))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

    #[test]
    fn postgres_folds_to_lowercase() {
        assert_eq!(fold_identifier(DatabaseType::Postgres, "Orders"), "orders");
        assert_eq!(fold_identifier(DatabaseType::Postgres, "ORDERS"), "orders");
    }

    #[test]
    fn mysql_folds_to_lowercase() {
        assert_eq!(fold_identifier(DatabaseType::Mysql, "Orders"), "orders");
    }

    #[test]
    fn table_keys_are_qualified_when_a_schema_is_present() {
        assert_eq!(table_key(DatabaseType::Postgres, Some("Core"), "Orders"), "core.orders");
        assert_eq!(table_key(DatabaseType::Postgres, None, "Orders"), "orders");
        assert_eq!(table_key(DatabaseType::Postgres, Some(""), "Orders"), "orders");
    }

    #[test]
    fn column_keys_extend_the_table_key() {
        assert_eq!(column_key(DatabaseType::Postgres, Some("core"), "orders", "Status"), "core.orders.status");
    }

    #[test]
    fn folding_is_idempotent() {
        // Folding an already-folded value must be a no-op, or a key would
        // depend on how many times it had been normalised.
        for engine in [DatabaseType::Postgres, DatabaseType::Oracle, DatabaseType::ClickHouse] {
            let once = fold_identifier(engine, "MixedCase");
            assert_eq!(fold_identifier(engine, &once), once, "engine {engine:?}");
        }

        let key_once = table_key(DatabaseType::Postgres, Some("Core"), "Orders");
        assert_eq!(key_once, "core.orders");
        // Re-folding each segment of an existing key must not change it.
        let refolded = key_once
            .split('.')
            .map(|segment| fold_identifier(DatabaseType::Postgres, segment))
            .collect::<Vec<_>>()
            .join(".");
        assert_eq!(refolded, key_once);
    }

    #[test]
    fn case_sensitive_engines_are_not_folded() {
        // ClickHouse and MongoDB treat `Orders` and `orders` as DIFFERENT
        // objects. Folding them would let one note attach to the wrong one.
        assert_eq!(fold_identifier(DatabaseType::ClickHouse, "Orders"), "Orders");
        assert_eq!(fold_identifier(DatabaseType::MongoDb, "Orders"), "Orders");
        assert_eq!(table_key(DatabaseType::ClickHouse, Some("Analytics"), "Orders"), "Analytics.Orders");
    }
}
