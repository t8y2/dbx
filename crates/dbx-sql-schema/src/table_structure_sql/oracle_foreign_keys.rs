use std::collections::HashSet;

use super::dialect::StructureDialect;
use super::util::{qualified_new_table, qualified_table, quote_ident, quote_new_ident};
use super::{
    build_table_structure_change_sql, OracleForeignKeyDefinition, TableStructureSqlOptions, TableStructureSqlResult,
};
use crate::models::connection::DatabaseType;

pub(super) fn build_changes(mut options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let changes = options.oracle_foreign_key_changes.take().expect("Oracle foreign key changes");
    let reject = |message: &str| TableStructureSqlResult { statements: vec![], warnings: vec![message.into()] };
    let oracle = options.database_type == Some(DatabaseType::Oracle);
    if !matches!(options.database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
        || options.is_gaussdb_m_mode
    {
        return reject("Ordered foreign key changes require Oracle or OceanBase Oracle.");
    }
    if options.primary_key_change.is_some() || !options.foreign_keys.is_empty() {
        return reject("Apply other table structure changes separately from Oracle foreign key changes.");
    }
    let ordinary = build_table_structure_change_sql(options.clone());
    if !ordinary.statements.is_empty() || !ordinary.warnings.is_empty() {
        return reject("Apply other table structure changes separately from Oracle foreign key changes.");
    }
    let mut original_names = HashSet::new();
    let mut target_names = HashSet::new();
    for change in &changes {
        if change.original.is_none() && change.target.is_none() {
            return reject("A foreign key change must have an original or target definition.");
        }
        for definition in [&change.original, &change.target].into_iter().flatten() {
            if let Err(message) = validate(definition, oracle) {
                return reject(message);
            }
        }
        if let Some(original) = &change.original {
            if !original_names.insert(&original.name) {
                return reject("Original foreign key names must not repeat.");
            }
        }
        if let Some(target) = &change.target {
            if !target_names.insert(&target.name) {
                return reject("Target foreign key names must not repeat.");
            }
        }
    }
    for change in &changes {
        if let Some(target) = &change.target {
            if original_names.contains(&target.name)
                && change.original.as_ref().is_none_or(|old| old.name != target.name)
            {
                return reject("Foreign key name exchanges are not supported in one plan.");
            }
        }
    }
    let table = qualified_table(StructureDialect::Oracle, options.schema.as_deref(), &options.table_name);
    let mut statements = vec![];
    for change in changes {
        if change.original == change.target {
            continue;
        }
        match (change.original, change.target) {
            (None, Some(target)) => statements.push(add_sql(&table, &target, oracle)),
            (Some(original), None) => statements.push(drop_sql(&table, &original.name)),
            (Some(original), Some(target)) => {
                let mut definition = original.clone();
                definition.name = target.name.clone();
                definition.state = target.state.clone();
                let same_definition = definition == target && original.state.deferrable == target.state.deferrable;
                if same_definition && (oracle || original.name == target.name) {
                    let name = quote_ident(StructureDialect::Oracle, &original.name);
                    if original.state.enabled != target.state.enabled
                        || original.state.validated != target.state.validated
                    {
                        let enabled = if target.state.enabled { "ENABLE" } else { "DISABLE" };
                        let validated = if target.state.validated { "VALIDATE" } else { "NOVALIDATE" };
                        statements.push(format!("ALTER TABLE {table} {enabled} {validated} CONSTRAINT {name};"));
                    }
                    if original.state.rely != target.state.rely {
                        let rely = if target.state.rely { "RELY" } else { "NORELY" };
                        statements.push(format!("ALTER TABLE {table} MODIFY CONSTRAINT {name} {rely};"));
                    }
                    if original.state.initially_deferred != target.state.initially_deferred {
                        let deferred = if target.state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" };
                        statements.push(format!("ALTER TABLE {table} MODIFY CONSTRAINT {name} INITIALLY {deferred};"));
                    }
                    if original.name != target.name {
                        statements.push(format!(
                            "ALTER TABLE {table} RENAME CONSTRAINT {name} TO {};",
                            quote_ident(StructureDialect::Oracle, &target.name)
                        ));
                    }
                } else {
                    statements.push(drop_sql(&table, &original.name));
                    statements.push(add_sql(&table, &target, oracle));
                }
            }
            (None, None) => unreachable!(),
        }
    }
    TableStructureSqlResult { statements, warnings: vec![] }
}

fn validate(key: &OracleForeignKeyDefinition, oracle: bool) -> Result<(), &'static str> {
    if key.name.is_empty()
        || key.ref_schema.is_empty()
        || key.ref_table.is_empty()
        || key.columns.is_empty()
        || key.columns.len() != key.ref_columns.len()
        || key.columns.iter().chain(&key.ref_columns).any(String::is_empty)
    {
        return Err("Foreign key identity and equal nonempty ordered column lists are required.");
    }
    for columns in [&key.columns, &key.ref_columns] {
        if columns.iter().collect::<HashSet<_>>().len() != columns.len() {
            return Err("Foreign key columns must not repeat.");
        }
    }
    if !matches!(key.on_delete.as_str(), "NO ACTION" | "CASCADE" | "SET NULL") {
        return Err("Unsupported Oracle foreign key delete action.");
    }
    if (!key.state.deferrable && key.state.initially_deferred)
        || (key.state.validated && key.state.rely)
        || (key.state.deferrable && !oracle)
    {
        return Err("The foreign key state is invalid or unsupported by this engine.");
    }
    Ok(())
}

fn drop_sql(table: &str, name: &str) -> String {
    format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(StructureDialect::Oracle, name))
}

pub(super) fn build_new_table_keys(options: &TableStructureSqlOptions) -> Result<Vec<String>, &'static str> {
    let Some(changes) = &options.oracle_foreign_key_changes else {
        return Ok(vec![]);
    };
    if !matches!(options.database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
        || options.is_gaussdb_m_mode
    {
        return Err("Ordered foreign key changes require Oracle or OceanBase Oracle.");
    }
    if !options.foreign_keys.is_empty() || options.primary_key_change.is_some() {
        return Err("New Oracle foreign keys must use only the ordered creation definitions.");
    }
    let oracle = options.database_type == Some(DatabaseType::Oracle);
    let dialect = StructureDialect::Oracle;
    let table = qualified_new_table(options.database_type, dialect, options.schema.as_deref(), &options.table_name);
    let source_columns: HashSet<_> =
        options.columns.iter().filter(|column| !column.marked_for_drop).map(|column| &column.name).collect();
    let primary_key_columns: Vec<_> = options
        .columns
        .iter()
        .filter(|column| !column.marked_for_drop && column.is_primary_key)
        .map(|column| &column.name)
        .collect();
    let mut names = HashSet::new();
    let name_identity = |name: &str| {
        let reference = quote_new_ident(options.database_type, dialect, name);
        if oracle && !reference.starts_with('"') {
            reference.to_ascii_uppercase()
        } else {
            reference
        }
    };
    if let Some(name) = &options.primary_key_name {
        names.insert(name_identity(name));
    }
    let mut statements = vec![];
    for change in changes {
        if change.original.is_some() {
            return Err("A new table cannot replace an existing foreign key.");
        }
        let Some(key) = &change.target else {
            return Err("A new foreign key requires a target definition.");
        };
        validate(key, oracle)?;
        if !names.insert(name_identity(&key.name)) {
            return Err("New constraint names must not repeat.");
        }
        if key.columns.iter().any(|name| !source_columns.contains(name)) {
            return Err("Foreign key source columns must exist in the new table draft.");
        }
        let self_reference =
            options.schema.as_deref().is_some_and(|schema| name_identity(schema) == name_identity(&key.ref_schema))
                && name_identity(&options.table_name) == name_identity(&key.ref_table);
        if self_reference && key.ref_columns.iter().any(|name| !source_columns.contains(name)) {
            return Err("Self-referenced columns must exist in the new table draft.");
        }
        if self_reference
            && (key.ref_columns.len() != primary_key_columns.len()
                || key.ref_columns.iter().any(|name| !primary_key_columns.contains(&name)))
        {
            return Err("Self-referenced columns must match the new table primary key.");
        }
        let source_quote = |name: &str| quote_new_ident(options.database_type, dialect, name);
        let columns = key.columns.iter().map(|name| source_quote(name)).collect::<Vec<_>>().join(", ");
        let ref_columns = key
            .ref_columns
            .iter()
            .map(|name| if self_reference { source_quote(name) } else { quote_ident(dialect, name) })
            .collect::<Vec<_>>()
            .join(", ");
        let ref_target = if self_reference {
            table.clone()
        } else {
            format!("{}.{}", quote_ident(dialect, &key.ref_schema), quote_ident(dialect, &key.ref_table))
        };
        statements.push(format!(
            "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {ref_target} ({ref_columns}){};",
            source_quote(&key.name),
            suffix(key, oracle)
        ));
    }
    Ok(statements)
}

fn add_sql(table: &str, key: &OracleForeignKeyDefinition, oracle: bool) -> String {
    let quote = |name: &str| quote_ident(StructureDialect::Oracle, name);
    let columns = key.columns.iter().map(|name| quote(name)).collect::<Vec<_>>().join(", ");
    let ref_columns = key.ref_columns.iter().map(|name| quote(name)).collect::<Vec<_>>().join(", ");
    format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({columns}) REFERENCES {}.{} ({ref_columns}){};",
        quote(&key.name),
        quote(&key.ref_schema),
        quote(&key.ref_table),
        suffix(key, oracle)
    )
}

fn suffix(key: &OracleForeignKeyDefinition, oracle: bool) -> String {
    let action = if key.on_delete == "NO ACTION" { String::new() } else { format!(" ON DELETE {}", key.on_delete) };
    let deferrable = if key.state.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" };
    let initially = if key.state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" };
    let deferred_clause = if oracle { format!(" {deferrable} INITIALLY {initially}") } else { String::new() };
    let rely = if key.state.rely { "RELY" } else { "NORELY" };
    let enabled = if key.state.enabled { "ENABLE" } else { "DISABLE" };
    let validated = if key.state.validated { "VALIDATE" } else { "NOVALIDATE" };
    format!("{action}{deferred_clause} {rely} {enabled} {validated}")
}
