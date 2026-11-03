use std::collections::HashSet;

use super::dialect::StructureDialect;
use super::util::{qualified_table, quote_ident};
use super::{build_table_structure_change_sql, TableStructureSqlOptions, TableStructureSqlResult};
use crate::models::connection::DatabaseType;

pub(super) fn build_existing_primary_key_change(mut options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let change = options.primary_key_change.take().expect("existing primary key change");
    let reject =
        |message: &str| TableStructureSqlResult { statements: Vec::new(), warnings: vec![message.to_string()] };
    let oracle = options.database_type == Some(DatabaseType::Oracle);
    if !matches!(options.database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
        || options.is_gaussdb_m_mode
    {
        return reject("Ordered existing primary key changes are only supported for Oracle and OceanBase Oracle.");
    }
    if change.name.trim().is_empty() || change.original_columns.is_empty() {
        return reject("The original primary key name and ordered columns are required.");
    }
    let original: HashSet<_> = change.original_columns.iter().collect();
    let target: HashSet<_> = change.columns.iter().collect();
    if original.len() != change.original_columns.len() || target.len() != change.columns.len() {
        return reject("Primary key columns must not repeat.");
    }
    if oracle {
        if change
            .oracle_state
            .as_ref()
            .is_some_and(|state| (!state.deferrable && state.initially_deferred) || (state.validated && state.rely))
        {
            return reject("The captured Oracle primary key state is invalid.");
        }
        let Some(index) = &change.oracle_index else {
            return reject("The original Oracle index identity and explicit index policy are required.");
        };
        let no_index = index.policy == "none";
        let enabled = change.oracle_state.as_ref().is_none_or(|state| state.enabled);
        if !matches!(index.policy.as_str(), "keep" | "drop" | "none")
            || index.owner.trim().is_empty()
            || options.schema.as_deref() != Some(index.owner.as_str())
            || (no_index && (enabled || !index.name.is_empty()))
            || (!no_index && index.name.trim().is_empty())
        {
            return reject("The Oracle index identity or policy is invalid.");
        }
        let new_index_required =
            enabled && !change.columns.is_empty() && (index.policy == "drop" || original != target);
        if new_index_required {
            let Some(name) = index.new_name.as_deref() else {
                return reject("A verified new Oracle index name is required.");
            };
            if name.is_empty()
                || name.len() > 30
                || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || !name.as_bytes()[0].is_ascii_alphabetic()
                || name == index.name
            {
                return reject("The new Oracle index name is invalid or conflicts with the original index.");
            }
        } else if index.new_name.is_some() {
            return reject("This Oracle primary key plan does not create a new index.");
        }
    } else if change.oracle_index.is_some() || change.oracle_state.is_some() {
        return reject("Oracle index policies are not supported for OceanBase Oracle.");
    }
    let known_original: HashSet<_> = options
        .columns
        .iter()
        .filter_map(|column| column.original.as_ref())
        .filter(|column| column.is_primary_key)
        .map(|column| &column.name)
        .collect();
    if original != known_original {
        return reject("The original primary key does not match the loaded columns. Refresh the table definition.");
    }
    if change.columns.iter().any(|name| {
        !options.columns.iter().any(|column| {
            !column.marked_for_drop
                && &column.name == name
                && column.original.as_ref().is_some_and(|old| &old.name == name)
        })
    }) {
        return reject("Primary key columns must be existing, unchanged columns.");
    }
    // Reuse the ordinary structure diff to reject combined edits. The explicit
    // ordered draft owns the key; the column membership flags remain unchanged.
    let ordinary = build_table_structure_change_sql(options.clone());
    if !ordinary.statements.is_empty() || !ordinary.warnings.is_empty() {
        return reject("Apply other table structure changes separately from an existing primary key change.");
    }
    if change.original_columns == change.columns {
        return TableStructureSqlResult { statements: Vec::new(), warnings: Vec::new() };
    }
    let dialect = StructureDialect::Oracle;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let name = quote_ident(dialect, &change.name);
    let index_policy = change.oracle_index.as_ref().map_or("", |index| {
        if index.policy == "keep" {
            " KEEP INDEX"
        } else if index.policy == "drop" {
            " DROP INDEX"
        } else {
            ""
        }
    });
    let mut statements = vec![format!("ALTER TABLE {table} DROP CONSTRAINT {name}{index_policy};")];
    if !change.columns.is_empty() {
        let columns = change.columns.iter().map(|name| quote_ident(dialect, name)).collect::<Vec<_>>().join(", ");
        let using_index = change
            .oracle_index
            .as_ref()
            .filter(|_| change.oracle_state.as_ref().is_none_or(|state| state.enabled))
            .map_or_else(String::new, |index| {
                if let Some(new_name) = &index.new_name {
                    let index_name = qualified_table(dialect, Some(&index.owner), new_name);
                    let unique =
                        if change.oracle_state.as_ref().is_some_and(|state| state.deferrable || !state.validated) {
                            ""
                        } else {
                            "UNIQUE "
                        };
                    format!(" USING INDEX (CREATE {unique}INDEX {index_name} ON {table} ({columns}))")
                } else {
                    let index_name = qualified_table(dialect, Some(&index.owner), &index.name);
                    format!(" USING INDEX {index_name}")
                }
            });
        let (before_index, after_index) = change.oracle_state.as_ref().map_or_else(
            || (String::new(), String::new()),
            |state| {
                let before = format!(
                    " {} INITIALLY {} {}",
                    if state.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
                    if state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" },
                    if state.rely { "RELY" } else { "NORELY" }
                );
                let after = format!(
                    " {} {}",
                    if state.enabled { "ENABLE" } else { "DISABLE" },
                    if state.validated { "VALIDATE" } else { "NOVALIDATE" }
                );
                (before, after)
            },
        );
        statements.push(format!("ALTER TABLE {table} ADD CONSTRAINT {name} PRIMARY KEY ({columns}){before_index}{using_index}{after_index};"));
    }
    TableStructureSqlResult { statements, warnings: Vec::new() }
}
