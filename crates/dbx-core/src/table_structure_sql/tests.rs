use super::*;
use crate::models::connection::DatabaseType;

fn column(name: &str) -> EditableStructureColumn {
    EditableStructureColumn {
        id: name.to_string(),
        name: name.to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        default_value: String::new(),
        comment: String::new(),
        is_primary_key: false,
        extra: None,
        original: None,
        original_position: None,
        marked_for_drop: false,
    }
}

fn index(name: &str, columns: &[&str]) -> EditableStructureIndex {
    EditableStructureIndex {
        id: name.to_string(),
        name: name.to_string(),
        columns: columns.iter().map(|column| column.to_string()).collect(),
        is_unique: false,
        is_primary: false,
        filter: String::new(),
        index_type: String::new(),
        included_columns: Vec::new(),
        comment: String::new(),
        original: None,
        marked_for_drop: false,
    }
}

fn foreign_key(name: &str, column: &str, ref_table: &str, ref_column: &str) -> EditableStructureForeignKey {
    EditableStructureForeignKey {
        id: name.to_string(),
        name: name.to_string(),
        column: column.to_string(),
        ref_schema: String::new(),
        ref_table: ref_table.to_string(),
        ref_column: ref_column.to_string(),
        on_update: String::new(),
        on_delete: String::new(),
        original: None,
        marked_for_drop: false,
    }
}

fn trigger(name: &str, timing: &str, event: &str, statement: &str) -> EditableStructureTrigger {
    EditableStructureTrigger {
        id: name.to_string(),
        name: name.to_string(),
        timing: timing.to_string(),
        event: event.to_string(),
        statement: statement.to_string(),
        original: None,
        marked_for_drop: false,
    }
}

#[test]
fn builds_mysql_column_and_index_changes() {
    let mut renamed = column("display_name");
    renamed.data_type = "varchar(120)".to_string();
    renamed.is_nullable = false;
    renamed.default_value = "guest".to_string();
    renamed.comment = "Shown name".to_string();
    renamed.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(80)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });
    let mut email = column("email");
    email.is_nullable = false;
    let mut old_index = index("idx_old", &["name"]);
    old_index.marked_for_drop = true;
    old_index.original = Some(IndexInfo {
        name: "idx_old".to_string(),
        columns: vec!["name".to_string()],
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: None,
        included_columns: None,
        comment: None,
    });
    let mut email_index = index("uniq_users_email", &["email"]);
    email_index.is_unique = true;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![renamed, email],
        indexes: vec![old_index, email_index],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
            result.statements,
            vec![
                "ALTER TABLE `users` CHANGE COLUMN `name` `display_name` varchar(120) NOT NULL DEFAULT 'guest' COMMENT 'Shown name';",
                "ALTER TABLE `users` ADD COLUMN `email` varchar(255) NOT NULL;",
                "DROP INDEX `idx_old` ON `users`;",
                "CREATE UNIQUE INDEX `uniq_users_email` ON `users` (`email`);",
            ]
        );
}

#[test]
fn builds_informix_column_and_index_changes() {
    let mut renamed = column("display_name");
    renamed.data_type = "varchar(120)".to_string();
    renamed.is_nullable = false;
    renamed.default_value = "guest".to_string();
    renamed.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(80)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });
    let mut email = column("email");
    email.is_nullable = false;
    let mut old_col = column("old_col");
    old_col.marked_for_drop = true;
    old_col.original = Some(ColumnInfo {
        name: "old_col".to_string(),
        data_type: "varchar(20)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });
    let mut old_index = index("idx_old", &["name"]);
    old_index.marked_for_drop = true;
    old_index.original = Some(IndexInfo {
        name: "idx_old".to_string(),
        columns: vec!["name".to_string()],
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: None,
        included_columns: None,
        comment: None,
    });
    let mut email_index = index("uniq_users_email", &["email"]);
    email_index.is_unique = true;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Informix),
        schema: Some("gbasedbt".to_string()),
        table_name: "users".to_string(),
        columns: vec![renamed, email, old_col],
        indexes: vec![old_index, email_index],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "RENAME COLUMN gbasedbt.users.name TO display_name;",
            "ALTER TABLE gbasedbt.users MODIFY (display_name varchar(120) NOT NULL DEFAULT 'guest');",
            "ALTER TABLE gbasedbt.users ADD (email varchar(255) NOT NULL);",
            "ALTER TABLE gbasedbt.users DROP (old_col);",
            "DROP INDEX gbasedbt.idx_old;",
            "CREATE UNIQUE INDEX uniq_users_email ON gbasedbt.users (email);",
        ]
    );
}

#[test]
fn iris_drop_index_includes_table_name() {
    let mut old_index = index("index_id", &["ID"]);
    old_index.marked_for_drop = true;
    old_index.original = Some(IndexInfo {
        name: "index_id".to_string(),
        columns: vec!["ID".to_string()],
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: None,
        included_columns: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Iris),
        schema: Some("SQLUSER".to_string()),
        table_name: "tb_a".to_string(),
        columns: Vec::new(),
        indexes: vec![old_index],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["DROP INDEX \"index_id\" ON TABLE \"SQLUSER\".\"tb_a\";"]);
}

#[test]
fn mysql_create_index_with_comment() {
    let mut col = column("name");
    col.data_type = "varchar(120)".to_string();
    let mut idx = index("idx_users_name", &["name"]);
    idx.comment = "Search index".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: vec![idx],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `users` ADD COLUMN `name` varchar(120);",
            "CREATE INDEX `idx_users_name` ON `users` (`name`) COMMENT 'Search index';",
        ]
    );
}

#[test]
fn manticoresearch_builds_create_table_sql_only() {
    let mut title = column("title");
    title.data_type = "text".to_string();
    title.is_nullable = false;
    let mut views = column("views");
    views.data_type = "int".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![title, views],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["CREATE TABLE `materials` (\n  `title` text,\n  `views` int\n);"]);
}

#[test]
fn manticoresearch_builds_add_and_drop_column_sql() {
    let mut old_code = column("code");
    old_code.data_type = "string".to_string();
    old_code.marked_for_drop = true;
    old_code.original = Some(ColumnInfo {
        name: "code".to_string(),
        data_type: "string".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut name = column("name");
    name.data_type = "string".to_string();
    name.extra =
        Some(ColumnExtra { manticore_attribute: Some(true), manticore_indexed: Some(true), ..Default::default() });
    let mut resource = column("resource");
    resource.data_type = "json".to_string();
    resource.extra = Some(ColumnExtra { manticore_secondary_index: Some(true), ..Default::default() });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![old_code, name, resource],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `materials` DROP COLUMN `code`;",
            "ALTER TABLE `materials` ADD COLUMN `name` string attribute indexed;",
            "ALTER TABLE `materials` ADD COLUMN `resource` json secondary_index='1';",
        ]
    );
}

#[test]
fn gbase8a_uses_limited_mysql_ddl() {
    let mut renamed = column("display_email");
    renamed.data_type = "varchar(255)".to_string();
    renamed.original = Some(ColumnInfo {
        name: "email".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });
    let new_col = column("nickname");
    let mut old_col = column("old_col");
    old_col.marked_for_drop = true;
    old_col.original = Some(ColumnInfo {
        name: "old_col".to_string(),
        data_type: "varchar(20)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });
    let mut index = index("idx_users_email", &["display_email"]);
    index.original = Some(IndexInfo {
        name: "idx_users_email".to_string(),
        columns: vec!["email".to_string()],
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: None,
        included_columns: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Gbase),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![renamed, new_col, old_col],
        indexes: vec![index],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `users` CHANGE COLUMN `email` `display_email` varchar(255);",
            "ALTER TABLE `users` ADD COLUMN `nickname` varchar(255);",
            "ALTER TABLE `users` DROP COLUMN `old_col`;",
        ]
    );
    assert_eq!(
        result.warnings,
        vec!["Editing existing indexes is not supported for gbase from this editor.".to_string()]
    );
}

#[test]
fn manticoresearch_does_not_drop_id_column() {
    let mut id = column("id");
    id.data_type = "bigint".to_string();
    id.marked_for_drop = true;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "bigint".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(result.warnings, vec!["Manticore Search id column cannot be dropped from this editor."]);
}

#[test]
fn manticoresearch_warns_when_existing_column_properties_change() {
    let mut name = column("name");
    name.data_type = "string".to_string();
    name.extra = Some(ColumnExtra {
        manticore_indexed: Some(true),
        manticore_stored: Some(true),
        manticore_attribute: Some(true),
        ..Default::default()
    });
    name.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "string".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut resource = column("resource");
    resource.data_type = "json".to_string();
    resource.extra = Some(ColumnExtra { manticore_secondary_index: Some(true), ..Default::default() });
    resource.original = Some(ColumnInfo {
        name: "resource".to_string(),
        data_type: "json".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut old_resource = column("old_resource");
    old_resource.data_type = "json".to_string();
    old_resource.extra = Some(ColumnExtra::default());
    old_resource.original = Some(ColumnInfo {
        name: "old_resource".to_string(),
        data_type: "json".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: Some("secondary_index='1'".to_string()),
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![name, resource, old_resource],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(
        result.warnings,
        vec![
            "Editing existing columns is not supported for manticoresearch yet.",
            "Editing existing columns is not supported for manticoresearch yet.",
            "Editing existing columns is not supported for manticoresearch yet.",
        ]
    );
}

#[test]
fn manticoresearch_ignores_mysql_column_options() {
    let mut title = column("title");
    title.data_type = "text".to_string();
    title.is_nullable = false;
    title.is_primary_key = true;
    title.default_value = "'untitled'".to_string();
    title.comment = "Title text".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![title],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["CREATE TABLE `materials` (\n  `title` text\n);"]);
}

#[test]
fn manticoresearch_builds_text_column_properties() {
    let mut title = column("title");
    title.data_type = "text".to_string();
    title.extra =
        Some(ColumnExtra { manticore_indexed: Some(true), manticore_stored: Some(true), ..Default::default() });
    let mut sku = column("sku");
    sku.data_type = "string".to_string();
    sku.extra =
        Some(ColumnExtra { manticore_indexed: Some(true), manticore_attribute: Some(true), ..Default::default() });
    let mut name = column("name");
    name.data_type = "string".to_string();
    name.extra = Some(ColumnExtra {
        manticore_indexed: Some(true),
        manticore_stored: Some(true),
        manticore_attribute: Some(true),
        ..Default::default()
    });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![title, sku, name],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "CREATE TABLE `materials` (\n  `title` text stored indexed,\n  `sku` string attribute indexed,\n  `name` string stored attribute indexed\n);"
        ]
    );
}

#[test]
fn manticoresearch_builds_json_secondary_index_property() {
    let mut metadata = column("metadata");
    metadata.data_type = "json".to_string();
    metadata.extra = Some(ColumnExtra { manticore_secondary_index: Some(true), ..Default::default() });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ManticoreSearch),
        schema: None,
        table_name: "materials".to_string(),
        columns: vec![metadata],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["CREATE TABLE `materials` (\n  `metadata` json secondary_index='1'\n);"]);
}

#[test]
fn mysql_create_unique_index_with_comment_and_btree() {
    let mut idx = index("uniq_users_email", &["email"]);
    idx.is_unique = true;
    idx.index_type = "BTREE".to_string();
    idx.comment = "Unique email index".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: Vec::new(),
        indexes: vec![idx],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["CREATE UNIQUE INDEX `uniq_users_email` USING BTREE ON `users` (`email`) COMMENT 'Unique email index';",]
    );
}

#[test]
fn mysql_add_timestamp_column_drops_invalid_precision() {
    let mut created_at = column("created_at");
    created_at.data_type = "timestamp(255)".to_string();
    created_at.default_value = "CURRENT_TIMESTAMP".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![created_at],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE `users` ADD COLUMN `created_at` timestamp DEFAULT CURRENT_TIMESTAMP;"]
    );
}

#[test]
fn mysql_add_timestamp_column_preserves_valid_precision() {
    let mut created_at = column("created_at");
    created_at.data_type = "timestamp(3)".to_string();
    created_at.default_value = "CURRENT_TIMESTAMP(3)".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![created_at],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE `users` ADD COLUMN `created_at` timestamp(3) DEFAULT CURRENT_TIMESTAMP(3);"]
    );
}

#[test]
fn builds_postgres_create_table_with_comments_and_index() {
    let mut id = column("id");
    id.data_type = "integer".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    let mut name = column("name");
    name.data_type = "text".to_string();
    name.comment = "Display name".to_string();
    let mut idx = index("idx_users_name", &["name"]);
    idx.index_type = "gin".to_string();
    idx.comment = "search".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        columns: vec![id, name],
        indexes: vec![idx],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "CREATE TABLE \"public\".\"users\" (\n  \"id\" integer,\n  \"name\" text,\n  PRIMARY KEY (\"id\")\n);",
            "COMMENT ON COLUMN \"public\".\"users\".\"name\" IS 'Display name';",
            "CREATE INDEX \"idx_users_name\" ON \"public\".\"users\" USING GIN (\"name\");",
            "COMMENT ON INDEX \"idx_users_name\" IS 'search';",
        ]
    );
}

#[test]
fn warns_for_sqlite_unsafe_column_changes() {
    let mut col = column("name");
    col.data_type = "text".to_string();
    col.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(80)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Sqlite),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(
        result.warnings,
        vec!["SQLite cannot safely alter existing column \"name\" without rebuilding the table."]
    );
}

#[test]
fn builds_rqlite_changes_with_sqlite_dialect() {
    let mut email = column("email");
    email.data_type = "text".to_string();
    email.is_nullable = false;
    let mut email_index = index("idx_users_email", &["email"]);
    email_index.filter = "email IS NOT NULL".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Rqlite),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![email],
        indexes: vec![email_index],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"users\" ADD COLUMN \"email\" text NOT NULL;",
            "CREATE INDEX \"idx_users_email\" ON \"users\" (\"email\") WHERE email IS NOT NULL;",
        ]
    );
}

#[test]
fn builds_mysql_column_reorder_statements() {
    let mut id = column("id");
    id.data_type = "int".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.original_position = Some(0);
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
    });

    let mut email = column("email");
    email.original_position = Some(2);
    email.original = Some(ColumnInfo {
        name: "email".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut name = column("display_name");
    name.id = "name".to_string();
    name.data_type = "varchar(120)".to_string();
    name.original_position = Some(1);
    name.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(80)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![id, email, name],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `users` MODIFY COLUMN `email` varchar(255) AFTER `id`;",
            "ALTER TABLE `users` CHANGE COLUMN `name` `display_name` varchar(120) AFTER `email`;",
        ]
    );
}

#[test]
fn builds_sql_server_quoted_column_and_index_statements() {
    let mut email = column("email");
    email.data_type = "nvarchar(255)".to_string();
    email.is_nullable = false;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "users".to_string(),
        columns: vec![email],
        indexes: vec![index("idx_users_email", &["email"])],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE [dbo].[users] ADD [email] nvarchar(255) NOT NULL;",
            "CREATE INDEX [idx_users_email] ON [dbo].[users] ([email]);",
        ]
    );
}

#[cfg(feature = "duckdb-bundled")]
#[test]
fn builds_duckdb_create_table_statements() {
    let mut name = column("name");
    name.data_type = "VARCHAR".to_string();
    name.is_nullable = false;
    let mut created_at = column("created_at");
    created_at.data_type = "TIMESTAMP".to_string();
    created_at.default_value = "current_timestamp".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::DuckDb),
        schema: None,
        table_name: "events".to_string(),
        columns: vec![name, created_at],
        indexes: vec![index("idx_events_name", &["name"])],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
            result.statements,
            vec![
                "CREATE TABLE \"events\" (\n  \"name\" VARCHAR NOT NULL,\n  \"created_at\" TIMESTAMP DEFAULT current_timestamp\n);",
                "CREATE INDEX \"idx_events_name\" ON \"events\" (\"name\");",
            ]
        );
}

#[test]
fn builds_clickhouse_nullable_comment_and_reorder_statements() {
    let mut source = column("source");
    source.data_type = "String".to_string();
    source.is_nullable = true;
    source.comment = "traffic source".to_string();
    let mut status = column("status");
    status.data_type = "Nullable(String)".to_string();
    status.is_nullable = false;
    status.comment = "current status".to_string();
    status.original = Some(ColumnInfo {
        name: "status".to_string(),
        data_type: "Nullable(String)".to_string(),
        is_nullable: true,
        column_default: Some("'pending'".to_string()),
        is_primary_key: false,
        extra: None,
        comment: Some("old status".to_string()),
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::ClickHouse),
        schema: None,
        table_name: "events".to_string(),
        columns: vec![source, status],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"events\" ADD COLUMN \"source\" Nullable(String);",
            "ALTER TABLE \"events\" COMMENT COLUMN \"source\" 'traffic source';",
            "ALTER TABLE \"events\" MODIFY COLUMN \"status\" REMOVE DEFAULT;",
            "ALTER TABLE \"events\" MODIFY COLUMN \"status\" String;",
            "ALTER TABLE \"events\" COMMENT COLUMN \"status\" 'current status';",
        ]
    );
}

#[test]
fn builds_h2_schema_qualified_existing_column_statements() {
    let mut name = column("DISPLAY_NAME");
    name.id = "name".to_string();
    name.data_type = "VARCHAR(120)".to_string();
    name.is_nullable = false;
    name.default_value = "guest".to_string();
    name.comment = "Display name".to_string();
    name.original = Some(ColumnInfo {
        name: "NAME".to_string(),
        data_type: "VARCHAR(80)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::H2),
        schema: Some("PUBLIC".to_string()),
        table_name: "USERS".to_string(),
        columns: vec![name],
        indexes: vec![index("IDX_USERS_DISPLAY_NAME", &["DISPLAY_NAME"])],
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"PUBLIC\".\"USERS\" ALTER COLUMN \"NAME\" RENAME TO \"DISPLAY_NAME\";",
            "ALTER TABLE \"PUBLIC\".\"USERS\" ALTER COLUMN \"DISPLAY_NAME\" SET DATA TYPE VARCHAR(120);",
            "ALTER TABLE \"PUBLIC\".\"USERS\" ALTER COLUMN \"DISPLAY_NAME\" SET NOT NULL;",
            "ALTER TABLE \"PUBLIC\".\"USERS\" ALTER COLUMN \"DISPLAY_NAME\" SET DEFAULT 'guest';",
            "COMMENT ON COLUMN \"PUBLIC\".\"USERS\".\"DISPLAY_NAME\" IS 'Display name';",
            "CREATE INDEX \"IDX_USERS_DISPLAY_NAME\" ON \"PUBLIC\".\"USERS\" (\"DISPLAY_NAME\");",
        ]
    );
}

#[test]
fn builds_postgres_alter_table_add_primary_key() {
    let mut id = column("id");
    id.data_type = "integer".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "integer".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE \"public\".\"users\" ADD PRIMARY KEY (\"id\");"]);
}

#[test]
fn builds_postgres_alter_table_drop_primary_key() {
    let mut id = column("id");
    id.data_type = "integer".to_string();
    id.is_nullable = false;
    id.is_primary_key = false;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "integer".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE \"public\".\"users\" DROP CONSTRAINT \"users_pkey\";"]);
}

#[test]
fn builds_mysql_alter_table_change_primary_key() {
    let mut old_pk = column("id");
    old_pk.id = "old_id".to_string();
    old_pk.data_type = "int".to_string();
    old_pk.is_nullable = false;
    old_pk.is_primary_key = false;
    old_pk.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
    });

    let mut new_pk = column("uuid");
    new_pk.id = "new_uuid".to_string();
    new_pk.data_type = "varchar(36)".to_string();
    new_pk.is_nullable = false;
    new_pk.is_primary_key = true;
    new_pk.original = Some(ColumnInfo {
        name: "uuid".to_string(),
        data_type: "varchar(36)".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![old_pk, new_pk],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE `users` DROP PRIMARY KEY;", "ALTER TABLE `users` ADD PRIMARY KEY (`uuid`);",]
    );
}

#[test]
fn builds_no_statements_when_primary_key_unchanged() {
    let mut id = column("id");
    id.data_type = "integer".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "integer".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements.is_empty());
}

#[test]
fn warns_sqlite_cannot_alter_primary_key() {
    let mut id = column("id");
    id.data_type = "integer".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "integer".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Sqlite),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(result.warnings.len(), 1);
    assert!(result.warnings[0].contains("primary key"));
}

#[test]
fn mysql_create_table_with_auto_increment() {
    let mut col = column("id");
    col.data_type = "int".to_string();
    col.is_nullable = false;
    col.is_primary_key = true;
    col.extra = Some(ColumnExtra { auto_increment: Some(true), ..Default::default() });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements.len(), 1);
    assert!(result.statements[0].contains("AUTO_INCREMENT"));
}

#[test]
fn mysql_create_table_with_on_update_current_timestamp() {
    let mut col = column("updated_at");
    col.data_type = "timestamp".to_string();
    col.is_nullable = false;
    col.default_value = "CURRENT_TIMESTAMP".to_string();
    col.extra = Some(ColumnExtra { on_update_current_timestamp: Some(true), ..Default::default() });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("ON UPDATE CURRENT_TIMESTAMP"));
}

#[test]
fn postgres_create_table_with_identity() {
    let mut col = column("id");
    col.data_type = "integer".to_string();
    col.is_nullable = false;
    col.extra = Some(ColumnExtra {
        identity: Some(ColumnIdentity { generation: Some("BY DEFAULT".to_string()), seed: None, increment: None }),
        ..Default::default()
    });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("GENERATED BY DEFAULT AS IDENTITY"));
}

#[test]
fn sqlserver_create_table_with_identity() {
    let mut col = column("id");
    col.data_type = "int".to_string();
    col.is_nullable = false;
    col.extra = Some(ColumnExtra {
        auto_increment: Some(true),
        identity: Some(ColumnIdentity { generation: None, seed: Some(100), increment: Some(5) }),
        ..Default::default()
    });

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("IDENTITY(100, 5)"));
}

#[test]
fn mysql_quotes_datetime_literal_default() {
    let mut col = column("created_at");
    col.data_type = "datetime".to_string();
    col.default_value = "2024-01-01 00:00:00".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "events".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT '2024-01-01 00:00:00'"));
}

#[test]
fn mysql_does_not_quote_current_timestamp() {
    let mut col = column("updated_at");
    col.data_type = "timestamp".to_string();
    col.default_value = "CURRENT_TIMESTAMP".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "events".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT CURRENT_TIMESTAMP"));
    assert!(!result.statements[0].contains("DEFAULT 'CURRENT_TIMESTAMP'"));
}

#[test]
fn mysql_does_not_quote_temporal_function_with_parens() {
    let mut col = column("created_at");
    col.data_type = "datetime".to_string();
    col.default_value = "NOW()".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "events".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT NOW()"));
}

#[test]
fn mysql_date_literal_default_is_quoted() {
    let mut col = column("birth_date");
    col.data_type = "date".to_string();
    col.default_value = "2000-01-01".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT '2000-01-01'"));
}

#[test]
fn mysql_time_literal_default_is_quoted() {
    let mut col = column("start_time");
    col.data_type = "time".to_string();
    col.default_value = "09:00:00".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "shifts".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT '09:00:00'"));
}

#[test]
fn non_temporal_types_are_not_quoted() {
    let mut col = column("score");
    col.data_type = "int".to_string();
    col.default_value = "0".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "games".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 0"));
    assert!(!result.statements[0].contains("DEFAULT '0'"));
}

#[test]
fn postgres_timestamp_literal_is_quoted() {
    let mut col = column("logged_at");
    col.data_type = "timestamp".to_string();
    col.default_value = "2024-06-01 12:00:00".to_string();
    col.original = Some(ColumnInfo {
        name: "logged_at".to_string(),
        data_type: "timestamp".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("public".to_string()),
        table_name: "events".to_string(),
        column: col,
    });

    assert!(result.statements.iter().any(|s| s.contains("SET DEFAULT '2024-06-01 12:00:00'")));
}

#[test]
fn mysql_single_column_alter_quotes_datetime_literal() {
    let mut col = column("created_at");
    col.data_type = "datetime".to_string();
    col.default_value = "2024-01-01 00:00:00".to_string();
    col.original = Some(ColumnInfo {
        name: "created_at".to_string(),
        data_type: "datetime".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "events".to_string(),
        column: col,
    });

    assert!(result.statements.iter().any(|s| s.contains("DEFAULT '2024-01-01 00:00:00'")));
}

#[test]
fn builds_mysql_foreign_key_changes() {
    let mut existing = foreign_key("fk_orders_users", "user_id", "users", "id");
    existing.on_delete = "CASCADE".to_string();
    existing.original = Some(ForeignKeyInfo {
        name: "fk_orders_users_old".to_string(),
        column: "customer_id".to_string(),
        ref_schema: None,
        ref_table: "customers".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: Some("RESTRICT".to_string()),
    });

    let mut dropped = foreign_key("fk_orders_accounts", "account_id", "accounts", "id");
    dropped.marked_for_drop = true;
    dropped.original = Some(ForeignKeyInfo {
        name: "fk_orders_accounts".to_string(),
        column: "account_id".to_string(),
        ref_schema: None,
        ref_table: "accounts".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "orders".to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: vec![existing, dropped],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_users_old`;",
            "ALTER TABLE `orders` ADD CONSTRAINT `fk_orders_users` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;",
            "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_accounts`;",
        ]
    );
}

#[test]
fn builds_mysql_composite_foreign_key() {
    let composite = foreign_key("fk_order_items_product", "tenant_id, product_id", "products", "tenant_id, id");

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "order_items".to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: vec![composite],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `order_items` ADD CONSTRAINT `fk_order_items_product` FOREIGN KEY (`tenant_id`, `product_id`) REFERENCES `products` (`tenant_id`, `id`);",
        ]
    );
}

#[test]
fn builds_mysql_trigger_changes() {
    let mut existing = trigger("orders_bu", "BEFORE", "UPDATE", "BEGIN\n  SET NEW.updated_at = NOW();\nEND");
    existing.original = Some(TriggerInfo {
        name: "orders_bu".to_string(),
        event: "UPDATE".to_string(),
        timing: "BEFORE".to_string(),
        statement: Some("SET NEW.updated_at = CURRENT_TIMESTAMP".to_string()),
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "orders".to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: vec![existing],
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "DROP TRIGGER `orders_bu`;",
            "CREATE TRIGGER `orders_bu` BEFORE UPDATE ON `orders` FOR EACH ROW\nBEGIN\n  SET NEW.updated_at = NOW();\nEND;",
        ]
    );
}

#[test]
fn mysql_varchar_default_is_quoted() {
    let mut col = column("name");
    col.data_type = "varchar(255)".to_string();
    col.default_value = "hello".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 'hello'"));
    assert!(!result.statements[0].contains("DEFAULT hello "));
}

#[test]
fn mysql_char_default_is_quoted() {
    let mut col = column("code");
    col.data_type = "char(10)".to_string();
    col.default_value = "abc".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "items".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 'abc'"));
}

#[test]
fn mysql_text_default_is_quoted() {
    let mut col = column("description");
    col.data_type = "text".to_string();
    col.default_value = "default value".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "products".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 'default value'"));
}

#[test]
fn mysql_enum_default_is_quoted() {
    let mut col = column("status");
    col.data_type = "enum('active','inactive')".to_string();
    col.default_value = "active".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 'active'"));
}

#[test]
fn mysql_int_default_is_not_quoted() {
    let mut col = column("score");
    col.data_type = "int".to_string();
    col.default_value = "100".to_string();

    let result = build_create_table_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "games".to_string(),
        columns: vec![col],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert!(result.statements[0].contains("DEFAULT 100"));
    assert!(!result.statements[0].contains("DEFAULT '100'"));
}

#[test]
fn postgres_varchar_default_is_quoted() {
    let mut col = column("label");
    col.data_type = "varchar(100)".to_string();
    col.default_value = "test label".to_string();
    col.original = Some(ColumnInfo {
        name: "label".to_string(),
        data_type: "varchar(100)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: None,
        table_name: "items".to_string(),
        column: col,
    });

    assert!(result.statements.iter().any(|s| s.contains("SET DEFAULT 'test label'")));
}
