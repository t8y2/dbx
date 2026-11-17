//! A copy is a new CREATE, never the replace/rename lifecycle used by Save.
use super::{
    ensure_semicolon, quote_mysql_identifier, quote_postgres_identifier, routine_location_to_byte_offset,
    split_sql_statements_for_database, validate_oracle_object_source, DatabaseType, ObjectSourceKind,
};
use serde::{Deserialize, Serialize};
use sqlparser::dialect::{Dialect, MsSqlDialect, MySqlDialect, OracleDialect, PostgreSqlDialect};
use sqlparser::tokenizer::{Token, TokenWithSpan, Tokenizer, Whitespace};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCopyObjectSourceInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub new_name: String,
    pub source: String,
}

fn keyword(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected))
}

fn matches_name(token: &Token, expected: &str, database_type: DatabaseType) -> bool {
    let Token::Word(word) = token else { return false };
    if word.quote_style.is_some() {
        word.value == expected
    } else if database_type == DatabaseType::Postgres {
        word.value.to_lowercase() == expected
    } else {
        word.value.eq_ignore_ascii_case(expected)
    }
}

fn offset(source: &str, location: sqlparser::tokenizer::Location) -> Result<usize, String> {
    routine_location_to_byte_offset(source, location).ok_or_else(|| "Cannot locate the routine header.".into())
}

fn quote_name(database_type: DatabaseType, value: &str) -> String {
    match database_type {
        DatabaseType::Mysql => quote_mysql_identifier(value),
        DatabaseType::SqlServer => format!("[{}]", value.replace(']', "]]")),
        _ => quote_postgres_identifier(value),
    }
}

/// Everything after CREATE PROCEDURE belongs to its batch body. Functions have
/// a bounded RETURN/BEGIN-END definition instead, so validate their trailing SQL.
fn validate_sqlserver_body(
    source: &str,
    tokens: &[&TokenWithSpan],
    name_end: usize,
    object_type: &ObjectSourceKind,
) -> Result<(), String> {
    for token in tokens {
        if keyword(&token.token, "GO") {
            let on_line = tokens
                .iter()
                .filter(|candidate| candidate.span.start.line == token.span.start.line)
                .collect::<Vec<_>>();
            if on_line.first().is_some_and(|first| keyword(&first.token, "GO"))
                && on_line[1..].iter().all(|next| matches!(next.token, Token::Number(_, _)))
            {
                return Err("A copied routine must not contain GO batches.".into());
            }
        }
    }
    let mut parens = 0usize;
    let body = (name_end..tokens.len())
        .find_map(|index| {
            match tokens[index].token {
                Token::LParen => parens += 1,
                Token::RParen => parens = parens.saturating_sub(1),
                _ => {}
            }
            let execute_as = index > 0 && keyword(&tokens[index - 1].token, "EXECUTE");
            if parens == 0 {
                if keyword(&tokens[index].token, "AS") && !execute_as {
                    return Some(index + 1);
                }
                // T-SQL functions allow AS to be omitted. Stop at the body
                // before a SELECT alias can be mistaken for a header AS.
                if *object_type == ObjectSourceKind::Function
                    && (keyword(&tokens[index].token, "BEGIN") || keyword(&tokens[index].token, "RETURN"))
                {
                    return Some(index);
                }
            }
            None
        })
        .ok_or_else(|| "The copied routine has no body.".to_string())?;
    if body >= tokens.len() {
        return Err("The copied routine has no body.".into());
    }
    if *object_type == ObjectSourceKind::Procedure {
        return Ok(());
    }
    if keyword(&tokens[body].token, "BEGIN") {
        let mut depth = 0usize;
        for index in body..tokens.len() {
            let token = &tokens[index].token;
            let transaction_begin = keyword(token, "BEGIN")
                && tokens.get(index + 1).is_some_and(|next| {
                    ["TRAN", "TRANSACTION", "DIALOG", "CONVERSATION"].iter().any(|word| keyword(&next.token, word))
                });
            if (keyword(token, "BEGIN") && !transaction_begin) || keyword(token, "CASE") {
                depth += 1;
            }
            if keyword(token, "END") {
                depth = depth.checked_sub(1).ok_or_else(|| "The copied routine has an unmatched END.".to_string())?;
                if depth == 0 {
                    if tokens[index + 1..].iter().any(|token| token.token != Token::SemiColon) {
                        return Err("A copied routine must contain only one complete definition.".into());
                    }
                    return Ok(());
                }
            }
        }
        return Err("The copied routine has an incomplete BEGIN/END body.".into());
    }
    if split_sql_statements_for_database(source, DatabaseType::SqlServer).len() != 1 {
        return Err("A copied routine must contain only one complete definition.".into());
    }
    Ok(())
}

/// Preserve the original body, parameters and security options while changing
/// only the declaration target. Existing destinations cause native CREATE to
/// fail rather than being replaced, and the original routine is never dropped.
pub fn build_routine_copy_object_source_sql(input: RoutineCopyObjectSourceInput) -> Result<String, String> {
    let oracle = matches!(input.database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle);
    if !matches!(input.object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function)
        || !matches!(
            input.database_type,
            DatabaseType::Mysql
                | DatabaseType::Postgres
                | DatabaseType::SqlServer
                | DatabaseType::Oracle
                | DatabaseType::OceanbaseOracle
        )
    {
        return Err("Routine copying is supported for standalone MySQL, PostgreSQL, SQL Server and Oracle procedures/functions.".into());
    }
    let new_name = input.new_name.trim();
    if input.name.trim().is_empty() || new_name.is_empty() || new_name.chars().any(char::is_control) {
        return Err("The copied routine requires a non-empty name without control characters.".into());
    }
    let same_name = if matches!(input.database_type, DatabaseType::Mysql | DatabaseType::SqlServer) {
        input.name.eq_ignore_ascii_case(new_name)
    } else {
        input.name == new_name
    };
    if same_name {
        return Err("The copied routine must have a different name.".into());
    }
    let source = if oracle { super::strip_standalone_trailing_slash(input.source.trim()) } else { input.source.trim() };
    // Dictionary providers may return USER_SOURCE text without CREATE.
    let statement_start = super::leading_sql_statement_start(source);
    let oracle_source;
    let source = if oracle
        && regex::Regex::new(r"(?i)^(?:PROCEDURE|FUNCTION)\b").unwrap().is_match(&source[statement_start..])
    {
        oracle_source = format!("{}CREATE {}", &source[..statement_start], &source[statement_start..]);
        oracle_source.as_str()
    } else {
        source
    };
    let dialect: Box<dyn Dialect> = match input.database_type {
        DatabaseType::Mysql => Box::new(MySqlDialect {}),
        DatabaseType::Postgres => Box::new(PostgreSqlDialect {}),
        DatabaseType::SqlServer => Box::new(MsSqlDialect {}),
        _ => Box::new(OracleDialect {}),
    };
    let all_tokens =
        Tokenizer::new(dialect.as_ref(), source).tokenize_with_location().map_err(|error| error.to_string())?;
    if input.database_type == DatabaseType::Mysql && all_tokens.iter().any(|token| {
        matches!(&token.token, Token::Whitespace(Whitespace::MultiLineComment(comment)) if comment.starts_with('!') || comment.starts_with("M!"))
    }) {
        return Err("A copied routine must not contain executable MySQL comments.".into());
    }
    let tokens = all_tokens.iter().filter(|token| !matches!(token.token, Token::Whitespace(_))).collect::<Vec<_>>();
    let at = |index: usize| tokens.get(index).map(|token| &token.token);
    let is = |index: usize, word: &str| at(index).is_some_and(|token| keyword(token, word));
    let mut cursor = 0;
    if is(cursor, "CREATE") || (input.database_type == DatabaseType::SqlServer && is(cursor, "ALTER")) {
        cursor += 1;
    } else {
        return Err("The copied source must start with a routine CREATE declaration.".into());
    }
    if is(cursor, "OR") {
        if !is(cursor + 1, "REPLACE") && !(input.database_type == DatabaseType::SqlServer && is(cursor + 1, "ALTER")) {
            return Err("The copied source has an invalid CREATE prefix.".into());
        }
        cursor += 2;
    }
    let option_start = cursor;
    if input.database_type == DatabaseType::Mysql && is(cursor, "DEFINER") {
        while cursor < tokens.len() && !is(cursor, "PROCEDURE") && !is(cursor, "FUNCTION") {
            cursor += 1;
        }
    } else if oracle && (is(cursor, "EDITIONABLE") || is(cursor, "NONEDITIONABLE")) {
        cursor += 1;
    }
    let kind_index = cursor;
    let kind = match input.object_type {
        ObjectSourceKind::Procedure => "PROCEDURE",
        _ => "FUNCTION",
    };
    if !is(cursor, kind)
        && !(input.database_type == DatabaseType::SqlServer && kind == "PROCEDURE" && is(cursor, "PROC"))
    {
        return Err("The copied source declaration does not match the selected routine kind.".into());
    }
    cursor += 1;
    if input.database_type == DatabaseType::Mysql
        && is(cursor, "IF")
        && is(cursor + 1, "NOT")
        && is(cursor + 2, "EXISTS")
    {
        cursor += 3;
    }
    let mut owner = None;
    if at(cursor + 1) == Some(&Token::Period) {
        let Some(Token::Word(word)) = at(cursor) else { return Err("The copied source has an invalid owner.".into()) };
        owner = Some(word.value.as_str());
        if input.database_type != DatabaseType::SqlServer {
            if let Some(schema) = input.schema.as_deref().filter(|value| !value.is_empty()) {
                if !matches_name(&tokens[cursor].token, schema, input.database_type) {
                    return Err("The copied source owner does not match the selected schema.".into());
                }
            }
        }
        cursor += 2;
    }
    let Some(name_token) = tokens.get(cursor) else { return Err("The copied source has no routine name.".into()) };
    if !matches!(&name_token.token, Token::Word(_)) {
        return Err("The copied source has an invalid routine name.".into());
    }
    // SQL Server retains the old declaration after sp_rename / ALTER SCHEMA.
    // The caller retrieves the definition by the selected catalog identity;
    // use that identity for the target, not the stale declaration text. This
    // also avoids imposing case-sensitive checks on a case-insensitive schema.
    if input.database_type != DatabaseType::SqlServer
        && !matches_name(&name_token.token, &input.name, input.database_type)
    {
        return Err("The copied source name does not match the selected routine.".into());
    }
    if at(cursor + 1) == Some(&Token::Period) {
        return Err("Three-part routine names are not supported for copying.".into());
    }
    if oracle {
        // A collection parameter can look exactly like a recursive call: P(1).
        // Do not turn an ambiguous parameter access into a call to the copy.
        if at(cursor + 1) == Some(&Token::LParen) {
            let mut depth = 0usize;
            let mut parameter_start = true;
            for token in tokens.iter().skip(cursor + 1) {
                match token.token {
                    Token::LParen => {
                        depth += 1;
                        continue;
                    }
                    Token::RParen => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            break;
                        }
                        continue;
                    }
                    Token::Comma if depth == 1 => {
                        parameter_start = true;
                        continue;
                    }
                    _ => {}
                }
                if depth == 1 && parameter_start {
                    if matches_name(&token.token, &input.name, input.database_type)
                        || matches_name(&token.token, new_name, input.database_type)
                    {
                        return Err(
                            "A routine parameter may shadow a self-reference or the copied routine name.".into()
                        );
                    }
                    parameter_start = false;
                }
            }
        }
        validate_oracle_object_source(
            input.database_type,
            &input.object_type,
            input.schema.as_deref(),
            &input.name,
            source,
        )?;
    } else if input.database_type == DatabaseType::SqlServer {
        validate_sqlserver_body(source, &tokens, cursor + 1, &input.object_type)?;
    } else if split_sql_statements_for_database(source, input.database_type).len() != 1 {
        return Err("A copied routine must contain only one complete definition.".into());
    }
    let target_name = quote_name(input.database_type, new_name);
    let target = if let Some(schema) = input.schema.as_deref().filter(|value| !value.is_empty()).or(owner) {
        format!("{}.{}", quote_name(input.database_type, schema), target_name)
    } else {
        target_name
    };
    let options = if option_start < kind_index {
        &source[offset(source, tokens[option_start].span.start)?..offset(source, tokens[kind_index].span.start)?]
    } else {
        ""
    };
    let first_start = offset(source, tokens[0].span.start)?;
    let name_end = offset(source, name_token.span.end)?;
    let copied = format!("{}CREATE {}{} {}{}", &source[..first_start], options, kind, target, &source[name_end..]);
    let copied = if oracle {
        super::rewrite_oracle_routine_self_references(
            &copied,
            &input.name,
            new_name,
            input.schema.as_deref().or(owner),
            input.object_type,
        )?
    } else {
        copied
    };
    Ok(ensure_semicolon(&copied))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(database_type: DatabaseType, object_type: ObjectSourceKind, source: &str) -> RoutineCopyObjectSourceInput {
        RoutineCopyObjectSourceInput {
            database_type,
            object_type,
            schema: Some("app".into()),
            name: "original".into(),
            new_name: "copied".into(),
            source: source.into(),
        }
    }
    #[test]
    fn routine_copy_mysql_preserves_definer_body_and_signature_without_drop() {
        let sql=build_routine_copy_object_source_sql(input(DatabaseType::Mysql,ObjectSourceKind::Procedure,"-- original\nCREATE DEFINER=`root`@`localhost` PROCEDURE `app`.`original`(IN n INT) BEGIN SELECT 'original; DROP TABLE t'; END;")).unwrap();
        assert_eq!(sql,"-- original\nCREATE DEFINER=`root`@`localhost` PROCEDURE `app`.`copied`(IN n INT) BEGIN SELECT 'original; DROP TABLE t'; END;");
    }
    #[test]
    fn routine_copy_postgres_keeps_dollar_quoted_body_and_removes_replace() {
        let sql=build_routine_copy_object_source_sql(input(DatabaseType::Postgres,ObjectSourceKind::Procedure,"CREATE OR REPLACE PROCEDURE app.original(IN n integer) LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'original'; END; $body$;")).unwrap();
        assert_eq!(sql,"CREATE PROCEDURE \"app\".\"copied\"(IN n integer) LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'original'; END; $body$;");
    }
    #[test]
    fn routine_copy_postgres_function_preserves_overload_arguments() {
        let sql = build_routine_copy_object_source_sql(input(
            DatabaseType::Postgres,
            ObjectSourceKind::Function,
            "CREATE FUNCTION app.original(n integer) RETURNS integer LANGUAGE sql AS $$SELECT n + 1$$;",
        ))
        .unwrap();
        assert!(sql.starts_with("CREATE FUNCTION \"app\".\"copied\"(n integer) RETURNS integer"));
    }
    #[test]
    fn routine_copy_sqlserver_changes_alter_and_proc_to_create_and_quotes_target() {
        for prefix in ["ALTER PROCEDURE", "CREATE OR ALTER PROC", "CREATE PROCEDURE"] {
            let sql=build_routine_copy_object_source_sql(input(DatabaseType::SqlServer,ObjectSourceKind::Procedure,&format!("/* header */ {prefix} [app].[original] @n int AS BEGIN SELECT CASE WHEN @n=1 THEN 'original' ELSE 'x' END; END;"))).unwrap();
            assert_eq!(sql,"/* header */ CREATE PROCEDURE [app].[copied] @n int AS BEGIN SELECT CASE WHEN @n=1 THEN 'original' ELSE 'x' END; END;");
        }
    }
    #[test]
    fn routine_copy_sqlserver_uses_selected_identity_after_rename_or_schema_transfer() {
        for (kind, declaration, body) in [
            (ObjectSourceKind::Procedure, "PROCEDURE", " AS SELECT 1;"),
            (ObjectSourceKind::Function, "FUNCTION", "(@n int) RETURNS int AS BEGIN RETURN @n + 1; END;"),
        ] {
            for old_target in ["app.old_name", "[APP].[original]", "[old_schema].[old_name]"] {
                let source = format!("CREATE {declaration} {old_target}{body}");
                let sql = build_routine_copy_object_source_sql(input(DatabaseType::SqlServer, kind.clone(), &source))
                    .unwrap();
                assert_eq!(sql, format!("CREATE {declaration} [app].[copied]{body}"));
            }
        }
    }
    #[test]
    fn routine_copy_sqlserver_optional_as_supports_scalar_inline_and_multistatement_functions() {
        for body in [
            "(@n int) RETURNS int BEGIN RETURN @n + 1; END;",
            "(@n int) RETURNS int WITH EXECUTE AS OWNER BEGIN RETURN @n + 1; END;",
            "(@n int) RETURNS int WITH EXECUTE AS 'routine user' BEGIN RETURN CASE WHEN @n > 0 THEN @n ELSE 0 END; END;",
            "(@n int) RETURNS TABLE RETURN (SELECT @n + 1 AS n);",
            "(@n int) RETURNS TABLE RETURN SELECT @n + 1 AS n;",
            "(@n int) RETURNS @result TABLE (n int) BEGIN INSERT @result VALUES (@n + 1); RETURN; END;",
            "(@n int) RETURNS int /* AS is optional */ BEGIN RETURN @n + 1; END;",
        ] {
            let sql = build_routine_copy_object_source_sql(input(
                DatabaseType::SqlServer,
                ObjectSourceKind::Function,
                &format!("CREATE FUNCTION app.original{body}"),
            ))
            .unwrap();
            assert_eq!(sql, format!("CREATE FUNCTION [app].[copied]{body}"));
        }
    }
    #[test]
    fn routine_copy_sqlserver_optional_as_keeps_body_boundaries() {
        for body in [
            "(@n int) RETURNS int BEGIN RETURN @n; END; DROP TABLE t;",
            "(@n int) RETURNS int BEGIN RETURN @n; END DROP TABLE t;",
            "(@n int) RETURNS int BEGIN RETURN @n;",
            "(@n int) RETURNS TABLE RETURN (SELECT @n AS n); DROP TABLE t;",
            "(@n int) RETURNS @r TABLE (n int) BEGIN RETURN; END; SELECT 2;",
            "(@n int) RETURNS int BEGIN RETURN @n; END;\nGO\nSELECT 2;",
            "(@n int) RETURNS int",
            "(@n int) RETURNS int WITH EXECUTE AS OWNER",
            "(@n int) RETURNS int AS",
        ] {
            assert!(
                build_routine_copy_object_source_sql(input(
                    DatabaseType::SqlServer,
                    ObjectSourceKind::Function,
                    &format!("CREATE FUNCTION app.original{body}"),
                ))
                .is_err(),
                "{body}"
            );
        }
    }
    #[test]
    fn routine_copy_sqlserver_still_requires_valid_header_kind_and_distinct_destination() {
        for source in [
            "CREATE PROCEDURE 123 AS SELECT 1;",
            "CREATE PROCEDURE [db].[app].[original] AS SELECT 1;",
            "CREATE FUNCTION app.original() RETURNS int AS BEGIN RETURN 1; END;",
        ] {
            assert!(build_routine_copy_object_source_sql(input(
                DatabaseType::SqlServer,
                ObjectSourceKind::Procedure,
                source
            ))
            .is_err());
        }
        let mut request =
            input(DatabaseType::SqlServer, ObjectSourceKind::Procedure, "CREATE PROC app.old_name AS SELECT 1;");
        request.new_name = "ORIGINAL".into();
        assert!(build_routine_copy_object_source_sql(request).is_err());
    }
    #[test]
    fn routine_copy_oracle_rewrites_outer_end_and_self_calls_only() {
        let mut request=input(DatabaseType::Oracle,ObjectSourceKind::Procedure,"CREATE OR REPLACE PROCEDURE APP.ORIGINAL(N NUMBER) AS BEGIN IF N>0 THEN ORIGINAL(N-1); END IF; DBMS_OUTPUT.PUT_LINE('ORIGINAL'); END ORIGINAL;\n/");
        request.name = "ORIGINAL".into();
        request.new_name = "COPIED".into();
        request.schema = Some("APP".into());
        assert_eq!(build_routine_copy_object_source_sql(request).unwrap(),"CREATE PROCEDURE \"APP\".\"COPIED\"(N NUMBER) AS BEGIN IF N>0 THEN \"COPIED\"(N-1); END IF; DBMS_OUTPUT.PUT_LINE('ORIGINAL'); END \"COPIED\";");
    }
    #[test]
    fn routine_copy_rejects_trailing_statements_outside_mysql_and_postgres_definition() {
        for (db, source) in [
            (DatabaseType::Mysql, "CREATE PROCEDURE app.original() BEGIN SELECT 1; END; DROP PROCEDURE app.original;"),
            (
                DatabaseType::Postgres,
                "CREATE PROCEDURE app.original() LANGUAGE SQL AS $$SELECT 1$$; DROP PROCEDURE app.original;",
            ),
        ] {
            assert!(
                build_routine_copy_object_source_sql(input(db, ObjectSourceKind::Procedure, source)).is_err(),
                "{db:?}"
            );
        }
    }
    #[test]
    fn routine_copy_rejects_mismatched_identity_kind_empty_same_and_unsupported_names() {
        let valid =
            input(DatabaseType::Mysql, ObjectSourceKind::Procedure, "CREATE PROCEDURE app.original() SELECT 1;");
        for name in ["", "  ", "ORIGINAL", "a\0b"] {
            let mut request = valid.clone();
            request.new_name = name.into();
            assert!(build_routine_copy_object_source_sql(request).is_err());
        }
        for source in [
            "CREATE PROCEDURE other.original() SELECT 1;",
            "CREATE PROCEDURE app.other() SELECT 1;",
            "CREATE FUNCTION app.original() RETURNS INT RETURN 1;",
        ] {
            let mut request = valid.clone();
            request.source = source.into();
            assert!(build_routine_copy_object_source_sql(request).is_err());
        }
        let mut request = valid;
        request.database_type = DatabaseType::Sqlite;
        assert!(build_routine_copy_object_source_sql(request).is_err());
    }
    #[test]
    fn routine_copy_escapes_new_identifier_instead_of_interpolating_sql() {
        let mut request =
            input(DatabaseType::Mysql, ObjectSourceKind::Procedure, "CREATE PROCEDURE app.original() SELECT 1;");
        request.new_name = "copy`; DROP TABLE t; --".into();
        assert_eq!(
            build_routine_copy_object_source_sql(request).unwrap(),
            "CREATE PROCEDURE `app`.`copy``; DROP TABLE t; --`() SELECT 1;"
        );
    }
    #[test]
    fn routine_copy_mysql_drops_if_not_exists_so_collisions_are_errors() {
        let sql = build_routine_copy_object_source_sql(input(
            DatabaseType::Mysql,
            ObjectSourceKind::Procedure,
            "CREATE PROCEDURE IF NOT EXISTS app.original() SELECT 1;",
        ))
        .unwrap();
        assert_eq!(sql, "CREATE PROCEDURE `app`.`copied`() SELECT 1;");
    }
    #[test]
    fn routine_copy_sqlserver_rejects_go_and_missing_body() {
        for source in [
            "CREATE PROC app.original AS SELECT 1;\nGO\nDROP TABLE t;",
            "CREATE PROC app.original AS",
            "CREATE PROC app.original SELECT 1;",
        ] {
            assert!(build_routine_copy_object_source_sql(input(
                DatabaseType::SqlServer,
                ObjectSourceKind::Procedure,
                source
            ))
            .is_err());
        }
    }

    #[test]
    fn routine_copy_rejects_executable_mysql_comments_without_rejecting_string_contents() {
        for source in [
            "/*!50003 DROP PROCEDURE app.original */ CREATE PROCEDURE app.original() SELECT 1;",
            "CREATE PROCEDURE app.original() SELECT 1; /*!50003 DROP PROCEDURE app.original */",
        ] {
            assert!(build_routine_copy_object_source_sql(input(
                DatabaseType::Mysql,
                ObjectSourceKind::Procedure,
                source
            ))
            .is_err());
        }
        let sql = build_routine_copy_object_source_sql(input(
            DatabaseType::Mysql,
            ObjectSourceKind::Procedure,
            "CREATE PROCEDURE app.original() SELECT '/*! DROP */';",
        ))
        .unwrap();
        assert!(sql.contains("SELECT '/*! DROP */'"));
    }

    #[test]
    fn routine_copy_keeps_unicode_and_escaped_identifiers() {
        let mut request = input(
            DatabaseType::Postgres,
            ObjectSourceKind::Function,
            "-- 文本\r\nCREATE OR REPLACE FUNCTION \"app\".\"原名\"() RETURNS text AS $$SELECT '原名'$$ LANGUAGE sql;",
        );
        request.name = "原名".into();
        request.new_name = "新\"名".into();
        assert_eq!(
            build_routine_copy_object_source_sql(request).unwrap(),
            "-- 文本\r\nCREATE FUNCTION \"app\".\"新\"\"名\"() RETURNS text AS $$SELECT '原名'$$ LANGUAGE sql;"
        );
    }

    #[test]
    fn routine_copy_oracle_rejects_trailing_statement_and_keeps_edition_option() {
        let mut request = input(
            DatabaseType::Oracle,
            ObjectSourceKind::Procedure,
            "CREATE OR REPLACE EDITIONABLE PROCEDURE APP.ORIGINAL AS BEGIN NULL; END ORIGINAL;",
        );
        request.name = "ORIGINAL".into();
        request.new_name = "COPIED".into();
        request.schema = Some("APP".into());
        assert_eq!(
            build_routine_copy_object_source_sql(request.clone()).unwrap(),
            "CREATE EDITIONABLE PROCEDURE \"APP\".\"COPIED\" AS BEGIN NULL; END \"COPIED\";"
        );
        request.source.push_str(" DROP PROCEDURE APP.ORIGINAL;");
        assert!(build_routine_copy_object_source_sql(request).is_err());
    }

    #[test]
    fn routine_copy_oracle_family_accepts_dictionary_source_without_create() {
        for db in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            let mut request = input(
                db,
                ObjectSourceKind::Procedure,
                "/* 字典源码 */\nPROCEDURE APP.ORIGINAL AS BEGIN NULL; END ORIGINAL;",
            );
            request.name = "ORIGINAL".into();
            request.new_name = "COPIED".into();
            request.schema = Some("APP".into());
            assert_eq!(
                build_routine_copy_object_source_sql(request).unwrap(),
                "/* 字典源码 */\nCREATE PROCEDURE \"APP\".\"COPIED\" AS BEGIN NULL; END \"COPIED\";"
            );
        }
    }

    #[test]
    fn routine_copy_sqlserver_preserves_execute_as_and_multistatement_procedure_body() {
        for option in ["WITH EXECUTE AS OWNER", "WITH EXECUTE AS 'routine user'", ""] {
            let source = format!("CREATE PROC app.original @n int {option} AS SELECT @n; SELECT 2;");
            let sql = build_routine_copy_object_source_sql(input(
                DatabaseType::SqlServer,
                ObjectSourceKind::Procedure,
                &source,
            ))
            .unwrap();
            assert_eq!(sql, format!("CREATE PROCEDURE [app].[copied] @n int {option} AS SELECT @n; SELECT 2;"));
        }
    }

    #[test]
    fn routine_copy_sqlserver_supports_inline_table_function_and_rejects_function_trailing_sql() {
        let source = "CREATE FUNCTION app.original(@n int) RETURNS TABLE AS RETURN (SELECT @n AS n);";
        let sql =
            build_routine_copy_object_source_sql(input(DatabaseType::SqlServer, ObjectSourceKind::Function, source))
                .unwrap();
        assert_eq!(sql, "CREATE FUNCTION [app].[copied](@n int) RETURNS TABLE AS RETURN (SELECT @n AS n);");
        for source in [
            "CREATE FUNCTION app.original(@n int) RETURNS TABLE AS RETURN (SELECT @n AS n); DROP TABLE t;",
            "CREATE FUNCTION app.original(@n int) RETURNS int AS BEGIN RETURN @n; END; DROP TABLE t;",
        ] {
            assert!(build_routine_copy_object_source_sql(input(
                DatabaseType::SqlServer,
                ObjectSourceKind::Function,
                source
            ))
            .is_err());
        }
    }

    #[test]
    fn routine_copy_oracle_does_not_rewrite_ambiguous_shadowing_parameter() {
        for source in [
            "CREATE PROCEDURE APP.ORIGINAL(ORIGINAL NUMBER) AS BEGIN DBMS_OUTPUT.PUT_LINE(ORIGINAL); END ORIGINAL;",
            "CREATE PROCEDURE APP.ORIGINAL(ORIGINAL SYS.ODCINUMBERLIST) AS BEGIN DBMS_OUTPUT.PUT_LINE(ORIGINAL(1)); END ORIGINAL;",
        ] {
            let mut request=input(DatabaseType::Oracle,ObjectSourceKind::Procedure,source);
            request.name="ORIGINAL".into();request.new_name="COPIED".into();request.schema=Some("APP".into());
            assert!(build_routine_copy_object_source_sql(request).is_err());
        }
    }
}
