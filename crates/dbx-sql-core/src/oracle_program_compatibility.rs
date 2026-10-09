//! Pure fixed-version Oracle/OceanBase program compatibility and identity mapping.
//! Shared by schema comparison and transfer; no connections or execution state.
use crate::models::connection::DatabaseType;
use crate::types::RoutineDependency;
use regex::Regex;
use std::collections::HashSet;

#[derive(Debug, Clone, Default)]
pub struct OracleProgramContext {
    pub source_version: String,
    pub target_version: String,
    pub target_editions_disabled: bool,
    pub non_editioned_source_objects: Vec<(String, String)>,
    pub target_dependencies: Vec<(String, String, String)>,
    pub blocked_types: Vec<(String, String)>,
    pub blocked_bodies: Vec<(String, String)>,
}

pub fn conversion_source(
    sql: &str,
    kind: &str,
    name: &str,
    source: DatabaseType,
    target: DatabaseType,
    context: &OracleProgramContext,
) -> Result<String, String> {
    conversion_profile(&source, &context.source_version, &target, &context.target_version)?;
    if target == DatabaseType::Oracle && !context.target_editions_disabled {
        return Err("Oracle target schema edition status is enabled or unknown; conversion blocked".into());
    }
    if source == DatabaseType::Oracle
        && !context.non_editioned_source_objects.contains(&(name.to_string(), kind.to_string()))
    {
        return Err("Oracle source program edition state is unknown or editioned; conversion blocked".into());
    }
    let edition = Regex::new(r"(?is)^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?)(?:NONEDITIONABLE|EDITIONABLE)\s+").unwrap();
    if edition.is_match(sql) {
        if source != DatabaseType::Oracle {
            return Err("Source program edition conversion has not been confirmed".into());
        }
        return Ok(edition.replace(sql, "${1}").to_string());
    }
    Ok(sql.to_string())
}

pub fn identifier_word(word: &str) -> String {
    if word.starts_with('"') && word.ends_with('"') {
        word[1..word.len() - 1].replace("\"\"", "\"")
    } else {
        word.to_string()
    }
}

fn declaration_tail(sql: &str, kind: &str) -> Result<String, String> {
    let identifier = r#"(?:"(?:[^"]|"")*"|[\p{L}][\p{L}\p{N}_$#]*)"#;
    let pattern = Regex::new(&format!(r#"(?is)\A\s*(?:(?:/\*.*?\*/|--[^\r\n]*(?:\r?\n|$))\s*)*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?)TYPE\s+(?P<body>BODY\s+)?{identifier}(?:\s*\.\s*{identifier})?(?P<tail>.+)\z"#)).unwrap();
    let captures = pattern.captures(sql).ok_or("Cannot parse the complete TYPE declaration")?;
    if captures.name("body").is_some() != (kind == "TYPE BODY") || !matches!(kind, "TYPE" | "TYPE BODY") {
        return Err("TYPE specification/body source kind does not match metadata".into());
    }
    Ok(captures.name("tail").unwrap().as_str().to_string())
}

pub fn source_tokens(sql: &str) -> Vec<(usize, usize, String)> {
    let chars: Vec<_> = sql.char_indices().collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        let ch = chars[i].1;
        let at = |n: usize| chars.get(n).map(|(_, c)| *c);
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch == '-' && at(i + 1) == Some('-') {
            while i < chars.len() && at(i) != Some('\n') {
                i += 1;
            }
            continue;
        }
        if ch == '/' && at(i + 1) == Some('*') {
            i += 2;
            while i + 1 < chars.len() && !(at(i) == Some('*') && at(i + 1) == Some('/')) {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        let q = if matches!(ch, 'n' | 'N') && matches!(at(i + 1), Some('q' | 'Q')) { i + 1 } else { i };
        if matches!(at(q), Some('q' | 'Q')) && at(q + 1) == Some('\'') && at(q + 2).is_some() {
            let closer = match at(q + 2).unwrap() {
                '[' => ']',
                '{' => '}',
                '(' => ')',
                '<' => '>',
                c => c,
            };
            i = q + 3;
            while i + 1 < chars.len() && !(at(i) == Some(closer) && at(i + 1) == Some('\'')) {
                i += 1;
            }
            i = (i + 2).min(chars.len());
        } else if ch == '\'' || ch == '"' {
            i += 1;
            while i < chars.len() {
                if at(i) == Some(ch) {
                    i += 1;
                    if at(i) == Some(ch) {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if ch.is_alphanumeric() || ch == '_' {
            i += 1;
            while i < chars.len() && (chars[i].1.is_alphanumeric() || "_$#".contains(chars[i].1)) {
                i += 1;
            }
        } else {
            i += 1;
        }
        let from = chars[start].0;
        let to = chars.get(i).map_or(sql.len(), |c| c.0);
        let raw = &sql[from..to];
        let word = if raw.starts_with('"') {
            raw.to_string()
        } else if ch == '\'' || q != start || (matches!(ch, 'q' | 'Q') && at(start + 1) == Some('\'')) {
            "<literal>".into()
        } else {
            raw.to_ascii_uppercase()
        };
        result.push((from, to, word));
    }
    result
}
pub fn map_reference(sql: &str, owner: &str, name: &str, target: &str) -> Result<String, String> {
    map_reference_as(sql, owner, name, target, name)
}
pub fn map_reference_as(sql: &str, owner: &str, name: &str, target: &str, target_name: &str) -> Result<String, String> {
    let tokens = source_tokens(sql);
    if !tokens
        .windows(3)
        .any(|p| identifier_word(&p[0].2) == owner && p[1].2 == "." && identifier_word(&p[2].2) == name)
    {
        return Ok(sql.to_string());
    }
    // A parameter, attribute, variable or SQL alias can shadow a schema identifier.
    // Do not infer that its field access is a schema-qualified dependency.
    if tokens.iter().enumerate().any(|(i, t)| {
        identifier_word(&t.2) == owner
            && tokens.get(i + 1).is_some_and(|next| {
                next.2 != "." && next.2 != ":" && next.2 != "(" && next.2 != ")" && next.2 != "," && next.2 != ";"
            })
            && i.checked_sub(1).is_some_and(|p| {
                matches!(tokens[p].2.as_str(), "(" | "," | ";" | "IS" | "AS" | "DECLARE")
                    || (p > 0 && matches!(tokens[p - 1].2.as_str(), "FROM" | "JOIN"))
            })
    }) {
        return Err(format!(
            "Ambiguous schema reference: local binding shadows {owner}; automatic owner mapping is blocked"
        ));
    }
    let mut mapped = sql.to_string();
    for part in tokens.windows(3).rev() {
        if identifier_word(&part[0].2) == owner && part[1].2 == "." && identifier_word(&part[2].2) == name {
            if target_name != name {
                mapped.replace_range(part[2].0..part[2].1, &format!("\"{}\"", target_name.replace('"', "\"\"")));
            }
            mapped.replace_range(part[0].0..part[0].1, &format!("\"{}\"", target.replace('"', "\"\"")));
        }
    }
    Ok(mapped)
}
pub fn map_unqualified_table(sql: &str, name: &str, target: &str, target_name: &str) -> Result<String, String> {
    if name == target_name {
        return Ok(sql.to_string());
    }
    let tokens = source_tokens(sql);
    if tokens.iter().any(|t| t.2 == "WITH") {
        return Err("Renamed table references with WITH scopes require an explicit mapping; transfer blocked".into());
    }
    let mut mapped = sql.to_string();
    for (index, token) in tokens.iter().enumerate().rev() {
        if identifier_word(&token.2) == name
            && index > 0
            && matches!(tokens[index - 1].2.as_str(), "FROM" | "JOIN" | "INTO" | "UPDATE")
            && tokens.get(index + 1).is_none_or(|t| t.2 != ".")
        {
            mapped.replace_range(
                token.0..token.1,
                &format!("\"{}\".\"{}\"", target.replace('"', "\"\""), target_name.replace('"', "\"\"")),
            );
        }
    }
    Ok(mapped)
}

pub fn compatible_type_source(sql: &str, kind: &str, dependencies: &[RoutineDependency]) -> Result<(), String> {
    let tail = declaration_tail(sql, kind)?;
    let words = source_tokens(&tail).into_iter().map(|t| t.2).collect::<Vec<_>>();
    // These clauses carry identity, edition, inheritance or execution semantics that
    // the fixed 19c/21c ↔ 4.2.5 conversion profile does not translate.
    for keyword in [
        "OID",
        "UNDER",
        "FINAL",
        "INSTANTIABLE",
        "OVERRIDING",
        "MAP",
        "AUTHID",
        "EDITIONABLE",
        "NONEDITIONABLE",
        "SHARING",
        "ACCESSIBLE",
        "OPAQUE",
        "EXTERNAL",
        "LIBRARY",
        "LANGUAGE",
        "PRAGMA",
        "PIPELINED",
        "PARALLEL_ENABLE",
        "RESULT_CACHE",
        "SQL_MACRO",
        "XMLTYPE",
        "JSON",
        "BFILE",
        "NCLOB",
        "UROWID",
        "ROWID",
        "PERSISTABLE",
        "COLLATION",
    ] {
        if words.iter().any(|word| word == keyword) {
            return Err(format!("TYPE conversion does not support or confirm {keyword} semantics between Oracle 19c/21c and OceanBase 4.2.5"));
        }
    }
    if kind == "TYPE BODY" {
        for keyword in [
            "BULK",
            "FORALL",
            "EXECUTE",
            "IMMEDIATE",
            "OPEN",
            "CURSOR",
            "RECORD",
            "REF",
            "SQLERRM",
            "SQLCODE",
            "RAISE_APPLICATION_ERROR",
            "DETERMINISTIC",
            "NOCOPY",
            "SUBTYPE",
            "GOTO",
            "CONNECT",
            "MODEL",
            "MATCH_RECOGNIZE",
            "MERGE",
            "RETURNING",
            "PIVOT",
            "UNPIVOT",
            "SAMPLE",
            "VERSIONS",
            "PARTITION",
            "ROWTYPE",
            "TYPE",
            "LONG",
            "BLOB",
            "CLOB",
            "TIMESTAMP",
            "INTERVAL",
            "BINARY_FLOAT",
            "BINARY_DOUBLE",
            "NCHAR",
            "NVARCHAR2",
        ] {
            if words.iter().any(|word| word == keyword) {
                return Err(format!("TYPE BODY conversion has no confirmed mapping for {keyword}"));
            }
        }
        let tokens = source_tokens(&tail);
        for (index, _) in tokens.iter().enumerate().filter(|(_, t)| t.2 == "STATIC") {
            let end = tokens[index + 1..]
                .iter()
                .position(|t| matches!(t.2.as_str(), "MEMBER" | "STATIC"))
                .map_or(tokens.len(), |offset| index + 1 + offset);
            if tokens[index + 1..end].iter().any(|t| t.2 == "SELF") {
                return Err("STATIC TYPE methods cannot use implicit SELF".into());
            }
        }
        if tokens.windows(2).any(|p| p[0].2 == "=" && p[1].2 == ">") {
            return Err("Named-argument TYPE BODY conversion is not in the confirmed positional-call profile".into());
        }
        let methods: HashSet<_> = tokens
            .windows(2)
            .filter(|p| matches!(p[0].2.as_str(), "FUNCTION" | "PROCEDURE"))
            .map(|p| identifier_word(&p[1].2))
            .collect();
        for (index, token) in tokens.iter().enumerate() {
            if tokens.get(index + 1).map(|t| t.2.as_str()) != Some("(") {
                continue;
            }
            let name = identifier_word(&token.2);
            if [
                "NUMBER", "VARCHAR2", "CHAR", "RAW", "ABS", "NVL", "COUNT", "SUM", "MIN", "MAX", "AVG", "IN", "VALUES",
                "IF", "WHILE",
            ]
            .contains(&name.as_str())
                || methods.contains(&name)
            {
                continue;
            }
            let package = index.checked_sub(2).and_then(|i| {
                if tokens[index - 1].2 == "." {
                    Some(identifier_word(&tokens[i].2))
                } else {
                    None
                }
            });
            if dependencies.iter().any(|d| d.name == name || package.as_deref() == Some(d.name.as_str())) {
                continue;
            }
            return Err(format!("TYPE BODY conversion cannot confirm callable or declaration {name}"));
        }
    }
    if kind == "TYPE" {
        if words.iter().any(|w| w == "ORDER" || w == "REF" || w == "INDEX") {
            return Err(
                "ORDER methods, REF attributes and associative-array TYPE conversion are outside the confirmed profile"
                    .into(),
            );
        }
        let tokens = source_tokens(&tail);
        let text: Vec<_> = tokens.iter().map(|t| t.2.as_str()).collect();
        let object = text.windows(2).any(|p| p == ["AS", "OBJECT"] || p == ["IS", "OBJECT"]);
        let collection = text.windows(2).any(|p| p == ["TABLE", "OF"])
            || text.contains(&"VARRAY")
            || text.windows(2).any(|p| p == ["VARYING", "ARRAY"]);
        if !object && !collection {
            return Err("TYPE conversion supports complete AS OBJECT, nested TABLE OF or VARRAY definitions; incomplete and other type forms are not migrated".into());
        }
        let primitive = ["NUMBER", "VARCHAR2", "CHAR", "DATE", "RAW"];
        let user_type =
            |value: &str| dependencies.iter().any(|d| d.object_type == "TYPE" && d.name == identifier_word(value));
        let check_datatype = |part: &[&str]| -> Result<(), String> {
            let name = if part.get(1) == Some(&".") { part.get(2) } else { part.first() }
                .ok_or("Missing type attribute datatype")?;
            if primitive.contains(name) || user_type(name) {
                Ok(())
            } else {
                Err(format!("TYPE conversion has no confirmed attribute/element datatype mapping for {name}"))
            }
        };
        if object {
            let open = text.iter().position(|t| *t == "(").ok_or("Missing OBJECT attribute list")?;
            let mut depth = 0;
            let mut start = open + 1;
            for index in open + 1..text.len() {
                match text[index] {
                    "(" => depth += 1,
                    ")" if depth > 0 => depth -= 1,
                    "," | ")" if depth == 0 => {
                        let part = &text[start..index];
                        if !part.is_empty() && !matches!(part[0], "MEMBER" | "STATIC" | "CONSTRUCTOR") {
                            check_datatype(&part[1..])?;
                        }
                        if matches!(part.first(), Some(&"MEMBER") | Some(&"STATIC")) {
                            if let Some(returned) = part.iter().position(|word| *word == "RETURN") {
                                check_datatype(&part[returned + 1..])?;
                            }
                            if let Some(open) = part.iter().position(|word| *word == "(") {
                                let mut depth = 0;
                                let mut from = open + 1;
                                for i in open + 1..part.len() {
                                    match part[i] {
                                        "(" => depth += 1,
                                        ")" if depth > 0 => depth -= 1,
                                        "," | ")" if depth == 0 => {
                                            let parameter = &part[from..i];
                                            if !parameter.is_empty() {
                                                let mut datatype = 1;
                                                while parameter
                                                    .get(datatype)
                                                    .is_some_and(|w| matches!(*w, "IN" | "OUT"))
                                                {
                                                    datatype += 1;
                                                }
                                                check_datatype(&parameter[datatype..])?;
                                            }
                                            from = i + 1;
                                            if part[i] == ")" {
                                                break;
                                            }
                                        }
                                        _ => (),
                                    }
                                }
                            }
                        }
                        if part.first() == Some(&"CONSTRUCTOR") {
                            return Err("User-defined CONSTRUCTOR conversion is not in the confirmed profile".into());
                        }
                        start = index + 1;
                        if text[index] == ")" {
                            break;
                        }
                    }
                    _ => (),
                }
            }
        } else {
            let of = text.iter().position(|t| *t == "OF").ok_or("Missing collection element datatype")?;
            check_datatype(&text[of + 1..])?;
        }
    }
    Ok(())
}

pub fn supported_version(kind: &DatabaseType, banner: &str) -> Result<String, String> {
    let pattern = if *kind == DatabaseType::Oracle {
        r"Oracle Database (19c|21c|23ai|23c)\b"
    } else {
        r"\A\s*(4\.2\.5)(?:\.[0-9]+)*(?:\s.*)?\z"
    };
    Regex::new(pattern)
        .unwrap()
        .captures(banner)
        .and_then(|c| c.get(1))
        .map(|c| c.as_str().to_ascii_lowercase())
        .ok_or_else(|| "Target/source type support is unknown for this version".into())
}
pub fn conversion_profile(
    source_type: &DatabaseType,
    source_banner: &str,
    target_type: &DatabaseType,
    target_banner: &str,
) -> Result<bool, String> {
    if !matches!(source_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        || !matches!(target_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
    {
        return Err("TYPE migration requires Oracle or OceanBase Oracle endpoints".into());
    }
    let from = supported_version(source_type, source_banner)?;
    let to = supported_version(target_type, target_banner)?;
    let conversion = source_type != target_type || from != to;
    if conversion && [from.as_str(), to.as_str()].iter().any(|v| matches!(*v, "23ai" | "23c")) {
        return Err("Oracle 23 TYPE conversion lacks fixed-version documentation; only Oracle 19c/21c and OceanBase 4.2.5 conversion profiles are confirmed".into());
    }
    Ok(conversion)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_type_body_header_is_not_a_body_local_type_declaration() {
        let body = "CREATE TYPE BODY T AS MEMBER FUNCTION f RETURN NUMBER IS BEGIN RETURN ABS(SELF.age); END; END;";
        assert!(compatible_type_source(body, "TYPE BODY", &[]).is_ok());
        assert!(compatible_type_source(&body.replace("ABS(SELF.age)", "unknown_call(SELF.age)"), "TYPE BODY", &[])
            .unwrap_err()
            .contains("UNKNOWN_CALL"));
        assert!(compatible_type_source(
            &body.replace("IS BEGIN", "IS TYPE local_t IS TABLE OF NUMBER; BEGIN"),
            "TYPE BODY",
            &[]
        )
        .is_err());
    }

    #[test]
    fn fixed_versions_do_not_accept_mysql_prefix_or_unconfirmed_oracle_conversion() {
        assert!(conversion_profile(
            &DatabaseType::Oracle,
            "Oracle Database 19c Enterprise Edition",
            &DatabaseType::OceanbaseOracle,
            "4.2.5.6"
        )
        .unwrap());
        assert!(conversion_profile(
            &DatabaseType::OceanbaseOracle,
            "4.2.5.6",
            &DatabaseType::Oracle,
            "Oracle Database 21c Enterprise Edition"
        )
        .unwrap());
        assert!(conversion_profile(
            &DatabaseType::OceanbaseOracle,
            "5.7.25-OceanBase-v4.2.5.0",
            &DatabaseType::Oracle,
            "Oracle Database 19c Enterprise Edition"
        )
        .is_err());
        assert!(conversion_profile(
            &DatabaseType::Oracle,
            "Oracle Database 23ai Enterprise Edition",
            &DatabaseType::OceanbaseOracle,
            "4.2.5.0"
        )
        .is_err());
    }

    #[test]
    fn mapping_preserves_literals_and_rejects_owner_shadowing() {
        let sql = "CREATE TYPE BODY T AS MEMBER FUNCTION f RETURN NUMBER IS BEGIN -- SRC.T\nRETURN SRC.T(q'[SRC.T O'Reilly]', nq'{SRC.T}'); END; END;";
        let mapped = map_reference(sql, "SRC", "T", "Mixed Target").unwrap();
        assert!(mapped.contains("RETURN \"Mixed Target\".T("));
        assert!(mapped.contains("-- SRC.T\n"));
        assert!(mapped.contains("q'[SRC.T O'Reilly]', nq'{SRC.T}'"));
        assert!(map_reference("FUNCTION f(SRC NUMBER) RETURN NUMBER IS BEGIN RETURN SRC.T; END;", "SRC", "T", "DST")
            .is_err());
    }

    #[test]
    fn type_categories_report_specific_unknown_semantics() {
        assert!(compatible_type_source(
            "CREATE TYPE T AS OBJECT (n NUMBER(10,2), label VARCHAR2(30 CHAR));",
            "TYPE",
            &[]
        )
        .is_ok());
        assert!(compatible_type_source("CREATE TYPE T AS TABLE OF NUMBER;", "TYPE", &[]).is_ok());
        assert!(compatible_type_source("CREATE TYPE T AS VARRAY(8) OF VARCHAR2(30);", "TYPE", &[]).is_ok());
        assert!(compatible_type_source("CREATE TYPE T AS OBJECT (n NUMBER) NOT FINAL;", "TYPE", &[])
            .unwrap_err()
            .contains("FINAL"));
        assert!(compatible_type_source("CREATE TYPE T AS OBJECT (value XMLTYPE);", "TYPE", &[])
            .unwrap_err()
            .contains("XMLTYPE"));
    }
}
