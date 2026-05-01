#[derive(Default)]
struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    previous: Option<char>,
}

impl SqlStatementSplitter {
    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let mut chars = chunk.chars().peekable();

        while let Some(ch) = chars.next() {
            let next = chars.peek().copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    continue;
                }
            }

            match ch {
                '\'' if !self.in_double_quote
                    && !self.in_backtick
                    && self.previous != Some('\\') =>
                {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote
                    && !self.in_backtick
                    && self.previous != Some('\\') =>
                {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    self.push_current_statement(&mut statements);
                }
                _ => self.buffer.push(ch),
            }

            self.previous = Some(ch);
        }

        statements
    }

    fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if !statement.is_empty() {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.previous = None;
    }
}

#[cfg(test)]
fn split_sql_script(sql: &str) -> Result<Vec<String>, String> {
    let mut splitter = SqlStatementSplitter::default();
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    Ok(statements)
}

#[cfg(test)]
mod tests {
    use super::split_sql_script;

    #[test]
    fn splits_semicolon_delimited_statements() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int); INSERT INTO a VALUES (1);").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn ignores_semicolons_inside_quotes_and_comments() {
        let sql = "\
            INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`);\n\
            -- comment ; ignored\n\
            /* block ; ignored */\n\
            SELECT 1;";
        assert_eq!(
            split_sql_script(sql).unwrap(),
            vec![
                "INSERT INTO logs VALUES ('a;b', \"c;d\", `weird;name`)",
                "-- comment ; ignored\n/* block ; ignored */\nSELECT 1",
            ]
        );
    }

    #[test]
    fn emits_trailing_statement_without_semicolon() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int);\nINSERT INTO a VALUES (1)").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }
}
