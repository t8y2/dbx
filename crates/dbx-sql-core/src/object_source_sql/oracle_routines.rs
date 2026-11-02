use super::*;

mod analysis;
pub use analysis::{
    analyze_oracle_package_body_draft, analyze_oracle_routine_draft, OracleDraftIssue, OracleDraftName,
    OracleDraftPackageCall, OracleDraftPackageMember, OracleDraftPackageMemberKind, OracleDraftParameter,
    OracleDraftQuery, OracleDraftReference, OracleDraftReferenceRole, OracleRoutineDraftAnalysis,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutineDefinitionInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    pub source_owner: String,
    pub target_owner: String,
    pub name: String,
    pub source: String,
    pub replace: bool,
}

pub fn validate_oracle_routine_target_definition(
    input: EditableObjectSourceSqlInput,
    require_replace: Option<bool>,
) -> Result<(), String> {
    if !matches!(
        input.object_type,
        ObjectSourceKind::Procedure
            | ObjectSourceKind::Function
            | ObjectSourceKind::Package
            | ObjectSourceKind::PackageBody
    ) {
        return Err("The approved statement must define one routine or package".into());
    }
    validate_oracle_executable_object_source(OracleObjectSourceValidationInput {
        database_type: input.database_type,
        object_type: input.object_type,
        schema: input.schema,
        name: input.name,
        source: input.source.clone(),
    })?;
    let tokens = Tokenizer::new(&OracleDialect {}, &input.source).tokenize().map_err(|error| error.to_string())?;
    let significant =
        tokens.iter().filter(|token| !matches!(token, Token::Whitespace(_) | Token::EOF)).collect::<Vec<_>>();
    if !significant.first().is_some_and(|token| token_unquoted_word_is(token, "CREATE")) {
        return Err("The approved routine statement must begin with CREATE".into());
    }
    let replaces = significant.get(1).is_some_and(|token| token_unquoted_word_is(token, "OR"));
    if require_replace.is_some_and(|required| required != replaces) {
        return Err(if replaces {
            "A newly created routine cannot use OR REPLACE"
        } else {
            "A routine replacement requires OR REPLACE"
        }
        .into());
    }
    Ok(())
}

/// Adapt only the declaration and client delimiter. The stored original remains
/// separate from this executable target draft.
pub fn prepare_oracle_routine_definition(input: OracleRoutineDefinitionInput) -> Result<String, String> {
    if !matches!(input.database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        || !matches!(
            input.object_type,
            ObjectSourceKind::Procedure
                | ObjectSourceKind::Function
                | ObjectSourceKind::Package
                | ObjectSourceKind::PackageBody
        )
    {
        return Err("Oracle routine adaptation requires a procedure, function or package".into());
    }
    if input.source_owner.is_empty() || input.target_owner.is_empty() || input.name.is_empty() {
        return Err("Oracle routine adaptation requires an exact owner and name".into());
    }
    let mut source = strip_client_delimiter(&input.source)?;
    let tokens = Tokenizer::new(&OracleDialect {}, &source).tokenize().map_err(|error| error.to_string())?;
    if !tokens
        .iter()
        .find(|token| !matches!(token, Token::Whitespace(_)))
        .is_some_and(|token| token_unquoted_word_is(token, "CREATE"))
    {
        source = format!("CREATE OR REPLACE {source}");
    }
    validate_oracle_object_source(
        input.database_type,
        &input.object_type,
        Some(&input.source_owner),
        &input.name,
        &source,
    )?;
    let tokens =
        Tokenizer::new(&OracleDialect {}, &source).tokenize_with_location().map_err(|error| error.to_string())?;
    let significant =
        tokens.iter().filter(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF)).collect::<Vec<_>>();
    let token_at = |position: usize| significant.get(position).map(|token| &token.token);
    let mut edits = Vec::new();
    let mut position = 1;
    if token_at(position).is_some_and(|token| token_unquoted_word_is(token, "OR")) {
        edits.push((significant[position].span, String::new()));
        edits.push((significant[position + 1].span, String::new()));
        position += 2;
    }
    edits.push((significant[0].span, if input.replace { "CREATE OR REPLACE".into() } else { "CREATE".into() }));
    if token_at(position).is_some_and(|token| {
        token_unquoted_word_is(token, "EDITIONABLE") || token_unquoted_word_is(token, "NONEDITIONABLE")
    }) {
        position += 1;
    }
    for keyword in object_type_keyword(&input.object_type).split_whitespace() {
        if !token_at(position).is_some_and(|token| token_unquoted_word_is(token, keyword)) {
            return Err("Routine declaration kind must use its exact unquoted keywords".into());
        }
        edits.push((significant[position].span, keyword.to_string()));
        position += 1;
    }
    if token_at(position + 1) == Some(&Token::Period) {
        edits.push((significant[position].span, quote_postgres_identifier(&input.target_owner)));
        edits.push((significant[position + 2].span, quote_postgres_identifier(&input.name)));
    } else {
        edits.push((
            significant[position].span,
            format!("{}.{}", quote_postgres_identifier(&input.target_owner), quote_postgres_identifier(&input.name)),
        ));
    }
    let mut ranges = edits
        .into_iter()
        .map(|(span, replacement)| {
            let start = routine_location_to_byte_offset(&source, span.start)
                .ok_or("Cannot locate routine declaration token")?;
            let end =
                routine_location_to_byte_offset(&source, span.end).ok_or("Cannot locate routine declaration token")?;
            Ok((start, end, replacement))
        })
        .collect::<Result<Vec<_>, String>>()?;
    ranges.sort_by_key(|(start, _, _)| *start);
    for (start, end, replacement) in ranges.into_iter().rev() {
        source.replace_range(start..end, &replacement);
    }
    let sql = ensure_oracle_ddl_terminated(&source);
    validate_oracle_object_source(
        input.database_type,
        &input.object_type,
        Some(&input.target_owner),
        &input.name,
        &sql,
    )?;
    Ok(sql)
}

pub fn comparable_oracle_routine_definition(mut input: OracleRoutineDefinitionInput) -> Result<String, String> {
    input.replace = true;
    let database_type = input.database_type;
    let object_type = input.object_type.clone();
    let schema = input.target_owner.clone();
    let name = input.name.clone();
    let source = prepare_oracle_routine_definition(input)?;
    fingerprint_oracle_routine_object_source(EditableObjectSourceSqlInput {
        database_type,
        object_type,
        schema: Some(schema),
        name,
        source,
    })
}

pub fn compact_oracle_ddl(source: &str) -> Result<String, String> {
    let tokens =
        Tokenizer::new(&OracleDialect {}, source).tokenize_with_location().map_err(|error| error.to_string())?;
    let mut result = String::new();
    let mut cursor = 0;
    for token in tokens.iter().filter(|token| {
        !matches!(
            token.token,
            Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline) | Token::EOF
        )
    }) {
        let start = routine_location_to_byte_offset(source, token.span.start).ok_or("Cannot locate DDL token")?;
        let end = routine_location_to_byte_offset(source, token.span.end).ok_or("Cannot locate DDL token")?;
        let gap = &source[cursor..start];
        if let Some(last_newline) = gap.rfind(['\r', '\n']) {
            result.push_str(if gap.contains("\r\n") {
                "\r\n"
            } else if gap.contains('\r') {
                "\r"
            } else {
                "\n"
            });
            result.push_str(&gap[last_newline + 1..]);
        } else if cursor == 0 {
            result.push_str(gap);
        } else if !gap.is_empty() {
            result.push(' ');
        }
        result.push_str(&source[start..end]);
        cursor = end;
    }
    result.push_str(&source[cursor..]);
    Ok(result)
}

fn strip_client_delimiter(source: &str) -> Result<String, String> {
    let tokens =
        Tokenizer::new(&OracleDialect {}, source).tokenize_with_location().map_err(|error| error.to_string())?;
    let Some(last) = tokens.iter().rev().find(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF)) else {
        return Err("Routine definition is empty".into());
    };
    if last.token != Token::Div {
        return Ok(source.into());
    }
    let start =
        routine_location_to_byte_offset(source, last.span.start).ok_or("Cannot locate Oracle client delimiter")?;
    let end = routine_location_to_byte_offset(source, last.span.end).ok_or("Cannot locate Oracle client delimiter")?;
    let line_start = source[..start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = source[end..].find('\n').map_or(source.len(), |index| end + index);
    if source[line_start..line_end].trim() != "/" {
        return Err("An Oracle client slash delimiter must be on a separate line".into());
    }
    let mut result = source.to_string();
    result.replace_range(start..end, "");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_ddl_preserves_token_text_comments_and_line_boundaries() {
        let source = "CREATE   FUNCTION \"中  文\" RETURN NUMBER AS\r\n\r\n  X VARCHAR2(20) := q'[a  b]'; -- keep  comment\r\nBEGIN\r\n  RETURN 1 -  - 2;\r\nEND;\r\n/\r\n";
        let compact = compact_oracle_ddl(source).unwrap();
        assert!(compact.starts_with("CREATE FUNCTION"));
        assert!(compact.contains("AS\r\n  X"));
        assert!(compact.contains("-- keep  comment\r\nBEGIN"));
        assert!(compact.ends_with("END;\r\n/\r\n"));
        let significant = |sql: &str| {
            Tokenizer::new(&OracleDialect {}, sql)
                .tokenize()
                .unwrap()
                .into_iter()
                .filter(|token| {
                    !matches!(
                        token,
                        Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline) | Token::EOF
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(significant(source), significant(&compact));
        assert_eq!(compact_oracle_ddl(&compact).unwrap(), compact);
    }

    fn input(source: &str) -> OracleRoutineDefinitionInput {
        OracleRoutineDefinitionInput {
            database_type: DatabaseType::OceanbaseOracle,
            object_type: ObjectSourceKind::Function,
            source_owner: "Source.Owner".into(),
            target_owner: "Target.Owner".into(),
            name: "Mixed.Func".into(),
            source: source.into(),
            replace: false,
        }
    }

    #[test]
    fn adapts_only_declaration_and_keeps_literals_comments_and_raw_input() {
        let source = r#"-- Source.Owner.Mixed.Func remains here
CREATE OR REPLACE NONEDITIONABLE FUNCTION "Source.Owner"."Mixed.Func" RETURN VARCHAR2 AS
BEGIN RETURN q'[Source.Owner.Mixed.Func  text]'; END;
/
"#;
        let original = input(source);
        let sql = prepare_oracle_routine_definition(original.clone()).unwrap();
        assert!(sql.contains("CREATE   NONEDITIONABLE FUNCTION \"Target.Owner\".\"Mixed.Func\""));
        assert!(sql.contains("-- Source.Owner.Mixed.Func remains here"));
        assert!(sql.contains("q'[Source.Owner.Mixed.Func  text]'"));
        assert!(!sql.lines().any(|line| line.trim() == "/"));
        assert_eq!(original.source, source);
    }

    #[test]
    fn bare_source_gets_an_exact_create_without_replace() {
        let sql =
            prepare_oracle_routine_definition(input(r#"FUNCTION "Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END"#))
                .unwrap();
        assert!(sql.starts_with("CREATE   FUNCTION \"Target.Owner\".\"Mixed.Func\""));
        assert!(!sql.contains("OR REPLACE"));
        assert!(sql.ends_with(';'));
    }

    #[test]
    fn replacement_preserves_declaration_comments() {
        let mut definition = input(
            r#"CREATE /* create */ OR /* or */ REPLACE FUNCTION "Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END;"#,
        );
        definition.replace = true;
        let sql = prepare_oracle_routine_definition(definition).unwrap();
        assert!(sql.starts_with("CREATE OR REPLACE /* create */  /* or */  FUNCTION"));
    }

    #[test]
    fn comparison_maps_only_declaration_and_outer_representation() {
        let left = input(r#"FUNCTION "Source.Owner"."Mixed.Func" RETURN VARCHAR2 AS BEGIN RETURN 'a  b'; END"#);
        let mut right = input("CREATE OR REPLACE FUNCTION \"Target.Owner\".\"Mixed.Func\" RETURN VARCHAR2 AS\nBEGIN RETURN 'a  b'; END;\n/");
        right.source_owner = "Target.Owner".into();
        assert_eq!(
            comparable_oracle_routine_definition(left.clone()).unwrap(),
            comparable_oracle_routine_definition(right.clone()).unwrap()
        );
        right.source = right.source.replace("a  b", "a b");
        assert_ne!(
            comparable_oracle_routine_definition(left).unwrap(),
            comparable_oracle_routine_definition(right).unwrap()
        );
    }

    #[test]
    fn edition_and_body_comments_are_not_normalized_away() {
        let base =
            input(r#"CREATE EDITIONABLE FUNCTION "Mixed.Func" RETURN NUMBER AS BEGIN /* keep */ RETURN 1; END;"#);
        let other = OracleRoutineDefinitionInput {
            source: base.source.replace("EDITIONABLE", "NONEDITIONABLE"),
            ..base.clone()
        };
        assert_ne!(
            comparable_oracle_routine_definition(base.clone()).unwrap(),
            comparable_oracle_routine_definition(other).unwrap()
        );
        let other =
            OracleRoutineDefinitionInput { source: base.source.replace("/* keep */", "/* changed */"), ..base.clone() };
        assert_ne!(
            comparable_oracle_routine_definition(base).unwrap(),
            comparable_oracle_routine_definition(other).unwrap()
        );
    }

    #[test]
    fn rejects_wrong_identity_kind_or_extra_statements() {
        for source in [
            r#"CREATE FUNCTION "Wrong.Owner"."Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END;"#,
            r#"CREATE FUNCTION "Other.Func" RETURN NUMBER AS BEGIN RETURN 1; END;"#,
            r#"CREATE PROCEDURE "Mixed.Func" AS BEGIN NULL; END;"#,
            r#"CREATE FUNCTION "Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END; DELETE FROM ACCOUNTS;"#,
        ] {
            assert!(prepare_oracle_routine_definition(input(source)).is_err(), "{source}");
        }
    }

    #[test]
    fn target_validation_does_not_execute_a_bare_body_or_widen_create_to_replace() {
        let check = |source: &str, replace| {
            validate_oracle_routine_target_definition(
                EditableObjectSourceSqlInput {
                    database_type: DatabaseType::OceanbaseOracle,
                    object_type: ObjectSourceKind::Function,
                    schema: Some("Target.Owner".into()),
                    name: "Mixed.Func".into(),
                    source: source.into(),
                },
                replace,
            )
        };
        let create = r#"CREATE FUNCTION "Target.Owner"."Mixed.Func" RETURN NUMBER AS BEGIN RETURN 1; END;"#;
        assert!(check(create, Some(false)).is_ok());
        assert!(check(&create.replacen("CREATE", "CREATE OR REPLACE", 1), Some(false)).is_err());
        assert!(check(create.strip_prefix("CREATE ").unwrap(), None).is_err());
        assert!(check(&create.replacen("CREATE", "CREATE OR REPLACE", 1), None).is_ok());
    }

    #[test]
    fn package_body_adaptation_preserves_the_complete_static_business_body() {
        let source = include_str!("../../tests/fixtures/oracle_package_flow_body.sql");
        let mut definition = input(source);
        definition.object_type = ObjectSourceKind::PackageBody;
        definition.name = "PKG_FLOW".into();
        let sql = prepare_oracle_routine_definition(definition).unwrap();
        assert!(sql.contains("PACKAGE BODY \"Target.Owner\".\"PKG_FLOW\" AS"));
        assert_eq!(sql[sql.find('\n').unwrap()..].trim_end(), source[source.find('\n').unwrap()..].trim_end());
    }

    #[test]
    fn package_specification_comparison_preserves_literals_and_kind() {
        let mut source = input("CREATE PACKAGE \"Source.Owner\".\"Mixed.Func\" AS label CONSTANT VARCHAR2(50) := q'[Source.Owner 中文😀]'; END \"Mixed.Func\";");
        source.object_type = ObjectSourceKind::Package;
        let mut target = source.clone();
        target.source_owner = "Target.Owner".into();
        target.source = target.source.replacen("\"Source.Owner\".", "\"Target.Owner\".", 1);
        assert_eq!(
            comparable_oracle_routine_definition(source.clone()).unwrap(),
            comparable_oracle_routine_definition(target.clone()).unwrap()
        );
        target.source = target.source.replace("中文😀", "changed");
        assert_ne!(
            comparable_oracle_routine_definition(source).unwrap(),
            comparable_oracle_routine_definition(target).unwrap()
        );
    }

    #[test]
    fn package_target_validation_rejects_wrong_kind_and_additional_statements() {
        let source = "CREATE PACKAGE \"Target.Owner\".\"Mixed.Func\" AS n NUMBER; END \"Mixed.Func\";";
        let check = |source: &str, kind| {
            validate_oracle_routine_target_definition(
                EditableObjectSourceSqlInput {
                    database_type: DatabaseType::OceanbaseOracle,
                    object_type: kind,
                    schema: Some("Target.Owner".into()),
                    name: "Mixed.Func".into(),
                    source: source.into(),
                },
                Some(false),
            )
        };
        assert!(check(source, ObjectSourceKind::Package).is_ok());
        assert!(check(source, ObjectSourceKind::PackageBody).is_err());
        assert!(check(source.strip_prefix("CREATE ").unwrap(), ObjectSourceKind::Package).is_err());
        assert!(check(&format!("{source}\nBEGIN NULL; END;"), ObjectSourceKind::Package).is_err());
    }
}
