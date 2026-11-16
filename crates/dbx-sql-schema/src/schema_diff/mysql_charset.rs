//! Remove declaration charset clauses from native CREATE TABLE without touching
//! quoted identifiers, literals, expressions, comments, or other table options.
use serde::{Deserialize, Serialize};
use sqlparser::dialect::MySqlDialect;
use sqlparser::tokenizer::{Location, Token, TokenWithSpan, Tokenizer};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlTableCharset {
    pub character_set: Option<String>,
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCharsetDiff {
    pub source: MysqlTableCharset,
    pub target: MysqlTableCharset,
}

impl TableCharsetDiff {
    pub(super) fn inverted(&self) -> Self {
        Self { source: self.target.clone(), target: self.source.clone() }
    }
}

pub(super) fn compare_table_defaults(source: Option<&str>, target: Option<&str>) -> Option<TableCharsetDiff> {
    let source = table_defaults(source?)?;
    let target = table_defaults(target?)?;
    (super::mysql_charset_values_differ(source.character_set.as_deref(), target.character_set.as_deref())
        || super::mysql_charset_values_differ(source.collation.as_deref(), target.collation.as_deref()))
    .then_some(TableCharsetDiff { source, target })
}

fn table_defaults(sql: &str) -> Option<MysqlTableCharset> {
    let tokens = Tokenizer::new(&MySqlDialect {}, sql).tokenize().ok()?;
    let tokens: Vec<_> = tokens.iter().filter(|t| !matches!(t, Token::Whitespace(_))).collect();
    let keyword = |i: usize, name: &str| matches!(tokens.get(i), Some(Token::Word(w)) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(name));
    if !keyword(0, "CREATE") || !(1..4).any(|i| keyword(i, "TABLE")) {
        return None;
    }
    let open = tokens.iter().position(|t| matches!(t, Token::LParen))?;
    let mut depth = 1;
    let mut result = MysqlTableCharset { character_set: None, collation: None };
    let mut i = open + 1;
    while i < tokens.len() {
        match tokens[i] {
            Token::LParen => depth += 1,
            Token::RParen => depth -= 1,
            Token::SemiColon if depth == 0 => break,
            _ => {}
        }
        if depth == 0 {
            if keyword(i, "PARTITION") {
                break;
            }
            let collation = keyword(i, "COLLATE");
            let charset = keyword(i, "CHARSET") || (keyword(i, "CHARACTER") && keyword(i + 1, "SET"));
            if collation || charset {
                let mut value = i + if keyword(i, "CHARACTER") { 2 } else { 1 };
                if matches!(tokens.get(value), Some(Token::Eq)) {
                    value += 1;
                }
                let name = match tokens.get(value)? {
                    Token::Word(w) => w.value.clone(),
                    Token::SingleQuotedString(s) => s.clone(),
                    _ => return None,
                };
                if collation {
                    result.collation = Some(name);
                } else {
                    result.character_set = Some(name);
                }
                i = value;
            }
        }
        i += 1;
    }
    Some(result)
}

fn word(token: &TokenWithSpan, expected: &str) -> bool {
    matches!(&token.token, Token::Word(w) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(expected))
}

pub(super) fn supports_charset(data_type: &str) -> bool {
    let base = data_type.trim().split(['(', ' ']).next().unwrap_or_default();
    ["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"]
        .iter()
        .any(|ty| base.eq_ignore_ascii_case(ty))
}

fn offset(sql: &str, location: Location) -> usize {
    let mut line = 1;
    let mut column = 1;
    for (offset, ch) in sql.char_indices() {
        if line == location.line && column == location.column {
            return offset;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    sql.len()
}

pub(super) fn without_create_charset(sql: &str) -> Result<String, String> {
    let tokens = Tokenizer::new(&MySqlDialect {}, sql)
        .tokenize_with_location()
        .map_err(|error| format!("Cannot apply charset policy to CREATE TABLE: {error}"))?;
    let tokens: Vec<_> = tokens.iter().filter(|t| !matches!(t.token, Token::Whitespace(_))).collect();
    if !tokens.first().is_some_and(|t| word(t, "CREATE")) {
        return Ok(sql.to_string());
    }
    let Some(table_index) = tokens.iter().take(4).position(|t| word(t, "TABLE")) else {
        return Ok(sql.to_string());
    };
    let Some(open) = tokens
        .iter()
        .enumerate()
        .skip(table_index + 1)
        .find_map(|(i, t)| matches!(t.token, Token::LParen).then_some(i))
    else {
        return Ok(sql.to_string());
    };
    let mut depth = 1;
    let mut column_declaration = true;
    let mut element_start = true;
    let mut ranges = Vec::new();
    let mut i = open + 1;
    while i < tokens.len() {
        let token = tokens[i];
        match token.token {
            Token::LParen => {
                depth += 1;
                i += 1;
                continue;
            }
            Token::RParen => {
                depth -= 1;
                i += 1;
                continue;
            }
            Token::SemiColon if depth == 0 => break,
            Token::Comma if depth == 1 => {
                element_start = true;
                column_declaration = true;
                i += 1;
                continue;
            }
            _ => {}
        }
        if depth == 1 && element_start {
            column_declaration =
                !["CONSTRAINT", "PRIMARY", "UNIQUE", "KEY", "INDEX", "FOREIGN", "CHECK", "FULLTEXT", "SPATIAL"]
                    .iter()
                    .any(|keyword| word(token, keyword));
            element_start = false;
            // The first token is the column name, even if unquoted and a keyword.
            i += 1;
            continue;
        }
        if depth == 0 && word(token, "PARTITION") {
            break;
        }
        if depth == 1
            && ["DEFAULT", "COMMENT", "GENERATED", "AS", "REFERENCES", "CHECK"]
                .iter()
                .any(|keyword| word(token, keyword))
        {
            column_declaration = false;
        }
        if depth == 0 || (depth == 1 && column_declaration) {
            let mut clause = i;
            if depth == 0 && word(token, "DEFAULT") {
                clause += 1;
            }
            let mut value = clause;
            if tokens.get(clause).is_some_and(|t| word(t, "CHARACTER"))
                && tokens.get(clause + 1).is_some_and(|t| word(t, "SET"))
            {
                value += 2;
            } else if tokens.get(clause).is_some_and(|t| word(t, "CHARSET") || word(t, "COLLATE")) {
                value += 1;
            }
            if value > clause {
                if tokens.get(value).is_some_and(|t| matches!(t.token, Token::Eq)) {
                    value += 1;
                }
                if let Some(end) =
                    tokens.get(value).filter(|t| matches!(t.token, Token::Word(_) | Token::SingleQuotedString(_)))
                {
                    ranges.push(offset(sql, token.span.start)..offset(sql, end.span.end));
                    i = value + 1;
                    continue;
                }
                return Err("Cannot read charset declaration in CREATE TABLE".into());
            }
        }
        i += 1;
    }
    let mut result = sql.to_string();
    for range in ranges.into_iter().rev() {
        result.replace_range(range, "");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_declaration_clauses_and_preserves_native_sql() {
        let sql = "CREATE TABLE `中文` (\n`charset` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'COLLATE utf8mb4_bin' COMMENT '字符集',\n`b` varchar(64) GENERATED ALWAYS AS (concat('CHARSET=utf8', 'x') COLLATE utf8mb4_bin),\nCHECK (`charset` COLLATE utf8mb4_bin <> '')\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='CHARACTER SET utf8';";
        let filtered = without_create_charset(sql).unwrap();
        assert!(!filtered.contains("CHARACTER SET utf8mb4"));
        assert!(!filtered.contains("DEFAULT CHARSET="));
        assert!(!filtered.contains("COLLATE="));
        assert!(filtered.contains("DEFAULT 'COLLATE utf8mb4_bin' COMMENT '字符集'"));
        assert!(filtered.contains("concat('CHARSET=utf8', 'x') COLLATE utf8mb4_bin"));
        assert!(filtered.contains("CHECK (`charset` COLLATE utf8mb4_bin <> '')"));
        assert!(filtered.contains("ENGINE=InnoDB"));
        assert!(filtered.contains("COMMENT='CHARACTER SET utf8'"));
    }
}
