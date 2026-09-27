use super::create_table::build_create_table_sql_with_partition_clause;
use super::dialect::{capabilities_for, StructureDialect};
use super::types::{
    TablePartitionBoundDraft, TablePartitionDefinition, TablePartitionOperation, TablePartitionOperationKind,
    TablePartitionSqlOptions, TableStructureSqlOptions, TableStructureSqlResult,
};
use super::util::quote_ident;
use crate::models::connection::DatabaseType;
use crate::types::PgPartitionKind;

/// Engines whose declarative-partition DDL has been verified. Only PostgreSQL
/// and KingbaseES expose the same `pg_partitioned_table` catalog and
/// `CREATE TABLE ... PARTITION OF` / `ATTACH` / `DETACH` syntax. openGauss-based
/// engines (openGauss, Vastbase, GaussDB) use a different `pg_partition`
/// catalog and are intentionally excluded until validated.
fn supports_partition_ddl(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::Kingbase))
}

/// Builds `CREATE TABLE ... PARTITION BY ...` for a table being created.
///
/// Kept separate from `build_create_table_sql` so the widely-used plain builder
/// keeps its signature; shares its implementation through
/// `build_create_table_sql_with_partition_clause`.
pub fn build_create_partitioned_table_sql(
    options: TableStructureSqlOptions,
    definition: TablePartitionDefinition,
) -> TableStructureSqlResult {
    let dialect = capabilities_for(options.database_type, options.driver_profile.as_deref()).dialect;
    if dialect != StructureDialect::Postgres || !supports_partition_ddl(options.database_type) {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["Partitioning is not supported for this database engine.".to_string()],
        };
    }
    let mut warnings = Vec::new();
    let Some(clause) = format_partition_clause(&definition, &mut warnings) else {
        return TableStructureSqlResult { statements: Vec::new(), warnings };
    };
    build_create_table_sql_with_partition_clause(options, Some(clause))
}

/// Renders the body of a `PARTITION BY` clause (without the leading keyword),
/// e.g. `RANGE (region, sold_on)`.
fn format_partition_clause(definition: &TablePartitionDefinition, warnings: &mut Vec<String>) -> Option<String> {
    let keyword = match definition.kind {
        PgPartitionKind::Range => "RANGE",
        PgPartitionKind::List => "LIST",
        PgPartitionKind::Hash => "HASH",
    };
    let expression = definition.expression.trim();
    let key = if !expression.is_empty() {
        expression.to_string()
    } else {
        let columns = definition
            .columns
            .iter()
            .map(|column| column.trim())
            .filter(|column| !column.is_empty())
            .collect::<Vec<_>>();
        if columns.is_empty() {
            warnings.push("A partition key needs at least one column or an expression.".to_string());
            return None;
        }
        columns.iter().map(|column| quote_ident(StructureDialect::Postgres, column)).collect::<Vec<_>>().join(", ")
    };
    Some(format!("PARTITION BY {keyword} ({key})"))
}

/// Builds the DDL for explicit partition maintenance operations
/// (create / attach / detach / drop).
///
/// Gated to the engines in [`supports_partition_ddl`]; a refusal empties the
/// statement list and pushes one warning. Callers surface the warning and block
/// the save, so an unsupported request never silently degrades.
pub fn build_table_partition_operation_sql(options: TablePartitionSqlOptions) -> TableStructureSqlResult {
    if options.operations.is_empty() {
        return TableStructureSqlResult { statements: Vec::new(), warnings: Vec::new() };
    }
    let dialect = capabilities_for(options.database_type, options.driver_profile.as_deref()).dialect;
    if dialect != StructureDialect::Postgres || !supports_partition_ddl(options.database_type) {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["Partition operations are not supported for this database engine.".to_string()],
        };
    }

    let default_schema = options.schema.as_deref().unwrap_or("");
    let mut warnings = Vec::new();
    let mut statements = Vec::new();
    for operation in &options.operations {
        if let Some(statement) = build_operation_sql(operation, default_schema, &options.table_name, &mut warnings) {
            statements.push(statement);
        }
    }
    TableStructureSqlResult { statements, warnings }
}

fn build_operation_sql(
    operation: &TablePartitionOperation,
    default_schema: &str,
    default_parent_table: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let dialect = StructureDialect::Postgres;
    let parent_schema = pick(&operation.parent_schema, default_schema);
    let parent_table = pick(&operation.parent_table, default_parent_table);
    let child_schema = pick(&operation.schema, &parent_schema);
    let name = operation.name.trim();
    if parent_table.is_empty() {
        warnings.push("A partition operation requires a parent table.".to_string());
        return None;
    }
    if name.is_empty() {
        warnings.push("A partition operation requires a partition name.".to_string());
        return None;
    }

    let parent = qualify(dialect, &parent_schema, &parent_table);
    let child = qualify(dialect, &child_schema, name);
    match operation.kind {
        TablePartitionOperationKind::Create => {
            let bound = require_bound(operation, "create", warnings)?;
            Some(format!("CREATE TABLE {child} PARTITION OF {parent} {bound};"))
        }
        TablePartitionOperationKind::Attach => {
            let bound = require_bound(operation, "attach", warnings)?;
            Some(format!("ALTER TABLE {parent} ATTACH PARTITION {child} {bound};"))
        }
        TablePartitionOperationKind::Detach => {
            reject_bound(operation, "detach", warnings)?;
            let concurrently = if operation.concurrently { " CONCURRENTLY" } else { "" };
            Some(format!("ALTER TABLE {parent} DETACH PARTITION {child}{concurrently};"))
        }
        TablePartitionOperationKind::Drop => {
            reject_bound(operation, "drop", warnings)?;
            Some(format!("DROP TABLE {child};"))
        }
    }
}

fn require_bound(operation: &TablePartitionOperation, action: &str, warnings: &mut Vec<String>) -> Option<String> {
    let Some(bound) = operation.bound.as_ref() else {
        warnings.push(format!("A partition {action} operation requires a bound definition."));
        return None;
    };
    format_bound(bound, warnings)
}

fn reject_bound(operation: &TablePartitionOperation, action: &str, warnings: &mut Vec<String>) -> Option<()> {
    if operation.bound.is_some() {
        warnings.push(format!("A partition {action} operation must not carry a bound definition."));
        return None;
    }
    Some(())
}

/// Renders a bound as the `FOR VALUES ...` clause PostgreSQL expects (or a bare
/// `DEFAULT`). Returns `None` and records a warning when the bound is
/// malformed, so the caller can drop just that statement.
fn format_bound(bound: &TablePartitionBoundDraft, warnings: &mut Vec<String>) -> Option<String> {
    match bound {
        TablePartitionBoundDraft::Default => Some("DEFAULT".to_string()),
        TablePartitionBoundDraft::Range { from, to } => {
            if from.is_empty() || from.len() != to.len() {
                warnings
                    .push("A RANGE partition bound needs a FROM and TO tuple of equal, non-zero length.".to_string());
                return None;
            }
            let from = from.iter().map(|value| value.trim()).collect::<Vec<_>>().join(", ");
            let to = to.iter().map(|value| value.trim()).collect::<Vec<_>>().join(", ");
            Some(format!("FOR VALUES FROM ({from}) TO ({to})"))
        }
        TablePartitionBoundDraft::List { values } => {
            if values.is_empty() {
                warnings.push("A LIST partition bound needs at least one value.".to_string());
                return None;
            }
            let values = values.iter().map(|value| value.trim()).collect::<Vec<_>>().join(", ");
            Some(format!("FOR VALUES IN ({values})"))
        }
        TablePartitionBoundDraft::Hash { modulus, remainder } => {
            if *modulus <= 0 || *remainder < 0 || remainder >= modulus {
                warnings.push("A HASH partition bound needs MODULUS > 0 and 0 <= REMAINDER < MODULUS.".to_string());
                return None;
            }
            Some(format!("FOR VALUES WITH (MODULUS {modulus}, REMAINDER {remainder})"))
        }
    }
}

fn pick(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.trim().to_string()
    } else {
        value.to_string()
    }
}

fn qualify(dialect: StructureDialect, schema: &str, table: &str) -> String {
    if schema.is_empty() {
        quote_ident(dialect, table)
    } else {
        format!("{}.{}", quote_ident(dialect, schema), quote_ident(dialect, table))
    }
}
