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
use sqlparser::ast::{visit_relations, ObjectNamePart, Statement, TableFactor, Visit, Visitor};
use sqlparser::dialect::{DuckDbDialect, SQLiteDialect};
use sqlparser::parser::Parser;
use std::collections::BTreeSet;
use std::ops::ControlFlow;

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

/// Error prefix for dependent objects that cannot be redirected during a rebuild.
pub const DROP_TARGET_EXTERNAL_DEPENDENCIES: &str = "TRANSFER_DROP_TARGET_EXTERNAL_DEPENDENCIES";

/// Dialects cleared for `drop_target_before_create`.
///
/// The excluded engines fall into three groups: no table object (MongoDB), a rebuild that
/// silently loses engine metadata (ClickHouse ENGINE/ORDER BY/TTL, QuestDB designated
/// timestamp), and managed-table DROP that also deletes the warehouse data files
/// (Hive/Spark/Kyuubi/Impala/Argo).
///
/// Oracle, Dameng and OceanBase-Oracle are additionally excluded even though they support
/// table rename: their constraint and index names are schema-unique, and the rename
/// pre-pass has not yet learned to release those names on the backup tables, so a rebuilt
/// table reusing the source DDL would collide (ORA-00955 / "already an object named").
const DROP_TARGET_SUPPORTED: &[DatabaseType] = &[
    DatabaseType::Mysql,
    DatabaseType::Postgres,
    DatabaseType::SqlServer,
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

/// Storage key prefix for the persisted rebuild recovery plan.
///
/// The journal lives in the existing state store (no schema change), keyed by transfer id,
/// so a crash mid-rename still leaves every backup findable on disk.
const REBUILD_JOURNAL_KEY_PREFIX: &str = "transfer-rebuild:";

/// One renamed table inside the persisted recovery plan.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RebuildRecoveryStep {
    /// Name of the table in the transfer selection.
    pub source_table: String,
    /// Actual target-side name that was renamed away.
    pub target_table: String,
    /// Backup name the target table now lives under.
    pub backup_table: String,
    /// Whether the table rename already executed.
    #[serde(default)]
    pub renamed: bool,
    /// Index/sequence renames executed on the backup table, as `kind old -> new`.
    #[serde(default)]
    pub renamed_objects: Vec<String>,
}

/// Persisted recovery plan for one rebuild transfer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RebuildRecoveryJournal {
    pub transfer_id: String,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    pub database_type: String,
    pub steps: Vec<RebuildRecoveryStep>,
}

fn rebuild_journal_key(transfer_id: &str) -> String {
    format!("{REBUILD_JOURNAL_KEY_PREFIX}{transfer_id}")
}

/// Persist the full recovery plan before the first rename executes.
///
/// `plan` carries `(source_table, target_table, backup_table)` for every table the
/// pre-pass intends to rename. Writing it before any mutation guarantees the journal
/// describes at least as much as has been renamed, never less.
pub(crate) async fn persist_rebuild_plan(
    state: &AppState,
    request: &crate::transfer::TransferRequest,
    database_type: DatabaseType,
    plan: &[(String, String, String)],
) -> Result<(), String> {
    if plan.is_empty() {
        return Ok(());
    }
    let journal = RebuildRecoveryJournal {
        transfer_id: request.transfer_id.clone(),
        target_connection_id: request.target_connection_id.clone(),
        target_database: request.target_database.clone(),
        target_schema: request.target_schema.clone(),
        database_type: database_type.as_str().to_string(),
        steps: plan
            .iter()
            .map(|(source_table, target_table, backup_table)| RebuildRecoveryStep {
                source_table: source_table.clone(),
                target_table: target_table.clone(),
                backup_table: backup_table.clone(),
                renamed: false,
                renamed_objects: Vec::new(),
            })
            .collect(),
    };
    let bytes =
        serde_json::to_vec(&journal).map_err(|e| format!("Failed to serialize the rebuild recovery plan: {e}"))?;
    state
        .storage
        .save_state(&rebuild_journal_key(&request.transfer_id), &bytes, "application/json")
        .await
        .map_err(|e| format!("Failed to persist the rebuild recovery plan: {e}"))
}

/// Mark one table's renames as executed inside the persisted plan.
///
/// A missing journal is tolerated silently: the plan may not have been persisted for
/// transfers that renamed nothing, and the journal is best-effort metadata — it must
/// never fail the transfer it is trying to make recoverable.
pub(crate) async fn record_rebuild_step(
    state: &AppState,
    transfer_id: &str,
    source_table: &str,
    renamed_objects: Vec<String>,
) -> Result<(), String> {
    let result = record_rebuild_step_inner(state, transfer_id, source_table, renamed_objects).await;
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            log::warn!("[transfer] failed to update the rebuild recovery journal: {error}");
            Ok(())
        }
    }
}

async fn record_rebuild_step_inner(
    state: &AppState,
    transfer_id: &str,
    source_table: &str,
    renamed_objects: Vec<String>,
) -> Result<(), String> {
    let key = rebuild_journal_key(transfer_id);
    let Some((bytes, _content_type)) = state.storage.load_state(&key).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let mut journal: RebuildRecoveryJournal =
        serde_json::from_slice(&bytes).map_err(|e| format!("Failed to parse the rebuild recovery journal: {e}"))?;
    if let Some(step) = journal.steps.iter_mut().find(|step| step.source_table == source_table) {
        step.renamed = true;
        step.renamed_objects = renamed_objects;
    }
    let bytes = serde_json::to_vec(&journal).map_err(|e| e.to_string())?;
    state.storage.save_state(&key, &bytes, "application/json").await
}

/// Delete the journal after the whole rebuild — including backup cleanup — succeeded.
///
/// Kept `pub`: the cleanup step lives in `transfer.rs` and both desktop and Web callers
/// run it through the same path.
pub(crate) async fn complete_rebuild_journal(state: &AppState, transfer_id: &str) -> Result<(), String> {
    state.storage.delete_state(&rebuild_journal_key(transfer_id)).await
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

/// Check incoming foreign keys and dependent views before the first rename.
///
/// This is the only dependency gate: it runs before any table is renamed aside, because a
/// foreign key from outside the collection or a dependent view would follow the rename onto
/// the backup. Cleanup later relies on `break_backup_foreign_key_graph` plus restrictive
/// drops, not on a second pass of this check.
pub async fn ensure_no_external_table_dependencies(
    state: &AppState,
    target_pool_key: &str,
    target_database: &str,
    target_schema: &str,
    target_tables: &[String],
    target_database_type: DatabaseType,
) -> Result<(), String> {
    if target_tables.is_empty() {
        return Ok(());
    }
    ensure_no_external_incoming_foreign_keys(
        state,
        target_pool_key,
        target_database,
        target_schema,
        target_tables,
        target_database_type,
    )
    .await?;

    let blocking = detect_dependent_views(
        state,
        target_pool_key,
        target_database,
        target_schema,
        target_tables,
        target_database_type,
    )
    .await?;
    if blocking.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{DROP_TARGET_EXTERNAL_DEPENDENCIES}: rebuilding the target tables would invalidate dependent objects or \
         leave them attached to the backup tables. These objects must be handled explicitly before rebuilding: {}",
        blocking.into_iter().collect::<Vec<_>>().join("; ")
    ))
}

async fn detect_dependent_views(
    state: &AppState,
    pool_key: &str,
    database: &str,
    schema: &str,
    target_tables: &[String],
    database_type: DatabaseType,
) -> Result<BTreeSet<String>, String> {
    if matches!(database_type, DatabaseType::Sqlite | DatabaseType::CloudflareD1 | DatabaseType::DuckDb) {
        return detect_parsed_view_dependencies(state, pool_key, database, schema, target_tables, database_type).await;
    }
    let sql = dependent_views_sql(database_type, database, schema, target_tables).ok_or_else(|| {
        format!("Cannot safely inspect dependent views for {} before rebuilding target tables", database_type.as_str())
    })?;
    let result = read_dependency_metadata(state, pool_key, &sql, 4)
        .await
        .map_err(|error| format!("Failed to inspect dependent views before rebuilding target tables: {error}"))?;
    result
        .rows
        .iter()
        .map(|row| {
            let owner = dependency_metadata_text(row, 0)?;
            let name = dependency_metadata_text(row, 1)?;
            let referenced = dependency_metadata_text(row, 2)?;
            let kind = dependency_metadata_text(row, 3)?;
            Ok(format!("{kind} {owner}.{name} -> {schema}.{referenced}"))
        })
        .collect()
}

/// Native dependency catalogs retain the referenced object identity across renames.
/// Do not exclude a view because its name happens to occur in `target_tables`: the
/// transfer's table selection does not authorize rewriting a target-only view.
fn dependent_views_sql(
    database_type: DatabaseType,
    database: &str,
    schema: &str,
    target_tables: &[String],
) -> Option<String> {
    let names = target_tables.iter().map(|table| quote_sql_literal(table)).collect::<Vec<_>>().join(", ");
    match database_type {
        DatabaseType::Postgres
        | DatabaseType::Kingbase
        | DatabaseType::Gaussdb
        | DatabaseType::OpenGauss
        | DatabaseType::Kwdb => Some(format!(
            "SELECT DISTINCT src_ns.nspname, src.relname, tgt.relname, \
                    CASE WHEN src.relkind = 'm' THEN 'materialized view' ELSE 'view' END \
             FROM pg_catalog.pg_depend dep \
             JOIN pg_catalog.pg_rewrite rewrite ON rewrite.oid = dep.objid \
             JOIN pg_catalog.pg_class src ON src.oid = rewrite.ev_class \
             JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src.relnamespace \
             JOIN pg_catalog.pg_class tgt ON tgt.oid = dep.refobjid \
             JOIN pg_catalog.pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace \
             WHERE dep.classid = 'pg_catalog.pg_rewrite'::regclass \
               AND dep.refclassid = 'pg_catalog.pg_class'::regclass \
               AND src.relkind IN ('v', 'm') \
               AND src.oid <> tgt.oid \
               AND tgt_ns.nspname = {schema} \
               AND tgt.relname IN ({names})",
            schema = quote_sql_literal(schema),
        )),
        DatabaseType::Mysql | DatabaseType::Goldendb => Some(format!(
            "SELECT DISTINCT VIEW_SCHEMA, VIEW_NAME, TABLE_NAME, 'view' \
             FROM information_schema.VIEW_TABLE_USAGE \
             WHERE {database_match} AND {table_match}",
            database_match = mysql_metadata_name_matches("TABLE_SCHEMA", &[database]),
            table_match = mysql_metadata_name_matches(
                "TABLE_NAME",
                &target_tables.iter().map(String::as_str).collect::<Vec<_>>()
            ),
        )),
        DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::OceanbaseOracle => Some(format!(
            "SELECT DISTINCT owner, name, referenced_name, type \
             FROM all_dependencies \
             WHERE type IN ('VIEW', 'MATERIALIZED VIEW') \
               AND referenced_type = 'TABLE' \
               AND referenced_owner = {schema} \
               AND referenced_name IN ({names})",
            schema = quote_sql_literal(schema),
        )),
        DatabaseType::SqlServer => Some(format!(
            "SELECT DISTINCT SCHEMA_NAME(src.schema_id), src.name, tgt.name, 'view' \
             FROM sys.sql_expression_dependencies dep \
             JOIN sys.views src ON src.object_id = dep.referencing_id \
             JOIN sys.tables tgt ON tgt.object_id = dep.referenced_id \
             WHERE dep.referencing_class = 1 AND dep.referenced_class = 1 \
               AND SCHEMA_NAME(tgt.schema_id) = {schema} AND tgt.name IN ({names})",
            schema = quote_sql_literal(schema),
        )),
        _ => None,
    }
}

async fn detect_parsed_view_dependencies(
    state: &AppState,
    pool_key: &str,
    database: &str,
    schema: &str,
    target_tables: &[String],
    database_type: DatabaseType,
) -> Result<BTreeSet<String>, String> {
    let (database, schema, sql) = if database_type == DatabaseType::DuckDb {
        let database = resolve_duckdb_dependency_database(state, pool_key, database).await?;
        let schema = if schema.is_empty() { "main" } else { schema }.to_string();
        // DuckDB views may reference tables in another schema or attached catalog.
        let sql =
            "SELECT database_name, schema_name, view_name, sql FROM duckdb_views() WHERE NOT internal".to_string();
        (database, schema, sql)
    } else {
        let schema = resolve_sqlite_dependency_schema(state, pool_key, database, schema, database_type).await?;
        let mut sql = format!(
            "SELECT '', {schema_value}, name, sql FROM {schema_ident}.sqlite_master WHERE type = 'view'",
            schema_value = quote_sql_literal(&schema),
            schema_ident = crate::db::sqlite::sqlite_quote_ident(&schema),
        );
        // Persistent SQLite views are confined to their own database. TEMP views can
        // refer to any attached database, so they must be inspected as well.
        if database_type == DatabaseType::Sqlite && !schema.eq_ignore_ascii_case("temp") {
            sql.push_str(" UNION ALL SELECT '', 'temp', name, sql FROM temp.sqlite_master WHERE type = 'view'");
        }
        (String::new(), schema, sql)
    };
    let result = read_dependency_metadata(state, pool_key, &sql, 4).await?;
    let mut blocking = BTreeSet::new();
    for row in &result.rows {
        let view_database = dependency_metadata_text(row, 0)?;
        let view_schema = dependency_metadata_text(row, 1)?;
        let view_name = dependency_metadata_text(row, 2)?;
        let qualified = if view_database.is_empty() {
            format!("{view_schema}.{view_name}")
        } else {
            format!("{view_database}.{view_schema}.{view_name}")
        };
        let ddl = dependency_metadata_text(row, 3)
            .map_err(|error| format!("Cannot safely inspect dependent view {qualified}: {error}"))?;
        let references =
            parsed_view_target_references(ddl, database_type, &database, &schema, view_schema, target_tables)
                .map_err(|error| format!("Cannot safely inspect dependent view {qualified}: {error}"))?;
        for referenced in references {
            blocking.insert(format!("view {qualified} -> {schema}.{referenced}"));
        }
    }
    Ok(blocking)
}

fn parsed_view_target_references(
    ddl: &str,
    database_type: DatabaseType,
    database: &str,
    schema: &str,
    view_schema: &str,
    target_tables: &[String],
) -> Result<BTreeSet<String>, String> {
    let dialect: &dyn sqlparser::dialect::Dialect =
        if database_type == DatabaseType::DuckDb { &DuckDbDialect {} } else { &SQLiteDialect {} };
    let statements = Parser::parse_sql(dialect, ddl).map_err(|error| error.to_string())?;
    let [Statement::CreateView(view)] = statements.as_slice() else {
        return Err("the catalog did not return a complete CREATE VIEW definition".to_string());
    };
    if let ControlFlow::Break(error) = view.query.visit(&mut StaticViewRelations) {
        return Err(error.to_string());
    }
    let mut references = BTreeSet::new();
    let visited = visit_relations(&view.query, |relation| {
        let names = relation
            .0
            .iter()
            .map(|part| match part {
                ObjectNamePart::Identifier(identifier) => Ok(identifier.value.as_str()),
                _ => Err("a view relation uses an unsupported dynamic identifier".to_string()),
            })
            .collect::<Result<Vec<_>, _>>();
        let names = match names {
            Ok(names) => names,
            Err(error) => return ControlFlow::Break(error),
        };
        let (qualifiers, table) = match names.split_last() {
            Some((table, qualifiers)) => (qualifiers, *table),
            None => return ControlFlow::Break("a view relation has no object name".to_string()),
        };
        let same_namespace = if database_type == DatabaseType::DuckDb {
            match qualifiers {
                // DuckDB retains unqualified references in its stored view SQL. A
                // view's own schema does not prove which search_path resolved them.
                [] => true,
                [namespace] => namespace.eq_ignore_ascii_case(schema) || namespace.eq_ignore_ascii_case(database),
                [catalog, namespace] => {
                    catalog.eq_ignore_ascii_case(database) && namespace.eq_ignore_ascii_case(schema)
                }
                _ => return ControlFlow::Break("a DuckDB view relation has an unsupported qualified name".to_string()),
            }
        } else {
            match qualifiers {
                [] => view_schema.eq_ignore_ascii_case(schema) || view_schema.eq_ignore_ascii_case("temp"),
                [namespace] => namespace.eq_ignore_ascii_case(schema),
                _ => return ControlFlow::Break("a SQLite view relation has an unsupported qualified name".to_string()),
            }
        };
        if same_namespace {
            if let Some(target) = target_tables.iter().find(|target| target.eq_ignore_ascii_case(table)) {
                references.insert(target.clone());
            }
        }
        ControlFlow::Continue(())
    });
    match visited {
        ControlFlow::Break(error) => Err(error),
        ControlFlow::Continue(()) => Ok(references),
    }
}

/// Table functions/macros can hide relation names in strings (`query_table`) or
/// their own definitions. The view AST alone cannot prove those references safe.
struct StaticViewRelations;

impl Visitor for StaticViewRelations {
    type Break = &'static str;

    fn pre_visit_table_factor(&mut self, table: &TableFactor) -> ControlFlow<Self::Break> {
        match table {
            TableFactor::Table { args: None, .. } | TableFactor::Derived { .. } | TableFactor::NestedJoin { .. } => {
                ControlFlow::Continue(())
            }
            _ => ControlFlow::Break(
                "the view contains a table function or table expression whose dependencies cannot be inspected safely",
            ),
        }
    }
}

async fn resolve_duckdb_dependency_database(
    state: &AppState,
    pool_key: &str,
    database: &str,
) -> Result<String, String> {
    let database = if database.is_empty() || database.eq_ignore_ascii_case("main") {
        let result = read_dependency_metadata(state, pool_key, "SELECT current_database()", 1).await?;
        let row = result.rows.first().ok_or("Cannot inspect DuckDB dependencies: current database is unknown")?;
        dependency_metadata_text(row, 0)?.to_string()
    } else {
        database.to_string()
    };
    let result =
        read_dependency_metadata(state, pool_key, "SELECT database_name, type FROM duckdb_databases()", 2).await?;
    let mut resolved = None;
    for row in &result.rows {
        let name = dependency_metadata_text(row, 0)?;
        let kind = dependency_metadata_text(row, 1)?;
        if !kind.eq_ignore_ascii_case("duckdb") {
            return Err(format!(
                "Cannot safely inspect dependencies in DuckDB catalog '{name}' (engine '{kind}') before rebuilding tables"
            ));
        }
        if name.eq_ignore_ascii_case(&database) {
            resolved = Some(name.to_string());
        }
    }
    resolved.ok_or_else(|| format!("Cannot inspect DuckDB dependencies: catalog '{database}' is not attached"))
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
/// SQLite also rewrites incoming foreign keys when a table is renamed, even if
/// enforcement is currently disabled. Never infer safety from `foreign_keys=OFF`.
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
    let resolved_database;
    let target_database = if target_database_type == DatabaseType::DuckDb {
        resolved_database = resolve_duckdb_dependency_database(state, target_pool_key, target_database).await?;
        resolved_database.as_str()
    } else {
        target_database
    };
    let resolved_schema;
    let target_schema = if matches!(target_database_type, DatabaseType::Sqlite | DatabaseType::CloudflareD1) {
        resolved_schema = resolve_sqlite_dependency_schema(
            state,
            target_pool_key,
            target_database,
            target_schema,
            target_database_type,
        )
        .await?;
        resolved_schema.as_str()
    } else if target_database_type == DatabaseType::DuckDb && target_schema.is_empty() {
        "main"
    } else {
        target_schema
    };
    let sql = external_incoming_foreign_keys_sql(target_database_type, target_database, target_schema, target_tables)
        .ok_or_else(|| {
        format!(
            "Cannot safely inspect incoming foreign keys for {} before rebuilding target tables: {}",
            target_database_type.as_str(),
            target_tables.join(", ")
        )
    })?;

    let result = read_dependency_metadata(state, target_pool_key, &sql, 4)
        .await
        .map_err(|e| format!("Failed to check incoming foreign keys on the target database: {e}"))?;

    let mut rows = result
        .rows
        .iter()
        .map(|row| {
            Ok(ExternalIncomingForeignKey {
                referencing_schema: dependency_metadata_text(row, 0)?.to_string(),
                referencing_table: dependency_metadata_text(row, 1)?.to_string(),
                referenced_table: dependency_metadata_text(row, 2)?.to_string(),
                constraint_name: dependency_metadata_text(row, 3)?.to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    rows.sort();
    rows.dedup();
    Ok(rows)
}

async fn read_dependency_metadata(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    expected_columns: usize,
) -> Result<crate::db::QueryResult, String> {
    let result = crate::transfer::execute_read_on_pool(state, pool_key, sql).await?;
    validate_dependency_metadata(&result, expected_columns)?;
    Ok(result)
}

fn validate_dependency_metadata(result: &crate::db::QueryResult, expected_columns: usize) -> Result<(), String> {
    if result.truncated || result.has_more {
        return Err("Target dependency metadata was truncated; a complete dependency check is required before rebuilding tables".to_string());
    }
    if result.columns.len() != expected_columns {
        return Err(format!(
            "Cannot safely inspect target dependencies: expected {expected_columns} metadata columns, received {}",
            result.columns.len()
        ));
    }
    if result.rows.iter().any(|row| row.len() != expected_columns) {
        return Err("Cannot safely inspect target dependencies: metadata contains an incomplete row".to_string());
    }
    Ok(())
}

fn dependency_metadata_text(row: &[serde_json::Value], index: usize) -> Result<&str, String> {
    row.get(index).and_then(serde_json::Value::as_str).ok_or_else(|| {
        format!("Cannot safely inspect target dependencies: metadata column {} is missing or is not text", index + 1)
    })
}

async fn resolve_sqlite_dependency_schema(
    state: &AppState,
    pool_key: &str,
    database: &str,
    schema: &str,
    database_type: DatabaseType,
) -> Result<String, String> {
    let requested = if !schema.trim().is_empty() {
        schema
    } else if database_type == DatabaseType::CloudflareD1 || database.trim().is_empty() {
        "main"
    } else {
        database
    };
    let result = read_dependency_metadata(state, pool_key, "PRAGMA database_list", 3).await?;
    let names = result.rows.iter().map(|row| dependency_metadata_text(row, 1)).collect::<Result<Vec<_>, _>>()?;
    // A real attached alias wins over the legacy file-path -> main normalization.
    if let Some(name) = names.iter().find(|name| name.eq_ignore_ascii_case(requested)) {
        return Ok((*name).to_string());
    }
    let normalized = crate::db::sqlite::sqlite_quote_schema_ident(requested);
    if let Some(name) =
        names.iter().find(|name| crate::db::sqlite::sqlite_quote_ident(name).eq_ignore_ascii_case(&normalized))
    {
        return Ok((*name).to_string());
    }
    Err(format!("Cannot safely inspect target dependencies: SQLite schema '{requested}' is not attached"))
}

/// Build the metadata query returning `(referencing_schema, referencing_table,
/// referenced_table, constraint_name)` for every foreign key that points at
/// `target_tables` from outside that set.
///
/// `None` for dialects without a reliable metadata query. Split out from the async caller so the
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
             WHERE {target_database_match} AND {target_table_match} \
               AND NOT ({source_database_match} AND {source_table_match})",
            target_database_match = mysql_metadata_name_matches("REFERENCED_TABLE_SCHEMA", &[database]),
            target_table_match = mysql_metadata_name_matches(
                "REFERENCED_TABLE_NAME",
                &target_tables.iter().map(String::as_str).collect::<Vec<_>>()
            ),
            source_database_match = mysql_metadata_name_matches("TABLE_SCHEMA", &[database]),
            source_table_match = mysql_metadata_name_matches(
                "TABLE_NAME",
                &target_tables.iter().map(String::as_str).collect::<Vec<_>>()
            ),
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
        DatabaseType::Sqlite | DatabaseType::CloudflareD1 => Some(format!(
            "SELECT DISTINCT {schema_value}, src.name, fk.\"table\", 'fk_' || CAST(fk.id AS TEXT) \
             FROM {schema_ident}.sqlite_master src \
             JOIN pragma_foreign_key_list(src.name, {schema_value}) fk \
             WHERE src.type = 'table' \
               AND fk.\"table\" COLLATE NOCASE IN ({name_list}) \
               AND src.name COLLATE NOCASE NOT IN ({name_list})",
            schema_value = quote_sql_literal(schema),
            schema_ident = crate::db::sqlite::sqlite_quote_ident(schema),
        )),
        DatabaseType::DuckDb => {
            let folded_names = target_tables
                .iter()
                .map(|name| format!("lower({})", quote_sql_literal(name)))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!(
                "SELECT DISTINCT src.table_catalog || '.' || src.table_schema, src.table_name, tgt.table_name, fk.constraint_name \
                 FROM information_schema.referential_constraints fk \
                 JOIN information_schema.key_column_usage src \
                   ON src.constraint_catalog = fk.constraint_catalog \
                  AND src.constraint_schema = fk.constraint_schema \
                  AND src.constraint_name = fk.constraint_name \
                 JOIN information_schema.key_column_usage tgt \
                   ON tgt.constraint_catalog = fk.unique_constraint_catalog \
                  AND tgt.constraint_schema = fk.unique_constraint_schema \
                  AND tgt.constraint_name = fk.unique_constraint_name \
                 WHERE lower(tgt.table_catalog) = lower({database}) \
                   AND lower(tgt.table_schema) = lower({schema}) \
                   AND lower(tgt.table_name) IN ({folded_names}) \
                   AND NOT (lower(src.table_catalog) = lower({database}) \
                        AND lower(src.table_schema) = lower({schema}) \
                        AND lower(src.table_name) IN ({folded_names}))",
                database = quote_sql_literal(database),
                schema = quote_sql_literal(schema),
            ))
        }
        _ => None,
    }
}

/// information_schema name columns have their own collation, which can equate
/// `orders` and `Orders` even when lower_case_table_names=0 makes them different
/// tables. Apply the server's table-name rules to both the selected and external
/// sides, keeping byte-sensitive comparison after folding where it is required.
fn mysql_metadata_name_matches(column: &str, names: &[&str]) -> String {
    let literals = names.iter().map(|name| quote_mysql_metadata_literal(name)).collect::<Vec<_>>();
    let exact = literals.join(", ");
    let folded = literals.iter().map(|literal| format!("LOWER({literal})")).collect::<Vec<_>>().join(", ");
    format!(
        "((@@lower_case_table_names = 0 AND BINARY {column} IN ({exact})) \
          OR (@@lower_case_table_names <> 0 AND BINARY LOWER({column}) IN ({folded})))"
    )
}

fn quote_mysql_metadata_literal(value: &str) -> String {
    if !value.contains('\\') {
        return quote_sql_literal(value);
    }
    // A hex literal has the same value with and without NO_BACKSLASH_ESCAPES.
    let hex = value.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("CONVERT(X'{hex}' USING utf8mb4)")
}

/// Quote a value as a SQL string literal. Local to this module so the metadata
/// queries above never interpolate a raw identifier.
fn quote_sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn sqlite_dependency_fixture() -> (AppState, crate::db::sqlite::SqliteHandle, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::storage::Storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let pool =
            crate::db::sqlite::connect_path_create_if_missing(directory.path().join("target.db").to_str().unwrap())
                .await
                .unwrap();
        state
            .update_connection_pools(|connections| {
                connections.insert("target".to_string(), crate::connection::PoolKind::Sqlite(pool.clone()));
            })
            .await;
        (state, pool, directory)
    }

    #[tokio::test]
    async fn sqlite_external_child_blocks_rebuild_without_changing_tables_or_rows() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "PRAGMA foreign_keys = ON;
                     CREATE TABLE parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE external_child (
                         id INTEGER PRIMARY KEY,
                         parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE
                     );
                     INSERT INTO parent VALUES (7);
                     INSERT INTO external_child VALUES (11, 7);",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();

        let result = ensure_no_external_incoming_foreign_keys(
            &state,
            "target",
            "main",
            "main",
            &["PARENT".to_string()],
            DatabaseType::Sqlite,
        )
        .await;

        let rows = crate::db::sqlite::execute_query(
            &pool,
            "SELECT child.id, parent.id FROM external_child child JOIN parent ON parent.id = child.parent_id",
        )
        .await
        .unwrap();
        assert_eq!(rows.rows, vec![vec![serde_json::json!(11), serde_json::json!(7)]]);
        let tables = crate::db::sqlite::execute_query(
            &pool,
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .await
        .unwrap();
        assert_eq!(tables.rows, vec![vec![serde_json::json!("external_child")], vec![serde_json::json!("parent")]]);
        let error = result.expect_err("a rename would redirect the external child's cascading FK to the backup");
        assert!(error.starts_with(DROP_TARGET_EXTERNAL_FOREIGN_KEYS), "{error}");
        assert!(error.contains("main.external_child"), "{error}");
    }

    #[tokio::test]
    async fn sqlite_dependent_view_blocks_rebuild_without_changing_view_or_rows() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "CREATE TABLE \"pa'rent\" (id INTEGER PRIMARY KEY);
                     INSERT INTO \"pa'rent\" VALUES (7);
                     CREATE VIEW external_view AS
                         SELECT id FROM (SELECT id FROM \"pa'rent\") nested_parent;",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        let result = ensure_no_external_table_dependencies(
            &state,
            "target",
            "main",
            "main",
            &["PA'RENT".to_string()],
            DatabaseType::Sqlite,
        )
        .await;

        let rows = crate::db::sqlite::execute_query(&pool, "SELECT id FROM external_view").await.unwrap();
        assert_eq!(rows.rows, vec![vec![serde_json::json!(7)]]);
        let error = result.expect_err("SQLite rewrites the external view to reference the renamed backup");
        assert!(error.contains("main.external_view"), "{error}");
    }

    #[tokio::test]
    async fn sqlite_selected_children_and_unrelated_views_do_not_block_rebuild() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "CREATE TABLE parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE selected_child (parent_id INTEGER REFERENCES parent(id));
                     CREATE TABLE unrelated (id INTEGER);
                     CREATE VIEW unrelated_view AS SELECT 'parent' AS label, id FROM unrelated;",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        ensure_no_external_table_dependencies(
            &state,
            "target",
            "main",
            "MAIN",
            &["PARENT".to_string(), "SELECTED_CHILD".to_string()],
            DatabaseType::Sqlite,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sqlite_dependency_checks_preserve_quoted_attached_schema_identity() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "ATTACH DATABASE ':memory:' AS \"tenant'.db\";
                     CREATE TABLE main.parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE main.child (parent_id INTEGER REFERENCES parent(id));
                     CREATE TABLE \"tenant'.db\".parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE \"tenant'.db\".child (parent_id INTEGER REFERENCES parent(id));",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        let error = ensure_no_external_table_dependencies(
            &state,
            "target",
            "tenant'.db",
            "tenant'.db",
            &["parent".to_string()],
            DatabaseType::Sqlite,
        )
        .await
        .unwrap_err();
        assert!(error.contains("tenant'.db.child"), "{error}");
        assert!(!error.contains("main.child"), "{error}");
    }

    #[tokio::test]
    async fn sqlite_temp_views_are_checked_against_the_referenced_attached_schema() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "ATTACH DATABASE ':memory:' AS reporting;
                     CREATE TABLE main.parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE reporting.parent (id INTEGER PRIMARY KEY);
                     CREATE TEMP VIEW outside_view AS SELECT id FROM reporting.parent;",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        ensure_no_external_table_dependencies(
            &state,
            "target",
            "main",
            "main",
            &["parent".to_string()],
            DatabaseType::Sqlite,
        )
        .await
        .unwrap();
        let error = ensure_no_external_table_dependencies(
            &state,
            "target",
            "reporting",
            "reporting",
            &["parent".to_string()],
            DatabaseType::Sqlite,
        )
        .await
        .unwrap_err();
        assert!(error.contains("temp.outside_view"), "{error}");
    }

    #[tokio::test]
    async fn sqlite_unreadable_view_definition_blocks_rebuild_with_object_name() {
        let (state, pool, _directory) = sqlite_dependency_fixture().await;
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "CREATE TABLE parent (id INTEGER);
                     CREATE VIEW unreadable_view AS SELECT id FROM parent;
                     PRAGMA writable_schema = ON;
                     UPDATE sqlite_master SET sql = NULL WHERE name = 'unreadable_view';
                     PRAGMA writable_schema = OFF;",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        let error = ensure_no_external_table_dependencies(
            &state,
            "target",
            "main",
            "main",
            &["parent".to_string()],
            DatabaseType::Sqlite,
        )
        .await
        .unwrap_err();
        assert!(error.contains("main.unreadable_view"), "{error}");
    }

    #[test]
    fn duckdb_foreign_keys_are_checked_with_catalog_and_schema_identity() {
        let sql =
            external_incoming_foreign_keys_sql(DatabaseType::DuckDb, "analytics", "reporting", &["parent".to_string()])
                .expect("DuckDB foreign keys must be checked before a rename");
        assert!(sql.contains("information_schema.referential_constraints"), "{sql}");
        assert!(sql.contains("tgt.table_catalog"), "{sql}");
        assert!(sql.contains("'analytics'"), "{sql}");
        assert!(sql.contains("tgt.table_schema"), "{sql}");
        assert!(sql.contains("'reporting'"), "{sql}");
    }

    #[test]
    fn duckdb_dynamic_view_table_references_cannot_bypass_dependency_check() {
        let result = parsed_view_target_references(
            "CREATE VIEW external_view AS SELECT * FROM query_table('parent')",
            DatabaseType::DuckDb,
            "analytics",
            "main",
            "main",
            &["parent".to_string()],
        );
        assert!(result.is_err(), "table functions can hide dependencies inside strings or macros: {result:?}");
    }

    #[test]
    fn postgres_view_dependency_query_tracks_rewrite_and_relation_catalog_identity() {
        let sql = dependent_views_sql(DatabaseType::Postgres, "shop", "tenant'one", &["orders".to_string()]).unwrap();
        assert!(sql.contains("JOIN pg_catalog.pg_rewrite rewrite ON rewrite.oid = dep.objid"), "{sql}");
        assert!(sql.contains("dep.classid = 'pg_catalog.pg_rewrite'::regclass"), "{sql}");
        assert!(sql.contains("dep.refclassid = 'pg_catalog.pg_class'::regclass"), "{sql}");
        assert!(sql.contains("src.relkind IN ('v', 'm')"), "{sql}");
        assert!(sql.contains("tgt_ns.nspname = 'tenant''one'"), "{sql}");
        assert!(!sql.contains("src_ns.nspname ="), "cross-schema dependent views must be included: {sql}");
    }

    #[tokio::test]
    async fn incomplete_metadata_cannot_be_reported_as_no_dependencies() {
        let (_state, pool, _directory) = sqlite_dependency_fixture().await;
        let mut result =
            crate::db::sqlite::execute_query(&pool, "SELECT 'schema', 'table', 'referenced', 'constraint' WHERE 0")
                .await
                .unwrap();
        validate_dependency_metadata(&result, 4).unwrap();

        result.truncated = true;
        assert!(validate_dependency_metadata(&result, 4).is_err());
        result.truncated = false;
        result.has_more = true;
        assert!(validate_dependency_metadata(&result, 4).is_err());
        result.has_more = false;
        result.rows.push(Vec::new());
        assert!(validate_dependency_metadata(&result, 4).is_err());
        result.rows.clear();
        result.columns.pop();
        assert!(validate_dependency_metadata(&result, 4).is_err());
    }

    #[test]
    fn mysql_metadata_queries_preserve_quotes_and_backslashes_without_sql_mode_assumptions() {
        let sql =
            external_incoming_foreign_keys_sql(DatabaseType::Mysql, "shop", "shop", &["x\\' OR 1=1 --".to_string()])
                .unwrap();
        assert!(sql.contains("CONVERT(X'785c27204f5220313d31202d2d' USING utf8mb4)"), "{sql}");
        let statements = Parser::parse_sql(&sqlparser::dialect::MySqlDialect {}, &sql).unwrap();
        assert_eq!(statements.len(), 1);
        assert!(matches!(statements.first(), Some(Statement::Query(_))));
    }

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
        assert!(mysql.contains("BINARY REFERENCED_TABLE_SCHEMA IN ('shop')"), "{mysql}");
        assert!(mysql.contains("AND NOT ("), "{mysql}");
        assert!(mysql.contains("BINARY TABLE_NAME IN ('orders', 'customers')"), "{mysql}");
        assert!(mysql.contains("BINARY LOWER(TABLE_NAME) IN (LOWER('orders'), LOWER('customers'))"), "{mysql}");

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
    fn sqlite_compatible_targets_inspect_foreign_keys_before_renaming() {
        for db in [DatabaseType::Sqlite, DatabaseType::CloudflareD1] {
            assert!(sql(db).is_some(), "{db:?} renames can redirect incoming foreign keys");
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
