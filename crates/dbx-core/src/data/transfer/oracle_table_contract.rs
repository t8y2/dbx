use sqlparser::{
    ast::{CreateTable, Statement},
    dialect::OracleDialect,
    parser::Parser,
    tokenizer::{Token, TokenWithSpan, Tokenizer},
};
use std::collections::BTreeSet;

#[path = "oracle_table_contract/types.rs"]
mod types;
pub(crate) use types::LengthSemantics;
#[path = "oracle_table_contract/frozen.rs"]
mod frozen;
pub use frozen::FrozenTableDdl;
#[path = "oracle_table_contract/length.rs"]
mod length;

pub(crate) struct CatalogTableColumn {
    pub id: u64,
    pub name: String,
    pub data_type: String,
    pub data_type_owner: Option<String>,
    pub data_length: u64,
    pub char_length: u64,
    pub char_used: Option<String>,
    pub precision: Option<u64>,
    pub scale: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TableShape {
    owner: String,
    name: String,
    columns: Vec<(String, types::ColumnType)>,
}

pub(crate) fn planned_columns(sql: &str, owner: &str, name: &str) -> Result<BTreeSet<String>, String> {
    let table = parse_create_table(sql)?;
    let effective = |identifier: &sqlparser::ast::Ident| {
        if identifier.quote_style.is_some() {
            identifier.value.clone()
        } else {
            identifier.value.to_uppercase()
        }
    };
    let parts = table
        .name
        .0
        .iter()
        .map(|part| part.as_ident().map(&effective).ok_or("The table target is not an exact identifier"))
        .collect::<Result<Vec<_>, _>>()?;
    if !matches!(parts.as_slice(), [table] if table == name)
        && !matches!(parts.as_slice(), [schema, table] if schema == owner && table == name)
    {
        return Err("The final table DDL belongs to another target identity".into());
    }
    let columns = table.columns.iter().map(|column| effective(&column.name)).collect::<BTreeSet<_>>();
    if columns.len() != table.columns.len() {
        return Err("The final table has duplicate effective column names".into());
    }
    Ok(columns)
}

pub(crate) fn needs_length_choice(sql: &str) -> Result<bool, String> {
    parse_create_table(sql)?;
    Ok(character_lengths(&table_tokens(sql)?)?.iter().any(|column| column.semantics.is_none()))
}

pub(super) fn table_shape(
    sql: &str,
    owner: &str,
    name: &str,
    default_length: Option<LengthSemantics>,
) -> Result<TableShape, String> {
    let table = parse_create_table(sql)?;
    let effective = |identifier: &sqlparser::ast::Ident| {
        if identifier.quote_style.is_some() {
            identifier.value.clone()
        } else {
            identifier.value.to_uppercase()
        }
    };
    let parts = table
        .name
        .0
        .iter()
        .map(|part| part.as_ident().map(&effective).ok_or("The table target is not an exact identifier"))
        .collect::<Result<Vec<_>, _>>()?;
    let matches = match parts.as_slice() {
        [table] => table == name,
        [schema, table] => schema == owner && table == name,
        _ => false,
    };
    if !matches {
        return Err("The final table DDL belongs to another target identity".into());
    }
    let mut columns = Vec::new();
    let mut names = BTreeSet::new();
    for column in table.columns {
        let name = effective(&column.name);
        if !names.insert(name.clone()) {
            return Err("The final table has duplicate effective column names".into());
        }
        if column.options.iter().any(|option| {
            matches!(
                option.option,
                sqlparser::ast::ColumnOption::Generated { generation_expr: Some(_), .. }
                    | sqlparser::ast::ColumnOption::Materialized(_)
                    | sqlparser::ast::ColumnOption::Alias(_)
                    | sqlparser::ast::ColumnOption::Ephemeral(_)
            )
        }) {
            return Err(format!("Column {name} has an unverified generated shape; retain its complete table draft"));
        }
        let data_type =
            types::from_ast(&column.data_type, default_length).map_err(|error| format!("Column {name}: {error}"))?;
        columns.push((name, data_type));
    }
    Ok(TableShape { owner: owner.into(), name: name.into(), columns })
}

pub(super) fn parse_create_table(sql: &str) -> Result<CreateTable, String> {
    let dialect = OracleDialect {};
    let mut tokens = table_tokens(sql)?;
    let (_, close) = column_bounds(&tokens)?;
    check_physical_options(&tokens[close + 1..])?;
    for column in character_lengths(&tokens)? {
        if column.kind == "CHAR" && column.semantics.is_some() {
            if let Token::Word(word) = &mut tokens[column.type_index].token {
                word.keyword = sqlparser::keywords::Keyword::NoKeyword;
            }
        }
    }
    let mut statements = Parser::new(&dialect)
        .with_tokens_with_locations(tokens[..=close].to_vec())
        .parse_statements()
        .map_err(|error| error.to_string())?;
    if statements.len() != 1 {
        return Err("Expected one complete CREATE TABLE definition".into());
    }
    match statements.remove(0) {
        Statement::CreateTable(table)
            if !table.columns.is_empty()
                && !table.or_replace
                && !table.temporary
                && !table.external
                && table.global.is_none()
                && !table.if_not_exists
                && table.query.is_none()
                && table.like.is_none()
                && table.clone.is_none() =>
        {
            Ok(table)
        }
        _ => Err("Expected a CREATE TABLE definition".into()),
    }
}

fn table_tokens(sql: &str) -> Result<Vec<TokenWithSpan>, String> {
    let mut tokens =
        Tokenizer::new(&OracleDialect {}, sql).tokenize_with_location().map_err(|error| error.to_string())?;
    tokens.retain(|token| !matches!(token.token, Token::Whitespace(_)));
    if tokens.last().is_some_and(|token| token.token == Token::SemiColon) {
        tokens.pop();
    }
    Ok(tokens)
}

fn column_bounds(tokens: &[TokenWithSpan]) -> Result<(usize, usize), String> {
    let open = tokens
        .iter()
        .position(|token| token.token == Token::LParen)
        .ok_or("Expected an explicit complete table column list")?;
    let mut depth = 0;
    let close = tokens
        .iter()
        .enumerate()
        .skip(open)
        .find_map(|(index, token)| {
            match token.token {
                Token::LParen => depth += 1,
                Token::RParen => depth -= 1,
                _ => (),
            }
            (depth == 0).then_some(index)
        })
        .ok_or("The table column list is incomplete")?;
    Ok((open, close))
}

struct CharacterLengthColumn {
    column: String,
    kind: String,
    length: u64,
    semantics: Option<LengthSemantics>,
    type_index: usize,
    close_index: usize,
}

fn character_lengths(tokens: &[TokenWithSpan]) -> Result<Vec<CharacterLengthColumn>, String> {
    let (open, close) = column_bounds(tokens)?;
    let mut start = open + 1;
    let mut depth = 0;
    let mut output = Vec::new();
    for index in open + 1..=close {
        match tokens[index].token {
            Token::LParen => depth += 1,
            Token::RParen if depth > 0 => depth -= 1,
            _ => (),
        }
        if index != close && !(depth == 0 && tokens[index].token == Token::Comma) {
            continue;
        }
        let segment = &tokens[start..index];
        if let [column, data_type, ..] = segment {
            let is_character = word(Some(data_type), "CHAR") || word(Some(data_type), "VARCHAR2");
            if is_character {
                let Token::Word(column) = &column.token else {
                    return Err("The character column has no exact identity".into());
                };
                let name =
                    if column.quote_style.is_some() { column.value.clone() } else { column.value.to_uppercase() };
                if segment.get(2).map(|token| &token.token) != Some(&Token::LParen) {
                    return Err(format!("Column {name} requires an explicit character length"));
                }
                let Some(Token::Number(length, false)) = segment.get(3).map(|token| &token.token) else {
                    return Err(format!("Column {name} has an unverified character length"));
                };
                let length =
                    length.parse::<u64>().ok().filter(|length| *length > 0).ok_or("The character length is invalid")?;
                let (semantics, end) = if segment.get(4).map(|token| &token.token) == Some(&Token::RParen) {
                    (None, 4)
                } else if word(segment.get(4), "BYTE") {
                    (Some(LengthSemantics::Bytes), 5)
                } else if word(segment.get(4), "CHAR") {
                    (Some(LengthSemantics::Characters), 5)
                } else {
                    return Err(format!("Column {name} has an unverified length unit"));
                };
                if segment.get(end).map(|token| &token.token) != Some(&Token::RParen) {
                    return Err(format!("Column {name} has incomplete length parameters"));
                }
                output.push(CharacterLengthColumn {
                    column: name,
                    kind: if word(Some(data_type), "CHAR") { "CHAR" } else { "VARCHAR2" }.into(),
                    length,
                    semantics,
                    type_index: start + 1,
                    close_index: start + end,
                });
            }
        }
        start = index + 1;
    }
    Ok(output)
}

fn word(token: Option<&TokenWithSpan>, expected: &str) -> bool {
    matches!(token.map(|token| &token.token), Some(Token::Word(word))
        if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected))
}

fn check_physical_options(tokens: &[TokenWithSpan]) -> Result<(), String> {
    let mut index = 0;
    let mut seen = BTreeSet::new();
    while let Some(token) = tokens.get(index) {
        let fail = || {
            format!(
                "Unverified table storage clause at line {}, column {}",
                token.span.start.line, token.span.start.column
            )
        };
        let Token::Word(option) = &token.token else {
            return Err(fail());
        };
        if option.quote_style.is_some() {
            return Err(fail());
        }
        let option = option.value.to_ascii_uppercase();
        if !seen.insert(option.clone()) {
            return Err(fail());
        }
        if option == "COMPRESS" {
            if !word(tokens.get(index + 1), "FOR") || !word(tokens.get(index + 2), "ARCHIVE") {
                return Err(fail());
            }
            index += 3;
            continue;
        }
        if !matches!(option.as_str(), "REPLICA_NUM" | "BLOCK_SIZE" | "USE_BLOOM_FILTER" | "TABLET_SIZE" | "PCTFREE")
            || tokens.get(index + 1).map(|token| &token.token) != Some(&Token::Eq)
        {
            return Err(fail());
        }
        let value = tokens.get(index + 2);
        if option == "USE_BLOOM_FILTER" {
            if !word(value, "TRUE") && !word(value, "FALSE") {
                return Err(fail());
            }
        } else {
            let Some(Token::Number(number, false)) = value.map(|token| &token.token) else {
                return Err(fail());
            };
            let number = number.parse::<u64>().map_err(|_| fail())?;
            if (option == "PCTFREE" && number > 99) || (option != "PCTFREE" && number == 0) {
                return Err(fail());
            }
        }
        index += 3;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::types::{from_ast, from_catalog, CatalogColumnType, ColumnType, LengthSemantics};
    use super::*;

    const OB_DDL: &str = "CREATE TABLE \"PKG_MIXED_TYPE_PROBE\" (\n  \"N\" NUMBER(12,3),\n  \"V\" VARCHAR2(20 CHAR),\n  \"B\" VARCHAR2(20),\n  \"D\" VARCHAR2(20),\n  \"T\" TIMESTAMP(6),\n  \"Z\" TIMESTAMP(3) WITH TIME ZONE,\n  \"Mixed列\" RAW(16)\n) COMPRESS FOR ARCHIVE REPLICA_NUM = 1 BLOCK_SIZE = 16384 USE_BLOOM_FILTER = FALSE TABLET_SIZE = 134217728 PCTFREE = 0";

    #[test]
    fn complete_ob_metadata_ddl_retains_all_column_types() {
        let table = parse_create_table(OB_DDL).unwrap();
        assert_eq!(table.name.to_string(), "\"PKG_MIXED_TYPE_PROBE\"");
        assert_eq!(table.columns.len(), 7);
        let sqlparser::ast::DataType::Custom(name, parameters) = &table.columns[0].data_type else {
            panic!("Expected Oracle NUMBER parameters");
        };
        assert_eq!(name.to_string(), "NUMBER");
        assert_eq!(parameters, &["12", "3"]);
        let sqlparser::ast::DataType::Custom(name, parameters) = &table.columns[1].data_type else {
            panic!("Expected Oracle VARCHAR2 length semantics");
        };
        assert_eq!(name.to_string(), "VARCHAR2");
        assert_eq!(parameters, &["20", "CHAR"]);
        assert_eq!(table.columns[5].data_type.to_string(), "TIMESTAMP(3) WITH TIME ZONE");
        assert_eq!(table.columns[6].name.value, "Mixed列");
    }

    #[test]
    fn unknown_duplicate_or_malformed_tail_and_additional_statements_are_not_ignored() {
        for suffix in [
            "UNKNOWN_OPTION = 1",
            "COMPRESS FOR QUERY",
            "REPLICA_NUM = 0",
            "BLOCK_SIZE = -1",
            "TABLET_SIZE = 1.5",
            "PCTFREE = 100",
            "USE_BLOOM_FILTER = MAYBE",
            "REPLICA_NUM = 1 REPLICA_NUM = 2",
            "COMPRESS FOR ARCHIVE COMPRESS FOR ARCHIVE",
            "PCTFREE = 1e2",
            "REPLICA_NUM =",
            "; ALTER TABLE T ADD X NUMBER",
            "; CREATE TABLE OTHER (X NUMBER)",
        ] {
            assert!(parse_create_table(&format!("CREATE TABLE T (N NUMBER) {suffix}")).is_err(), "{suffix}");
        }
    }

    #[test]
    fn column_parentheses_quotes_and_comments_do_not_end_the_definition_early() {
        let sql = "CREATE TABLE \"T.With.Dot\" (\"Mixed列\" VARCHAR2(20 CHAR) DEFAULT q'[); COMPRESS]', N NUMBER(12,3) CHECK (N >= 0)) /* ) */ COMPRESS FOR ARCHIVE PCTFREE = 0; -- trailing";
        let table = parse_create_table(sql).unwrap();
        assert_eq!(table.name.to_string(), "\"T.With.Dot\"");
        assert_eq!(table.columns.len(), 2);
    }

    #[test]
    fn ctas_incomplete_and_nonpermanent_definitions_are_not_typed_tables() {
        for sql in [
            "CREATE TABLE T AS SELECT 1 N FROM DUAL",
            "CREATE TABLE T (N NUMBER",
            "CREATE GLOBAL TEMPORARY TABLE T (N NUMBER)",
            "CREATE TABLE IF NOT EXISTS T (N NUMBER)",
            "SELECT F(N) FROM T",
        ] {
            assert!(parse_create_table(sql).is_err(), "{sql}");
        }
        assert!(parse_create_table("CREATE TABLE T (N NUMBER, V VARCHAR2(20 BYTE));").is_ok());
    }

    #[test]
    fn actual_ob_catalog_types_match_final_ddl_semantics_not_display_strings() {
        let table = parse_create_table(OB_DDL).unwrap();
        let observed = [
            ("NUMBER", 22, 0, None, Some(12), Some(3)),
            ("VARCHAR2", 80, 20, Some("C"), None, None),
            ("VARCHAR2", 20, 20, Some("B"), None, None),
            ("VARCHAR2", 20, 20, Some("B"), None, None),
            ("TIMESTAMP(6)", 11, 0, None, None, Some(6)),
            ("TIMESTAMP(3) WITH TIME ZONE", 13, 0, None, None, Some(3)),
            ("RAW", 16, 0, None, None, Some(-1)),
        ];
        for (column, (data_type, data_length, char_length, char_used, precision, scale)) in
            table.columns.iter().zip(observed)
        {
            let actual = from_catalog(CatalogColumnType {
                data_type,
                data_type_owner: None,
                data_length,
                char_length,
                char_used,
                precision,
                scale,
            })
            .unwrap();
            assert_eq!(from_ast(&column.data_type, Some(LengthSemantics::Bytes)).unwrap(), actual, "{}", column.name);
        }
        assert!(from_ast(&table.columns[2].data_type, None).is_err());
        assert!(matches!(
            from_ast(&table.columns[1].data_type, None).unwrap(),
            ColumnType::Character { semantics: LengthSemantics::Characters, length: 20, .. }
        ));
    }

    #[test]
    fn changed_types_or_incomplete_catalog_fields_do_not_become_equivalent() {
        let table =
            parse_create_table("CREATE TABLE T (N NUMBER(12,3), R RAW(16), S TIMESTAMP(3) WITH TIME ZONE)").unwrap();
        assert_ne!(
            from_ast(&table.columns[0].data_type, None).unwrap(),
            from_catalog(CatalogColumnType {
                data_type: "NUMBER",
                data_type_owner: None,
                data_length: 22,
                char_length: 0,
                char_used: None,
                precision: Some(12),
                scale: Some(0)
            })
            .unwrap()
        );
        assert_ne!(
            from_ast(&table.columns[1].data_type, None).unwrap(),
            from_catalog(CatalogColumnType {
                data_type: "RAW",
                data_type_owner: None,
                data_length: 8,
                char_length: 0,
                char_used: None,
                precision: None,
                scale: Some(-1)
            })
            .unwrap()
        );
        assert!(from_catalog(CatalogColumnType {
            data_type: "VARCHAR2",
            data_type_owner: None,
            data_length: 20,
            char_length: 20,
            char_used: None,
            precision: None,
            scale: None
        })
        .is_err());
        assert!(from_catalog(CatalogColumnType {
            data_type: "TIMESTAMP(3) WITH TIME ZONE",
            data_type_owner: None,
            data_length: 13,
            char_length: 0,
            char_used: None,
            precision: None,
            scale: Some(6)
        })
        .is_err());
        assert_ne!(
            from_ast(&table.columns[0].data_type, None).unwrap(),
            from_catalog(CatalogColumnType {
                data_type: "NUMBER",
                data_type_owner: Some("OTHER"),
                data_length: 22,
                char_length: 0,
                char_used: None,
                precision: Some(12),
                scale: Some(3)
            })
            .unwrap()
        );
    }

    #[test]
    fn external_column_types_keep_exact_qualified_identity_not_unverified_local_aliases() {
        let frozen = FrozenTableDdl::from_server_plan(
            "S",
            "T",
            "FINAL",
            "CREATE TABLE FINAL (A ext.shape, B \"Owner.With.Dot\".\"Mixed列\")",
            serde_json::json!({}),
            None,
        )
        .unwrap();
        assert_eq!(
            frozen.external_types(),
            BTreeSet::from([("EXT".into(), "SHAPE".into()), ("Owner.With.Dot".into(), "Mixed列".into())])
        );
        for sql in ["CREATE TABLE FINAL(A SHAPE)", "CREATE TABLE FINAL(A ext.shape(12))", "CREATE TABLE FINAL(A LONG)"]
        {
            assert!(
                FrozenTableDdl::from_server_plan("S", "T", "FINAL", sql, serde_json::json!({}), None).is_err(),
                "{sql}"
            );
        }
        frozen
            .verify_catalog_columns(&[
                CatalogTableColumn {
                    id: 16,
                    name: "A".into(),
                    data_type: "SHAPE".into(),
                    data_type_owner: Some("EXT".into()),
                    data_length: 0,
                    char_length: 0,
                    char_used: None,
                    precision: None,
                    scale: None,
                },
                CatalogTableColumn {
                    id: 17,
                    name: "B".into(),
                    data_type: "Mixed列".into(),
                    data_type_owner: Some("Owner.With.Dot".into()),
                    data_length: 0,
                    char_length: 0,
                    char_used: None,
                    precision: None,
                    scale: None,
                },
            ])
            .unwrap();
    }

    #[test]
    fn final_target_and_effective_column_names_are_exact_and_ordered() {
        let shape = table_shape(
            "CREATE TABLE \"Target.With.Dot\".\"T\" (source_name NUMBER(12,3), \"Mixed列\" RAW(16))",
            "Target.With.Dot",
            "T",
            None,
        )
        .unwrap();
        assert_eq!(shape.columns.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["SOURCE_NAME", "Mixed列"]);
        assert!(table_shape("CREATE TABLE \"Other\".T(N NUMBER)", "Target.With.Dot", "T", None).is_err());
        assert!(table_shape("CREATE TABLE T(N NUMBER, \"N\" NUMBER)", "Target.With.Dot", "T", None).is_err());
        assert!(table_shape(
            "CREATE TABLE T(N NUMBER, X NUMBER GENERATED ALWAYS AS (N+1) VIRTUAL)",
            "Target.With.Dot",
            "T",
            None
        )
        .is_err());
        let reordered = table_shape(
            "CREATE TABLE \"Target.With.Dot\".T(\"Mixed列\" RAW(16), source_name NUMBER(12,3))",
            "Target.With.Dot",
            "T",
            None,
        )
        .unwrap();
        assert_ne!(shape, reordered);
    }

    #[test]
    fn native_ast_variants_preserve_character_lob_and_binary_float_precision() {
        let sql = "CREATE TABLE T (C CHAR(10), D DATE, L CLOB, B BLOB, N NCHAR(10), V NVARCHAR2(12), F FLOAT(8))";
        let shape = table_shape(sql, "OWNER", "T", Some(LengthSemantics::Bytes)).unwrap();
        assert_eq!(
            shape.columns.iter().map(|(_, kind)| kind.clone()).collect::<Vec<_>>(),
            [
                ColumnType::Character { kind: "CHAR".into(), length: 10, semantics: LengthSemantics::Bytes },
                ColumnType::Date,
                ColumnType::Clob,
                ColumnType::Blob,
                ColumnType::Character { kind: "NCHAR".into(), length: 10, semantics: LengthSemantics::Characters },
                ColumnType::Character { kind: "NVARCHAR2".into(), length: 12, semantics: LengthSemantics::Characters },
                ColumnType::Float(8),
            ]
        );
        assert!(table_shape(sql, "OWNER", "T", None).is_err());
        assert_eq!(
            from_catalog(CatalogColumnType {
                data_type: "FLOAT",
                data_type_owner: None,
                data_length: 22,
                char_length: 0,
                char_used: None,
                precision: Some(8),
                scale: None
            })
            .unwrap(),
            ColumnType::Float(8)
        );
        assert!(from_catalog(CatalogColumnType {
            data_type: "FLOAT",
            data_type_owner: None,
            data_length: 22,
            char_length: 0,
            char_used: None,
            precision: None,
            scale: None
        })
        .is_err());
        assert_eq!(
            table_shape("CREATE TABLE T (V OTHER.EXTERNAL_TYPE)", "OWNER", "T", None).unwrap().columns[0].1,
            ColumnType::External { owner: "OTHER".into(), name: "EXTERNAL_TYPE".into() }
        );
    }
}
