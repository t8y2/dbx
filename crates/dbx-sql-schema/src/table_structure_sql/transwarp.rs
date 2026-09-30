use super::column_format::column_data_type;
use super::dialect::StructureDialect;
use super::types::{EditableStructureColumn, TableStructureSqlOptions, TranswarpCreateTableOptions};
use super::util::{clean, quote_new_ident, quote_string};
use crate::models::connection::DatabaseType;

pub(super) fn validate_create_options(
    options: &TableStructureSqlOptions,
    active_columns: &[&EditableStructureColumn],
    warnings: &mut Vec<String>,
) {
    let Some(create) = options.transwarp_create.as_ref() else { return };
    if options.database_type != Some(DatabaseType::Transwarp) {
        warnings.push("Inceptor table options require a Transwarp connection.".to_string());
        return;
    }
    for name in create.partition_columns.iter().chain(&create.bucket_columns) {
        if !active_columns.iter().any(|column| column.name.eq_ignore_ascii_case(name.trim())) {
            warnings.push(format!("Inceptor column {name:?} does not exist in the table draft."));
        }
    }
    if create.partition_columns.len() >= active_columns.len() && !create.partition_columns.is_empty() {
        warnings.push("Inceptor partitioned tables need at least one non-partition column.".to_string());
    }
    for names in [&create.partition_columns, &create.bucket_columns] {
        let mut seen = std::collections::HashSet::new();
        for name in names {
            if name.trim().is_empty() || !seen.insert(name.trim().to_ascii_lowercase()) {
                warnings.push("Inceptor partition and bucket columns must be distinct and non-empty.".to_string());
                break;
            }
        }
    }
    if create
        .bucket_columns
        .iter()
        .any(|bucket| create.partition_columns.iter().any(|partition| partition.eq_ignore_ascii_case(bucket)))
    {
        warnings.push("Inceptor bucket columns cannot also be partition columns.".to_string());
    }
    if create.bucket_columns.is_empty() != create.bucket_count.is_none()
        || create.bucket_count.is_some_and(|count| count == 0 || count > 4096)
    {
        warnings.push("Inceptor bucketing requires columns and a bucket count from 1 to 4096.".to_string());
    }
    let storage = create.storage_format.as_deref().unwrap_or("").trim();
    if !storage.is_empty()
        && !["ORC", "PARQUET", "TEXTFILE"].iter().any(|allowed| storage.eq_ignore_ascii_case(allowed))
    {
        warnings.push("Unsupported Inceptor storage format.".to_string());
    }
    if create.transactional && (!storage.eq_ignore_ascii_case("ORC") || create.bucket_columns.is_empty()) {
        warnings.push("Inceptor transactional tables require ORC storage and bucket columns.".to_string());
    }
}

pub(super) fn is_partition_column(options: &TableStructureSqlOptions, column: &EditableStructureColumn) -> bool {
    options.database_type == Some(DatabaseType::Transwarp)
        && options.transwarp_create.as_ref().is_some_and(|create| {
            create.partition_columns.iter().any(|name| column.name.eq_ignore_ascii_case(name.trim()))
        })
}

pub(super) fn create_table_suffix(
    options: &TableStructureSqlOptions,
    active_columns: &[&EditableStructureColumn],
    dialect: StructureDialect,
) -> String {
    if options.database_type != Some(DatabaseType::Transwarp) {
        return String::new();
    }
    let mut suffix = String::new();
    let comment = clean(options.table_comment.as_deref().unwrap_or(""));
    if !comment.is_empty() {
        suffix.push_str(&format!(" COMMENT {}", quote_string(&comment)));
    }
    if let Some(create) = options.transwarp_create.as_ref() {
        suffix.push_str(&create_options_clause(create, active_columns, dialect));
    }
    suffix
}

fn create_options_clause(
    create: &TranswarpCreateTableOptions,
    active_columns: &[&EditableStructureColumn],
    dialect: StructureDialect,
) -> String {
    let mut clauses = String::new();
    if !create.partition_columns.is_empty() {
        let partition_columns = create
            .partition_columns
            .iter()
            .map(|name| {
                let column = active_columns
                    .iter()
                    .find(|column| column.name.eq_ignore_ascii_case(name.trim()))
                    .expect("validated partition column");
                format!(
                    "{} {}",
                    quote_new_ident(Some(DatabaseType::Transwarp), dialect, &column.name),
                    column_data_type(dialect, column)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        clauses.push_str(&format!(" PARTITIONED BY ({partition_columns})"));
    }
    if let Some(count) = create.bucket_count {
        let columns = create
            .bucket_columns
            .iter()
            .map(|name| quote_new_ident(Some(DatabaseType::Transwarp), dialect, name.trim()))
            .collect::<Vec<_>>()
            .join(", ");
        clauses.push_str(&format!(" CLUSTERED BY ({columns}) INTO {count} BUCKETS"));
    }
    if let Some(storage) = create.storage_format.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        clauses.push_str(&format!(" STORED AS {}", storage.to_ascii_uppercase()));
    }
    if create.transactional {
        clauses.push_str(" TBLPROPERTIES ('transactional'='true')");
    }
    clauses
}
