use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::types::ObjectSourceKind;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableObjectSourceSqlInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRenameObjectSourceInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub new_name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildViewDdlInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObjectSourceSaveExecutionMode {
    #[serde(rename = "single")]
    Single,
    #[serde(rename = "script")]
    Script,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RoutineDeclaration {
    kind: ObjectSourceKind,
    name: String,
    signature: String,
}

pub fn supports_source_backed_routine_rename(
    database_type: Option<DatabaseType>,
    object_type: ObjectSourceKind,
) -> bool {
    if !matches!(object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure) {
        return false;
    }
    let Some(database_type) = database_type else {
        return false;
    };
    database_type != DatabaseType::SqlServer
        && (is_mysql_like(database_type) || is_postgres_like(database_type) || is_oracle_like(database_type))
}

pub fn build_routine_rename_object_source_statements(
    input: RoutineRenameObjectSourceInput,
) -> Result<Vec<String>, String> {
    if !supports_source_backed_routine_rename(Some(input.database_type), input.object_type.clone()) {
        return Err(format!(
            "Renaming {:?} from source is not supported for {:?}.",
            input.object_type, input.database_type
        ));
    }

    let source = input.source.trim();
    let declaration = if is_mysql_like(input.database_type) {
        mysql_routine_declaration(source)
    } else {
        routine_declaration(source)
    };
    let Some(declaration) = declaration else {
        return Err(format!("Cannot find a CREATE {:?} declaration in the object source.", input.object_type));
    };
    if declaration.kind != input.object_type {
        return Err(format!("Cannot find a CREATE {:?} declaration in the object source.", input.object_type));
    }

    let renamed_source = if is_mysql_like(input.database_type) {
        replace_mysql_routine_declaration_name(source, &input.new_name)
    } else {
        replace_sql_routine_declaration_name(source, input.schema.as_deref(), &input.new_name)
    };
    let Some(renamed_source) = renamed_source else {
        return Err(format!("Cannot rewrite the {:?} name in the object source.", input.object_type));
    };

    if is_oracle_like(input.database_type) {
        return Ok(vec![
            ensure_semicolon(&renamed_source),
            format!(
                "DROP {} {};",
                object_type_keyword(&input.object_type),
                postgres_qualified_name(input.schema.as_deref(), &input.name)
            ),
        ]);
    }

    build_executable_object_source_statements(EditableObjectSourceSqlInput {
        database_type: input.database_type,
        object_type: input.object_type,
        schema: input.schema,
        name: input.name,
        source: renamed_source,
    })
}

pub fn build_executable_object_source_statements(input: EditableObjectSourceSqlInput) -> Result<Vec<String>, String> {
    let source = input.source.trim();
    if input.database_type == DatabaseType::SqlServer {
        if input.object_type == ObjectSourceKind::View {
            return Ok(vec![build_sqlserver_alter_view_sql(input.schema.as_deref(), &input.name, source)]);
        }
        return Ok(vec![replace_sqlserver_create_with_create_or_alter(source)]);
    }

    if matches!(
        input.database_type,
        DatabaseType::Postgres
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Questdb
    ) && input.object_type == ObjectSourceKind::View
    {
        return Ok(vec![format!(
            "CREATE OR REPLACE VIEW {} AS\n{}",
            postgres_qualified_name(input.schema.as_deref(), &input.name),
            ensure_semicolon(source)
        )]);
    }

    let create_statement = ensure_semicolon(source);
    let cleanup = build_routine_rename_cleanup(&input, source);
    Ok(if let Some(cleanup) = cleanup { vec![create_statement, cleanup] } else { vec![create_statement] })
}

pub fn build_executable_object_source_sql(input: EditableObjectSourceSqlInput) -> Result<String, String> {
    Ok(build_executable_object_source_statements(input)?.join("\n"))
}

/// Convert a raw database object source into a form suitable for the source editor.
///
/// This is the *editable* presentation shown to the user when they open a view,
/// procedure, or function for editing. For SQL Server the raw `CREATE VIEW` /
/// `CREATE PROCEDURE` is rewritten to `CREATE OR ALTER` so the user doesn't see
/// a mismatched CREATE statement for an already-existing object. Callers that
/// only need the first statement should use this instead of calling
/// `build_executable_object_source_statements` and discarding rename-cleanup
/// statements.
pub fn build_editable_object_source(input: EditableObjectSourceSqlInput) -> String {
    let source = input.source.clone();
    match build_executable_object_source_statements(input) {
        Ok(statements) => statements.into_iter().next().unwrap_or_default(),
        Err(_) => ensure_semicolon(source.trim()),
    }
}

pub fn build_view_ddl_sql(input: BuildViewDdlInput) -> String {
    let source = input.source.trim();
    if Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(source) {
        return ensure_semicolon(source);
    }

    let qualified_name = if matches!(input.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
        mysql_qualified_name(input.schema.as_deref(), &input.name)
    } else {
        postgres_qualified_name(input.schema.as_deref(), &input.name)
    };

    if input.database_type.is_none()
        || input.database_type.is_some_and(|database_type| {
            is_postgres_like(database_type)
                || database_type == DatabaseType::OpenGauss
                || database_type == DatabaseType::Questdb
        })
    {
        return format!("CREATE OR REPLACE VIEW {qualified_name} AS\n{}", ensure_semicolon(source));
    }

    format!("CREATE VIEW {qualified_name} AS\n{}", ensure_semicolon(source))
}

pub fn object_source_save_execution_mode(_database_type: DatabaseType) -> ObjectSourceSaveExecutionMode {
    ObjectSourceSaveExecutionMode::Single
}

fn build_routine_rename_cleanup(input: &EditableObjectSourceSqlInput, source: &str) -> Option<String> {
    if !matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure) {
        return None;
    }

    if is_mysql_like(input.database_type) {
        let declaration = mysql_routine_declaration(source)?;
        if declaration.kind != input.object_type || !routine_name_changed(&declaration.name, &input.name) {
            return None;
        }
        return Some(format!(
            "DROP {} IF EXISTS {};",
            object_type_keyword(&input.object_type),
            mysql_qualified_name(input.schema.as_deref(), &input.name)
        ));
    }

    if !is_postgres_like(input.database_type) {
        return None;
    }

    let declaration = routine_declaration(source)?;
    if declaration.kind != input.object_type || !routine_name_changed(&declaration.name, &input.name) {
        return None;
    }

    Some(format!(
        "DROP {} IF EXISTS {}{};",
        object_type_keyword(&input.object_type),
        postgres_qualified_name(input.schema.as_deref(), &input.name),
        declaration.signature
    ))
}

fn is_postgres_like(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Questdb
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
    )
}

fn is_mysql_like(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Mysql | DatabaseType::Goldendb)
}

fn is_oracle_like(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::Dameng)
}

fn object_type_keyword(object_type: &ObjectSourceKind) -> &'static str {
    match object_type {
        ObjectSourceKind::View => "VIEW",
        ObjectSourceKind::MaterializedView => "MATERIALIZED_VIEW",
        ObjectSourceKind::Procedure => "PROCEDURE",
        ObjectSourceKind::Function => "FUNCTION",
        ObjectSourceKind::Sequence => "SEQUENCE",
        ObjectSourceKind::Package => "PACKAGE",
        ObjectSourceKind::PackageBody => "PACKAGE BODY",
    }
}

fn quote_postgres_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn postgres_qualified_name(schema: Option<&str>, name: &str) -> String {
    schema
        .into_iter()
        .chain(std::iter::once(name))
        .filter(|part| !part.is_empty())
        .map(quote_postgres_identifier)
        .collect::<Vec<_>>()
        .join(".")
}

fn mysql_qualified_name(schema: Option<&str>, name: &str) -> String {
    schema
        .into_iter()
        .chain(std::iter::once(name))
        .filter(|part| !part.is_empty())
        .map(quote_mysql_identifier)
        .collect::<Vec<_>>()
        .join(".")
}

fn quote_sqlserver_identifier(value: &str) -> String {
    format!("[{}]", value.replace(']', "]]"))
}

fn sqlserver_qualified_name(schema: Option<&str>, name: &str) -> String {
    schema
        .into_iter()
        .chain(std::iter::once(name))
        .filter(|part| !part.is_empty())
        .map(quote_sqlserver_identifier)
        .collect::<Vec<_>>()
        .join(".")
}

fn unquote_postgres_identifier(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].replace("\"\"", "\"")
    } else {
        trimmed.to_string()
    }
}

fn split_qualified_routine_name(value: &str) -> Vec<String> {
    Regex::new(r#""(?:""|[^"])+"|[A-Za-z_][\w$]*"#)
        .unwrap()
        .find_iter(value)
        .map(|part| unquote_postgres_identifier(part.as_str()))
        .collect()
}

fn unquote_mysql_identifier(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('`') && trimmed.ends_with('`') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].replace("``", "`")
    } else {
        trimmed.to_string()
    }
}

fn split_mysql_qualified_routine_name(value: &str) -> Vec<String> {
    Regex::new(r"`(?:``|[^`])+`|[A-Za-z_][\w$]*")
        .unwrap()
        .find_iter(value)
        .map(|part| unquote_mysql_identifier(part.as_str()))
        .collect()
}

fn routine_declaration(source: &str) -> Option<RoutineDeclaration> {
    let re = Regex::new(
        r#"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(FUNCTION|PROCEDURE)\s+((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)\s*(\(.*?\))?"#,
    )
    .unwrap();
    let captures = re.captures(source)?;
    let kind = parse_object_source_kind(captures.get(1)?.as_str())?;
    let name_parts = split_qualified_routine_name(captures.get(2)?.as_str());
    let name = name_parts.last()?.clone();
    let signature = captures.get(3).map(|value| value.as_str().trim().to_string()).unwrap_or_default();
    Some(RoutineDeclaration { kind, name, signature })
}

fn replace_sql_routine_declaration_name(source: &str, schema: Option<&str>, new_name: &str) -> Option<String> {
    let re = Regex::new(
        r#"(?is)^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:FUNCTION|PROCEDURE)\s+)((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)"#,
    )
    .unwrap();
    let captures = re.captures(source)?;
    let full = captures.get(0)?;
    let prefix = captures.get(1)?.as_str();
    let existing_name = captures.get(2)?.as_str();
    let existing_parts = split_qualified_routine_name(existing_name);
    let schema_name =
        schema.or_else(|| existing_parts.first().filter(|_| existing_parts.len() > 1).map(String::as_str));
    let replacement = if let Some(schema_name) = schema_name {
        format!("{}.{}", quote_postgres_identifier(schema_name), quote_postgres_identifier(new_name))
    } else {
        quote_postgres_identifier(new_name)
    };
    Some(format!("{}{}{}{}", &source[..full.start()], prefix, replacement, &source[full.end()..]))
}

fn mysql_routine_declaration(source: &str) -> Option<RoutineDeclaration> {
    let re = Regex::new(
        r"(?is)^\s*CREATE\s+(?:DEFINER\s*=\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s+)?(FUNCTION|PROCEDURE)\s+((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
    )
    .unwrap();
    let captures = re.captures(source)?;
    let kind = parse_object_source_kind(captures.get(1)?.as_str())?;
    let name_parts = split_mysql_qualified_routine_name(captures.get(2)?.as_str());
    let name = name_parts.last()?.clone();
    Some(RoutineDeclaration { kind, name, signature: String::new() })
}

fn replace_mysql_routine_declaration_name(source: &str, new_name: &str) -> Option<String> {
    let re = Regex::new(
        r"(?is)^(\s*CREATE\s+(?:DEFINER\s*=\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s+)?(?:FUNCTION|PROCEDURE)\s+)((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
    )
    .unwrap();
    let captures = re.captures(source)?;
    let full = captures.get(0)?;
    let prefix = captures.get(1)?.as_str();
    Some(format!("{}{}{}{}", &source[..full.start()], prefix, quote_mysql_identifier(new_name), &source[full.end()..]))
}

fn routine_name_changed(source_name: &str, saved_name: &str) -> bool {
    !source_name.eq_ignore_ascii_case(saved_name)
}

fn replace_sqlserver_create_with_create_or_alter(source: &str) -> String {
    Regex::new(r"(?i)^(?:CREATE\s+(?:OR\s+ALTER\s+)?|ALTER\s+)")
        .unwrap()
        .replace(source, "CREATE OR ALTER ")
        .to_string()
}

fn build_sqlserver_alter_view_sql(schema: Option<&str>, name: &str, source: &str) -> String {
    let existing_view_statement = Regex::new(r"(?i)^CREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+|^ALTER\s+VIEW\s+").unwrap();
    if existing_view_statement.is_match(source) {
        return ensure_semicolon(&existing_view_statement.replace(source, "ALTER VIEW "));
    }

    format!("ALTER VIEW {} AS\n{}", sqlserver_qualified_name(schema, name), ensure_semicolon(source))
}

fn parse_object_source_kind(value: &str) -> Option<ObjectSourceKind> {
    if value.eq_ignore_ascii_case("VIEW") {
        Some(ObjectSourceKind::View)
    } else if value.eq_ignore_ascii_case("MATERIALIZED VIEW") || value.eq_ignore_ascii_case("MATERIALIZED_VIEW") {
        Some(ObjectSourceKind::MaterializedView)
    } else if value.eq_ignore_ascii_case("PROCEDURE") {
        Some(ObjectSourceKind::Procedure)
    } else if value.eq_ignore_ascii_case("FUNCTION") {
        Some(ObjectSourceKind::Function)
    } else if value.eq_ignore_ascii_case("SEQUENCE") {
        Some(ObjectSourceKind::Sequence)
    } else if value.eq_ignore_ascii_case("PACKAGE") {
        Some(ObjectSourceKind::Package)
    } else if value.eq_ignore_ascii_case("PACKAGE BODY") || value.eq_ignore_ascii_case("PACKAGE_BODY") {
        Some(ObjectSourceKind::PackageBody)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(database_type: DatabaseType, object_type: ObjectSourceKind, source: &str) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type,
            object_type,
            schema: Some("public".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        }
    }

    #[test]
    fn sqlserver_edited_source_saves_as_create_or_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_alter_source_saves_as_create_or_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_view_save_rewrites_create_to_alter_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "new_view".to_string(),
            source: "CREATE VIEW dbo.new_view AS SELECT * FROM AppInfo".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "ALTER VIEW dbo.new_view AS SELECT * FROM AppInfo;");
    }

    #[test]
    fn sqlserver_view_save_rewrites_create_or_alter_to_alter_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "new_view".to_string(),
            source: "CREATE OR ALTER VIEW dbo.new_view AS SELECT * FROM AppInfo;".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "ALTER VIEW dbo.new_view AS SELECT * FROM AppInfo;");
    }

    #[test]
    fn sqlserver_view_body_saves_as_alter_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "new_view".to_string(),
            source: "SELECT\n  *\nFROM AppInfo".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "ALTER VIEW [dbo].[new_view] AS\nSELECT\n  *\nFROM AppInfo;");
    }

    #[test]
    fn postgres_view_body_opens_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
        );
    }

    #[test]
    fn postgres_compatible_view_body_opens_as_create_or_replace_view() {
        for database_type in [DatabaseType::OpenGauss, DatabaseType::Kwdb] {
            let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
                database_type,
                object_type: ObjectSourceKind::View,
                schema: Some("public".to_string()),
                name: "active users".to_string(),
                source: " SELECT id, name FROM users WHERE active ".to_string(),
            })
            .unwrap();
            assert_eq!(
                sql,
                "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
            );
        }
    }

    #[test]
    fn view_ddl_wraps_postgres_body_as_create_or_replace_view() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
        });

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
        );
    }

    #[test]
    fn view_ddl_keeps_existing_create_view_statement() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Mysql),
            schema: Some("reporting".to_string()),
            name: "active_users".to_string(),
            source: "CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`".to_string(),
        });

        assert_eq!(sql, "CREATE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`;");
    }

    #[test]
    fn view_ddl_uses_create_view_for_non_postgres_like_databases() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Mysql),
            schema: Some("reporting".to_string()),
            name: "active_users".to_string(),
            source: "SELECT id FROM users".to_string(),
        });

        assert_eq!(sql, "CREATE VIEW `reporting`.`active_users` AS\nSELECT id FROM users;");
    }

    #[test]
    fn oracle_package_source_saves_as_single_create_or_replace_statement() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::PackageBody,
            schema: Some("HR".to_string()),
            name: "PAYROLL".to_string(),
            source: "CREATE OR REPLACE PACKAGE BODY PAYROLL AS\nEND PAYROLL;".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE PACKAGE BODY PAYROLL AS\nEND PAYROLL;");
    }

    #[test]
    fn postgres_procedure_rename_adds_drop_cleanup() {
        let statements = build_executable_object_source_statements(input(
            DatabaseType::Postgres,
            ObjectSourceKind::Procedure,
            "CREATE OR REPLACE PROCEDURE \"public\".\"refresh_cache_v2\"(mode text)\nLANGUAGE SQL\nAS $$ SELECT 1 $$;",
        ))
        .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE OR REPLACE PROCEDURE \"public\".\"refresh_cache_v2\"(mode text)\nLANGUAGE SQL\nAS $$ SELECT 1 $$;",
                "DROP PROCEDURE IF EXISTS \"public\".\"refresh_cache\"(mode text);",
            ]
        );
    }

    #[test]
    fn mysql_routine_rename_adds_drop_cleanup() {
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source:
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache_v2`(IN mode_name varchar(20)) BEGIN SELECT 1; END"
                    .to_string(),
        })
        .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache_v2`(IN mode_name varchar(20)) BEGIN SELECT 1; END;",
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;",
            ]
        );
    }

    #[test]
    fn sqlserver_view_source_opened_for_editing_shows_alter_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "v_active_users".to_string(),
            source: "CREATE VIEW dbo.v_active_users AS SELECT id, name FROM users WHERE active = 1;".to_string(),
        });
        assert_eq!(sql, "ALTER VIEW dbo.v_active_users AS SELECT id, name FROM users WHERE active = 1;");
    }

    #[test]
    fn sqlserver_view_body_opened_for_editing_shows_alter_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::View,
            schema: Some("dbo".to_string()),
            name: "new_view".to_string(),
            source: "SELECT\n  *\nFROM AppInfo".to_string(),
        });
        assert_eq!(sql, "ALTER VIEW [dbo].[new_view] AS\nSELECT\n  *\nFROM AppInfo;");
    }

    #[test]
    fn sqlserver_procedure_source_opened_for_editing_shows_create_or_alter() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        });
        assert_eq!(sql, "CREATE OR ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn oracle_family_routine_rename_rewrites_source_and_drops_original() {
        let statements = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Dameng,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("SYSDBA".to_string()),
            name: "SP_TAB_BAKSET_REMOVE_BATCH".to_string(),
            new_name: "SP_TAB_BAKSET_REMOVE_BATCH_2".to_string(),
            source:
                "CREATE OR REPLACE PROCEDURE \"SYSDBA\".\"SP_TAB_BAKSET_REMOVE_BATCH\" AS\nBEGIN\n  SELECT 1;\nEND;"
                    .to_string(),
        })
        .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE OR REPLACE PROCEDURE \"SYSDBA\".\"SP_TAB_BAKSET_REMOVE_BATCH_2\" AS\nBEGIN\n  SELECT 1;\nEND;",
                "DROP PROCEDURE \"SYSDBA\".\"SP_TAB_BAKSET_REMOVE_BATCH\";",
            ]
        );
    }
}
