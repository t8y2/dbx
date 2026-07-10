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
fn builds_mysql_unsigned_integer_column_with_length_before_attribute() {
    let mut score = column("score");
    score.data_type = "int unsigned(11)".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "users".to_string(),
        columns: vec![score],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE `users` ADD COLUMN `score` int(11) unsigned;"]);
}

#[test]
fn doris_table_editor_renames_column_without_mysql_change_syntax() {
    let mut renamed = column("dtp_flag_jt");
    renamed.data_type = "int".to_string();
    renamed.comment = "Group DTP".to_string();
    renamed.original = Some(ColumnInfo {
        name: "dtp_flag".to_string(),
        data_type: "int".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some("Group DTP".to_string()),
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Doris),
        schema: Some("qybiprod".to_string()),
        table_name: "dim_prod_sp_vkorg".to_string(),
        columns: vec![renamed],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE `dim_prod_sp_vkorg` RENAME COLUMN `dtp_flag` `dtp_flag_jt`;"]);
}

#[test]
fn doris_single_column_alter_renames_then_modifies_column_definition() {
    let mut renamed = column("dtp_flag_jt");
    renamed.data_type = "int".to_string();
    renamed.comment = "Group DTP".to_string();
    renamed.original = Some(ColumnInfo {
        name: "dtp_flag".to_string(),
        data_type: "int".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some("Division DTP".to_string()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Doris),
        schema: Some("qybiprod".to_string()),
        table_name: "dim_prod_sp_vkorg".to_string(),
        column: renamed,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE `dim_prod_sp_vkorg` RENAME COLUMN `dtp_flag` `dtp_flag_jt`;",
            "ALTER TABLE `dim_prod_sp_vkorg` MODIFY COLUMN `dtp_flag_jt` int COMMENT 'Group DTP';",
        ]
    );
}

#[test]
fn dameng_integer_column_omits_mysql_display_width() {
    let mut age = column("age");
    age.data_type = "integer(11)".to_string();
    let mut amount = column("amount");
    amount.data_type = "number(10,0)".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Dameng),
        schema: Some("SYSDBA".to_string()),
        table_name: "users".to_string(),
        columns: vec![age, amount],
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
            "ALTER TABLE \"SYSDBA\".\"users\" ADD (\"age\" integer);",
            "ALTER TABLE \"SYSDBA\".\"users\" ADD (\"amount\" number(10,0));",
        ]
    );
}

#[test]
fn builds_highgo_foreign_key_changes_with_postgres_syntax() {
    let mut old_fk = foreign_key("orders_user_id_fkey", "user_id", "users", "id");
    old_fk.marked_for_drop = true;
    old_fk.original = Some(ForeignKeyInfo {
        name: "orders_user_id_fkey".to_string(),
        column: "user_id".to_string(),
        ref_schema: Some("public".to_string()),
        ref_table: "users".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: None,
    });
    let mut new_fk = foreign_key("orders_account_id_fkey", "account_id", "accounts", "id");
    new_fk.ref_schema = "crm".to_string();
    new_fk.on_delete = "CASCADE".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Highgo),
        schema: Some("public".to_string()),
        table_name: "orders".to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: vec![old_fk, new_fk],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec![
            "ALTER TABLE \"public\".\"orders\" DROP CONSTRAINT \"orders_user_id_fkey\";",
            "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"orders_account_id_fkey\" FOREIGN KEY (\"account_id\") REFERENCES \"crm\".\"accounts\" (\"id\") ON DELETE CASCADE;",
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
fn oracle_does_not_generate_drop_sql_for_all_columns() {
    let mut id = column("id");
    id.marked_for_drop = true;
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "varchar2(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });
    let mut name = column("name");
    name.marked_for_drop = true;
    name.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar2(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Oracle),
        schema: Some("DBX_TEST".to_string()),
        table_name: "test".to_string(),
        columns: vec![id, name],
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
            "Oracle does not allow dropping all columns from a table. Keep at least one column or drop the table instead."
        ]
    );
}

#[test]
fn oracle_timestamp_default_precedes_nullability_in_modify_sql() {
    let mut col = column("time");
    col.data_type = "TIMESTAMP(6)".to_string();
    col.default_value = "CURRENT_TIMESTAMP".to_string();
    col.original = Some(ColumnInfo {
        name: "time".to_string(),
        data_type: "TIMESTAMP(6)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Oracle),
        schema: Some("DBX_TEST".to_string()),
        table_name: "test".to_string(),
        column: col,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE \"DBX_TEST\".\"test\" MODIFY (\"time\" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP);"]
    );
}

#[test]
fn oracle_timestamp_precision_change_does_not_repeat_unchanged_nullability() {
    let mut col = column("time");
    col.data_type = "TIMESTAMP(9)".to_string();
    col.original = Some(ColumnInfo {
        name: "time".to_string(),
        data_type: "TIMESTAMP(6)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Oracle),
        schema: Some("DBX_TEST".to_string()),
        table_name: "test".to_string(),
        column: col,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE \"DBX_TEST\".\"test\" MODIFY (\"time\" TIMESTAMP(9));"]);
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
fn gbase8a_allows_mysql_style_column_reorder() {
    let mut id = column("id");
    id.original_position = Some(0);
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut name = column("name");
    name.original_position = Some(1);
    name.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
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

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Gbase),
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
    assert_eq!(result.statements, vec!["ALTER TABLE `users` MODIFY COLUMN `name` varchar(255) AFTER `email`;"]);
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
fn builds_kingbase_add_column_without_column_keyword() {
    let mut flag = column("flag");
    flag.data_type = "varchar(100)".to_string();

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Kingbase),
        schema: Some("dbo".to_string()),
        table_name: "dw_bill_info_copy".to_string(),
        columns: vec![flag],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE \"dbo\".\"dw_bill_info_copy\" ADD \"flag\" varchar(100);"]);
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
        vec!["ALTER TABLE `users` CHANGE COLUMN `name` `display_name` varchar(120) AFTER `email`;"]
    );
}

#[test]
fn mysql_add_column_before_existing_column_does_not_reorder_shifted_column() {
    let mut deleted = column("deleted");
    deleted.original_position = Some(0);
    deleted.original = Some(ColumnInfo {
        name: "deleted".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let new_column = column("sss");

    let mut tenant_id = column("tenant_id");
    tenant_id.data_type = "bigint".to_string();
    tenant_id.is_nullable = false;
    tenant_id.default_value = "0".to_string();
    tenant_id.comment = "tenant id".to_string();
    tenant_id.original_position = Some(1);
    tenant_id.original = Some(ColumnInfo {
        name: "tenant_id".to_string(),
        data_type: "bigint".to_string(),
        is_nullable: false,
        column_default: Some("0".to_string()),
        is_primary_key: false,
        extra: None,
        comment: Some("tenant id".to_string()),
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::Mysql),
        schema: None,
        table_name: "infra_api_error_log".to_string(),
        columns: vec![deleted, new_column, tenant_id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        result.statements,
        vec!["ALTER TABLE `infra_api_error_log` ADD COLUMN `sss` varchar(255) AFTER `deleted`;"]
    );
}

#[test]
fn mysql_existing_column_reorder_does_not_reorder_columns_shifted_by_prior_move() {
    let mut id = column("id");
    id.original_position = Some(0);
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut name = column("name");
    name.original_position = Some(1);
    name.original = Some(ColumnInfo {
        name: "name".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
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
    assert_eq!(result.statements, vec!["ALTER TABLE `users` MODIFY COLUMN `name` varchar(255) AFTER `email`;"]);
}

#[test]
fn mysql_moving_first_column_to_end_uses_single_reorder_statement() {
    let mut col_0 = column("col_0");
    col_0.data_type = "int(11)".to_string();
    col_0.is_nullable = false;
    col_0.original_position = Some(0);
    col_0.original = Some(ColumnInfo {
        name: "col_0".to_string(),
        data_type: "int(11)".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut col_1 = column("col_1");
    col_1.original_position = Some(1);
    col_1.original = Some(ColumnInfo {
        name: "col_1".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut col_2 = column("col_2");
    col_2.original_position = Some(2);
    col_2.original = Some(ColumnInfo {
        name: "col_2".to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut col_3 = column("col_3");
    col_3.original_position = Some(3);
    col_3.original = Some(ColumnInfo {
        name: "col_3".to_string(),
        data_type: "varchar(255)".to_string(),
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
        columns: vec![col_1, col_2, col_3, col_0],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE `users` MODIFY COLUMN `col_0` int(11) NOT NULL AFTER `col_3`;"]);
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

#[test]
fn sqlserver_strips_mysql_display_width_from_fixed_integer_types() {
    let mut id = column("id");
    id.data_type = "int(11)".to_string();
    id.is_nullable = false;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "users".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE [dbo].[users] ADD [id] int NOT NULL;"]);
}

#[test]
fn sqlserver_strips_scale_from_float() {
    let mut amount = column("amount");
    amount.data_type = "float(10,2)".to_string();
    amount.is_nullable = true;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: vec![amount],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE [dbo].[orders] ADD [amount] float;"]);
}

#[test]
fn sqlserver_preserves_float_mantissa_bits() {
    let mut value = column("value");
    value.data_type = "float(53)".to_string();
    value.is_nullable = false;

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "measurements".to_string(),
        columns: vec![value],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE [dbo].[measurements] ADD [value] float(53) NOT NULL;"]);
}

#[test]
fn sqlserver_default_changes_drop_old_constraints_with_isolated_batches() {
    let mut sku = column("sku");
    sku.data_type = "nvarchar(64)".to_string();
    sku.default_value = "new sku".to_string();
    sku.original = Some(ColumnInfo {
        name: "sku".to_string(),
        data_type: "nvarchar(64)".to_string(),
        is_nullable: true,
        column_default: Some("'old sku'".to_string()),
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let mut active = column("active");
    active.data_type = "bit".to_string();
    active.is_nullable = false;
    active.default_value = "1".to_string();
    active.original = Some(ColumnInfo {
        name: "active".to_string(),
        data_type: "bit".to_string(),
        is_nullable: false,
        column_default: Some("0".to_string()),
        is_primary_key: false,
        extra: None,
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("core".to_string()),
        table_name: "products".to_string(),
        columns: vec![sku, active],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements.len(), 4);

    let sku_drop = &result.statements[0];
    let active_drop = &result.statements[2];
    let sku_var = sku_drop.strip_prefix("DECLARE ").unwrap().split_once(" NVARCHAR(MAX);").unwrap().0;
    let active_var = active_drop.strip_prefix("DECLARE ").unwrap().split_once(" NVARCHAR(MAX);").unwrap().0;
    assert_ne!(sku_var, "@sql");
    assert_ne!(active_var, "@sql");
    assert_ne!(sku_var, active_var);

    for (sql, column_name) in [(sku_drop, "sku"), (active_drop, "active")] {
        assert!(sql.contains("SELECT TOP (1)"));
        assert!(sql.contains(" + QUOTENAME(dc.name) FROM sys.default_constraints AS dc WHERE "));
        assert!(sql.contains("OBJECT_ID(N'[core].[products]')"));
        assert!(sql.contains(&format!("N'{column_name}', 'ColumnId'")));
        assert!(sql.contains(" IF "));
        assert!(!sql.contains("]'FROM"));
        assert!(!sql.contains("constraintsWHERE"));
    }

    assert_eq!(
        result.statements[1],
        "ALTER TABLE [core].[products] ADD CONSTRAINT [DF_products_sku] DEFAULT 'new sku' FOR [sku];"
    );
    assert_eq!(
        result.statements[3],
        "ALTER TABLE [core].[products] ADD CONSTRAINT [DF_products_active] DEFAULT 1 FOR [active];"
    );
}

#[test]
fn sqlserver_unchanged_foreign_key_does_not_warn_when_saving_other_changes() {
    let mut email = column("email");
    email.data_type = "nvarchar(255)".to_string();
    email.is_nullable = false;

    let mut user_fk = foreign_key("fk_orders_user_id", "user_id", "users", "id");
    user_fk.ref_schema = "dbo".to_string();
    user_fk.original = Some(ForeignKeyInfo {
        name: "fk_orders_user_id".to_string(),
        column: "user_id".to_string(),
        ref_schema: Some("dbo".to_string()),
        ref_table: "users".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: vec![email],
        indexes: Vec::new(),
        foreign_keys: vec![user_fk],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE [dbo].[orders] ADD [email] nvarchar(255) NOT NULL;"]);
}

#[test]
fn sqlserver_add_column_with_identity() {
    let mut id = column("id");
    id.data_type = "int".to_string();
    id.is_nullable = false;
    id.extra = Some(ColumnExtra {
        auto_increment: Some(true),
        identity: Some(ColumnIdentity { generation: None, seed: Some(10), increment: Some(2) }),
        ..Default::default()
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, vec!["ALTER TABLE [dbo].[orders] ADD [id] int NOT NULL IDENTITY(10, 2);"]);
}

#[test]
fn sqlserver_rejects_identity_on_incompatible_type() {
    let mut column = column("test");
    column.data_type = "varchar(255)".to_string();
    column.is_nullable = false;
    column.extra = Some(ColumnExtra {
        auto_increment: Some(true),
        identity: Some(ColumnIdentity { generation: None, seed: Some(1), increment: Some(1) }),
        ..Default::default()
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("core".to_string()),
        table_name: "products".to_string(),
        columns: vec![column],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(
        result.warnings,
        vec!["SQL Server identity column \"test\" must use tinyint, smallint, int, bigint, or decimal/numeric with scale 0."]
    );
}

#[test]
fn sqlserver_changed_foreign_key_still_warns_as_unsupported() {
    let mut user_fk = foreign_key("fk_orders_user_id", "user_id", "accounts", "id");
    user_fk.ref_schema = "dbo".to_string();
    user_fk.original = Some(ForeignKeyInfo {
        name: "fk_orders_user_id".to_string(),
        column: "user_id".to_string(),
        ref_schema: Some("dbo".to_string()),
        ref_table: "users".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: vec![user_fk],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(result.warnings, vec!["Editing foreign keys is not supported for sqlserver from this editor."]);
}

#[test]
fn sqlserver_unchanged_identity_extra_does_not_mark_existing_column_changed() {
    let mut id = column("id");
    id.data_type = "int".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.extra = Some(ColumnExtra {
        auto_increment: Some(true),
        identity: Some(ColumnIdentity { generation: None, seed: Some(1), increment: Some(1) }),
        ..Default::default()
    });
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: Some("IDENTITY(1,1)".to_string()),
        comment: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements, Vec::<String>::new());
}

#[test]
fn sqlserver_existing_column_identity_change_warns_without_unchanged_foreign_key_warning() {
    let mut id = column("id");
    id.data_type = "int".to_string();
    id.is_nullable = false;
    id.is_primary_key = true;
    id.extra = Some(ColumnExtra {
        auto_increment: Some(true),
        identity: Some(ColumnIdentity { generation: None, seed: Some(1), increment: Some(1) }),
        ..Default::default()
    });
    id.original = Some(ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        extra: None,
        comment: None,
    });

    let mut user_fk = foreign_key("fk_orders_user_id", "user_id", "users", "id");
    user_fk.ref_schema = "dbo".to_string();
    user_fk.original = Some(ForeignKeyInfo {
        name: "fk_orders_user_id".to_string(),
        column: "user_id".to_string(),
        ref_schema: Some("dbo".to_string()),
        ref_table: "users".to_string(),
        ref_column: "id".to_string(),
        on_update: None,
        on_delete: None,
    });

    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some("dbo".to_string()),
        table_name: "orders".to_string(),
        columns: vec![id],
        indexes: Vec::new(),
        foreign_keys: vec![user_fk],
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });

    assert_eq!(result.statements, Vec::<String>::new());
    assert_eq!(
        result.warnings,
        vec!["Changing SQL Server IDENTITY for existing column \"id\" is not supported from this editor."]
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

#[test]
fn postgres_empty_string_default_is_not_quoted_again() {
    let mut col = column("sku");
    col.data_type = "character varying".to_string();
    col.default_value = "''".to_string();
    col.original = Some(ColumnInfo {
        name: "sku".to_string(),
        data_type: "character varying".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("core".to_string()),
        table_name: "products".to_string(),
        column: col,
    });

    assert_eq!(result.statements, vec!["ALTER TABLE \"core\".\"products\" ALTER COLUMN \"sku\" SET DEFAULT '';"]);
}

#[test]
fn postgres_string_default_cast_matches_plain_literal() {
    let mut col = column("category");
    col.data_type = "character varying".to_string();
    col.default_value = "''".to_string();
    col.original = Some(ColumnInfo {
        name: "category".to_string(),
        data_type: "character varying".to_string(),
        is_nullable: true,
        column_default: Some("''::character varying".to_string()),
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("core".to_string()),
        table_name: "products".to_string(),
        column: col,
    });

    assert_eq!(result.statements, Vec::<String>::new());
}

#[test]
fn postgres_integer_default_is_not_quoted() {
    let mut col = column("stock");
    col.data_type = "integer".to_string();
    col.default_value = "0".to_string();
    col.original = Some(ColumnInfo {
        name: "stock".to_string(),
        data_type: "integer".to_string(),
        is_nullable: true,
        column_default: None,
        is_primary_key: false,
        extra: None,
        comment: Some(String::new()),
    });

    let result = build_single_column_alter_sql(SingleColumnAlterSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("core".to_string()),
        table_name: "products".to_string(),
        column: col,
    });

    assert_eq!(result.statements, vec!["ALTER TABLE \"core\".\"products\" ALTER COLUMN \"stock\" SET DEFAULT 0;"]);
}
