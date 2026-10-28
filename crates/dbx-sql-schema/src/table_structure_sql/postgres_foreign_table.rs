use std::collections::HashSet;

use super::create_options::PostgresForeignTableCreateOptions;
use super::dialect::StructureDialect;
use super::types::TableStructureSqlOptions;
use super::util::{quote_ident, quote_string};
use crate::models::connection::DatabaseType;

pub(super) fn create_clause(
    options: &TableStructureSqlOptions,
    foreign: &PostgresForeignTableCreateOptions,
) -> Result<String, Vec<String>> {
    let mut warnings = Vec::new();
    let native_profile = options
        .driver_profile
        .as_deref()
        .is_none_or(|profile| profile.trim().is_empty() || profile.trim().eq_ignore_ascii_case("postgres"));
    if options.database_type != Some(DatabaseType::Postgres) || !native_profile || options.is_gaussdb_m_mode {
        warnings.push("Foreign table creation is supported only for PostgreSQL.".into());
    }
    if foreign.server.trim().is_empty() || foreign.server.contains('\0') {
        warnings.push("A foreign server is required to create a PostgreSQL foreign table.".into());
    }
    if options.partitioned {
        warnings.push("Foreign table creation cannot be combined with partitioned table creation.".into());
    }
    if options.columns.iter().any(|column| !column.marked_for_drop && column.is_primary_key)
        || options.indexes.iter().any(|index| !index.marked_for_drop)
        || options.foreign_keys.iter().any(|key| !key.marked_for_drop)
    {
        warnings.push("PostgreSQL foreign tables do not support primary keys, indexes or foreign keys.".into());
    }
    if options.columns.iter().filter(|column| !column.marked_for_drop).any(|column| {
        column.extra.as_ref().is_some_and(|extra| extra.auto_increment == Some(true) || extra.identity.is_some())
    }) {
        warnings.push("PostgreSQL foreign tables do not support identity columns.".into());
    }
    let mut names = HashSet::new();
    for option in &foreign.options {
        if option.name.trim().is_empty() || option.name.contains('\0') || option.value.contains('\0') {
            warnings.push("Foreign table options require a valid name and cannot contain NUL characters.".into());
        } else if !names.insert(&option.name) {
            warnings.push(format!("Duplicate foreign table option: {}", option.name));
        }
    }
    if !warnings.is_empty() {
        return Err(warnings);
    }
    let mut clause = format!(" SERVER {}", quote_ident(StructureDialect::Postgres, &foreign.server));
    if !foreign.options.is_empty() {
        let values = foreign
            .options
            .iter()
            .map(|option| {
                format!("{} {}", quote_ident(StructureDialect::Postgres, &option.name), quote_string(&option.value))
            })
            .collect::<Vec<_>>()
            .join(", ");
        clause.push_str(&format!(" OPTIONS ({values})"));
    }
    Ok(clause)
}
