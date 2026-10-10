use super::dialect::{capabilities_for, database_label, dialect_label, StructureDialect};
use super::types::TableStructureSqlOptions;
use super::util::{clean, qualified_table, quote_string};
use crate::models::connection::DatabaseType;

pub(super) fn build_table_comment_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type, options.driver_profile.as_deref());
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
    if options.database_type == Some(DatabaseType::Transwarp) {
        return vec![format!("ALTER TABLE {table} SET TBLPROPERTIES ('comment' = {quoted});")];
    }
    match dialect {
        StructureDialect::Mysql | StructureDialect::GaussdbM => {
            vec![format!("ALTER TABLE {table} COMMENT = {quoted};")]
        }
        StructureDialect::Postgres if options.foreign_table => {
            // PostgreSQL foreign tables (relkind = 'f') reject
            // `COMMENT ON TABLE` ("<name>" is not a table) and require the
            // FOREIGN form instead.
            vec![format!("COMMENT ON FOREIGN TABLE {table} IS {quoted};")]
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
        StructureDialect::SqlServer => build_sqlserver_table_comment_sql_for_profile(
            &table,
            options.schema.as_deref(),
            &options.table_name,
            new_comment,
            options.driver_profile.as_deref(),
        ),
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

fn build_sqlserver_extended_property_comment_sql(
    exists: &str,
    levels: &str,
    new_comment: &str,
    procedure_prefix: &str,
) -> Vec<String> {
    let new_comment = clean(new_comment);
    if new_comment.is_empty() {
        return vec![format!(
            "IF {exists} EXEC {procedure_prefix}sp_dropextendedproperty @name=N'MS_Description', {levels};"
        )];
    }

    let escaped_comment = new_comment.replace('\'', "''");
    vec![format!(
        "IF {exists} EXEC {procedure_prefix}sp_updateextendedproperty @name=N'MS_Description', @value=N'{escaped_comment}', {levels} ELSE EXEC {procedure_prefix}sp_addextendedproperty @name=N'MS_Description', @value=N'{escaped_comment}', {levels};"
    )]
}

pub fn build_sqlserver_table_comment_sql(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    new_comment: &str,
) -> Vec<String> {
    build_sqlserver_table_comment_sql_for_profile(qualified_table, schema, table_name, new_comment, None)
}

pub fn build_sqlserver_table_comment_sql_for_profile(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    new_comment: &str,
    driver_profile: Option<&str>,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let modern = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM sys.extended_properties AS ep WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND ep.minor_id = 0 AND ep.name = N'MS_Description')"
        ),
        &format!(
            "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}'"
        ),
        new_comment,
        "sys.",
    );
    if !is_sqlserver_legacy_profile(driver_profile) {
        return modern;
    }
    let sql2000 = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM ::fn_listextendedproperty(N'MS_Description', N'USER', N'{escaped_schema}', N'TABLE', N'{escaped_table}', NULL, NULL))"
        ),
        &format!(
            "@level0type=N'USER', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}'"
        ),
        new_comment,
        "",
    );
    sqlserver_version_switched_comment_sql(modern, sql2000)
}

pub(super) fn build_sqlserver_index_comment_sql_for_profile(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    index_name: &str,
    new_comment: &str,
    driver_profile: Option<&str>,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let escaped_idx = index_name.replace('\'', "''");
    let modern = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM sys.extended_properties AS ep INNER JOIN sys.indexes AS i ON i.object_id = ep.major_id AND i.index_id = ep.minor_id WHERE ep.class = 7 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND i.name = N'{escaped_idx}' AND ep.name = N'MS_Description')"
        ),
        &format!(
            "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'INDEX', @level2name=N'{escaped_idx}'"
        ),
        new_comment,
        "sys.",
    );
    if !is_sqlserver_legacy_profile(driver_profile) {
        return modern;
    }
    let sql2000 = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM ::fn_listextendedproperty(N'MS_Description', N'USER', N'{escaped_schema}', N'TABLE', N'{escaped_table}', N'INDEX', N'{escaped_idx}'))"
        ),
        &format!(
            "@level0type=N'USER', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'INDEX', @level2name=N'{escaped_idx}'"
        ),
        new_comment,
        "",
    );
    sqlserver_version_switched_comment_sql(modern, sql2000)
}

pub fn build_sqlserver_column_comment_sql(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    column_name: &str,
    new_comment: &str,
) -> Vec<String> {
    build_sqlserver_column_comment_sql_for_profile(qualified_table, schema, table_name, column_name, new_comment, None)
}

pub fn build_sqlserver_column_comment_sql_for_profile(
    qualified_table: &str,
    schema: Option<&str>,
    table_name: &str,
    column_name: &str,
    new_comment: &str,
    driver_profile: Option<&str>,
) -> Vec<String> {
    let schema_name = sqlserver_schema_name(schema);
    let escaped_qualified = qualified_table.replace('\'', "''");
    let escaped_schema = schema_name.replace('\'', "''");
    let escaped_table = table_name.replace('\'', "''");
    let escaped_col = column_name.replace('\'', "''");
    let modern = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM sys.extended_properties AS ep WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(N'{escaped_qualified}') AND ep.minor_id = COLUMNPROPERTY(OBJECT_ID(N'{escaped_qualified}'), N'{escaped_col}', 'ColumnId') AND ep.name = N'MS_Description')"
        ),
        &format!(
            "@level0type=N'SCHEMA', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'COLUMN', @level2name=N'{escaped_col}'"
        ),
        new_comment,
        "sys.",
    );
    if !is_sqlserver_legacy_profile(driver_profile) {
        return modern;
    }
    let sql2000 = build_sqlserver_extended_property_comment_sql(
        &format!(
            "EXISTS (SELECT 1 FROM ::fn_listextendedproperty(N'MS_Description', N'USER', N'{escaped_schema}', N'TABLE', N'{escaped_table}', N'COLUMN', N'{escaped_col}'))"
        ),
        &format!(
            "@level0type=N'USER', @level0name=N'{escaped_schema}', @level1type=N'TABLE', @level1name=N'{escaped_table}', @level2type=N'COLUMN', @level2name=N'{escaped_col}'"
        ),
        new_comment,
        "",
    );
    sqlserver_version_switched_comment_sql(modern, sql2000)
}

/// The legacy driver serves SQL Server 2000 through current releases. Since
/// SQL Server 2005, the `USER` level only resolves when a database user shares
/// the schema name, so non-`dbo` schemas fail with Msg 15135. Choose the level
/// on the server instead, and keep each branch in dynamic SQL so SQL Server
/// 2000 never compiles the `sys.` catalog references.
fn sqlserver_version_switched_comment_sql(modern: Vec<String>, sql2000: Vec<String>) -> Vec<String> {
    let dynamic = |statements: Vec<String>| {
        let sql = statements.concat();
        format!("EXEC (N'{}')", sql.trim_end_matches(';').replace('\'', "''"))
    };
    vec![format!("IF @@MICROSOFTVERSION / 16777216 >= 9 {} ELSE {};", dynamic(modern), dynamic(sql2000))]
}

fn is_sqlserver_legacy_profile(driver_profile: Option<&str>) -> bool {
    driver_profile.is_some_and(|profile| profile.trim().eq_ignore_ascii_case("sqlserver-legacy"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg_comment_options(foreign_table: bool) -> TableStructureSqlOptions {
        TableStructureSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            driver_profile: None,
            schema: Some("de_sk".to_string()),
            table_name: "vmes_base_destination".to_string(),
            columns: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            table_comment: Some("港口资料".to_string()),
            original_table_comment: None,
            mysql_engine: None,
            mysql_auto_increment_value: None,
            transwarp_create: None,
            partitioned: false,
            is_gaussdb_m_mode: false,
            table_collation: None,
            foreign_table,
        }
    }

    #[test]
    fn postgres_foreign_table_comment_uses_foreign_table_form() {
        let mut warnings = Vec::new();
        let statements = build_table_comment_sql(&pg_comment_options(true), &mut warnings);

        assert_eq!(statements, vec!["COMMENT ON FOREIGN TABLE \"de_sk\".\"vmes_base_destination\" IS '港口资料';"]);
        assert!(warnings.is_empty(), "no warnings expected: {warnings:?}");
    }

    #[test]
    fn postgres_regular_table_comment_keeps_table_form() {
        let mut warnings = Vec::new();
        let statements = build_table_comment_sql(&pg_comment_options(false), &mut warnings);

        assert_eq!(statements, vec!["COMMENT ON TABLE \"de_sk\".\"vmes_base_destination\" IS '港口资料';"]);
    }

    #[test]
    fn foreign_table_flag_is_ignored_by_non_postgres_dialects() {
        let mut options = pg_comment_options(true);
        options.database_type = Some(DatabaseType::Oracle);
        let mut warnings = Vec::new();
        let statements = build_table_comment_sql(&options, &mut warnings);

        assert_eq!(statements, vec!["COMMENT ON TABLE \"de_sk\".\"vmes_base_destination\" IS '港口资料';"]);
    }

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
        let statements = build_sqlserver_index_comment_sql_for_profile(
            "[dbo].[orders]",
            None,
            "orders",
            "ix_owner's",
            "index comment",
            None,
        );

        assert_eq!(statements.len(), 1);
        let sql = &statements[0];
        assert!(sql.contains("INNER JOIN sys.indexes AS i"), "index lookup: {sql}");
        assert!(sql.contains("ep.class = 7"), "index extended-property class: {sql}");
        assert!(sql.contains("i.name = N'ix_owner''s'"), "index name escaping: {sql}");
        assert!(sql.contains("sys.sp_updateextendedproperty"), "update existing comment: {sql}");
        assert!(sql.contains("ELSE EXEC sys.sp_addextendedproperty"), "add missing comment: {sql}");
    }

    #[test]
    fn sqlserver_legacy_column_comment_picks_extended_property_level_by_server_version() {
        let statements = build_sqlserver_column_comment_sql_for_profile(
            "[app].[Categories]",
            Some("app"),
            "Categories",
            "CategoryID",
            "owner's test",
            Some("sqlserver-legacy"),
        );

        assert_eq!(statements.len(), 1);
        let sql = &statements[0];
        let (modern, sql2000) = sql
            .strip_prefix("IF @@MICROSOFTVERSION / 16777216 >= 9 EXEC (N'")
            .and_then(|rest| rest.split_once("') ELSE EXEC (N'"))
            .unwrap_or_else(|| panic!("version switch: {sql}"));
        assert!(modern.contains("sys.extended_properties"), "2005+ property lookup: {sql}");
        assert!(modern.contains("@level0type=N''SCHEMA'', @level0name=N''app''"), "2005+ hierarchy: {sql}");
        assert!(modern.contains("EXEC sys.sp_updateextendedproperty"), "2005+ update procedure: {sql}");
        assert!(!modern.contains("N''USER''"), "USER level fails for non-dbo schemas on 2005+: {sql}");
        assert!(sql2000.contains("::fn_listextendedproperty"), "legacy property lookup: {sql}");
        assert!(sql2000.contains("@level0type=N''USER''"), "legacy hierarchy: {sql}");
        assert!(sql2000.contains("ELSE EXEC sp_addextendedproperty"), "legacy add procedure: {sql}");
        assert!(!sql2000.contains("sys."), "SQL Server 2005+ catalog leaked into the 2000 branch: {sql}");
        assert!(sql.contains("@value=N''owner''''s test''"), "comment escaped for dynamic SQL: {sql}");
        assert!(sql.ends_with("');"), "{sql}");
        assert_eq!(
            crate::sql::split_sql_statements_for_database(sql, crate::models::connection::DatabaseType::SqlServer)
                .len(),
            1,
            "version-switched comment upsert must remain one executable statement: {sql}"
        );
    }
}
