use serde::{Deserialize, Serialize};
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::models::connection::DatabaseType;

pub const MIN_FUZZY_FILTER_CHARS: usize = 2;

pub fn fuzzy_filter_enabled(filter: &str) -> bool {
    filter.trim().chars().count() >= MIN_FUZZY_FILTER_CHARS
}

pub fn fuzzy_subsequence_match(text: &str, filter: &str) -> bool {
    let filter = filter.trim().to_lowercase();
    if filter.is_empty() {
        return true;
    }

    let text = text.to_lowercase();
    let mut chars = text.chars();
    for needle in filter.chars() {
        if !chars.any(|candidate| candidate == needle) {
            return false;
        }
    }
    true
}

pub fn contains_or_fuzzy_match(text: &str, filter: &str) -> bool {
    let filter = filter.trim().to_lowercase();
    if filter.is_empty() {
        return true;
    }

    let text = text.to_lowercase();
    text.contains(&filter) || (fuzzy_filter_enabled(&filter) && fuzzy_subsequence_match(&text, &filter))
}

pub fn fuzzy_like_pattern_with_escape(value: &str, mut escape: impl FnMut(&str) -> String) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "%%".to_string();
    }

    let mut pattern = String::with_capacity(value.len() * 2 + 2);
    pattern.push('%');
    for ch in value.chars() {
        pattern.push_str(&escape(&ch.to_string()));
        pattern.push('%');
    }
    pattern
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRequest {
    pub execution_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileStatus {
    Started,
    Running,
    StatementDone,
    StatementFailed,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlFileStatementAction {
    Execute(String),
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlFileImportStatementKind {
    Execute,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlFileImportStatement {
    pub kind: SqlFileImportStatementKind,
    pub sql: String,
    pub source_sqls: Vec<String>,
    pub source_statement_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SqlDialectProfile {
    supports_hash_line_comments: bool,
    supports_oracle_plsql_blocks: bool,
    supports_slash_line_block_delimiter: bool,
    supports_custom_delimiter_commands: bool,
    supports_dollar_quoted_strings: bool,
    supports_go_batch_separator: bool,
    keeps_sqlserver_module_batch_at_cursor: bool,
}

impl Default for SqlDialectProfile {
    fn default() -> Self {
        Self {
            supports_hash_line_comments: false,
            supports_oracle_plsql_blocks: false,
            supports_slash_line_block_delimiter: false,
            supports_custom_delimiter_commands: true,
            supports_dollar_quoted_strings: true,
            supports_go_batch_separator: false,
            keeps_sqlserver_module_batch_at_cursor: false,
        }
    }
}

impl SqlDialectProfile {
    fn for_database_type(db_type: DatabaseType) -> Self {
        if Self::is_oracle_like_database(db_type) {
            return Self::oracle_like();
        }

        if matches!(db_type, DatabaseType::SqlServer) {
            return Self::sql_server();
        }

        if Self::is_mysql_compatible_database(db_type) {
            return Self::mysql_compatible();
        }

        Self::default()
    }

    fn mysql_compatible() -> Self {
        Self { supports_hash_line_comments: true, ..Self::default() }
    }

    fn oracle_like() -> Self {
        Self { supports_oracle_plsql_blocks: true, supports_slash_line_block_delimiter: true, ..Self::default() }
    }

    fn sql_server() -> Self {
        Self { supports_go_batch_separator: true, keeps_sqlserver_module_batch_at_cursor: true, ..Self::default() }
    }

    fn is_mysql_compatible_database(db_type: DatabaseType) -> bool {
        matches!(
            db_type,
            DatabaseType::Mysql
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::ManticoreSearch
                | DatabaseType::Goldendb
        )
    }

    fn is_oracle_like_database(db_type: DatabaseType) -> bool {
        matches!(
            db_type,
            DatabaseType::Oracle
                | DatabaseType::Dameng
                | DatabaseType::Gaussdb
                | DatabaseType::Yashandb
                | DatabaseType::Oscar
                | DatabaseType::OceanbaseOracle
        )
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SqlParsingOptions {
    profile: SqlDialectProfile,
}

impl SqlParsingOptions {
    pub fn for_database_type(db_type: DatabaseType) -> Self {
        Self::from_profile(SqlDialectProfile::for_database_type(db_type))
    }

    pub fn mysql_compatible() -> Self {
        Self::from_profile(SqlDialectProfile::mysql_compatible())
    }

    fn from_profile(profile: SqlDialectProfile) -> Self {
        Self { profile }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileProgress {
    pub execution_id: String,
    pub status: SqlFileStatus,
    pub statement_index: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: Option<String>,
}

pub fn decode_sql_file_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..]).map(|text| text.to_string()).map_err(|_| sql_file_encoding_error());
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_sql_file_with_encoding(&bytes[2..], encoding_rs::UTF_16LE);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_sql_file_with_encoding(&bytes[2..], encoding_rs::UTF_16BE);
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_string());
    }

    decode_sql_file_with_encoding(bytes, encoding_rs::GBK)
}

fn decode_sql_file_with_encoding(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> Result<String, String> {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        return Err(sql_file_encoding_error());
    }
    Ok(text.into_owned())
}

fn sql_file_encoding_error() -> String {
    "Unsupported SQL file encoding. Save the file as UTF-8, UTF-8 with BOM, UTF-16 with BOM, or GBK, then try again."
        .to_string()
}

#[derive(Default)]
pub struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    dollar_quote_tag: Option<String>,
    previous: Option<char>,
    custom_delimiter: Option<String>,
    options: SqlParsingOptions,
}

impl SqlStatementSplitter {
    pub fn with_options(options: SqlParsingOptions) -> Self {
        Self { options, ..Self::default() }
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let chars = chunk.chars().collect::<Vec<_>>();
        let mut i = 0;

        while i < chars.len() {
            if let Some(tag) = &self.dollar_quote_tag {
                let tag_chars = tag.chars().collect::<Vec<_>>();
                if starts_with_chars(&chars, i, &tag_chars) {
                    for tag_ch in &tag_chars {
                        self.buffer.push(*tag_ch);
                        self.previous = Some(*tag_ch);
                    }
                    i += tag_chars.len();
                    self.dollar_quote_tag = None;
                    continue;
                }

                let ch = chars[i];
                self.buffer.push(ch);
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            let ch = chars[i];
            let next = chars.get(i + 1).copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if self.previous == Some('-') && ch == '-' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if self.previous == Some('/') && ch == '*' {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if self.options.profile.supports_hash_line_comments && ch == '#' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if let Some(tag) = self
                    .options
                    .profile
                    .supports_dollar_quoted_strings
                    .then(|| dollar_quote_tag_at(&chars, i))
                    .flatten()
                {
                    if self.custom_delimiter.is_none() && !self.on_delimiter_line() {
                        for tag_ch in tag.chars() {
                            self.buffer.push(tag_ch);
                            self.previous = Some(tag_ch);
                        }
                        i += tag.chars().count();
                        self.dollar_quote_tag = Some(tag);
                        continue;
                    }
                }
            }

            match ch {
                '\'' if !self.in_double_quote && !self.in_backtick && self.previous != Some('\\') => {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote && !self.in_backtick && self.previous != Some('\\') => {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    if self.options.profile.supports_custom_delimiter_commands && self.on_delimiter_line() {
                        self.buffer.push(ch);
                    } else if self.custom_delimiter.is_some() {
                        self.buffer.push(ch);
                    } else if self.options.profile.supports_oracle_plsql_blocks
                        && starts_with_oracle_plsql_block(&self.buffer)
                    {
                        self.buffer.push(ch);
                        if oracle_plsql_block_is_complete(&self.buffer) {
                            self.push_current_statement(&mut statements);
                        }
                    } else {
                        self.push_current_statement(&mut statements);
                    }
                }
                _ => self.buffer.push(ch),
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick && self.dollar_quote_tag.is_none() {
                if ch == '\n' {
                    let buf_end = self.buffer.len() - 1;
                    let last_line_start = self.buffer[..buf_end].rfind('\n').map_or(0, |p| p + 1);
                    let last_line = self.buffer[last_line_start..buf_end].trim();
                    if self.options.profile.supports_slash_line_block_delimiter && last_line == "/" {
                        let before = self.buffer[..last_line_start].trim();
                        if has_executable_sql_with_options(before, self.options) {
                            statements.push(before.to_string());
                        }
                        self.buffer.clear();
                        self.previous = None;
                        i += 1;
                        continue;
                    }
                    if let Some(new_delim) = self
                        .options
                        .profile
                        .supports_custom_delimiter_commands
                        .then(|| parse_delimiter_command(last_line))
                        .flatten()
                    {
                        self.custom_delimiter = if new_delim == ";" { None } else { Some(new_delim.to_string()) };
                        if last_line_start > 0 {
                            let before = self.buffer[..last_line_start].trim();
                            if has_executable_sql_with_options(before, self.options) {
                                statements.push(before.to_string());
                            }
                        }
                        self.buffer.clear();
                        self.previous = None;
                        i += 1;
                        continue;
                    }
                }
                if let Some(delim) = self.custom_delimiter.clone() {
                    if self.buffer.ends_with(delim.as_str()) {
                        self.buffer.truncate(self.buffer.len() - delim.len());
                        self.push_current_statement(&mut statements);
                    }
                }
            }

            self.previous = Some(ch);
            i += 1;
        }

        statements
    }

    pub fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        let trimmed = self.buffer.trim();
        let last_line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
        if self.options.profile.supports_custom_delimiter_commands && parse_delimiter_command(last_line).is_some() {
            let before = trimmed.rsplit_once('\n').map(|x| x.0).unwrap_or("").trim();
            if has_executable_sql_with_options(before, self.options) {
                statements.push(before.to_string());
            }
            self.buffer.clear();
        } else if self.options.profile.supports_slash_line_block_delimiter && last_line == "/" {
            let before = trimmed.rsplit_once('\n').map(|x| x.0).unwrap_or("").trim();
            if has_executable_sql_with_options(before, self.options) {
                statements.push(before.to_string());
            }
            self.buffer.clear();
        } else if let Some(ref delim) = self.custom_delimiter {
            if self.buffer.ends_with(delim.as_str()) {
                self.buffer.truncate(self.buffer.len() - delim.len());
            }
        }
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if has_executable_sql_with_options(statement, self.options) {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.previous = None;
    }

    fn on_delimiter_line(&self) -> bool {
        let start = self.buffer.rfind('\n').map_or(0, |p| p + 1);
        let line = self.buffer[start..].trim_start().as_bytes();
        line.len() >= 9 && line[..9].eq_ignore_ascii_case(b"delimiter")
    }
}

pub fn split_sql_statements(sql: &str) -> Vec<String> {
    split_sql_statements_with_options(sql, SqlParsingOptions::default())
}

pub fn split_sql_statements_for_database(sql: &str, db_type: DatabaseType) -> Vec<String> {
    split_sql_statements_with_options(sql, SqlParsingOptions::for_database_type(db_type))
}

pub fn split_sql_statements_with_options(sql: &str, options: SqlParsingOptions) -> Vec<String> {
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    statements
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlStatementRange {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

pub fn find_statement_at_cursor(sql: &str, cursor_pos: usize) -> String {
    find_statement_at_cursor_with_options(sql, cursor_pos, SqlParsingOptions::default())
}

pub fn find_statement_at_cursor_for_database(sql: &str, cursor_pos: usize, db_type: DatabaseType) -> String {
    if db_type == DatabaseType::SqlServer {
        return find_sqlserver_statement_at_cursor(sql, cursor_pos);
    }
    find_statement_at_cursor_with_options(sql, cursor_pos, SqlParsingOptions::for_database_type(db_type))
}

pub fn find_statement_at_cursor_with_options(sql: &str, cursor_pos: usize, options: SqlParsingOptions) -> String {
    let statements = split_sql_statement_ranges_with_options(sql, options);
    let cursor = utf16_offset_to_byte_index(sql, cursor_pos);

    for (idx, statement) in statements.iter().enumerate() {
        if cursor > statement.start && cursor < statement.end {
            return statement_text_at_cursor(sql, statement, cursor, options);
        }

        if cursor == statement.start {
            if cursor_has_sql_after_cursor_on_line(sql, cursor) {
                return statement_text_at_cursor(sql, statement, cursor, options);
            }
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| statements.get(prev_idx)) {
                return statement_text_at_cursor(sql, prev, cursor, options);
            }
            return statement_text_at_cursor(sql, statement, cursor, options);
        }

        if cursor < statement.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| statements.get(prev_idx)) {
                return statement_text_at_cursor(sql, prev, cursor, options);
            }
            return statement_text_at_cursor(sql, statement, cursor, options);
        }
    }

    statements
        .last()
        .map(|statement| statement_text_at_cursor(sql, statement, cursor, options))
        .unwrap_or_else(|| sql.trim().to_string())
}

fn cursor_has_sql_after_cursor_on_line(sql: &str, cursor: usize) -> bool {
    let line_end = sql[cursor..].find('\n').map_or(sql.len(), |offset| cursor + offset);
    sql[cursor..line_end].chars().any(|ch| !ch.is_whitespace())
}

fn statement_text_at_cursor(
    sql: &str,
    statement: &SqlStatementRange,
    cursor: usize,
    options: SqlParsingOptions,
) -> String {
    let soft_ranges = split_statement_range_at_blank_lines(sql, statement, options);
    find_statement_text_in_ranges(sql, &soft_ranges, cursor).unwrap_or_else(|| statement.text.clone())
}

fn find_statement_text_in_ranges(sql: &str, ranges: &[SqlStatementRange], cursor: usize) -> Option<String> {
    for (idx, range) in ranges.iter().enumerate() {
        if cursor > range.start && cursor < range.end {
            return Some(range.text.clone());
        }

        if cursor == range.start {
            if cursor_has_sql_after_cursor_on_line(sql, cursor) {
                return Some(range.text.clone());
            }
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| ranges.get(prev_idx)) {
                return Some(prev.text.clone());
            }
            return Some(range.text.clone());
        }

        if cursor < range.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| ranges.get(prev_idx)) {
                return Some(prev.text.clone());
            }
            return Some(range.text.clone());
        }
    }

    ranges.last().map(|range| range.text.clone())
}

fn split_statement_range_at_blank_lines(
    sql: &str,
    statement: &SqlStatementRange,
    options: SqlParsingOptions,
) -> Vec<SqlStatementRange> {
    if options.profile.supports_oracle_plsql_blocks && starts_with_oracle_plsql_block(&statement.text) {
        return vec![statement.clone()];
    }

    let mut ranges = Vec::new();
    let mut scanner = SqlScanner::with_profile(options.profile);
    let mut current_start = statement.start;
    let mut line_start = statement.start;
    let mut line_has_non_whitespace = false;
    let mut blank_line_run = 0usize;

    for (relative_idx, ch) in sql[statement.start..statement.end].char_indices() {
        let idx = statement.start + relative_idx;
        if ch == '\n' {
            if !line_has_non_whitespace && !scanner.is_masked() {
                blank_line_run += 1;
            } else {
                blank_line_run = 0;
            }
            scanner.step(sql, idx, ch);
            line_start = idx + ch.len_utf8();
            line_has_non_whitespace = false;
            continue;
        }

        if !line_has_non_whitespace && !ch.is_whitespace() {
            if blank_line_run >= 2
                && !scanner.is_masked()
                && has_executable_sql_with_options(&sql[current_start..line_start], options)
                && starts_with_soft_statement_keyword(&sql[line_start..statement.end], options)
            {
                push_statement_range(&mut ranges, sql, current_start, line_start, options);
                current_start = line_start;
            }
            blank_line_run = 0;
            line_has_non_whitespace = true;
        }

        scanner.step(sql, idx, ch);
    }

    push_statement_range(&mut ranges, sql, current_start, statement.end, options);
    if ranges.is_empty() {
        vec![statement.clone()]
    } else {
        ranges
    }
}

fn starts_with_soft_statement_keyword(sql: &str, options: SqlParsingOptions) -> bool {
    starts_with_executable_sql_keyword_with_options(
        sql,
        &[
            "CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "TRUNCATE", "GRANT", "REVOKE",
            "COMMENT", "EXPLAIN", "SHOW", "DESCRIBE", "USE", "SET", "CALL", "EXEC", "EXECUTE", "BEGIN", "COMMIT",
            "ROLLBACK", "DECLARE", "ANALYZE", "VACUUM", "PRAGMA", "REFRESH", "COPY",
        ],
        options,
    )
}

#[allow(dead_code)]
fn split_sql_statement_ranges(sql: &str) -> Vec<SqlStatementRange> {
    split_sql_statement_ranges_with_options(sql, SqlParsingOptions::default())
}

fn split_sql_statement_ranges_with_options(sql: &str, options: SqlParsingOptions) -> Vec<SqlStatementRange> {
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_quote_tag: Option<String> = None;
    let mut custom_delimiter: Option<String> = None;

    while i < sql.len() {
        if let Some(tag) = &dollar_quote_tag {
            if sql[i..].starts_with(tag) {
                i += tag.len();
                dollar_quote_tag = None;
                continue;
            }
            i += next_char_len(sql, i);
            continue;
        }

        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());

        if in_line_comment {
            i += ch.len_utf8();
            if ch == '\n' {
                in_line_comment = false;
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                i += 2;
                in_block_comment = false;
            } else {
                i += ch.len_utf8();
            }
            continue;
        }

        if !in_single_quote && !in_double_quote && !in_backtick {
            if ch == '-' && next == Some('-') {
                in_line_comment = true;
                i += 2;
                continue;
            }
            if options.profile.supports_hash_line_comments && ch == '#' {
                in_line_comment = true;
                i += ch.len_utf8();
                continue;
            }
            if ch == '/' && next == Some('*') {
                in_block_comment = true;
                i += 2;
                continue;
            }
            if let Some(tag) =
                options.profile.supports_dollar_quoted_strings.then(|| dollar_quote_tag_at_str(sql, i)).flatten()
            {
                if custom_delimiter.is_none() && !is_on_delimiter_line(sql, start, i) {
                    i += tag.len();
                    dollar_quote_tag = Some(tag);
                    continue;
                }
            }
            if ch == '\n' {
                let line_start = sql[..i].rfind('\n').map_or(0, |pos| pos + 1);
                let line = sql[line_start..i].trim();
                if options.profile.supports_slash_line_block_delimiter && line == "/" {
                    push_statement_range(&mut ranges, sql, start, line_start, options);
                    start = i + ch.len_utf8();
                    i = start;
                    continue;
                }
                if let Some(new_delimiter) =
                    options.profile.supports_custom_delimiter_commands.then(|| parse_delimiter_command(line)).flatten()
                {
                    let before = sql[start..line_start].trim();
                    if has_executable_sql_with_options(before, options) {
                        push_statement_range(&mut ranges, sql, start, line_start, options);
                    }
                    custom_delimiter = if new_delimiter == ";" { None } else { Some(new_delimiter.to_string()) };
                    start = i + ch.len_utf8();
                    i = start;
                    continue;
                }
            }
        }

        match ch {
            '\'' if !in_double_quote && !in_backtick && !is_escaped_single_quote(sql, i) => {
                in_single_quote = !in_single_quote;
                i += ch.len_utf8();
            }
            '"' if !in_single_quote && !in_backtick => {
                in_double_quote = !in_double_quote;
                i += ch.len_utf8();
            }
            '`' if !in_single_quote && !in_double_quote => {
                in_backtick = !in_backtick;
                i += ch.len_utf8();
            }
            ';' if !in_single_quote
                && !in_double_quote
                && !in_backtick
                && custom_delimiter.is_none()
                && !(options.profile.supports_custom_delimiter_commands && is_on_delimiter_line(sql, start, i)) =>
            {
                let is_oracle_plsql =
                    options.profile.supports_oracle_plsql_blocks && starts_with_oracle_plsql_block(&sql[start..i]);
                if is_oracle_plsql {
                    if !oracle_plsql_block_is_complete(&sql[start..i + ch.len_utf8()]) {
                        i += ch.len_utf8();
                        continue;
                    }
                    push_statement_range(&mut ranges, sql, start, i + ch.len_utf8(), options);
                } else {
                    push_statement_range(&mut ranges, sql, start, i, options);
                }
                i += ch.len_utf8();
                start = i;
            }
            _ => {
                i += ch.len_utf8();
                if !in_single_quote && !in_double_quote && !in_backtick {
                    if let Some(delimiter) = &custom_delimiter {
                        if sql[start..i].ends_with(delimiter) {
                            let end = i - delimiter.len();
                            push_statement_range(&mut ranges, sql, start, end, options);
                            start = i;
                        }
                    }
                }
            }
        }
    }

    let trimmed = sql[start..].trim();
    let last_line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
    if options.profile.supports_custom_delimiter_commands && parse_delimiter_command(last_line).is_some() {
        if let Some(line_start) = sql[start..].rfind('\n').map(|pos| start + pos + 1) {
            push_statement_range(&mut ranges, sql, start, line_start, options);
        }
    } else if options.profile.supports_slash_line_block_delimiter && last_line == "/" {
        if let Some(line_start) = sql[start..].rfind('\n').map(|pos| start + pos + 1) {
            push_statement_range(&mut ranges, sql, start, line_start, options);
        }
    } else {
        push_statement_range(&mut ranges, sql, start, sql.len(), options);
    }

    ranges
}

fn push_statement_range(
    ranges: &mut Vec<SqlStatementRange>,
    sql: &str,
    start: usize,
    end: usize,
    options: SqlParsingOptions,
) {
    let Some((relative_start, relative_end)) = executable_sql_bounds(&sql[start..end], options) else {
        return;
    };
    let statement_start = start + relative_start;
    let statement_end = start + relative_end;
    let text = sql[statement_start..statement_end].to_string();
    if !text.is_empty() {
        ranges.push(SqlStatementRange { text, start: statement_start, end: statement_end });
    }
}

fn utf16_offset_to_byte_index(sql: &str, offset: usize) -> usize {
    let mut utf16_seen = 0;
    for (byte_index, ch) in sql.char_indices() {
        if utf16_seen >= offset {
            return byte_index;
        }
        utf16_seen += ch.len_utf16();
        if utf16_seen > offset {
            return byte_index + ch.len_utf8();
        }
    }
    sql.len()
}

fn next_char(sql: &str, index: usize) -> char {
    sql[index..].chars().next().unwrap_or('\0')
}

fn next_char_at(sql: &str, index: usize) -> Option<char> {
    if index >= sql.len() {
        None
    } else {
        sql[index..].chars().next()
    }
}

fn next_char_len(sql: &str, index: usize) -> usize {
    next_char(sql, index).len_utf8()
}

fn is_escaped_single_quote(sql: &str, index: usize) -> bool {
    index > 0 && sql.as_bytes().get(index - 1) == Some(&b'\\')
}

fn is_on_delimiter_line(sql: &str, range_start: usize, index: usize) -> bool {
    let line_start = sql[range_start..index].rfind('\n').map_or(range_start, |pos| range_start + pos + 1);
    sql[line_start..index]
        .trim_start()
        .as_bytes()
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"delimiter"))
}

fn dollar_quote_tag_at_str(sql: &str, index: usize) -> Option<String> {
    let rest = &sql[index..];
    if !rest.starts_with('$') {
        return None;
    }
    let end = rest[1..].find('$')? + 1;
    let tag = &rest[..=end];
    if tag.len() == 2 {
        return Some(tag.to_string());
    }
    let name = &tag[1..tag.len() - 1];
    if !name.chars().all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return None;
    }
    Some(tag.to_string())
}

pub fn split_sql_batches(sql: &str) -> Vec<String> {
    let ranges = split_sql_batch_ranges(sql, SqlDialectProfile::sql_server());
    if ranges.is_empty() {
        let trimmed = sql.trim();
        return if trimmed.is_empty() { Vec::new() } else { vec![trimmed.to_string()] };
    }
    ranges.into_iter().map(|range| range.text).collect()
}

fn split_sql_batch_ranges(sql: &str, profile: SqlDialectProfile) -> Vec<SqlStatementRange> {
    let mut batches = Vec::new();
    let mut current_start = 0;
    let lines: Vec<&str> = sql.split('\n').collect();
    let mut offset = 0;

    for line in &lines {
        let line_start = offset;
        let line_end = offset + line.len();
        offset = line_end + 1; // +1 for the '\n'

        let trimmed = line.trim();
        if profile.supports_go_batch_separator
            && (trimmed.eq_ignore_ascii_case("go")
                || trimmed.to_ascii_lowercase().starts_with("go ") && trimmed[2..].trim().is_empty())
        {
            push_batch_range(&mut batches, sql, current_start, line_start);
            current_start = line_end.min(sql.len());
            if current_start < sql.len() && sql.as_bytes()[current_start] == b'\n' {
                current_start += 1;
            }
        }
    }

    push_batch_range(&mut batches, sql, current_start, sql.len());
    batches
}

fn push_batch_range(ranges: &mut Vec<SqlStatementRange>, sql: &str, start: usize, end: usize) {
    let Some((relative_start, relative_end)) = executable_sql_bounds(&sql[start..end], SqlParsingOptions::default())
    else {
        return;
    };
    let statement_start = start + relative_start;
    let statement_end = start + relative_end;
    let text = sql[statement_start..statement_end].to_string();
    if !text.is_empty() {
        ranges.push(SqlStatementRange { text, start: statement_start, end: statement_end });
    }
}

fn find_sqlserver_statement_at_cursor(sql: &str, cursor_pos: usize) -> String {
    let profile = SqlDialectProfile::sql_server();
    let cursor = utf16_offset_to_byte_index(sql, cursor_pos);
    let batches = split_sql_batch_ranges(sql, profile);

    for (idx, batch) in batches.iter().enumerate() {
        if cursor >= batch.start && cursor <= batch.end {
            if profile.keeps_sqlserver_module_batch_at_cursor && starts_with_sqlserver_module_ddl(&batch.text) {
                return batch.text.clone();
            }
            let relative_cursor = sql[..cursor].encode_utf16().count() - sql[..batch.start].encode_utf16().count();
            return find_statement_at_cursor_with_options(&batch.text, relative_cursor, SqlParsingOptions::default());
        }

        if cursor < batch.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| batches.get(prev_idx)) {
                if profile.keeps_sqlserver_module_batch_at_cursor && starts_with_sqlserver_module_ddl(&prev.text) {
                    return prev.text.clone();
                }
                let relative_cursor = prev.text.encode_utf16().count();
                return find_statement_at_cursor_with_options(
                    &prev.text,
                    relative_cursor,
                    SqlParsingOptions::default(),
                );
            }
            return batch.text.clone();
        }
    }

    batches.last().map(|batch| batch.text.clone()).unwrap_or_else(|| sql.trim().to_string())
}

fn starts_with_sqlserver_module_ddl(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 4);
    if tokens.len() >= 4
        && tokens[0].eq_ignore_ascii_case("CREATE")
        && tokens[1].eq_ignore_ascii_case("OR")
        && tokens[2].eq_ignore_ascii_case("ALTER")
    {
        return is_sqlserver_module_keyword(&tokens[3]);
    }

    tokens.len() >= 2
        && (tokens[0].eq_ignore_ascii_case("CREATE") || tokens[0].eq_ignore_ascii_case("ALTER"))
        && is_sqlserver_module_keyword(&tokens[1])
}

fn is_sqlserver_module_keyword(token: &str) -> bool {
    ["FUNCTION", "PROC", "PROCEDURE", "TRIGGER", "VIEW"].iter().any(|keyword| token.eq_ignore_ascii_case(keyword))
}

fn first_sql_tokens(sql: &str, limit: usize) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_') {
        if token.is_empty() {
            continue;
        }
        tokens.push(token.to_string());
        if tokens.len() >= limit {
            break;
        }
    }
    tokens
}

fn parse_delimiter_command(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let rest = if bytes.len() > 10
        && (bytes[..10].eq_ignore_ascii_case(b"delimiter ") || bytes[..10].eq_ignore_ascii_case(b"delimiter\t"))
    {
        Some(&line[10..])
    } else {
        None
    };
    rest.map(|r| r.trim()).filter(|r| !r.is_empty())
}

pub fn statement_summary(statement: &str) -> String {
    const MAX_LEN: usize = 120;

    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_LEN {
        return collapsed;
    }

    collapsed.chars().take(MAX_LEN).collect()
}

pub fn prepare_sql_file_statement(
    statement: &str,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
) -> SqlFileStatementAction {
    let statement = statement.trim();
    let is_mysql_compatible_target = is_mysql_compatible_import_target(db_type, driver_profile);
    if is_mysql_compatible_target && is_mysql_lock_table_statement(statement) {
        return SqlFileStatementAction::Skip;
    }

    let Some(body) = mysql_executable_comment_body(statement) else {
        if is_mysql_compatible_target && is_mysql_session_restore_statement(statement) {
            return SqlFileStatementAction::Skip;
        }
        return SqlFileStatementAction::Execute(statement.to_string());
    };

    if !is_mysql_compatible_target {
        return SqlFileStatementAction::Skip;
    }

    let body = body.trim();
    if body.is_empty() || is_mysql_key_toggle_statement(body) || is_mysql_session_restore_statement(body) {
        return SqlFileStatementAction::Skip;
    }

    SqlFileStatementAction::Execute(body.to_string())
}

pub fn optimize_sql_file_import_statements(
    statements: &[String],
    db_type: Option<DatabaseType>,
    driver_profile: Option<&str>,
) -> Vec<SqlFileImportStatement> {
    let mut optimized = Vec::new();
    let mut pending_insert: Option<PendingInsertBatch> = None;

    for statement in statements {
        let action = db_type
            .as_ref()
            .map(|db_type| prepare_sql_file_statement(statement, db_type, driver_profile))
            .unwrap_or_else(|| SqlFileStatementAction::Execute(statement.trim().to_string()));

        match action {
            SqlFileStatementAction::Skip => {
                flush_pending_insert(&mut optimized, &mut pending_insert);
                optimized.push(SqlFileImportStatement {
                    kind: SqlFileImportStatementKind::Skip,
                    sql: statement.trim().to_string(),
                    source_sqls: vec![statement.trim().to_string()],
                    source_statement_count: 1,
                });
            }
            SqlFileStatementAction::Execute(sql) => {
                let options = db_type.map(SqlParsingOptions::for_database_type).unwrap_or_default();
                if let Some(insert) = parse_mergeable_insert(&sql, options) {
                    match pending_insert.as_mut() {
                        Some(batch) if batch.can_accept(&insert) => batch.push(insert),
                        Some(_) => {
                            flush_pending_insert(&mut optimized, &mut pending_insert);
                            pending_insert = Some(PendingInsertBatch::new(insert));
                        }
                        None => {
                            pending_insert = Some(PendingInsertBatch::new(insert));
                        }
                    }
                } else {
                    flush_pending_insert(&mut optimized, &mut pending_insert);
                    optimized.push(SqlFileImportStatement {
                        kind: SqlFileImportStatementKind::Execute,
                        sql: sql.clone(),
                        source_sqls: vec![sql],
                        source_statement_count: 1,
                    });
                }
            }
        }
    }

    flush_pending_insert(&mut optimized, &mut pending_insert);
    optimized
}

fn flush_pending_insert(optimized: &mut Vec<SqlFileImportStatement>, pending_insert: &mut Option<PendingInsertBatch>) {
    if let Some(batch) = pending_insert.take() {
        optimized.push(SqlFileImportStatement {
            kind: SqlFileImportStatementKind::Execute,
            sql: batch.to_sql(),
            source_sqls: batch.source_sqls,
            source_statement_count: batch.source_statement_count,
        });
    }
}

const SQL_FILE_INSERT_BATCH_MAX_STATEMENTS: usize = 500;
const SQL_FILE_INSERT_BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
struct MergeableInsert {
    prefix: String,
    prefix_key: String,
    values: String,
    sql: String,
}

#[derive(Debug, Clone)]
struct PendingInsertBatch {
    prefix: String,
    prefix_key: String,
    values: Vec<String>,
    source_sqls: Vec<String>,
    source_statement_count: usize,
    byte_len: usize,
}

impl PendingInsertBatch {
    fn new(insert: MergeableInsert) -> Self {
        let byte_len = insert.prefix.len() + insert.values.len() + 16;
        Self {
            prefix: insert.prefix,
            prefix_key: insert.prefix_key,
            values: vec![insert.values],
            source_sqls: vec![insert.sql],
            source_statement_count: 1,
            byte_len,
        }
    }

    fn can_accept(&self, insert: &MergeableInsert) -> bool {
        self.prefix_key == insert.prefix_key
            && self.source_statement_count < SQL_FILE_INSERT_BATCH_MAX_STATEMENTS
            && self.byte_len + insert.values.len() + 3 <= SQL_FILE_INSERT_BATCH_MAX_BYTES
    }

    fn push(&mut self, insert: MergeableInsert) {
        self.byte_len += insert.values.len() + 3;
        self.values.push(insert.values);
        self.source_sqls.push(insert.sql);
        self.source_statement_count += 1;
    }

    fn to_sql(&self) -> String {
        if self.source_statement_count == 1 {
            return self.source_sqls.first().cloned().unwrap_or_default();
        }
        format!("{} VALUES\n{}", self.prefix, self.values.join(",\n"))
    }
}

fn parse_mergeable_insert(sql: &str, options: SqlParsingOptions) -> Option<MergeableInsert> {
    let executable = leading_executable_sql_with_options(sql, options).trim().trim_end_matches(';').trim();
    if !starts_with_keyword(executable, "insert") {
        return None;
    }

    let (values_start, values_end) = find_top_level_values_keyword(executable)?;
    let prefix_without_values = executable[..values_start].trim_end();
    let values = executable[values_end..].trim();
    let values = parse_insert_values_tail(values)?;

    let prefix = prefix_without_values.to_string();
    Some(MergeableInsert {
        prefix_key: normalize_insert_prefix_key(&prefix),
        prefix,
        values,
        sql: executable.to_string(),
    })
}

fn find_top_level_values_keyword(sql: &str) -> Option<(usize, usize)> {
    let mut scanner = SqlScanner::default();
    let mut depth = 0usize;

    for (idx, ch) in sql.char_indices() {
        scanner.step(sql, idx, ch);
        if scanner.is_masked() {
            continue;
        }

        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => {
                for keyword in ["values", "value"] {
                    if keyword_at(sql, idx, keyword) {
                        return Some((idx, idx + keyword.len()));
                    }
                }
            }
            _ => {}
        }
    }

    None
}

fn parse_insert_values_tail(tail: &str) -> Option<String> {
    let tail = tail.trim().trim_end_matches(';').trim();
    if tail.is_empty() {
        return None;
    }

    let mut scanner = SqlScanner::default();
    let mut depth = 0usize;
    let mut saw_tuple = false;
    let mut expecting_tuple = true;

    for (idx, ch) in tail.char_indices() {
        scanner.step(tail, idx, ch);
        if scanner.is_masked() {
            continue;
        }

        if expecting_tuple {
            if ch.is_whitespace() || (saw_tuple && ch == ',') {
                continue;
            }
            if ch != '(' {
                return None;
            }
            expecting_tuple = false;
            saw_tuple = true;
            depth = 1;
            continue;
        }

        match ch {
            '(' => depth += 1,
            ')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    expecting_tuple = true;
                }
            }
            ',' if depth == 0 => {}
            _ if depth == 0 && !ch.is_whitespace() => return None,
            _ => {}
        }
    }

    if saw_tuple && depth == 0 {
        Some(tail.to_string())
    } else {
        None
    }
}

struct SqlScanner {
    profile: SqlDialectProfile,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    dollar_quote_tag: Option<String>,
    previous: Option<char>,
}

impl SqlScanner {
    fn with_profile(profile: SqlDialectProfile) -> Self {
        Self { profile, ..Self::default() }
    }

    fn step(&mut self, sql: &str, idx: usize, ch: char) {
        if let Some(tag) = self.dollar_quote_tag.clone() {
            if sql[idx..].starts_with(&tag) {
                self.dollar_quote_tag = None;
            }
            self.previous = Some(ch);
            return;
        }

        let next = next_char_at(sql, idx + ch.len_utf8());
        if self.in_line_comment {
            if ch == '\n' {
                self.in_line_comment = false;
            }
            self.previous = Some(ch);
            return;
        }
        if self.in_block_comment {
            if self.previous == Some('*') && ch == '/' {
                self.in_block_comment = false;
            }
            self.previous = Some(ch);
            return;
        }

        if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
            if ch == '-' && next == Some('-') {
                self.in_line_comment = true;
            } else if self.profile.supports_hash_line_comments && ch == '#' {
                self.in_line_comment = true;
            } else if ch == '/' && next == Some('*') {
                self.in_block_comment = true;
            } else if let Some(tag) =
                self.profile.supports_dollar_quoted_strings.then(|| dollar_quote_tag_at_str(sql, idx)).flatten()
            {
                self.dollar_quote_tag = Some(tag);
            }
        }

        match ch {
            '\'' if !self.in_double_quote && !self.in_backtick && self.previous != Some('\\') => {
                self.in_single_quote = !self.in_single_quote;
            }
            '"' if !self.in_single_quote && !self.in_backtick && self.previous != Some('\\') => {
                self.in_double_quote = !self.in_double_quote;
            }
            '`' if !self.in_single_quote && !self.in_double_quote => {
                self.in_backtick = !self.in_backtick;
            }
            _ => {}
        }
        self.previous = Some(ch);
    }

    fn is_masked(&self) -> bool {
        self.in_single_quote
            || self.in_double_quote
            || self.in_backtick
            || self.in_line_comment
            || self.in_block_comment
            || self.dollar_quote_tag.is_some()
    }
}

impl Default for SqlScanner {
    fn default() -> Self {
        Self {
            profile: SqlDialectProfile::default(),
            in_single_quote: false,
            in_double_quote: false,
            in_backtick: false,
            in_line_comment: false,
            in_block_comment: false,
            dollar_quote_tag: None,
            previous: None,
        }
    }
}

fn keyword_at(sql: &str, idx: usize, keyword: &str) -> bool {
    let end = idx + keyword.len();
    sql.get(idx..end).is_some_and(|candidate| candidate.eq_ignore_ascii_case(keyword))
        && sql[..idx].chars().next_back().is_none_or(|ch| !is_sql_ident_char(ch))
        && sql.get(end..).and_then(|tail| tail.chars().next()).is_none_or(|ch| !is_sql_ident_char(ch))
}

fn starts_with_keyword(sql: &str, keyword: &str) -> bool {
    sql.get(..keyword.len()).is_some_and(|candidate| candidate.eq_ignore_ascii_case(keyword))
        && sql.get(keyword.len()..).and_then(|tail| tail.chars().next()).is_none_or(|ch| !is_sql_ident_char(ch))
}

fn is_sql_ident_char(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()
}

fn normalize_insert_prefix_key(prefix: &str) -> String {
    let mut scanner = SqlScanner::default();
    let mut key = String::with_capacity(prefix.len());
    let mut previous_space = false;

    for (idx, ch) in prefix.char_indices() {
        scanner.step(prefix, idx, ch);
        if scanner.in_single_quote
            || scanner.in_double_quote
            || scanner.in_backtick
            || scanner.dollar_quote_tag.is_some()
        {
            key.push(ch);
            previous_space = false;
            continue;
        }

        if ch.is_whitespace() {
            if !previous_space {
                key.push(' ');
            }
            previous_space = true;
        } else {
            key.push(ch.to_ascii_lowercase());
            previous_space = false;
        }
    }

    key.trim().to_string()
}

pub fn starts_with_executable_sql_keyword(sql: &str, keywords: &[&str]) -> bool {
    starts_with_executable_sql_keyword_with_options(sql, keywords, SqlParsingOptions::default())
}

pub fn starts_with_executable_sql_keyword_for_database(sql: &str, keywords: &[&str], db_type: DatabaseType) -> bool {
    starts_with_executable_sql_keyword_with_options(sql, keywords, SqlParsingOptions::for_database_type(db_type))
}

pub fn starts_with_duckdb_result_sql_keyword(sql: &str) -> bool {
    starts_with_executable_sql_keyword(
        sql,
        &[
            "SELECT",
            "SHOW",
            "DESCRIBE",
            "EXPLAIN",
            "WITH",
            "PRAGMA",
            "FROM",
            "SUMMARIZE",
            "SUMMARISE",
            "PIVOT",
            "UNPIVOT",
        ],
    )
}

pub fn starts_with_executable_sql_keyword_with_options(
    sql: &str,
    keywords: &[&str],
    options: SqlParsingOptions,
) -> bool {
    let Some(token) = first_executable_sql_token_with_options(sql, options) else {
        return false;
    };
    keywords.iter().any(|keyword| executable_sql_keyword_matches(token, keyword))
}

fn executable_sql_keyword_matches(token: &str, keyword: &str) -> bool {
    token.eq_ignore_ascii_case(keyword)
        || (keyword.eq_ignore_ascii_case("DESCRIBE") && token.eq_ignore_ascii_case("DESC"))
}

fn is_mysql_compatible_import_target(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    matches!(
        db_type,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Goldendb
    ) || driver_profile.map(|profile| profile.to_ascii_lowercase()).is_some_and(|profile| {
        matches!(
            profile.as_str(),
            "mariadb"
                | "tidb"
                | "oceanbase"
                | "custom_mysql"
                | "doris"
                | "starrocks"
                | "manticoresearch"
                | "selectdb"
                | "goldendb"
        )
    })
}

fn mysql_executable_comment_body(statement: &str) -> Option<&str> {
    let bytes = statement.as_bytes();
    let start = leading_mysql_executable_comment_start(statement)?;
    let body_start = if bytes.get(start + 2) == Some(&b'!') { start + 3 } else { start + 4 };
    let mut body_start = body_start;
    while body_start < bytes.len() && (bytes[body_start].is_ascii_digit() || bytes[body_start].is_ascii_whitespace()) {
        body_start += 1;
    }

    let close = find_block_comment_close(bytes, body_start)?;
    if has_executable_sql(&statement[close + 2..]) {
        return None;
    }

    Some(&statement[body_start..close])
}

fn leading_mysql_executable_comment_start(statement: &str) -> Option<usize> {
    let bytes = statement.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                return Some(i);
            }

            let close = find_block_comment_close(bytes, i + 2)?;
            i = close + 2;
            continue;
        }

        return None;
    }

    None
}

fn find_block_comment_close(bytes: &[u8], mut start: usize) -> Option<usize> {
    while start + 1 < bytes.len() {
        if bytes[start] == b'*' && bytes[start + 1] == b'/' {
            return Some(start);
        }
        start += 1;
    }
    None
}

fn is_mysql_key_toggle_statement(statement: &str) -> bool {
    let upper = statement.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    upper.starts_with("ALTER TABLE ") && (upper.ends_with(" ENABLE KEYS") || upper.ends_with(" DISABLE KEYS"))
}

fn is_mysql_lock_table_statement(statement: &str) -> bool {
    let executable = leading_executable_sql(statement);
    let upper = executable.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    upper == "UNLOCK TABLES" || (upper.starts_with("LOCK TABLES ") && upper.ends_with(" WRITE"))
}

fn is_mysql_session_restore_statement(statement: &str) -> bool {
    let executable = leading_executable_sql_with_options(statement, SqlParsingOptions::mysql_compatible());
    let upper = executable.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    if !upper.starts_with("SET ") {
        return false;
    }

    let assignment = upper.trim_start_matches("SET ").trim();
    if assignment.starts_with('@') {
        return false;
    }

    assignment.contains("= @OLD_")
        || assignment.contains("=@OLD_")
        || assignment.contains("= @SAVED_")
        || assignment.contains("=@SAVED_")
}

fn leading_executable_sql(sql: &str) -> &str {
    leading_executable_sql_with_options(sql, SqlParsingOptions::default())
}

fn leading_executable_sql_with_options(sql: &str, options: SqlParsingOptions) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if options.profile.supports_hash_line_comments && bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                break;
            }

            let Some(close) = find_block_comment_close(bytes, i + 2) else {
                return &sql[sql.len()..];
            };
            i = close + 2;
            continue;
        }

        break;
    }

    &sql[i..]
}

fn first_executable_sql_token_with_options(sql: &str, options: SqlParsingOptions) -> Option<&str> {
    let bytes = sql.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'(') {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if options.profile.supports_hash_line_comments && bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                i += if bytes[i + 2] == b'!' { 3 } else { 4 };
                while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i].is_ascii_whitespace()) {
                    i += 1;
                }
                break;
            }

            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        break;
    }

    let start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        i += 1;
    }

    (i > start).then_some(&sql[start..i])
}

fn starts_with_oracle_plsql_block(sql: &str) -> bool {
    OraclePlSqlBlock::parse(sql).starts_block()
}

fn oracle_plsql_block_is_complete(sql: &str) -> bool {
    OraclePlSqlBlock::parse(sql).is_complete()
}

struct OraclePlSqlBlock {
    tokens: Vec<OraclePlSqlToken>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OraclePlSqlToken {
    Word(String),
    Semicolon,
}

impl OraclePlSqlBlock {
    fn parse(sql: &str) -> Self {
        Self { tokens: oracle_plsql_tokens(sql) }
    }

    fn starts_block(&self) -> bool {
        match self.tokens.as_slice() {
            [first, ..] if first.is_word("DECLARE") => true,
            [first, second, ..] if first.is_word("BEGIN") && !Self::is_transaction_begin_tail(second) => true,
            [first, rest @ ..] if first.is_word("CREATE") => Self::starts_create_plsql_object(rest),
            _ => false,
        }
    }

    fn is_complete(&self) -> bool {
        if !self.starts_block() {
            return false;
        }

        let mut depth = 0usize;
        let mut saw_begin = false;
        let mut complete = false;
        let mut pending_end: Option<bool> = None;

        for token in &self.tokens {
            if token.is_semicolon() {
                if let Some(is_block_end) = pending_end.take() {
                    if is_block_end && depth > 0 {
                        depth -= 1;
                        complete = depth == 0;
                    }
                }
                continue;
            }

            if let Some(is_block_end) = pending_end.as_mut() {
                if token.is_any_word(&["IF", "LOOP", "CASE"]) {
                    *is_block_end = false;
                }
                continue;
            }

            if token.is_word("BEGIN") {
                depth += 1;
                saw_begin = true;
                complete = false;
            } else if token.is_word("END") {
                pending_end = Some(true);
            }
        }

        saw_begin && complete
    }

    fn starts_create_plsql_object(tokens: &[OraclePlSqlToken]) -> bool {
        let tokens = Self::skip_or_replace(tokens);
        tokens.first().is_some_and(|token| token.is_any_word(&["FUNCTION", "PROCEDURE", "TRIGGER", "PACKAGE", "TYPE"]))
    }

    fn skip_or_replace(tokens: &[OraclePlSqlToken]) -> &[OraclePlSqlToken] {
        match tokens {
            [or, replace, rest @ ..] if or.is_word("OR") && replace.is_word("REPLACE") => rest,
            _ => tokens,
        }
    }

    fn is_transaction_begin_tail(token: &OraclePlSqlToken) -> bool {
        token.is_semicolon() || token.is_any_word(&["TRANSACTION", "WORK"])
    }
}

impl OraclePlSqlToken {
    fn word(value: String) -> Self {
        Self::Word(value)
    }

    fn from_sqlparser_token(token: Token) -> Option<Self> {
        match token {
            Token::Word(word) if word.quote_style.is_none() => Some(Self::Word(word.value.to_ascii_uppercase())),
            Token::SemiColon => Some(Self::Semicolon),
            _ => None,
        }
    }

    fn is_word(&self, expected: &str) -> bool {
        matches!(self, Self::Word(value) if value == expected)
    }

    fn is_any_word(&self, expected: &[&str]) -> bool {
        expected.iter().any(|word| self.is_word(word))
    }

    fn is_semicolon(&self) -> bool {
        matches!(self, Self::Semicolon)
    }
}

fn oracle_plsql_tokens(sql: &str) -> Vec<OraclePlSqlToken> {
    let dialect = OracleDialect {};
    if let Ok(tokens) = Tokenizer::new(&dialect, sql).tokenize() {
        return tokens.into_iter().filter_map(OraclePlSqlToken::from_sqlparser_token).collect();
    }

    oracle_plsql_tokens_fallback(sql)
}

fn oracle_plsql_tokens_fallback(sql: &str) -> Vec<OraclePlSqlToken> {
    let mut tokens = Vec::new();
    let mut iter = sql.char_indices().peekable();

    while let Some((_, ch)) = iter.next() {
        if ch.is_whitespace() {
            continue;
        }

        if ch == '-' && iter.peek().is_some_and(|(_, next)| *next == '-') {
            iter.next();
            for (_, comment_ch) in iter.by_ref() {
                if comment_ch == '\n' {
                    break;
                }
            }
            continue;
        }

        if ch == '/' && iter.peek().is_some_and(|(_, next)| *next == '*') {
            iter.next();
            let mut previous = '\0';
            for (_, comment_ch) in iter.by_ref() {
                if previous == '*' && comment_ch == '/' {
                    break;
                }
                previous = comment_ch;
            }
            continue;
        }

        if ch == '\'' {
            while let Some((_, quote_ch)) = iter.next() {
                if quote_ch == '\'' {
                    if iter.peek().is_some_and(|(_, next)| *next == '\'') {
                        iter.next();
                    } else {
                        break;
                    }
                }
            }
            continue;
        }

        if ch == '"' {
            for (_, ident_ch) in iter.by_ref() {
                if ident_ch == '"' {
                    break;
                }
            }
            continue;
        }

        if ch == ';' {
            tokens.push(OraclePlSqlToken::Semicolon);
            continue;
        }

        if ch.is_ascii_alphabetic() || ch == '_' {
            let mut token = String::new();
            token.push(ch.to_ascii_uppercase());
            while let Some((_, next)) = iter.peek().copied() {
                if next.is_ascii_alphanumeric() || next == '_' || next == '$' || next == '#' {
                    token.push(next.to_ascii_uppercase());
                    iter.next();
                } else {
                    break;
                }
            }
            tokens.push(OraclePlSqlToken::word(token));
        }
    }

    tokens
}

fn starts_with_chars(chars: &[char], start: usize, needle: &[char]) -> bool {
    start + needle.len() <= chars.len() && chars[start..start + needle.len()] == *needle
}

fn dollar_quote_tag_at(chars: &[char], start: usize) -> Option<String> {
    if chars.get(start) != Some(&'$') {
        return None;
    }

    match chars.get(start + 1) {
        Some('$') => return Some("$$".to_string()),
        Some(ch) if ch.is_ascii_alphabetic() || *ch == '_' => {}
        _ => return None,
    }

    let mut end = start + 2;
    while let Some(ch) = chars.get(end) {
        if *ch == '$' {
            return Some(chars[start..=end].iter().collect());
        }
        if !ch.is_ascii_alphanumeric() && *ch != '_' {
            return None;
        }
        end += 1;
    }

    None
}

pub fn has_executable_sql(statement: &str) -> bool {
    has_executable_sql_with_options(statement, SqlParsingOptions::default())
}

pub fn has_executable_sql_for_database(statement: &str, db_type: DatabaseType) -> bool {
    has_executable_sql_with_options(statement, SqlParsingOptions::for_database_type(db_type))
}

fn executable_sql_bounds(statement: &str, options: SqlParsingOptions) -> Option<(usize, usize)> {
    let trimmed_end = statement.trim_end().len();
    let trimmed = &statement[..trimmed_end];
    let executable = leading_executable_sql_with_options(trimmed, options);
    if executable.is_empty() {
        return None;
    }
    let start = trimmed.len() - executable.len();
    Some((start, trimmed_end))
}

fn has_executable_sql_with_options(statement: &str, options: SqlParsingOptions) -> bool {
    let chars = statement.chars().collect::<Vec<_>>();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut previous = None;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }

        if in_block_comment {
            if previous == Some('*') && ch == '/' {
                in_block_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }

        if ch == '-' && next == Some('-') {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if options.profile.supports_hash_line_comments && ch == '#' {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if ch == '/' && next == Some('*') {
            if is_mysql_executable_comment_start(&chars, i) {
                return true;
            }
            in_block_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if !ch.is_whitespace() {
            return true;
        }

        previous = Some(ch);
        i += 1;
    }

    false
}

fn is_mysql_executable_comment_start(chars: &[char], start: usize) -> bool {
    chars.get(start) == Some(&'/')
        && chars.get(start + 1) == Some(&'*')
        && (chars.get(start + 2) == Some(&'!')
            || (chars.get(start + 2) == Some(&'M') && chars.get(start + 3) == Some(&'!')))
}

#[cfg(test)]
fn split_sql_script(sql: &str) -> Result<Vec<String>, String> {
    Ok(split_sql_statements(sql))
}

#[cfg(test)]
mod tests {
    use crate::models::connection::DatabaseType;

    use super::{
        contains_or_fuzzy_match, decode_sql_file_bytes, find_statement_at_cursor_for_database, fuzzy_filter_enabled,
        fuzzy_like_pattern_with_escape, fuzzy_subsequence_match, optimize_sql_file_import_statements,
        prepare_sql_file_statement, split_sql_script, split_sql_statement_ranges_with_options,
        split_sql_statements_for_database, starts_with_executable_sql_keyword,
        starts_with_executable_sql_keyword_for_database, SqlDialectProfile, SqlFileStatementAction, SqlParsingOptions,
        SqlStatementSplitter,
    };

    #[test]
    fn fuzzy_subsequence_match_matches_ordered_characters() {
        assert!(fuzzy_subsequence_match("system_user", "sysu"));
        assert!(contains_or_fuzzy_match("user_order", "uo"));
        assert!(!contains_or_fuzzy_match("alpha", "uo"));
    }

    #[test]
    fn contains_or_fuzzy_match_skips_fuzzy_for_single_character_filters() {
        assert!(fuzzy_filter_enabled("uo"));
        assert!(!fuzzy_filter_enabled("u"));
        assert!(contains_or_fuzzy_match("user_order", "u"));
        assert!(!contains_or_fuzzy_match("orders", "u"));
    }

    #[test]
    fn fuzzy_like_pattern_with_escape_keeps_wildcards_literal() {
        let pattern = fuzzy_like_pattern_with_escape("user_%", |value| value.replace('%', "\\%").replace('_', "\\_"));

        assert_eq!(pattern, "%u%s%e%r%\\_%\\%%");
    }

    #[test]
    fn splits_semicolon_delimited_statements() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int); INSERT INTO a VALUES (1);").unwrap(),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn decodes_utf8_bom_sql_file_bytes_without_bom_statement_prefix() {
        let sql = decode_sql_file_bytes(b"\xEF\xBB\xBFCREATE TABLE t(id int);").unwrap();

        assert_eq!(sql, "CREATE TABLE t(id int);");
    }

    #[test]
    fn decodes_gbk_sql_file_bytes_before_execution() {
        let bytes = b"INSERT INTO t VALUES ('\xD6\xD0\xCE\xC4');";
        let sql = decode_sql_file_bytes(bytes).unwrap();

        assert_eq!(sql, "INSERT INTO t VALUES ('中文');");
    }

    #[test]
    fn decodes_utf16le_bom_sql_file_bytes() {
        let bytes = [
            0xFF, 0xFE, b'S', 0x00, b'E', 0x00, b'L', 0x00, b'E', 0x00, b'C', 0x00, b'T', 0x00, b' ', 0x00, b'1', 0x00,
            b';', 0x00,
        ];
        let sql = decode_sql_file_bytes(&bytes).unwrap();

        assert_eq!(sql, "SELECT 1;");
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

    #[test]
    fn line_comment_openers_can_span_chunks() {
        let mut splitter = SqlStatementSplitter::default();

        assert_eq!(splitter.push_chunk("SELECT 1; -"), vec!["SELECT 1"]);
        assert_eq!(splitter.push_chunk("- comment ; ignored\nSELECT 2;"), vec!["-- comment ; ignored\nSELECT 2"]);
        assert_eq!(splitter.finish(), Vec::<String>::new());
    }

    #[test]
    fn block_comment_openers_can_span_chunks() {
        let mut splitter = SqlStatementSplitter::default();

        assert_eq!(splitter.push_chunk("SELECT 1; /"), vec!["SELECT 1"]);
        assert_eq!(splitter.push_chunk("* comment ; ignored */\nSELECT 2;"), vec!["/* comment ; ignored */\nSELECT 2"]);
        assert_eq!(splitter.finish(), Vec::<String>::new());
    }

    #[test]
    fn skips_comment_only_tail_after_statement() {
        assert_eq!(
            split_sql_script("CREATE TABLE a(id int); -- done\n/* no more sql */").unwrap(),
            vec!["CREATE TABLE a(id int)"]
        );
    }

    #[test]
    fn skips_comment_only_statement_with_semicolon() {
        assert_eq!(
            split_sql_script("-- insert sqluser.tb_a values (6,'006','测试6','无');").unwrap(),
            Vec::<String>::new()
        );
        assert!(!super::has_executable_sql("-- insert sqluser.tb_a values (6,'006','测试6','无');"));
    }

    #[test]
    fn keeps_postgres_dollar_quoted_function_body_together() {
        let sql = "\
            CREATE FUNCTION bump_counter()\n\
            RETURNS trigger AS $$\n\
            BEGIN\n\
              PERFORM 1;\n\
              RETURN NEW;\n\
            END;\n\
            $$ LANGUAGE plpgsql;\n\
            SELECT 1;";

        assert_eq!(
            split_sql_script(sql).unwrap(),
            vec![
                "CREATE FUNCTION bump_counter()\nRETURNS trigger AS $$\nBEGIN\nPERFORM 1;\nRETURN NEW;\nEND;\n$$ LANGUAGE plpgsql",
                "SELECT 1",
            ]
        );
    }

    #[test]
    fn keeps_mysql_executable_comments_as_statements() {
        assert_eq!(
            split_sql_script("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\nSELECT 1;",).unwrap(),
            vec!["/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */", "SELECT 1",]
        );
    }

    #[test]
    fn detects_result_set_keyword_after_comments() {
        assert!(starts_with_executable_sql_keyword("-- comment\nselect * from users;", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword(
            "/* comment */\nWITH rows AS (SELECT 1) SELECT * FROM rows;",
            &["WITH"]
        ));
        assert!(!starts_with_executable_sql_keyword("-- comment only\n", &["SELECT"]));
    }

    #[test]
    fn detects_mysql_executable_comment_keyword() {
        assert!(starts_with_executable_sql_keyword("/*!40101 SELECT 1 */", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword("/*M! SELECT 1 */", &["SELECT"]));
    }

    #[test]
    fn describe_keyword_detection_accepts_desc_shorthand() {
        assert!(starts_with_executable_sql_keyword("DESC users", &["DESCRIBE"]));
        assert!(starts_with_executable_sql_keyword("-- comment\nDESC users", &["DESCRIBE"]));
    }

    #[test]
    fn detects_keyword_after_parentheses() {
        assert!(starts_with_executable_sql_keyword("(SELECT 1)", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword("  (  SELECT 1  )", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword("((SELECT 1))", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword("(SELECT * FROM users)", &["SELECT"]));
        assert!(starts_with_executable_sql_keyword("(INSERT INTO users VALUES (1))", &["INSERT"]));
        assert!(starts_with_executable_sql_keyword("/* comment */(UPDATE users SET name = 'test')", &["UPDATE"]));
    }

    #[test]
    fn mysql_hash_comments_are_ignored_for_keyword_detection() {
        assert!(starts_with_executable_sql_keyword_for_database(
            "# comment only for mysql\nSELECT 1",
            &["SELECT"],
            DatabaseType::Mysql
        ));
        assert!(!starts_with_executable_sql_keyword("# comment only for mysql\nSELECT 1", &["SELECT"]));
    }

    #[test]
    fn prepares_mysql_executable_comments_for_mysql_compatible_imports() {
        assert_eq!(
            prepare_sql_file_statement("/*!40101 SET NAMES utf8mb4 */", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Execute("SET NAMES utf8mb4".to_string())
        );
    }

    #[test]
    fn skips_mysql_key_toggle_comments_for_mysql_compatible_imports() {
        assert_eq!(
            prepare_sql_file_statement(" /*!40000 ALTER TABLE `dd_admin` ENABLE KEYS */", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement("/*!40000 ALTER TABLE `dd_admin` DISABLE KEYS */", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
    }

    #[test]
    fn skips_mysql_lock_table_statements_for_mysql_compatible_imports() {
        assert_eq!(
            prepare_sql_file_statement("LOCK TABLES `dd_geo_json` WRITE", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement("UNLOCK TABLES", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement(
                "-- Dumping data for table `dd_geo_json`\nLOCK TABLES `dd_geo_json` WRITE",
                &DatabaseType::Mysql,
                None
            ),
            SqlFileStatementAction::Skip
        );
    }

    #[test]
    fn skips_mysql_session_restore_statements_for_mysql_compatible_imports() {
        assert_eq!(
            prepare_sql_file_statement(
                "/*!40101 SET character_set_client = @saved_cs_client */",
                &DatabaseType::Mysql,
                None
            ),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement("/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement("SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS", &DatabaseType::Mysql, None),
            SqlFileStatementAction::Skip
        );
        assert_eq!(
            prepare_sql_file_statement(
                "/*!40101 SET @saved_cs_client = @@character_set_client */",
                &DatabaseType::Mysql,
                None
            ),
            SqlFileStatementAction::Execute("SET @saved_cs_client = @@character_set_client".to_string())
        );
    }

    #[test]
    fn skips_mysql_executable_comments_for_non_mysql_imports() {
        assert_eq!(
            prepare_sql_file_statement(
                "/*!40101 SET character_set_client = @saved_cs_client */",
                &DatabaseType::Postgres,
                None
            ),
            SqlFileStatementAction::Skip
        );
    }

    #[test]
    fn optimizes_adjacent_single_row_inserts_into_multi_row_insert() {
        let statements = vec![
            "INSERT INTO users (id, name) VALUES (1, 'Ada')".to_string(),
            "insert into users (id, name) values (2, 'Linus')".to_string(),
            "SELECT 1".to_string(),
        ];

        let optimized = optimize_sql_file_import_statements(&statements, Some(DatabaseType::Mysql), None);

        assert_eq!(optimized.len(), 2);
        assert_eq!(optimized[0].source_statement_count, 2);
        assert_eq!(optimized[0].sql, "INSERT INTO users (id, name) VALUES\n(1, 'Ada'),\n(2, 'Linus')");
        assert_eq!(optimized[1].sql, "SELECT 1");
    }

    #[test]
    fn keeps_insert_batches_separate_for_different_targets_or_suffixes() {
        let statements = vec![
            "INSERT INTO users (id) VALUES (1)".to_string(),
            "INSERT INTO teams (id) VALUES (1)".to_string(),
            "INSERT INTO users (id) VALUES (2) RETURNING id".to_string(),
        ];

        let optimized = optimize_sql_file_import_statements(&statements, Some(DatabaseType::Postgres), None);

        assert_eq!(optimized.len(), 3);
        assert!(optimized.iter().all(|statement| statement.source_statement_count == 1));
    }

    #[test]
    fn optimized_sql_file_import_keeps_skipped_mysql_dump_statements() {
        let statements = vec![
            "LOCK TABLES `users` WRITE".to_string(),
            "INSERT INTO `users` VALUES (1)".to_string(),
            "INSERT INTO `users` VALUES (2)".to_string(),
            "UNLOCK TABLES".to_string(),
        ];

        let optimized = optimize_sql_file_import_statements(&statements, Some(DatabaseType::Mysql), None);

        assert_eq!(optimized.len(), 3);
        assert_eq!(optimized[0].kind, super::SqlFileImportStatementKind::Skip);
        assert_eq!(optimized[1].source_statement_count, 2);
        assert_eq!(optimized[2].kind, super::SqlFileImportStatementKind::Skip);
    }

    #[test]
    fn split_batches_by_go() {
        assert_eq!(super::split_sql_batches("SELECT 1\nGO\nSELECT 2"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_batches_go_case_insensitive() {
        assert_eq!(
            super::split_sql_batches("SELECT 1\ngo\nSELECT 2\nGo\nSELECT 3"),
            vec!["SELECT 1", "SELECT 2", "SELECT 3"]
        );
    }

    #[test]
    fn split_batches_go_with_surrounding_whitespace() {
        assert_eq!(super::split_sql_batches("SELECT 1\n  GO  \nSELECT 2"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_batches_no_go_returns_whole() {
        assert_eq!(
            super::split_sql_batches("DECLARE @x INT = 1;\nSELECT @x;"),
            vec!["DECLARE @x INT = 1;\nSELECT @x;"]
        );
    }

    #[test]
    fn split_batches_skips_empty_batches() {
        assert_eq!(super::split_sql_batches("SELECT 1\nGO\n\nGO\nSELECT 2"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn split_batches_trailing_go() {
        assert_eq!(super::split_sql_batches("SELECT 1\nGO"), vec!["SELECT 1"]);
    }

    // --- DELIMITER support ---

    #[test]
    fn delimiter_basic_procedure() {
        let sql = "\
DELIMITER //
CREATE PROCEDURE foo()
BEGIN
  SELECT 1;
  SELECT 2;
END //
DELIMITER ;
SELECT 3;";
        assert_eq!(
            super::split_sql_statements(sql),
            vec!["CREATE PROCEDURE foo()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", "SELECT 3",]
        );
    }

    #[test]
    fn delimiter_no_trailing_newline() {
        let sql = "DELIMITER //\nSELECT 1//";
        assert_eq!(super::split_sql_statements(sql), vec!["SELECT 1"]);
    }

    #[test]
    fn delimiter_no_space_before_delim() {
        let sql = "DELIMITER //\nCREATE PROCEDURE foo() BEGIN SELECT 1; END//\nDELIMITER ;";
        assert_eq!(super::split_sql_statements(sql), vec!["CREATE PROCEDURE foo() BEGIN SELECT 1; END"]);
    }

    #[test]
    fn delimiter_case_insensitive() {
        let sql = "delimiter //\nSELECT 1//\ndelimiter ;\nSELECT 2;";
        assert_eq!(super::split_sql_statements(sql), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn delimiter_double_dollar() {
        let sql = "DELIMITER $$\nCREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END $$\nDELIMITER ;";
        assert_eq!(super::split_sql_statements(sql), vec!["CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END"]);
    }

    #[test]
    fn delimiter_semicolons_preserved_inside_body() {
        let sql = "\
DELIMITER //
CREATE TRIGGER t BEFORE INSERT ON tbl FOR EACH ROW
BEGIN
  SET NEW.a = 1;
  SET NEW.b = 2;
END //
DELIMITER ;";
        let stmts = super::split_sql_statements(sql);
        assert_eq!(stmts.len(), 1);
        assert!(stmts[0].contains("SET NEW.a = 1;\n  SET NEW.b = 2;"));
    }

    #[test]
    fn delimiter_multiple_statements() {
        let sql = "\
DELIMITER //
CREATE PROCEDURE p1() BEGIN SELECT 1; END //
CREATE PROCEDURE p2() BEGIN SELECT 2; END //
DELIMITER ;";
        assert_eq!(
            super::split_sql_statements(sql),
            vec!["CREATE PROCEDURE p1() BEGIN SELECT 1; END", "CREATE PROCEDURE p2() BEGIN SELECT 2; END",]
        );
    }

    #[test]
    fn delimiter_after_comment_with_chinese() {
        let sql = "\
-- 判断字段是否存在
DELIMITER $$
DROP FUNCTION IF EXISTS isFieldExisting $$
CREATE FUNCTION isFieldExisting(s VARCHAR(100), t VARCHAR(100), f VARCHAR(100))
    RETURNS INT
    RETURN (SELECT COUNT(COLUMN_NAME)
            FROM INFORMATION_SCHEMA.columns
            WHERE TABLE_SCHEMA = s
              AND TABLE_NAME = t
              AND COLUMN_NAME = f)$$
DELIMITER ;";
        let stmts = super::split_sql_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("DROP FUNCTION"));
        assert!(stmts[1].starts_with("CREATE FUNCTION"));
    }

    #[test]
    fn delimiter_after_ascii_comment() {
        let sql = "\
-- check field existence
DELIMITER $$
SELECT 1 $$
DELIMITER ;";
        assert_eq!(super::split_sql_statements(sql), vec!["SELECT 1"]);
    }

    #[test]
    fn delimiter_after_statement() {
        let sql = "\
SELECT 1;
DELIMITER $$
SELECT 2 $$
DELIMITER ;";
        assert_eq!(super::split_sql_statements(sql), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn sql_dialect_profiles_map_database_types_to_parser_capabilities() {
        let default = SqlDialectProfile::for_database_type(DatabaseType::Postgres);
        assert_eq!(default, SqlDialectProfile::default());
        assert!(default.supports_custom_delimiter_commands);
        assert!(default.supports_dollar_quoted_strings);
        assert!(!default.supports_hash_line_comments);
        assert!(!default.supports_oracle_plsql_blocks);
        assert!(!default.supports_slash_line_block_delimiter);
        assert!(!default.supports_go_batch_separator);
        assert!(!default.keeps_sqlserver_module_batch_at_cursor);

        let mysql = SqlDialectProfile::for_database_type(DatabaseType::Mysql);
        assert_eq!(mysql, SqlDialectProfile::mysql_compatible());
        assert!(mysql.supports_hash_line_comments);
        assert!(SqlDialectProfile::for_database_type(DatabaseType::Doris).supports_hash_line_comments);
        assert!(SqlDialectProfile::for_database_type(DatabaseType::StarRocks).supports_hash_line_comments);
        assert!(SqlDialectProfile::for_database_type(DatabaseType::ManticoreSearch).supports_hash_line_comments);
        assert!(SqlDialectProfile::for_database_type(DatabaseType::Goldendb).supports_hash_line_comments);

        for db_type in [
            DatabaseType::Oracle,
            DatabaseType::Dameng,
            DatabaseType::Gaussdb,
            DatabaseType::Yashandb,
            DatabaseType::Oscar,
            DatabaseType::OceanbaseOracle,
        ] {
            let profile = SqlDialectProfile::for_database_type(db_type);
            assert_eq!(profile, SqlDialectProfile::oracle_like());
            assert!(profile.supports_oracle_plsql_blocks);
            assert!(profile.supports_slash_line_block_delimiter);
        }

        let sql_server = SqlDialectProfile::for_database_type(DatabaseType::SqlServer);
        assert_eq!(sql_server, SqlDialectProfile::sql_server());
        assert!(sql_server.supports_go_batch_separator);
        assert!(sql_server.keeps_sqlserver_module_batch_at_cursor);
    }

    #[test]
    fn oracle_like_split_keeps_anonymous_plsql_block_together() {
        let sql = "\
DECLARE
V_EXISTS_FLAG NUMBER;
BEGIN
SELECT COUNT(1)
INTO V_EXISTS_FLAG
FROM SCHEMA_NAME.TABLE_NAME
WHERE UNIQUE_KEY_COLUMN = 'BUSINESS_UNIQUE_VALUE';
IF V_EXISTS_FLAG = 0 THEN
INSERT INTO SCHEMA_NAME.TABLE_NAME (UNIQUE_KEY_COLUMN, COLUMN_NAME_1)
VALUES ('BUSINESS_UNIQUE_VALUE', 'BUSINESS_VALUE_1');
END IF;
END;";

        assert_eq!(split_sql_statements_for_database(sql, DatabaseType::Oracle), vec![sql.to_string()]);
        assert_eq!(split_sql_statements_for_database(sql, DatabaseType::Dameng), vec![sql.to_string()]);
        assert_eq!(split_sql_statements_for_database(sql, DatabaseType::Gaussdb), vec![sql.to_string()]);
    }

    #[test]
    fn oracle_like_split_treats_slash_line_as_plsql_delimiter() {
        let sql = "\
BEGIN
  NULL;
END;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec!["BEGIN\n  NULL;\nEND;", "SELECT 1"]
        );
    }

    #[test]
    fn oracle_like_current_statement_keeps_plsql_block_together() {
        let sql = "\
DECLARE
  v_exists_flag NUMBER;
BEGIN
  IF v_exists_flag = 0 THEN
    NULL;
  END IF;
END;
/
SELECT 1;";
        let cursor = sql[..sql.find("NULL").unwrap()].encode_utf16().count();
        let next_cursor = sql[..sql.find("SELECT 1").unwrap()].encode_utf16().count();

        assert_eq!(
            find_statement_at_cursor_for_database(sql, cursor, DatabaseType::Oracle),
            "DECLARE\n  v_exists_flag NUMBER;\nBEGIN\n  IF v_exists_flag = 0 THEN\n    NULL;\n  END IF;\nEND;"
        );
        assert_eq!(find_statement_at_cursor_for_database(sql, next_cursor, DatabaseType::Oracle), "SELECT 1");
    }

    #[test]
    fn oracle_like_current_statement_keeps_nested_dml_plsql_block_together() {
        let sql = "\
DECLARE
  v_order_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_order_count
  FROM \"DBX_TEST\".\"ORDERS_10K\";

  IF v_order_count = 0 THEN
    INSERT INTO \"DBX_TEST\".\"STORES\"
      (\"ID\", \"STORE_CODE\", \"STORE_NAME\", \"CITY\", \"OPENED_AT\")
    SELECT 10001, 'TEST_STORE_001', '测试门店', '上海', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM \"DBX_TEST\".\"STORES\" WHERE \"ID\" = 10001
    );

    INSERT INTO \"DBX_TEST\".\"PRODUCTS\"
      (\"ID\", \"SKU\", \"PRODUCT_NAME\", \"CATEGORY\", \"PRICE\")
    SELECT 10001, 'TEST_SKU_001', '测试商品', '测试分类', 99.90
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM \"DBX_TEST\".\"PRODUCTS\" WHERE \"ID\" = 10001
    );

    INSERT INTO \"DBX_TEST\".\"ORDERS_10K\"
      (\"ID\", \"ORDER_NO\", \"STORE_ID\", \"PRODUCT_ID\", \"CUSTOMER_NAME\", \"QUANTITY\", \"AMOUNT\", \"ORDER_STATUS\", \"CREATED_AT\")
    SELECT 10001, 'TEST_ORDER_001', 10001, 10001, '测试客户', 2, 199.80, 'PAID', SYSDATE
    FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM \"DBX_TEST\".\"ORDERS_10K\" WHERE \"ORDER_NO\" = 'TEST_ORDER_001'
    );

    COMMIT;
  END IF;
END;
/
SELECT 1;";
        let expected = sql.split("\n/").next().unwrap();
        let cursor = sql[..sql.find("ORDERS_10K").unwrap()].encode_utf16().count();
        let next_cursor = sql[..sql.find("SELECT 1;").unwrap()].encode_utf16().count();

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec![expected.to_string(), "SELECT 1".to_string()]
        );
        assert_eq!(find_statement_at_cursor_for_database(sql, cursor, DatabaseType::Oracle), expected);
        assert_eq!(find_statement_at_cursor_for_database(sql, next_cursor, DatabaseType::Oracle), "SELECT 1");
    }

    #[test]
    fn oracle_like_split_keeps_transaction_begin_as_statement() {
        assert_eq!(
            split_sql_statements_for_database("BEGIN; INSERT INTO t VALUES (1); COMMIT;", DatabaseType::Gaussdb),
            vec!["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]
        );
    }

    #[test]
    fn oracle_like_split_keeps_create_function_together() {
        let sql = "\
CREATE OR REPLACE FUNCTION number_tochar(nums VARCHAR(20))
RETURN VARCHAR(20)
AS
    res VARCHAR(20);
BEGIN
    RETURN '一';
END;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec!["CREATE OR REPLACE FUNCTION number_tochar(nums VARCHAR(20))\nRETURN VARCHAR(20)\nAS\n    res VARCHAR(20);\nBEGIN\n    RETURN '一';\nEND;", "SELECT 1"]
        );
        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Dameng),
            vec!["CREATE OR REPLACE FUNCTION number_tochar(nums VARCHAR(20))\nRETURN VARCHAR(20)\nAS\n    res VARCHAR(20);\nBEGIN\n    RETURN '一';\nEND;", "SELECT 1"]
        );
    }

    #[test]
    fn oracle_like_split_keeps_create_procedure_together() {
        let sql = "\
CREATE OR REPLACE PROCEDURE update_salary(p_id NUMBER, p_amount NUMBER)
AS
BEGIN
    UPDATE employees SET salary = salary + p_amount WHERE id = p_id;
    COMMIT;
END;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec![
                "CREATE OR REPLACE PROCEDURE update_salary(p_id NUMBER, p_amount NUMBER)\nAS\nBEGIN\n    UPDATE employees SET salary = salary + p_amount WHERE id = p_id;\n    COMMIT;\nEND;",
                "SELECT 1"
            ]
        );
    }

    #[test]
    fn oracle_like_split_keeps_create_trigger_together() {
        let sql = "\
CREATE TRIGGER trg_audit
BEFORE INSERT ON employees
FOR EACH ROW
BEGIN
    INSERT INTO audit_log VALUES (:NEW.id, 'INSERT');
END;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec![
                "CREATE TRIGGER trg_audit\nBEFORE INSERT ON employees\nFOR EACH ROW\nBEGIN\n    INSERT INTO audit_log VALUES (:NEW.id, 'INSERT');\nEND;",
                "SELECT 1"
            ]
        );
    }

    #[test]
    fn yashandb_split_keeps_create_trigger_with_slash_delimiter_together() {
        let sql = "\
CREATE TRIGGER \"TB_SC_UPDATE_TIME_TRI\"
BEFORE UPDATE ON \"TB_SC\"
FOR EACH ROW
 BEGIN
   IF NOT UPDATING('UPDATE_TIME')  THEN
   \t\t:NEW.\"UPDATE_TIME\" := CURRENT_TIMESTAMP;
   END IF;
END;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Yashandb),
            vec![
                "CREATE TRIGGER \"TB_SC_UPDATE_TIME_TRI\"\nBEFORE UPDATE ON \"TB_SC\"\nFOR EACH ROW\n BEGIN\n   IF NOT UPDATING('UPDATE_TIME')  THEN\n   \t\t:NEW.\"UPDATE_TIME\" := CURRENT_TIMESTAMP;\n   END IF;\nEND;",
                "SELECT 1"
            ]
        );
    }

    #[test]
    fn oracle_like_split_keeps_create_package_together() {
        let sql = "\
CREATE OR REPLACE PACKAGE pkg_utils AS
    FUNCTION get_version RETURN VARCHAR2;
    PROCEDURE log_message(msg VARCHAR2);
END pkg_utils;
/
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec![
                "CREATE OR REPLACE PACKAGE pkg_utils AS\n    FUNCTION get_version RETURN VARCHAR2;\n    PROCEDURE log_message(msg VARCHAR2);\nEND pkg_utils;",
                "SELECT 1"
            ]
        );
    }

    #[test]
    fn oracle_like_split_ignores_end_tokens_inside_q_quoted_strings() {
        let sql = "\
BEGIN
    v_text := q'[not really END;]';
    NULL;
END;
SELECT 1;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec!["BEGIN\n    v_text := q'[not really END;]';\n    NULL;\nEND;", "SELECT 1"]
        );
    }

    #[test]
    fn oracle_plsql_tokenizer_falls_back_when_sqlparser_rejects_partial_literals() {
        let sql = "\
BEGIN
    NULL;
    v_text := 'partial";
        let tokens = super::oracle_plsql_tokens(sql);

        assert!(tokens.iter().any(|token| token.is_word("BEGIN")));
        assert!(tokens.iter().any(super::OraclePlSqlToken::is_semicolon));
    }

    #[test]
    fn oracle_like_split_does_not_affect_create_table() {
        let sql = "\
CREATE TABLE users (id NUMBER PRIMARY KEY, name VARCHAR2(100));
CREATE OR REPLACE VIEW v_users AS SELECT id, name FROM users;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Oracle),
            vec![
                "CREATE TABLE users (id NUMBER PRIMARY KEY, name VARCHAR2(100))",
                "CREATE OR REPLACE VIEW v_users AS SELECT id, name FROM users"
            ]
        );
    }

    #[test]
    fn finds_statement_at_cursor() {
        let sql = "SELECT 1; SELECT 2";

        assert_eq!(super::find_statement_at_cursor(sql, 3), "SELECT 1");
        assert_eq!(super::find_statement_at_cursor(sql, 12), "SELECT 2");
        assert_eq!(super::find_statement_at_cursor(sql, 18), "SELECT 2");
    }

    #[test]
    fn finds_statement_at_cursor_after_unicode_comment() {
        let sql = "-- 判断字段是否存在\nSELECT 1; SELECT 2";
        let cursor_byte = sql.find("SELECT 2").unwrap();
        let cursor = sql[..cursor_byte].encode_utf16().count();

        assert_eq!(super::find_statement_at_cursor(sql, cursor), "SELECT 2");
    }

    #[test]
    fn finds_statement_at_cursor_after_semicolon_with_blank_line_stays_on_previous_statement() {
        let sql = "SELECT 1;\n\nSELECT 2;";
        let cursor = sql[..sql.find(';').unwrap() + 1].encode_utf16().count();
        assert_eq!(super::find_statement_at_cursor(sql, cursor), "SELECT 1");
    }

    #[test]
    fn finds_statement_at_cursor_after_semicolon_same_line_moves_to_next_statement() {
        let sql = "SELECT 1; SELECT 2;";
        let cursor = sql[..sql.find("SELECT 2").unwrap()].encode_utf16().count();

        assert_eq!(super::find_statement_at_cursor(sql, cursor), "SELECT 2");
    }

    #[test]
    fn finds_statement_at_cursor_after_double_blank_line_without_semicolon() {
        let sql = "SELECT * FROM old_table\n\n\nCREATE VIEW v AS SELECT 1";
        let cursor = sql[..sql.find("CREATE VIEW").unwrap()].encode_utf16().count();

        assert_eq!(super::find_statement_at_cursor(sql, cursor), "CREATE VIEW v AS SELECT 1");
    }

    #[test]
    fn keeps_create_view_statement_together_across_double_blank_line() {
        let sql = "CREATE VIEW v AS\n\n\nSELECT 1";
        let cursor = sql[..sql.find("SELECT 1").unwrap()].encode_utf16().count();

        assert_eq!(super::find_statement_at_cursor(sql, cursor), "CREATE VIEW v AS\n\n\nSELECT 1");
    }

    #[test]
    fn finds_statement_with_dollar_quote() {
        let sql = "SELECT $$a;b$$; SELECT 2";

        assert_eq!(super::find_statement_at_cursor(sql, 3), "SELECT $$a;b$$");
        assert_eq!(super::find_statement_at_cursor(sql, 17), "SELECT 2");
    }

    #[test]
    fn finds_statement_with_custom_delimiter() {
        let sql = "\
DELIMITER //
CREATE PROCEDURE foo()
BEGIN
  SELECT 1;
END //
DELIMITER ;
SELECT 2;";
        let cursor = sql.find("SELECT 1").unwrap();
        let next_cursor = sql.rfind("SELECT 2").unwrap();

        assert_eq!(super::find_statement_at_cursor(sql, cursor), "CREATE PROCEDURE foo()\nBEGIN\n  SELECT 1;\nEND");
        assert_eq!(super::find_statement_at_cursor(sql, next_cursor), "SELECT 2");
    }

    #[test]
    fn sqlserver_current_statement_keeps_procedure_batch_with_inner_semicolons() {
        let sql = "\
CREATE OR ALTER PROCEDURE dbo.usp_demo
AS
BEGIN
  SELECT 1;
  SELECT 2;
END
GO
SELECT 3;";
        let cursor = sql[..sql.find("SELECT 2").unwrap()].encode_utf16().count();
        let next_cursor = sql[..sql.rfind("SELECT 3").unwrap()].encode_utf16().count();

        assert_eq!(
            super::find_statement_at_cursor_for_database(sql, cursor, DatabaseType::SqlServer),
            "CREATE OR ALTER PROCEDURE dbo.usp_demo\nAS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND"
        );
        assert_eq!(super::find_statement_at_cursor_for_database(sql, next_cursor, DatabaseType::SqlServer), "SELECT 3");
    }

    #[test]
    fn sqlserver_current_statement_keeps_alter_procedure_batch() {
        let sql = "\
ALTER PROC dbo.usp_demo
AS
BEGIN
  UPDATE dbo.users SET name = name;
END";
        let cursor = sql[..sql.find("UPDATE").unwrap()].encode_utf16().count();

        assert_eq!(
            super::find_statement_at_cursor_for_database(sql, cursor, DatabaseType::SqlServer),
            "ALTER PROC dbo.usp_demo\nAS\nBEGIN\n  UPDATE dbo.users SET name = name;\nEND"
        );
    }

    #[test]
    fn mysql_hash_comments_split_statements_per_issue_428() {
        let sql = "SELECT 1; # mysql comment\n\nSELECT 2 # trailing comment";
        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Mysql),
            vec!["SELECT 1", "# mysql comment\n\nSELECT 2 # trailing comment"]
        );
    }

    #[test]
    fn mysql_delimiter_command_keeps_procedure_body_together_per_issue_1978() {
        let sql = "\
-- ----------------------------
-- Procedure structure for fix_collation
-- ----------------------------
DROP PROCEDURE IF EXISTS `fix_collation`;
delimiter ;;
CREATE PROCEDURE `fix_collation`()
BEGIN
DECLARE done INT DEFAULT FALSE;
DECLARE tbl_name VARCHAR(255);
DECLARE cur CURSOR FOR
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_COLLATION = 'utf8mb4_0900_ai_ci';
DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN cur;
    read_loop: LOOP
        FETCH cur INTO tbl_name;
        IF done THEN LEAVE read_loop; END IF;
        SET @sql = CONCAT('ALTER TABLE `', tbl_name, '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END LOOP;
    CLOSE cur;
END
;;
delimiter ;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Mysql),
            vec![
                "-- ----------------------------\n-- Procedure structure for fix_collation\n-- ----------------------------\nDROP PROCEDURE IF EXISTS `fix_collation`",
                "CREATE PROCEDURE `fix_collation`()\nBEGIN\nDECLARE done INT DEFAULT FALSE;\nDECLARE tbl_name VARCHAR(255);\nDECLARE cur CURSOR FOR\nSELECT TABLE_NAME FROM information_schema.TABLES\nWHERE TABLE_SCHEMA = DATABASE() AND TABLE_COLLATION = 'utf8mb4_0900_ai_ci';\nDECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;\n\n    OPEN cur;\n    read_loop: LOOP\n        FETCH cur INTO tbl_name;\n        IF done THEN LEAVE read_loop; END IF;\n        SET @sql = CONCAT('ALTER TABLE `', tbl_name, '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');\n        PREPARE stmt FROM @sql;\n        EXECUTE stmt;\n        DEALLOCATE PREPARE stmt;\n    END LOOP;\n    CLOSE cur;\nEND",
            ]
        );
    }

    #[test]
    fn mysql_current_statement_ignores_delimiter_command_semicolon_per_issue_1978() {
        let sql = "\
delimiter ;;
CREATE PROCEDURE `fix_collation`()
BEGIN
    SET @sql = CONCAT('ALTER TABLE `', 't', '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
END
;;
delimiter ;";
        let cursor = sql[..sql.find("PREPARE").unwrap()].encode_utf16().count();

        assert_eq!(
            find_statement_at_cursor_for_database(sql, cursor, DatabaseType::Mysql),
            "CREATE PROCEDURE `fix_collation`()\nBEGIN\n    SET @sql = CONCAT('ALTER TABLE `', 't', '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');\n    PREPARE stmt FROM @sql;\n    EXECUTE stmt;\nEND"
        );
    }

    #[test]
    fn mysql_delimiter_command_skips_empty_custom_delimiter_statement_per_issue_1988() {
        let sql = "\
select COUNT(1) FROM your_table;
delimiter ;;
select COUNT(1) FROM your_table;

;;
delimiter ;";

        assert_eq!(
            split_sql_statements_for_database(sql, DatabaseType::Mysql),
            vec!["select COUNT(1) FROM your_table", "select COUNT(1) FROM your_table;"]
        );
    }

    #[test]
    fn mysql_delimiter_command_ranges_skip_empty_custom_delimiter_statement_per_issue_1988() {
        let sql = "\
select COUNT(1) FROM your_table;
delimiter ;;
select COUNT(1) FROM your_table;

;;
delimiter ;";

        let ranges =
            split_sql_statement_ranges_with_options(sql, SqlParsingOptions::for_database_type(DatabaseType::Mysql));

        assert_eq!(
            ranges.iter().map(|range| range.text.as_str()).collect::<Vec<_>>(),
            vec!["select COUNT(1) FROM your_table", "select COUNT(1) FROM your_table;"]
        );
    }

    #[test]
    fn mysql_current_statement_keeps_inline_hash_comment_per_issue_428() {
        let sql = "SELECT 1; # mysql comment\n\nSELECT 2 # trailing comment";
        let cursor = sql[..sql.find("SELECT 2").unwrap()].encode_utf16().count();
        assert_eq!(
            find_statement_at_cursor_for_database(sql, cursor, DatabaseType::Mysql),
            "SELECT 2 # trailing comment"
        );
    }

    #[test]
    fn mysql_single_statement_with_inline_comment_stays_executable_per_issue_428() {
        let sql = "SELECT 1 # mysql comment";
        let cursor = sql.encode_utf16().count();
        assert_eq!(find_statement_at_cursor_for_database(sql, cursor, DatabaseType::Mysql), "SELECT 1 # mysql comment");
    }
}
