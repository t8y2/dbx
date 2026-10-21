use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlparser::dialect::OracleDialect;
use sqlparser::keywords::Keyword;
use sqlparser::tokenizer::{Token, Tokenizer, Whitespace};

use crate::models::connection::DatabaseType;
use crate::sql::split_sql_statements_for_database;
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
pub struct OracleObjectSourceValidationInput {
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
pub struct OracleRoutineReferenceRewriteInput {
    pub database_type: DatabaseType,
    pub caller_type: ObjectSourceKind,
    pub target_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub old_name: String,
    pub new_name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTableReferenceRewriteInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub old_name: String,
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
    /// Driver-reported identifier quote (e.g. `` ` `` for Kingbase MySQL
    /// compatibility mode). When set, overrides the database_type-based quote
    /// selection so hyphenated schemas render as valid identifiers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
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
        && (is_mysql_like(database_type)
            || is_postgres_like(database_type)
            || is_oracle_like(database_type)
            || database_type == DatabaseType::OceanbaseOracle)
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
    if input.database_type == DatabaseType::Oracle || input.database_type == DatabaseType::OceanbaseOracle {
        validate_oracle_object_source(
            input.database_type,
            &input.object_type,
            input.schema.as_deref(),
            &input.name,
            source,
        )?;
    }
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

    if is_oracle_like(input.database_type) || input.database_type == DatabaseType::OceanbaseOracle {
        let renamed_source = rewrite_oracle_routine_self_references(
            &renamed_source,
            &input.name,
            &input.new_name,
            input.schema.as_deref(),
            input.object_type.clone(),
        )?;
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

pub fn rewrite_oracle_routine_references(input: OracleRoutineReferenceRewriteInput) -> Result<String, String> {
    if !(is_oracle_like(input.database_type) || input.database_type == DatabaseType::OceanbaseOracle)
        || !matches!(
            input.caller_type,
            ObjectSourceKind::View | ObjectSourceKind::Procedure | ObjectSourceKind::Function
        )
    {
        return Err("Static routine reference rewriting is supported only for Oracle-family views and routines.".into());
    }
    if input.old_name == input.new_name {
        return Ok(input.source);
    }
    let tokens = Tokenizer::new(&OracleDialect {}, &input.source)
        .tokenize_with_location()
        .map_err(|error| format!("Cannot safely tokenize the dependent source: {error}"))?;
    let significant = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
        .collect::<Vec<_>>();
    if matches!(input.caller_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        if let Some(execute_index) =
            find_oracle_execute_immediate(significant.iter().copied().map(|index| (index, &tokens[index].token)))
        {
            let location = tokens[execute_index].span.start;
            return Err(format!(
                "Dynamic SQL must be rewritten as a verifiable static call at line {}, column {}.",
                location.line, location.column
            ));
        }
    }
    if significant.windows(2).any(|pair| {
        (token_word_is(&tokens[pair[0]].token, "FUNCTION") || token_word_is(&tokens[pair[0]].token, "PROCEDURE"))
            && (token_matches_identifier(&tokens[pair[1]].token, &input.old_name)
                || token_matches_identifier(&tokens[pair[1]].token, &input.new_name))
    }) {
        return Err(format!(
            "A local routine named {} or {} may shadow the dependent reference.",
            input.old_name, input.new_name
        ));
    }
    let mut local_bindings = Vec::new();
    if matches!(input.caller_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        for body_start in 0..significant.len() {
            if !token_word_is(&tokens[significant[body_start]].token, "AS")
                && !token_word_is(&tokens[significant[body_start]].token, "IS")
            {
                continue;
            }
            if let Some(body_end) = (body_start + 1..significant.len())
                .find(|position| token_word_is(&tokens[significant[*position]].token, "BEGIN"))
            {
                local_bindings.extend(significant[body_start + 1..body_end].iter().map(|index| &tokens[*index].token));
            }

            // Formal parameters are declared before AS/IS and can shadow the
            // dependent name just like declarations in the block body.
            if let Some(close) =
                (0..body_start).rev().find(|position| tokens[significant[*position]].token == Token::RParen)
            {
                let mut nesting = 0usize;
                let mut open = None;
                for position in (0..=close).rev() {
                    match tokens[significant[position]].token {
                        Token::RParen => nesting += 1,
                        Token::LParen => {
                            nesting -= 1;
                            if nesting == 0 {
                                open = Some(position);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(open) = open {
                    local_bindings.extend(significant[open + 1..close].iter().map(|index| &tokens[*index].token));
                }
            }
        }

        // Nested anonymous blocks can declare a collection or record after
        // the outer BEGIN. Reject a possibly shadowed rewrite there too.
        for declaration in 0..significant.len() {
            if !token_word_is(&tokens[significant[declaration]].token, "DECLARE") {
                continue;
            }
            if let Some(block_start) = (declaration + 1..significant.len())
                .find(|position| token_word_is(&tokens[significant[*position]].token, "BEGIN"))
            {
                local_bindings
                    .extend(significant[declaration + 1..block_start].iter().map(|index| &tokens[*index].token));
            }
        }
    }
    let mut edits = Vec::new();
    for (position, token_index) in significant.iter().copied().enumerate() {
        let token = &tokens[token_index];
        if !token_matches_identifier(&token.token, &input.old_name) {
            continue;
        }
        let previous = position.checked_sub(1).map(|index| &tokens[significant[index]].token);
        let previous_previous = position.checked_sub(2).map(|index| &tokens[significant[index]].token);
        if previous == Some(&Token::Period) {
            let Some(Token::Word(owner)) = previous_previous else {
                return Err(format!("Cannot determine which routine reference to rename: {}.", input.old_name));
            };
            if !input.schema.as_deref().is_some_and(|schema| identifier_matches(owner, schema)) {
                continue;
            }
            if local_bindings
                .iter()
                .any(|binding| token_matches_identifier(binding, input.schema.as_deref().unwrap_or_default()))
            {
                return Err(format!(
                    "The schema qualifier may be shadowed by a local declaration while rewriting {}.",
                    input.old_name
                ));
            }
        } else if local_bindings.iter().any(|binding| {
            token_matches_identifier(binding, &input.old_name) || token_matches_identifier(binding, &input.new_name)
        }) {
            return Err(format!(
                "A local declaration may shadow the {} or {} reference.",
                input.old_name, input.new_name
            ));
        }
        let next = significant.get(position + 1).map(|index| &tokens[*index].token);
        let routine_caller = matches!(input.caller_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function);
        let parenthesized_call = (input.target_type == ObjectSourceKind::Function
            || (input.target_type == ObjectSourceKind::Procedure && routine_caller))
            && matches!(next, Some(Token::LParen));
        let procedure_call = input.target_type == ObjectSourceKind::Procedure
            && matches!(input.caller_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function)
            && matches!(next, Some(Token::SemiColon));
        if parenthesized_call || procedure_call {
            edits.push((token.span, quote_postgres_identifier(&input.new_name)));
        } else if matches!(next, Some(Token::Period)) {
            return Err(format!("The dependent reference {} is qualified in an unsupported form.", input.old_name));
        }
    }
    if edits.is_empty() {
        return Err(format!("The dependent source does not contain a verifiable static call to {}.", input.old_name));
    }
    let mut result = input.source;
    for (span, replacement) in edits.into_iter().rev() {
        let start = routine_location_to_byte_offset(&result, span.start)
            .ok_or_else(|| "Cannot map routine token positions to the dependent source text.".to_string())?;
        let end = routine_location_to_byte_offset(&result, span.end)
            .ok_or_else(|| "Cannot map routine token positions to the dependent source text.".to_string())?;
        if start >= end || end > result.len() {
            return Err("Routine token positions overlap or exceed the dependent source text.".into());
        }
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

pub fn rewrite_oracle_table_references(input: OracleTableReferenceRewriteInput) -> Result<String, String> {
    if !(is_oracle_like(input.database_type) || input.database_type == DatabaseType::OceanbaseOracle)
        || !matches!(
            input.object_type,
            ObjectSourceKind::Procedure | ObjectSourceKind::Function | ObjectSourceKind::Trigger
        )
    {
        return Err(
            "Static table reference rewriting supports only Oracle-family procedures, functions, and triggers.".into(),
        );
    }
    let tokens = Tokenizer::new(&OracleDialect {}, &input.source)
        .tokenize_with_location()
        .map_err(|error| format!("Cannot safely tokenize the dependent source: {error}"))?;
    let significant = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
        .collect::<Vec<_>>();
    if let Some(execute_index) =
        find_oracle_execute_immediate(significant.iter().copied().map(|index| (index, &tokens[index].token)))
    {
        let location = tokens[execute_index].span.start;
        return Err(format!(
            "Dynamic SQL is outside the supported table-reference subset at line {}, column {}.",
            location.line, location.column
        ));
    }

    let mut edits = Vec::new();
    for (position, token_index) in significant.iter().copied().enumerate() {
        let token = &tokens[token_index];
        if !token_matches_identifier(&token.token, &input.old_name) {
            continue;
        }
        let previous = position.checked_sub(1).map(|index| &tokens[significant[index]].token);
        let previous_previous = position.checked_sub(2).map(|index| &tokens[significant[index]].token);
        let next = significant.get(position + 1).map(|index| &tokens[*index].token);
        let next_next = significant.get(position + 2).map(|index| &tokens[*index].token);

        let owner_qualified = previous == Some(&Token::Period);
        if owner_qualified {
            let Some(Token::Word(owner)) = previous_previous else {
                return Err(format!("Cannot determine which table reference to rename: {}.", input.old_name));
            };
            if !input.schema.as_deref().is_some_and(|schema| identifier_matches(owner, schema)) {
                continue;
            }
            if position >= 3 && matches!(tokens[significant[position - 3]].token, Token::Period) {
                return Err(format!("Three-part table reference {} is outside the supported subset.", input.old_name));
            }
        }
        let context_position = if owner_qualified { position - 2 } else { position };
        let context_previous = context_position.checked_sub(1).map(|index| &tokens[significant[index]].token);
        let context_previous_previous = context_position.checked_sub(2).map(|index| &tokens[significant[index]].token);

        let type_reference = next == Some(&Token::Period)
            && next_next.is_some_and(|column| matches!(column, Token::Word(_)))
            && significant
                .get(position + 3)
                .is_some_and(|index| matches!(tokens[*index].token, Token::Mod | Token::Char('%')))
            && significant.get(position + 4).is_some_and(|index| token_word_is(&tokens[*index].token, "TYPE"));
        let rowtype_reference = next.is_some_and(|value| matches!(value, Token::Mod | Token::Char('%')))
            && next_next.is_some_and(|value| token_word_is(value, "ROWTYPE"));
        let relation_reference = context_previous.is_some_and(|value| {
            token_word_is(value, "FROM")
                || token_word_is(value, "UPDATE")
                || (input.object_type == ObjectSourceKind::Trigger && token_word_is(value, "ON"))
        }) || (context_previous.is_some_and(|value| token_word_is(value, "INTO"))
            && context_previous_previous
                .is_some_and(|value| token_word_is(value, "INSERT") || token_word_is(value, "MERGE")));

        if relation_reference && context_previous.is_some_and(|value| token_word_is(value, "FROM")) {
            let multiple_relations = significant
                .iter()
                .skip(position + 1)
                .map(|index| &tokens[*index].token)
                .take_while(|candidate| {
                    ![
                        "WHERE",
                        "GROUP",
                        "ORDER",
                        "HAVING",
                        "CONNECT",
                        "START",
                        "UNION",
                        "MINUS",
                        "INTERSECT",
                        "FETCH",
                        "FOR",
                    ]
                    .iter()
                    .any(|clause| token_word_is(candidate, clause))
                        && !matches!(candidate, Token::SemiColon)
                })
                .any(|candidate| matches!(candidate, Token::Comma) || token_word_is(candidate, "JOIN"));
            if multiple_relations {
                return Err(format!(
                    "Multiple relations in one FROM clause are outside the supported subset at line {}, column {}.",
                    token.span.start.line, token.span.start.column
                ));
            }
        }

        if !(type_reference || rowtype_reference || relation_reference) {
            return Err(format!(
                "Cannot safely identify the table reference at line {}, column {}.",
                token.span.start.line, token.span.start.column
            ));
        }
        edits.push((token.span, quote_postgres_identifier(&input.new_name)));
    }
    if edits.is_empty() {
        return Err(format!("The dependent source has no verifiable static reference to table {}.", input.old_name));
    }
    let mut result = input.source;
    for (span, replacement) in edits.into_iter().rev() {
        let start = routine_location_to_byte_offset(&result, span.start)
            .ok_or_else(|| "Cannot map table-reference token positions to the dependent source text.".to_string())?;
        let end = routine_location_to_byte_offset(&result, span.end)
            .ok_or_else(|| "Cannot map table-reference token positions to the dependent source text.".to_string())?;
        if start >= end || end > result.len() {
            return Err("Table-reference token positions overlap or exceed the dependent source text.".into());
        }
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

pub fn build_executable_object_source_statements(input: EditableObjectSourceSqlInput) -> Result<Vec<String>, String> {
    build_executable_object_source_statements_with_mysql_validation_name(input, None, true)
}

/// Builds executable MySQL routine replacement statements using a caller-owned
/// validation name. Transfer callers pass a per-run name and preflight its
/// absence, so validation never drops an unrelated user routine.
pub fn build_mysql_routine_replacement_statements(
    input: EditableObjectSourceSqlInput,
    validation_name: &str,
) -> Result<Vec<String>, String> {
    if !is_mysql_like(input.database_type)
        || !matches!(input.object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function)
    {
        return Err("MySQL routine replacement is supported only for MySQL procedures and functions.".to_string());
    }
    if validation_name.trim().is_empty() {
        return Err("MySQL routine validation name must not be empty.".to_string());
    }
    build_executable_object_source_statements_with_mysql_validation_name(input, Some(validation_name), false)
}

fn build_executable_object_source_statements_with_mysql_validation_name(
    input: EditableObjectSourceSqlInput,
    mysql_validation_name: Option<&str>,
    drop_mysql_validation_before_create: bool,
) -> Result<Vec<String>, String> {
    if input.database_type == DatabaseType::OceanbaseOracle && input.object_type == ObjectSourceKind::Sequence {
        return Ok(vec![oceanbase_sequence_edit_sql(&input)?]);
    }
    let source = input.source.trim();
    let source = if is_opengauss_like(input.database_type) && input.object_type == ObjectSourceKind::Procedure {
        strip_standalone_trailing_slash(source)
    } else {
        source
    };
    if (input.database_type == DatabaseType::Oracle || input.database_type == DatabaseType::OceanbaseOracle)
        && matches!(
            input.object_type,
            ObjectSourceKind::Procedure
                | ObjectSourceKind::Function
                | ObjectSourceKind::Package
                | ObjectSourceKind::PackageBody
        )
        && source_starts_with_create(source)
    {
        validate_oracle_object_source(
            input.database_type,
            &input.object_type,
            input.schema.as_deref(),
            &input.name,
            source,
        )?;
    }
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

    if (is_oracle_like(input.database_type) || input.database_type == DatabaseType::OceanbaseOracle)
        && input.object_type == ObjectSourceKind::View
    {
        return Ok(vec![executable_oracle_view_ddl(input.schema.as_deref(), &input.name, source)]);
    }

    if is_oracle_like(input.database_type)
        && matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure)
    {
        return Ok(vec![executable_oracle_routine_ddl(source)]);
    }

    if matches!(input.database_type, DatabaseType::Informix | DatabaseType::Gbase8s)
        && input.object_type == ObjectSourceKind::View
    {
        return Ok(executable_informix_view_statements(input.schema.as_deref(), &input.name, source));
    }

    if is_mysql_like(input.database_type)
        && matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure)
    {
        return Ok(executable_mysql_routine_statements(
            &input,
            source,
            mysql_validation_name,
            drop_mysql_validation_before_create,
        ));
    }

    let create_statement = ensure_semicolon(source);
    let cleanup = build_routine_rename_cleanup(&input, source);
    Ok(if let Some(cleanup) = cleanup { vec![create_statement, cleanup] } else { vec![create_statement] })
}

pub fn validate_oracle_executable_object_source(input: OracleObjectSourceValidationInput) -> Result<(), String> {
    if !matches!(input.database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        || !matches!(
            input.object_type,
            ObjectSourceKind::Procedure
                | ObjectSourceKind::Function
                | ObjectSourceKind::Package
                | ObjectSourceKind::PackageBody
        )
    {
        return Err("Strict object-source validation is supported only for Oracle routines and packages.".to_string());
    }
    validate_oracle_object_source(
        input.database_type,
        &input.object_type,
        input.schema.as_deref(),
        &input.name,
        &input.source,
    )
}

pub fn fingerprint_oracle_routine_object_source(input: EditableObjectSourceSqlInput) -> Result<String, String> {
    if !matches!(input.database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        || !matches!(input.object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function)
    {
        return Err("Routine source fingerprinting is supported only for Oracle procedures and functions.".into());
    }
    validate_oracle_object_source(
        input.database_type,
        &input.object_type,
        input.schema.as_deref(),
        &input.name,
        &input.source,
    )?;

    let tokens = Tokenizer::new(&OracleDialect {}, &input.source)
        .tokenize_with_location()
        .map_err(|error| format!("Cannot tokenize Oracle routine source: {error}"))?;
    let mut tokens = tokens
        .iter()
        .filter(|token| {
            !matches!(
                &token.token,
                Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline) | Token::EOF
            )
        })
        .collect::<Vec<_>>();
    let last_statement_token = tokens.iter().rposition(|token| {
        !matches!(
            token.token,
            Token::Whitespace(Whitespace::SingleLineComment { .. } | Whitespace::MultiLineComment(_))
        )
    });
    if last_statement_token.is_some_and(|index| tokens[index].token == Token::SemiColon) {
        tokens.remove(last_statement_token.unwrap());
    }
    let token_fingerprints = tokens
        .iter()
        .map(|token| {
            let start = routine_location_to_byte_offset(&input.source, token.span.start)
                .ok_or_else(|| "Cannot map Oracle routine token positions to the source text.".to_string())?;
            let end = routine_location_to_byte_offset(&input.source, token.span.end)
                .ok_or_else(|| "Cannot map Oracle routine token positions to the source text.".to_string())?;
            if start >= end || end > input.source.len() {
                return Err("Oracle routine token positions overlap or exceed the source text.".to_string());
            }
            Ok(input.source[start..end].to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    serde_json::to_string(&token_fingerprints)
        .map_err(|error| format!("Cannot encode Oracle routine fingerprint: {error}"))
}

pub fn build_executable_object_source_sql(input: EditableObjectSourceSqlInput) -> Result<String, String> {
    Ok(build_executable_object_source_statements(input)?.join("\n"))
}

fn validate_oracle_object_source(
    database_type: DatabaseType,
    object_type: &ObjectSourceKind,
    schema: Option<&str>,
    name: &str,
    source: &str,
) -> Result<(), String> {
    let initial_tokens =
        Tokenizer::new(&OracleDialect {}, source).tokenize_with_location().map_err(|error| error.to_string())?;
    let first_significant = initial_tokens.iter().find(|token| !matches!(token.token, Token::Whitespace(_)));
    let source = if first_significant.is_some_and(|token| token_word_is(&token.token, "CREATE")) {
        source.to_string()
    } else if matches!(object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        format!("CREATE OR REPLACE {}", source.trim())
    } else {
        format!("CREATE {}", source.trim())
    };
    let statements = split_sql_statements_for_database(&source, database_type);
    if statements.len() != 1 {
        return Err("Oracle object source must contain exactly one complete object definition.".to_string());
    }

    let tokens =
        Tokenizer::new(&OracleDialect {}, &source).tokenize_with_location().map_err(|error| error.to_string())?;
    let significant = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
        .collect::<Vec<_>>();
    let token_at = |position: usize| significant.get(position).map(|index| &tokens[*index].token);
    let mut position = 0;
    if !token_at(position).is_some_and(|token| token_word_is(token, "CREATE")) {
        return Err("Oracle object source must begin with CREATE.".to_string());
    }
    position += 1;
    if token_at(position).is_some_and(|token| token_word_is(token, "OR")) {
        if !token_at(position + 1).is_some_and(|token| token_word_is(token, "REPLACE")) {
            return Err("Oracle object source has an invalid CREATE prefix.".to_string());
        }
        position += 2;
    }
    if token_at(position)
        .is_some_and(|token| token_word_is(token, "EDITIONABLE") || token_word_is(token, "NONEDITIONABLE"))
    {
        position += 1;
    }

    let kind_matches = match object_type {
        ObjectSourceKind::Procedure => token_at(position).is_some_and(|token| token_word_is(token, "PROCEDURE")),
        ObjectSourceKind::Function => token_at(position).is_some_and(|token| token_word_is(token, "FUNCTION")),
        ObjectSourceKind::Package => {
            token_at(position).is_some_and(|token| token_word_is(token, "PACKAGE"))
                && !token_at(position + 1).is_some_and(|token| token_word_is(token, "BODY"))
        }
        ObjectSourceKind::PackageBody => {
            token_at(position).is_some_and(|token| token_word_is(token, "PACKAGE"))
                && token_at(position + 1).is_some_and(|token| token_word_is(token, "BODY"))
        }
        _ => false,
    };
    if !kind_matches {
        return Err(format!("Oracle object source declaration does not match {object_type:?}."));
    }
    position += 1;
    if *object_type == ObjectSourceKind::PackageBody {
        position += 1;
    }

    let first_name = token_at(position).ok_or_else(|| "Oracle object source has no declaration name.".to_string())?;
    let (owner, declared_name, consumed) = if token_at(position + 1) == Some(&Token::Period) {
        let declared_name = token_at(position + 2)
            .ok_or_else(|| "Oracle object source has an incomplete qualified name.".to_string())?;
        (Some(first_name), declared_name, 3)
    } else {
        (None, first_name, 1)
    };
    if !oracle_identifier_matches(declared_name, name) {
        return Err(format!("Oracle source declares a different object than {name}."));
    }
    if let Some(Token::Word(owner)) = owner {
        if schema.is_some_and(|schema| !oracle_identifier_matches(&Token::Word(owner.clone()), schema)) {
            return Err("Oracle object source owner does not match the selected schema.".to_string());
        }
    } else if owner.is_some() {
        return Err("Oracle object source has an invalid owner identifier.".to_string());
    }
    if token_at(position + consumed).is_some_and(|token| token == &Token::Period) {
        return Err("Three-part Oracle object names are not supported.".to_string());
    }
    Ok(())
}

fn oracle_identifier_matches(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if identifier_matches(word, expected))
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
    if matches!(input.database_type, DatabaseType::Informix | DatabaseType::Gbase8s)
        && input.object_type == ObjectSourceKind::View
    {
        return editable_informix_view_ddl(input.schema.as_deref(), &input.name, &source);
    }
    if is_mysql_like(input.database_type)
        && matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure)
    {
        return ensure_semicolon(source.trim());
    }
    if input.database_type == DatabaseType::Mysql && input.object_type == ObjectSourceKind::View {
        // Existing view DDL opens as ALTER, while save must preserve CREATE for new views and TiDB.
        return executable_mysql_view_ddl(&source);
    }
    match build_executable_object_source_statements(input) {
        Ok(statements) => statements.into_iter().next().unwrap_or_default(),
        Err(_) => ensure_semicolon(source.trim()),
    }
}

pub fn build_view_ddl_sql(input: BuildViewDdlInput) -> String {
    let source = input.source.trim();
    if input.database_type.is_some_and(is_mysql_like) {
        return display_mysql_view_ddl(source, &quote_mysql_identifier(&input.name));
    }
    let terminated_source = if matches!(
        input.database_type,
        Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng)
    ) {
        ensure_oracle_ddl_terminated(source)
    } else {
        ensure_semicolon(source)
    };
    if Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(source) {
        return terminated_source;
    }

    // Backtick-quoting is used for MySQL-family engines and for connections
    // whose driver reports a backtick identifier quote (Kingbase MySQL
    // compatibility mode); everything else keeps the PostgreSQL double quote.
    let use_backtick = input.identifier_quote.as_deref() == Some("`")
        || (input.identifier_quote.is_none()
            && matches!(input.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)));
    let qualified_name = if use_backtick {
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
        return format!("CREATE OR REPLACE VIEW {qualified_name} AS\n{terminated_source}");
    }

    format!("CREATE VIEW {qualified_name} AS\n{terminated_source}")
}

pub fn build_export_object_source_sql(
    database_type: DatabaseType,
    object_type: ObjectSourceKind,
    source: &str,
) -> String {
    let source = source.trim();
    let source = if is_opengauss_like(database_type) && object_type == ObjectSourceKind::Procedure {
        strip_standalone_trailing_slash(source)
    } else {
        source
    };
    if source.is_empty() {
        return String::new();
    }
    // MySQL routine bodies, trigger bodies and event bodies may contain `;`, so the
    // exported statements need a client-side delimiter the same way `mysqldump` emits one.
    if is_mysql_like(database_type)
        && matches!(
            object_type,
            ObjectSourceKind::Procedure
                | ObjectSourceKind::Function
                | ObjectSourceKind::Trigger
                | ObjectSourceKind::Event
        )
    {
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

/// Alter sequence options without replaying START WITH or dropping the existing sequence.
fn oceanbase_sequence_edit_sql(input: &EditableObjectSourceSqlInput) -> Result<String, String> {
    let invalid = || {
        "Expected CREATE/ALTER SEQUENCE for the selected object with supported sequence options; restart and additional statements are not allowed.".to_string()
    };
    let mut tokens: Vec<Token> = Tokenizer::new(&OracleDialect {}, input.source.trim())
        .tokenize()
        .map_err(|_| invalid())?
        .into_iter()
        .filter(|token| !matches!(token, Token::Whitespace(_)))
        .collect();
    if matches!(tokens.last(), Some(Token::SemiColon)) {
        tokens.pop();
    }
    let word = |index: usize, expected: &str| matches!(tokens.get(index), Some(Token::Word(w)) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(expected));
    let creating = word(0, "CREATE");
    if (!creating && !word(0, "ALTER")) || !word(1, "SEQUENCE") {
        return Err(invalid());
    }
    let mut index = 2;
    let mut names = Vec::new();
    loop {
        let Some(Token::Word(name)) = tokens.get(index) else {
            return Err(invalid());
        };
        names.push(if name.quote_style.is_some() { name.value.clone() } else { name.value.to_uppercase() });
        index += 1;
        if !matches!(tokens.get(index), Some(Token::Period)) {
            break;
        }
        index += 1;
    }
    let expected = match input.schema.as_deref().filter(|schema| !schema.is_empty()) {
        Some(schema) => vec![schema.to_string(), input.name.clone()],
        None => vec![input.name.clone()],
    };
    if names != expected && names != vec![input.name.clone()] {
        return Err(invalid());
    }
    let mut options = Vec::new();
    while index < tokens.len() {
        let start = index;
        let skip_start = creating && word(index, "START");
        let numeric = if word(index, "INCREMENT") || skip_start {
            let next = if skip_start { "WITH" } else { "BY" };
            if !word(index + 1, next) {
                return Err(invalid());
            }
            index += 2;
            true
        } else if ["MINVALUE", "MAXVALUE", "CACHE"].iter().any(|option| word(index, option)) {
            index += 1;
            true
        } else if ["NOMINVALUE", "NOMAXVALUE", "NOCACHE", "CYCLE", "NOCYCLE", "ORDER", "NOORDER"]
            .iter()
            .any(|option| word(index, option))
        {
            index += 1;
            false
        } else {
            return Err(invalid());
        };
        if numeric {
            if matches!(tokens.get(index), Some(Token::Minus | Token::Plus)) {
                index += 1;
            }
            if !matches!(tokens.get(index), Some(Token::Number(value, false)) if !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()))
            {
                return Err(invalid());
            }
            index += 1;
        }
        if !skip_start {
            options.push(tokens[start..index].iter().map(ToString::to_string).collect::<Vec<_>>().join(" "));
        }
    }
    if options.is_empty() {
        return Err(invalid());
    }
    Ok(format!(
        "ALTER SEQUENCE {}\n  {};",
        postgres_qualified_name(input.schema.as_deref(), &input.name),
        options.join("\n  ")
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
            | DatabaseType::Uxdb
            | DatabaseType::Vastbase
    )
}

fn is_opengauss_like(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Gaussdb | DatabaseType::OpenGauss)
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
        ObjectSourceKind::Event => "EVENT",
        ObjectSourceKind::Sequence => "SEQUENCE",
        ObjectSourceKind::Synonym => "SYNONYM",
        ObjectSourceKind::Job => "JOB",
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

pub fn ensure_oracle_ddl_terminated(sql: &str) -> String {
    let trimmed = sql.trim_end();
    if trimmed.trim().is_empty() {
        return String::new();
    }
    if let Ok(tokens) = Tokenizer::new(&OracleDialect {}, trimmed).tokenize() {
        let last_code = tokens.iter().rev().find(|token| !matches!(token, Token::Whitespace(_)));
        if matches!(last_code, Some(Token::SemiColon | Token::Div)) {
            return trimmed.to_string();
        }
        if !matches!(tokens.last(), Some(Token::Whitespace(Whitespace::SingleLineComment { .. }))) {
            return format!("{trimmed};");
        }
    }
    format!("{trimmed}\n;")
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn strip_standalone_trailing_slash(sql: &str) -> &str {
    let trimmed = sql.trim();
    let Some(without_slash) = trimmed.strip_suffix('/') else {
        return trimmed;
    };
    if without_slash.ends_with('\n') || without_slash.ends_with('\r') {
        without_slash.trim_end()
    } else {
        trimmed
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

fn source_starts_with_create(source: &str) -> bool {
    let executable = &source[leading_sql_statement_start(source)..];
    Regex::new(r"(?i)^CREATE\s+").unwrap().is_match(executable)
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
    let statement_start = leading_sql_statement_start(trimmed);
    let executable = &trimmed[statement_start..];
    if Regex::new(r"(?i)^CREATE\s+OR\s+REPLACE\s+").unwrap().is_match(executable)
        || source_starts_with_alter(executable)
    {
        return ensure_semicolon(trimmed);
    }

    let create_view = Regex::new(r"(?i)^CREATE\s+((?:(?:NO)?FORCE\s+)?(?:(?:NON)?EDITIONABLE\s+)?VIEW\s+)").unwrap();
    if create_view.is_match(executable) {
        let replaced = create_view.replace(executable, "CREATE OR REPLACE $1");
        return ensure_semicolon(&format!("{}{}", &trimmed[..statement_start], replaced));
    }

    format!("CREATE OR REPLACE VIEW {} AS\n{}", postgres_qualified_name(schema, name), ensure_semicolon(trimmed))
}

fn executable_oracle_routine_ddl(source: &str) -> String {
    let trimmed = source.trim();
    if Regex::new(r"(?i)^(?:PROCEDURE|FUNCTION)\b").unwrap().is_match(trimmed) {
        return ensure_semicolon(&format!("CREATE OR REPLACE {trimmed}"));
    }
    ensure_semicolon(trimmed)
}

/// View DDL shown in Edit Structure. MySQL returns `CREATE VIEW`, which the
/// structure editor used to present like a table script. Rewrite that to
/// `CREATE OR REPLACE VIEW` and keep the view name unqualified.
fn display_mysql_view_ddl(source: &str, view_name: &str) -> String {
    let trimmed = source.trim();
    if let Some(statement) = rewrite_mysql_view_statement(trimmed) {
        return statement;
    }
    if Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(trimmed) {
        return ensure_semicolon(trimmed);
    }
    format!("CREATE OR REPLACE VIEW {view_name} AS\n{}", ensure_semicolon(trimmed))
}

fn rewrite_mysql_view_statement(source: &str) -> Option<String> {
    let start = leading_sql_statement_start(source);
    let executable = source[start..].trim_end();
    let create_view = Regex::new(
        r"(?is)^(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?P<options>(?:ALGORITHM\s*=\s*(?:UNDEFINED|MERGE|TEMPTABLE)\s+)?(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(?:SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\s+)?)VIEW\s+(?:(?:`(?:``|[^`])+`|[A-Za-z0-9_$]+)\s*\.\s*)?(?P<rest>.*)$",
    )
    .unwrap();
    let captures = create_view.captures(executable)?;
    let options = captures.name("options").map(|value| value.as_str()).unwrap_or("");
    let rest = captures.name("rest")?.as_str();
    let statement = format!("CREATE OR REPLACE {options}VIEW {rest}");
    Some(ensure_semicolon(&format!("{}{}", &source[..start], statement.trim_start())))
}

fn executable_mysql_view_ddl(source: &str) -> String {
    let trimmed = source.trim();
    let statement_start = leading_sql_statement_start(trimmed);
    let executable = &trimmed[statement_start..];
    let create_view = Regex::new(
        r"(?is)^CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*(?:UNDEFINED|MERGE|TEMPTABLE)\s+)?(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(?:SQL\s+SECURITY\s+(?:DEFINER|INVOKER)\s+)?VIEW\s+",
    )
    .unwrap();
    if create_view.is_match(executable) {
        let create = Regex::new(r"(?i)^CREATE\s+(?:OR\s+REPLACE\s+)?").unwrap();
        let replaced = create.replace(executable, "ALTER ");
        return ensure_semicolon(&format!("{}{}", &trimmed[..statement_start], replaced));
    }

    ensure_semicolon(trimmed)
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

fn executable_mysql_routine_statements(
    input: &EditableObjectSourceSqlInput,
    source: &str,
    custom_validation_name: Option<&str>,
    drop_validation_before_create: bool,
) -> Vec<String> {
    if !mysql_source_starts_with_create_routine(source) {
        return vec![ensure_semicolon(source)];
    }

    let declaration = mysql_routine_declaration(source).filter(|declaration| declaration.kind == input.object_type);
    let create_name = declaration.as_ref().map(|declaration| declaration.name.as_str()).unwrap_or(&input.name);
    let is_rename =
        declaration.as_ref().is_some_and(|declaration| routine_name_changed(&declaration.name, &input.name));
    let mut statements = Vec::with_capacity(6);

    // MySQL has no cross-version CREATE OR REPLACE for stored routines. Validate the CREATE
    // body under a temporary name first (same idea as Informix view saves) so a syntax error
    // cannot leave the original routine deleted after DROP.
    let owned_validation_name;
    let validation_name = if let Some(validation_name) = custom_validation_name {
        validation_name
    } else {
        owned_validation_name = mysql_validation_routine_name(create_name);
        &owned_validation_name
    };
    if let Some(validation_source) = replace_mysql_routine_declaration_name(source, validation_name) {
        if drop_validation_before_create {
            statements.push(mysql_drop_routine_if_exists(
                input.object_type.clone(),
                input.schema.as_deref(),
                validation_name,
            ));
        }
        statements.push(ensure_semicolon(&validation_source));
        statements.push(mysql_drop_routine_if_exists(
            input.object_type.clone(),
            input.schema.as_deref(),
            validation_name,
        ));
    }

    statements.push(mysql_drop_routine_if_exists(input.object_type.clone(), input.schema.as_deref(), create_name));
    statements.push(ensure_semicolon(source));

    if is_rename {
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

fn mysql_validation_routine_name(target_name: &str) -> String {
    let mut hash = 0x811c9dc5u32;
    for byte in target_name.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("dbx_routine_check_{hash:08x}")
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

fn rewrite_oracle_routine_self_references(
    source: &str,
    old_name: &str,
    new_name: &str,
    schema: Option<&str>,
    object_type: ObjectSourceKind,
) -> Result<String, String> {
    let tokens = Tokenizer::new(&OracleDialect {}, source)
        .tokenize_with_location()
        .map_err(|error| format!("Cannot safely tokenize the routine source: {error}"))?;
    let significant = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
        .collect::<Vec<_>>();
    if old_name != new_name {
        if let Some(execute_index) =
            find_oracle_execute_immediate(significant.iter().copied().map(|index| (index, &tokens[index].token)))
        {
            let location = tokens[execute_index].span.start;
            return Err(format!(
                "Dynamic SQL must be rewritten as a verifiable static call at line {}, column {}.",
                location.line, location.column
            ));
        }
    }
    let routine_kind_position = significant
        .iter()
        .position(|index| {
            token_word_is(&tokens[*index].token, "FUNCTION") || token_word_is(&tokens[*index].token, "PROCEDURE")
        })
        .ok_or_else(|| "Cannot locate the routine declaration.".to_string())?;
    let mut declaration_name_position = routine_kind_position + 1;
    if significant.get(declaration_name_position + 1).is_some_and(|index| tokens[*index].token == Token::Period) {
        declaration_name_position += 2;
    }
    let body_start = (declaration_name_position + 1..significant.len())
        .find(|position| {
            token_word_is(&tokens[significant[*position]].token, "AS")
                || token_word_is(&tokens[significant[*position]].token, "IS")
        })
        .ok_or_else(|| "Cannot locate the routine body.".to_string())?;
    let declaration_end = (body_start + 1..significant.len())
        .find(|position| token_word_is(&tokens[significant[*position]].token, "BEGIN"))
        .unwrap_or(significant.len());
    if significant[body_start + 1..declaration_end]
        .iter()
        .any(|index| token_matches_identifier(&tokens[*index].token, old_name))
    {
        return Err(format!("A local declaration named {old_name} may shadow self-recursive calls."));
    }
    if (body_start + 1..significant.len()).any(|position| {
        (token_word_is(&tokens[significant[position]].token, "FUNCTION")
            || token_word_is(&tokens[significant[position]].token, "PROCEDURE"))
            && significant
                .get(position + 1)
                .is_some_and(|index| token_matches_identifier(&tokens[*index].token, old_name))
    }) {
        return Err(format!("A local routine named {old_name} may shadow self-recursive calls."));
    }
    if old_name != new_name
        && significant[body_start + 1..].iter().any(|index| token_matches_identifier(&tokens[*index].token, new_name))
    {
        return Err(format!(
            "The new routine name {new_name} already occurs in the body and could capture an existing reference."
        ));
    }
    let mut end = significant.len();
    if significant.last().is_some_and(|index| tokens[*index].token == Token::SemiColon) {
        end -= 1;
    }
    let outer_end = (end >= body_start + 2
        && token_word_is(&tokens[significant[end - 2]].token, "END")
        && token_matches_identifier(&tokens[significant[end - 1]].token, old_name))
    .then_some(significant[end - 1]);

    let mut edits = Vec::new();
    for position in body_start..significant.len() {
        let token_index = significant[position];
        let token = &tokens[token_index];
        if !token_matches_identifier(&token.token, old_name) {
            continue;
        }
        if Some(token_index) == outer_end {
            edits.push((token.span, quote_postgres_identifier(new_name)));
            continue;
        }
        let previous = position.checked_sub(1).map(|index| &tokens[significant[index]].token);
        let previous_previous = position.checked_sub(2).map(|index| &tokens[significant[index]].token);
        let qualified_owner = if previous == Some(&Token::Period) {
            let Some(Token::Word(owner)) = previous_previous else {
                return Err(format!("Cannot determine which routine reference to rename: {old_name}."));
            };
            if schema.is_some_and(|schema| identifier_matches(owner, schema)) {
                true
            } else {
                continue;
            }
        } else {
            false
        };
        let next = significant.get(position + 1).map(|index| &tokens[*index].token);
        let is_call = matches!(next, Some(Token::LParen))
            || (object_type == ObjectSourceKind::Procedure && matches!(next, Some(Token::SemiColon)));
        if is_call && (!matches!(previous, Some(Token::Period)) || qualified_owner) {
            edits.push((token.span, quote_postgres_identifier(new_name)));
        } else {
            return Err(format!(
                "Cannot safely determine whether {old_name} is a self-reference or another identifier."
            ));
        }
    }

    let mut result = source.to_string();
    for (span, replacement) in edits.into_iter().rev() {
        let start = routine_location_to_byte_offset(source, span.start)
            .ok_or_else(|| "Cannot map routine token positions to the source text.".to_string())?;
        let end = routine_location_to_byte_offset(source, span.end)
            .ok_or_else(|| "Cannot map routine token positions to the source text.".to_string())?;
        if start >= end || end > result.len() {
            return Err("Routine token positions overlap or exceed the source text.".to_string());
        }
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

fn routine_location_to_byte_offset(source: &str, location: sqlparser::tokenizer::Location) -> Option<usize> {
    let mut line = 1;
    let mut column = 1;
    for (offset, character) in source.char_indices() {
        if line == location.line && column == location.column {
            return Some(offset);
        }
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line == location.line && column == location.column).then_some(source.len())
}

fn token_word_is(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if word.value.eq_ignore_ascii_case(expected))
}

fn find_oracle_execute_immediate<'a>(tokens: impl IntoIterator<Item = (usize, &'a Token)>) -> Option<usize> {
    let mut previous: Option<(usize, &'a Token)> = None;
    for (index, token) in tokens {
        if let Some((previous_index, previous_token)) = previous {
            if token_unquoted_word_is(previous_token, "EXECUTE") && token_unquoted_word_is(token, "IMMEDIATE") {
                return Some(previous_index);
            }
        }
        previous = Some((index, token));
    }
    None
}

fn token_unquoted_word_is(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected))
}

fn token_matches_identifier(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if identifier_matches(word, expected))
}

fn identifier_matches(identifier: &sqlparser::tokenizer::Word, expected: &str) -> bool {
    if identifier.quote_style.is_some() {
        identifier.value == expected
    } else if identifier.keyword != Keyword::NoKeyword {
        false
    } else {
        identifier.value.to_ascii_uppercase() == expected
    }
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
    let statement_start = leading_sql_statement_start(source);
    let executable = &source[statement_start..];
    let create = Regex::new(r"(?i)^CREATE\s+(?:OR\s+ALTER\s+)?").unwrap();
    format!("{}{}", &source[..statement_start], create.replace(executable, "ALTER "))
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
    } else if value.eq_ignore_ascii_case("SYNONYM") {
        Some(ObjectSourceKind::Synonym)
    } else if value.eq_ignore_ascii_case("JOB") {
        Some(ObjectSourceKind::Job)
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

    fn oracle_routine_fingerprint(source: &str) -> Result<String, String> {
        fingerprint_oracle_routine_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            name: "CALLER_1".into(),
            source: source.into(),
        })
    }

    #[test]
    fn oracle_routine_source_fingerprint_ignores_only_whitespace_and_one_final_semicolon() {
        let submitted = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN APP.P_NEW; APP.P_NEW; END;";
        let readback = "CREATE OR REPLACE PROCEDURE APP.CALLER_1\n IS\nBEGIN APP.P_NEW; APP.P_NEW; END";

        assert_eq!(oracle_routine_fingerprint(submitted).unwrap(), oracle_routine_fingerprint(readback).unwrap());
    }

    #[test]
    fn oracle_routine_source_fingerprint_preserves_literals_comments_hints_and_identifiers() {
        let base = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE('a b'); APP.P_NEW; END;";
        for changed in [
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE('a  b'); APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN /* changed */ DBMS_OUTPUT.PUT_LINE('a b'); APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN /*+ changed */ DBMS_OUTPUT.PUT_LINE('a b'); APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(q'{a  b}'); APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(q'{a b}'); \"APP\".P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE('a b'); APP.P_OTHER; END;",
        ] {
            assert_ne!(oracle_routine_fingerprint(base).unwrap(), oracle_routine_fingerprint(changed).unwrap());
        }
        let q_literal = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(q'{a b}'); END;";
        let changed_q_literal =
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(q'{a  b}'); END;";
        let nq_literal = "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(nq'{a b}'); END;";
        let changed_nq_literal =
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN DBMS_OUTPUT.PUT_LINE(nq'{a  b}'); END;";
        assert_ne!(
            oracle_routine_fingerprint(q_literal).unwrap(),
            oracle_routine_fingerprint(changed_q_literal).unwrap()
        );
        assert_ne!(
            oracle_routine_fingerprint(nq_literal).unwrap(),
            oracle_routine_fingerprint(changed_nq_literal).unwrap()
        );
    }

    #[test]
    fn oracle_routine_source_fingerprint_rejects_wrong_identity_and_multiple_statements() {
        for source in [
            "CREATE OR REPLACE PROCEDURE OTHER.CALLER_1 IS BEGIN APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.OTHER IS BEGIN APP.P_NEW; END;",
            "CREATE OR REPLACE PROCEDURE APP.CALLER_1 IS BEGIN APP.P_NEW; END; SELECT 1",
        ] {
            assert!(oracle_routine_fingerprint(source).is_err(), "accepted invalid source: {source}");
        }
    }

    fn ob_sequence(source: &str, schema: Option<&str>, name: &str) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Sequence,
            schema: schema.map(str::to_string),
            name: name.to_string(),
            source: source.to_string(),
        }
    }

    #[test]
    fn oceanbase_sequence_edit_preserves_counter_and_object_identity() {
        let source = "CREATE SEQUENCE \"App\".\"Seq\" MINVALUE -999 MAXVALUE 9999999999999999999999999999 INCREMENT BY -2 START WITH 40 CACHE 20 NOCYCLE NOORDER;";
        let input = ob_sequence(source, Some("App"), "Seq");
        let expected = "ALTER SEQUENCE \"App\".\"Seq\"\n  MINVALUE - 999\n  MAXVALUE 9999999999999999999999999999\n  INCREMENT BY - 2\n  CACHE 20\n  NOCYCLE\n  NOORDER;";
        assert_eq!(build_editable_object_source(input.clone()), expected);
        assert_eq!(build_executable_object_source_statements(input).unwrap(), vec![expected]);
        let alter = ob_sequence(expected, Some("App"), "Seq");
        assert_eq!(build_executable_object_source_statements(alter).unwrap(), vec![expected]);
    }

    #[test]
    fn oceanbase_sequence_edit_handles_unqualified_and_quoted_names() {
        for (schema, name, source, expected_name) in [
            (Some("APP"), "SEQ", "alter sequence seq increment by 3 nocache", "\"APP\".\"SEQ\""),
            (None, "SEQ", "create sequence seq start with 1 increment by 1", "\"SEQ\""),
            (
                Some("A.B"),
                "S\"Q",
                "CREATE SEQUENCE \"A.B\".\"S\"\"Q\" START WITH 1 -- no reset\n INCREMENT BY 2",
                "\"A.B\".\"S\"\"Q\"",
            ),
        ] {
            let sql = build_executable_object_source_sql(ob_sequence(source, schema, name)).unwrap();
            assert!(sql.starts_with(&format!("ALTER SEQUENCE {expected_name}")));
            assert!(!sql.contains("START WITH"));
            assert!(!sql.contains("DROP"));
        }
    }

    #[test]
    fn oceanbase_sequence_edit_rejects_restart_wrong_targets_and_extra_statements() {
        for source in [
            "ALTER SEQUENCE APP.SEQ RESTART START WITH 1",
            "ALTER SEQUENCE APP.OTHER INCREMENT BY 1",
            "ALTER SEQUENCE OTHER.SEQ INCREMENT BY 1",
            "ALTER SEQUENCE \"app\".SEQ INCREMENT BY 1",
            "ALTER SEQUENCE APP.SEQ INCREMENT BY 1; DROP TABLE APP.T",
            "DROP SEQUENCE APP.SEQ",
            "CREATE OR REPLACE SEQUENCE APP.SEQ INCREMENT BY 1",
            "CREATE SEQUENCE APP.SEQ START WITH 1",
            "ALTER SEQUENCE APP.SEQ CACHE 1.5",
            "ALTER SEQUENCE APP.SEQ CACHE 1e3",
            "ALTER SEQUENCE APP.SEQ INCREMENT BY",
            "ALTER SEQUENCE APP.SEQ START WITH 1",
            "CREATE SEQUENCE APP.SEQ START WITH 1 INCREMENT BY 1; SELECT 1 FROM DUAL",
        ] {
            assert!(
                build_executable_object_source_statements(ob_sequence(source, Some("APP"), "SEQ")).is_err(),
                "{source}"
            );
        }
    }

    #[test]
    fn oracle_ddl_terminator_respects_quoted_tokens_and_slash_delimiters() {
        for (source, expected) in [
            ("SELECT q'[owner's --;]' FROM DUAL -- tail;", "SELECT q'[owner's --;]' FROM DUAL -- tail;\n;"),
            ("SELECT q'[owner's --;]' FROM DUAL; -- tail;", "SELECT q'[owner's --;]' FROM DUAL; -- tail;"),
            ("SELECT 1 AS \"名--称\" FROM DUAL -- tail;", "SELECT 1 AS \"名--称\" FROM DUAL -- tail;\n;"),
            ("SELECT 1 FROM DUAL\n/", "SELECT 1 FROM DUAL\n/"),
            ("SELECT 1 FROM DUAL;\n/", "SELECT 1 FROM DUAL;\n/"),
            ("SELECT 1 FROM DUAL\n/\n-- tail;", "SELECT 1 FROM DUAL\n/\n-- tail;"),
            ("  CREATE TABLE t (id NUMBER);\n", "  CREATE TABLE t (id NUMBER);"),
            ("  \n", ""),
        ] {
            assert_eq!(ensure_oracle_ddl_terminated(source), expected);
        }
    }

    fn input(database_type: DatabaseType, object_type: ObjectSourceKind, source: &str) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type,
            object_type,
            schema: Some("public".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        }
    }

    fn assert_sqlserver_editable_and_executable(object_type: ObjectSourceKind, source: &str, expected: &str) {
        let input = EditableObjectSourceSqlInput {
            database_type: DatabaseType::SqlServer,
            object_type,
            schema: Some("dbo".to_string()),
            name: "usp_demo".to_string(),
            source: source.to_string(),
        };

        assert_eq!(build_editable_object_source(input.clone()), expected);
        assert_eq!(build_executable_object_source_sql(input).unwrap(), expected);
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
    fn sqlserver_commented_procedure_source_preserves_comments_and_uses_alter() {
        let source = "-- =============================================\n-- Author: DBX\n-- Description: issue 2269 reproduction\n-- =============================================\n\nCREATE PROCEDURE [dbo].[usp_demo]\nAS\nBEGIN\n    SELECT 1;\nEND;";
        let expected = "-- =============================================\n-- Author: DBX\n-- Description: issue 2269 reproduction\n-- =============================================\n\nALTER PROCEDURE [dbo].[usp_demo]\nAS\nBEGIN\n    SELECT 1;\nEND;";

        assert_sqlserver_editable_and_executable(ObjectSourceKind::Procedure, source, expected);
    }

    #[test]
    fn sqlserver_block_commented_function_source_preserves_comment_and_uses_alter() {
        let source = "/* keep this function header */\nCREATE OR ALTER FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;";
        let expected =
            "/* keep this function header */\nALTER FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1 END;";

        assert_sqlserver_editable_and_executable(ObjectSourceKind::Function, source, expected);
    }

    #[test]
    fn sqlserver_commented_alter_source_remains_unchanged() {
        let source = "-- keep this note\nALTER PROCEDURE dbo.usp_demo AS SELECT 1;";

        assert_sqlserver_editable_and_executable(ObjectSourceKind::Procedure, source, source);
    }

    #[test]
    fn sqlserver_unclosed_block_comment_source_remains_unchanged() {
        let source = "/* unclosed header\nCREATE PROCEDURE dbo.usp_demo AS SELECT 1;";

        assert_sqlserver_editable_and_executable(ObjectSourceKind::Procedure, source, source);
    }

    #[test]
    fn sqlserver_leading_whitespace_before_procedure_uses_alter() {
        let source = "\n \tCREATE PROCEDURE dbo.usp_demo AS SELECT 1;\n";

        assert_sqlserver_editable_and_executable(
            ObjectSourceKind::Procedure,
            source,
            "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;",
        );
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
    fn oceanbase_oracle_view_source_builds_executable_replace_ddl() {
        for (source, expected) in [
            (
                "SELECT 2 AS N FROM DUAL",
                "CREATE OR REPLACE VIEW \"SYS\".\"DBX_VIEW_SAVE_PROBE\" AS\nSELECT 2 AS N FROM DUAL;",
            ),
            (
                "CREATE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 3 AS N FROM DUAL",
                "CREATE OR REPLACE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 3 AS N FROM DUAL;",
            ),
        ] {
            let input = EditableObjectSourceSqlInput {
                database_type: DatabaseType::OceanbaseOracle,
                object_type: ObjectSourceKind::View,
                schema: Some("SYS".to_string()),
                name: "DBX_VIEW_SAVE_PROBE".to_string(),
                source: source.to_string(),
            };

            assert_eq!(build_editable_object_source(input.clone()), expected);
            assert_eq!(build_executable_object_source_sql(input).unwrap(), expected);
        }
    }

    #[test]
    fn oceanbase_oracle_view_full_ddl_keeps_leading_comments() {
        for (source, expected) in [
            (
                "/* Keep this note */\nCREATE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 2 AS N FROM DUAL",
                "/* Keep this note */\nCREATE OR REPLACE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 2 AS N FROM DUAL;",
            ),
            (
                "-- Keep this note\nCREATE OR REPLACE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 3 AS N FROM DUAL",
                "-- Keep this note\nCREATE OR REPLACE VIEW SYS.DBX_VIEW_SAVE_PROBE AS SELECT 3 AS N FROM DUAL;",
            ),
        ] {
            let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
                database_type: DatabaseType::OceanbaseOracle,
                object_type: ObjectSourceKind::View,
                schema: Some("SYS".to_string()),
                name: "DBX_VIEW_SAVE_PROBE".to_string(),
                source: source.to_string(),
            })
            .unwrap();

            assert_eq!(sql, expected);
        }
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
    fn gbase8s_view_source_opened_for_editing_shows_unqualified_create_view() {
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Gbase8s,
            object_type: ObjectSourceKind::View,
            schema: Some("gbasedbt".to_string()),
            name: "v_orders".to_string(),
            source: "create view \"gbasedbt\".v_orders as select id from orders".to_string(),
        });

        assert_eq!(sql, "CREATE VIEW v_orders as select id from orders;");
    }

    #[test]
    fn view_ddl_wraps_postgres_body_as_create_or_replace_view() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
            identifier_quote: None,
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
            identifier_quote: None,
        });

        assert_eq!(sql, "CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW `active_users` AS SELECT `id` FROM `users`;");
    }

    #[test]
    fn mysql_view_ddl_uses_create_or_replace_without_database_name() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Mysql),
            schema: Some("app".to_string()),
            name: "active_users".to_string(),
            source: "SELECT id FROM users".to_string(),
            identifier_quote: None,
        });

        assert_eq!(sql, "CREATE OR REPLACE VIEW `active_users` AS\nSELECT id FROM users;");
    }

    #[test]
    fn mysql_show_create_view_drops_database_qualifier() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Mysql),
            schema: Some("app".to_string()),
            name: "active_users".to_string(),
            source: "CREATE ALGORITHM=UNDEFINED DEFINER=`hr`@`%` SQL SECURITY DEFINER VIEW `app`.`active_users` AS select `id` from `users`"
                .to_string(),
            identifier_quote: None,
        });

        assert_eq!(
            sql,
            "CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=`hr`@`%` SQL SECURITY DEFINER VIEW `active_users` AS select `id` from `users`;"
        );
    }

    #[test]
    fn view_ddl_uses_create_view_for_non_postgres_like_databases() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Sqlite),
            schema: Some("main".to_string()),
            name: "active_users".to_string(),
            source: "SELECT id FROM users".to_string(),
            identifier_quote: None,
        });

        assert_eq!(sql, "CREATE VIEW \"main\".\"active_users\" AS\nSELECT id FROM users;");
    }

    #[test]
    fn view_ddl_uses_backtick_quote_when_identifier_quote_reports_mysql_compat() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Kingbase),
            schema: Some("audit-schema".to_string()),
            name: "active_users".to_string(),
            source: "SELECT id FROM users".to_string(),
            identifier_quote: Some("`".to_string()),
        });

        assert_eq!(sql, "CREATE OR REPLACE VIEW `audit-schema`.`active_users` AS\nSELECT id FROM users;");
    }

    #[test]
    fn view_ddl_keeps_double_quote_without_mysql_compat_identifier_quote() {
        let sql = build_view_ddl_sql(BuildViewDdlInput {
            database_type: Some(DatabaseType::Kingbase),
            schema: Some("audit-schema".to_string()),
            name: "active_users".to_string(),
            source: "SELECT id FROM users".to_string(),
            identifier_quote: None,
        });

        assert_eq!(sql, "CREATE OR REPLACE VIEW \"audit-schema\".\"active_users\" AS\nSELECT id FROM users;");
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
    fn oracle_like_bare_procedure_source_saves_as_create_or_replace() {
        let source = "PROCEDURE refresh_cache AS\nBEGIN\n  DELETE FROM cache_entries;\n  COMMIT;\nEND;";

        for database_type in [DatabaseType::Oracle, DatabaseType::Dameng] {
            let statements =
                build_executable_object_source_statements(input(database_type, ObjectSourceKind::Procedure, source))
                    .unwrap();

            assert_eq!(
                statements,
                vec![
                    "CREATE OR REPLACE PROCEDURE refresh_cache AS\nBEGIN\n  DELETE FROM cache_entries;\n  COMMIT;\nEND;"
                ]
            );
        }
    }

    #[test]
    fn oracle_like_bare_function_source_saves_as_create_or_replace() {
        for database_type in [DatabaseType::Oracle, DatabaseType::Dameng] {
            let statements = build_executable_object_source_statements(input(
                database_type,
                ObjectSourceKind::Function,
                "FUNCTION refresh_cache RETURN NUMBER AS\nBEGIN\n  RETURN 1;\nEND;",
            ))
            .unwrap();

            assert_eq!(
                statements,
                vec!["CREATE OR REPLACE FUNCTION refresh_cache RETURN NUMBER AS\nBEGIN\n  RETURN 1;\nEND;"]
            );
        }
    }

    #[test]
    fn oracle_routine_create_prefix_is_not_duplicated() {
        for source in [
            "CREATE PROCEDURE refresh_cache AS BEGIN NULL; END;",
            "CREATE OR REPLACE PROCEDURE refresh_cache AS BEGIN NULL; END;",
        ] {
            let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
                database_type: DatabaseType::Oracle,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("public".to_string()),
                name: "REFRESH_CACHE".to_string(),
                source: source.to_string(),
            })
            .unwrap();

            assert_eq!(statements, vec![source]);
        }
    }

    #[test]
    fn non_oracle_bare_routine_source_is_unchanged() {
        let source = "PROCEDURE refresh_cache AS BEGIN NULL; END;";
        let statements = build_executable_object_source_statements(input(
            DatabaseType::Postgres,
            ObjectSourceKind::Procedure,
            source,
        ))
        .unwrap();

        assert_eq!(statements, vec![source]);
    }

    #[test]
    fn parses_programmable_metadata_object_kinds() {
        assert_eq!(parse_object_source_kind("TRIGGER"), Some(ObjectSourceKind::Trigger));
        assert_eq!(parse_object_source_kind("SYNONYM"), Some(ObjectSourceKind::Synonym));
        assert_eq!(parse_object_source_kind("JOB"), Some(ObjectSourceKind::Job));
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
        let source =
            "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache_v2`(IN mode_name varchar(20)) BEGIN SELECT 1; END";
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        })
        .unwrap();
        let validation_name = mysql_validation_routine_name("refresh_cache_v2");
        let validation_source = replace_mysql_routine_declaration_name(source, &validation_name).unwrap();
        assert_eq!(
            statements,
            vec![
                format!("DROP PROCEDURE IF EXISTS `app`.`{validation_name}`;"),
                ensure_semicolon(&validation_source),
                format!("DROP PROCEDURE IF EXISTS `app`.`{validation_name}`;"),
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache_v2`;".to_string(),
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache_v2`(IN mode_name varchar(20)) BEGIN SELECT 1; END;"
                    .to_string(),
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;".to_string(),
            ]
        );
    }

    #[test]
    fn mysql_procedure_save_replaces_existing_routine() {
        let source = "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END";
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("app".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        })
        .unwrap();
        let validation_name = mysql_validation_routine_name("refresh_cache");
        let validation_source = replace_mysql_routine_declaration_name(source, &validation_name).unwrap();

        assert_eq!(
            statements,
            vec![
                format!("DROP PROCEDURE IF EXISTS `app`.`{validation_name}`;"),
                ensure_semicolon(&validation_source),
                format!("DROP PROCEDURE IF EXISTS `app`.`{validation_name}`;"),
                "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;".to_string(),
                "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END;".to_string(),
            ]
        );
    }

    #[test]
    fn mysql_routine_replace_sequence_keeps_the_create_last_for_the_desktop_run_path() {
        // The desktop Run path of a routine source tab (issue #12855) executes every statement before the last one
        // as the replace preparation and then runs the tab's own CREATE through the normal query pipeline. That only
        // holds while the CREATE stays last; a rename ends with the cleanup DROP instead and is never prepared.
        for (object_type, source) in [
            (ObjectSourceKind::Procedure, "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"),
            (ObjectSourceKind::Function, "CREATE FUNCTION `refresh_cache`() RETURNS INT RETURN 1"),
        ] {
            let keyword = object_type_keyword(&object_type);
            let input = |name: &str| EditableObjectSourceSqlInput {
                database_type: DatabaseType::Mysql,
                object_type: object_type.clone(),
                schema: Some("app".to_string()),
                name: name.to_string(),
                source: source.to_string(),
            };

            let statements = build_executable_object_source_statements(input("refresh_cache")).unwrap();
            let (create, preparation) = statements.split_last().unwrap();
            assert_eq!(create, &format!("{source};"));
            assert_eq!(preparation.len(), 4);
            assert!(preparation[0].starts_with(&format!("DROP {keyword} IF EXISTS `app`.`dbx_routine_check_")));
            assert!(preparation[1].starts_with("CREATE") && preparation[1].contains("`dbx_routine_check_"));
            assert_eq!(preparation[2], preparation[0]);
            assert_eq!(preparation[3], format!("DROP {keyword} IF EXISTS `app`.`refresh_cache`;"));

            let renamed = build_executable_object_source_statements(input("refresh_cache_old")).unwrap();
            assert_eq!(renamed.last().unwrap(), &format!("DROP {keyword} IF EXISTS `app`.`refresh_cache_old`;"));
        }
    }

    #[test]
    fn mysql_transfer_routine_replacement_uses_scoped_validation_name() {
        let statements = build_mysql_routine_replacement_statements(
            EditableObjectSourceSqlInput {
                database_type: DatabaseType::Mysql,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("app".to_string()),
                name: "refresh_cache".to_string(),
                source: "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END".to_string(),
            },
            "dbx_transfer_check_0123456789abcdef",
        )
        .unwrap();

        assert_eq!(statements.len(), 4);
        assert!(statements[0].contains("CREATE PROCEDURE `dbx_transfer_check_0123456789abcdef`"));
        assert!(statements[1].contains("DROP PROCEDURE IF EXISTS `app`.`dbx_transfer_check_0123456789abcdef`"));
        assert!(statements[2].contains("DROP PROCEDURE IF EXISTS `app`.`refresh_cache`"));
        assert!(!statements[0].contains("DROP"));
    }

    #[test]
    fn mysql_function_save_replaces_existing_routine() {
        let source = "CREATE DEFINER=CURRENT_USER FUNCTION `active_count`() RETURNS INT RETURN 1";
        let statements = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::Function,
            schema: Some("app".to_string()),
            name: "active_count".to_string(),
            source: source.to_string(),
        })
        .unwrap();
        let validation_name = mysql_validation_routine_name("active_count");
        let validation_source = replace_mysql_routine_declaration_name(source, &validation_name).unwrap();

        assert_eq!(
            statements,
            vec![
                format!("DROP FUNCTION IF EXISTS `app`.`{validation_name}`;"),
                ensure_semicolon(&validation_source),
                format!("DROP FUNCTION IF EXISTS `app`.`{validation_name}`;"),
                "DROP FUNCTION IF EXISTS `app`.`active_count`;".to_string(),
                "CREATE DEFINER=CURRENT_USER FUNCTION `active_count`() RETURNS INT RETURN 1;".to_string(),
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
    fn mysql_view_source_opened_for_editing_uses_alter_view() {
        let source = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `new_view` AS select `base_plugins`.`id` AS `id` from `base_plugins`";
        let expected = "ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `new_view` AS select `base_plugins`.`id` AS `id` from `base_plugins`;";
        let mut input = EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("dol_test".to_string()),
            name: "new_view".to_string(),
            source: source.to_string(),
        };

        let editable = build_editable_object_source(input.clone());
        assert_eq!(editable, expected);
        input.source = editable;
        assert_eq!(build_executable_object_source_sql(input).unwrap(), expected);
    }

    #[test]
    fn mysql_new_view_create_source_remains_create() {
        let source = "CREATE VIEW `new_view` AS SELECT 1 AS `id`";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("dol_test".to_string()),
            name: "new_view".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, "CREATE VIEW `new_view` AS SELECT 1 AS `id`;");
    }

    #[test]
    fn mysql_new_view_create_source_preserves_leading_comments() {
        let source =
            "-- keep this view note\n/* and this block */\nCREATE OR REPLACE VIEW `new_view` AS SELECT 1 AS `id`";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("dol_test".to_string()),
            name: "new_view".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "-- keep this view note\n/* and this block */\nCREATE OR REPLACE VIEW `new_view` AS SELECT 1 AS `id`;"
        );
    }

    #[test]
    fn mysql_view_alter_source_remains_unchanged() {
        let source = "ALTER ALGORITHM=MERGE VIEW `new_view` AS SELECT 2 AS `id`;";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Mysql,
            object_type: ObjectSourceKind::View,
            schema: Some("dol_test".to_string()),
            name: "new_view".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, source);
    }

    #[test]
    fn opengauss_procedure_source_omits_gsql_trailing_slash() {
        let source = "CREATE OR REPLACE PROCEDURE public.refresh_cache()\nAS DECLARE BEGIN\n  NULL;\nEND;\n/";
        let expected = "CREATE OR REPLACE PROCEDURE public.refresh_cache()\nAS DECLARE BEGIN\n  NULL;\nEND;";

        for database_type in [DatabaseType::Gaussdb, DatabaseType::OpenGauss] {
            let editable = build_editable_object_source(input(database_type, ObjectSourceKind::Procedure, source));
            assert_eq!(editable, expected);

            let exported = build_export_object_source_sql(database_type, ObjectSourceKind::Procedure, source);
            assert_eq!(exported, expected);
        }
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
    fn mysql_trigger_and_event_export_use_delimiter_script() {
        let trigger = build_export_object_source_sql(
            DatabaseType::Mysql,
            ObjectSourceKind::Trigger,
            "CREATE DEFINER=`root`@`%` TRIGGER `trg_orders_ai` AFTER INSERT ON `orders` FOR EACH ROW\nBEGIN\n  INSERT INTO audit_log(msg) VALUES ('x');\nEND",
        );

        assert_eq!(
            trigger,
            "DELIMITER //\nCREATE DEFINER=`root`@`%` TRIGGER `trg_orders_ai` AFTER INSERT ON `orders` FOR EACH ROW\nBEGIN\n  INSERT INTO audit_log(msg) VALUES ('x');\nEND//\nDELIMITER ;"
        );

        // An event body already carries its schedule, so only the terminator changes.
        let event = build_export_object_source_sql(
            DatabaseType::Mysql,
            ObjectSourceKind::Event,
            "CREATE DEFINER=`root`@`%` EVENT `ev_purge` ON SCHEDULE EVERY 1 DAY DO DELETE FROM audit_log WHERE id < 0;",
        );

        assert_eq!(
            event,
            "DELIMITER //\nCREATE DEFINER=`root`@`%` EVENT `ev_purge` ON SCHEDULE EVERY 1 DAY DO DELETE FROM audit_log WHERE id < 0//\nDELIMITER ;"
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

    #[test]
    fn oceanbase_routine_source_builder_rewrites_self_reference_for_planned_migration() {
        let statements = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            name: "P_OLD".into(),
            new_name: "P_NEW".into(),
            source: "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN P_OLD; END P_OLD;".into(),
        })
        .unwrap();

        assert_eq!(statements[0], "CREATE OR REPLACE PROCEDURE \"APP\".\"P_NEW\" AS BEGIN \"P_NEW\"; END \"P_NEW\";");
        assert_eq!(statements[1], "DROP PROCEDURE \"APP\".\"P_OLD\";");
    }

    #[test]
    fn oracle_routine_rename_rejects_mismatched_owner_name_and_extra_sql() {
        for source in [
            "CREATE OR REPLACE PROCEDURE APP.P_OTHER AS BEGIN APP.P_OLD; END;",
            "CREATE OR REPLACE PROCEDURE OTHER.P_OLD AS BEGIN NULL; END;",
            "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN NULL; END; DROP TABLE T;",
        ] {
            let result = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
                database_type: DatabaseType::Oracle,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("APP".into()),
                name: "P_OLD".into(),
                new_name: "P_NEW".into(),
                source: source.into(),
            });
            assert!(result.is_err(), "accepted unsafe source: {source}");
        }
    }

    #[test]
    fn oracle_executable_routine_rejects_wrong_identity_and_create_or_replace() {
        for source in [
            "CREATE OR REPLACE PROCEDURE APP.P_OTHER AS BEGIN NULL; END;",
            "CREATE PROCEDURE OTHER.P_OLD AS BEGIN NULL; END;",
            "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN NULL; END; DROP TABLE T;",
        ] {
            let result = build_executable_object_source_statements(EditableObjectSourceSqlInput {
                database_type: DatabaseType::Oracle,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("APP".into()),
                name: "P_OLD".into(),
                source: source.into(),
            });
            assert!(result.is_err(), "accepted unsafe source: {source}");
        }
    }

    #[test]
    fn oracle_executable_package_source_requires_exact_identity_and_one_unit() {
        let valid = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Package,
            schema: Some("APP".into()),
            name: "P_NEW".into(),
            source: "CREATE PACKAGE APP.P_NEW AS PROCEDURE RUN; END P_NEW;".into(),
        })
        .unwrap();
        assert_eq!(valid.len(), 1);

        for source in [
            "CREATE PACKAGE APP.P_OTHER AS PROCEDURE RUN; END P_OTHER;",
            "CREATE PACKAGE OTHER.P_NEW AS PROCEDURE RUN; END P_NEW;",
            "CREATE PACKAGE APP.P_NEW AS PROCEDURE RUN; END P_NEW; BEGIN DROP TABLE T; END;",
        ] {
            let result = build_executable_object_source_statements(EditableObjectSourceSqlInput {
                database_type: DatabaseType::Oracle,
                object_type: ObjectSourceKind::Package,
                schema: Some("APP".into()),
                name: "P_NEW".into(),
                source: source.into(),
            });
            assert!(result.is_err(), "accepted unsafe package source: {source}");
        }
    }

    #[test]
    fn oracle_executable_source_respects_quoted_mixed_case_identity() {
        let input = |source: &str| EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Package,
            schema: Some("MiXeD".into()),
            name: "Pkg".into(),
            source: source.into(),
        };

        assert!(build_executable_object_source_statements(input(
            "CREATE PACKAGE \"MiXeD\".\"Pkg\" AS PROCEDURE RUN; END \"Pkg\";"
        ))
        .is_ok());
        for source in [
            "CREATE PACKAGE MIXED.\"Pkg\" AS PROCEDURE RUN; END \"Pkg\";",
            "CREATE PACKAGE \"MiXeD\".PKG AS PROCEDURE RUN; END PKG;",
        ] {
            assert!(
                build_executable_object_source_statements(input(source)).is_err(),
                "accepted identity with incorrect case semantics: {source}"
            );
        }
    }

    #[test]
    fn oracle_strict_source_validation_checks_create_and_bare_definitions() {
        let validate = |source: &str| {
            validate_oracle_executable_object_source(OracleObjectSourceValidationInput {
                database_type: DatabaseType::Oracle,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("APP".into()),
                name: "P_OLD".into(),
                source: source.into(),
            })
        };

        for source in [
            "CREATE OR REPLACE PROCEDURE APP.P_OTHER AS BEGIN APP.P_OLD; END;",
            "PROCEDURE APP.P_OTHER AS BEGIN APP.P_OLD; END;",
            "CREATE PROCEDURE OTHER.P_OLD AS BEGIN NULL; END;",
            "CREATE/*comment*/ OR REPLACE PROCEDURE APP.P_OTHER AS BEGIN NULL; END;",
            "CREATE OR REPLACE FUNCTION APP.P_OLD RETURN NUMBER AS BEGIN RETURN 1; END;",
            "CREATE OR REPLACE PROCEDURE APP.P_OLD AS BEGIN NULL; END; DROP TABLE T;",
        ] {
            assert!(validate(source).is_err(), "accepted unsafe source: {source}");
        }

        assert!(validate(
            "CREATE/*prefix*/OR/*replace*/REPLACE/*kind*/PROCEDURE APP.P_OLD AS BEGIN IF 1 = 1 THEN NULL; END IF; EXECUTE IMMEDIATE 'BEGIN NULL; END;'; END;"
        )
        .is_ok());
        assert!(validate(
            "PROCEDURE APP.P_OLD AS BEGIN IF 1 = 1 THEN NULL; END IF; EXECUTE IMMEDIATE 'BEGIN NULL; END;'; END;"
        )
        .is_ok());
    }

    #[test]
    fn oracle_family_routine_rename_updates_self_recursion_and_outer_end_only() {
        let source = r#"CREATE OR REPLACE FUNCTION "SYSDBA"."F_REC"(N NUMBER) RETURN NUMBER AS
BEGIN
  -- 注释中的 F_REC 必须保持不变。
  IF N <= 1 THEN RETURN 'F_REC'; END IF;
  RETURN "SYSDBA"."F_REC"(N - 1);
END F_REC;"#
            .replace('\n', "\r\n");
        let statements = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Dameng,
            object_type: ObjectSourceKind::Function,
            schema: Some("SYSDBA".to_string()),
            name: "F_REC".to_string(),
            new_name: "F_REC_2".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(
            statements[0],
            r#"CREATE OR REPLACE FUNCTION "SYSDBA"."F_REC_2"(N NUMBER) RETURN NUMBER AS
BEGIN
  -- 注释中的 F_REC 必须保持不变。
  IF N <= 1 THEN RETURN 'F_REC'; END IF;
  RETURN "SYSDBA"."F_REC_2"(N - 1);
END "F_REC_2";"#
                .replace('\n', "\r\n")
        );
    }

    #[test]
    fn oracle_family_routine_rename_does_not_treat_matching_schema_as_a_self_reference() {
        let statements = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("F_REC".to_string()),
            name: "F_REC".to_string(),
            new_name: "F_REC_2".to_string(),
            source: "CREATE OR REPLACE PROCEDURE \"F_REC\".\"F_REC\" AS BEGIN F_REC; END F_REC;".to_string(),
        })
        .unwrap();

        assert_eq!(
            statements[0],
            "CREATE OR REPLACE PROCEDURE \"F_REC\".\"F_REC_2\" AS BEGIN \"F_REC_2\"; END \"F_REC_2\";"
        );
    }

    #[test]
    fn oracle_family_routine_rename_rejects_ambiguous_old_name_use() {
        let result = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Function,
            schema: Some("APP".to_string()),
            name: "F_REC".to_string(),
            new_name: "F_REC_2".to_string(),
            source: "CREATE FUNCTION APP.F_REC(N NUMBER) RETURN NUMBER AS BEGIN SELECT F_REC INTO N FROM T; RETURN N; END F_REC;".to_string(),
        });

        assert!(result.unwrap_err().contains("Cannot safely determine whether F_REC"));
    }

    #[test]
    fn oracle_family_routine_rename_rejects_new_name_capture() {
        let result = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Function,
            schema: Some("APP".to_string()),
            name: "F_REC".to_string(),
            new_name: "F_REC_2".to_string(),
            source: "CREATE FUNCTION APP.F_REC(N NUMBER) RETURN NUMBER AS BEGIN RETURN F_REC_2(N - 1); END F_REC;"
                .to_string(),
        });

        assert!(result.unwrap_err().contains("could capture an existing reference"));
    }

    #[test]
    fn oracle_family_routine_rename_rejects_local_routine_shadowing() {
        let result = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Function,
            schema: Some("APP".to_string()),
            name: "F_REC".to_string(),
            new_name: "F_REC_2".to_string(),
            source: "CREATE FUNCTION APP.F_REC(N NUMBER) RETURN NUMBER AS FUNCTION F_REC(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END F_REC; BEGIN RETURN F_REC(N - 1); END F_REC;".to_string(),
        });

        assert!(result.unwrap_err().contains("may shadow self-recursive calls"));
    }

    #[test]
    fn oracle_family_routine_rename_does_not_rewrite_keywords_matching_quoted_routine_name() {
        let statements = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Function,
            schema: Some("APP".to_string()),
            name: "IF".to_string(),
            new_name: "F_IF".to_string(),
            source: "CREATE FUNCTION APP.\"IF\"(N NUMBER) RETURN NUMBER AS BEGIN IF N = 0 THEN RETURN 0; END IF; RETURN \"IF\"(N - 1); END \"IF\";".to_string(),
        })
        .unwrap();

        assert_eq!(
            statements[0],
            "CREATE FUNCTION \"APP\".\"F_IF\"(N NUMBER) RETURN NUMBER AS BEGIN IF N = 0 THEN RETURN 0; END IF; RETURN \"F_IF\"(N - 1); END \"F_IF\";"
        );
    }

    #[test]
    fn oracle_routine_caller_rewrite_changes_only_static_calls() {
        let source = "CREATE OR REPLACE VIEW APP.V_CALL AS\r\nSELECT APP.F_OLD(ID), OTHER.F_OLD(ID), 'F_OLD()' AS NOTE FROM APP.T -- F_OLD()\r\n";
        let rewritten = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::OceanbaseOracle,
            caller_type: ObjectSourceKind::View,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: source.into(),
        })
        .unwrap();

        assert_eq!(
            rewritten,
            "CREATE OR REPLACE VIEW APP.V_CALL AS\r\nSELECT APP.\"F_NEW\"(ID), OTHER.F_OLD(ID), 'F_OLD()' AS NOTE FROM APP.T -- F_OLD()\r\n"
        );
    }

    #[test]
    fn oracle_routine_caller_rewrite_preserves_case_sensitive_sibling_calls() {
        let rewritten = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::OceanbaseOracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "f_old".into(),
            new_name: "f_new".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS BEGIN RETURN \"f_old\"(1) + F_OLD(1); END;".into(),
        })
        .unwrap();

        assert_eq!(rewritten, "CREATE FUNCTION APP.CALLER RETURN NUMBER AS BEGIN RETURN \"f_new\"(1) + F_OLD(1); END;");
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_new_name_capture_before_writing() {
        let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS FUNCTION F_NEW(X NUMBER) RETURN NUMBER IS BEGIN RETURN X; END; BEGIN RETURN F_OLD(1); END;".into(),
        });
        assert!(result.unwrap_err().contains("F_OLD or F_NEW"));
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_dynamic_old_name_even_with_static_call() {
        let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Procedure,
            target_type: ObjectSourceKind::Procedure,
            schema: Some("SYS".into()),
            old_name: "DBX50_OLD_20261014_8F31".into(),
            new_name: "DBX50_NEW_20261014_8F31".into(),
            source: "CREATE OR REPLACE PROCEDURE \"SYS\".\"DBX50_CALL_20261014_8F31\" IS BEGIN DBX50_OLD_20261014_8F31; EXECUTE IMMEDIATE 'BEGIN DBX50_OLD_20261014_8F31; END;'; END".into(),
        });

        let error = result.unwrap_err();
        assert!(error.contains("Dynamic SQL"));
        assert!(error.contains("line 1") && error.contains("column"));
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_dynamic_sql_forms_and_comment_separated_keywords() {
        for dynamic_sql in
            ["'BEGIN DBX50_OLD_20261014_8F31; END;'", "statement_text", "'BEGIN ' || 'DBX50_OLD_20261014_8F31; END;'"]
        {
            let source = format!(
                "CREATE OR REPLACE PROCEDURE SYS.CALLER IS BEGIN DBX50_OLD_20261014_8F31; EXECUTE /* comment */ IMMEDIATE {dynamic_sql}; END;"
            );
            let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
                database_type: DatabaseType::Oracle,
                caller_type: ObjectSourceKind::Procedure,
                target_type: ObjectSourceKind::Procedure,
                schema: Some("SYS".into()),
                old_name: "DBX50_OLD_20261014_8F31".into(),
                new_name: "DBX50_NEW_20261014_8F31".into(),
                source,
            });

            let error = result.unwrap_err();
            assert!(error.contains("Dynamic SQL"), "accepted dynamic SQL: {dynamic_sql}");
            assert!(error.contains("line 1") && error.contains("column"));
        }
    }

    #[test]
    fn oracle_routine_caller_rewrite_ignores_execute_immediate_in_literals_comments_and_quoted_words() {
        let source = "CREATE OR REPLACE PROCEDURE SYS.CALLER IS v VARCHAR2(200); BEGIN DBX50_OLD_20261014_8F31; SELECT \"EXECUTE\" IMMEDIATE INTO v FROM DUAL; v := 'EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31'; v := q'[EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31]'; v := nq'[EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31]'; -- EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31\n DBMS_OUTPUT.PUT_LINE(\"EXECUTE\"); EXECUTE \"IMMEDIATE\"; END;";
        let rewritten = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Procedure,
            target_type: ObjectSourceKind::Procedure,
            schema: Some("SYS".into()),
            old_name: "DBX50_OLD_20261014_8F31".into(),
            new_name: "DBX50_NEW_20261014_8F31".into(),
            source: source.into(),
        })
        .unwrap();

        assert!(rewritten.contains("\"DBX50_NEW_20261014_8F31\";"));
        assert!(rewritten.contains("'EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31'"));
        assert!(rewritten.contains("q'[EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31]'"));
        assert!(rewritten.contains("nq'[EXECUTE IMMEDIATE DBX50_OLD_20261014_8F31]'"));
    }

    #[test]
    fn oracle_routine_self_reference_rewrite_rejects_dynamic_sql() {
        let result = build_routine_rename_object_source_statements(RoutineRenameObjectSourceInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("SYS".into()),
            name: "DBX50_OLD_20261014_8F31".into(),
            new_name: "DBX50_NEW_20261014_8F31".into(),
            source: "CREATE OR REPLACE PROCEDURE SYS.DBX50_OLD_20261014_8F31 IS BEGIN DBX50_OLD_20261014_8F31; EXECUTE IMMEDIATE 'BEGIN DBX50_OLD_20261014_8F31; END;'; END;".into(),
        });

        let error = result.unwrap_err();
        assert!(error.contains("Dynamic SQL"));
        assert!(error.contains("line 1") && error.contains("column"));
    }

    #[test]
    fn oracle_routine_caller_rewrite_handles_unqualified_calls_and_rejects_ambiguous_forms() {
        let rewritten = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Procedure,
            target_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "P_OLD".into(),
            new_name: "P_NEW".into(),
            source: "CREATE PROCEDURE APP.CALLER AS BEGIN P_OLD; P_OLD(1); END;".into(),
        })
        .unwrap();
        assert_eq!(rewritten, "CREATE PROCEDURE APP.CALLER AS BEGIN \"P_NEW\"; \"P_NEW\"(1); END;");

        let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS BEGIN RETURN F_OLD.VALUE; END;".into(),
        });
        assert!(result.unwrap_err().contains("unsupported form"));

        let scalar_reference = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS F_OLD NUMBER; BEGIN RETURN F_OLD; END;".into(),
        });
        assert!(scalar_reference.unwrap_err().contains("local declaration may shadow"));

        let procedure_from_view = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::View,
            target_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "P_OLD".into(),
            new_name: "P_NEW".into(),
            source: "CREATE VIEW APP.V_CALL AS SELECT P_OLD(1) FROM DUAL".into(),
        });
        assert!(procedure_from_view.unwrap_err().contains("does not contain a verifiable static call"));
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_shadowed_collection_calls() {
        let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS TYPE numbers IS TABLE OF NUMBER; F_OLD numbers; BEGIN RETURN F_OLD(1) + APP.F_OLD(1); END;".into(),
        });

        assert!(result.unwrap_err().contains("local declaration may shadow"));
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_shadowed_nested_block_and_parameter_names() {
        for source in [
            "CREATE FUNCTION APP.CALLER RETURN NUMBER AS BEGIN DECLARE TYPE numbers IS TABLE OF NUMBER; F_OLD numbers; BEGIN RETURN F_OLD(1) + APP.F_OLD(1); END; END;",
            "CREATE FUNCTION APP.CALLER(F_OLD NUMBER) RETURN NUMBER AS BEGIN RETURN APP.F_OLD(1); END;",
            "CREATE PROCEDURE APP.CALLER AS PROCEDURE helper IS BEGIN NULL; END; PROCEDURE worker IS TYPE numbers IS TABLE OF NUMBER; F_OLD numbers; BEGIN F_OLD(1) := 1; APP.F_OLD(1); END; BEGIN worker; END;",
        ] {
            let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
                database_type: DatabaseType::Oracle,
                caller_type: ObjectSourceKind::Function,
                target_type: ObjectSourceKind::Function,
                schema: Some("APP".into()),
                old_name: "F_OLD".into(),
                new_name: "F_NEW".into(),
                source: source.into(),
            });

            assert!(result.unwrap_err().contains("local declaration may shadow"));
        }
    }

    #[test]
    fn oracle_routine_caller_rewrite_rejects_shadowed_schema_qualifiers() {
        let result = rewrite_oracle_routine_references(OracleRoutineReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            caller_type: ObjectSourceKind::Function,
            target_type: ObjectSourceKind::Function,
            schema: Some("APP".into()),
            old_name: "F_OLD".into(),
            new_name: "F_NEW".into(),
            source: "CREATE FUNCTION APP.CALLER RETURN NUMBER AS APP RECORD; BEGIN RETURN APP.F_OLD(1); END;".into(),
        });

        assert!(result.unwrap_err().contains("schema qualifier may be shadowed"));
    }

    #[test]
    fn oracle_table_reference_rewrite_updates_static_sql_and_record_types_only() {
        let source = "CREATE OR REPLACE PROCEDURE APP.P AS r APP.T_OLD%ROWTYPE; v APP.T_OLD.V%TYPE; BEGIN SELECT COUNT(*) INTO v FROM APP.T_OLD; END;";
        let rewritten = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "T_OLD".into(),
            new_name: "T_NEW".into(),
            source: source.into(),
        })
        .unwrap();
        assert_eq!(
            rewritten,
            "CREATE OR REPLACE PROCEDURE APP.P AS r APP.\"T_NEW\"%ROWTYPE; v APP.\"T_NEW\".V%TYPE; BEGIN SELECT COUNT(*) INTO v FROM APP.\"T_NEW\"; END;"
        );
    }

    #[test]
    fn oracle_table_reference_rewrite_updates_trigger_binding_without_touching_literals_or_other_owner() {
        let source = "CREATE OR REPLACE TRIGGER APP.TR_OLD BEFORE INSERT ON APP.T_OLD FOR EACH ROW BEGIN :NEW.V := 'T_OLD'; -- T_OLD\n NULL; END;";
        let rewritten = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Trigger,
            schema: Some("APP".into()),
            old_name: "T_OLD".into(),
            new_name: "T_NEW".into(),
            source: source.into(),
        })
        .unwrap();
        assert_eq!(
            rewritten,
            "CREATE OR REPLACE TRIGGER APP.TR_OLD BEFORE INSERT ON APP.\"T_NEW\" FOR EACH ROW BEGIN :NEW.V := 'T_OLD'; -- T_OLD\n NULL; END;"
        );

        let other_owner = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "T_OLD".into(),
            new_name: "T_NEW".into(),
            source: "CREATE PROCEDURE APP.P AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM OTHER.T_OLD; END;".into(),
        });
        assert!(other_owner.unwrap_err().contains("no verifiable static reference"));
    }

    #[test]
    fn oracle_table_reference_rewrite_rejects_ambiguous_and_dynamic_source() {
        let ambiguous = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "T_OLD".into(),
            new_name: "T_NEW".into(),
            source: "CREATE PROCEDURE APP.P AS T_OLD NUMBER; BEGIN NULL; END;".into(),
        });
        assert!(ambiguous.unwrap_err().contains("Cannot safely identify"));

        let dynamic = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            old_name: "T_OLD".into(),
            new_name: "T_NEW".into(),
            source: "CREATE PROCEDURE APP.P AS BEGIN EXECUTE IMMEDIATE 'SELECT * FROM T_OLD'; END;".into(),
        });
        let dynamic_error = dynamic.unwrap_err();
        assert!(dynamic_error.contains("Dynamic SQL"));
        assert!(dynamic_error.contains("line 1, column 33"));

        for source in [
            "CREATE PROCEDURE APP.P AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM APP.T_OLD o JOIN APP.T_OTHER x ON x.ID=o.ID; END;",
            "CREATE PROCEDURE APP.P AS n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM APP.T_OLD o, APP.T_OTHER x; END;",
        ] {
            let multiple_relations = rewrite_oracle_table_references(OracleTableReferenceRewriteInput {
                database_type: DatabaseType::OceanbaseOracle,
                object_type: ObjectSourceKind::Procedure,
                schema: Some("APP".into()),
                old_name: "T_OLD".into(),
                new_name: "T_NEW".into(),
                source: source.into(),
            });
            assert!(multiple_relations.is_err());
        }
    }
}
