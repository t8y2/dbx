use super::dialect::StructureDialect;
use super::types::{TableOwnerChangeSqlOptions, TableStructureSqlResult};
use super::util::{qualified_table, quote_ident};
use crate::models::connection::DatabaseType;

pub fn build_table_owner_change_sql(options: TableOwnerChangeSqlOptions) -> TableStructureSqlResult {
    let owner = &options.owner;
    if owner == &options.original_owner {
        return TableStructureSqlResult { statements: Vec::new(), warnings: Vec::new() };
    }
    if owner.is_empty() {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["Table owner cannot be empty.".to_string()],
        };
    }
    if options.database_type != Some(DatabaseType::Postgres) {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["Changing the table owner is currently supported only for PostgreSQL.".to_string()],
        };
    }

    let table = qualified_table(StructureDialect::Postgres, options.schema.as_deref(), &options.table_name);
    let owner = quote_ident(StructureDialect::Postgres, owner);
    TableStructureSqlResult { statements: vec![format!("ALTER TABLE {table} OWNER TO {owner};")], warnings: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(owner: &str, original_owner: &str) -> TableOwnerChangeSqlOptions {
        TableOwnerChangeSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("app schema".to_string()),
            table_name: "order\"items".to_string(),
            owner: owner.to_string(),
            original_owner: original_owner.to_string(),
        }
    }

    #[test]
    fn builds_quoted_postgres_owner_change() {
        let result = build_table_owner_change_sql(options("reporting\"role", "app_user"));
        assert!(result.warnings.is_empty());
        assert_eq!(
            result.statements,
            vec!["ALTER TABLE \"app schema\".\"order\"\"items\" OWNER TO \"reporting\"\"role\";".to_string()]
        );
    }

    #[test]
    fn preserves_whitespace_in_postgres_role_names() {
        let changed = build_table_owner_change_sql(options(" app_user ", "app_user"));
        assert!(changed.warnings.is_empty());
        assert_eq!(
            changed.statements,
            vec!["ALTER TABLE \"app schema\".\"order\"\"items\" OWNER TO \" app_user \";".to_string()]
        );

        let unchanged = build_table_owner_change_sql(options(" app_user ", " app_user "));
        assert!(unchanged.statements.is_empty());
        assert!(unchanged.warnings.is_empty());
    }

    #[test]
    fn rejects_empty_or_unsupported_owner_changes() {
        let empty = build_table_owner_change_sql(options("", "app_user"));
        assert!(empty.statements.is_empty());
        assert_eq!(empty.warnings, vec!["Table owner cannot be empty."]);

        let mut unsupported = options("reporting", "app_user");
        unsupported.database_type = Some(DatabaseType::Mysql);
        let unsupported = build_table_owner_change_sql(unsupported);
        assert!(unsupported.statements.is_empty());
        assert_eq!(unsupported.warnings, vec!["Changing the table owner is currently supported only for PostgreSQL."]);
    }
}
