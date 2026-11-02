const UNSAFE_WORDS: &[&str] = &[
    "CREATE",
    "INSERT",
    "MERGE",
    "SET",
    "REMOVE",
    "DELETE",
    "DETACH",
    "DROP",
    "ALTER",
    "RENAME",
    "GRANT",
    "REVOKE",
    "DENY",
    "CALL",
    "FOREACH",
    "LOAD",
    "START",
    "STOP",
    "TERMINATE",
];

// Cypher's `--` is a relationship, not a SQL line comment. Keep this scanner
// separate so trailing writes cannot disappear during SQL comment stripping.
pub(crate) fn is_proven_read_only_cypher(source: &str) -> bool {
    // Neo4j expands Unicode escapes before lexing, including inside comments.
    if source.contains("\\u") {
        return false;
    }
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut statements = vec![Vec::<String>::new()];
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if ch == '/' && next == Some('/') {
            index += 2;
            while index < chars.len() && !matches!(chars[index], '\n' | '\r') {
                index += 1;
            }
        } else if ch == '/' && next == Some('*') {
            index += 2;
            let mut depth = 1;
            while index < chars.len() && depth > 0 {
                match (chars[index], chars.get(index + 1)) {
                    ('/', Some('*')) => {
                        return false;
                    }
                    ('*', Some('/')) => {
                        depth -= 1;
                        index += 2;
                    }
                    _ => index += 1,
                }
            }
            if depth != 0 {
                return false;
            }
        } else if matches!(ch, '\'' | '"' | '`') {
            index += 1;
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '\\' {
                    index += 2;
                } else if chars[index] == ch {
                    index += 1;
                    if chars.get(index) == Some(&ch) {
                        index += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            if !closed {
                return false;
            }
            statements.last_mut().unwrap().push("<quoted>".into());
        } else if ch == ';' {
            statements.push(Vec::new());
            index += 1;
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let start = index;
            index += 1;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            statements.last_mut().unwrap().push(chars[start..index].iter().collect::<String>().to_ascii_uppercase());
        } else {
            if matches!(ch, '.' | ':' | '$') {
                statements.last_mut().unwrap().push(ch.to_string());
            } else if !ch.is_whitespace() {
                statements.last_mut().unwrap().push("<symbol>".into());
            }
            index += 1;
        }
    }
    let statements: Vec<_> = statements.iter().filter(|words| !words.is_empty()).collect();
    !statements.is_empty()
        && statements.iter().all(|words| {
            matches!(
                words.first().map(String::as_str),
                Some("MATCH" | "OPTIONAL" | "RETURN" | "WITH" | "UNWIND" | "SHOW" | "EXPLAIN" | "PROFILE")
            ) && (words[0] == "SHOW" || words.iter().any(|word| word == "RETURN"))
                && !words.iter().enumerate().any(|(index, word)| {
                    UNSAFE_WORDS.contains(&word.as_str())
                        && !matches!(
                            index.checked_sub(1).and_then(|previous| words.get(previous)).map(String::as_str),
                            Some("." | ":" | "$")
                        )
                        && words.get(index + 1).map(String::as_str) != Some(":")
                })
        })
}

#[cfg(test)]
mod tests {
    use crate::{models::connection::DatabaseType, query_execution_sql::check_read_only};

    #[test]
    fn cypher_reads_are_allowed_only_for_neo4j() {
        for source in [
            "MATCH (n)-->(m) RETURN n,m",
            "MATCH (n) WHERE elementId(n) = '4:id:1' OPTIONAL MATCH (n)-[r]-(m) RETURN n,r,m LIMIT 200",
            "// SET is a comment\nMATCH (n:`DELETE`) WHERE n.name = 'CREATE; SET' RETURN n",
            "UNWIND [1,2] AS x RETURN x; RETURN 1",
            "SHOW DATABASES",
            "EXPLAIN MATCH (n) RETURN n",
            "/* comment */ WITH 1 AS x RETURN x",
            "WITH {set: 1, delete: 2} AS m RETURN m.set, m.delete",
            "MATCH (n:SET) WHERE n.remove = $delete RETURN n",
            "MATCH (n) RETURN n./* property */set",
        ] {
            assert!(check_read_only(source, "test", DatabaseType::Neo4j).is_ok(), "{source}");
        }
        assert!(check_read_only("MATCH (n) RETURN n", "test", DatabaseType::Mysql).is_err());
    }

    #[test]
    fn cypher_writes_procedures_and_incomplete_input_are_blocked() {
        for source in [
            "MATCH (n)-->(m) SET n.x = 1 RETURN n",
            "MATCH (n) RETURN n /* outer /* inner */ UNION MATCH (m) SET m.x=1 RETURN m /* */",
            "MATCH (n) RETURN n; CREATE (m)",
            "MATCH (n) WITH n DETACH DELETE n RETURN 1",
            "MATCH (n) CALL { WITH n SET n.x = 1 } RETURN n",
            "WITH 1 AS x CALL apoc.cypher.run('CREATE (n)', {}) YIELD value RETURN value",
            "MATCH (n) FOREACH (x IN [1] | SET n.x = x) RETURN n",
            "INSERT (n) RETURN n",
            "SHOW TRANSACTIONS YIELD transactionId TERMINATE TRANSACTIONS transactionId",
            "RETURN 'unterminated",
            "RETURN 1 /*",
            "",
            "// read",
            "MATCH (n) RETURN 'escaped\\' quote' SET n.x = 1 RETURN n",
            r"MATCH (n) \u0053ET n.p = 1 RETURN n",
            r"MATCH (n) // hidden\u000ASET n.p = 1 RETURN n",
            r"MATCH (n) RETURN n.\u0060name\u0060 SET n.p = 1 RETURN n",
            "WITH {set: 1} AS m MATCH (n) SET n.p = m.set RETURN n",
            "MATCH (n:SET) DELETE n RETURN 1",
            "MATCH (n) RETURN n.set; CALL dbms.killQuery('q')",
        ] {
            assert!(check_read_only(source, "test", DatabaseType::Neo4j).is_err(), "{source}");
        }
    }
}
