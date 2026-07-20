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
        // CREATE OR ALTER requires SQL Server 2016 SP1+, while ALTER keeps existing routines executable on older servers.
        return Ok(vec![replace_sqlserver_create_with_alter(source)]);
    }

    if input.database_type == DatabaseType::DuckDb && input.object_type == ObjectSourceKind::View {
        return Ok(vec![executable_duckdb_view_ddl(input.schema.as_deref(), &input.name, source)]);
    }

    if is_postgres_like(input.database_type) && input.object_type == ObjectSourceKind::View {
        if let Some(sql) = executable_postgres_view_ddl(source) {
            return Ok(vec![sql]);
        }
        if source_starts_with_alter(source) {
            // ALTER VIEW is already executable DDL, but it is not a view body.
            return Ok(vec![ensure_semicolon(source)]);
        }
        return Ok(vec![format!(
            "CREATE OR REPLACE VIEW {} AS\n{}",
            postgres_qualified_name(input.schema.as_deref(), &input.name),
            ensure_semicolon(source)
        )]);
    }

    if is_oracle_like(input.database_type) && input.object_type == ObjectSourceKind::View {
        return Ok(vec![executable_oracle_view_ddl(input.schema.as_deref(), &input.name, source)]);
    }

    if input.database_type == DatabaseType::Informix && input.object_type == ObjectSourceKind::View {
        return Ok(executable_informix_view_statements(input.schema.as_deref(), &input.name, source));
    }

    if is_mysql_like(input.database_type)
        && matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure)
    {
        return Ok(executable_mysql_routine_statements(&input, source));
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
/// `CREATE PROCEDURE` is rewritten to `ALTER` so the user doesn't see a
/// mismatched CREATE statement for an already-existing object. Callers that
/// only need the first statement should use this instead of calling
/// `build_executable_object_source_statements` and discarding rename-cleanup
/// statements.
pub fn build_editable_object_source(input: EditableObjectSourceSqlInput) -> String {
    let source = input.source.clone();
    if is_postgres_like(input.database_type)
        && input.object_type == ObjectSourceKind::View
        && source_starts_with_create_or_alter(&source)
    {
        // Some providers return full view DDL instead of a bare SELECT body.
        return ensure_semicolon(source.trim());
    }
    if input.database_type == DatabaseType::Informix && input.object_type == ObjectSourceKind::View {
        return editable_informix_view_ddl(input.schema.as_deref(), &input.name, &source);
    }
    if is_mysql_like(input.database_type)
        && matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure)
    {
        return ensure_semicolon(source.trim());
    }
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

pub fn build_export_object_source_sql(
    database_type: DatabaseType,
    object_type: ObjectSourceKind,
    source: &str,
) -> String {
    let source = source.trim();
    if source.is_empty() {
        return String::new();
    }
    if is_mysql_like(database_type) && matches!(object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        return mysql_delimited_routine_source(source);
    }
    ensure_semicolon(source)
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
        ObjectSourceKind::Trigger => "TRIGGER",
        ObjectSourceKind::Sequence => "SEQUENCE",
        ObjectSourceKind::Package => "PACKAGE",
        ObjectSourceKind::PackageBody => "PACKAGE BODY",
        ObjectSourceKind::Type => "TYPE",
        ObjectSourceKind::TypeBody => "TYPE BODY",
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

fn mysql_delimited_routine_source(source: &str) -> String {
    let trimmed = source.trim();
    if Regex::new(r"(?i)^\s*DELIMITER\b").unwrap().is_match(trimmed) {
        return trimmed.to_string();
    }
    let body = trimmed.trim_end_matches(';').trim_end();
    let delimiter = mysql_routine_script_delimiter(body);
    format!("DELIMITER {delimiter}\n{body}{delimiter}\nDELIMITER ;")
}

fn mysql_routine_script_delimiter(source: &str) -> &'static str {
    ["//", "$$", ";;", "__DBX_DELIMITER__"]
        .into_iter()
        .find(|delimiter| !source.contains(delimiter))
        .unwrap_or("__DBX_DELIMITER__")
}

fn source_starts_with_create_or_alter(source: &str) -> bool {
    let executable = &source[leading_sql_statement_start(source)..];
    Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(executable)
}

fn source_starts_with_alter(source: &str) -> bool {
    let executable = &source[leading_sql_statement_start(source)..];
    Regex::new(r"(?i)^ALTER\s+").unwrap().is_match(executable)
}

fn executable_postgres_view_ddl(source: &str) -> Option<String> {
    let trimmed = source.trim();
    let statement_start = leading_sql_statement_start(trimmed);
    let executable = &trimmed[statement_start..];
    if Regex::new(r"(?i)^CREATE\s+OR\s+REPLACE\s+").unwrap().is_match(executable) {
        return Some(ensure_semicolon(trimmed));
    }

    // Kingbase extends PostgreSQL's prefix with FORCE after the optional RECURSIVE modifier.
    let create_view =
        Regex::new(r"(?i)^CREATE\s+((?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?(?:FORCE\s+)?VIEW\s+)").unwrap();
    if create_view.is_match(executable) {
        let replaced = create_view.replace(executable, "CREATE OR REPLACE $1");
        return Some(ensure_semicolon(&format!("{}{}", &trimmed[..statement_start], replaced)));
    }

    None
}

fn leading_sql_statement_start(source: &str) -> usize {
    let mut index = 0;
    loop {
        index = skip_sql_whitespace(source, index);
        if let Some(end) = sql_line_comment_end(source, index) {
            index = end;
            continue;
        }
        if let Some(end) = sql_block_comment_end(source, index) {
            index = end;
            continue;
        }
        return index;
    }
}

fn executable_oracle_view_ddl(schema: Option<&str>, name: &str, source: &str) -> String {
    let trimmed = source.trim();
    if Regex::new(r"(?i)^CREATE\s+OR\s+REPLACE\s+").unwrap().is_match(trimmed) || source_starts_with_alter(trimmed) {
        return ensure_semicolon(trimmed);
    }

    let create_view = Regex::new(r"(?i)^CREATE\s+((?:(?:NO)?FORCE\s+)?(?:(?:NON)?EDITIONABLE\s+)?VIEW\s+)").unwrap();
    if create_view.is_match(trimmed) {
        let replaced = create_view.replace(trimmed, "CREATE OR REPLACE $1");
        return ensure_semicolon(replaced.as_ref());
    }

    format!("CREATE OR REPLACE VIEW {} AS\n{}", postgres_qualified_name(schema, name), ensure_semicolon(trimmed))
}

fn executable_informix_view_statements(schema: Option<&str>, name: &str, source: &str) -> Vec<String> {
    let (target_name, create_tail) = informix_view_definition(schema, name, source);
    if source_starts_with_alter(source.trim()) {
        return vec![ensure_semicolon(source.trim())];
    }

    let validation_name = informix_validation_view_name(&target_name);
    let mut statements = vec![
        drop_informix_view_if_exists(&validation_name),
        create_informix_view(&validation_name, &create_tail),
        drop_informix_view_if_exists(&validation_name),
    ];

    let original_name = informix_identifier(name);
    if !target_name.eq_ignore_ascii_case(&original_name) {
        statements.push(drop_informix_view_if_exists(&original_name));
    }
    statements.push(drop_informix_view_if_exists(&target_name));
    statements.push(create_informix_view(&target_name, &create_tail));
    statements
}

fn editable_informix_view_ddl(schema: Option<&str>, name: &str, source: &str) -> String {
    if source_starts_with_alter(source.trim()) {
        return ensure_semicolon(source.trim());
    }
    let (target_name, create_tail) = informix_view_definition(schema, name, source);
    create_informix_view(&target_name, &create_tail)
}

fn informix_view_definition(schema: Option<&str>, name: &str, source: &str) -> (String, String) {
    let trimmed = source.trim();
    let create_view = Regex::new(
        r#"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)"#,
    )
    .unwrap();
    if let Some(captures) = create_view.captures(trimmed) {
        let view_name = captures.get(1).unwrap();
        let target_name = strip_informix_owner_qualifiers(view_name.as_str(), schema);
        let body = strip_informix_owner_qualifiers(&trimmed[view_name.end()..], schema);
        (target_name.trim().to_string(), body)
    } else {
        let body = strip_informix_owner_qualifiers(trimmed, schema);
        (informix_identifier(name), format!(" AS\n{body}"))
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

fn informix_identifier(name: &str) -> String {
    if is_simple_informix_identifier(name) {
        name.to_string()
    } else {
        quote_postgres_identifier(name)
    }
}

fn create_informix_view(name: &str, create_tail: &str) -> String {
    ensure_semicolon(&format!("CREATE VIEW {}{}", name.trim(), create_tail))
}

fn drop_informix_view_if_exists(name: &str) -> String {
    format!("DROP VIEW IF EXISTS {};", name.trim())
}

fn executable_mysql_routine_statements(input: &EditableObjectSourceSqlInput, source: &str) -> Vec<String> {
    if !mysql_source_starts_with_create_routine(source) {
        return vec![ensure_semicolon(source)];
    }

    let declaration = mysql_routine_declaration(source).filter(|declaration| declaration.kind == input.object_type);
    let create_name = declaration.as_ref().map(|declaration| declaration.name.as_str()).unwrap_or(&input.name);
    let mut statements = Vec::with_capacity(3);

    // MySQL has no cross-version CREATE OR REPLACE for stored routines; DBeaver also
    // replaces them by dropping the target routine before executing the CREATE body.
    statements.push(mysql_drop_routine_if_exists(input.object_type.clone(), input.schema.as_deref(), create_name));
    statements.push(ensure_semicolon(source));

    if declaration.as_ref().is_some_and(|declaration| routine_name_changed(&declaration.name, &input.name)) {
        statements.push(mysql_drop_routine_if_exists(input.object_type.clone(), input.schema.as_deref(), &input.name));
    }

    statements
}

fn mysql_drop_routine_if_exists(object_type: ObjectSourceKind, schema: Option<&str>, name: &str) -> String {
    format!("DROP {} IF EXISTS {};", object_type_keyword(&object_type), mysql_qualified_name(schema, name))
}

fn mysql_source_starts_with_create_routine(source: &str) -> bool {
    Regex::new(r"(?is)^\s*CREATE\s+(?:DEFINER\s*=.+?\s+)?(?:FUNCTION|PROCEDURE)\b").unwrap().is_match(source)
}

fn informix_validation_view_name(target_name: &str) -> String {
    let mut hash = 0x811c9dc5u32;
    for byte in target_name.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("dbx_view_check_{hash:08x}")
}

fn strip_informix_owner_qualifiers(source: &str, schema: Option<&str>) -> String {
    let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) else {
        return source.to_string();
    };

    let mut result = String::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if let Some(end) = sql_single_quoted_literal_end(source, index) {
            result.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if let Some(end) = sql_line_comment_end(source, index) {
            result.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if let Some(end) = sql_block_comment_end(source, index) {
            result.push_str(&source[index..end]);
            index = end;
            continue;
        }
        if let Some((end, replacement)) = informix_owner_qualifier_replacement(source, index, schema) {
            result.push_str(replacement);
            index = end;
            continue;
        }
        let ch = source[index..].chars().next().unwrap();
        result.push(ch);
        index += ch.len_utf8();
    }
    result
}

fn informix_owner_qualifier_replacement<'a>(source: &'a str, start: usize, schema: &str) -> Option<(usize, &'a str)> {
    if let Some((owner_end, owner)) = read_quoted_sql_identifier(source, start) {
        if owner.eq_ignore_ascii_case(schema) {
            let dot = skip_sql_whitespace(source, owner_end);
            if source[dot..].starts_with('.') {
                let ident_start = skip_sql_whitespace(source, dot + 1);
                if let Some((ident_end, ident_text)) = read_informix_identifier_text(source, ident_start) {
                    return Some((ident_end, ident_text));
                }
            }
        }
    }

    if !is_simple_informix_identifier(schema) || !starts_with_ignore_ascii_case_at(source, start, schema) {
        return None;
    }
    if source[..start].chars().next_back().is_some_and(is_informix_identifier_part) {
        return None;
    }
    let owner_end = start + schema.len();
    if source[owner_end..].chars().next().is_some_and(is_informix_identifier_part) {
        return None;
    }
    let dot = skip_sql_whitespace(source, owner_end);
    if !source[dot..].starts_with('.') {
        return None;
    }
    let ident_start = skip_sql_whitespace(source, dot + 1);
    read_informix_identifier_text(source, ident_start)
}

fn sql_single_quoted_literal_end(source: &str, start: usize) -> Option<usize> {
    if !source[start..].starts_with('\'') {
        return None;
    }
    let mut index = start + 1;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        index += ch.len_utf8();
        if ch == '\'' {
            if source[index..].starts_with('\'') {
                index += 1;
            } else {
                return Some(index);
            }
        }
    }
    Some(source.len())
}

fn sql_line_comment_end(source: &str, start: usize) -> Option<usize> {
    if !source[start..].starts_with("--") {
        return None;
    }
    let rest = &source[start..];
    Some(start + rest.find('\n').map(|index| index + 1).unwrap_or(rest.len()))
}

fn sql_block_comment_end(source: &str, start: usize) -> Option<usize> {
    if !source[start..].starts_with("/*") {
        return None;
    }

    // PostgreSQL and Kingbase default to nested SQL block comments, so match the outer terminator.
    let mut depth = 1;
    let mut index = start + 2;
    while index < source.len() {
        if source[index..].starts_with("/*") {
            depth += 1;
            index += 2;
        } else if source[index..].starts_with("*/") {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return Some(index);
            }
        } else {
            index += source[index..].chars().next().unwrap().len_utf8();
        }
    }

    // Preserve the existing safe behavior: an unclosed leading comment consumes the remaining source.
    Some(source.len())
}

fn read_quoted_sql_identifier(source: &str, start: usize) -> Option<(usize, String)> {
    if !source[start..].starts_with('"') {
        return None;
    }
    let mut value = String::new();
    let mut index = start + 1;
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        index += ch.len_utf8();
        if ch == '"' {
            if source[index..].starts_with('"') {
                value.push('"');
                index += 1;
            } else {
                return Some((index, value));
            }
        } else {
            value.push(ch);
        }
    }
    None
}

fn read_informix_identifier_text(source: &str, start: usize) -> Option<(usize, &str)> {
    if let Some((end, _)) = read_quoted_sql_identifier(source, start) {
        return Some((end, &source[start..end]));
    }
    let first = source[start..].chars().next()?;
    if !is_informix_identifier_start(first) {
        return None;
    }
    let mut end = start + first.len_utf8();
    while end < source.len() {
        let ch = source[end..].chars().next().unwrap();
        if !is_informix_identifier_part(ch) {
            break;
        }
        end += ch.len_utf8();
    }
    Some((end, &source[start..end]))
}

fn skip_sql_whitespace(source: &str, mut index: usize) -> usize {
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn starts_with_ignore_ascii_case_at(source: &str, start: usize, needle: &str) -> bool {
    source.get(start..start + needle.len()).is_some_and(|value| value.eq_ignore_ascii_case(needle))
}

fn is_informix_identifier_start(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphabetic()
}

fn is_informix_identifier_part(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()
}

fn is_simple_informix_identifier(name: &str) -> bool {
    Regex::new(r"^[A-Za-z_][A-Za-z0-9_$]*$").unwrap().is_match(name)
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
        r"(?is)^\s*CREATE\s+(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
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
        r"(?is)^(\s*CREATE\s+(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(?:FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?)((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
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

fn replace_sqlserver_create_with_alter(source: &str) -> String {
    Regex::new(r"(?i)^(?:CREATE\s+(?:OR\s+ALTER\s+)?|ALTER\s+)").unwrap().replace(source, "ALTER ").to_string()
}

fn build_sqlserver_alter_view_sql(schema: Option<&str>, name: &str, source: &str) -> String {
    let existing_view_statement = Regex::new(r"(?i)^CREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+|^ALTER\s+VIEW\s+").unwrap();
    if existing_view_statement.is_match(source) {
        return ensure_semicolon(&existing_view_statement.replace(source, "ALTER VIEW "));
    }

    format!("ALTER VIEW {} AS\n{}", sqlserver_qualified_name(schema, name), ensure_semicolon(source))
}

fn executable_duckdb_view_ddl(schema: Option<&str>, name: &str, source: &str) -> String {
    let existing_view_statement =
        Regex::new(r"(?i)^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW(?:\s+IF\s+NOT\s+EXISTS)?\s+").unwrap();
    if existing_view_statement.is_match(source) {
        return ensure_semicolon(&existing_view_statement.replace(source, "CREATE OR REPLACE VIEW "));
    }

    format!("CREATE OR REPLACE VIEW {} AS\n{}", postgres_qualified_name(schema, name), ensure_semicolon(source))
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
    } else if value.eq_ignore_ascii_case("TRIGGER") {
        Some(ObjectSourceKind::Trigger)
    } else if value.eq_ignore_ascii_case("SEQUENCE") {
        Some(ObjectSourceKind::Sequence)
    } else if value.eq_ignore_ascii_case("PACKAGE") {
        Some(ObjectSourceKind::Package)
    } else if value.eq_ignore_ascii_case("PACKAGE BODY") || value.eq_ignore_ascii_case("PACKAGE_BODY") {
        Some(ObjectSourceKind::PackageBody)
    } else if value.eq_ignore_ascii_case("TYPE") {
        Some(ObjectSourceKind::Type)
    } else if value.eq_ignore_ascii_case("TYPE BODY") || value.eq_ignore_ascii_case("TYPE_BODY") {
        Some(ObjectSourceKind::TypeBody)
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

    fn informix_view_statements(name: &str, source: &str) -> Vec<String> {
        build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Informix,
            object_type: ObjectSourceKind::View,
            schema: Some("gbasedbt".to_string()),
            name: name.to_string(),
            source: source.to_string(),
        })
        .unwrap()
    }

    fn expected_informix_view_replace_statements(
        original_name: &str,
        target_name: &str,
        create_tail: &str,
    ) -> Vec<String> {
        let validation_name = informix_validation_view_name(target_name);
        let mut statements = vec![
            drop_informix_view_if_exists(&validation_name),
            create_informix_view(&validation_name, create_tail),
            drop_informix_view_if_exists(&validation_name),
        ];
        if !target_name.eq_ignore_ascii_case(original_name) {
            statements.push(drop_informix_view_if_exists(original_name));
        }
        statements.push(drop_informix_view_if_exists(target_name));
        statements.push(create_informix_view(target_name, create_tail));
        statements
    }

    #[test]
    fn sqlserver_edited_source_saves_as_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_alter_source_saves_as_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
    }

    #[test]
    fn sqlserver_create_function_source_saves_as_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Function,
            schema: Some("dbo".to_string()),
            name: "fn_demo".to_string(),
            source: "CREATE FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "ALTER FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;");
    }

    #[test]
    fn sqlserver_create_or_alter_function_source_saves_as_alter() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Function,
            schema: Some("dbo".to_string()),
            name: "fn_demo".to_string(),
            source: "CREATE OR ALTER FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;".to_string(),
        })
        .unwrap();
        assert_eq!(sql, "ALTER FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;");
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
    fn duckdb_view_create_source_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::DuckDb,
            object_type: ObjectSourceKind::View,
            schema: Some("main".to_string()),
            name: "active_orders".to_string(),
            source: "CREATE VIEW active_orders AS SELECT id FROM orders WHERE active".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE VIEW active_orders AS SELECT id FROM orders WHERE active;");
    }

    #[test]
    fn duckdb_view_body_saves_as_qualified_create_or_replace_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::DuckDb,
            object_type: ObjectSourceKind::View,
            schema: Some("reporting".to_string()),
            name: "active orders".to_string(),
            source: "SELECT id FROM orders WHERE active".to_string(),
        });

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"reporting\".\"active orders\" AS\nSELECT id FROM orders WHERE active;"
        );
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
    fn postgres_view_create_source_opens_without_rewrapping_or_reformatting() {
        let source = "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true";
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: source.to_string(),
        });

        assert_eq!(sql, format!("{source};"));
    }

    #[test]
    fn postgres_view_create_source_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: "CREATE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true".to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true;"
        );
    }

    #[test]
    fn postgres_view_create_or_replace_source_saves_without_rewrapping() {
        let source = "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, format!("{source};"));
    }

    #[test]
    fn kingbase_view_body_opens_as_create_or_replace_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("dbx_issue3895_repro".to_string()),
            name: "edited_view".to_string(),
            source: "SELECT id, label FROM source_rows WHERE id >= 1".to_string(),
        });

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"dbx_issue3895_repro\".\"edited_view\" AS\nSELECT id, label FROM source_rows WHERE id >= 1;"
        );
    }

    #[test]
    fn kingbase_view_create_source_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("dbx_issue3895_repro".to_string()),
            name: "edited_view".to_string(),
            source: "CREATE VIEW dbx_issue3895_repro.edited_view AS SELECT id, label FROM source_rows".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE VIEW dbx_issue3895_repro.edited_view AS SELECT id, label FROM source_rows;");
    }

    #[test]
    fn kingbase_view_create_force_source_saves_as_create_or_replace_force_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "CREATE FORCE VIEW app.edited_view AS SELECT id FROM source_rows".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE FORCE VIEW app.edited_view AS SELECT id FROM source_rows;");
    }

    #[test]
    fn kingbase_view_create_recursive_force_source_preserves_modifier_order() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "CREATE RECURSIVE FORCE VIEW app.edited_view AS SELECT id FROM source_rows".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE RECURSIVE FORCE VIEW app.edited_view AS SELECT id FROM source_rows;");
    }

    #[test]
    fn kingbase_view_create_temporary_recursive_force_source_preserves_legal_modifiers() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "CREATE TEMPORARY RECURSIVE FORCE VIEW app.edited_view AS SELECT id FROM source_rows".to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "CREATE OR REPLACE TEMPORARY RECURSIVE FORCE VIEW app.edited_view AS SELECT id FROM source_rows;"
        );
    }

    #[test]
    fn kingbase_view_create_or_replace_force_source_saves_without_rewrapping() {
        let source = "CREATE OR REPLACE FORCE VIEW app.edited_view AS SELECT id FROM source_rows";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, format!("{source};"));
    }

    #[test]
    fn kingbase_view_create_source_preserves_leading_line_comment() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "-- keep this note\nCREATE VIEW app.edited_view AS SELECT id FROM source_rows".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "-- keep this note\nCREATE OR REPLACE VIEW app.edited_view AS SELECT id FROM source_rows;");
    }

    #[test]
    fn kingbase_view_create_source_preserves_leading_block_comment() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "/* CREATE VIEW in this comment is ignored */\nCREATE VIEW app.edited_view AS SELECT id FROM source_rows"
                .to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "/* CREATE VIEW in this comment is ignored */\nCREATE OR REPLACE VIEW app.edited_view AS SELECT id FROM source_rows;"
        );
    }

    #[test]
    fn kingbase_view_create_source_preserves_leading_nested_block_comment() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: "/* outer /* nested */ comment */\nCREATE FORCE VIEW app.edited_view AS SELECT id FROM source_rows"
                .to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "/* outer /* nested */ comment */\nCREATE OR REPLACE FORCE VIEW app.edited_view AS SELECT id FROM source_rows;"
        );
    }

    #[test]
    fn kingbase_view_create_source_preserves_leading_multi_level_block_comment() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source:
                "/* level 1 /* level 2 /* level 3 */ level 2 */ level 1 */\nCREATE VIEW app.edited_view AS SELECT id FROM source_rows"
                    .to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "/* level 1 /* level 2 /* level 3 */ level 2 */ level 1 */\nCREATE OR REPLACE VIEW app.edited_view AS SELECT id FROM source_rows;"
        );
    }

    #[test]
    fn kingbase_view_unclosed_leading_block_comment_keeps_safe_body_fallback() {
        let source = "/* unclosed comment\nCREATE FORCE VIEW app.edited_view AS SELECT id FROM source_rows";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Kingbase,
            object_type: ObjectSourceKind::View,
            schema: Some("app".to_string()),
            name: "edited_view".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, format!("CREATE OR REPLACE VIEW \"app\".\"edited_view\" AS\n{source};"));
    }

    #[test]
    fn postgres_view_alter_source_saves_without_body_wrapping() {
        let source = "ALTER VIEW public.active_users SET (security_barrier = true)";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, format!("{source};"));
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
    fn oracle_view_body_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::View,
            schema: Some("DBX_TEST".to_string()),
            name: "V_ACTIVE_USERS".to_string(),
            source: "SELECT id, name FROM users WHERE active = 1".to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"DBX_TEST\".\"V_ACTIVE_USERS\" AS\nSELECT id, name FROM users WHERE active = 1;"
        );
    }

    #[test]
    fn oracle_view_create_source_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::View,
            schema: Some("DBX_TEST".to_string()),
            name: "V_ACTIVE_USERS".to_string(),
            source: "CREATE FORCE EDITIONABLE VIEW DBX_TEST.V_ACTIVE_USERS AS SELECT id FROM users".to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE OR REPLACE FORCE EDITIONABLE VIEW DBX_TEST.V_ACTIVE_USERS AS SELECT id FROM users;");
    }

    #[test]
    fn oracle_view_source_opened_for_editing_shows_create_or_replace_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::View,
            schema: Some("DBX_TEST".to_string()),
            name: "V_ACTIVE_USERS".to_string(),
            source: "SELECT id, name FROM users WHERE active = 1".to_string(),
        });

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"DBX_TEST\".\"V_ACTIVE_USERS\" AS\nSELECT id, name FROM users WHERE active = 1;"
        );
    }

    #[test]
    fn informix_view_body_saves_with_validate_drop_create() {
        let statements = informix_view_statements("demo_view", "SELECT id, name FROM users");

        assert_eq!(
            statements,
            expected_informix_view_replace_statements("demo_view", "demo_view", " AS\nSELECT id, name FROM users")
        );
    }

    #[test]
    fn informix_view_create_source_strips_owner_qualifier_before_save() {
        let statements =
            informix_view_statements("demo_view", "create view \"gbasedbt\".demo_view (id) as select id from users");

        assert_eq!(
            statements,
            expected_informix_view_replace_statements("demo_view", "demo_view", " (id) as select id from users")
        );
    }

    #[test]
    fn informix_view_create_source_preserves_sql_target_name() {
        let statements = informix_view_statements("new_view", "create view codex_created_view as select id from users");

        assert_eq!(
            statements,
            expected_informix_view_replace_statements("new_view", "codex_created_view", " as select id from users")
        );
    }

    #[test]
    fn informix_view_create_source_strips_same_owner_table_references() {
        let statements = informix_view_statements(
            "dba_db_links",
            "create view \"gbasedbt\".dba_db_links as select x0.db_link from \"gbasedbt\".user_db_links x0",
        );

        assert_eq!(
            statements,
            expected_informix_view_replace_statements(
                "dba_db_links",
                "dba_db_links",
                " as select x0.db_link from user_db_links x0",
            )
        );
    }

    #[test]
    fn informix_view_body_strips_same_owner_table_references() {
        let statements = informix_view_statements("demo_view", "SELECT id FROM gbasedbt.users");

        assert_eq!(
            statements,
            expected_informix_view_replace_statements("demo_view", "demo_view", " AS\nSELECT id FROM users")
        );
    }

    #[test]
    fn informix_owner_qualifier_rewrite_skips_strings_and_comments() {
        let statements = informix_view_statements(
            "demo_view",
            "SELECT 'gbasedbt.users' AS literal, id FROM gbasedbt.users -- gbasedbt.audit\n/* gbasedbt.logs */",
        );

        assert_eq!(
            statements,
            expected_informix_view_replace_statements(
                "demo_view",
                "demo_view",
                " AS\nSELECT 'gbasedbt.users' AS literal, id FROM users -- gbasedbt.audit\n/* gbasedbt.logs */",
            )
        );
    }

    #[test]
    fn informix_view_source_opened_for_editing_shows_unqualified_create_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Informix,
            object_type: ObjectSourceKind::View,
            schema: Some("gbasedbt".to_string()),
            name: "demo_view".to_string(),
            source: "create view \"gbasedbt\".demo_view as select id from users".to_string(),
        });

        assert_eq!(sql, "CREATE VIEW demo_view as select id from users;");
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
    fn parses_programmable_metadata_object_kinds() {
        assert_eq!(parse_object_source_kind("TRIGGER"), Some(ObjectSourceKind::Trigger));
        assert_eq!(parse_object_source_kind("TYPE"), Some(ObjectSourceKind::Type));
        assert_eq!(parse_object_source_kind("TYPE_BODY"), Some(ObjectSourceKind::TypeBody));
        assert_eq!(parse_object_source_kind("PACKAGE BODY"), Some(ObjectSourceKind::PackageBody));
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
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache_v2`;",
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache_v2`(IN mode_name varchar(20)) BEGIN SELECT 1; END;",
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;",
            ]
        );
    }

    #[test]
    fn mysql_procedure_save_replaces_existing_routine() {
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source: "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END".to_string(),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;",
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END;",
            ]
        );
    }

    #[test]
    fn mysql_function_save_replaces_existing_routine() {
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Function,
            schema: Some("app".to_string()),
            name: "active_count".to_string(),
            source: "CREATE DEFINER=CURRENT_USER FUNCTION `active_count`() RETURNS INT RETURN 1".to_string(),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "DROP FUNCTION IF EXISTS `app`.`active_count`;",
                "CREATE DEFINER=CURRENT_USER FUNCTION `active_count`() RETURNS INT RETURN 1;",
            ]
        );
    }

    #[test]
    fn mysql_alter_routine_source_saves_without_dropping() {
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source: "ALTER PROCEDURE `refresh_cache` COMMENT 'refreshes cache'".to_string(),
        })
        .unwrap();

        assert_eq!(statements, vec!["ALTER PROCEDURE `refresh_cache` COMMENT 'refreshes cache';"]);
    }

    #[test]
    fn mysql_routine_source_opened_for_editing_keeps_create_statement() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source: "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END".to_string(),
        });

        assert_eq!(sql, "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END;");
    }

    #[test]
    fn mysql_routine_export_uses_delimiter_script() {
        let sql = build_export_object_source_sql(
            DatabaseType::Mysql,
            ObjectSourceKind::Procedure,
            "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`()\nBEGIN\n  SELECT 1;\nEND",
        );

        assert_eq!(
            sql,
            "DELIMITER //\nCREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`()\nBEGIN\n  SELECT 1;\nEND//\nDELIMITER ;"
        );
    }

    #[test]
    fn mysql_routine_export_does_not_double_wrap_delimiter_script() {
        let source = "DELIMITER //\nCREATE PROCEDURE `refresh_cache`()\nBEGIN\n  SELECT 1;\nEND//\nDELIMITER ;";

        let sql = build_export_object_source_sql(DatabaseType::Mysql, ObjectSourceKind::Procedure, source);

        assert_eq!(sql, source);
    }

    #[test]
    fn mysql_view_export_keeps_regular_statement_terminator() {
        let sql = build_export_object_source_sql(
            DatabaseType::Mysql,
            ObjectSourceKind::View,
            "CREATE VIEW `active_users` AS SELECT `id` FROM `users`",
        );

        assert_eq!(sql, "CREATE VIEW `active_users` AS SELECT `id` FROM `users`;");
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
    fn sqlserver_procedure_source_opened_for_editing_shows_alter() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;".to_string(),
        });
        assert_eq!(sql, "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
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
