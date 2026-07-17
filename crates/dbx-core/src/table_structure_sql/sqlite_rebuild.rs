use std::collections::{BTreeMap, HashSet};
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::indexes::has_existing_index_change;
use super::types::{SqliteTableStructurePreview, TableStructureSqlOptions};
use super::util::{clean, normalize_default, original_comment, original_default};
use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone)]
struct SqliteColumnSnapshot {
    cid: i64,
    name: String,
    data_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key_order: i64,
    hidden: i64,
}

#[derive(Debug, Clone)]
struct SqliteDependency {
    kind: String,
    name: String,
    sql: String,
}

#[derive(Debug, Clone)]
struct SqliteSchemaSnapshot {
    schema: String,
    table_name: String,
    table_sql: String,
    table_kind: String,
    columns: Vec<SqliteColumnSnapshot>,
    dependencies: Vec<SqliteDependency>,
    schema_version: i64,
    autoincrement_sequence: Option<i64>,
    revision: String,
}

struct SqliteChangePlan {
    preview: SqliteTableStructurePreview,
    executable_statements: Vec<String>,
    schema: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SqliteForeignKeyViolation {
    table: String,
    rowid: Option<i64>,
    parent: String,
    foreign_key_id: i64,
}

pub async fn preview_sqlite_table_structure_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    options: TableStructureSqlOptions,
) -> Result<SqliteTableStructurePreview, String> {
    let (_, pool) = native_sqlite_pool(state, connection_id, database).await?;
    preview_sqlite_table_structure_change_with_pool(pool, options).await
}

pub async fn apply_sqlite_table_structure_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    options: TableStructureSqlOptions,
    schema_revision: &str,
) -> Result<db::QueryResult, String> {
    let (pool_key, pool) = native_sqlite_pool(state, connection_id, database).await?;
    crate::query::check_read_only_for_connection(state, &pool_key, "ALTER TABLE").await?;
    apply_sqlite_table_structure_change_with_pool(pool, options, schema_revision).await
}

async fn native_sqlite_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<(String, db::sqlite::SqliteHandle), String> {
    let database = (!database.trim().is_empty()).then_some(database);
    let pool_key = state.get_or_create_pool(connection_id, database).await?;
    let connections = state.connections.read().await;
    match connections.get(&pool_key) {
        Some(PoolKind::Sqlite(pool)) => Ok((pool_key, pool.clone())),
        Some(_) => Err("SQLite table rebuild is only available for native SQLite connections.".to_string()),
        None => Err("SQLite connection pool not found.".to_string()),
    }
}

async fn preview_sqlite_table_structure_change_with_pool(
    pool: db::sqlite::SqliteHandle,
    options: TableStructureSqlOptions,
) -> Result<SqliteTableStructurePreview, String> {
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| build_change_plan(conn, &options).map(|p| p.preview))
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn apply_sqlite_table_structure_change_with_pool(
    pool: db::sqlite::SqliteHandle,
    options: TableStructureSqlOptions,
    expected_revision: &str,
) -> Result<db::QueryResult, String> {
    let expected_revision = expected_revision.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            if !conn.is_autocommit() {
                return Err("SQLite already has an active transaction; finish it before applying structure changes."
                    .to_string());
            }

            execute_change_transaction(conn, &options, &expected_revision)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_change_plan(conn: &mut Connection, options: &TableStructureSqlOptions) -> Result<SqliteChangePlan, String> {
    if options.database_type.is_some_and(|database_type| database_type != DatabaseType::Sqlite) {
        return Err("SQLite table rebuild requires databaseType=sqlite.".to_string());
    }
    let schema = options.schema.as_deref().map(str::trim).filter(|schema| !schema.is_empty()).unwrap_or("main");
    if !schema.eq_ignore_ascii_case("main") {
        return Err("SQLite table rebuild currently supports the native main schema only.".to_string());
    }
    if options.table_name.trim().is_empty() {
        return Err("SQLite table name cannot be empty.".to_string());
    }

    let snapshot = load_schema_snapshot(conn, schema, &options.table_name)?;
    let mut warnings = super::validation::validate_draft(options);
    let mut type_changes = BTreeMap::new();
    let live_columns =
        snapshot.columns.iter().map(|column| (column.name.to_ascii_lowercase(), column)).collect::<BTreeMap<_, _>>();

    for column in options.columns.iter().filter(|column| !column.marked_for_drop) {
        let Some(original) = &column.original else {
            validate_declared_type(&column.data_type)
                .map_err(|error| format!("Column \"{}\": {error}", column.name))?;
            continue;
        };
        let Some(live) = live_columns.get(&original.name.to_ascii_lowercase()) else {
            warnings.push(format!(
                "Column \"{}\" no longer exists in the live SQLite table. Refresh the structure before applying changes.",
                original.name
            ));
            continue;
        };
        if normalize_type_name(&live.data_type) != normalize_type_name(&original.data_type) {
            warnings.push(format!(
                "Column \"{}\" changed in SQLite after this editor was opened. Refresh the structure before applying changes.",
                original.name
            ));
            continue;
        }

        let has_type_change = normalize_type_name(&column.data_type) != normalize_type_name(&original.data_type);
        if has_type_change {
            validate_declared_type(&column.data_type)
                .map_err(|error| format!("Column \"{}\": {error}", column.name))?;
            let primary_key_columns = snapshot.columns.iter().filter(|column| column.primary_key_order > 0).count();
            let changes_integer_primary_key_alias = live.primary_key_order > 0
                && primary_key_columns == 1
                && !snapshot_is_without_rowid(&snapshot)?
                && (normalize_type_name(&live.data_type) == "integer"
                    || normalize_type_name(&column.data_type) == "integer");
            if changes_integer_primary_key_alias {
                warnings.push(format!(
                    "Changing the declared type of primary key column \"{}\" to or from INTEGER can change SQLite rowid alias semantics and is blocked.",
                    original.name
                ));
            }
            if type_changes.insert(original.name.to_ascii_lowercase(), column.data_type.trim().to_string()).is_some() {
                warnings.push(format!("Column \"{}\" appears more than once in the structure draft.", original.name));
            }
        }

        let has_non_type_attribute_change = column.is_nullable != original.is_nullable
            || normalize_default(Some(&column.default_value)) != original_default(column)
            || clean(&column.comment) != original_comment(column);
        if has_non_type_attribute_change {
            warnings.push(format!(
                "SQLite rebuild currently supports changing the declared type of existing column \"{}\", but not its nullability, default, or comment.",
                original.name
            ));
        }
    }

    if has_trigger_edits(options) {
        warnings.push("Editing SQLite triggers is not supported by this structure workflow.".to_string());
    }
    if type_changes.is_empty() {
        warnings.push(
            "No existing SQLite column type change was detected; use the standard table structure path for other edits."
                .to_string(),
        );
    }

    let replaced_index_names = options
        .indexes
        .iter()
        .filter_map(|index| {
            let original = index.original.as_ref()?;
            (index.marked_for_drop || has_existing_index_change(index)).then(|| original.name.to_ascii_lowercase())
        })
        .collect::<HashSet<_>>();

    let mut generic_options = options.clone();
    generic_options.database_type = Some(DatabaseType::Sqlite);
    generic_options.schema = None;
    generic_options.triggers.clear();
    for column in &mut generic_options.columns {
        if let Some(original) = &column.original {
            if normalize_type_name(&column.data_type) != normalize_type_name(&original.data_type) {
                column.data_type = original.data_type.clone();
            }
        }
    }
    // The rebuild drops every named index from the migration source. Unchanged indexes are
    // restored from sqlite_schema; edited indexes are recreated directly in their final form;
    // dropped indexes need no follow-up DROP statement.
    generic_options.indexes = options
        .indexes
        .iter()
        .filter_map(|index| {
            if index.marked_for_drop {
                return None;
            }
            match &index.original {
                Some(_) if has_existing_index_change(index) => {
                    let mut replacement = index.clone();
                    replacement.original = None;
                    Some(replacement)
                }
                Some(_) => None,
                None => Some(index.clone()),
            }
        })
        .collect();
    let generic_result = super::build_table_structure_change_sql(generic_options);
    warnings.extend(generic_result.warnings);
    deduplicate_warnings(&mut warnings);

    let mut executable_statements = Vec::new();
    if !type_changes.is_empty() {
        if snapshot.table_sql.trim_start().to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE") {
            warnings.push("SQLite virtual tables cannot be rebuilt by the table structure editor.".to_string());
        } else {
            if hidden_rowid_is_shadowed(&snapshot)? {
                warnings.push(
                    "SQLite cannot preserve the hidden rowid because columns named rowid, _rowid_, and oid all exist."
                        .to_string(),
                );
            }
            if !snapshot.dependencies.is_empty()
                && options.columns.iter().any(|column| column.marked_for_drop && column.original.is_some())
            {
                warnings.push(
                    "Drop dependent indexes or triggers separately before combining a SQLite column drop with a type rebuild."
                        .to_string(),
                );
            }
            executable_statements.extend(build_rebuild_statements(
                conn,
                &snapshot,
                &type_changes,
                &replaced_index_names,
            )?);
        }
    }
    executable_statements.extend(generic_result.statements);

    let foreign_keys_enabled: i64 = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| format!("Failed to read SQLite foreign_keys state: {error}"))?;
    let legacy_alter_table_enabled: i64 = conn
        .pragma_query_value(None, "legacy_alter_table", |row| row.get(0))
        .map_err(|error| format!("Failed to read SQLite legacy_alter_table state: {error}"))?;
    let mut preview_statements = Vec::new();
    if !executable_statements.is_empty() {
        preview_statements.push("PRAGMA foreign_keys = OFF;".to_string());
        preview_statements.push("PRAGMA legacy_alter_table = ON;".to_string());
        preview_statements.push("BEGIN IMMEDIATE;".to_string());
        preview_statements.push(
            "-- Record this baseline before the rebuild; existing rows do not block the change unless their count increases."
                .to_string(),
        );
        preview_statements.push(format!("PRAGMA {}.foreign_key_check;", quote_ident(&snapshot.schema)));
        preview_statements.extend(executable_statements.iter().cloned());
        preview_statements.push(
            "-- Compare this result with the baseline and ROLLBACK only for new or additional violations.".to_string(),
        );
        preview_statements.push(format!("PRAGMA {}.foreign_key_check;", quote_ident(&snapshot.schema)));
        preview_statements.push("COMMIT;".to_string());
        preview_statements.push(format!(
            "PRAGMA legacy_alter_table = {};",
            if legacy_alter_table_enabled != 0 { "ON" } else { "OFF" }
        ));
        preview_statements
            .push(format!("PRAGMA foreign_keys = {};", if foreign_keys_enabled != 0 { "ON" } else { "OFF" }));
    }

    let plan_revision = plan_revision(&snapshot.revision, options, &executable_statements)?;
    Ok(SqliteChangePlan {
        preview: SqliteTableStructurePreview {
            statements: preview_statements,
            warnings,
            schema_revision: plan_revision,
        },
        executable_statements,
        schema: snapshot.schema,
    })
}

fn load_schema_snapshot(conn: &Connection, schema: &str, table_name: &str) -> Result<SqliteSchemaSnapshot, String> {
    let schema_ident = quote_ident(schema);
    let mut table_list_statement = conn
        .prepare(&format!("PRAGMA {schema_ident}.table_list"))
        .map_err(|error| format!("Failed to inspect SQLite table kind: {error}"))?;
    let table_kind = table_list_statement
        .query_map([], |row| Ok((row.get::<_, String>("name")?, row.get::<_, String>("type")?)))
        .map_err(|error| format!("Failed to inspect SQLite table kind: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to inspect SQLite table kind: {error}"))?
        .into_iter()
        .find(|(name, _)| name == table_name)
        .map(|(_, kind)| kind)
        .ok_or_else(|| format!("SQLite table \"{table_name}\" was not found."))?;
    drop(table_list_statement);
    if table_kind != "table" {
        return Err(format!(
            "SQLite object \"{table_name}\" has table_list type \"{table_kind}\" and cannot be rebuilt safely."
        ));
    }
    let table_record = conn
        .query_row(
            &format!("SELECT type, sql FROM {schema_ident}.sqlite_schema WHERE name = ?1"),
            [table_name],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to read SQLite table definition: {error}"))?
        .ok_or_else(|| format!("SQLite table \"{table_name}\" was not found."))?;
    if table_record.0 != "table" {
        return Err(format!("SQLite object \"{table_name}\" is not a table."));
    }
    let table_sql = table_record
        .1
        .ok_or_else(|| format!("SQLite table \"{table_name}\" has no reusable CREATE TABLE statement."))?;

    let mut column_stmt = conn
        .prepare(&format!("PRAGMA {schema_ident}.table_xinfo({})", quote_string(table_name)))
        .map_err(|error| format!("Failed to inspect SQLite columns: {error}"))?;
    let columns = column_stmt
        .query_map([], |row| {
            Ok(SqliteColumnSnapshot {
                cid: row.get("cid")?,
                name: row.get("name")?,
                data_type: row.get("type")?,
                not_null: row.get::<_, i64>("notnull")? != 0,
                default_value: row.get("dflt_value")?,
                primary_key_order: row.get("pk")?,
                hidden: row.get("hidden")?,
            })
        })
        .map_err(|error| format!("Failed to inspect SQLite columns: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to inspect SQLite columns: {error}"))?;
    drop(column_stmt);
    if columns.is_empty() {
        return Err(format!("SQLite table \"{table_name}\" has no inspectable columns."));
    }

    let mut dependency_stmt = conn
        .prepare(&format!(
            "SELECT type, name, sql FROM {schema_ident}.sqlite_schema \
             WHERE tbl_name = ?1 AND type IN ('index', 'trigger') AND sql IS NOT NULL \
             ORDER BY type, name"
        ))
        .map_err(|error| format!("Failed to inspect SQLite table dependencies: {error}"))?;
    let dependencies = dependency_stmt
        .query_map([table_name], |row| Ok(SqliteDependency { kind: row.get(0)?, name: row.get(1)?, sql: row.get(2)? }))
        .map_err(|error| format!("Failed to inspect SQLite table dependencies: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to inspect SQLite table dependencies: {error}"))?;
    drop(dependency_stmt);

    let schema_version: i64 = conn
        .pragma_query_value(Some(rusqlite::DatabaseName::Main), "schema_version", |row| row.get(0))
        .map_err(|error| format!("Failed to read SQLite schema version: {error}"))?;
    let autoincrement_sequence = if contains_sql_keyword(&table_sql, "autoincrement") {
        conn.query_row(
            &format!("SELECT seq FROM {schema_ident}.sqlite_sequence WHERE name = ?1"),
            [table_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read SQLite AUTOINCREMENT sequence: {error}"))?
    } else {
        None
    };
    let mut snapshot = SqliteSchemaSnapshot {
        schema: schema.to_string(),
        table_name: table_name.to_string(),
        table_sql,
        table_kind,
        columns,
        dependencies,
        schema_version,
        autoincrement_sequence,
        revision: String::new(),
    };
    snapshot.revision = schema_revision(&snapshot);
    Ok(snapshot)
}

fn schema_revision(snapshot: &SqliteSchemaSnapshot) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, &snapshot.schema);
    hash_field(&mut hasher, &snapshot.table_name);
    hash_field(&mut hasher, &snapshot.table_sql);
    hash_field(&mut hasher, &snapshot.table_kind);
    hash_field(&mut hasher, &snapshot.schema_version.to_string());
    hash_field(
        &mut hasher,
        &snapshot.autoincrement_sequence.map_or_else(|| "<null>".to_string(), |sequence| sequence.to_string()),
    );
    for column in &snapshot.columns {
        hash_field(&mut hasher, &column.cid.to_string());
        hash_field(&mut hasher, &column.name);
        hash_field(&mut hasher, &column.data_type);
        hash_field(&mut hasher, if column.not_null { "1" } else { "0" });
        hash_field(&mut hasher, column.default_value.as_deref().unwrap_or("<null>"));
        hash_field(&mut hasher, &column.primary_key_order.to_string());
        hash_field(&mut hasher, &column.hidden.to_string());
    }
    for dependency in &snapshot.dependencies {
        hash_field(&mut hasher, &dependency.kind);
        hash_field(&mut hasher, &dependency.name);
        hash_field(&mut hasher, &dependency.sql);
    }
    format!("{:x}", hasher.finalize())
}

fn hash_field(hasher: &mut Sha256, value: &str) {
    hasher.update(value.len().to_le_bytes());
    hasher.update(value.as_bytes());
}

fn plan_revision(
    schema_revision: &str,
    options: &TableStructureSqlOptions,
    executable_statements: &[String],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, schema_revision);
    hash_field(
        &mut hasher,
        &serde_json::to_string(options)
            .map_err(|error| format!("Failed to fingerprint SQLite structure draft: {error}"))?,
    );
    for statement in executable_statements {
        hash_field(&mut hasher, statement);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn build_rebuild_statements(
    conn: &Connection,
    snapshot: &SqliteSchemaSnapshot,
    type_changes: &BTreeMap<String, String>,
    replaced_index_names: &HashSet<String>,
) -> Result<Vec<String>, String> {
    let mut create_replacement = rewrite_declared_column_types(&snapshot.table_sql, type_changes)?;
    let (_, body_end) = find_create_table_body_span(&create_replacement)
        .ok_or_else(|| "SQLite CREATE TABLE statement could not be parsed safely.".to_string())?;
    ensure_statement_terminated(&mut create_replacement);
    let backup_seed = u64::from_str_radix(&snapshot.revision[..15], 16)
        .map_err(|error| format!("Failed to derive SQLite backup table suffix: {error}"))?;
    let backup_name = format!("{}_{:012}", snapshot.table_name, backup_seed % 1_000_000_000_000);
    let source_name = format!("__dbx_source_{}", &snapshot.revision[..12]);
    let schema_ident = quote_ident(&snapshot.schema);
    for reserved_name in [&backup_name, &source_name] {
        let collision: bool = conn
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {schema_ident}.sqlite_schema WHERE name = ?1)"),
                [reserved_name],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to reserve SQLite rebuild table name: {error}"))?;
        if collision {
            return Err(format!(
                "SQLite rebuild table \"{reserved_name}\" already exists; remove it or refresh the schema."
            ));
        }
    }

    let qualified_table = qualified_name(&snapshot.schema, &snapshot.table_name);
    let qualified_backup = qualified_name(&snapshot.schema, &backup_name);
    let qualified_source = qualified_name(&snapshot.schema, &source_name);

    let without_rowid = has_without_rowid_clause(&create_replacement[body_end + 1..]);
    let visible_columns = snapshot.columns.iter().filter(|column| column.hidden == 0).collect::<Vec<_>>();
    let live_names = snapshot.columns.iter().map(|column| column.name.to_ascii_lowercase()).collect::<HashSet<_>>();
    let rowid_alias = if without_rowid {
        None
    } else {
        ["rowid", "_rowid_", "oid"].into_iter().find(|name| !live_names.contains(*name))
    };
    let source_alias = quote_ident("__dbx_source");
    let mut copy_targets = Vec::with_capacity(visible_columns.len() + usize::from(rowid_alias.is_some()));
    let mut copy_expressions = Vec::with_capacity(copy_targets.capacity());
    if let Some(rowid_alias) = rowid_alias {
        copy_targets.push(quote_ident(rowid_alias));
        copy_expressions.push(format!("{source_alias}.{}", quote_ident(rowid_alias)));
    }
    for column in visible_columns {
        let quoted_column = quote_ident(&column.name);
        copy_targets.push(quoted_column.clone());
        let source = format!("{source_alias}.{quoted_column}");
        copy_expressions.push(
            type_changes
                .get(&column.name.to_ascii_lowercase())
                .map_or(source.clone(), |target_type| format!("CAST({source} AS {target_type})")),
        );
    }

    let backup_source_alias = quote_ident("__dbx_backup_source");
    let mut backup_targets = Vec::with_capacity(snapshot.columns.len() + usize::from(rowid_alias.is_some()));
    let mut backup_expressions = Vec::with_capacity(backup_targets.capacity());
    if let Some(rowid_alias) = rowid_alias {
        backup_targets.push(quote_ident(rowid_alias));
        backup_expressions.push(format!("{backup_source_alias}.{}", quote_ident(rowid_alias)));
    }
    for column in &snapshot.columns {
        let quoted_column = quote_ident(&column.name);
        backup_targets.push(quoted_column.clone());
        backup_expressions.push(format!("{backup_source_alias}.{quoted_column}"));
    }

    let mut statements = vec![
        format!("CREATE TABLE {qualified_backup} AS SELECT * FROM {qualified_table} WHERE 0;"),
        format!(
            "INSERT INTO {qualified_backup} ({}) SELECT {} FROM {qualified_table} AS {backup_source_alias};",
            backup_targets.join(", "),
            backup_expressions.join(", ")
        ),
        format!("ALTER TABLE {qualified_table} RENAME TO {};", quote_ident(&source_name)),
    ];
    // Index and trigger names are unique within a SQLite schema. The renamed source table is
    // intentionally retained as the backup, so release its dependency names before recreating
    // those dependencies on the replacement table.
    statements.extend(snapshot.dependencies.iter().map(|dependency| {
        format!("DROP {} {};", dependency.kind.to_ascii_uppercase(), qualified_name(&snapshot.schema, &dependency.name))
    }));
    statements.extend([
        create_replacement,
        format!(
            "INSERT INTO {qualified_table} ({}) SELECT {} FROM {qualified_source} AS {source_alias};",
            copy_targets.join(", "),
            copy_expressions.join(", ")
        ),
    ]);
    if let Some(sequence) = snapshot.autoincrement_sequence {
        let sequence_table = qualified_name(&snapshot.schema, "sqlite_sequence");
        let table_literal = quote_string(&snapshot.table_name);
        statements.push(format!(
            "UPDATE {sequence_table} SET seq = CASE WHEN seq < {sequence} THEN {sequence} ELSE seq END WHERE name = {table_literal};"
        ));
        statements.push(format!(
            "INSERT INTO {sequence_table} (name, seq) SELECT {table_literal}, {sequence} WHERE NOT EXISTS (SELECT 1 FROM {sequence_table} WHERE name = {table_literal});"
        ));
    }
    statements.push(format!("DROP TABLE {qualified_source};"));
    statements.extend(
        snapshot
            .dependencies
            .iter()
            .filter(|dependency| {
                dependency.kind != "index" || !replaced_index_names.contains(&dependency.name.to_ascii_lowercase())
            })
            .map(|dependency| {
                let mut sql = dependency.sql.clone();
                ensure_statement_terminated(&mut sql);
                sql
            }),
    );
    Ok(statements)
}

fn execute_change_transaction(
    conn: &mut Connection,
    options: &TableStructureSqlOptions,
    expected_revision: &str,
) -> Result<db::QueryResult, String> {
    let started_at = Instant::now();
    let foreign_keys_enabled: i64 = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| format!("Failed to read SQLite foreign_keys state: {error}"))?;
    let legacy_alter_table_enabled: i64 = conn
        .pragma_query_value(None, "legacy_alter_table", |row| row.get(0))
        .map_err(|error| format!("Failed to read SQLite legacy_alter_table state: {error}"))?;
    conn.pragma_update(None, "foreign_keys", false)
        .map_err(|error| format!("Failed to disable SQLite foreign key enforcement: {error}"))?;
    if let Err(error) = conn.pragma_update(None, "legacy_alter_table", true) {
        let restore_error = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled != 0).err();
        return Err(match restore_error {
            Some(restore_error) => format!(
                "Failed to enable SQLite legacy_alter_table for the backup rename: {error}; failed to restore foreign_keys state: {restore_error}"
            ),
            None => format!("Failed to enable SQLite legacy_alter_table for the backup rename: {error}"),
        });
    }

    let operation_result = (|| {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| format!("Failed to begin SQLite table rebuild transaction: {error}"))?;
        let plan = build_change_plan(conn, options)?;
        if plan.preview.schema_revision != expected_revision {
            return Err(
                "SQLite schema changed or the structure draft differs from the preview. Refresh the table structure and preview the change again."
                    .to_string(),
            );
        }
        if !plan.preview.warnings.is_empty() {
            return Err(format!("SQLite structure change cannot be applied: {}", plan.preview.warnings.join(" ")));
        }
        // Compare the complete schema so inbound references are covered while unrelated historical violations remain tolerated.
        let foreign_key_baseline = foreign_key_violations(conn, &plan.schema)?;
        for (index, statement) in plan.executable_statements.iter().enumerate() {
            if let Err(error) = conn.execute_batch(statement) {
                return Err(format!("SQLite structure statement {} failed: {error}", index + 1));
            }
        }
        let foreign_key_after = foreign_key_violations(conn, &plan.schema)?;
        if let Some(violation) = first_added_foreign_key_violation(&foreign_key_baseline, &foreign_key_after) {
            return Err(format!(
                "SQLite foreign key check found a new violation after rebuilding the table: {}",
                format_foreign_key_violation(violation)
            ));
        }
        conn.execute_batch("COMMIT").map_err(|error| format!("SQLite table rebuild COMMIT failed: {error}"))?;
        Ok(())
    })();

    if operation_result.is_err() && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }

    let mut cleanup_errors = Vec::new();
    if let Err(error) = conn.pragma_update(None, "legacy_alter_table", legacy_alter_table_enabled != 0) {
        cleanup_errors.push(format!("Failed to restore SQLite legacy_alter_table state: {error}"));
    }
    if let Err(error) = conn.pragma_update(None, "foreign_keys", foreign_keys_enabled != 0) {
        cleanup_errors.push(format!("Failed to restore SQLite foreign_keys state: {error}"));
    }
    match operation_result {
        Err(operation_error) if cleanup_errors.is_empty() => Err(operation_error),
        Err(operation_error) => Err(format!("{operation_error}; {}", cleanup_errors.join("; "))),
        Ok(()) if !cleanup_errors.is_empty() => Err(cleanup_errors.join("; ")),
        Ok(()) => Ok(db::QueryResult {
            columns: Vec::new(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_time_ms: started_at.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        }),
    }
}

fn foreign_key_violations(conn: &Connection, schema: &str) -> Result<Vec<SqliteForeignKeyViolation>, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA {}.foreign_key_check", quote_ident(schema)))
        .map_err(|error| format!("Failed to prepare SQLite foreign_key_check: {error}"))?;
    let mut rows = statement.query([]).map_err(|error| format!("Failed to run SQLite foreign_key_check: {error}"))?;
    let mut violations = Vec::new();
    while let Some(row) = rows.next().map_err(|error| format!("Failed to read SQLite foreign_key_check: {error}"))? {
        violations.push(SqliteForeignKeyViolation {
            table: row.get(0).unwrap_or_else(|_| "<unknown>".to_string()),
            rowid: row.get(1).unwrap_or(None),
            parent: row.get(2).unwrap_or_else(|_| "<unknown>".to_string()),
            foreign_key_id: row.get(3).unwrap_or(-1),
        });
    }
    Ok(violations)
}

fn first_added_foreign_key_violation<'a>(
    baseline: &[SqliteForeignKeyViolation],
    after: &'a [SqliteForeignKeyViolation],
) -> Option<&'a SqliteForeignKeyViolation> {
    let mut remaining = baseline.iter().cloned().fold(BTreeMap::new(), |mut counts, violation| {
        *counts.entry(violation).or_insert(0usize) += 1;
        counts
    });
    after.iter().find(|violation| match remaining.get_mut(*violation) {
        Some(count) if *count > 0 => {
            *count -= 1;
            false
        }
        _ => true,
    })
}

fn format_foreign_key_violation(violation: &SqliteForeignKeyViolation) -> String {
    format!(
        "table={table}, rowid={}, parent={parent}, foreignKeyId={foreign_key_id}",
        violation.rowid.map_or_else(|| "null".to_string(), |rowid| rowid.to_string()),
        table = violation.table,
        parent = violation.parent,
        foreign_key_id = violation.foreign_key_id,
    )
}

fn rewrite_declared_column_types(create_sql: &str, type_changes: &BTreeMap<String, String>) -> Result<String, String> {
    let (body_start, body_end) = find_create_table_body_span(create_sql)
        .ok_or_else(|| "SQLite CREATE TABLE statement could not be parsed safely.".to_string())?;
    let body = &create_sql[body_start + 1..body_end];
    let mut replacements = Vec::new();
    let mut found = HashSet::new();

    for (entry_start, entry_end) in split_entry_ranges(body) {
        let entry = &body[entry_start..entry_end];
        let Some((name, type_start, type_end)) = parse_column_type_span(entry) else {
            continue;
        };
        let key = name.to_ascii_lowercase();
        let Some(next_type) = type_changes.get(&key) else {
            continue;
        };
        if !found.insert(key.clone()) {
            return Err(format!("SQLite CREATE TABLE contains duplicate column definition \"{name}\"."));
        }
        let replacement = if type_start == type_end { format!("{next_type} ") } else { next_type.clone() };
        replacements.push((
            body_start + 1 + entry_start + type_start,
            body_start + 1 + entry_start + type_end,
            replacement,
        ));
    }

    for name in type_changes.keys() {
        if !found.contains(name) {
            return Err(format!(
                "Column \"{name}\" could not be located unambiguously in the SQLite CREATE TABLE statement."
            ));
        }
    }

    let mut rewritten = create_sql.to_string();
    for (start, end, replacement) in replacements.into_iter().rev() {
        rewritten.replace_range(start..end, &replacement);
    }
    Ok(rewritten)
}

fn find_create_table_body_span(sql: &str) -> Option<(usize, usize)> {
    let mut mode = ScanMode::Normal;
    let mut depth = 0_usize;
    let mut start = None;
    let bytes = sql.as_bytes();
    let mut index = 0_usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match mode {
            ScanMode::Normal => match byte {
                b'\'' => mode = ScanMode::SingleQuote,
                b'"' => mode = ScanMode::DoubleQuote,
                b'`' => mode = ScanMode::Backtick,
                b'[' => mode = ScanMode::Bracket,
                b'-' if bytes.get(index + 1) == Some(&b'-') => {
                    mode = ScanMode::LineComment;
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    mode = ScanMode::BlockComment;
                    index += 1;
                }
                b'(' => {
                    if start.is_none() {
                        start = Some(index);
                    }
                    depth += 1;
                }
                b')' if depth > 0 => {
                    depth -= 1;
                    if depth == 0 {
                        return Some((start?, index));
                    }
                }
                _ => {}
            },
            ScanMode::SingleQuote => {
                if byte == b'\'' {
                    if bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::DoubleQuote => {
                if byte == b'"' {
                    if bytes.get(index + 1) == Some(&b'"') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Backtick => {
                if byte == b'`' {
                    if bytes.get(index + 1) == Some(&b'`') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Bracket => {
                if byte == b']' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::LineComment => {
                if byte == b'\n' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::BlockComment => {
                if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    mode = ScanMode::Normal;
                    index += 1;
                }
            }
        }
        index += 1;
    }
    None
}

fn split_entry_ranges(body: &str) -> Vec<(usize, usize)> {
    let bytes = body.as_bytes();
    let mut ranges = Vec::new();
    let mut mode = ScanMode::Normal;
    let mut depth = 0_usize;
    let mut entry_start = 0_usize;
    let mut index = 0_usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match mode {
            ScanMode::Normal => match byte {
                b'\'' => mode = ScanMode::SingleQuote,
                b'"' => mode = ScanMode::DoubleQuote,
                b'`' => mode = ScanMode::Backtick,
                b'[' => mode = ScanMode::Bracket,
                b'-' if bytes.get(index + 1) == Some(&b'-') => {
                    mode = ScanMode::LineComment;
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    mode = ScanMode::BlockComment;
                    index += 1;
                }
                b'(' => depth += 1,
                b')' => depth = depth.saturating_sub(1),
                b',' if depth == 0 => {
                    ranges.push(trimmed_range(body, entry_start, index));
                    entry_start = index + 1;
                }
                _ => {}
            },
            ScanMode::SingleQuote => {
                if byte == b'\'' {
                    if bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::DoubleQuote => {
                if byte == b'"' {
                    if bytes.get(index + 1) == Some(&b'"') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Backtick => {
                if byte == b'`' {
                    if bytes.get(index + 1) == Some(&b'`') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Bracket => {
                if byte == b']' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::LineComment => {
                if byte == b'\n' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::BlockComment => {
                if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    mode = ScanMode::Normal;
                    index += 1;
                }
            }
        }
        index += 1;
    }
    ranges.push(trimmed_range(body, entry_start, body.len()));
    ranges.into_iter().filter(|(start, end)| start < end).collect()
}

fn trimmed_range(value: &str, mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end && value.as_bytes()[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && value.as_bytes()[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    (start, end)
}

fn parse_column_type_span(entry: &str) -> Option<(String, usize, usize)> {
    let name_start = skip_space_and_comments(entry, 0)?;
    let (name, name_end, quoted) = parse_identifier(entry, name_start)?;
    if !quoted
        && matches!(name.to_ascii_lowercase().as_str(), "constraint" | "primary" | "unique" | "check" | "foreign")
    {
        return None;
    }
    let type_start = skip_space_and_comments(entry, name_end).unwrap_or(entry.len());
    let constraint_start = find_column_constraint_start(entry, type_start).unwrap_or(entry.len());
    let mut type_end = constraint_start;
    while type_end > type_start && entry.as_bytes()[type_end - 1].is_ascii_whitespace() {
        type_end -= 1;
    }
    Some((name, type_start, type_end))
}

fn parse_identifier(value: &str, start: usize) -> Option<(String, usize, bool)> {
    let bytes = value.as_bytes();
    let first = *bytes.get(start)?;
    if matches!(first, b'"' | b'`' | b'[') {
        let close = if first == b'[' { b']' } else { first };
        let mut decoded = String::new();
        let mut index = start + 1;
        while index < bytes.len() {
            if bytes[index] == close {
                if close != b']' && bytes.get(index + 1) == Some(&close) {
                    decoded.push(close as char);
                    index += 2;
                    continue;
                }
                return Some((decoded, index + 1, true));
            }
            let ch = value[index..].chars().next()?;
            decoded.push(ch);
            index += ch.len_utf8();
        }
        return None;
    }

    let mut end = start;
    while end < bytes.len() {
        let ch = value[end..].chars().next()?;
        if ch.is_whitespace() || matches!(ch, '(' | ')' | ',' | ';') {
            break;
        }
        end += ch.len_utf8();
    }
    (end > start).then(|| (value[start..end].to_string(), end, false))
}

fn skip_space_and_comments(value: &str, mut index: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) == Some(&b'-') && bytes.get(index + 1) == Some(&b'-') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes.get(index) == Some(&b'/') && bytes.get(index + 1) == Some(&b'*') {
            let tail = value.get(index + 2..)?;
            let end = tail.find("*/")?;
            index += end + 4;
            continue;
        }
        return Some(index);
    }
}

fn find_column_constraint_start(value: &str, start: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut mode = ScanMode::Normal;
    let mut depth = 0_usize;
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        match mode {
            ScanMode::Normal => match byte {
                b'\'' => mode = ScanMode::SingleQuote,
                b'"' => mode = ScanMode::DoubleQuote,
                b'`' => mode = ScanMode::Backtick,
                b'[' => mode = ScanMode::Bracket,
                b'-' if bytes.get(index + 1) == Some(&b'-') => {
                    mode = ScanMode::LineComment;
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    mode = ScanMode::BlockComment;
                    index += 1;
                }
                b'(' => depth += 1,
                b')' => depth = depth.saturating_sub(1),
                _ if depth == 0 && (byte.is_ascii_alphabetic() || byte == b'_') => {
                    let word_start = index;
                    index += 1;
                    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
                        index += 1;
                    }
                    if is_column_constraint_keyword(&value[word_start..index]) {
                        return Some(word_start);
                    }
                    continue;
                }
                _ => {}
            },
            ScanMode::SingleQuote => {
                if byte == b'\'' {
                    if bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::DoubleQuote => {
                if byte == b'"' {
                    if bytes.get(index + 1) == Some(&b'"') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Backtick => {
                if byte == b'`' {
                    if bytes.get(index + 1) == Some(&b'`') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Bracket => {
                if byte == b']' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::LineComment => {
                if byte == b'\n' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::BlockComment => {
                if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    mode = ScanMode::Normal;
                    index += 1;
                }
            }
        }
        index += 1;
    }
    None
}

fn is_column_constraint_keyword(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "primary" | "not" | "unique" | "check" | "default" | "collate" | "references" | "generated"
    )
}

fn validate_declared_type(data_type: &str) -> Result<(), String> {
    let data_type = data_type.trim();
    if data_type.is_empty() {
        return Err("declared type cannot be empty.".to_string());
    }
    if data_type.contains(';')
        || data_type.contains("--")
        || data_type.contains("/*")
        || data_type.contains("*/")
        || data_type.chars().any(|ch| matches!(ch, '\'' | '"' | '`' | '[' | ']'))
    {
        return Err("declared type contains SQL syntax that is not allowed in a type name.".to_string());
    }
    let mut depth = 0_i32;
    for ch in data_type.chars() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return Err("declared type has unbalanced parentheses.".to_string());
                }
            }
            ',' if depth == 0 => return Err("declared type contains a top-level comma.".to_string()),
            _ if ch.is_ascii_alphanumeric()
                || ch == '_'
                || ch.is_ascii_whitespace()
                || matches!(ch, '(' | ')' | ',') => {}
            _ => return Err(format!("declared type contains unsupported character \"{ch}\".")),
        }
    }
    if depth != 0 {
        return Err("declared type has unbalanced parentheses.".to_string());
    }
    if data_type
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter(|word| !word.is_empty())
        .any(is_column_constraint_keyword)
    {
        return Err("declared type cannot include column constraints.".to_string());
    }
    Ok(())
}

fn has_trigger_edits(options: &TableStructureSqlOptions) -> bool {
    options.triggers.iter().any(|trigger| {
        if trigger.marked_for_drop || trigger.original.is_none() {
            return true;
        }
        let original = trigger.original.as_ref().unwrap();
        clean(&trigger.name) != clean(&original.name)
            || !clean(&trigger.timing).eq_ignore_ascii_case(&clean(&original.timing))
            || !clean(&trigger.event).eq_ignore_ascii_case(&clean(&original.event))
            || clean(&trigger.statement).trim_end_matches(';').trim()
                != clean(original.statement.as_deref().unwrap_or("")).trim_end_matches(';').trim()
    })
}

fn normalize_type_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()
}

fn has_without_rowid_clause(tail: &str) -> bool {
    sql_words_outside_comments_and_quotes(tail)
        .windows(2)
        .any(|words| words[0].eq_ignore_ascii_case("without") && words[1].eq_ignore_ascii_case("rowid"))
}

fn hidden_rowid_is_shadowed(snapshot: &SqliteSchemaSnapshot) -> Result<bool, String> {
    if snapshot_is_without_rowid(snapshot)? {
        return Ok(false);
    }
    let names = snapshot.columns.iter().map(|column| column.name.to_ascii_lowercase()).collect::<HashSet<_>>();
    Ok(["rowid", "_rowid_", "oid"].into_iter().all(|alias| names.contains(alias)))
}

fn snapshot_is_without_rowid(snapshot: &SqliteSchemaSnapshot) -> Result<bool, String> {
    let (_, body_end) = find_create_table_body_span(&snapshot.table_sql)
        .ok_or_else(|| "SQLite CREATE TABLE statement could not be parsed safely.".to_string())?;
    Ok(has_without_rowid_clause(&snapshot.table_sql[body_end + 1..]))
}

fn contains_sql_keyword(sql: &str, keyword: &str) -> bool {
    sql_words_outside_comments_and_quotes(sql).iter().any(|word| word.eq_ignore_ascii_case(keyword))
}

fn sql_words_outside_comments_and_quotes(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut words = Vec::new();
    let mut mode = ScanMode::Normal;
    let mut index = 0_usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match mode {
            ScanMode::Normal => match byte {
                b'\'' => mode = ScanMode::SingleQuote,
                b'"' => mode = ScanMode::DoubleQuote,
                b'`' => mode = ScanMode::Backtick,
                b'[' => mode = ScanMode::Bracket,
                b'-' if bytes.get(index + 1) == Some(&b'-') => {
                    mode = ScanMode::LineComment;
                    index += 1;
                }
                b'/' if bytes.get(index + 1) == Some(&b'*') => {
                    mode = ScanMode::BlockComment;
                    index += 1;
                }
                _ if byte.is_ascii_alphabetic() || byte == b'_' => {
                    let start = index;
                    index += 1;
                    while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
                        index += 1;
                    }
                    words.push(sql[start..index].to_string());
                    continue;
                }
                _ => {}
            },
            ScanMode::SingleQuote => {
                if byte == b'\'' {
                    if bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::DoubleQuote => {
                if byte == b'"' {
                    if bytes.get(index + 1) == Some(&b'"') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Backtick => {
                if byte == b'`' {
                    if bytes.get(index + 1) == Some(&b'`') {
                        index += 1;
                    } else {
                        mode = ScanMode::Normal;
                    }
                }
            }
            ScanMode::Bracket => {
                if byte == b']' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::LineComment => {
                if byte == b'\n' {
                    mode = ScanMode::Normal;
                }
            }
            ScanMode::BlockComment => {
                if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    mode = ScanMode::Normal;
                    index += 1;
                }
            }
        }
        index += 1;
    }
    words
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn qualified_name(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

fn ensure_statement_terminated(statement: &mut String) {
    if !statement.trim_end().ends_with(';') {
        statement.push(';');
    }
}

fn deduplicate_warnings(warnings: &mut Vec<String>) {
    let mut seen = HashSet::new();
    warnings.retain(|warning| seen.insert(warning.clone()));
}

#[derive(Debug, Clone, Copy)]
enum ScanMode {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    Bracket,
    LineComment,
    BlockComment,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table_structure_sql::{
        ColumnExtra, ColumnInfo, EditableStructureColumn, EditableStructureIndex, IndexInfo,
    };

    fn type_change_options(
        table_name: &str,
        column_name: &str,
        old_type: &str,
        new_type: &str,
    ) -> TableStructureSqlOptions {
        TableStructureSqlOptions {
            database_type: Some(DatabaseType::Sqlite),
            schema: None,
            table_name: table_name.to_string(),
            columns: vec![EditableStructureColumn {
                id: column_name.to_string(),
                name: column_name.to_string(),
                data_type: new_type.to_string(),
                is_nullable: false,
                default_value: String::new(),
                comment: String::new(),
                is_primary_key: false,
                extra: None,
                original: Some(ColumnInfo {
                    name: column_name.to_string(),
                    data_type: old_type.to_string(),
                    is_nullable: false,
                    column_default: None,
                    is_primary_key: false,
                    extra: None,
                    comment: None,
                    character_set: None,
                    collation: None,
                }),
                original_position: Some(1),
                marked_for_drop: false,
                character_set: String::new(),
                collation: String::new(),
            }],
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            table_comment: None,
            original_table_comment: None,
        }
    }

    #[test]
    fn rewrites_only_target_column_type_and_preserves_table_tail() {
        let sql = r#"CREATE TABLE "items" (
  "id" INTEGER PRIMARY KEY,
  [value] VARCHAR(20) NOT NULL DEFAULT (printf('%s,%s', 'a', 'b')),
  note DOUBLE PRECISION CHECK (note > 0),
  CONSTRAINT "uq_value" UNIQUE ([value])
) STRICT, WITHOUT ROWID"#;
        let changes = BTreeMap::from([
            ("value".to_string(), "TEXT".to_string()),
            ("note".to_string(), "DECIMAL(12, 4)".to_string()),
        ]);

        let rewritten = rewrite_declared_column_types(sql, &changes).unwrap();

        assert!(rewritten.contains("[value] TEXT NOT NULL DEFAULT (printf('%s,%s', 'a', 'b'))"));
        assert!(rewritten.contains("note DECIMAL(12, 4) CHECK (note > 0)"));
        assert!(rewritten.contains("CONSTRAINT \"uq_value\" UNIQUE ([value])"));
        assert!(rewritten.ends_with("STRICT, WITHOUT ROWID"));
        assert!(!has_without_rowid_clause("/* WITHOUT ROWID */ STRICT"));
        assert!(has_without_rowid_clause("STRICT, WITHOUT /* keep */ ROWID"));
    }

    #[tokio::test]
    async fn rebuild_preserves_data_generated_columns_indexes_triggers_and_foreign_key_state() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        pool.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE parent(id INTEGER PRIMARY KEY);
                 INSERT INTO parent VALUES (1);
                 CREATE TABLE audit(message TEXT);
                 CREATE TABLE items(
                   id INTEGER PRIMARY KEY,
                   value TEXT NOT NULL,
                   doubled TEXT GENERATED ALWAYS AS (value || value) STORED,
                   parent_id INTEGER REFERENCES parent(id)
                 ) STRICT;
                 CREATE INDEX idx_items_value ON items(value) WHERE value IS NOT NULL;
                 CREATE TRIGGER trg_items_ai AFTER INSERT ON items BEGIN INSERT INTO audit VALUES (NEW.value); END;
                 INSERT INTO items(id, value, parent_id) VALUES (7, '42', 1);
                 CREATE TABLE item_refs(item_id INTEGER REFERENCES items(id));
                 INSERT INTO item_refs VALUES (7);",
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");

        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);
        assert!(preview.statements.iter().any(|sql| sql.contains("BEGIN IMMEDIATE")));
        assert!(preview.statements.iter().any(|sql| sql.contains("legacy_alter_table = ON")));
        let foreign_key_checks = preview
            .statements
            .iter()
            .enumerate()
            .filter(|(_, sql)| sql.starts_with("PRAGMA") && sql.contains("foreign_key_check"))
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let rename_position = preview.statements.iter().position(|sql| sql.starts_with("ALTER TABLE")).unwrap();
        let create_position = preview
            .statements
            .iter()
            .enumerate()
            .filter(|(_, sql)| sql.starts_with("CREATE TABLE"))
            .nth(1)
            .map(|(index, _)| index)
            .unwrap();
        let copy_position = preview.statements.iter().position(|sql| sql.contains("CAST(")).unwrap();
        assert_eq!(foreign_key_checks.len(), 2);
        assert!(foreign_key_checks[0] < rename_position);
        assert!(foreign_key_checks[1] > copy_position);
        assert!(rename_position < create_position && create_position < copy_position);
        assert!(preview.statements.iter().any(|sql| sql.starts_with("DROP TABLE") && sql.contains("__dbx_source_")));
        assert!(!preview.statements.iter().any(|sql| sql.starts_with("DROP TABLE") && sql.contains("\"items_")));
        assert!(preview.statements[copy_position].contains("CAST("));
        assert!(preview.statements[copy_position].contains(" AS INTEGER)"));
        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT typeof(value), value, doubled, rowid, id FROM items;")
            .await
            .unwrap();
        assert_eq!(result.rows[0], serde_json::json!(["integer", 42, "4242", 7, 7]).as_array().unwrap().clone());
        let schema = db::sqlite::execute_query(
            &pool,
            "SELECT type, name FROM sqlite_schema WHERE name IN ('idx_items_value', 'trg_items_ai') ORDER BY type;",
        )
        .await
        .unwrap();
        assert_eq!(schema.rows.len(), 2);
        let foreign_keys = db::sqlite::execute_query(&pool, "PRAGMA foreign_keys;").await.unwrap();
        assert_eq!(foreign_keys.rows[0][0], serde_json::json!(1));
        let legacy_alter_table = db::sqlite::execute_query(&pool, "PRAGMA legacy_alter_table;").await.unwrap();
        assert_eq!(legacy_alter_table.rows[0][0], serde_json::json!(0));
        let child_reference = db::sqlite::execute_query(&pool, "PRAGMA foreign_key_list(item_refs);").await.unwrap();
        assert_eq!(child_reference.rows[0][2], serde_json::json!("items"));
        let violations = db::sqlite::execute_query(&pool, "PRAGMA foreign_key_check;").await.unwrap();
        assert!(violations.rows.is_empty());
        let backups = db::sqlite::execute_query(
            &pool,
            "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'items_[0-9]*';",
        )
        .await
        .unwrap();
        assert_eq!(backups.rows.len(), 1);
        let backup_name = backups.rows[0][0].as_str().unwrap();
        let backup_suffix = backup_name.strip_prefix("items_").unwrap();
        assert_eq!(backup_suffix.len(), 12);
        assert!(backup_suffix.chars().all(|ch| ch.is_ascii_digit()));
        let backup_data = db::sqlite::execute_query(
            &pool,
            &format!("SELECT typeof(value), value FROM {};", quote_ident(backup_name)),
        )
        .await
        .unwrap();
        assert_eq!(backup_data.rows[0], serde_json::json!(["text", "42"]).as_array().unwrap().clone());
    }

    #[tokio::test]
    async fn unrelated_existing_foreign_key_violation_does_not_block_rebuild() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        pool.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys=OFF;
                 CREATE TABLE unrelated_parent(id INTEGER PRIMARY KEY);
                 CREATE TABLE unrelated_child(parent_id INTEGER REFERENCES unrelated_parent(id));
                 INSERT INTO unrelated_child VALUES (999);
                 CREATE TABLE healthy(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO healthy VALUES (1, '42');
                 PRAGMA foreign_keys=ON;",
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let options = type_change_options("healthy", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let value = db::sqlite::execute_query(&pool, "SELECT typeof(value), value FROM healthy;").await.unwrap();
        assert_eq!(value.rows[0], serde_json::json!(["integer", 42]).as_array().unwrap().clone());
        let violations = db::sqlite::execute_query(&pool, "PRAGMA foreign_key_check;").await.unwrap();
        assert_eq!(violations.rows.len(), 1);
        assert_eq!(violations.rows[0][0], serde_json::json!("unrelated_child"));
    }

    #[tokio::test]
    async fn newly_introduced_inbound_foreign_key_violation_rolls_back_rebuild() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        pool.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE parent(value TEXT NOT NULL UNIQUE);
                 CREATE TABLE child(parent_value TEXT REFERENCES parent(value));
                 INSERT INTO parent VALUES ('abc');
                 INSERT INTO child VALUES ('abc');",
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let options = type_change_options("parent", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        let error = apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision)
            .await
            .unwrap_err();

        assert!(error.contains("new violation") && error.contains("table=child"), "{error}");
        let parent = db::sqlite::execute_query(&pool, "SELECT typeof(value), value FROM parent;").await.unwrap();
        assert_eq!(parent.rows[0], serde_json::json!(["text", "abc"]).as_array().unwrap().clone());
        let violations = db::sqlite::execute_query(&pool, "PRAGMA foreign_key_check;").await.unwrap();
        assert!(violations.rows.is_empty());
    }

    #[tokio::test]
    async fn retained_backup_is_inert_and_does_not_participate_in_foreign_key_actions() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        pool.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE parent(id INTEGER PRIMARY KEY);
                 CREATE TABLE items(
                   id INTEGER PRIMARY KEY,
                   parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE,
                   value TEXT NOT NULL
                 );
                 INSERT INTO parent VALUES (1);
                 INSERT INTO items VALUES (7, 1, '42');",
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let backups = db::sqlite::execute_query(
            &pool,
            "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'items_[0-9]*';",
        )
        .await
        .unwrap();
        let backup_name = backups.rows[0][0].as_str().unwrap();
        let backup_foreign_keys =
            db::sqlite::execute_query(&pool, &format!("PRAGMA foreign_key_list({});", quote_string(backup_name)))
                .await
                .unwrap();
        assert!(backup_foreign_keys.rows.is_empty());

        db::sqlite::execute_query(&pool, "DELETE FROM parent WHERE id = 1;").await.unwrap();
        let current_rows = db::sqlite::execute_query(&pool, "SELECT count(*) FROM items;").await.unwrap();
        assert_eq!(current_rows.rows[0][0], serde_json::json!(0));
        let backup_rows = db::sqlite::execute_query(
            &pool,
            &format!("SELECT count(*) FROM {} WHERE parent_id = 1;", quote_ident(backup_name)),
        )
        .await
        .unwrap();
        assert_eq!(backup_rows.rows[0][0], serde_json::json!(1));
    }

    #[tokio::test]
    async fn successive_rebuilds_keep_distinct_backup_tables() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(&pool, "CREATE TABLE items(value TEXT NOT NULL); INSERT INTO items VALUES ('42');")
            .await
            .unwrap();

        let first = type_change_options("items", "value", "TEXT", "INTEGER");
        let first_preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), first.clone()).await.unwrap();
        apply_sqlite_table_structure_change_with_pool(pool.clone(), first, &first_preview.schema_revision)
            .await
            .unwrap();

        let second = type_change_options("items", "value", "INTEGER", "REAL");
        let second_preview =
            preview_sqlite_table_structure_change_with_pool(pool.clone(), second.clone()).await.unwrap();
        apply_sqlite_table_structure_change_with_pool(pool.clone(), second, &second_preview.schema_revision)
            .await
            .unwrap();

        let backups = db::sqlite::execute_query(
            &pool,
            "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'items_[0-9]*' ORDER BY name;",
        )
        .await
        .unwrap();
        assert_eq!(backups.rows.len(), 2);
        assert_ne!(backups.rows[0][0], backups.rows[1][0]);
    }

    #[tokio::test]
    async fn type_change_can_drop_an_explicit_unique_index_before_casting() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(value TEXT NOT NULL);
             CREATE UNIQUE INDEX uq_items_value ON items(value);
             INSERT INTO items VALUES ('01'), ('1');",
        )
        .await
        .unwrap();
        let mut options = type_change_options("items", "value", "TEXT", "INTEGER");
        options.indexes.push(EditableStructureIndex {
            id: "uq_items_value".to_string(),
            name: "uq_items_value".to_string(),
            columns: vec!["value".to_string()],
            is_unique: true,
            is_primary: false,
            filter: String::new(),
            index_type: String::new(),
            included_columns: Vec::new(),
            comment: String::new(),
            original: Some(IndexInfo {
                name: "uq_items_value".to_string(),
                columns: vec!["value".to_string()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            }),
            marked_for_drop: true,
        });
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let values = db::sqlite::execute_query(&pool, "SELECT value FROM items ORDER BY rowid;").await.unwrap();
        assert_eq!(values.rows, vec![vec![serde_json::json!(1)], vec![serde_json::json!(1)]]);
        let indexes = db::sqlite::execute_query(
            &pool,
            "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='uq_items_value';",
        )
        .await
        .unwrap();
        assert_eq!(indexes.rows[0][0], serde_json::json!(0));
    }

    #[tokio::test]
    async fn stale_revision_is_rejected_before_mutation() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(&pool, "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL);")
            .await
            .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        db::sqlite::execute_query(&pool, "ALTER TABLE items ADD COLUMN note TEXT;").await.unwrap();

        let error = apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision)
            .await
            .unwrap_err();

        assert!(error.contains("schema changed"));
        let result = db::sqlite::execute_query(&pool, "PRAGMA table_info(items);").await.unwrap();
        assert_eq!(result.rows.len(), 3);
    }

    #[tokio::test]
    async fn cast_constraint_failure_rolls_back_backup_and_restores_pragmas() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        pool.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE) STRICT;
                 CREATE INDEX idx_items_value ON items(value);
                 INSERT INTO items(id, value) VALUES (1, '01'), (2, '1');",
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        let error = apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision)
            .await
            .unwrap_err();

        assert!(error.contains("structure statement") && error.contains("failed"), "{error}");
        let result =
            db::sqlite::execute_query(&pool, "SELECT type FROM pragma_table_info('items') WHERE name='value';")
                .await
                .unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("TEXT"));
        let data = db::sqlite::execute_query(&pool, "SELECT value FROM items;").await.unwrap();
        assert_eq!(data.rows.len(), 2);
        assert_eq!(data.rows[0][0], serde_json::json!("01"));
        assert_eq!(data.rows[1][0], serde_json::json!("1"));
        let index = db::sqlite::execute_query(
            &pool,
            "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='idx_items_value';",
        )
        .await
        .unwrap();
        assert_eq!(index.rows[0][0], serde_json::json!(1));
        let foreign_keys = db::sqlite::execute_query(&pool, "PRAGMA foreign_keys;").await.unwrap();
        assert_eq!(foreign_keys.rows[0][0], serde_json::json!(1));
        let legacy_alter_table = db::sqlite::execute_query(&pool, "PRAGMA legacy_alter_table;").await.unwrap();
        assert_eq!(legacy_alter_table.rows[0][0], serde_json::json!(0));
        let backup =
            db::sqlite::execute_query(&pool, "SELECT count(*) FROM sqlite_schema WHERE name GLOB 'items_[0-9]*';")
                .await
                .unwrap();
        assert_eq!(backup.rows[0][0], serde_json::json!(0));
    }

    #[tokio::test]
    async fn rebuild_preserves_autoincrement_high_water_mark() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);\
             INSERT INTO items(id, value) VALUES (100, '42');\
             DELETE FROM items;\
             INSERT INTO items(id, value) VALUES (1, '7');",
        )
        .await
        .unwrap();
        let mut options = type_change_options("items", "value", "TEXT", "INTEGER");
        options.columns.insert(
            0,
            EditableStructureColumn {
                id: "id".to_string(),
                name: "id".to_string(),
                data_type: "INTEGER".to_string(),
                is_nullable: true,
                default_value: String::new(),
                comment: String::new(),
                is_primary_key: true,
                extra: Some(ColumnExtra::default()),
                original: Some(ColumnInfo {
                    name: "id".to_string(),
                    data_type: "INTEGER".to_string(),
                    is_nullable: true,
                    column_default: None,
                    is_primary_key: true,
                    extra: Some("autoincrement".to_string()),
                    comment: None,
                    character_set: None,
                    collation: None,
                }),
                original_position: Some(0),
                marked_for_drop: false,
                character_set: String::new(),
                collation: String::new(),
            },
        );
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();
        db::sqlite::execute_query(&pool, "INSERT INTO items(value) VALUES (8);").await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT max(id) FROM items;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(101));
    }

    #[tokio::test]
    async fn revision_is_bound_to_the_structure_draft() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(&pool, "CREATE TABLE items(value TEXT NOT NULL);").await.unwrap();
        let integer_options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview =
            preview_sqlite_table_structure_change_with_pool(pool.clone(), integer_options.clone()).await.unwrap();
        let real_options = type_change_options("items", "value", "TEXT", "REAL");

        let error = apply_sqlite_table_structure_change_with_pool(pool.clone(), real_options, &preview.schema_revision)
            .await
            .unwrap_err();

        assert!(error.contains("structure draft differs"));
        let result =
            db::sqlite::execute_query(&pool, "SELECT type FROM pragma_table_info('items') WHERE name='value';")
                .await
                .unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("TEXT"));
    }

    #[tokio::test]
    async fn rebuild_preserves_hidden_rowid_for_ordinary_tables() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(value TEXT NOT NULL) /* WITHOUT ROWID */ STRICT;\
             INSERT INTO items(rowid, value) VALUES (17, '42');",
        )
        .await
        .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT rowid, typeof(value), value FROM items;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(17));
        assert_eq!(result.rows[0][1], serde_json::json!("integer"));
        assert_eq!(result.rows[0][2], serde_json::json!(42));
    }

    #[tokio::test]
    async fn cast_copy_preserves_null_and_does_not_cast_unchanged_columns() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(value TEXT, note TEXT NOT NULL);\
             INSERT INTO items(value, note) VALUES (NULL, 'first'), ('12', 'second');",
        )
        .await
        .unwrap();
        let mut options = type_change_options("items", "value", "TEXT", "INTEGER");
        options.columns[0].is_nullable = true;
        options.columns[0].original.as_mut().unwrap().is_nullable = true;
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        let copy = preview.statements.iter().find(|sql| sql.contains("CAST(")).unwrap();
        assert!(copy.contains("CAST(\"__dbx_source\".\"value\" AS INTEGER)"));
        assert!(!copy.contains("CAST(\"__dbx_source\".\"note\""));

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT value, typeof(value), note FROM items ORDER BY rowid;")
            .await
            .unwrap();
        assert_eq!(result.rows[0], serde_json::json!([null, "null", "first"]).as_array().unwrap().clone());
        assert_eq!(result.rows[1], serde_json::json!([12, "integer", "second"]).as_array().unwrap().clone());
    }

    #[tokio::test]
    async fn strict_table_uses_sqlite_cast_semantics_for_incompatible_text() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(value TEXT NOT NULL) STRICT; INSERT INTO items VALUES ('not-a-number');",
        )
        .await
        .unwrap();
        let options = type_change_options("items", "value", "TEXT", "INTEGER");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT typeof(value), value FROM items;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("integer"));
        assert_eq!(result.rows[0][1], serde_json::json!(0));
    }

    #[tokio::test]
    async fn text_email_to_float4_uses_explicit_real_cast() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE users(email TEXT NOT NULL); INSERT INTO users VALUES ('alice@example.com');",
        )
        .await
        .unwrap();
        let options = type_change_options("users", "email", "TEXT", "float4");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        let copy = preview.statements.iter().find(|sql| sql.contains("CAST(")).unwrap();
        assert!(copy.contains("CAST(\"__dbx_source\".\"email\" AS float4)"));

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT typeof(email), email FROM users;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("real"));
        assert_eq!(result.rows[0][1], serde_json::json!(0.0));
    }

    #[tokio::test]
    async fn combined_column_rename_and_type_change_casts_source_then_updates_dependencies() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE audit(message TEXT);
             CREATE TABLE items(old_value TEXT NOT NULL);
             CREATE INDEX idx_items_old_value ON items(old_value);
             CREATE TRIGGER trg_items_update AFTER UPDATE OF old_value ON items
             BEGIN INSERT INTO audit VALUES (NEW.old_value); END;
             INSERT INTO items VALUES ('7');",
        )
        .await
        .unwrap();
        let mut options = type_change_options("items", "old_value", "TEXT", "INTEGER");
        options.columns[0].name = "new_value".to_string();
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        let copy = preview.statements.iter().find(|sql| sql.contains("CAST(")).unwrap();
        assert!(copy.contains("CAST(\"__dbx_source\".\"old_value\" AS INTEGER)"));

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result = db::sqlite::execute_query(&pool, "SELECT typeof(new_value), new_value FROM items;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("integer"));
        assert_eq!(result.rows[0][1], serde_json::json!(7));
        let dependencies = db::sqlite::execute_query(
            &pool,
            "SELECT sql FROM sqlite_schema WHERE name IN ('idx_items_old_value', 'trg_items_update') ORDER BY type;",
        )
        .await
        .unwrap();
        assert_eq!(dependencies.rows.len(), 2);
        assert!(dependencies.rows.iter().all(|row| row[0].as_str().unwrap().contains("new_value")));
        db::sqlite::execute_query(&pool, "UPDATE items SET new_value = 8;").await.unwrap();
        let audit = db::sqlite::execute_query(&pool, "SELECT message FROM audit;").await.unwrap();
        assert_eq!(audit.rows[0][0], serde_json::json!("8"));
    }

    #[tokio::test]
    async fn rebuild_blocks_shadowed_hidden_rowid_and_integer_primary_key_alias_changes() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE shadowed(rowid TEXT, _rowid_ TEXT, oid TEXT, value TEXT NOT NULL);",
        )
        .await
        .unwrap();
        let shadowed = type_change_options("shadowed", "value", "TEXT", "INTEGER");
        let shadowed_preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), shadowed).await.unwrap();
        assert!(shadowed_preview.warnings.iter().any(|warning| warning.contains("hidden rowid")));

        db::sqlite::execute_query(&pool, "CREATE TABLE keyed(id TEXT PRIMARY KEY);").await.unwrap();
        let mut keyed = type_change_options("keyed", "id", "TEXT", "INTEGER");
        keyed.columns[0].is_nullable = true;
        keyed.columns[0].is_primary_key = true;
        keyed.columns[0].original.as_mut().unwrap().is_nullable = true;
        keyed.columns[0].original.as_mut().unwrap().is_primary_key = true;
        let keyed_preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), keyed).await.unwrap();
        assert!(keyed_preview.warnings.iter().any(|warning| warning.contains("rowid alias semantics")));
    }

    #[tokio::test]
    async fn virtual_tables_are_rejected_using_table_list_kind() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(&pool, "CREATE VIRTUAL TABLE docs USING fts5(content);").await.unwrap();
        let options = type_change_options("docs", "content", "", "TEXT");

        let error = preview_sqlite_table_structure_change_with_pool(pool, options).await.unwrap_err();

        assert!(error.contains("table_list type \"virtual\""), "{error}");
    }

    #[tokio::test]
    async fn fts_shadow_tables_are_rejected_using_table_list_kind() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(&pool, "CREATE VIRTUAL TABLE docs USING fts5(content);").await.unwrap();
        let options = type_change_options("docs_data", "id", "INTEGER", "TEXT");

        let error = preview_sqlite_table_structure_change_with_pool(pool, options).await.unwrap_err();

        assert!(error.contains("table_list type \"shadow\""), "{error}");
    }

    #[tokio::test]
    async fn without_rowid_composite_primary_key_type_change_preserves_data() {
        let pool = db::sqlite::connect_path(":memory:").await.unwrap();
        db::sqlite::execute_query(
            &pool,
            "CREATE TABLE items(\
               part TEXT NOT NULL,\
               seq INTEGER NOT NULL,\
               value TEXT,\
               PRIMARY KEY(part, seq)\
             ) WITHOUT ROWID;\
             INSERT INTO items(part, seq, value) VALUES ('a', 7, 'kept');",
        )
        .await
        .unwrap();
        let options = type_change_options("items", "seq", "INTEGER", "TEXT");
        let preview = preview_sqlite_table_structure_change_with_pool(pool.clone(), options.clone()).await.unwrap();
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);

        apply_sqlite_table_structure_change_with_pool(pool.clone(), options, &preview.schema_revision).await.unwrap();

        let result =
            db::sqlite::execute_query(&pool, "SELECT part, typeof(seq), seq, value FROM items;").await.unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!("a"));
        assert_eq!(result.rows[0][1], serde_json::json!("text"));
        assert_eq!(result.rows[0][2], serde_json::json!("7"));
        assert_eq!(result.rows[0][3], serde_json::json!("kept"));
    }
}
