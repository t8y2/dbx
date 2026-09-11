use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sqlparser::dialect::MySqlDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

/// The database is the scope in the dump, not the destination selected in the UI.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileTable {
    pub database: Option<String>,
    pub name: String,
}

#[derive(Default)]
pub(super) struct TableRestoreFilter {
    database: Option<String>,
    pub tables: BTreeSet<SqlFileTable>,
    views: BTreeSet<SqlFileTable>,
}

enum Scope {
    Table(SqlFileTable),
    DropTables(Vec<SqlFileTable>, bool),
    Session,
    DatabaseSession(String),
    Skip,
}

impl TableRestoreFilter {
    pub fn inspect(&mut self, sql: &str) -> Result<(), String> {
        match self.classify(sql)? {
            Scope::Table(table) => {
                self.tables.insert(table);
            }
            Scope::DropTables(tables, _) => self.tables.extend(tables),
            _ => {}
        }
        Ok(())
    }

    pub fn with_views(views: BTreeSet<SqlFileTable>) -> Self {
        Self { views, ..Self::default() }
    }

    pub fn finish(mut self) -> (Vec<SqlFileTable>, BTreeSet<SqlFileTable>) {
        self.tables.retain(|table| !self.views.contains(table));
        (self.tables.into_iter().collect(), self.views)
    }

    pub fn filter(&mut self, sql: &str, selected: &[SqlFileTable]) -> Result<Option<String>, String> {
        let scope = self.classify(sql)?;
        let includes = |table: &SqlFileTable| !self.views.contains(table) && selected.contains(table);
        match scope {
            Scope::Table(table) => {
                let included = includes(&table);
                self.tables.insert(table);
                Ok(included.then(|| sql.to_string()))
            }
            Scope::DropTables(tables, if_exists) => {
                let kept = tables.iter().filter(|table| includes(table)).map(quoted_table).collect::<Vec<_>>();
                self.tables.extend(tables);
                Ok((!kept.is_empty())
                    .then(|| format!("DROP TABLE {}{}", if if_exists { "IF EXISTS " } else { "" }, kept.join(", "))))
            }
            Scope::Session => Ok(Some(sql.to_string())),
            Scope::DatabaseSession(database) => {
                Ok(selected.iter().any(|table| table.database.as_ref() == Some(&database)).then(|| sql.to_string()))
            }
            Scope::Skip => Ok(None),
        }
    }

    fn classify(&mut self, sql: &str) -> Result<Scope, String> {
        // INSERT payloads can be gigabytes. Only tokenize the header; the existing
        // streaming splitter remains responsible for statement boundaries.
        let limit = sql.char_indices().nth(16_384).map_or(sql.len(), |(offset, _)| offset);
        let mut tokens = Vec::new();
        let tokenized = Tokenizer::new(&MySqlDialect {}, &sql[..limit]).tokenize_with_location_into_buf(&mut tokens);
        let tokens = tokens
            .into_iter()
            .map(|token| token.token)
            .filter(|token| !matches!(token, Token::Whitespace(_) | Token::EOF))
            .collect::<Vec<_>>();
        let mut cursor = Tokens { tokens: &tokens, index: 0 };
        if tokens.is_empty() && tokenized.is_ok() && limit == sql.len() {
            return Ok(Scope::Skip);
        }
        if cursor.eat("INSERT") || cursor.eat("REPLACE") {
            for modifier in ["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"] {
                cursor.eat(modifier);
            }
            cursor.eat("INTO");
            return cursor.table(&self.database).map(Scope::Table).ok_or_else(|| unsupported(sql));
        }
        // Object ownership is in the header even if a long definition was
        // truncated inside a string literal by the tokenizer limit.
        if cursor.eat("CREATE") {
            if cursor.eat("TEMPORARY") {
                return Err(unsupported(sql));
            }
            if cursor.eat("TABLE") {
                cursor.eat_if_not_exists();
                return cursor.table(&self.database).map(Scope::Table).ok_or_else(|| unsupported(sql));
            }
            // Dumps may use CREATE ... DEFINER ... SQL SECURITY ... VIEW.
            // Track views to exclude mysqldump's temporary table placeholders too.
            if let Some(index) = tokens.iter().take_while(|token| **token != Token::LParen).position(|token| {
                ["VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"].iter().any(|kind| word_is(token, kind))
            }) {
                if word_is(&tokens[index], "VIEW") {
                    cursor.index = index + 1;
                    self.views.insert(cursor.table(&self.database).ok_or_else(|| unsupported(sql))?);
                }
                return Ok(Scope::Skip);
            }
        }
        tokenized.map_err(|_| unsupported(sql))?;
        if limit != sql.len() {
            return Err(unsupported(sql));
        }
        cursor.index = 0;
        if cursor.eat("USE") {
            let database = cursor.identifier().ok_or_else(|| unsupported(sql))?;
            self.database = Some(database.clone());
            return Ok(Scope::DatabaseSession(database));
        }
        if cursor.eat("SET") {
            if cursor.eat("STATEMENT") {
                // MariaDB's SET STATEMENT ... FOR can wrap arbitrary mutations.
                return Err(unsupported(sql));
            }
            // Server-wide settings (including GTID_PURGED) are not part of a table restore.
            return Ok(
                if tokens.iter().any(|token| {
                    word_is(token, "GLOBAL")
                        || word_is(token, "@@GLOBAL")
                        || word_is(token, "PERSIST")
                        || word_is(token, "PERSIST_ONLY")
                }) {
                    Scope::Skip
                } else {
                    Scope::Session
                },
            );
        }
        if cursor.eat("BEGIN") {
            cursor.eat("WORK");
            cursor.eat_token(&Token::SemiColon);
            return if cursor.index == tokens.len() { Ok(Scope::Session) } else { Err(unsupported(sql)) };
        }
        if cursor.eat("START") && cursor.eat("TRANSACTION")
            || word_is(&tokens[0], "COMMIT")
            || word_is(&tokens[0], "ROLLBACK")
        {
            return Ok(Scope::Session);
        }
        if word_is(&tokens[0], "LOCK") || word_is(&tokens[0], "UNLOCK") {
            // The SQL-file executor already omits dump table locks.
            return Ok(Scope::Skip);
        }
        cursor.index = 0;
        if cursor.eat("CREATE") {
            if cursor.eat("DATABASE") || cursor.eat("SCHEMA") {
                // Keep only idempotent bootstrap, never destructive database DDL.
                if cursor.eat("IF") && cursor.eat("NOT") && cursor.eat("EXISTS") {
                    return Ok(Scope::DatabaseSession(cursor.identifier().ok_or_else(|| unsupported(sql))?));
                }
                return Ok(Scope::Skip);
            }
            cursor.eat("UNIQUE");
            cursor.eat("FULLTEXT");
            cursor.eat("SPATIAL");
            if cursor.eat("INDEX") {
                if let Some(index) = tokens.iter().position(|token| word_is(token, "ON")) {
                    cursor.index = index + 1;
                    return cursor.table(&self.database).map(Scope::Table).ok_or_else(|| unsupported(sql));
                }
            }
        }
        cursor.index = 0;
        if cursor.eat("DROP") {
            if cursor.eat("TEMPORARY") {
                return Err(unsupported(sql));
            }
            if cursor.eat("TABLE") {
                let if_exists = cursor.eat("IF") && cursor.eat("EXISTS");
                let mut tables = vec![cursor.table(&self.database).ok_or_else(|| unsupported(sql))?];
                while cursor.eat_token(&Token::Comma) {
                    tables.push(cursor.table(&self.database).ok_or_else(|| unsupported(sql))?);
                }
                cursor.eat("RESTRICT");
                cursor.eat("CASCADE");
                cursor.eat_token(&Token::SemiColon);
                if cursor.index != tokens.len() {
                    return Err(unsupported(sql));
                }
                return Ok(Scope::DropTables(tables, if_exists));
            }
            if ["DATABASE", "SCHEMA", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]
                .iter()
                .any(|kind| cursor.eat(kind))
            {
                return Ok(Scope::Skip);
            }
        }
        cursor.index = 0;
        if cursor.eat("ALTER") && cursor.eat("TABLE") {
            let table = cursor.table(&self.database).ok_or_else(|| unsupported(sql))?;
            // Renaming/exchanging a table can also mutate an unselected table.
            if tokens[cursor.index..].iter().any(|token| word_is(token, "RENAME") || word_is(token, "EXCHANGE")) {
                return Err(unsupported(sql));
            }
            return Ok(Scope::Table(table));
        }
        Err(unsupported(sql))
    }
}

fn unsupported(sql: &str) -> String {
    format!("Cannot safely restore selected tables from this statement: {}", crate::sql::statement_summary(sql))
}

fn word_is(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected))
}

struct Tokens<'a> {
    tokens: &'a [Token],
    index: usize,
}

impl Tokens<'_> {
    fn eat(&mut self, word: &str) -> bool {
        if self.tokens.get(self.index).is_some_and(|token| word_is(token, word)) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn eat_token(&mut self, token: &Token) -> bool {
        if self.tokens.get(self.index) == Some(token) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn eat_if_not_exists(&mut self) {
        if self.eat("IF") {
            self.eat("NOT");
            self.eat("EXISTS");
        }
    }

    fn identifier(&mut self) -> Option<String> {
        let Token::Word(word) = self.tokens.get(self.index)? else {
            return None;
        };
        self.index += 1;
        Some(word.value.clone())
    }

    fn table(&mut self, database: &Option<String>) -> Option<SqlFileTable> {
        let first = self.identifier()?;
        if self.eat_token(&Token::Period) {
            Some(SqlFileTable { database: Some(first), name: self.identifier()? })
        } else {
            Some(SqlFileTable { database: database.clone(), name: first })
        }
    }
}

fn quoted_table(table: &SqlFileTable) -> String {
    let quote = |name: &str| format!("`{}`", name.replace('`', "``"));
    match &table.database {
        Some(database) => format!("{}.{}", quote(database), quote(&table.name)),
        None => quote(&table.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;
    use crate::sql::split_sql_statements_for_database;

    fn table(database: Option<&str>, name: &str) -> SqlFileTable {
        SqlFileTable { database: database.map(str::to_string), name: name.to_string() }
    }

    fn restore(sql: &str, selected: &[SqlFileTable]) -> Result<Vec<String>, String> {
        let statements = split_sql_statements_for_database(sql, DatabaseType::Mysql);
        let mut scan = TableRestoreFilter::default();
        for statement in &statements {
            scan.inspect(statement)?;
        }
        let (_, views) = scan.finish();
        let mut filter = TableRestoreFilter::with_views(views);
        statements.iter().filter_map(|sql| filter.filter(sql, selected).transpose()).collect()
    }

    #[test]
    fn restores_only_selected_structure_and_data_with_session_context() {
        let sql = "SET FOREIGN_KEY_CHECKS=0; CREATE TABLE `a` (id INT); INSERT INTO a VALUES (1, 'DROP TABLE b;'); CREATE TABLE b (id INT); INSERT INTO b VALUES (2); SET FOREIGN_KEY_CHECKS=1;";
        assert_eq!(
            restore(sql, &[table(None, "a")]).unwrap(),
            vec![
                "SET FOREIGN_KEY_CHECKS=0",
                "CREATE TABLE `a` (id INT)",
                "INSERT INTO a VALUES (1, 'DROP TABLE b;')",
                "SET FOREIGN_KEY_CHECKS=1",
            ]
        );
    }

    #[test]
    fn distinguishes_databases_and_escaped_identifiers() {
        let sql = "USE first; INSERT INTO `a``b` VALUES (1); USE second; INSERT INTO `a``b` VALUES (2); INSERT INTO first.`a``b` VALUES (3);";
        let statements = restore(sql, &[table(Some("first"), "a`b")]).unwrap();
        assert_eq!(statements.iter().filter(|sql| sql.starts_with("INSERT")).count(), 2);
        assert!(!statements.iter().any(|sql| sql.contains("(2)")));
    }

    #[test]
    fn filters_multi_table_drop_without_dropping_unselected_tables() {
        assert_eq!(
            restore("DROP TABLE IF EXISTS a, b;", &[table(None, "a")]).unwrap(),
            vec!["DROP TABLE IF EXISTS `a`"]
        );
    }

    #[test]
    fn excludes_view_placeholders_routines_and_global_changes() {
        let sql = "CREATE TABLE v (id INT); DROP TABLE IF EXISTS v; CREATE VIEW v AS SELECT * FROM a; DROP DATABASE other; SET @@GLOBAL.GTID_PURGED='x'; CREATE TABLE a (id INT);";
        assert_eq!(restore(sql, &[table(None, "a"), table(None, "v")]).unwrap(), vec!["CREATE TABLE a (id INT)"]);
    }

    #[test]
    fn handles_version_comments_key_toggles_and_insert_modifiers() {
        let sql = "/*!40000 ALTER TABLE a DISABLE KEYS */; INSERT IGNORE INTO a VALUES (1); REPLACE INTO b VALUES (2); /*!40000 ALTER TABLE a ENABLE KEYS */;";
        assert_eq!(restore(sql, &[table(None, "a")]).unwrap().len(), 3);
    }

    #[test]
    fn rejects_unknown_and_multi_target_mutations_before_execution() {
        for sql in [
            "CALL remove_all()",
            "UPDATE a JOIN b SET b.id=1",
            "ALTER TABLE a RENAME TO b",
            "RENAME TABLE a TO b",
            "DROP TEMPORARY TABLE a",
            "CREATE TEMPORARY TABLE a (id INT)",
            "SET STATEMENT max_statement_time=1 FOR DELETE FROM b",
            "BEGIN NOT ATOMIC DELETE FROM b; END",
        ] {
            assert!(restore(sql, &[table(None, "a")]).is_err(), "{sql}");
        }
    }

    #[test]
    fn identifies_large_insert_without_tokenizing_its_values() {
        let sql = format!("INSERT INTO a VALUES ('{}');", "x".repeat(1_000_000));
        assert_eq!(restore(&sql, &[table(None, "a")]).unwrap().len(), 1);
        assert!(restore(&sql, &[table(None, "b")]).unwrap().is_empty());
    }

    #[test]
    fn identifies_large_definitions_without_parsing_their_bodies() {
        let body = "x".repeat(100_000);
        let ddl = format!("CREATE TABLE a (body TEXT COMMENT '{body}')");
        let sql = format!("{ddl}; CREATE VIEW v AS SELECT '{body}';\nDELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT '{body}'; END;;\nDELIMITER ;\n");
        assert_eq!(restore(&sql, &[table(None, "a")]).unwrap(), vec![ddl]);
    }

    #[test]
    fn skips_mysqldump_view_placeholders_and_delimited_triggers() {
        let sql = "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
            CREATE TABLE a (id INT);
            CREATE TABLE v (id INT);
            DELIMITER ;;
            /*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER tr AFTER INSERT ON a FOR EACH ROW BEGIN INSERT INTO audit VALUES (NEW.id); END */;;
            DELIMITER ;
            DROP TABLE IF EXISTS v;
            /*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ /*!50001 VIEW v AS SELECT id FROM a */;
            INSERT INTO a VALUES (1);
            /*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;";
        let statements = restore(sql, &[table(None, "a"), table(None, "v")]).unwrap();
        assert_eq!(statements.len(), 4);
        assert!(statements.iter().any(|sql| sql == "INSERT INTO a VALUES (1)"));
    }
}
