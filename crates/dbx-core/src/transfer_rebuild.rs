//! Support for the transfer option `drop_target_before_create`.
//!
//! The transfer path has no usable transaction (see `transfer::execute_on_pool`: every
//! statement checks out a fresh connection), so the target table is renamed to a backup
//! instead of dropped. The backup is dropped only after the whole transfer succeeds; any
//! failure leaves it in place for manual recovery.
//!
//! This module owns the backup identifier: deriving it, and keeping it inside the target
//! dialect's identifier budget.

use sha2::{Digest, Sha256};

use crate::connection::AppState;
use crate::db_admin_sql::{supports_object_rename, DatabaseObjectType};
use crate::models::connection::DatabaseType;
use crate::production_safety::is_production_database;
use crate::sql_dialect::DialectCapabilityDescriptor;

/// Marker that identifies a table as a DBX transfer backup.
pub const BACKUP_TABLE_MARKER: &str = "__dbx_bak_";

/// Error prefix returned when a production target needs the destructive confirmation.
/// The frontend matches on this to raise its confirmation dialog instead of a plain error.
pub const DROP_TARGET_CONFIRMATION_REQUIRED: &str = "TRANSFER_DROP_TARGET_CONFIRMATION_REQUIRED";

/// Error prefix returned when the target dialect is outside the supported set.
pub const DROP_TARGET_UNSUPPORTED_DATABASE: &str = "TRANSFER_DROP_TARGET_UNSUPPORTED_DATABASE";

/// Error prefix returned when tables outside the transfer reference a target table.
/// Not recoverable by confirming: the user has to widen the selection or drop the
/// foreign keys, so the frontend surfaces it as a plain error with the table list.
pub const DROP_TARGET_EXTERNAL_FOREIGN_KEYS: &str = "TRANSFER_DROP_TARGET_EXTERNAL_FOREIGN_KEYS";

/// Dialects cleared for `drop_target_before_create`.
///
/// The excluded engines fall into three groups: no table object (MongoDB), a rebuild that
/// silently loses engine metadata (ClickHouse ENGINE/ORDER BY/TTL, QuestDB designated
/// timestamp), and managed-table DROP that also deletes the warehouse data files
/// (Hive/Spark/Kyuubi/Impala/Argo).
const DROP_TARGET_SUPPORTED: &[DatabaseType] = &[
    DatabaseType::Mysql,
    DatabaseType::Postgres,
    DatabaseType::Oracle,
    DatabaseType::SqlServer,
    DatabaseType::Dameng,
    DatabaseType::OceanbaseOracle,
    DatabaseType::Kingbase,
    DatabaseType::Gaussdb,
    DatabaseType::OpenGauss,
    DatabaseType::Kwdb,
    DatabaseType::Goldendb,
    DatabaseType::Sqlite,
    DatabaseType::DuckDb,
    DatabaseType::CloudflareD1,
];

/// Hex characters of the derived hash appended after [`BACKUP_TABLE_MARKER`].
const BACKUP_HASH_LEN: usize = 8;

/// Identifier budget used when the dialect descriptor reports no limit. Deliberately the
/// tightest real limit in the descriptor table (Oracle) so an unknown target cannot
/// produce an over-long name.
const FALLBACK_MAX_IDENTIFIER_BYTES: usize = 30;

/// Identifier byte budget for `database_type`.
///
/// Measured in bytes even for dialects that count characters (MySQL): bytes are the
/// stricter reading, and over-truncating only makes the backup name shorter.
pub fn max_identifier_bytes(database_type: DatabaseType) -> usize {
    let reported = DialectCapabilityDescriptor::capabilities_for_database_type(database_type).max_identifier_length;
    if reported == 0 {
        FALLBACK_MAX_IDENTIFIER_BYTES
    } else {
        reported as usize
    }
}

/// Derive the backup table name for one source table inside one transfer.
///
/// Stable for a given `(transfer_id, qualified_source)` pair, so a retried step inside the
/// same transfer targets the same backup. Distinct source tables never collide even when
/// their names truncate to the same stem, because the hash covers the full qualified name.
pub fn backup_table_name(
    database_type: DatabaseType,
    transfer_id: &str,
    qualified_source: &str,
    target_table_name: &str,
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(transfer_id.as_bytes());
    hasher.update([0x1f]);
    hasher.update(qualified_source.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let suffix = format!("{BACKUP_TABLE_MARKER}{}", &digest[..BACKUP_HASH_LEN]);

    let budget = max_identifier_bytes(database_type);
    if budget <= suffix.len() {
        return Err(format!(
            "Cannot derive a backup table name for {target_table_name}: {} allows only {budget} identifier bytes, \
             and the backup suffix needs {}.",
            database_type.as_str(),
            suffix.len() + 1
        ));
    }
    let stem = truncate_on_char_boundary(target_table_name, budget - suffix.len());
    Ok(format!("{stem}{suffix}"))
}

/// Truncate to at most `max_bytes` bytes without splitting a UTF-8 character.
fn truncate_on_char_boundary(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

/// Append the retained backup table to a failure message.
///
/// Once the rename pre-pass has run, every later failure leaves the original table behind
/// under its backup name. The name is derived from the transfer id and is not stored
/// anywhere, so an error that omits it leaves the user with no way to find their data.
///
/// Idempotent: a message that already names the backup — the drop-backup failure path does
/// — is returned unchanged instead of naming it twice.
pub fn annotate_error_with_retained_backup(error: String, qualified_backup: &str) -> String {
    if error.contains(qualified_backup) {
        return error;
    }
    format!("{error} The original target table was kept as backup '{qualified_backup}'; rename it back to recover.")
}

/// Whether `database_type` is cleared for `drop_target_before_create`.
///
/// Membership in [`DROP_TARGET_SUPPORTED`] is necessary but not sufficient: the backup step
/// needs a table rename, so a dialect that loses rename support also loses this option.
pub fn supports_drop_target_before_create(database_type: DatabaseType) -> bool {
    DROP_TARGET_SUPPORTED.contains(&database_type)
        && supports_object_rename(Some(database_type), DatabaseObjectType::Table)
}

/// Gate `drop_target_before_create` before a transfer starts.
///
/// Both the Tauri command and the web route call this, so the desktop app and the HTTP API
/// cannot drift apart on which targets are allowed or when confirmation is demanded.
pub async fn ensure_drop_target_allowed(
    state: &AppState,
    target_connection_id: &str,
    target_database: &str,
    target_database_type: DatabaseType,
    drop_target_before_create: bool,
    drop_target_confirmed: bool,
) -> Result<(), String> {
    if !drop_target_before_create {
        return Ok(());
    }
    if !supports_drop_target_before_create(target_database_type) {
        return Err(format!(
            "{DROP_TARGET_UNSUPPORTED_DATABASE}: dropping the target table before creating it is not supported for \
             {}.",
            target_database_type.as_str()
        ));
    }
    let production = {
        let configs = state.configs.read().await;
        configs
            .get(target_connection_id)
            .map(|config| is_production_database(config, target_database))
            // Fail closed: an unknown target connection is treated as production.
            .unwrap_or(true)
    };
    if production && !drop_target_confirmed {
        return Err(format!(
            "{DROP_TARGET_CONFIRMATION_REQUIRED}: rebuilding tables in production database '{target_database}' \
             requires explicit confirmation."
        ));
    }
    Ok(())
}

/// One incoming foreign key held by a table outside the transfer collection.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExternalIncomingForeignKey {
    /// Schema (MySQL: database) that owns the referencing table.
    pub referencing_schema: String,
    /// Table holding the foreign key.
    pub referencing_table: String,
    /// Table inside the transfer collection that the foreign key points at.
    pub referenced_table: String,
    pub constraint_name: String,
}

/// Fail-fast gate: refuse the rebuild when a table outside the transfer collection
/// points a foreign key at one of the tables about to be renamed.
///
/// MySQL `RENAME TABLE` and PostgreSQL `ALTER TABLE ... RENAME` both keep incoming
/// foreign keys attached to the renamed table, so after the pre-pass the external
/// table's foreign key would reference the backup instead of the rebuilt table —
/// and dropping the backup at the end would then fail or, worse, silently leave the
/// external table pointing at a table that is about to disappear. Neither outcome is
/// recoverable from inside the transfer, so the transfer refuses to start.
///
/// Tables inside the collection are excluded: their foreign keys are re-created from
/// the source structure by the main pass (`pending_fk_alters`).
pub async fn ensure_no_external_incoming_foreign_keys(
    state: &AppState,
    target_pool_key: &str,
    target_database: &str,
    target_schema: &str,
    target_tables: &[String],
    target_database_type: DatabaseType,
) -> Result<(), String> {
    let blocking = detect_external_incoming_foreign_keys(
        state,
        target_pool_key,
        target_database,
        target_schema,
        target_tables,
        target_database_type,
    )
    .await?;
    match describe_external_incoming_foreign_keys(&blocking) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// Render the fail-fast error for a non-empty set of blocking foreign keys.
///
/// `None` when nothing blocks. Grouped by referencing table so a table holding several
/// constraints reads as one entry, and ordered so the message is stable across runs
/// (`BTreeMap` + sorted constraints) — the frontend shows this string verbatim.
fn describe_external_incoming_foreign_keys(blocking: &[ExternalIncomingForeignKey]) -> Option<String> {
    if blocking.is_empty() {
        return None;
    }
    let mut grouped = std::collections::BTreeMap::<String, Vec<String>>::new();
    for fk in blocking {
        grouped
            .entry(format!("{}.{}", fk.referencing_schema, fk.referencing_table))
            .or_default()
            .push(format!("{} -> {}", fk.constraint_name, fk.referenced_table));
    }
    let described = grouped
        .into_iter()
        .map(|(table, mut constraints)| {
            constraints.sort();
            constraints.dedup();
            format!("{table} ({})", constraints.join(", "))
        })
        .collect::<Vec<_>>();

    Some(format!(
        "{DROP_TARGET_EXTERNAL_FOREIGN_KEYS}: {} table(s) outside this transfer reference the target tables, and \
         renaming a referenced table would move those foreign keys onto the backup table. Add the listed tables to \
         the transfer, or drop their foreign keys first: {}",
        described.len(),
        described.join("; ")
    ))
}

/// List incoming foreign keys held by tables outside `target_tables`.
///
/// Empty for dialects where a rename does not carry incoming foreign keys along —
/// SQLite/DuckDB/D1 rebuild the table wholesale, and the remaining supported
/// engines are gated by [`supports_drop_target_before_create`] anyway.
pub async fn detect_external_incoming_foreign_keys(
    state: &AppState,
    target_pool_key: &str,
    target_database: &str,
    target_schema: &str,
    target_tables: &[String],
    target_database_type: DatabaseType,
) -> Result<Vec<ExternalIncomingForeignKey>, String> {
    if target_tables.is_empty() {
        return Ok(Vec::new());
    }
    let Some(sql) =
        external_incoming_foreign_keys_sql(target_database_type, target_database, target_schema, target_tables)
    else {
        return Ok(Vec::new());
    };

    let result = crate::transfer::execute_read_on_pool(state, target_pool_key, &sql)
        .await
        .map_err(|e| format!("Failed to check incoming foreign keys on the target database: {e}"))?;

    let mut rows = result
        .rows
        .iter()
        .filter_map(|row| {
            let cell = |index: usize| row.get(index).and_then(|value| value.as_str()).map(str::to_string);
            Some(ExternalIncomingForeignKey {
                referencing_schema: cell(0)?,
                referencing_table: cell(1)?,
                referenced_table: cell(2)?,
                constraint_name: cell(3)?,
            })
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows.dedup();
    Ok(rows)
}

/// Build the metadata query returning `(referencing_schema, referencing_table,
/// referenced_table, constraint_name)` for every foreign key that points at
/// `target_tables` from outside that set.
///
/// `None` for dialects that need no check. Split out from the async caller so the
/// generated SQL — including the same-schema exclusion that keeps the transfer's own
/// tables out of the result — is unit-testable without a live database.
fn external_incoming_foreign_keys_sql(
    database_type: DatabaseType,
    database: &str,
    schema: &str,
    target_tables: &[String],
) -> Option<String> {
    let name_list = target_tables.iter().map(|table| quote_sql_literal(table)).collect::<Vec<_>>().join(", ");
    match database_type {
        // MySQL family: schemas are databases, so the referenced side is keyed by
        // REFERENCED_TABLE_SCHEMA. Reading KEY_COLUMN_USAGE alone avoids the
        // catalog-wide scan a join with TABLE_CONSTRAINTS triggers on MySQL 5.7
        // (same reason as db::mysql::list_foreign_keys).
        DatabaseType::Mysql | DatabaseType::Goldendb => Some(format!(
            "SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME, REFERENCED_TABLE_NAME, CONSTRAINT_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE REFERENCED_TABLE_SCHEMA = {db} \
               AND REFERENCED_TABLE_NAME IN ({name_list}) \
               AND NOT (TABLE_SCHEMA = {db} AND TABLE_NAME IN ({name_list}))",
            db = quote_sql_literal(database),
        )),
        // PostgreSQL family: pg_constraint is indexed on confrelid, so this stays
        // cheap even on large catalogs. The referencing side is deliberately not
        // restricted to `schema` — a foreign key from another schema follows the
        // rename just the same — so the exclusion is namespace-qualified rather
        // than by bare name.
        DatabaseType::Postgres
        | DatabaseType::Kingbase
        | DatabaseType::Gaussdb
        | DatabaseType::OpenGauss
        | DatabaseType::Kwdb => Some(format!(
            "SELECT DISTINCT src_ns.nspname, src.relname, tgt.relname, con.conname \
             FROM pg_constraint con \
             JOIN pg_class src ON src.oid = con.conrelid \
             JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace \
             JOIN pg_class tgt ON tgt.oid = con.confrelid \
             JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace \
             WHERE con.contype = 'f' \
               AND tgt_ns.nspname = {schema} \
               AND tgt.relname IN ({name_list}) \
               AND NOT (src_ns.nspname = {schema} AND src.relname IN ({name_list}))",
            schema = quote_sql_literal(schema),
        )),
        // Oracle family: constraint metadata is owner-qualified and a rename keeps
        // incoming constraints attached, same as the two families above.
        DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::OceanbaseOracle => Some(format!(
            "SELECT DISTINCT c.owner, c.table_name, r.table_name, c.constraint_name \
             FROM all_constraints c \
             JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
             WHERE c.constraint_type = 'R' \
               AND r.owner = {schema} \
               AND r.table_name IN ({name_list}) \
               AND NOT (c.owner = {schema} AND c.table_name IN ({name_list}))",
            schema = quote_sql_literal(schema),
        )),
        DatabaseType::SqlServer => Some(format!(
            "SELECT DISTINCT SCHEMA_NAME(src.schema_id), src.name, tgt.name, fk.name \
             FROM sys.foreign_keys fk \
             JOIN sys.tables src ON src.object_id = fk.parent_object_id \
             JOIN sys.tables tgt ON tgt.object_id = fk.referenced_object_id \
             WHERE SCHEMA_NAME(tgt.schema_id) = {schema} \
               AND tgt.name IN ({name_list}) \
               AND NOT (SCHEMA_NAME(src.schema_id) = {schema} AND src.name IN ({name_list}))",
            schema = quote_sql_literal(schema),
        )),
        // SQLite-family engines rebuild the table instead of renaming in place, and
        // every other engine is already refused by the allow-list.
        _ => None,
    }
}

/// Quote a value as a SQL string literal. Local to this module so the metadata
/// queries above never interpolate a raw identifier.
fn quote_sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_TABLE: &str = "customer_order_line_item_revision_history";

    fn name(db: DatabaseType, table: &str) -> String {
        backup_table_name(db, "transfer-1", &format!("shop.{table}"), table).unwrap()
    }

    #[test]
    fn backup_name_fits_identifier_budget_per_dialect() {
        for db in [DatabaseType::Oracle, DatabaseType::Postgres, DatabaseType::Mysql, DatabaseType::SqlServer] {
            let generated = name(db, LONG_TABLE);
            assert!(
                generated.len() <= max_identifier_bytes(db),
                "{db:?} produced {} bytes for budget {}: {generated}",
                generated.len(),
                max_identifier_bytes(db)
            );
            assert!(generated.contains(BACKUP_TABLE_MARKER), "{db:?} lost the backup marker: {generated}");
        }
    }

    #[test]
    fn backup_name_uses_the_full_budget_boundaries() {
        // Oracle 30 / PostgreSQL 63 / MySQL 64 / SQL Server 128 are the four descriptor
        // values the transfer path can hit; pin them so a descriptor edit is visible here.
        assert_eq!(max_identifier_bytes(DatabaseType::Oracle), 30);
        assert_eq!(max_identifier_bytes(DatabaseType::Postgres), 63);
        assert_eq!(max_identifier_bytes(DatabaseType::Mysql), 64);
        assert_eq!(max_identifier_bytes(DatabaseType::SqlServer), 128);

        // 30 - len("__dbx_bak_") - 8 = 12 stem bytes on Oracle.
        let oracle = name(DatabaseType::Oracle, LONG_TABLE);
        assert_eq!(oracle.len(), 30);
        assert!(oracle.starts_with("customer_ord"), "unexpected Oracle stem: {oracle}");

        // Short names are left intact.
        let short = name(DatabaseType::Postgres, "orders");
        assert!(short.starts_with("orders__dbx_bak_"), "unexpected short name: {short}");
    }

    #[test]
    fn distinct_sources_do_not_collide_after_truncation() {
        let first = backup_table_name(
            DatabaseType::Oracle,
            "transfer-1",
            "shop.customer_order_line_item_a",
            "customer_order_line_item_a",
        )
        .unwrap();
        let second = backup_table_name(
            DatabaseType::Oracle,
            "transfer-1",
            "shop.customer_order_line_item_b",
            "customer_order_line_item_b",
        )
        .unwrap();
        assert_ne!(first, second, "truncated stems must stay distinct via the hash");
        assert_eq!(first.len(), 30);
        assert_eq!(second.len(), 30);
    }

    #[test]
    fn same_source_and_transfer_is_idempotent() {
        let first = name(DatabaseType::Mysql, "orders");
        let second = name(DatabaseType::Mysql, "orders");
        assert_eq!(first, second);

        let other_transfer = backup_table_name(DatabaseType::Mysql, "transfer-2", "shop.orders", "orders").unwrap();
        assert_ne!(first, other_transfer, "a different transfer must not reuse the same backup name");
    }

    #[test]
    fn multibyte_names_truncate_on_char_boundaries() {
        let generated = name(DatabaseType::Oracle, "客户订单明细修订历史记录表");
        assert_eq!(generated.len(), 30, "12 stem bytes = 4 CJK characters: {generated}");
        assert!(generated.starts_with("客户订单"), "unexpected CJK stem: {generated}");
    }

    #[test]
    fn failure_messages_point_at_the_retained_backup() {
        let annotated = annotate_error_with_retained_backup(
            "Failed to insert batch: duplicate key.".to_string(),
            "`shop`.`orders__dbx_bak_1a2b3c4d`",
        );
        assert!(annotated.starts_with("Failed to insert batch: duplicate key."), "original error must lead");
        assert!(annotated.contains("`shop`.`orders__dbx_bak_1a2b3c4d`"), "backup name is missing: {annotated}");
    }

    #[test]
    fn a_message_that_already_names_the_backup_is_left_alone() {
        // The drop-backup failure path builds its own message; annotating it again would
        // print the same table twice.
        let original = "Transfer completed successfully, but failed to drop backup table \
                        'orders__dbx_bak_1a2b3c4d': permission denied."
            .to_string();
        assert_eq!(annotate_error_with_retained_backup(original.clone(), "orders__dbx_bak_1a2b3c4d"), original);
    }

    #[test]
    fn supported_targets_all_have_table_rename() {
        for db in DROP_TARGET_SUPPORTED {
            assert!(
                supports_drop_target_before_create(*db),
                "{db:?} is on the allow-list but cannot rename a table, so the backup step would fail"
            );
        }
    }

    #[test]
    fn high_risk_and_non_tabular_targets_stay_excluded() {
        for db in [
            DatabaseType::MongoDb,
            DatabaseType::ClickHouse,
            DatabaseType::Questdb,
            DatabaseType::Hive,
            DatabaseType::Spark,
            DatabaseType::Kyuubi,
            DatabaseType::Impala,
            DatabaseType::Argo,
            DatabaseType::Turso,
            DatabaseType::Rqlite,
        ] {
            assert!(!supports_drop_target_before_create(db), "{db:?} must stay excluded");
        }
    }

    fn sql(db: DatabaseType) -> Option<String> {
        external_incoming_foreign_keys_sql(db, "shop", "public", &["orders".to_string(), "customers".to_string()])
    }

    #[test]
    fn external_fk_query_excludes_the_transfer_tables_themselves() {
        // Without the exclusion every child table inside the transfer would look like a
        // blocker and no multi-table rebuild could ever start.
        let mysql = sql(DatabaseType::Mysql).expect("MySQL needs the check");
        assert!(mysql.contains("REFERENCED_TABLE_SCHEMA = 'shop'"), "{mysql}");
        assert!(mysql.contains("NOT (TABLE_SCHEMA = 'shop' AND TABLE_NAME IN ('orders', 'customers'))"), "{mysql}");

        // PostgreSQL qualifies the exclusion by namespace: a same-named table in another
        // schema is a real blocker, since its foreign key follows the rename too.
        let postgres = sql(DatabaseType::Postgres).expect("PostgreSQL needs the check");
        assert!(postgres.contains("con.contype = 'f'"), "{postgres}");
        assert!(postgres.contains("tgt_ns.nspname = 'public'"), "{postgres}");
        assert!(
            postgres.contains("NOT (src_ns.nspname = 'public' AND src.relname IN ('orders', 'customers'))"),
            "{postgres}"
        );

        for db in [DatabaseType::Oracle, DatabaseType::SqlServer] {
            let generated = sql(db).unwrap_or_else(|| panic!("{db:?} needs the check"));
            assert!(generated.contains("'orders'") && generated.contains("'customers'"), "{db:?}: {generated}");
            assert!(generated.contains("NOT ("), "{db:?} is missing the self-exclusion: {generated}");
        }
    }

    #[test]
    fn external_fk_query_is_skipped_for_rebuild_style_engines() {
        // SQLite-family targets recreate the table rather than renaming in place, so no
        // foreign key ever ends up pointing at a backup.
        for db in [DatabaseType::Sqlite, DatabaseType::DuckDb, DatabaseType::CloudflareD1] {
            assert!(sql(db).is_none(), "{db:?} must not run the incoming-FK query");
        }
    }

    #[test]
    fn external_fk_query_escapes_quotes_in_table_names() {
        let generated =
            external_incoming_foreign_keys_sql(DatabaseType::Postgres, "shop", "public", &["o'brien".to_string()])
                .expect("PostgreSQL needs the check");
        assert!(generated.contains("'o''brien'"), "quote was not doubled: {generated}");
        assert!(!generated.contains("'o'brien'"), "unescaped literal leaked into the query: {generated}");
    }

    #[test]
    fn blocking_foreign_keys_are_grouped_per_referencing_table() {
        let fk = |table: &str, referenced: &str, constraint: &str| ExternalIncomingForeignKey {
            referencing_schema: "public".to_string(),
            referencing_table: table.to_string(),
            referenced_table: referenced.to_string(),
            constraint_name: constraint.to_string(),
        };
        assert_eq!(describe_external_incoming_foreign_keys(&[]), None, "no blockers must not produce an error");

        let message = describe_external_incoming_foreign_keys(&[
            fk("invoices", "orders", "fk_invoice_order"),
            fk("audit_log", "orders", "fk_audit_order"),
            fk("invoices", "customers", "fk_invoice_customer"),
        ])
        .expect("blockers must produce an error");

        assert!(message.starts_with(DROP_TARGET_EXTERNAL_FOREIGN_KEYS), "{message}");
        // Two referencing tables, not three constraints — the count drives the wording.
        assert!(message.contains("2 table(s)"), "{message}");
        // BTreeMap ordering keeps the message stable for snapshot-style frontend tests.
        assert!(
            message.contains(
                "public.audit_log (fk_audit_order -> orders); public.invoices (fk_invoice_customer -> \
                 customers, fk_invoice_order -> orders)"
            ),
            "{message}"
        );
    }
}
