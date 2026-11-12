//! Bounded TYPE migration syntax. Every token belongs to the accepted grammar;
//! arbitrary SQL remains in the ordinary SQL editor, not in a migration plan.
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, Tokenizer, Whitespace};

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[derive(Clone)]
struct Cursor {
    tokens: Vec<Token>,
    at: usize,
}
impl Cursor {
    fn new(sql: &str) -> Result<Self, String> {
        let mut tokens = Vec::new();
        for token in Tokenizer::new(&OracleDialect {}, sql).tokenize().map_err(|e| e.to_string())? {
            match token {
                Token::Whitespace(Whitespace::Space | Whitespace::Newline | Whitespace::Tab) => (),
                Token::Whitespace(_) => {
                    return Err("Comments and hints are not part of the bounded migration grammar".into())
                }
                other => tokens.push(other),
            }
        }
        Ok(Self { tokens, at: 0 })
    }
    fn keyword(&mut self, word: &str) -> bool {
        if matches!(self.tokens.get(self.at), Some(Token::Word(w)) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(word))
        {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn expect_keyword(&mut self, word: &str) -> Result<(), String> {
        if self.keyword(word) {
            Ok(())
        } else {
            Err(format!("Expected {word} in the bounded migration statement"))
        }
    }
    fn take(&mut self, token: Token) -> bool {
        if self.tokens.get(self.at) == Some(&token) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, token: Token) -> Result<(), String> {
        if self.take(token.clone()) {
            Ok(())
        } else {
            Err(format!("Expected {token} in the bounded migration statement"))
        }
    }
    fn ident(&mut self) -> Result<String, String> {
        match self.tokens.get(self.at) {
            Some(Token::Word(word)) if word.quote_style.is_none() || word.quote_style == Some('"') => {
                let value = if word.quote_style.is_some() { word.value.clone() } else { word.value.to_uppercase() };
                self.at += 1;
                if value.is_empty() {
                    Err("Empty identifier".into())
                } else {
                    Ok(value)
                }
            }
            _ => Err("Expected an exact column or relation identifier".into()),
        }
    }
    fn number(&mut self) -> Result<i32, String> {
        let negative = self.take(Token::Minus);
        match self.tokens.get(self.at) {
            Some(Token::Number(value, false)) if value.bytes().all(|c| c.is_ascii_digit()) => {
                let value = value.parse::<i32>().map_err(|_| "Numeric type dimension exceeds the supported range")?;
                self.at += 1;
                Ok(if negative { -value } else { value })
            }
            _ => Err("Expected an integer type dimension".into()),
        }
    }
    fn relation(&mut self) -> Result<(String, String), String> {
        let owner = self.ident()?;
        self.expect(Token::Period)?;
        Ok((owner, self.ident()?))
    }
    fn end(&mut self) -> Result<(), String> {
        self.take(Token::SemiColon);
        if self.at == self.tokens.len() {
            Ok(())
        } else {
            Err("The complete statement contains unsupported syntax or an additional statement".into())
        }
    }
}

fn oceanbase_table_header(owner: &str, name: &str, ddl: &str) -> Result<Cursor, String> {
    let mut cursor = Cursor::new(ddl)?;
    cursor.expect_keyword("CREATE")?;
    cursor.expect_keyword("TABLE")?;
    let first = cursor.ident()?;
    let identity_matches =
        if cursor.take(Token::Period) { first == owner && cursor.ident()? == name } else { first == name };
    if !identity_matches {
        return Err("The native table definition does not match the exact requested relation".into());
    }
    cursor.expect(Token::LParen)?;
    Ok(cursor)
}

/// OceanBase can return NULL for ALL_TABLES.READ_ONLY even after ALTER TABLE
/// READ ONLY. Only its complete, exact native simple-table definition supplies
/// the fallback; an unfamiliar or partial suffix must remain unverifiable.
/// The six-option suffix was verified on OceanBase Oracle 4.2.5.7; this is a
/// grammar boundary, not a claim that other versions cannot support READ ONLY.
pub fn oceanbase_table_read_only_from_ddl(owner: &str, name: &str, ddl: &str) -> Result<bool, String> {
    let mut cursor = oceanbase_table_header(owner, name, ddl)?;
    let start = cursor.at;
    let mut depth = 1;
    while depth > 0 {
        match cursor.tokens.get(cursor.at) {
            Some(Token::LParen) => depth += 1,
            Some(Token::RParen) => depth -= 1,
            None | Some(Token::SemiColon) => return Err("The native table definition is incomplete".into()),
            _ => (),
        }
        cursor.at += 1;
    }
    if cursor.at == start + 1 {
        return Err("The native table definition has no columns".into());
    }
    let mut options = std::collections::HashSet::new();
    loop {
        if cursor.keyword("COMPRESS") {
            if !options.insert("COMPRESS") {
                return Err("Duplicate native table option".into());
            }
            cursor.expect_keyword("FOR")?;
            cursor.expect_keyword("ARCHIVE")?;
        } else if cursor.keyword("USE_BLOOM_FILTER") {
            if !options.insert("USE_BLOOM_FILTER") {
                return Err("Duplicate native table option".into());
            }
            cursor.expect(Token::Eq)?;
            if !cursor.keyword("TRUE") && !cursor.keyword("FALSE") {
                return Err("Unknown native bloom-filter state".into());
            }
        } else if let Some(option) =
            ["REPLICA_NUM", "BLOCK_SIZE", "TABLET_SIZE", "PCTFREE"].into_iter().find(|option| cursor.keyword(option))
        {
            if !options.insert(option) {
                return Err("Duplicate native table option".into());
            }
            cursor.expect(Token::Eq)?;
            if cursor.number()? < 0 {
                return Err("Invalid native table option".into());
            }
        } else {
            break;
        }
    }
    if options.len() != 6 {
        return Err("The complete supported OceanBase native table suffix is required".into());
    }
    let read_only = if cursor.keyword("READ") {
        if cursor.keyword("ONLY") {
            true
        } else {
            cursor.expect_keyword("WRITE")?;
            false
        }
    } else {
        false
    };
    cursor.end()?;
    Ok(read_only)
}

/// Prove the native INSERT target has only explicit scalar columns and simple
/// keys. In particular, NULL compatibility flags cannot hide a default, identity
/// or generated expression. Unfamiliar definitions need external preparation.
pub fn oceanbase_scalar_insert_columns(owner: &str, name: &str, ddl: &str) -> Result<Vec<String>, String> {
    if oceanbase_table_read_only_from_ddl(owner, name, ddl)? {
        return Err("The native scalar INSERT target must be READ WRITE".into());
    }
    let mut cursor = oceanbase_table_header(owner, name, ddl)?;
    let mut columns = Vec::new();
    let mut keys = Vec::new();
    loop {
        let named_constraint = cursor.keyword("CONSTRAINT");
        if named_constraint {
            cursor.ident()?;
        }
        let primary = cursor.keyword("PRIMARY");
        if primary || cursor.keyword("UNIQUE") {
            if primary {
                cursor.expect_keyword("KEY")?;
            }
            cursor.expect(Token::LParen)?;
            let mut key = vec![cursor.ident()?];
            while cursor.take(Token::Comma) {
                key.push(cursor.ident()?);
            }
            cursor.expect(Token::RParen)?;
            keys.push(key);
        } else if named_constraint {
            return Err("Only simple PRIMARY/UNIQUE constraints are supported in the native INSERT definition".into());
        } else {
            let column = cursor.ident()?;
            ScalarType::read(&mut cursor)?;
            if cursor.keyword("NOT") {
                cursor.expect_keyword("NULL")?;
            } else {
                cursor.keyword("NULL");
            }
            if columns.contains(&column) {
                return Err("Duplicate native scalar column".into());
            }
            columns.push(column);
        }
        if !cursor.take(Token::Comma) {
            cursor.expect(Token::RParen)?;
            break;
        }
    }
    if columns.is_empty()
        || keys.iter().any(|key| {
            key.iter().any(|column| !columns.contains(column))
                || key.iter().collect::<std::collections::HashSet<_>>().len() != key.len()
        })
    {
        return Err("The complete native scalar columns and key references could not be verified".into());
    }
    Ok(columns)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScalarType {
    pub name: String,
    pub size: Option<i32>,
    pub scale: Option<i32>,
    pub semantics: Option<String>,
}
impl ScalarType {
    pub fn parse(sql: &str) -> Result<Self, String> {
        let mut cursor = Cursor::new(sql)?;
        let value = Self::read(&mut cursor)?;
        cursor.end()?;
        Ok(value)
    }
    fn read(cursor: &mut Cursor) -> Result<Self, String> {
        if !matches!(cursor.tokens.get(cursor.at), Some(Token::Word(word)) if word.quote_style.is_none()) {
            return Err("A bounded scalar type must be an unquoted built-in type, not a user-defined type".into());
        }
        let name = cursor.ident()?;
        if !["NUMBER", "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW", "DATE", "TIMESTAMP"].contains(&name.as_str()) {
            return Err(format!("{name} needs a verified scalar projection in the SQL editor"));
        }
        let mut value = Self { name, size: None, scale: None, semantics: None };
        if cursor.take(Token::LParen) {
            value.size = Some(cursor.number()?);
            if cursor.take(Token::Comma) {
                value.scale = Some(cursor.number()?);
            }
            if cursor.keyword("BYTE") {
                value.semantics = Some("BYTE".into());
            } else if cursor.keyword("CHAR") {
                value.semantics = Some("CHAR".into());
            }
            cursor.expect(Token::RParen)?;
        }
        match value.name.as_str() {
            "NUMBER" => {
                if value.size.is_some_and(|p| !(1..=38).contains(&p))
                    || value.scale.is_some_and(|s| !(-84..=127).contains(&s))
                    || value.semantics.is_some()
                {
                    return Err("Unsupported NUMBER precision or scale".into());
                }
                if value.size.is_some() {
                    value.scale = Some(value.scale.unwrap_or(0));
                }
            }
            "DATE" if value.size.is_none() => (),
            "TIMESTAMP"
                if value.size.is_none_or(|p| (0..=9).contains(&p))
                    && value.scale.is_none()
                    && value.semantics.is_none() =>
            {
                value.size = Some(value.size.unwrap_or(6));
            }
            "CHAR" | "VARCHAR2" | "RAW" | "NCHAR" | "NVARCHAR2"
                if value.size.is_some_and(|n| n > 0 && n <= 32767) && value.scale.is_none() =>
            {
                if matches!(value.name.as_str(), "NCHAR" | "NVARCHAR2") {
                    value.semantics = Some("CHAR".into());
                }
                if value.name == "RAW" && value.semantics.is_some() {
                    return Err("RAW has no character semantics".into());
                }
            }
            _ => return Err("Unsupported scalar type dimensions".into()),
        }
        Ok(value)
    }
    pub fn sql(&self) -> String {
        match self.name.as_str() {
            "NUMBER" => {
                self.size.map(|p| format!("NUMBER({p},{})", self.scale.unwrap_or(0))).unwrap_or_else(|| "NUMBER".into())
            }
            "DATE" => "DATE".into(),
            "TIMESTAMP" => format!("TIMESTAMP({})", self.size.unwrap_or(6)),
            _ => format!(
                "{}({}{})",
                self.name,
                self.size.unwrap_or(0),
                self.semantics.as_ref().map(|s| format!(" {s}")).unwrap_or_default()
            ),
        }
    }
    pub fn losslessly_accepts(&self, old: &Self) -> bool {
        if self == old {
            return true;
        }
        if self.name != old.name {
            return false;
        }
        if self.name == "NUMBER" {
            return match (self.size, old.size) {
                (None, _) => true,
                (Some(p), Some(q)) => {
                    let s = self.scale.unwrap_or(0);
                    let t = old.scale.unwrap_or(0);
                    s >= t && p - s >= q - t
                }
                _ => false,
            };
        }
        matches!(self.name.as_str(), "VARCHAR2" | "NVARCHAR2" | "RAW" | "TIMESTAMP")
            && self.semantics == old.semantics
            && self.size >= old.size
    }
    pub fn family(&self) -> &str {
        match self.name.as_str() {
            "CHAR" | "VARCHAR2" | "NCHAR" | "NVARCHAR2" => "text",
            "NUMBER" => "decimal",
            "RAW" => "raw",
            "DATE" => "date",
            _ => "timestamp",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScalarColumn {
    pub name: String,
    pub data_type: ScalarType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvolutionDataType {
    Scalar(ScalarType),
    Named { owner: String, name: String },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvolutionShape {
    pub attributes: Vec<(String, EvolutionDataType)>,
    pub varray: Option<(i32, EvolutionDataType)>,
    signature: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct EvolutionStep {
    pub sql: String,
    pub after: EvolutionShape,
}
#[derive(Debug, Clone)]
pub struct EvolutionSql {
    pub before: EvolutionShape,
    pub steps: Vec<EvolutionStep>,
}

/// Finite, data-preserving differences only. Database restrictions are checked
/// separately by Core before this preview can become an executable plan.
pub fn build_type_evolution_sql(owner: &str, name: &str, before: &str, after: &str) -> Result<EvolutionSql, String> {
    use crate::object_source_sql::{build_oracle_type_management_source, EditableObjectSourceSqlInput};
    let parse = |source: &str| {
        let (sql, _) = build_oracle_type_management_source(EditableObjectSourceSqlInput {
            database_type: crate::models::connection::DatabaseType::Oracle,
            object_type: crate::types::ObjectSourceKind::Type,
            schema: Some(owner.into()),
            name: name.into(),
            source: source.into(),
        })?;
        evolution_shape(owner, &sql)
    };
    let before = parse(before)?;
    let after = parse(after)?;
    if before.signature != after.signature {
        return Err("Native evolution cannot change methods, inheritance, AUTHID or TYPE properties. Retain their definitions or prepare an explicit mapping".into());
    }
    let mut steps = Vec::new();
    let target = format!("{}.{}", quote(owner), quote(name));
    match (&before.varray, &after.varray) {
        (Some((old_limit, old_type)), Some((new_limit, new_type)))
            if old_type == new_type && new_limit >= old_limit =>
        {
            if new_limit != old_limit {
                steps.push(EvolutionStep {
                    sql: format!("ALTER TYPE {target} MODIFY LIMIT {new_limit} CASCADE INCLUDING TABLE DATA;"),
                    after: after.clone(),
                });
            }
        }
        (None, None) => {
            if after.attributes.len() < before.attributes.len() {
                return Err("Removing or renaming attributes requires an explicit data mapping".into());
            }
            let mut widened = Vec::new();
            let mut intermediate = before.clone();
            for (index, ((old_name, old_type), (new_name, new_type))) in
                before.attributes.iter().zip(&after.attributes).enumerate()
            {
                if old_name != new_name {
                    return Err("Native evolution preserves the exact attribute names and order".into());
                }
                if old_type != new_type {
                    let (EvolutionDataType::Scalar(old), EvolutionDataType::Scalar(new)) = (old_type, new_type) else {
                        return Err("Changing a referenced UDT requires an explicit mapping".into());
                    };
                    if !native_scalar(new)
                        || !matches!(new.name.as_str(), "NUMBER" | "VARCHAR2" | "RAW")
                        || !new.losslessly_accepts(old)
                    {
                        return Err("The larger type is not a supported lossless widening of both integer digits and scale/length semantics".into());
                    }
                    widened.push(format!("{} {}", quote(new_name), new.sql()));
                    intermediate.attributes[index] = (new_name.clone(), new_type.clone());
                }
            }
            if !widened.is_empty() {
                steps.push(EvolutionStep {
                    sql: format!(
                        "ALTER TYPE {target} MODIFY ATTRIBUTE ({}) CASCADE INCLUDING TABLE DATA;",
                        widened.join(", ")
                    ),
                    after: intermediate,
                });
            }
            let appended = &after.attributes[before.attributes.len()..];
            let mut additions = Vec::new();
            for (name, ty) in appended {
                let EvolutionDataType::Scalar(ty) = ty else {
                    return Err("A new UDT, REF or nested attribute needs an explicit mapping".into());
                };
                if !native_scalar(ty) {
                    return Err("Append a supported built-in scalar attribute; character lengths require explicit BYTE semantics".into());
                }
                additions.push(format!("{} {}", quote(name), ty.sql()));
            }
            if !additions.is_empty() {
                steps.push(EvolutionStep {
                    sql: format!(
                        "ALTER TYPE {target} ADD ATTRIBUTE ({}) CASCADE INCLUDING TABLE DATA;",
                        additions.join(", ")
                    ),
                    after,
                });
            }
        }
        _ => return Err("Native evolution only increases a VARRAY limit without changing its element type".into()),
    }
    Ok(EvolutionSql { before, steps })
}

fn native_scalar(ty: &ScalarType) -> bool {
    match ty.name.as_str() {
        "NUMBER" | "DATE" => true,
        "VARCHAR2" => ty.semantics.as_deref() == Some("BYTE") && ty.size.is_some_and(|n| n <= 4000),
        "RAW" => ty.size.is_some_and(|n| n <= 2000),
        _ => false,
    }
}

fn type_token(token: &Token) -> String {
    match token {
        Token::Word(word) if word.quote_style.is_none() => word.value.to_uppercase(),
        Token::Word(word) if word.quote_style == Some('"') => quote(&word.value),
        _ => token.to_string(),
    }
}

fn evolution_data_type(cursor: &mut Cursor, owner: &str) -> Result<EvolutionDataType, String> {
    let mut scalar = cursor.clone();
    if let Ok(value) = ScalarType::read(&mut scalar) {
        *cursor = scalar;
        return Ok(EvolutionDataType::Scalar(value));
    }
    let first = cursor.ident()?;
    let (owner, name) = if cursor.take(Token::Period) { (first, cursor.ident()?) } else { (owner.into(), first) };
    Ok(EvolutionDataType::Named { owner, name })
}

fn evolution_shape(owner: &str, sql: &str) -> Result<EvolutionShape, String> {
    let tokens = Tokenizer::new(&OracleDialect {}, sql).tokenize().map_err(|e| e.to_string())?;
    let mut signature: Vec<_> = tokens
        .iter()
        .filter_map(|token| match token {
            Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline) => None,
            Token::Whitespace(_) => Some(format!("comment:{token}")),
            _ => None,
        })
        .collect();
    let mut cursor =
        Cursor { tokens: tokens.into_iter().filter(|t| !matches!(t, Token::Whitespace(_))).collect(), at: 0 };
    cursor.expect_keyword("CREATE")?;
    if cursor.keyword("OR") {
        cursor.expect_keyword("REPLACE")?;
    }
    if cursor.keyword("EDITIONABLE") {
        signature.push("EDITIONABLE".into());
    } else if cursor.keyword("NONEDITIONABLE") {
        signature.push("NONEDITIONABLE".into());
    }
    cursor.expect_keyword("TYPE")?;
    cursor.relation()?;
    let (mut oid, mut authid) = (false, false);
    loop {
        if !oid && cursor.keyword("OID") {
            let Some(Token::SingleQuotedString(value)) = cursor.tokens.get(cursor.at) else {
                return Err("The unchanged TYPE OID must be a complete literal".into());
            };
            signature.push(format!("OID:{value}"));
            cursor.at += 1;
            oid = true;
        } else if !authid && cursor.keyword("AUTHID") {
            signature.push("AUTHID".into());
            if cursor.keyword("DEFINER") {
                signature.push("DEFINER".into());
            } else {
                cursor.expect_keyword("CURRENT_USER")?;
                signature.push("CURRENT_USER".into());
            }
            authid = true;
        } else {
            break;
        }
    }
    if !cursor.keyword("AS") {
        cursor.expect_keyword("IS")?;
    }
    let mut shape = EvolutionShape { attributes: Vec::new(), varray: None, signature };
    if cursor.keyword("VARRAY") || cursor.keyword("VARYING") {
        if matches!(cursor.tokens.get(cursor.at - 1), Some(Token::Word(w)) if w.value.eq_ignore_ascii_case("VARYING")) {
            cursor.expect_keyword("ARRAY")?;
        }
        cursor.expect(Token::LParen)?;
        let limit = cursor.number()?;
        if limit < 1 {
            return Err("The VARRAY limit must be a positive supported integer".into());
        }
        cursor.expect(Token::RParen)?;
        cursor.expect_keyword("OF")?;
        shape.varray = Some((limit, evolution_data_type(&mut cursor, owner)?));
        cursor.end()?;
        shape.signature.push("VARRAY".into());
        return Ok(shape);
    }
    cursor.expect_keyword("OBJECT")?;
    cursor.expect(Token::LParen)?;
    let mut names = std::collections::HashSet::new();
    loop {
        let method = matches!(cursor.tokens.get(cursor.at), Some(Token::Word(w)) if w.quote_style.is_none() && ["MEMBER", "STATIC", "MAP", "ORDER", "CONSTRUCTOR", "FINAL", "NOT", "OVERRIDING", "INSTANTIABLE"].iter().any(|keyword| w.value.eq_ignore_ascii_case(keyword)));
        if method {
            break;
        }
        let name = cursor.ident()?;
        if !names.insert(name.clone()) {
            return Err("Each native attribute must have a distinct exact name".into());
        }
        shape.attributes.push((name, evolution_data_type(&mut cursor, owner)?));
        if !cursor.take(Token::Comma) {
            break;
        }
    }
    // The strict source builder has already checked the complete single TYPE.
    // Any method/property tokens must remain identical; they are never emitted
    // as arbitrary text in an ALTER clause.
    while let Some(token) = cursor.tokens.get(cursor.at) {
        if *token == Token::SemiColon {
            break;
        }
        shape.signature.push(type_token(token));
        cursor.at += 1;
    }
    cursor.end()?;
    if shape.attributes.is_empty() {
        return Err("Native evolution needs a complete OBJECT attribute prefix".into());
    }
    Ok(shape)
}

#[cfg(test)]
mod evolution_tests {
    use super::*;
    fn source(shape: &str) -> String {
        format!("CREATE OR REPLACE TYPE \"App\".\"Root (v1)\" AS {shape};")
    }
    #[test]
    fn native_evolution_does_not_claim_to_apply_changed_source_comments() {
        let before = source("OBJECT (ID NUMBER)");
        let after = source("OBJECT (ID NUMBER, /* new source comment */ EXTRA RAW(16))");
        assert!(build_type_evolution_sql("App", "Root (v1)", &before, &after).is_err());
    }
    #[test]
    fn native_evolution_separates_widening_and_append_without_drop_or_force() {
        let old = source("OBJECT (\"Id\" NUMBER(8,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER)");
        let new = source(
            "OBJECT (\"Id\" NUMBER(10,3), NAME VARCHAR2(40 BYTE), EXTRA RAW(16), MEMBER FUNCTION F RETURN NUMBER)",
        );
        let plan = build_type_evolution_sql("App", "Root (v1)", &old, &new).unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].sql, "ALTER TYPE \"App\".\"Root (v1)\" MODIFY ATTRIBUTE (\"Id\" NUMBER(10,3), \"NAME\" VARCHAR2(40 BYTE)) CASCADE INCLUDING TABLE DATA;");
        assert_eq!(
            plan.steps[1].sql,
            "ALTER TYPE \"App\".\"Root (v1)\" ADD ATTRIBUTE (\"EXTRA\" RAW(16)) CASCADE INCLUDING TABLE DATA;"
        );
        assert_eq!(plan.steps[0].after.attributes.len(), 2);
        assert_eq!(plan.steps[1].after.attributes.len(), 3);
    }
    #[test]
    fn native_varray_limit_keeps_the_exact_element_and_increases_only_the_bound() {
        let old = source("VARRAY(10) OF \"App\".\"Quoted Element\"");
        let new = source("VARRAY(30) OF \"App\".\"Quoted Element\"");
        let plan = build_type_evolution_sql("App", "Root (v1)", &old, &new).unwrap();
        assert_eq!(plan.steps[0].sql, "ALTER TYPE \"App\".\"Root (v1)\" MODIFY LIMIT 30 CASCADE INCLUDING TABLE DATA;");
        for shape in [
            "VARRAY(9) OF \"App\".\"Quoted Element\"",
            "VARRAY(30) OF \"App\".OTHER",
            "TABLE OF \"App\".\"Quoted Element\"",
        ] {
            assert!(build_type_evolution_sql("App", "Root (v1)", &old, &source(shape)).is_err());
        }
    }
    #[test]
    fn native_evolution_rejects_semantic_changes_and_larger_but_lossy_numeric_dimensions() {
        let old = source("OBJECT (ID NUMBER(8,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER)");
        for shape in [
            "OBJECT (ID NUMBER(9,4), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (ID NUMBER(7,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (RENAMED NUMBER(8,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (NAME VARCHAR2(20 BYTE), ID NUMBER(8,2), MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (ID NUMBER(8,2), NAME VARCHAR2(20 CHAR), MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (ID NUMBER(8,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN VARCHAR2)",
            "OBJECT (ID NUMBER(8,2), NAME VARCHAR2(20 BYTE), EXTRA \"NUMBER\", MEMBER FUNCTION F RETURN NUMBER)",
            "OBJECT (ID NUMBER(8,2), NAME VARCHAR2(20 BYTE), MEMBER FUNCTION F RETURN NUMBER) NOT FINAL",
        ] {
            assert!(build_type_evolution_sql("App", "Root (v1)", &old, &source(shape)).is_err(), "{shape}");
        }
        assert!(build_type_evolution_sql("App", "Root (v1)", &old, &(old.clone() + " DROP TABLE X;")).is_err());
        assert!(build_type_evolution_sql("Other", "Root (v1)", &old, &old).is_err());
    }
}

enum Projection {
    Column(String),
    Typed(String, ScalarType),
    Cast(Box<Projection>, ScalarType),
}
impl Projection {
    fn read(cursor: &mut Cursor, depth: usize) -> Result<Self, String> {
        if depth > 2 {
            return Err("Nested mapping expressions are not supported".into());
        }
        if cursor.keyword("CAST") {
            cursor.expect(Token::LParen)?;
            let expression = if cursor.keyword("NULL") {
                Self::Typed("NULL".into(), ScalarType::parse("NUMBER")?)
            } else if let Some(Token::SingleQuotedString(text)) = cursor.tokens.get(cursor.at) {
                let sql = format!("'{}'", text.replace('\'', "''"));
                cursor.at += 1;
                Self::Typed(sql, ScalarType::parse(&format!("VARCHAR2({} BYTE)", text.len().max(1)))?)
            } else if matches!(cursor.tokens.get(cursor.at), Some(Token::Number(..) | Token::Minus)) {
                let start = cursor.at;
                cursor.take(Token::Minus);
                let Some(Token::Number(number, false)) = cursor.tokens.get(cursor.at) else {
                    return Err("Expected a numeric constant".into());
                };
                if !number.chars().all(|c| c.is_ascii_digit() || c == '.') {
                    return Err("Use an exact decimal constant without exponent notation".into());
                }
                let digits = number.chars().filter(|c| c.is_ascii_digit()).count();
                let scale = number.split_once('.').map_or(0, |(_, frac)| frac.len());
                if digits == 0 || digits > 38 || number.matches('.').count() > 1 {
                    return Err("Invalid exact decimal constant".into());
                }
                cursor.at += 1;
                Self::Typed(
                    cursor.tokens[start..cursor.at].iter().map(ToString::to_string).collect::<Vec<_>>().join(""),
                    ScalarType::parse(&format!("NUMBER({},{scale})", digits.max(scale + 1)))?,
                )
            } else {
                Self::read(cursor, depth + 1)?
            };
            cursor.expect_keyword("AS")?;
            let data_type = ScalarType::read(cursor)?;
            cursor.expect(Token::RParen)?;
            if let Self::Typed(literal, _) = &expression {
                if literal == "NULL" {
                    return Ok(Self::Typed(format!("CAST(NULL AS {})", data_type.sql()), data_type));
                }
            }
            return Ok(Self::Cast(Box::new(expression), data_type));
        }
        if cursor.keyword("DATE") || cursor.keyword("TIMESTAMP") {
            let kind = cursor.tokens[cursor.at - 1].to_string().to_uppercase();
            let Some(Token::SingleQuotedString(text)) = cursor.tokens.get(cursor.at) else {
                return Err("Expected a typed date/time literal".into());
            };
            let date = text.as_bytes();
            let valid_date = date.len() >= 10
                && date[..10].iter().enumerate().all(|(i, byte)| {
                    if i == 4 || i == 7 {
                        *byte == b'-'
                    } else {
                        byte.is_ascii_digit()
                    }
                });
            let precision = if kind == "DATE" {
                if !valid_date || date.len() != 10 {
                    return Err("Use a complete YYYY-MM-DD date literal".into());
                }
                None
            } else {
                let valid_time = date.len() >= 19
                    && date[10..19].iter().enumerate().all(|(i, byte)| match i {
                        0 => *byte == b' ',
                        3 | 6 => *byte == b':',
                        _ => byte.is_ascii_digit(),
                    });
                let fraction = if date.len() == 19 {
                    0
                } else if date.get(19) == Some(&b'.')
                    && (21..=29).contains(&date.len())
                    && date[20..].iter().all(u8::is_ascii_digit)
                {
                    date.len() - 20
                } else {
                    return Err("Use an exact timestamp literal with at most nine fractional digits".into());
                };
                if !valid_date || !valid_time {
                    return Err("Use a complete YYYY-MM-DD HH:MM:SS timestamp literal".into());
                }
                Some(fraction)
            };
            let sql = format!("{kind} '{}'", text.replace('\'', "''"));
            cursor.at += 1;
            return Ok(Self::Typed(
                sql,
                ScalarType::parse(&precision.map_or(kind.clone(), |p| format!("TIMESTAMP({p})")))?,
            ));
        }
        Ok(Self::Column(cursor.ident()?))
    }
    fn checked(&self, columns: &[ScalarColumn]) -> Result<(String, ScalarType), String> {
        match self {
            Self::Column(name) => columns
                .iter()
                .find(|c| c.name == *name)
                .map(|c| (quote(name), c.data_type.clone()))
                .ok_or_else(|| format!("Unregistered EXPECTED column: {name}")),
            Self::Typed(sql, ty) => Ok((sql.clone(), ty.clone())),
            Self::Cast(inner, ty) => {
                let (sql, old) = inner.checked(columns)?;
                if !ty.losslessly_accepts(&old) {
                    return Err("The CAST is not proven lossless for the complete registered source type".into());
                }
                Ok((format!("CAST({sql} AS {})", ty.sql()), ty.clone()))
            }
        }
    }
}

/// A tiny, fully consumed INSERT/SELECT AST. Live object/implicit-execution and
/// empty-target checks belong to the Core reader immediately before dispatch.
pub fn validate_scalar_insert(
    sql: &str,
    target: (&str, &str),
    expected: (&str, &str),
    target_columns: &[ScalarColumn],
    expected_columns: &[ScalarColumn],
) -> Result<String, String> {
    let mut cursor = Cursor::new(sql)?;
    cursor.expect_keyword("INSERT")?;
    cursor.expect_keyword("INTO")?;
    if cursor.relation()? != (target.0.into(), target.1.into()) {
        return Err("INSERT target is not the registered target relation".into());
    }
    cursor.expect(Token::LParen)?;
    let mut columns = vec![cursor.ident()?];
    while cursor.take(Token::Comma) {
        columns.push(cursor.ident()?);
    }
    cursor.expect(Token::RParen)?;
    cursor.expect_keyword("SELECT")?;
    let mut projection = vec![Projection::read(&mut cursor, 0)?];
    while cursor.take(Token::Comma) {
        projection.push(Projection::read(&mut cursor, 0)?);
    }
    cursor.expect_keyword("FROM")?;
    if cursor.relation()? != (expected.0.into(), expected.1.into()) {
        return Err("SELECT source is not the registered EXPECTED relation".into());
    }
    cursor.end()?;
    let names: std::collections::HashSet<_> = columns.iter().collect();
    if columns.len() != target_columns.len() || names.len() != columns.len() || projection.len() != columns.len() {
        return Err("Supply every target scalar column exactly once".into());
    }
    let mut checked = Vec::new();
    for (name, expression) in columns.iter().zip(projection) {
        let column = target_columns.iter().find(|c| &c.name == name).ok_or("Unknown target column")?;
        let (sql, data_type) = expression.checked(expected_columns)?;
        if !column.data_type.losslessly_accepts(&data_type) {
            return Err(format!("Target column {name} cannot accept the full expression type without loss"));
        }
        checked.push(sql);
    }
    Ok(format!(
        "INSERT INTO {}.{} ({}) SELECT {} FROM {}.{};",
        quote(target.0),
        quote(target.1),
        columns.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", "),
        checked.join(", "),
        quote(expected.0),
        quote(expected.1)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    const OB_TABLE_SUFFIX: &str = "COMPRESS FOR ARCHIVE REPLICA_NUM = 1 BLOCK_SIZE = 16384 USE_BLOOM_FILTER = FALSE TABLET_SIZE = 134217728 PCTFREE = 0";
    #[test]
    fn oceanbase_native_insert_definition_proves_simple_scalar_columns_and_keys() {
        for body in [
            "\"ID\" NUMBER, \"LABEL\" VARCHAR2(40), PRIMARY KEY (\"ID\")",
            "\"ID\" NUMBER(38,4) NOT NULL, \"LABEL\" VARCHAR2(80 BYTE) NULL, CONSTRAINT PK_ID PRIMARY KEY (\"ID\"), UNIQUE (\"ID\", \"LABEL\")",
        ] {
            let ddl = format!("CREATE TABLE APP.RESULT ({body}) {OB_TABLE_SUFFIX}");
            assert_eq!(oceanbase_scalar_insert_columns("APP", "RESULT", &ddl), Ok(vec!["ID".into(), "LABEL".into()]));
        }
    }
    #[test]
    fn oceanbase_native_insert_definition_rejects_unverified_execution_or_columns() {
        for body in [
            "ID NUMBER DEFAULT APP.F()",
            "ID NUMBER GENERATED BY DEFAULT AS IDENTITY",
            "ID NUMBER GENERATED ALWAYS AS (1) VIRTUAL",
            "ID NUMBER CHECK (APP.F(ID)=1)",
            "ID APP.OBJECT_TYPE",
            "ID NUMBER, ID NUMBER",
            "ID NUMBER, PRIMARY KEY (MISSING)",
            "ID NUMBER, UNIQUE (ID,ID)",
            "ID NUMBER, CONSTRAINT FK FOREIGN KEY (ID) REFERENCES OTHER(ID)",
            "ID NUMBER, CONSTRAINT C CHECK (ID>0)",
            "ID NUMBER,",
            "",
        ] {
            let ddl = format!("CREATE TABLE APP.RESULT ({body}) {OB_TABLE_SUFFIX}");
            assert!(oceanbase_scalar_insert_columns("APP", "RESULT", &ddl).is_err(), "{ddl}");
        }
        let readonly = format!("CREATE TABLE APP.RESULT (ID NUMBER) {OB_TABLE_SUFFIX} READ ONLY");
        assert!(oceanbase_scalar_insert_columns("APP", "RESULT", &readonly).is_err());
    }
    #[test]
    fn oceanbase_native_readonly_requires_complete_exact_definition() {
        for (declaration, state) in [("", false), (" READ WRITE;", false), (" READ ONLY", true)] {
            for relation in ["\"APP\".\"Old table\"", "\"Old table\""] {
                let ddl = format!("CREATE TABLE {relation} (\"ID\" NUMBER(38,4), \"READ ONLY\" VARCHAR2(80) DEFAULT 'READ ONLY') {OB_TABLE_SUFFIX}{declaration}");
                assert_eq!(oceanbase_table_read_only_from_ddl("APP", "Old table", &ddl), Ok(state));
            }
        }
        for ddl in [
            format!("CREATE TABLE APP.OLD (ID NUMBER) {OB_TABLE_SUFFIX} READ ONLY"),
            format!("CREATE TABLE OTHER.\"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} READ ONLY"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER {OB_TABLE_SUFFIX} READ ONLY"),
            format!("CREATE TABLE \"Old table\" () {OB_TABLE_SUFFIX} READ ONLY"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} READ ONLY; DROP TABLE APP.X"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} READ ONLY READ WRITE"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} PCTFREE=0 READ ONLY"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} /* READ ONLY */"),
            format!("CREATE TABLE \"Old table\" (ID NUMBER) {OB_TABLE_SUFFIX} UNKNOWN_OPTION=1 READ ONLY"),
            "CREATE TABLE \"Old table\" (ID NUMBER) READ ONLY".into(),
            "CREATE TABLE \"Old table\" (ID NUMBER)".into(),
        ] {
            assert!(oceanbase_table_read_only_from_ddl("APP", "Old table", &ddl).is_err(), "{ddl}");
        }
    }
    fn columns() -> Vec<ScalarColumn> {
        vec![
            ScalarColumn { name: "ID".into(), data_type: ScalarType::parse("NUMBER(30,0)").unwrap() },
            ScalarColumn { name: "LABEL".into(), data_type: ScalarType::parse("VARCHAR2(80 BYTE)").unwrap() },
        ]
    }
    #[test]
    fn accepts_complete_projection_and_proven_lossless_cast() {
        let sql = validate_scalar_insert(
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT CAST(ID AS NUMBER(32,0)), LABEL FROM APP.EXPECTED",
            ("APP", "RESULT"),
            ("APP", "EXPECTED"),
            &[
                ScalarColumn { name: "ID".into(), data_type: ScalarType::parse("NUMBER(38,0)").unwrap() },
                columns().remove(1),
            ],
            &columns(),
        )
        .unwrap();
        assert!(sql.starts_with("INSERT INTO \"APP\".\"RESULT\""));
    }
    #[test]
    fn typed_constants_are_bounded_and_fractional_timestamp_precision_is_not_silently_lost() {
        let columns =
            vec![ScalarColumn { name: "VALUE".into(), data_type: ScalarType::parse("TIMESTAMP(9)").unwrap() }];
        let sql = "INSERT INTO APP.RESULT(VALUE) SELECT TIMESTAMP '2026-10-20 12:13:14.123456789' FROM APP.EXPECTED";
        assert!(validate_scalar_insert(sql, ("APP", "RESULT"), ("APP", "EXPECTED"), &columns, &columns).is_ok());
        let narrow = vec![ScalarColumn { name: "VALUE".into(), data_type: ScalarType::parse("TIMESTAMP(6)").unwrap() }];
        assert!(validate_scalar_insert(sql, ("APP", "RESULT"), ("APP", "EXPECTED"), &narrow, &columns).is_err());
        let number = vec![ScalarColumn { name: "VALUE".into(), data_type: ScalarType::parse("NUMBER(38,0)").unwrap() }];
        assert!(validate_scalar_insert(
            "INSERT INTO APP.RESULT(VALUE) SELECT CAST(900719925474099312345 AS NUMBER(38,0)) FROM APP.EXPECTED",
            ("APP", "RESULT"),
            ("APP", "EXPECTED"),
            &number,
            &number
        )
        .is_ok());
    }
    #[test]
    fn number_scale_must_preserve_integer_digits_as_well_as_fraction() {
        assert!(!ScalarType::parse("NUMBER(30,4)")
            .unwrap()
            .losslessly_accepts(&ScalarType::parse("NUMBER(30,0)").unwrap()));
        assert!(ScalarType::parse("NUMBER(34,4)")
            .unwrap()
            .losslessly_accepts(&ScalarType::parse("NUMBER(30,0)").unwrap()));
        assert!(!ScalarType::parse("VARCHAR2(90 CHAR)")
            .unwrap()
            .losslessly_accepts(&ScalarType::parse("VARCHAR2(80 BYTE)").unwrap()));
    }
    #[test]
    fn rejects_every_non_grammar_write_or_hidden_expression() {
        for sql in [
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED; DROP TABLE APP.X",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED WHERE 1=1",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,F(LABEL) FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,APP.F(LABEL) FROM APP.EXPECTED",
            "INSERT /*+ hint */ INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT * FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED@REMOTE",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED JOIN APP.X ON 1=1",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,(SELECT LABEL FROM APP.X) FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,SEQ.NEXTVAL FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT CAST(ID AS NUMBER(30,4)),LABEL FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,LABEL) SELECT CAST(ID AS \"NUMBER\"(38,0)),LABEL FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID) SELECT ID FROM APP.EXPECTED",
            "INSERT INTO APP.RESULT(ID,ID) SELECT ID,ID FROM APP.EXPECTED",
            "UPDATE APP.RESULT SET ID=1",
            "BEGIN NULL; END;",
        ] {
            assert!(
                validate_scalar_insert(sql, ("APP", "RESULT"), ("APP", "EXPECTED"), &columns(), &columns()).is_err(),
                "{sql}"
            );
        }
    }
}
