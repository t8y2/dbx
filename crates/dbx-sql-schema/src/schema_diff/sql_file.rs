//! Parse a schema-only MySQL dump into the metadata shapes the live driver
//! returns, so a mysqldump --no-data file can stand in for a source
//! connection during a structure comparison.
//!
//! The comparison never sees SQL text: the frontend loads five metadata views
//! (columns, indexes, foreign keys, triggers, DDL) from whatever side it is
//! comparing. A dump has to fill exactly those views, which means reproducing
//! the handful of places where the MySQL driver rewrites information_schema
//! output: COLUMN_TYPE becomes the declared type, generated columns get their
//! EXTRA rebuilt, and routine definitions lose their DEFINER clause.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::types::{ColumnInfo, ForeignKeyInfo, FunctionInfo, IndexInfo, TableInfo, TriggerInfo};

use super::TableSchemaDetail;

/// Tables, routines and definitions recovered from a schema-only SQL file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffSqlFileSnapshot {
    pub tables: Vec<TableInfo>,
    pub details: Vec<TableSchemaDetail>,
    pub functions: Vec<FunctionInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl SchemaDiffSqlFileSnapshot {
    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
}

/// Parse a MySQL schema dump.
///
/// Unsupported statements are skipped instead of failing the whole file: a dump
/// contains SET, DROP, privilege and LOCK TABLES noise around the definitions
/// that matter. The optional database name backfills the schema qualifier the
/// live driver always reports for foreign keys.
pub fn parse_mysql_schema_sql_file(sql: &str, database: Option<&str>) -> SchemaDiffSqlFileSnapshot {
    let mut parser = DumpParser { database: database.map(|value| value.to_string()), ..DumpParser::default() };
    for statement in split_dump_statements(sql) {
        let text = normalize_dump_statement(&statement);
        if text.is_empty() {
            continue;
        }
        parser.parse_statement(&text);
    }
    parser.finish()
}

#[derive(Default)]
struct DumpParser {
    database: Option<String>,
    order: Vec<String>,
    infos: HashMap<String, TableInfo>,
    details: HashMap<String, TableSchemaDetail>,
    functions: Vec<FunctionInfo>,
    warnings: Vec<String>,
    pending_triggers: Vec<(String, TriggerInfo)>,
}

impl DumpParser {
    fn parse_statement(&mut self, text: &str) {
        let tokens = tokenize(text);
        let mut cursor = Cursor::new(&tokens, text);
        if !cursor.eat_word("CREATE") {
            return;
        }
        cursor.eat_word("OR");
        cursor.eat_word("REPLACE");
        cursor.eat_word("TEMPORARY");
        skip_definer_clause(&mut cursor);
        if cursor.eat_word("TABLE") {
            self.parse_create_table(cursor);
            return;
        }
        if cursor.eat_word("UNIQUE") || cursor.eat_word("FULLTEXT") || cursor.eat_word("SPATIAL") {
            if cursor.eat_word("INDEX") {
                self.parse_create_index(cursor);
            }
            return;
        }
        if cursor.eat_word("INDEX") {
            self.parse_create_index(cursor);
            return;
        }
        if cursor.eat_word("TRIGGER") {
            self.parse_create_trigger(cursor, text);
            return;
        }
        if cursor.eat_word("PROCEDURE") {
            self.parse_create_routine(cursor, text, "PROCEDURE");
            return;
        }
        if cursor.eat_word("FUNCTION") {
            self.parse_create_routine(cursor, text, "FUNCTION");
            return;
        }
        if cursor.eat_word("VIEW") || cursor.looks_like_view() {
            self.parse_create_view(cursor, text);
        }
    }

    fn parse_create_table(&mut self, mut cursor: Cursor) {
        if cursor.eat_word("IF") {
            cursor.eat_word("NOT");
            cursor.eat_word("EXISTS");
        }
        let Some(name) = cursor.read_qualified_name() else {
            return;
        };
        if !cursor.peek_punct('(') {
            return;
        }
        let Some(items) = split_parenthesized_parts(&mut cursor) else {
            return;
        };
        let source = cursor.source;
        let mut detail = TableSchemaDetail {
            name: name.clone(),
            columns: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            ddl: Some(ensure_semicolon(source.trim_end())),
        };
        for item in &items {
            let keyword = item
                .first()
                .and_then(|token| match &token.kind {
                    TokenKind::Word(word) => Some(word.to_ascii_uppercase()),
                    _ => None,
                })
                .unwrap_or_default();
            match keyword.as_str() {
                "PRIMARY" => {
                    if let Some(index) = parse_index_definition(item, source, IndexFlavor::Primary) {
                        detail.indexes.push(index);
                    }
                }
                "UNIQUE" => {
                    if let Some(index) = parse_index_definition(item, source, IndexFlavor::Unique) {
                        detail.indexes.push(index);
                    }
                }
                "KEY" | "INDEX" => {
                    if let Some(index) = parse_index_definition(item, source, IndexFlavor::Plain) {
                        detail.indexes.push(index);
                    }
                }
                "FULLTEXT" => {
                    if let Some(index) = parse_index_definition(item, source, IndexFlavor::Fulltext) {
                        detail.indexes.push(index);
                    }
                }
                "SPATIAL" => {
                    if let Some(index) = parse_index_definition(item, source, IndexFlavor::Spatial) {
                        detail.indexes.push(index);
                    }
                }
                "CONSTRAINT" | "FOREIGN" => {
                    if let Some(foreign_keys) = parse_foreign_key_definition(item, source, self.database.as_deref()) {
                        detail.foreign_keys.extend(foreign_keys);
                    }
                }
                "CHECK" => {}
                _ => {
                    if let Some(column) = parse_column_definition(item, source) {
                        detail.columns.push(column);
                    }
                }
            }
        }
        if detail.columns.is_empty() {
            self.warnings.push(format!("No column definitions found for table {name}"));
        }

        // Table options follow the column list: ) ENGINE=InnoDB
        // AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COMMENT='accounts'.
        let mut comment = None;
        loop {
            if cursor.peek().is_none() {
                break;
            }
            if cursor.eat_word("COMMENT") {
                cursor.eat_punct('=');
                if let Some(token) = cursor.peek() {
                    if let TokenKind::Str(value) = &token.kind {
                        if !value.is_empty() {
                            comment = Some(value.clone());
                        }
                    }
                }
                cursor.advance();
                continue;
            }
            cursor.advance();
        }

        let primary_columns: Vec<String> =
            detail.indexes.iter().find(|index| index.is_primary).map(|index| index.columns.clone()).unwrap_or_default();
        for column in &mut detail.columns {
            if primary_columns.iter().any(|primary| primary.eq_ignore_ascii_case(&column.name)) {
                column.is_primary_key = true;
                column.is_nullable = false;
            }
        }

        let info = TableInfo {
            name,
            table_type: "BASE TABLE".to_string(),
            valid: None,
            comment,
            parent_schema: None,
            parent_name: None,
        };
        self.push_table(info, detail);
    }

    fn parse_create_index(&mut self, mut cursor: Cursor) {
        // CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX name [USING type] ON table (cols)
        let Some(name) = cursor.read_name() else {
            return;
        };
        let mut index_type = None;
        if cursor.eat_word("USING") {
            index_type = cursor.read_name().map(|value| value.to_ascii_uppercase());
        }
        if !cursor.eat_word("ON") {
            return;
        }
        let Some(table) = cursor.read_qualified_name() else {
            return;
        };
        let Some(parts) = split_parenthesized_parts(&mut cursor) else {
            return;
        };
        let columns: Vec<String> = parts.iter().filter_map(|part| index_column_name(part, cursor.source)).collect();
        if columns.is_empty() {
            return;
        }
        let Some(detail) = self.details.get_mut(&normalized_name(&table)) else {
            return;
        };
        detail.indexes.push(new_index(name, columns, false, false, index_type));
    }

    fn parse_create_view(&mut self, mut cursor: Cursor, text: &str) {
        while !cursor.is_done() {
            if cursor.eat_word("VIEW") {
                break;
            }
            cursor.advance();
        }
        let Some(name) = cursor.read_qualified_name() else {
            return;
        };
        let info = TableInfo {
            name,
            table_type: "VIEW".to_string(),
            valid: None,
            comment: None,
            parent_schema: None,
            parent_name: None,
        };
        let detail = TableSchemaDetail {
            name: info.name.clone(),
            columns: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            ddl: Some(view_ddl(text)),
        };
        self.push_table(info, detail);
    }

    fn parse_create_trigger(&mut self, mut cursor: Cursor, text: &str) {
        let Some(name) = cursor.read_name() else {
            return;
        };
        let mut timing = None;
        let mut event = None;
        let mut table = None;
        let mut body_start = None;
        while !cursor.is_done() {
            let Some(token) = cursor.peek() else {
                break;
            };
            let keyword = match &token.kind {
                TokenKind::Word(word) => word.to_ascii_uppercase(),
                _ => String::new(),
            };
            match keyword.as_str() {
                "BEFORE" | "AFTER" => {
                    timing = cursor.read_name().map(|value| value.to_ascii_uppercase());
                }
                "INSERT" | "UPDATE" | "DELETE" => {
                    event = cursor.read_name().map(|value| value.to_ascii_uppercase());
                }
                "ON" => {
                    cursor.advance();
                    table = cursor.read_qualified_name();
                }
                "FOR" => {
                    cursor.advance();
                    cursor.eat_word("EACH");
                    cursor.eat_word("ROW");
                    body_start = cursor.peek().map(|token| token.start);
                    break;
                }
                _ => {
                    cursor.advance();
                }
            }
        }
        let Some(table) = table else {
            return;
        };
        let statement = body_start.map(|start| text.get(start..).unwrap_or_default().trim().to_string());
        let trigger = TriggerInfo {
            name,
            event: event.unwrap_or_default(),
            timing: timing.unwrap_or_default(),
            level: None,
            condition: None,
            language: None,
            enabled: None,
            valid: None,
            comment: None,
            created_at: None,
            statement: statement.filter(|value| !value.is_empty()),
            oracle_metadata: None,
        };
        if let Some(detail) = self.details.get_mut(&normalized_name(&table)) {
            detail.triggers.push(trigger);
        } else {
            self.pending_triggers.push((table, trigger));
        }
    }

    fn parse_create_routine(&mut self, mut cursor: Cursor, text: &str, kind: &str) {
        let Some(name) = cursor.read_qualified_name() else {
            return;
        };
        self.functions.push(FunctionInfo {
            name,
            function_type: kind.to_string(),
            data_type: String::new(),
            definition: remove_definer_clause(text),
            arguments: String::new(),
        });
    }

    fn push_table(&mut self, info: TableInfo, detail: TableSchemaDetail) {
        let key = normalized_name(&info.name);
        if let std::collections::hash_map::Entry::Occupied(mut entry) = self.details.entry(key.clone()) {
            entry.insert(detail);
            return;
        }
        self.order.push(key.clone());
        self.details.insert(key.clone(), detail);
        self.infos.insert(key, info);
    }

    fn finish(mut self) -> SchemaDiffSqlFileSnapshot {
        for (table, trigger) in std::mem::take(&mut self.pending_triggers) {
            if let Some(detail) = self.details.get_mut(&normalized_name(&table)) {
                detail.triggers.push(trigger);
            }
        }
        let mut tables = Vec::with_capacity(self.order.len());
        let mut details = Vec::with_capacity(self.order.len());
        for key in &self.order {
            if let Some(info) = self.infos.remove(key) {
                tables.push(info);
            }
            if let Some(detail) = self.details.remove(key) {
                details.push(detail);
            }
        }
        SchemaDiffSqlFileSnapshot { tables, details, functions: self.functions, warnings: self.warnings }
    }
}

fn new_index(
    name: String,
    columns: Vec<String>,
    is_unique: bool,
    is_primary: bool,
    index_type: Option<String>,
) -> IndexInfo {
    IndexInfo {
        owner: None,
        name,
        columns,
        is_unique,
        is_primary,
        filter: None,
        index_type,
        included_columns: None,
        comment: None,
        key_is_expression: Vec::new(),
        key_directions: Vec::new(),
        visibility: None,
        key_metadata_complete: false,
        column_opclasses: Vec::new(),
        key_options: Vec::new(),
        constraint_backed: false,
    }
}

fn normalized_name(name: &str) -> String {
    name.to_ascii_lowercase()
}

fn ensure_semicolon(text: &str) -> String {
    let trimmed = text.trim_end();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

/// Rebuild a view definition the way the driver hands it to the comparison:
/// CREATE OR REPLACE prefix, no DEFINER, statement still ending with a semicolon.
fn view_ddl(text: &str) -> String {
    let base = remove_definer_clause(text);
    let upper = base.to_ascii_uppercase();
    let rewritten = if upper.starts_with("CREATE OR REPLACE ") {
        base.clone()
    } else if upper.starts_with("CREATE ") {
        format!("CREATE OR REPLACE {}", base.get("CREATE ".len()..).unwrap_or_default())
    } else {
        base.clone()
    };
    ensure_semicolon(&rewritten)
}

/// Drop a DEFINER=user@host clause from a CREATE statement, mirroring the
/// driver's own normalization for routines and views.
fn remove_definer_clause(text: &str) -> String {
    let tokens = tokenize(text);
    let Some(index) = tokens
        .iter()
        .position(|token| matches!(&token.kind, TokenKind::Word(word) if word.eq_ignore_ascii_case("DEFINER")))
    else {
        return text.trim().to_string();
    };
    let mut cursor = index + 1;
    if tokens.get(cursor).is_some_and(|token| matches!(token.kind, TokenKind::Punct('='))) {
        cursor += 1;
    }
    if tokens
        .get(cursor)
        .is_some_and(|token| matches!(&token.kind, TokenKind::Word(word) if word.eq_ignore_ascii_case("CURRENT_USER")))
    {
        cursor += 1;
    } else if tokens.get(cursor).is_some() {
        cursor += 1;
        if tokens.get(cursor).is_some_and(|token| matches!(token.kind, TokenKind::Punct('@'))) {
            cursor += 2;
        }
    }
    let end = tokens.get(cursor.saturating_sub(1)).map(|token| token.end);
    let start = tokens.get(index).map(|token| token.start);
    match (start, end) {
        (Some(start), Some(end)) => {
            let before = text.get(..start).unwrap_or_default().trim_end();
            let after = text.get(end..).unwrap_or_default().trim_start();
            format!("{before} {after}").trim().to_string()
        }
        _ => text.trim().to_string(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndexFlavor {
    Primary,
    Unique,
    Plain,
    Fulltext,
    Spatial,
}

fn parse_index_definition(item: &[Token], source: &str, flavor: IndexFlavor) -> Option<IndexInfo> {
    let mut cursor = Cursor::new(item, source);
    cursor.advance();
    cursor.eat_word("KEY");
    cursor.eat_word("INDEX");
    let mut name = if flavor == IndexFlavor::Primary { "PRIMARY".to_string() } else { String::new() };
    if flavor != IndexFlavor::Primary && !cursor.peek_punct('(') && !cursor.peek_word("USING") {
        if let Some(value) = cursor.read_name() {
            name = value;
        }
    }
    let mut index_type = match flavor {
        IndexFlavor::Fulltext => Some("FULLTEXT".to_string()),
        IndexFlavor::Spatial => Some("SPATIAL".to_string()),
        _ => None,
    };
    if cursor.eat_word("USING") {
        index_type = cursor.read_name().map(|value| value.to_ascii_uppercase());
    }
    if !cursor.peek_punct('(') {
        return None;
    }
    let parts = split_parenthesized_parts(&mut cursor)?;
    let columns: Vec<String> = parts.iter().filter_map(|part| index_column_name(part, source)).collect();
    if columns.is_empty() {
        return None;
    }
    if index_type.is_none() {
        index_type = Some("BTREE".to_string());
    }
    if cursor.eat_word("USING") {
        if let Some(value) = cursor.read_name() {
            index_type = Some(value.to_ascii_uppercase());
        }
    }
    if name.is_empty() {
        name = columns.first().cloned().unwrap_or_default();
    }
    let is_primary = flavor == IndexFlavor::Primary;
    Some(new_index(name, columns, is_primary || flavor == IndexFlavor::Unique, is_primary, index_type))
}

fn parse_foreign_key_definition(item: &[Token], source: &str, database: Option<&str>) -> Option<Vec<ForeignKeyInfo>> {
    let mut cursor = Cursor::new(item, source);
    let mut name = String::new();
    if cursor.eat_word("CONSTRAINT") {
        let is_name = match cursor.peek().map(|token| &token.kind) {
            Some(TokenKind::Ident(_)) => true,
            Some(TokenKind::Word(word)) => !word.eq_ignore_ascii_case("FOREIGN"),
            _ => false,
        };
        if is_name {
            name = cursor.read_name().unwrap_or_default();
        }
    }
    if !cursor.eat_word("FOREIGN") {
        return None;
    }
    cursor.eat_word("KEY");
    if !cursor.peek_punct('(') {
        return None;
    }
    let parts = split_parenthesized_parts(&mut cursor)?;
    let columns: Vec<String> = parts.iter().filter_map(|part| index_column_name(part, source)).collect();
    if !cursor.eat_word("REFERENCES") {
        return None;
    }
    let ref_table = cursor.read_qualified_name()?;
    let mut ref_schema = cursor.last_qualifier.clone();
    if ref_schema.is_none() {
        ref_schema = database.map(|value| value.to_string());
    }
    if !cursor.peek_punct('(') {
        return None;
    }
    let ref_parts = split_parenthesized_parts(&mut cursor)?;
    let ref_columns: Vec<String> = ref_parts.iter().filter_map(|part| index_column_name(part, source)).collect();
    let mut on_delete = None;
    let mut on_update = None;
    loop {
        if cursor.is_done() {
            break;
        }
        if cursor.eat_word("ON") {
            if cursor.eat_word("DELETE") {
                on_delete = cursor.read_action();
            } else if cursor.eat_word("UPDATE") {
                on_update = cursor.read_action();
            }
            continue;
        }
        cursor.advance();
    }
    let mut result = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        let Some(ref_column) = ref_columns.get(index) else {
            break;
        };
        result.push(ForeignKeyInfo {
            name: name.clone(),
            column: column.clone(),
            ref_schema: ref_schema.clone(),
            ref_table: ref_table.clone(),
            ref_column: ref_column.clone(),
            on_update: on_update.clone(),
            on_delete: on_delete.clone(),
        });
    }
    Some(result)
}

fn index_column_name(part: &[Token], source: &str) -> Option<String> {
    let first = part.first()?;
    match &first.kind {
        TokenKind::Punct('(') => {
            let last = part.last()?;
            if last.end <= first.start + 1 {
                return None;
            }
            let inner = source.get(first.start + 1..last.end - 1)?;
            Some(format!("({})", normalize_sql_fragment(inner)))
        }
        TokenKind::Ident(name) | TokenKind::Word(name) => Some(name.clone()),
        _ => None,
    }
}

fn parse_column_definition(item: &[Token], source: &str) -> Option<ColumnInfo> {
    let mut cursor = Cursor::new(item, source);
    let name = cursor.read_name()?;
    let type_start = cursor.peek()?.start;
    let mut type_end = type_start;
    while let Some(token) = cursor.peek() {
        if is_column_type_terminator(&token.kind, cursor.peek_at(1).map(|next| &next.kind)) {
            break;
        }
        type_end = token.end;
        cursor.advance();
    }
    if type_end <= type_start {
        return None;
    }
    let data_type = normalize_sql_fragment(source.get(type_start..type_end)?);
    if data_type.is_empty() {
        return None;
    }
    let mut column = ColumnInfo { name, data_type, is_nullable: true, ..ColumnInfo::default() };
    let mut auto_increment = false;
    let mut default_is_expression = false;
    let mut on_update = false;
    let mut generated: Option<(String, String)> = None;

    while !cursor.is_done() {
        if cursor.eat_word("NOT") {
            if cursor.eat_word("NULL") {
                column.is_nullable = false;
            }
            continue;
        }
        if cursor.eat_word("NULL") {
            column.is_nullable = true;
            continue;
        }
        if cursor.eat_word("DEFAULT") {
            let parsed = parse_default_value(&mut cursor);
            default_is_expression = parsed.1;
            column.column_default = parsed.0;
            continue;
        }
        if cursor.eat_word("AUTO_INCREMENT") {
            auto_increment = true;
            continue;
        }
        if cursor.eat_word("UNIQUE") {
            column.is_unique = true;
            cursor.eat_word("KEY");
            continue;
        }
        if cursor.eat_word("PRIMARY") {
            cursor.eat_word("KEY");
            column.is_primary_key = true;
            column.is_nullable = false;
            continue;
        }
        if cursor.eat_word("KEY") {
            column.is_primary_key = true;
            column.is_nullable = false;
            continue;
        }
        if cursor.eat_word("COMMENT") {
            cursor.eat_punct('=');
            if let Some(token) = cursor.peek() {
                if let TokenKind::Str(value) = &token.kind {
                    if !value.is_empty() {
                        column.comment = Some(value.clone());
                    }
                }
            }
            cursor.advance();
            continue;
        }
        if cursor.eat_word("COLLATE") {
            cursor.eat_punct('=');
            column.collation = cursor.read_name();
            continue;
        }
        if cursor.eat_word("CHARSET") {
            cursor.eat_punct('=');
            column.character_set = cursor.read_name();
            continue;
        }
        if cursor.peek_word("CHARACTER") && cursor.peek_word_at(1, "SET") {
            cursor.advance();
            cursor.advance();
            cursor.eat_punct('=');
            column.character_set = cursor.read_name();
            continue;
        }
        if cursor.eat_word("GENERATED") || cursor.eat_word("AS") {
            cursor.eat_word("ALWAYS");
            cursor.eat_word("AS");
            if cursor.peek_punct('(') {
                let expression = strip_outer_parens(&read_parenthesized_text(&mut cursor).unwrap_or_default());
                let storage = if cursor.eat_word("STORED") {
                    "STORED".to_string()
                } else {
                    cursor.eat_word("VIRTUAL");
                    "VIRTUAL".to_string()
                };
                generated = Some((expression, storage));
            }
            continue;
        }
        if cursor.eat_word("ON") {
            if cursor.eat_word("UPDATE") {
                on_update = true;
                let _ = read_expression_text(&mut cursor);
            }
            continue;
        }
        if cursor.eat_word("CHECK") {
            if cursor.peek_punct('(') {
                let _ = read_parenthesized_text(&mut cursor);
            }
            continue;
        }
        cursor.advance();
    }

    let mut extra_parts: Vec<String> = Vec::new();
    if auto_increment {
        extra_parts.push("auto_increment".to_string());
    }
    if let Some((expression, storage)) = generated {
        extra_parts.push(format!("GENERATED ALWAYS AS ({expression}) {storage}"));
    } else {
        if default_is_expression {
            extra_parts.push("DEFAULT_GENERATED".to_string());
        }
        if on_update {
            extra_parts.push("on update CURRENT_TIMESTAMP".to_string());
        }
    }
    if !extra_parts.is_empty() {
        column.extra = Some(extra_parts.join(" "));
    }
    if column.data_type.to_ascii_lowercase().starts_with("enum(") {
        column.enum_values = parse_enum_values(&column.data_type);
    }
    Some(column)
}

fn parse_default_value(cursor: &mut Cursor) -> (Option<String>, bool) {
    let Some(token) = cursor.peek() else {
        return (None, false);
    };
    match &token.kind {
        TokenKind::Punct('(') => (
            read_parenthesized_text(cursor).map(|value| escape_information_schema_default(&strip_outer_parens(&value))),
            true,
        ),
        TokenKind::Punct('-') | TokenKind::Punct('+') => {
            let sign = if matches!(token.kind, TokenKind::Punct('-')) { "-" } else { "" };
            match read_expression_text(cursor) {
                Some(text) => (Some(format!("{sign}{text}")), false),
                None => (None, false),
            }
        }
        TokenKind::Str(value) => {
            let value = value.clone();
            cursor.advance();
            (Some(value), false)
        }
        TokenKind::Ident(value) => {
            let value = value.clone();
            cursor.advance();
            (Some(value), false)
        }
        TokenKind::Word(word) => {
            let upper = word.to_ascii_uppercase();
            if upper == "NULL" {
                cursor.advance();
                return (None, false);
            }
            if is_expression_keyword(&upper) {
                return (read_expression_text(cursor), true);
            }
            let literal_prefix = matches!(upper.as_str(), "B" | "X" | "N") || upper.starts_with('_');
            if literal_prefix && cursor.peek_at(1).is_some_and(|next| matches!(next.kind, TokenKind::Str(_))) {
                let start = token.start;
                cursor.advance();
                cursor.advance();
                let end = cursor.last_end().unwrap_or(start);
                return (cursor.source.get(start..end).map(|text| text.to_string()), false);
            }
            (read_expression_text(cursor), false)
        }
        _ => {
            cursor.advance();
            (None, false)
        }
    }
}

/// Remove one balanced parenthesis layer from an expression that was read as a group.
fn strip_outer_parens(value: &str) -> String {
    let trimmed = value.trim();
    let Some(inner) = trimmed.strip_prefix('(').and_then(|rest| rest.strip_suffix(')')) else {
        return trimmed.to_string();
    };
    let mut depth = 0i32;
    for (offset, ch) in inner.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return trimmed.to_string();
                }
                let _ = offset;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return trimmed.to_string();
    }
    inner.trim().to_string()
}

/// The server reports an expression default without the parenthesis layer
/// mysqldump adds around it, and escapes quotes and backslashes the way a
/// string literal is escaped, so the file default is given the same shape.
fn escape_information_schema_default(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '\'' => escaped.push_str("\\'"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn read_expression_text(cursor: &mut Cursor) -> Option<String> {
    let start = cursor.peek()?.start;
    cursor.advance();
    if cursor.peek_punct('(') {
        let _ = read_parenthesized_text(cursor);
    }
    let end = cursor.last_end().unwrap_or(start);
    cursor.source.get(start..end).map(normalize_sql_fragment)
}

fn read_parenthesized_text(cursor: &mut Cursor) -> Option<String> {
    let start = cursor.peek()?.start;
    if !cursor.peek_punct('(') {
        return None;
    }
    let mut depth = 0usize;
    let mut end = start;
    while let Some(token) = cursor.peek() {
        match token.kind {
            TokenKind::Punct('(') => depth += 1,
            TokenKind::Punct(')') => {
                depth -= 1;
                if depth == 0 {
                    end = token.end;
                    cursor.advance();
                    break;
                }
            }
            _ => {}
        }
        end = token.end;
        cursor.advance();
    }
    cursor.source.get(start..end).map(normalize_sql_fragment)
}

fn is_expression_keyword(upper: &str) -> bool {
    matches!(
        upper,
        "CURRENT_TIMESTAMP"
            | "NOW"
            | "LOCALTIME"
            | "LOCALTIMESTAMP"
            | "CURRENT_DATE"
            | "CURRENT_TIME"
            | "CURDATE"
            | "CURTIME"
            | "UTC_TIMESTAMP"
            | "UTC_DATE"
            | "UTC_TIME"
    )
}

fn is_column_type_terminator(kind: &TokenKind, next: Option<&TokenKind>) -> bool {
    let TokenKind::Word(word) = kind else {
        return false;
    };
    let upper = word.to_ascii_uppercase();
    match upper.as_str() {
        "NOT" | "NULL" | "DEFAULT" | "AUTO_INCREMENT" | "UNIQUE" | "PRIMARY" | "KEY" | "COMMENT" | "COLLATE"
        | "CHARSET" | "GENERATED" | "AS" | "ON" | "REFERENCES" | "CHECK" | "VISIBLE" | "INVISIBLE"
        | "COLUMN_FORMAT" | "STORAGE" | "SRID" => true,
        "CHARACTER" => matches!(next, Some(TokenKind::Word(value)) if value.eq_ignore_ascii_case("SET")),
        _ => false,
    }
}

fn parse_enum_values(data_type: &str) -> Option<Vec<String>> {
    let open = data_type.find('(')?;
    let inner = data_type.get(open + 1..)?.trim_end().strip_suffix(')')?;
    let mut values = Vec::new();
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_ascii_whitespace() || ch == ',' {
            continue;
        }
        if ch != '\'' {
            return None;
        }
        let mut value = String::new();
        loop {
            let current = chars.next()?;
            if current == '\\' {
                let escaped = chars.next()?;
                value.push(match escaped {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
            } else if current == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    value.push('\'');
                } else {
                    break;
                }
            } else {
                value.push(current);
            }
        }
        values.push(value);
    }
    Some(values)
}

/// Collapse insignificant whitespace while leaving string and identifier
/// contents untouched.
fn normalize_sql_fragment(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut quote = None;
    let mut pending_space = false;
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        match quote {
            Some(active) => {
                result.push(ch);
                if ch == '\\' {
                    if let Some(next) = chars.next() {
                        result.push(next);
                    }
                    continue;
                }
                if ch == active {
                    quote = None;
                }
            }
            None => {
                if ch.is_whitespace() {
                    pending_space = true;
                    continue;
                }
                if pending_space && !result.is_empty() {
                    result.push(' ');
                }
                pending_space = false;
                if ch == SYMBOL_QUOTE {
                    quote = Some(ch);
                }
                result.push(ch);
            }
        }
    }
    result.trim().to_string()
}

const SYMBOL_QUOTE: char = '`';

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Word(String),
    Ident(String),
    Str(String),
    Punct(char),
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    start: usize,
    end: usize,
}

struct Cursor<'a> {
    tokens: &'a [Token],
    source: &'a str,
    pos: usize,
    last_qualifier: Option<String>,
}

impl<'a> Cursor<'a> {
    fn new(tokens: &'a [Token], source: &'a str) -> Self {
        Self { tokens, source, pos: 0, last_qualifier: None }
    }

    fn peek(&self) -> Option<&'a Token> {
        self.tokens.get(self.pos)
    }

    fn peek_at(&self, offset: usize) -> Option<&'a Token> {
        self.tokens.get(self.pos + offset)
    }

    fn advance(&mut self) -> Option<&'a Token> {
        let token = self.tokens.get(self.pos);
        if token.is_some() {
            self.pos += 1;
        }
        token
    }

    fn is_done(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    fn last_end(&self) -> Option<usize> {
        let index = self.pos.checked_sub(1)?;
        self.tokens.get(index).map(|token| token.end)
    }

    fn eat_word(&mut self, word: &str) -> bool {
        if self.peek_word(word) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn peek_word(&self, word: &str) -> bool {
        self.peek_word_at(0, word)
    }

    fn peek_word_at(&self, offset: usize, word: &str) -> bool {
        matches!(self.peek_at(offset).map(|token| &token.kind), Some(TokenKind::Word(value)) if value.eq_ignore_ascii_case(word))
    }

    fn peek_punct(&self, punct: char) -> bool {
        matches!(self.peek().map(|token| &token.kind), Some(TokenKind::Punct(value)) if *value == punct)
    }

    fn eat_punct(&mut self, punct: char) -> bool {
        if self.peek_punct(punct) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn read_name(&mut self) -> Option<String> {
        let token = self.peek()?;
        let name = match &token.kind {
            TokenKind::Word(value) | TokenKind::Ident(value) | TokenKind::Str(value) => value.clone(),
            _ => return None,
        };
        self.pos += 1;
        Some(name)
    }

    // Consume a name or a qualifier.name pair; the leading segment is kept in
    // last_qualifier so foreign keys can inherit the schema they name.
    fn read_qualified_name(&mut self) -> Option<String> {
        self.last_qualifier = None;
        let first = self.read_name()?;
        if !self.eat_punct('.') {
            return Some(first);
        }
        let Some(second) = self.read_name() else {
            return Some(first);
        };
        if self.eat_punct('.') {
            if let Some(third) = self.read_name() {
                self.last_qualifier = Some(second);
                return Some(third);
            }
        }
        self.last_qualifier = Some(first);
        Some(second)
    }

    fn read_action(&mut self) -> Option<String> {
        if self.eat_word("RESTRICT") {
            return Some("RESTRICT".to_string());
        }
        if self.eat_word("CASCADE") {
            return Some("CASCADE".to_string());
        }
        if self.eat_word("SET") {
            if self.eat_word("NULL") {
                return Some("SET NULL".to_string());
            }
            self.eat_word("DEFAULT");
            return Some("SET DEFAULT".to_string());
        }
        if self.eat_word("NO") {
            self.eat_word("ACTION");
            return Some("NO ACTION".to_string());
        }
        None
    }

    fn looks_like_view(&self) -> bool {
        for token in self.tokens.get(self.pos..).unwrap_or_default() {
            match &token.kind {
                TokenKind::Word(word) if word.eq_ignore_ascii_case("VIEW") => return true,
                TokenKind::Punct('(') => return false,
                _ => {}
            }
        }
        false
    }
}

// Skip the DEFINER clause that precedes the object type in SHOW CREATE output.
fn skip_definer_clause(cursor: &mut Cursor) {
    while cursor.peek_word("DEFINER") {
        cursor.advance();
        cursor.eat_punct('=');
        if cursor.peek_word("CURRENT_USER") {
            cursor.advance();
            if cursor.peek_punct('(') {
                let _ = read_parenthesized_text(cursor);
            }
            continue;
        }
        let _ = cursor.read_name();
        if cursor.eat_punct('@') {
            let _ = cursor.read_name();
        }
    }
}

// Split the contents of a parenthesized group on top-level commas.
fn split_parenthesized_parts(cursor: &mut Cursor) -> Option<Vec<Vec<Token>>> {
    if !cursor.peek_punct('(') {
        return None;
    }
    let mut depth = 0usize;
    let mut parts: Vec<Vec<Token>> = Vec::new();
    let mut current: Vec<Token> = Vec::new();
    while let Some(token) = cursor.advance() {
        match token.kind {
            TokenKind::Punct('(') => {
                depth += 1;
                if depth == 1 {
                    continue;
                }
                current.push(token.clone());
            }
            TokenKind::Punct(')') => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                if depth == 0 {
                    break;
                }
                current.push(token.clone());
            }
            TokenKind::Punct(',') if depth == 1 => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(token.clone()),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    Some(parts)
}

fn tokenize(text: &str) -> Vec<Token> {
    let bytes = text.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let Some(ch) = text.get(index..).and_then(|rest| rest.chars().next()) else {
            break;
        };
        if ch.is_whitespace() {
            index += ch.len_utf8();
            continue;
        }
        if ch == '#' {
            index = skip_line(text, index);
            continue;
        }
        if ch == '-' && bytes.get(index + 1) == Some(&b'-') {
            index = skip_line(text, index);
            continue;
        }
        if ch == '/' && bytes.get(index + 1) == Some(&b'*') {
            index = skip_block_comment(text, index);
            continue;
        }
        if ch == '\'' || ch == '"' || ch == SYMBOL_QUOTE {
            let (end, value) = read_quoted_string(text, index, ch);
            let kind = if ch == SYMBOL_QUOTE { TokenKind::Ident(value) } else { TokenKind::Str(value) };
            tokens.push(Token { kind, start: index, end });
            index = end;
            continue;
        }
        if ch == '@' {
            tokens.push(Token { kind: TokenKind::Punct('@'), start: index, end: index + 1 });
            index += 1;
            continue;
        }
        if ch.is_ascii_digit() {
            let start = index;
            let mut end = index;
            while end < bytes.len() {
                let byte = bytes[end];
                if byte.is_ascii_digit()
                    || (byte == b'.' && bytes.get(end + 1).is_some_and(|next| next.is_ascii_digit()))
                {
                    end += 1;
                } else {
                    break;
                }
            }
            tokens.push(Token {
                kind: TokenKind::Word(text.get(start..end).unwrap_or_default().to_string()),
                start,
                end,
            });
            index = end;
            continue;
        }
        if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            let start = index;
            let mut end = index;
            while end < bytes.len() {
                let byte = bytes[end];
                if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' {
                    end += 1;
                } else {
                    break;
                }
            }
            tokens.push(Token {
                kind: TokenKind::Word(text.get(start..end).unwrap_or_default().to_string()),
                start,
                end,
            });
            index = end;
            continue;
        }
        tokens.push(Token { kind: TokenKind::Punct(ch), start: index, end: index + ch.len_utf8() });
        index += ch.len_utf8();
    }
    tokens
}

fn skip_line(text: &str, start: usize) -> usize {
    text.get(start..).and_then(|rest| rest.find('\n')).map(|offset| start + offset).unwrap_or(text.len())
}

fn skip_block_comment(text: &str, start: usize) -> usize {
    text.get(start + 2..).and_then(|rest| rest.find("*/")).map(|offset| start + 2 + offset + 2).unwrap_or(text.len())
}

fn skip_quoted(text: &str, start: usize, quote: char) -> usize {
    read_quoted_string(text, start, quote).0
}

// Read a quoted literal, undoing backslash and doubled-quote escapes.
fn read_quoted_string(text: &str, start: usize, quote: char) -> (usize, String) {
    let mut value = String::new();
    let mut chars = text.get(start + quote.len_utf8()..).unwrap_or_default().char_indices();
    while let Some((offset, ch)) = chars.next() {
        if ch == '\\' {
            if let Some((_, escaped)) = chars.next() {
                value.push(match escaped {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '0' => '\0',
                    other => other,
                });
            }
            continue;
        }
        if ch == quote {
            if let Some((_, next)) = chars.clone().next() {
                if next == quote {
                    chars.next();
                    value.push(quote);
                    continue;
                }
            }
            return (start + quote.len_utf8() + offset + ch.len_utf8(), value);
        }
        value.push(ch);
    }
    (text.len(), value)
}

// Split a dump into statements, honouring DELIMITER directives, quoted
// literals and comments. Delimiters are cut off; comments are kept so the
// normalizer can decide what to unwrap.
fn split_dump_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut buffer = String::new();
    let mut delimiter = String::from(";");
    let bytes = sql.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if blank_line_prefix(sql, index) && buffer.trim().is_empty() && word_starts_at(sql, index, "DELIMITER") {
            let end =
                sql.get(index..).and_then(|rest| rest.find('\n')).map(|offset| index + offset).unwrap_or(sql.len());
            let line = sql.get(index..end).unwrap_or_default().trim();
            if let Some(value) = line.split_whitespace().nth(1) {
                delimiter = value.to_string();
            }
            index = end;
            continue;
        }
        let Some(ch) = sql.get(index..).and_then(|rest| rest.chars().next()) else {
            break;
        };
        if ch == '\'' || ch == '"' || ch == SYMBOL_QUOTE {
            let end = skip_quoted(sql, index, ch);
            buffer.push_str(sql.get(index..end).unwrap_or_default());
            index = end;
            continue;
        }
        if ch == '#' {
            let end = skip_line(sql, index);
            buffer.push_str(sql.get(index..end).unwrap_or_default());
            index = end;
            continue;
        }
        if ch == '-' && bytes.get(index + 1) == Some(&b'-') {
            let end = skip_line(sql, index);
            buffer.push_str(sql.get(index..end).unwrap_or_default());
            index = end;
            continue;
        }
        if ch == '/' && bytes.get(index + 1) == Some(&b'*') {
            let end = skip_block_comment(sql, index);
            buffer.push_str(sql.get(index..end).unwrap_or_default());
            index = end;
            continue;
        }
        if sql.get(index..).is_some_and(|rest| rest.starts_with(delimiter.as_str())) {
            statements.push(std::mem::take(&mut buffer));
            index += delimiter.len();
            continue;
        }
        buffer.push(ch);
        index += ch.len_utf8();
    }
    if !buffer.trim().is_empty() {
        statements.push(buffer);
    }
    statements
}

fn blank_line_prefix(sql: &str, index: usize) -> bool {
    let line_start = sql.get(..index).and_then(|head| head.rfind('\n')).map(|offset| offset + 1).unwrap_or(0);
    sql.get(line_start..index).is_some_and(|prefix| prefix.trim().is_empty())
}

fn word_starts_at(sql: &str, index: usize, word: &str) -> bool {
    let Some(rest) = sql.get(index..) else {
        return false;
    };
    if rest.len() < word.len() || !rest.is_char_boundary(word.len()) {
        return false;
    }
    let Some(head) = rest.get(..word.len()) else {
        return false;
    };
    head.eq_ignore_ascii_case(word)
        && rest.get(word.len()..).and_then(|tail| tail.chars().next()).is_some_and(|next| next.is_whitespace())
}

// Unwrap executable comments (/*!50003 ... */), drop ordinary comments and
// trim the statement.
fn normalize_dump_statement(statement: &str) -> String {
    let mut result = String::with_capacity(statement.len());
    let bytes = statement.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let Some(ch) = statement.get(index..).and_then(|rest| rest.chars().next()) else {
            break;
        };
        if ch == '\'' || ch == '"' || ch == SYMBOL_QUOTE {
            let end = skip_quoted(statement, index, ch);
            result.push_str(statement.get(index..end).unwrap_or_default());
            index = end;
            continue;
        }
        if ch == '/' && bytes.get(index + 1) == Some(&b'*') {
            let end = skip_block_comment(statement, index);
            let inner = statement.get(index + 2..end.saturating_sub(2)).unwrap_or_default();
            if let Some(body) = inner.strip_prefix('!') {
                let body = body.trim_start_matches(|value: char| value.is_ascii_digit());
                result.push(' ');
                result.push_str(body);
                result.push(' ');
            }
            index = end;
            continue;
        }
        if ch == '#' || (ch == '-' && bytes.get(index + 1) == Some(&b'-')) {
            index = skip_line(statement, index);
            continue;
        }
        result.push(ch);
        index += ch.len_utf8();
    }
    result.trim().trim_end_matches(';').trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = r#"--
-- MySQL dump 10.13
--
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;

CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'pk',
  `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `score` decimal(10,2) NOT NULL DEFAULT '0.00',
  `payload` json DEFAULT (json_object()),
  `note_expr` varchar(40) DEFAULT (concat(_latin1'a\\b')),
  `quoted_expr` varchar(40) DEFAULT (concat(_latin1'it\'s')),
  `paren_expr` int DEFAULT ((1 + 1)),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  `team_id` int DEFAULT NULL,
  `slug` varchar(64) GENERATED ALWAYS AS (lower(`name`)) STORED,
  `nickname` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_name` (`name`),
  KEY `idx_team_name` (`team_id`,`name`),
  KEY `idx_slug` (`slug`(10)),
  FULLTEXT KEY `ft_name` (`name`),
  CONSTRAINT `fk_users_team` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='accounts';

/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`%` SQL SECURITY DEFINER */
/*!50001 VIEW `active_users` AS select `users`.`id`, `users`.`name` from `users` where (`users`.`status` = 'active') */;

DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER `trg_users_touch` BEFORE UPDATE ON `users` FOR EACH ROW BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP;
END */;;
DELIMITER ;

DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `p_refresh`()
BEGIN
  DELETE FROM `active_users`;
END ;;
DELIMITER ;
"#;

    fn column<'a>(snapshot: &'a SchemaDiffSqlFileSnapshot, table: &str, column: &str) -> &'a ColumnInfo {
        let detail = snapshot.details.iter().find(|detail| detail.name == table).expect("table detail");
        detail.columns.iter().find(|entry| entry.name == column).expect("column")
    }

    #[test]
    fn parses_tables_columns_indexes_and_keys() {
        let snapshot = parse_mysql_schema_sql_file(DUMP, Some("shop"));

        assert_eq!(snapshot.tables.len(), 2);
        assert_eq!(snapshot.tables[0].name, "users");
        assert_eq!(snapshot.tables[0].table_type, "BASE TABLE");
        assert_eq!(snapshot.tables[0].comment.as_deref(), Some("accounts"));
        assert_eq!(snapshot.tables[1].name, "active_users");
        assert_eq!(snapshot.tables[1].table_type, "VIEW");

        let detail = snapshot.details.iter().find(|detail| detail.name == "users").expect("users detail");
        assert_eq!(detail.columns.len(), 13);

        let id = column(&snapshot, "users", "id");
        assert_eq!(id.data_type, "int unsigned");
        assert_eq!(id.extra.as_deref(), Some("auto_increment"));
        assert!(id.is_primary_key);
        assert!(!id.is_nullable);
        assert_eq!(id.comment.as_deref(), Some("pk"));

        let name = column(&snapshot, "users", "name");
        assert_eq!(name.data_type, "varchar(64)");
        assert_eq!(name.column_default.as_deref(), Some(""));
        assert_eq!(name.character_set.as_deref(), Some("utf8mb4"));
        assert_eq!(name.collation.as_deref(), Some("utf8mb4_bin"));
        assert!(!name.is_nullable);

        let status = column(&snapshot, "users", "status");
        assert_eq!(status.enum_values.as_deref(), Some(&["active".to_string(), "disabled".to_string()][..]));

        let score = column(&snapshot, "users", "score");
        assert_eq!(score.column_default.as_deref(), Some("0.00"));
        assert_eq!(score.data_type, "decimal(10,2)");

        let payload = column(&snapshot, "users", "payload");
        assert_eq!(payload.column_default.as_deref(), Some("json_object()"));
        assert_eq!(payload.extra.as_deref(), Some("DEFAULT_GENERATED"));

        // The server drops the parenthesis layer the dump adds and escapes quotes
        // and backslashes the way a string literal is escaped.
        let note_expr = column(&snapshot, "users", "note_expr");
        assert_eq!(note_expr.column_default.as_deref(), Some(r"concat(_latin1\'a\\\\b\')"));
        assert_eq!(note_expr.extra.as_deref(), Some("DEFAULT_GENERATED"));

        let quoted_expr = column(&snapshot, "users", "quoted_expr");
        assert_eq!(quoted_expr.column_default.as_deref(), Some(r"concat(_latin1\'it\\\'s\')"));

        // Only the layer mysqldump adds is removed; a parenthesised expression keeps its own.
        let paren_expr = column(&snapshot, "users", "paren_expr");
        assert_eq!(paren_expr.column_default.as_deref(), Some("(1 + 1)"));

        let created_at = column(&snapshot, "users", "created_at");
        assert_eq!(created_at.column_default.as_deref(), Some("CURRENT_TIMESTAMP"));
        assert_eq!(created_at.extra.as_deref(), Some("DEFAULT_GENERATED"));

        let updated_at = column(&snapshot, "users", "updated_at");
        assert_eq!(updated_at.column_default, None);
        assert_eq!(updated_at.extra.as_deref(), Some("on update CURRENT_TIMESTAMP"));

        let slug = column(&snapshot, "users", "slug");
        assert!(slug.extra.as_deref().is_some_and(|extra| extra.starts_with("GENERATED ALWAYS AS (lower(")));
        assert!(slug.extra.as_deref().is_some_and(|extra| extra.ends_with(") STORED")));

        let nickname = column(&snapshot, "users", "nickname");
        assert_eq!(nickname.column_default, None);
        assert!(nickname.is_nullable);

        assert_eq!(detail.indexes.len(), 5);
        let primary = detail.indexes.iter().find(|index| index.is_primary).expect("primary key");
        assert_eq!(primary.name, "PRIMARY");
        assert_eq!(primary.columns, vec!["id".to_string()]);
        let unique = detail.indexes.iter().find(|index| index.name == "uq_name").expect("unique key");
        assert!(unique.is_unique);
        let composite = detail.indexes.iter().find(|index| index.name == "idx_team_name").expect("composite key");
        assert_eq!(composite.columns, vec!["team_id".to_string(), "name".to_string()]);
        assert_eq!(composite.index_type.as_deref(), Some("BTREE"));
        let prefix = detail.indexes.iter().find(|index| index.name == "idx_slug").expect("prefix key");
        assert_eq!(prefix.columns, vec!["slug".to_string()]);
        let fulltext = detail.indexes.iter().find(|index| index.name == "ft_name").expect("fulltext key");
        assert_eq!(fulltext.index_type.as_deref(), Some("FULLTEXT"));

        assert_eq!(detail.foreign_keys.len(), 1);
        let foreign_key = &detail.foreign_keys[0];
        assert_eq!(foreign_key.name, "fk_users_team");
        assert_eq!(foreign_key.column, "team_id");
        assert_eq!(foreign_key.ref_table, "teams");
        assert_eq!(foreign_key.ref_column, "id");
        assert_eq!(foreign_key.ref_schema.as_deref(), Some("shop"));
        assert_eq!(foreign_key.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(foreign_key.on_update.as_deref(), Some("SET NULL"));
    }

    #[test]
    fn parses_views_triggers_and_routines() {
        let snapshot = parse_mysql_schema_sql_file(DUMP, Some("shop"));

        let view = snapshot.details.iter().find(|detail| detail.name == "active_users").expect("view detail");
        let ddl = view.ddl.as_deref().expect("view ddl");
        assert!(ddl.starts_with("CREATE OR REPLACE "), "{ddl}");
        assert!(ddl.contains("VIEW"), "{ddl}");
        assert!(!ddl.contains("DEFINER="), "{ddl}");
        assert!(ddl.ends_with(';'), "{ddl}");

        let users = snapshot.details.iter().find(|detail| detail.name == "users").expect("users detail");
        assert_eq!(users.triggers.len(), 1);
        let trigger = &users.triggers[0];
        assert_eq!(trigger.name, "trg_users_touch");
        assert_eq!(trigger.timing, "BEFORE");
        assert_eq!(trigger.event, "UPDATE");
        assert!(trigger.statement.as_deref().is_some_and(|statement| statement.contains("SET NEW.updated_at")));

        assert_eq!(snapshot.functions.len(), 1);
        let procedure = &snapshot.functions[0];
        assert_eq!(procedure.name, "p_refresh");
        assert_eq!(procedure.function_type, "PROCEDURE");
        assert!(procedure.definition.starts_with("CREATE "), "{}", procedure.definition);
        assert!(procedure.definition.contains("PROCEDURE"));
        assert!(!procedure.definition.contains("DEFINER"));
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
    }

    #[test]
    fn ignores_files_without_definitions() {
        let snapshot = parse_mysql_schema_sql_file("/*!40101 SET NAMES utf8 */;\nSELECT 1;\n", None);
        assert!(snapshot.is_empty());
        assert!(snapshot.functions.is_empty());
    }
}
