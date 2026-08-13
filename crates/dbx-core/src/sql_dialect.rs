mod capabilities;
pub mod ddl_profile;
pub mod descriptor;
pub mod dialect_loader;
pub mod dialect_types;
pub mod dialect_yaml;
pub mod hot_reload;
mod identifiers;
pub mod inference;
mod table_select;
pub mod type_rewrite;
mod types;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod descriptor_snapshots;

pub use capabilities::{
    firebird_rows_clause, is_schema_aware, pagination_strategy, table_pagination_strategy, uses_fetch_first,
    uses_oracle_row_id, uses_single_row_insert_statements, PaginationContext, TablePaginationStrategy,
};
pub use ddl_profile::{
    profile_for, AutoIncSyntax, DdlDialectProfile, IndexTypePlacement, QuoteStyle, RenameColumnSyntax, TriggerTemplate,
    TypeMapEntry,
};
pub use descriptor::{
    dialect_check, dialect_check_all, DialectCapabilityDescriptor, DialectInfo, DialectKind, TypeConversionRule,
    TypeMappingMatrix, CAP_ADD_COLUMN, CAP_ALTER_EXISTING_COLUMN, CAP_ALTER_OWNER, CAP_ALTER_PRIMARY_KEY,
    CAP_AUTO_INCREMENT, CAP_COMMENT, CAP_CREATE_FUNCTION, CAP_CREATE_INDEX, CAP_CREATE_OR_REPLACE, CAP_CREATE_SEQUENCE,
    CAP_CREATE_TABLE, CAP_CREATE_TRIGGER, CAP_DROP_COLUMN, CAP_DROP_FUNCTION, CAP_DROP_INDEX, CAP_DROP_SEQUENCE,
    CAP_DROP_TABLE, CAP_DROP_TRIGGER, CAP_FOREIGN_KEY, CAP_GRANT_REVOKE, CAP_IDENTITY_COLUMNS, CAP_IF_NOT_EXISTS,
    CAP_INDEX_COMMENT, CAP_INDEX_FILTER, CAP_INDEX_INCLUDE, CAP_INDEX_TYPE, CAP_REBUILD_INDEX, CAP_RENAME_COLUMN,
    CAP_REORDER_COLUMN, CAP_TEMPORARY_TABLE, CAP_TRANSACTIONAL_DDL, CAP_TRUNCATE_TABLE,
};
pub use identifiers::{
    normalize_where_input, qualified_table_name, qualified_table_name_with_catalog, quote_table_identifier,
};
pub(crate) use identifiers::{parse_sqlserver_linked_schema_ref, qualified_transfer_table, quote_transfer_identifier};
pub use table_select::{build_count_table_sql, build_table_data_select_sql, build_table_select_sql};
pub(crate) use table_select::{
    quote_table_data_identifier, table_data_qualified_table_name, table_data_schema, uses_connection_identifier_quote,
};
pub use type_rewrite::{
    apply_auto_inc_to_column_def, column_is_auto_increment, rewrite_column_type, split_type_base_params,
    type_looks_integer, AutoIncColumnBuild,
};
pub use types::*;

/// Resolve a dialect descriptor for the given kind.
pub fn resolve(kind: descriptor::DialectKind) -> descriptor::DialectCapabilityDescriptor {
    lazy_init();
    if let Some(desc) = dialect_loader::DialectRegistry::global().get_descriptor(kind.label()) {
        return desc;
    }
    descriptor::DialectCapabilityDescriptor::for_dialect(kind)
}

fn lazy_init() {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        dialect_loader::register_core_dialects();
        let _ = crate::dml_binding::DmlCleanRuleRegistry::load_default();
    });
}

pub fn resolve_for_db(db_type: crate::models::connection::DatabaseType) -> descriptor::DialectCapabilityDescriptor {
    let kind = descriptor::DialectKind::from_database_type(db_type);
    resolve(kind)
}

pub fn resolve_label(kind: descriptor::DialectKind) -> String {
    if let Some(loaded) = dialect_loader::DialectRegistry::global().get(kind.label()) {
        return loaded.yaml.dialect.display_name.clone().unwrap_or_else(|| kind.label().to_string());
    }
    kind.label().to_string()
}
