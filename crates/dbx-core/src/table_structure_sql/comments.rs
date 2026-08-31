use super::dialect::{capabilities_for, database_label, dialect_label, StructureDialect};
use super::types::TableStructureSqlOptions;
use super::util::{clean, qualified_table, quote_string};

pub(super) fn build_table_comment_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let new_comment = options.table_comment.as_deref().unwrap_or("");
    let original_comment = options.original_table_comment.as_deref().unwrap_or("");
    if clean(new_comment) == clean(original_comment) {
        return Vec::new();
    }
    if !capabilities.comment {
        warnings.push(format!(
            "Table comments are not supported for {} from this editor; the comment change was ignored.",
            database_label(options.database_type)
        ));
        return Vec::new();
    }
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let quoted = quote_string(&clean(new_comment));
    match dialect {
        StructureDialect::Mysql | StructureDialect::GaussdbM => {
            vec![format!("ALTER TABLE {table} COMMENT = {quoted};")]
        }
        StructureDialect::Postgres
        | StructureDialect::Oracle
        | StructureDialect::Dameng
        | StructureDialect::Oscar
        | StructureDialect::H2 => {
            vec![format!("COMMENT ON TABLE {table} IS {quoted};")]
        }
        StructureDialect::ClickHouse => {
            vec![format!("ALTER TABLE {table} MODIFY COMMENT {quoted};")]
        }
        StructureDialect::SqlServer => {
            build_sqlserver_table_comment_sql(&table, options.schema.as_deref(), &options.table_name, new_comment)
        }
        _ => {
            if !clean(new_comment).is_empty() {
                warnings
                    .push(format!("Table comments are not supported for {} from this editor.", dialect_label(dialect)));
            }
            Vec::new()
        }
    }
}

pub(super) fn sqlserver_schema_name(schema: Option<&str>) -> String {
    schema.filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string()).unwrap_or_else(|| "dbo".to_string())
}

fn build_sqlserver_extended_property_comment_sql(exists: &str, levels: &str, new_comment: &str) -> Vec<String> {
    let new_comment = clean(new_comment);
    if new_comment.is_empty() {
        return vec![format!("IF {exists} EXEC sys.sp_dropextendedproperty @name=N'MS_Description', {levels};")];
    }

    let escaped_comment = new_comment.replace('\'', "''");
    vec![format!(
        "IF {exists} EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value=N'{escaped_comment}', {levels} ELSE EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{escaped_comment}', {levels};"
    )]
}

pub(crate) fn build_sqlserver_table_comment_sql(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    new_comment: &str,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let exists = format!(
        "EXISTS (SELECT 1 FROM sys.extended_properties AS ep WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND ep.minor_id = 0 AND ep.name = N'MS_Description')"
    );
    let levels = format!(
        "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}'"
    );

    build_sqlserver_extended_property_comment_sql(&exists, &levels, new_comment)
}

pub(super) fn build_sqlserver_index_comment_sql(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    index_name: &str,
    new_comment: &str,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let escaped_idx = index_name.replace('\'', "''");
    let exists = format!(
        "EXISTS (SELECT 1 FROM sys.extended_properties AS ep INNER JOIN sys.indexes AS i ON i.object_id = ep.major_id AND i.index_id = ep.minor_id WHERE ep.class = 7 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND i.name = N'{escaped_idx}' AND ep.name = N'MS_Description')"
    );
    let levels = format!(
        "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'INDEX', @level2name=N'{escaped_idx}'"
    );

    build_sqlserver_extended_property_comment_sql(&exists, &levels, new_comment)
}

pub(crate) fn build_sqlserver_column_comment_sql(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    column_name: &str,
    new_comment: &str,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let escaped_col = column_name.replace('\'', "''");
    let exists = format!(
        "EXISTS (SELECT 1 FROM sys.extended_properties AS ep WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND ep.minor_id = COLUMNPROPERTY(OBJECT_ID(N'{escaped_qualified}'), N'{escaped_col}', 'ColumnId') AND ep.name = N'MS_Description')"
    );
    let levels = format!(
        "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'COLUMN', @level2name=N'{escaped_col}'"
    );

    build_sqlserver_extended_property_comment_sql(&exists, &levels, new_comment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlserver_table_comment_updates_or_adds_without_dropping() {
        let statements = build_sqlserver_table_comment_sql("[app's].[user's]", Some("app's"), "user's", "owner's 新值");

        assert_eq!(statements.len(), 1);
        let sql = &statements[0];
        assert!(sql.contains("ep.class = 1"), "table extended-property class: {sql}");
        assert!(sql.contains("sys.sp_updateextendedproperty"), "update existing comment: {sql}");
        assert!(sql.contains("ELSE EXEC sys.sp_addextendedproperty"), "add missing comment: {sql}");
        assert!(!sql.contains("sys.sp_dropextendedproperty"), "non-empty comments are not dropped first: {sql}");
        assert!(sql.contains("OBJECT_ID(N'[app''s].[user''s]')"), "object name escaping: {sql}");
        assert!(sql.contains("@value=N'owner''s 新值'"), "Unicode comment escaping: {sql}");
        assert_eq!(
            crate::sql::split_sql_statements_for_database(sql, crate::models::connection::DatabaseType::SqlServer)
                .len(),
            1,
            "IF/ELSE comment upsert must remain one executable statement: {sql}"
        );
    }

    #[test]
    fn sqlserver_empty_column_comment_drops_only_when_present() {
        let statements = build_sqlserver_column_comment_sql("[dbo].[orders]", None, "orders", "owner'id", "  ");

        assert_eq!(statements.len(), 1);
        let sql = &statements[0];
        assert!(sql.contains("COLUMNPROPERTY(OBJECT_ID(N'[dbo].[orders]'), N'owner''id', 'ColumnId')"));
        assert!(sql.contains("sys.sp_dropextendedproperty"), "drop existing comment: {sql}");
        assert!(!sql.contains("sys.sp_updateextendedproperty"), "empty comment must not update: {sql}");
        assert!(!sql.contains("sys.sp_addextendedproperty"), "empty comment must not add: {sql}");
        assert!(sql.contains("@level0name=N'dbo'"), "default schema: {sql}");
        assert_eq!(
            crate::sql::split_sql_statements_for_database(sql, crate::models::connection::DatabaseType::SqlServer)
                .len(),
            1,
            "conditional comment drop must remain one executable statement: {sql}"
        );
    }

    #[test]
    fn sqlserver_index_comment_uses_index_extended_property_identity() {
        let statements =
            build_sqlserver_index_comment_sql("[dbo].[orders]", None, "orders", "ix_owner's", "index comment");

        assert_eq!(statements.len(), 1);
        let sql = &statements[0];
        assert!(sql.contains("INNER JOIN sys.indexes AS i"), "index lookup: {sql}");
        assert!(sql.contains("ep.class = 7"), "index extended-property class: {sql}");
        assert!(sql.contains("i.name = N'ix_owner''s'"), "index name escaping: {sql}");
        assert!(sql.contains("sys.sp_updateextendedproperty"), "update existing comment: {sql}");
        assert!(sql.contains("ELSE EXEC sys.sp_addextendedproperty"), "add missing comment: {sql}");
    }
}
