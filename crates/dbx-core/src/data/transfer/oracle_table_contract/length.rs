use super::{character_lengths, parse_create_table, table_shape, table_tokens, LengthSemantics, TableShape};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertedLengthUnit {
    pub column: String,
    pub kind: String,
    pub length: u64,
    pub semantics: LengthSemantics,
}

pub(super) struct FinalTableDdl {
    pub sql: String,
    pub shape: TableShape,
    pub inserted_units: Vec<InsertedLengthUnit>,
}

pub(super) fn finalize_length_semantics(
    sql: &str,
    owner: &str,
    name: &str,
    choice: Option<LengthSemantics>,
) -> Result<FinalTableDdl, String> {
    parse_create_table(sql)?;
    let tokens = table_tokens(sql)?;
    let missing =
        character_lengths(&tokens)?.into_iter().filter(|column| column.semantics.is_none()).collect::<Vec<_>>();
    let mut final_sql = sql.to_owned();
    let mut inserted_units = Vec::new();
    if !missing.is_empty() {
        let choice =
            choice.ok_or("Read and review the target character length unit before confirming this table draft")?;
        let text = match choice {
            LengthSemantics::Bytes => " BYTE",
            LengthSemantics::Characters => " CHAR",
        };
        let mut offsets = Vec::new();
        for column in missing {
            let location = tokens[column.close_index].span.start;
            let offset = byte_offset(sql, location)?;
            if !sql[offset..].starts_with(')') {
                return Err("The character length token no longer matches the complete table draft".into());
            }
            offsets.push(offset);
            inserted_units.push(InsertedLengthUnit {
                column: column.column,
                kind: column.kind,
                length: column.length,
                semantics: choice,
            });
        }
        for offset in offsets.into_iter().rev() {
            final_sql.insert_str(offset, text);
        }
    }
    let shape = table_shape(&final_sql, owner, name, None)?;
    Ok(FinalTableDdl { sql: final_sql, shape, inserted_units })
}

fn byte_offset(sql: &str, location: sqlparser::tokenizer::Location) -> Result<usize, String> {
    let (mut line, mut column) = (1, 1);
    for (offset, value) in sql.char_indices() {
        if line == location.line && column == location.column {
            return Ok(offset);
        }
        if value == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    Err("The character length location is outside the original UTF-8 table draft".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_length_units_preserve_every_other_byte_and_are_idempotent() {
        let sql = "CREATE TABLE \"T.With.Dot\" (\r\n \"混合😀\" VARCHAR2 /* 中文 */ (20),\r\n C CHAR(3), V VARCHAR2(7 CHAR), N NVARCHAR2(12), X RAW(4) DEFAULT q'[CHAR(3); 😀)]'\r\n) COMPRESS FOR ARCHIVE PCTFREE = 0; -- CHAR(3)";
        let expected = "CREATE TABLE \"T.With.Dot\" (\r\n \"混合😀\" VARCHAR2 /* 中文 */ (20 BYTE),\r\n C CHAR(3 BYTE), V VARCHAR2(7 CHAR), N NVARCHAR2(12), X RAW(4) DEFAULT q'[CHAR(3); 😀)]'\r\n) COMPRESS FOR ARCHIVE PCTFREE = 0; -- CHAR(3)";
        let result = finalize_length_semantics(sql, "OWNER", "T.With.Dot", Some(LengthSemantics::Bytes)).unwrap();
        assert_eq!(result.sql, expected);
        assert_eq!(result.inserted_units.len(), 2);
        assert_eq!(result.inserted_units[0].column, "混合😀");
        assert_eq!(result.inserted_units[1].column, "C");
        assert_eq!(table_shape(expected, "OWNER", "T.With.Dot", None).unwrap(), result.shape);
        let again = finalize_length_semantics(expected, "OWNER", "T.With.Dot", None).unwrap();
        assert_eq!(again.sql, expected);
        assert!(again.inserted_units.is_empty());
    }

    #[test]
    fn an_unconfirmed_choice_or_wrong_target_cannot_produce_a_final_table() {
        assert!(finalize_length_semantics("CREATE TABLE T(V VARCHAR2(20))", "OWNER", "T", None).is_err());
        assert!(finalize_length_semantics(
            "CREATE TABLE OTHER.T(V VARCHAR2(20))",
            "OWNER",
            "T",
            Some(LengthSemantics::Bytes)
        )
        .is_err());
        let result = finalize_length_semantics(
            "CREATE TABLE T(C CHAR(3), V VARCHAR2(20 BYTE), N NCHAR(3))",
            "OWNER",
            "T",
            Some(LengthSemantics::Characters),
        )
        .unwrap();
        assert_eq!(result.sql, "CREATE TABLE T(C CHAR(3 CHAR), V VARCHAR2(20 BYTE), N NCHAR(3))");
        assert_eq!(
            result.inserted_units,
            [InsertedLengthUnit {
                column: "C".into(),
                kind: "CHAR".into(),
                length: 3,
                semantics: LengthSemantics::Characters
            }]
        );
        let explicit =
            finalize_length_semantics("CREATE TABLE T(C CHAR(3 CHAR), V VARCHAR2(20 BYTE))", "OWNER", "T", None)
                .unwrap();
        assert!(explicit.inserted_units.is_empty());
        assert_eq!(explicit.sql, "CREATE TABLE T(C CHAR(3 CHAR), V VARCHAR2(20 BYTE))");
    }

    #[test]
    fn malformed_character_units_do_not_get_reinterpreted_by_the_generic_parser() {
        for sql in [
            "CREATE TABLE T(V VARCHAR2(20,CHAR))",
            "CREATE TABLE T(V VARCHAR2(20 CHAR BYTE))",
            "CREATE TABLE T(V VARCHAR2(20 UNKNOWN))",
            "CREATE TABLE T(V VARCHAR2(0))",
            "CREATE TABLE T(V VARCHAR2(20)) UNKNOWN_STORAGE = 1",
            "CREATE TABLE T(V VARCHAR2(20)); DROP TABLE OTHER",
        ] {
            assert!(finalize_length_semantics(sql, "OWNER", "T", Some(LengthSemantics::Bytes)).is_err(), "{sql}");
        }
    }
}
