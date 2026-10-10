use super::*;
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, TokenWithSpan, Tokenizer, Whitespace};

fn kind_for_source(kind: TransferObjectKind) -> Result<db::ObjectSourceKind, String> {
    use db::ObjectSourceKind as S;
    Ok(match kind {
        TransferObjectKind::View => S::View,
        TransferObjectKind::MaterializedView => S::MaterializedView,
        TransferObjectKind::Procedure => S::Procedure,
        TransferObjectKind::Function => S::Function,
        TransferObjectKind::Trigger => S::Trigger,
        TransferObjectKind::Sequence => S::Sequence,
        _ => return Err(format!("OceanBase source transfer does not support {kind:?}")),
    })
}

fn tokens(source: &str) -> Result<Vec<TokenWithSpan>, String> {
    Tokenizer::new(&OracleDialect {}, source)
        .tokenize_with_location()
        .map(|tokens| tokens.into_iter().filter(|token| !matches!(token.token, Token::Whitespace(_))).collect())
        .map_err(|error| format!("Cannot tokenize complete OceanBase object source: {error}"))
}

fn word(token: Option<&TokenWithSpan>, value: &str) -> bool {
    matches!(token.map(|token| &token.token), Some(Token::Word(word)) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(value))
}

fn view_body(source: &str) -> Result<bool, String> {
    let tokens = tokens(source)?;
    Ok(!word(tokens.first(), "CREATE") && !word(tokens.first(), "ALTER"))
}

/// Use the same Agent source path as the editor; never retry it via a raw GET_DDL-only query.
pub(crate) async fn load(
    state: &AppState,
    request: &TransferRequest,
    target_schema: &str,
    name: &str,
    kind: TransferObjectKind,
) -> Result<Vec<String>, String> {
    load_with_owner(state, request, target_schema, name, kind).await.map(|(statements, _)| statements)
}

async fn load_with_owner(
    state: &AppState,
    request: &TransferRequest,
    target_schema: &str,
    name: &str,
    kind: TransferObjectKind,
) -> Result<(Vec<String>, String), String> {
    let source = crate::schema::get_object_source_core(
        state,
        &request.source_connection_id,
        &request.source_database,
        &request.source_schema,
        name,
        kind_for_source(kind)?,
        None,
        None,
    )
    .await?;
    if source.source.trim().is_empty() {
        return Err(format!("No complete source returned for OceanBase {kind:?} {name}; object may be missing, inaccessible or unsupported"));
    }
    let owner = source.schema.as_deref().filter(|owner| !owner.is_empty()).unwrap_or(&request.source_schema);
    if owner.is_empty() || target_schema.is_empty() {
        return Err(format!("Source/target schema is unavailable for OceanBase {kind:?} {name}"));
    }
    let columns = if kind == TransferObjectKind::View && view_body(&source.source)? {
        crate::schema::get_columns_core(state, &request.source_connection_id, &request.source_database, owner, name)
            .await?
            .into_iter()
            .map(|column| column.name)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    Ok((prepare(&source.source, owner, target_schema, name, kind, &columns)?, owner.to_string()))
}

fn offset(source: &str, line: u64, column: u64) -> Result<usize, String> {
    let mut current_line = 1;
    let mut current_column = 1;
    for (offset, character) in source.char_indices() {
        if current_line == line && current_column == column {
            return Ok(offset);
        }
        if character == '\n' {
            current_line += 1;
            current_column = 1;
        } else {
            current_column += 1;
        }
    }
    if current_line == line && current_column == column {
        return Ok(source.len());
    }
    Err("Invalid object source token location".into())
}

fn identifier(token: Option<&TokenWithSpan>) -> Result<String, String> {
    match token.map(|token| &token.token) {
        Some(Token::Word(word)) if word.quote_style == Some('"') => Ok(word.value.clone()),
        Some(Token::Word(word)) if word.quote_style.is_none() => Ok(word.value.to_uppercase()),
        _ => Err("Missing object identifier in OceanBase source declaration".into()),
    }
}

fn prepare(
    source: &str,
    owner: &str,
    target: &str,
    name: &str,
    kind: TransferObjectKind,
    columns: &[String],
) -> Result<Vec<String>, String> {
    let quote = |name: &str| quote_identifier(name, &DatabaseType::Oracle);
    let qualified = format!("{}.{}", quote(target), quote(name));
    let ddl = if kind == TransferObjectKind::View {
        let source = if view_body(source)? {
            if columns.is_empty() {
                return Err(format!("View column metadata is missing for {owner}.{name}"));
            }
            format!(
                "CREATE VIEW {qualified} ({}) AS\n{source}",
                columns.iter().map(|name| quote(name)).collect::<Vec<_>>().join(", ")
            )
        } else {
            source.to_string()
        };
        crate::object_source_sql::build_view_ddl_sql(crate::object_source_sql::BuildViewDdlInput {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some(target.into()),
            name: name.into(),
            source,
            identifier_quote: None,
        })
    } else {
        source.to_string()
    };
    let tokens = tokens(&ddl)?;
    if !word(tokens.first(), "CREATE") {
        return Err(format!("No complete CREATE {kind:?} source for {owner}.{name}"));
    }
    let mut index = 1;
    if word(tokens.get(index), "OR") && word(tokens.get(index + 1), "REPLACE") {
        index += 2;
    }
    while ["FORCE", "NOFORCE", "EDITIONABLE", "NONEDITIONABLE"].iter().any(|value| word(tokens.get(index), value)) {
        index += 1;
    }
    let keywords: &[&str] = match kind {
        TransferObjectKind::View => &["VIEW"],
        TransferObjectKind::MaterializedView => &["MATERIALIZED", "VIEW"],
        TransferObjectKind::Procedure => &["PROCEDURE"],
        TransferObjectKind::Function => &["FUNCTION"],
        TransferObjectKind::Trigger => &["TRIGGER"],
        TransferObjectKind::Sequence => &["SEQUENCE"],
        _ => return Err(format!("Unsupported OceanBase source kind {kind:?}")),
    };
    for keyword in keywords {
        if !word(tokens.get(index), keyword) {
            return Err(format!("Source declaration does not match {kind:?} {name}"));
        }
        index += 1;
    }
    let first = index;
    let declared_owner = if matches!(tokens.get(index + 1).map(|token| &token.token), Some(Token::Period)) {
        let declared = identifier(tokens.get(index))?;
        index += 2;
        Some(declared)
    } else {
        None
    };
    if declared_owner.as_deref().is_some_and(|declared| declared != owner && declared != target)
        || identifier(tokens.get(index))? != name
    {
        return Err(format!("Source declaration identity does not match {owner}.{name}"));
    }
    let start = offset(&ddl, tokens[first].span.start.line, tokens[first].span.start.column)?;
    let end = offset(&ddl, tokens[index].span.end.line, tokens[index].span.end.column)?;
    if owner != target
        && tokens[index + 1..].windows(2).any(|pair| {
            matches!(pair[1].token, Token::Period) && identifier(Some(&pair[0])).ok().as_deref() == Some(owner)
        })
    {
        reject_shadowed_owner(&tokens[index + 1..], owner)?;
    }
    let mut replacements = vec![(start, end, qualified)];
    // Token positions preserve the original PL/SQL, including comments, q-quotes and strings.
    for pair in tokens[index + 1..].windows(2) {
        if matches!(pair[1].token, Token::Period) && identifier(Some(&pair[0])).ok().as_deref() == Some(owner) {
            replacements.push((
                offset(&ddl, pair[0].span.start.line, pair[0].span.start.column)?,
                offset(&ddl, pair[0].span.end.line, pair[0].span.end.column)?,
                quote(target),
            ));
        }
    }
    let mut ddl = ddl;
    for (start, end, replacement) in replacements.into_iter().rev() {
        ddl.replace_range(start..end, &replacement);
    }
    let statements = split_sql_statements_for_database(&ddl, DatabaseType::Oracle);
    if statements.is_empty() {
        return Err(format!("No executable source for OceanBase {kind:?} {name}"));
    }
    Ok(statements)
}

fn reject_shadowed_owner(tokens: &[TokenWithSpan], owner: &str) -> Result<(), String> {
    for (index, token) in tokens.iter().enumerate() {
        if identifier(Some(token)).ok().as_deref() != Some(owner)
            || matches!(tokens.get(index + 1).map(|token| &token.token), Some(Token::Period))
        {
            continue;
        }
        // A local declaration or an explicit alias can bind the same spelling.
        let local = index.checked_sub(1).is_some_and(|previous| {
            matches!(tokens[previous].token, Token::LParen | Token::Comma | Token::SemiColon)
                || ["AS", "IS", "DECLARE", "FOR"].iter().any(|value| word(tokens.get(previous), value))
        }) && identifier(tokens.get(index + 1)).is_ok();
        let mut reference = index;
        if reference > 0 && identifier(tokens.get(reference - 1)).is_ok() {
            reference -= 1;
            while reference >= 2
                && matches!(tokens[reference - 1].token, Token::Period)
                && identifier(tokens.get(reference - 2)).is_ok()
            {
                reference -= 2;
            }
        }
        // Derived-table aliases follow ')'; comma-separated references have the
        // same alias ambiguity as FROM/JOIN. Block these bindings conservatively.
        let table_alias = index.checked_sub(1).is_some_and(|previous| matches!(tokens[previous].token, Token::RParen))
            || reference.checked_sub(1).is_some_and(|previous| {
                word(tokens.get(previous), "FROM")
                    || word(tokens.get(previous), "JOIN")
                    || matches!(tokens[previous].token, Token::Comma)
            });
        if local || table_alias {
            return Err(format!("Ambiguous source owner {owner}: a local binding or table alias shadows the schema; automatic owner mapping is blocked"));
        }
    }
    Ok(())
}

pub(super) async fn execute(
    state: &AppState,
    request: &TransferRequest,
    source_pool_key: &str,
    target_pool_key: &str,
    target_schema: &str,
    name: &str,
    kind: TransferObjectKind,
) -> Result<(), String> {
    let (statements, source_owner) = load_with_owner(state, request, target_schema, name, kind).await?;
    let sequence = if kind == TransferObjectKind::Sequence {
        Some(sequence_configuration(state, source_pool_key, &source_owner, name).await?)
    } else {
        None
    };
    for (index, statement) in statements.iter().enumerate() {
        if is_cancelled(&request.transfer_id).await {
            return Err(format!("OceanBase {kind:?} {name}, cancelled before statement {}/{} after {index} completed DDL statements; target retained for inspection; no rollback was attempted", index + 1, statements.len()));
        }
        execute_on_pool(state, target_pool_key, statement).await.map_err(|error| format!("OceanBase {kind:?} {name}, statement {}/{} failed after {} completed DDL statements; no rollback was attempted: {error}", index + 1, statements.len(), index))?;
    }
    verify_target(state, request, target_pool_key, target_schema, name, kind, &statements, sequence.as_ref()).await
        .map_err(|error| format!("OceanBase {kind:?} {name}, target verification failed after {} completed DDL statements; target retained for inspection; no rollback was attempted: {error}", statements.len()))
}

async fn complete_metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool_with_max_rows(state, pool, sql, Some(i32::MAX as usize)).await?;
    if result.truncated || result.has_more {
        return Err("Target verification metadata is incomplete".into());
    }
    Ok(result)
}

async fn sequence_configuration(
    state: &AppState,
    pool: &str,
    owner: &str,
    name: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let result = complete_metadata(state, pool, &format!("SELECT MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER={} AND SEQUENCE_NAME={}", quote_string_literal(owner), quote_string_literal(name))).await?;
    if result.rows.len() != 1 || result.rows[0].len() != 6 || result.rows[0].iter().any(serde_json::Value::is_null) {
        return Err("Sequence static configuration is missing or incomplete".into());
    }
    Ok(result.rows[0].clone())
}

fn definition_tokens(statements: &[String]) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for statement in statements {
        let mut values = Tokenizer::new(&OracleDialect {}, statement)
            .tokenize_with_location()
            .map_err(|error| format!("Cannot tokenize target definition: {error}"))?
            .into_iter()
            .filter(|value| match &value.token {
                Token::Whitespace(Whitespace::MultiLineComment(comment))
                | Token::Whitespace(Whitespace::SingleLineComment { comment, .. }) => {
                    comment.trim_start().starts_with('+')
                }
                Token::Whitespace(_) => false,
                _ => true,
            })
            .collect::<Vec<_>>();
        if word(values.first(), "CREATE") && word(values.get(1), "OR") && word(values.get(2), "REPLACE") {
            values.drain(1..3);
        }
        while values.last().is_some_and(|value| matches!(value.token, Token::SemiColon | Token::Div)) {
            values.pop();
        }
        result.extend(values.into_iter().map(|value| match value.token {
            Token::Word(value) => {
                if value.quote_style.is_some() {
                    format!("quoted identifier:{}", value.value)
                } else {
                    format!("word:{}", value.value.to_uppercase())
                }
            }
            value => format!("token:{value}"),
        }));
        result.push("statement boundary".into());
    }
    Ok(result)
}

async fn verify_target(
    state: &AppState,
    request: &TransferRequest,
    pool: &str,
    owner: &str,
    name: &str,
    kind: TransferObjectKind,
    expected: &[String],
    sequence: Option<&Vec<serde_json::Value>>,
) -> Result<(), String> {
    let dictionary_kind = match kind {
        TransferObjectKind::MaterializedView => "MATERIALIZED VIEW",
        TransferObjectKind::View => "VIEW",
        TransferObjectKind::Procedure => "PROCEDURE",
        TransferObjectKind::Function => "FUNCTION",
        TransferObjectKind::Trigger => "TRIGGER",
        TransferObjectKind::Sequence => "SEQUENCE",
        _ => return Err("Unsupported verification kind".into()),
    };
    let identity = format!(
        "OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={}",
        quote_string_literal(owner),
        quote_string_literal(name),
        quote_string_literal(dictionary_kind)
    );
    let objects = complete_metadata(
        state,
        pool,
        &format!("SELECT OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS WHERE {identity}"),
    )
    .await?;
    if objects.rows.len() != 1
        || objects.rows[0].first().and_then(serde_json::Value::as_str) != Some(name)
        || objects.rows[0].get(1).and_then(serde_json::Value::as_str) != Some(dictionary_kind)
    {
        return Err("Target object identity is missing or ambiguous".into());
    }
    if matches!(kind, TransferObjectKind::Procedure | TransferObjectKind::Function | TransferObjectKind::Trigger) {
        let errors = complete_metadata(state, pool, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE={} AND ATTRIBUTE='ERROR' ORDER BY SEQUENCE", quote_string_literal(owner), quote_string_literal(name), quote_string_literal(dictionary_kind))).await?;
        verify_program_status(objects.rows[0].get(2).and_then(serde_json::Value::as_str), &errors.rows)?;
    }
    let actual = crate::schema::get_object_source_core(
        state,
        &request.target_connection_id,
        &request.target_database,
        owner,
        name,
        kind_for_source(kind)?,
        None,
        None,
    )
    .await?;
    let columns = if kind == TransferObjectKind::View && view_body(&actual.source)? {
        crate::schema::get_columns_core(state, &request.target_connection_id, &request.target_database, owner, name)
            .await?
            .into_iter()
            .map(|column| column.name)
            .collect()
    } else {
        Vec::new()
    };
    let actual = prepare(&actual.source, owner, owner, name, kind, &columns)?;
    if let Some(expected_sequence) = sequence {
        if &sequence_configuration(state, pool, owner, name).await? != expected_sequence {
            return Err("Target sequence static configuration differs".into());
        }
    } else if definition_tokens(expected)? != definition_tokens(&actual)? {
        return Err("Target complete definition differs from the planned source".into());
    }
    Ok(())
}

fn verify_program_status(status: Option<&str>, errors: &[Vec<serde_json::Value>]) -> Result<(), String> {
    if status != Some("VALID") || !errors.is_empty() {
        return Err("Target program is not VALID or has compiler errors".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_ddl_does_not_make_invalid_or_unreadable_program_successful() {
        assert!(verify_program_status(Some("VALID"), &[]).is_ok());
        assert!(verify_program_status(Some("INVALID"), &[]).is_err());
        assert!(verify_program_status(None, &[]).is_err());
        assert!(verify_program_status(Some("VALID"), &[vec![serde_json::json!("compiler error")]]).is_err());
    }

    #[test]
    fn complete_definition_comparison_preserves_literals_operators_and_trigger_state() {
        let original = vec!["CREATE PROCEDURE \"P\" AS BEGIN X := 8 / 2; END;".into()];
        let readback = vec!["create or replace procedure \"P\" as begin x := 8 / 2; end;".into()];
        assert_eq!(definition_tokens(&original).unwrap(), definition_tokens(&readback).unwrap());
        for changed in [
            "CREATE PROCEDURE \"P\" AS BEGIN X := 8 * 2; END;",
            "CREATE PROCEDURE \"P\" AS BEGIN X := 8 / 3; END;",
            "CREATE PROCEDURE \"P\" AS BEGIN X := 'secret'; END;",
        ] {
            assert_ne!(definition_tokens(&original).unwrap(), definition_tokens(&[changed.into()]).unwrap());
        }
        let enabled: Vec<String> =
            vec!["CREATE TRIGGER T BEFORE INSERT ON A BEGIN NULL; END;".into(), "ALTER TRIGGER T ENABLE;".into()];
        let disabled = vec![enabled[0].clone(), "ALTER TRIGGER T DISABLE;".into()];
        assert_ne!(definition_tokens(&enabled).unwrap(), definition_tokens(&disabled).unwrap());
        for keyword in ["NULL", "SYSDATE"] {
            assert_ne!(
                definition_tokens(&[format!("CREATE VIEW V AS SELECT \"{keyword}\" FROM T")]).unwrap(),
                definition_tokens(&[format!("CREATE VIEW V AS SELECT {keyword} FROM T")]).unwrap()
            );
        }
        let hinted = vec!["CREATE VIEW V AS SELECT /*+ NO_MERGE */ A FROM T".into()];
        for changed in [
            "CREATE VIEW V AS SELECT A FROM T",
            "CREATE VIEW V AS SELECT /*+ MERGE */ A FROM T",
            "CREATE VIEW V AS SELECT --+ MERGE\n A FROM T",
        ] {
            assert_ne!(definition_tokens(&hinted).unwrap(), definition_tokens(&[changed.into()]).unwrap());
        }
        assert_ne!(
            definition_tokens(&["CREATE VIEW V AS SELECT 'a' FROM DUAL".into()]).unwrap(),
            definition_tokens(&["CREATE VIEW V AS SELECT 'A' FROM DUAL".into()]).unwrap()
        );
    }

    #[test]
    fn view_dictionary_body_preserves_column_aliases_and_quoted_owner() {
        let statements = prepare(
            "SELECT c, 'SRC.t' FROM SRC.t -- SRC.t\n",
            "SRC",
            "Mixed Owner",
            "V",
            TransferObjectKind::View,
            &["Alias".into(), "Other".into()],
        )
        .unwrap();
        assert_eq!(statements.len(), 1);
        assert!(statements[0].contains("CREATE VIEW \"Mixed Owner\".\"V\" (\"Alias\", \"Other\") AS"));
        assert!(statements[0].contains("'SRC.t' FROM \"Mixed Owner\".t -- SRC.t"));
    }

    #[test]
    fn schema_mapping_rejects_table_aliases_and_local_bindings_before_ddl() {
        for (kind, source) in [
            (TransferObjectKind::View, "CREATE VIEW SRC.OBJ AS SELECT SRC.ID FROM SRC.T SRC"),
            (TransferObjectKind::View, "CREATE VIEW SRC.OBJ AS SELECT SRC.ID FROM T SRC WHERE SRC.ID > 0"),
            (TransferObjectKind::Procedure, "CREATE PROCEDURE SRC.OBJ AS SRC T%ROWTYPE; BEGIN SRC.ID := 1; END;"),
            (
                TransferObjectKind::Function,
                "CREATE FUNCTION SRC.OBJ(SRC NUMBER) RETURN NUMBER AS BEGIN RETURN SRC.ID; END;",
            ),
        ] {
            let error = prepare(source, "SRC", "DST", "OBJ", kind, &[]).unwrap_err();
            assert!(error.contains("shadows the schema"));
            assert!(prepare(source, "SRC", "SRC", "OBJ", kind, &[]).is_ok());
        }
        let source = "CREATE VIEW SRC.OBJ AS SELECT T.ID FROM SRC.T T";
        assert!(prepare(source, "SRC", "DST", "OBJ", TransferObjectKind::View, &[]).is_ok());
        let source = "CREATE PROCEDURE SRC.OBJ AS SRC NUMBER; BEGIN NULL; END;";
        assert!(prepare(source, "SRC", "DST", "OBJ", TransferObjectKind::Procedure, &[]).is_ok());
    }

    #[test]
    fn schema_mapping_rejects_derived_table_alias_before_ddl() {
        let source = "CREATE VIEW SRC.OBJ AS SELECT SRC.ID FROM (SELECT ID FROM SRC.T) SRC";
        let error = prepare(source, "SRC", "DST", "OBJ", TransferObjectKind::View, &[]).unwrap_err();
        assert!(error.contains("shadows the schema"));
        assert!(prepare(source, "SRC", "SRC", "OBJ", TransferObjectKind::View, &[]).is_ok());
    }

    #[test]
    fn schema_mapping_rejects_comma_table_alias_before_ddl() {
        let source = "CREATE VIEW SRC.OBJ AS SELECT SRC.ID FROM SRC.T T, OTHER.T SRC";
        let error = prepare(source, "SRC", "DST", "OBJ", TransferObjectKind::View, &[]).unwrap_err();
        assert!(error.contains("shadows the schema"));
        assert!(prepare(source, "SRC", "SRC", "OBJ", TransferObjectKind::View, &[]).is_ok());
    }

    #[test]
    fn source_identity_and_empty_source_fail_before_execution() {
        for source in ["", "-- unavailable", "CREATE SEQUENCE OTHER START WITH 1", "ALTER SEQUENCE S INCREMENT BY 2"] {
            assert!(prepare(source, "SRC", "DST", "S", TransferObjectKind::Sequence, &[]).is_err());
        }
        assert!(prepare("SELECT 1 FROM DUAL", "SRC", "DST", "V", TransferObjectKind::View, &[]).is_err());
    }

    #[test]
    fn routine_fallback_gets_target_owner_without_touching_literals_or_body() {
        for (kind, source) in [
            (TransferObjectKind::Procedure, "CREATE OR REPLACE PROCEDURE P AS\nBEGIN\n INSERT INTO SRC.T VALUES (q'[don't change SRC.T]');\nEND;\n/"),
            (TransferObjectKind::Function, "CREATE OR REPLACE FUNCTION P RETURN NUMBER AS\nBEGIN RETURN 1; END;\n/"),
        ] {
            let statements = prepare(source, "SRC", "Dst\"Owner", "P", kind, &[]).unwrap();
            assert_eq!(statements.len(), 1);
            assert!(statements[0].contains("\"Dst\"\"Owner\".\"P\""));
            if kind == TransferObjectKind::Procedure {
                assert!(statements[0].contains("INSERT INTO \"Dst\"\"Owner\".T VALUES (q'[don't change SRC.T]')"));
            }
        }
    }

    #[test]
    fn trigger_create_and_state_are_separate_statements_with_target_owners() {
        let source = "CREATE OR REPLACE TRIGGER \"SRC\".\"AUDIT\" BEFORE INSERT ON \"SRC\".\"T\"\nBEGIN NULL; END;\n/\nALTER TRIGGER \"SRC\".\"AUDIT\" DISABLE;";
        let statements = prepare(source, "SRC", "DST", "AUDIT", TransferObjectKind::Trigger, &[]).unwrap();
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("ON \"DST\".\"T\""));
        assert!(statements[0].contains("BEGIN NULL; END;"));
        assert!(statements[1].contains("ALTER TRIGGER \"DST\".\"AUDIT\" DISABLE"));
    }

    #[test]
    fn sequence_and_complete_materialized_view_keep_their_create_options() {
        for (kind, source, tail) in [
            (
                TransferObjectKind::Sequence,
                "CREATE SEQUENCE \"SRC\".\"OBJ\" START WITH 7 INCREMENT BY 2 NOCYCLE;",
                "START WITH 7 INCREMENT BY 2 NOCYCLE",
            ),
            (
                TransferObjectKind::MaterializedView,
                "CREATE MATERIALIZED VIEW \"SRC\".\"OBJ\" REFRESH COMPLETE ON DEMAND AS SELECT * FROM \"SRC\".\"T\";",
                "REFRESH COMPLETE ON DEMAND",
            ),
        ] {
            let statements = prepare(source, "SRC", "DST", "OBJ", kind, &[]).unwrap();
            assert_eq!(statements.len(), 1);
            assert!(statements[0].contains("\"DST\".\"OBJ\""));
            assert!(statements[0].contains(tail));
        }
    }
}
