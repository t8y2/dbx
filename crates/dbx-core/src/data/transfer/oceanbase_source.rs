use super::*;
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, TokenWithSpan, Tokenizer};

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
    prepare(&source.source, owner, target_schema, name, kind, &columns)
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

pub(super) async fn execute(
    state: &AppState,
    request: &TransferRequest,
    target_pool_key: &str,
    target_schema: &str,
    name: &str,
    kind: TransferObjectKind,
) -> Result<(), String> {
    let statements = load(state, request, target_schema, name, kind).await?;
    for (index, statement) in statements.iter().enumerate() {
        if is_cancelled(&request.transfer_id).await {
            return Err("Cancelled".into());
        }
        execute_on_pool(state, target_pool_key, statement).await.map_err(|error| format!("OceanBase {kind:?} {name}, statement {}/{} failed after {} completed DDL statements; no rollback was attempted: {error}", index + 1, statements.len(), index))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
