mod capabilities;
mod identifiers;
mod table_select;
mod types;

#[cfg(test)]
mod tests;

pub use capabilities::{
    firebird_rows_clause, is_schema_aware, pagination_strategy, table_pagination_strategy, uses_fetch_first,
    uses_single_row_insert_statements, PaginationContext, TablePaginationStrategy,
};
pub use identifiers::{
    normalize_where_input, qualified_table_name, qualified_table_name_with_catalog, quote_table_identifier,
};
pub(crate) use identifiers::{parse_sqlserver_linked_schema_ref, qualified_transfer_table, quote_transfer_identifier};
pub(crate) use table_select::table_data_qualified_table_name;
pub use table_select::{build_count_table_sql, build_table_data_select_sql, build_table_select_sql};
pub use types::*;
