use crate::models::connection::DatabaseType;
use crate::sql_dialect::quote_table_data_identifier;
use sqlparser::dialect::{Dialect, GenericDialect, MsSqlDialect};
use sqlparser::tokenizer::{Token, Tokenizer};
use std::collections::HashSet;
use std::sync::OnceLock;

pub(super) fn unquote_optional_identifiers(
    reference: String,
    database_type: Option<DatabaseType>,
    identifier_quote: Option<&str>,
) -> String {
    let dialect: &dyn Dialect =
        if database_type == Some(DatabaseType::SqlServer) { &MsSqlDialect {} } else { &GenericDialect {} };
    let Ok(tokens) = Tokenizer::new(dialect, &reference).with_unescape(false).tokenize() else {
        return reference;
    };
    if tokens.iter().any(|token| !matches!(token, Token::Word(_) | Token::Period)) {
        return reference;
    }
    tokens
        .into_iter()
        .map(|token| match token {
            Token::Word(mut word) => {
                if word.quote_style.is_some() && can_unquote(&word.value, database_type, identifier_quote) {
                    word.quote_style = None;
                }
                word.to_string()
            }
            _ => token.to_string(),
        })
        .collect()
}

fn can_unquote(name: &str, database_type: Option<DatabaseType>, identifier_quote: Option<&str>) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    match database_type {
        Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle) => {
            first.is_ascii_uppercase()
                && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || matches!(ch, '_' | '$' | '#'))
                && !oracle_reserved(name)
        }
        Some(DatabaseType::Dameng) => {
            (first.is_ascii_uppercase() || first == '_')
                && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
                && !dameng_reserved(name)
        }
        Some(
            DatabaseType::Postgres
            | DatabaseType::Gaussdb
            | DatabaseType::OpenGauss
            | DatabaseType::Kingbase
            | DatabaseType::Jdbc,
        ) if identifier_quote != Some("`") => {
            quote_table_data_identifier(Some(DatabaseType::Postgres), name, Some("\"")) == name
        }
        _ => {
            let simple =
                |ch: char| ch.is_ascii_alphabetic() || matches!(ch, '_' | '$') || ('\u{80}'..='\u{ffff}').contains(&ch);
            let lower = name.to_ascii_lowercase();
            simple(first) && chars.all(|ch| simple(ch) || ch.is_ascii_digit()) && !mysql_reserved(&lower)
        }
    }
}

fn oracle_reserved(name: &str) -> bool {
    static KEYWORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    KEYWORDS
        .get_or_init(|| {
            concat!(
                "ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS ",
                "CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE ",
                "FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER ",
                "INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT ",
                "NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PRIVILEGES PUBLIC RAW RENAME ",
                "RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL ",
                "SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 ",
                "VIEW WHENEVER WHERE WITH",
            )
            .split_ascii_whitespace()
            .collect()
        })
        .contains(name)
}

fn dameng_reserved(name: &str) -> bool {
    static KEYWORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    KEYWORDS
        .get_or_init(|| {
            concat!(
                "ABSOLUTE ABSTRACT ADD ADMIN ALL ALTER AND ANY ARRAY ARRAYLEN AS ASC ASSIGN AUDIT AUTHORIZATION ",
                "AUTO_INCREMENT BEGIN BETWEEN BIGDATEDIFF BINARY BOOL BOTH BREAK BSTRING BY BYTE CALL CASE CAST CATCH ",
                "CHAR CHECK CLASS CLUSTER CLUSTERBTR COLLATION COLLECT COLUMN COMMENT COMMIT COMMITWORK CONNECT ",
                "CONNECT_BY_ROOT CONST CONSTRAINT CONTAINS CONTEXT CONTINUE CONVERT CORRESPONDING CREATE CROSS CRYPTO ",
                "CUBE CURRENT CURSOR DATEADD DATEDIFF DATEPART DECIMAL DECLARE DECODE DEFAULT DELETE DESC DISABLE ",
                "DISKSPACE DISTINCT DISTRIBUTED DO DOMAIN DOUBLE DROP ELSE ELSEIF ELSIF ENABLE END EQU EXCHANGE EXEC ",
                "EXECUTE EXISTS EXIT EXPLAIN EXTERN EXTRACT FETCH FINAL FINALLY FIRST FLASHBACK FLOAT FOR FOREIGN ",
                "FROM FULL FULLY FUNCTION GET GOTO GRANT GROUP GROUPING HAVING IDENTITY IF IFNULL IMMEDIATE IN INDEX ",
                "INLINE INNER INSERT INT INTERSECT INTERVAL INTO IS JOIN KEEP LEADING LEFT LEXER LIKE LIST LNNVL ",
                "LOGIN LOOP MEMBER MINUS MULTISET NATURAL NEW NEXT NOCOPY NOCYCLE NOT NULL OBJECT OF ON OR ORDER OUT ",
                "OVER OVERLAY OVERRIDE PARTITION PENDANT PERCENT PRIMARY PRINT PRIOR PRIVATE PRIVILEGES PROCEDURE ",
                "PROTECTED PUBLIC RAISE RECORD REF REFERENCE REFERENCES REFERENCING RELATIVE REPEAT REPLICATE RETURN ",
                "RETURNING REVERSE REVOKE RIGHT ROLLBACK ROLLUP ROW ROWNUM ROWS SAVEPOINT SBYTE SCHEMA SEALED SECTION ",
                "SELECT SET SETS SHORT SIZEOF SOME STATIC STRUCT SUBPARTITION SWITCH SYNONYM TABLE THROW TIMESTAMPADD ",
                "TIMESTAMPDIFF TO TOP TRAILING TRIGGER TRIM TRUNCATE TRY TYPEDEF TYPEOF UINT ULONG UNION UNIQUE UNTIL ",
                "UPDATE USER USHORT USING VALUES VARRAY VERIFY VIEW VIRTUAL VOID WHEN WHENEVER WHERE WHILE WITH ",
                "WITHIN XMLAGG XMLPARSE XMLTABLE",
            )
            .split_ascii_whitespace()
            .collect()
        })
        .contains(name)
}

fn mysql_reserved(name: &str) -> bool {
    static KEYWORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    KEYWORDS
        .get_or_init(|| {
            concat!(
                "all analyse analyze and any array as asc asymmetric authorization binary both case cast check ",
                "collate collation column concurrently constraint create cross current_catalog current_date ",
                "current_role current_schema current_time current_timestamp current_user default deferrable desc ",
                "distinct do else end except false fetch for foreign freeze from full grant group having ilike in ",
                "initially inner intersect into is isnull join lateral leading left like limit localtime ",
                "localtimestamp natural not notnull null offset on only or order outer overlaps placing primary ",
                "references returning right select session_user similar some symmetric system_user table tablesample ",
                "then to trailing true union unique user using variadic verbose when where window with accessible ",
                "auto_increment change database databases delayed describe div dual enclosed escaped explain force ",
                "fulltext high_priority ignore index infile key keys kill linear lines load lock low_priority ",
                "master_ssl_verify_server_cert maxvalue mediumint mod no_write_to_binlog optimize optionally outfile ",
                "partition purge range read_write regexp release rename replace require rlike schema schemas ",
                "separator show spatial sql_big_result sql_calc_found_rows sql_small_result ssl starting ",
                "straight_join terminated tinyint unlock unsigned use utc_date utc_time utc_timestamp values ",
                "varbinary varchar write xor zerofill",
            )
            .split_ascii_whitespace()
            .collect()
        })
        .contains(name)
}
