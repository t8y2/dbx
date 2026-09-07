use std::{
    collections::HashSet,
    ops::ControlFlow,
    sync::atomic::{AtomicBool, Ordering},
};

use hmac::{Hmac, Mac};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use sqlparser::ast::{
    visit_expressions, Expr, Ident, ObjectNamePart, SelectItem, SetExpr, Statement, TableFactor,
    WildcardAdditionalOptions,
};

use crate::{db::QueryResult, models::connection::DatabaseType};

mod source;
pub(crate) use source::query_has_unbound_database;
pub use source::{resolve_result_database, result_source_metadata, ResultSourceMetadata, ResultSourceMetadataRequest};

pub const POLICY_INVALID: &str =
    "MCP_RESULT_POLICY_INVALID: Invalid result protection policy; no query data was returned.";
pub const SOURCE_UNRESOLVED: &str = "MCP_RESULT_SOURCE_UNRESOLVED: Result protection cannot verify this query's column sources. Use direct columns from a base table, or review the documented name-only mode limits.";
pub const RESULT_DENIED: &str =
    "MCP_RESULT_DENIED: Result protection denied this response; no query data was returned.";
pub const QUERY_FAILED: &str =
    "MCP_RESULT_QUERY_FAILED: The operation failed. Database details are withheld by result protection.";
const MASK: &str = "[REDACTED]";
const MAX_RULES: usize = 100;
const MAX_DEPTH: usize = 32;
pub const AUDIT_LOG_TARGET: &str = module_path!();

// Driver tasks may outlive the request that created them. Once protection is
// used, keep diagnostic payloads out of this process's log sinks until restart.
static PRIVATE_DIAGNOSTICS: AtomicBool = AtomicBool::new(false);

pub fn activate_diagnostic_protection() {
    PRIVATE_DIAGNOSTICS.store(true, Ordering::Release);
}

pub fn diagnostic_log_allowed(target: &str) -> bool {
    !PRIVATE_DIAGNOSTICS.load(Ordering::Acquire) || target == AUDIT_LOG_TARGET
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultProtectionMode {
    #[default]
    Strict,
    NameOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultProtectionAction {
    Remove,
    Mask,
    Partial,
    Hash,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultProtectionRule {
    pub id: String,
    #[serde(default)]
    pub column_pattern: Option<String>,
    #[serde(default)]
    pub data_type_pattern: Option<String>,
    #[serde(default)]
    pub value_pattern: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    pub action: ResultProtectionAction,
    #[serde(default)]
    pub keep_prefix: usize,
    #[serde(default)]
    pub keep_suffix: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultProtectionSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: ResultProtectionMode,
    #[serde(default)]
    pub rules: Vec<ResultProtectionRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultProtectionOverride {
    pub connection_id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub settings: ResultProtectionSettings,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpResultProtectionPolicy {
    #[serde(default)]
    pub default: ResultProtectionSettings,
    #[serde(default)]
    pub overrides: Vec<ResultProtectionOverride>,
    #[serde(default)]
    pub hash_key: Option<String>,
}

impl std::fmt::Debug for McpResultProtectionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpResultProtectionPolicy")
            .field("default", &self.default)
            .field("overrides", &self.overrides)
            .field("has_hash_key", &self.hash_key.is_some())
            .finish()
    }
}

impl McpResultProtectionPolicy {
    pub fn any_enabled(&self) -> bool {
        self.default.enabled || self.overrides.iter().any(|rule| rule.settings.enabled)
    }

    pub fn has_database_overrides(&self, connection: &str) -> bool {
        self.overrides.iter().any(|rule| rule.connection_id == connection && rule.database.is_some())
    }

    pub fn protects_metadata(&self, connection: &str, database: &str) -> bool {
        self.has_database_overrides(connection) || self.effective(connection, database).enabled
    }

    pub fn effective(&self, connection: &str, database: &str) -> &ResultProtectionSettings {
        self.overrides
            .iter()
            .filter(|rule| rule.connection_id == connection)
            .find(|rule| rule.database.as_deref() == Some(database))
            .or_else(|| self.overrides.iter().find(|rule| rule.connection_id == connection && rule.database.is_none()))
            .map(|rule| &rule.settings)
            .unwrap_or(&self.default)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.overrides.len() > MAX_RULES {
            return Err(POLICY_INVALID.to_string());
        }
        compile_rules(&self.default, self.hash_key.as_deref())?;
        let mut scopes = HashSet::new();
        for rule in &self.overrides {
            if rule.connection_id.trim().is_empty()
                || rule.database.as_ref().is_some_and(|database| database.trim().is_empty())
                || !scopes
                    .insert((&rule.connection_id, rule.database.as_ref().map(|database| database.to_ascii_lowercase())))
            {
                return Err(POLICY_INVALID.to_string());
            }
            compile_rules(&rule.settings, self.hash_key.as_deref())?;
        }
        Ok(())
    }

    pub fn compile(&self, connection: &str, database: &str) -> Result<Option<ResultProtector>, String> {
        self.validate()?;
        let settings = self.effective(connection, database);
        if !settings.enabled {
            return Ok(None);
        }
        Ok(Some(ResultProtector {
            mode: settings.mode,
            rules: compile_rules(settings, self.hash_key.as_deref())?,
            hash_key: self.hash_key.clone().unwrap_or_default(),
        }))
    }
}

struct CompiledRule {
    rule: ResultProtectionRule,
    column: Option<Regex>,
    data_type: Option<Regex>,
    value: Option<Regex>,
}

fn compile_pattern(pattern: &Option<String>) -> Result<Option<Regex>, String> {
    pattern
        .as_ref()
        .map(|pattern| {
            if pattern.is_empty() || pattern.len() > 512 {
                return Err(POLICY_INVALID.to_string());
            }
            RegexBuilder::new(pattern)
                .case_insensitive(true)
                .size_limit(2 * 1024 * 1024)
                .build()
                .map_err(|_| POLICY_INVALID.to_string())
        })
        .transpose()
}

fn compile_rules(settings: &ResultProtectionSettings, hash_key: Option<&str>) -> Result<Vec<CompiledRule>, String> {
    if settings.rules.len() > MAX_RULES || (settings.enabled && settings.rules.is_empty()) {
        return Err(POLICY_INVALID.to_string());
    }
    let mut ids = HashSet::new();
    settings
        .rules
        .iter()
        .map(|rule| {
            if rule.id.is_empty()
                || rule.id.len() > 64
                || !rule.id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
                || !ids.insert(&rule.id)
                || (rule.column_pattern.is_none() && rule.data_type_pattern.is_none() && rule.value_pattern.is_none())
                || rule.keep_prefix > 32
                || rule.keep_suffix > 32
                || rule.schema.as_ref().is_some_and(|v| v.trim().is_empty())
                || rule.table.as_ref().is_some_and(|v| v.trim().is_empty())
                || (rule.action == ResultProtectionAction::Hash && hash_key.is_none_or(|key| key.len() < 32))
            {
                return Err(POLICY_INVALID.to_string());
            }
            Ok(CompiledRule {
                rule: rule.clone(),
                column: compile_pattern(&rule.column_pattern)?,
                data_type: compile_pattern(&rule.data_type_pattern)?,
                value: compile_pattern(&rule.value_pattern)?,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultSource {
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone)]
pub struct ResultProjection {
    pub source: Option<ResultSource>,
    // None means a sole, unmodified wildcard (or name-only fallback).
    columns: Option<Vec<String>>,
    expected_output_columns: Option<Vec<String>>,
    qualified_sql: Option<String>,
}

impl ResultProjection {
    pub fn verify_metadata(
        &mut self,
        tables: &[crate::types::TableInfo],
        columns: &[crate::types::ColumnInfo],
    ) -> Result<(), String> {
        let source = self.source.as_ref().ok_or_else(|| SOURCE_UNRESOLVED.to_string())?;
        let tables: Vec<_> = tables.iter().filter(|table| table.name.eq_ignore_ascii_case(&source.table)).collect();
        if tables.len() != 1
            || !matches!(tables[0].table_type.to_ascii_uppercase().as_str(), "TABLE" | "BASE TABLE")
            || columns.is_empty()
        {
            return Err(SOURCE_UNRESOLVED.to_string());
        }
        let selected: Vec<_> = match &self.columns {
            Some(names) => names
                .iter()
                .map(|name| {
                    let mut matches = columns.iter().filter(|column| column.name.eq_ignore_ascii_case(name));
                    let column = matches.next().ok_or_else(|| SOURCE_UNRESOLVED.to_string())?;
                    if matches.next().is_some() {
                        return Err(SOURCE_UNRESOLVED.to_string());
                    }
                    Ok(column)
                })
                .collect::<Result<_, _>>()?,
            None => columns.iter().collect(),
        };
        if selected.iter().any(|column| {
            column.extra.as_ref().is_some_and(|extra| {
                let extra = extra.to_ascii_lowercase();
                extra.contains("generated") || extra.contains("computed") || extra.contains("virtual")
            })
        }) {
            return Err(SOURCE_UNRESOLVED.to_string());
        }
        if self.columns.is_none() {
            let names: Vec<String> = columns.iter().map(|column| column.name.clone()).collect();
            self.expected_output_columns = Some(names.clone());
            self.columns = Some(names);
        }
        Ok(())
    }
}

pub struct ResultProtector {
    mode: ResultProtectionMode,
    rules: Vec<CompiledRule>,
    hash_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultProtectionHit {
    pub rule_id: String,
    pub column: String,
    pub action: ResultProtectionAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultProtectionPreview {
    pub policy: McpResultProtectionPolicy,
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub schema: String,
    #[serde(default)]
    pub table: String,
    pub column: String,
    pub data_type: String,
    pub value: Value,
}

pub fn preview_result_protection(request: ResultProtectionPreview) -> Result<Vec<ResultProtectionHit>, String> {
    let Some(protector) = request.policy.compile(&request.connection_id, &request.database)? else {
        return Ok(Vec::new());
    };
    let mut result: QueryResult = serde_json::from_value(serde_json::json!({
        "columns": [request.column], "column_types": [request.data_type], "rows": [[request.value]],
        "affected_rows": 0, "execution_time_ms": 0,
    }))
    .map_err(|_| RESULT_DENIED.to_string())?;
    let projection = ResultProjection {
        source: Some(ResultSource { schema: request.schema, table: request.table }),
        columns: None,
        expected_output_columns: None,
        qualified_sql: None,
    };
    // Only match metadata leaves this endpoint. Samples never enter audit logs.
    let mut hits = Vec::new();
    match protector.protect_with_hits(&mut result, &projection, &mut hits) {
        Ok(()) => Ok(hits),
        Err(error) if error == RESULT_DENIED && hits.iter().any(|hit| hit.action == ResultProtectionAction::Deny) => {
            Ok(hits)
        }
        Err(error) => Err(error),
    }
}

impl ResultProtector {
    pub fn is_strict(&self) -> bool {
        self.mode == ResultProtectionMode::Strict
    }

    pub fn projection(
        &self,
        sql: &str,
        db_type: DatabaseType,
        database: &str,
        schema: &str,
    ) -> Result<ResultProjection, String> {
        match direct_projection(sql, db_type, database, schema) {
            Ok(projection) if self.is_strict() && projection.qualified_sql.is_none() => {
                Err(SOURCE_UNRESOLVED.to_string())
            }
            Ok(projection) => Ok(projection),
            Err(_)
                if !self.is_strict()
                    && self.rules.iter().all(|r| r.rule.schema.is_none() && r.rule.table.is_none()) =>
            {
                Ok(ResultProjection { source: None, columns: None, expected_output_columns: None, qualified_sql: None })
            }
            Err(_) => Err(SOURCE_UNRESOLVED.to_string()),
        }
    }

    pub fn execution_sql<'a>(&self, projection: &'a ResultProjection, original: &'a str) -> &'a str {
        if self.is_strict() {
            projection.qualified_sql.as_deref().unwrap_or(original)
        } else {
            original
        }
    }

    pub fn protect(
        &self,
        result: &mut QueryResult,
        projection: &ResultProjection,
    ) -> Result<Vec<ResultProtectionHit>, String> {
        let mut hits = Vec::new();
        self.protect_with_hits(result, projection, &mut hits)?;
        Ok(hits)
    }

    fn protect_with_hits(
        &self,
        result: &mut QueryResult,
        projection: &ResultProjection,
        hits: &mut Vec<ResultProtectionHit>,
    ) -> Result<(), String> {
        if result.rows.iter().any(|row| row.len() != result.columns.len())
            || projection.columns.as_ref().is_some_and(|columns| columns.len() != result.columns.len())
            || projection.expected_output_columns.as_ref().is_some_and(|expected| {
                expected.iter().zip(&result.columns).any(|(expected, actual)| !expected.eq_ignore_ascii_case(actual))
            })
        {
            return Err(SOURCE_UNRESOLVED.to_string());
        }
        let mut retained = Vec::new();
        for (index, column) in result.columns.iter().enumerate() {
            let source_column = projection.columns.as_ref().map(|columns| columns[index].as_str()).unwrap_or(column);
            let data_type = result.column_types.get(index).map(String::as_str).filter(|value| !value.is_empty());
            let mut matches = Vec::new();
            for rule in &self.rules {
                if !rule.matches_column(column, source_column, data_type, projection.source.as_ref())? {
                    continue;
                }
                let matching_rows: Vec<usize> = result
                    .rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| rule.matches_value(&row[index]))
                    .map(|(row, _)| row)
                    .collect();
                if rule.value.is_some() && matching_rows.is_empty() {
                    continue;
                }
                push_hit(hits, &rule.rule, column);
                matches.push((rule, matching_rows));
            }
            // Evaluate against original values. An earlier mask must never
            // conceal a match from a later deny/remove rule.
            if matches.iter().any(|(rule, _)| rule.rule.action == ResultProtectionAction::Deny) {
                return Err(RESULT_DENIED.to_string());
            }
            if !matches.iter().any(|(rule, _)| rule.rule.action == ResultProtectionAction::Remove) {
                for (row_index, row) in result.rows.iter_mut().enumerate() {
                    if let Some((rule, _)) = matches.iter().find(|(_, rows)| rows.contains(&row_index)) {
                        row[index] = self.transform(&row[index], &rule.rule)?;
                    } else {
                        self.protect_json(&mut row[index], projection.source.as_ref(), hits, 0)?;
                    }
                }
                retained.push(index);
            }
        }
        result.columns = retained.iter().map(|&i| result.columns[i].clone()).collect();
        for row in &mut result.rows {
            *row = retained.iter().map(|&i| row[i].take()).collect();
        }
        // These side channels can contain values or indices into the original
        // result. The protected response deliberately contains only table data.
        result.column_types.clear();
        result.column_sortables.clear();
        result.spatial_columns.clear();
        result.spatial_values.clear();
        result.session_id = None;
        result.elasticsearch_raw_body = None;
        result.messages.clear();
        Ok(())
    }

    fn transform(&self, value: &Value, rule: &ResultProtectionRule) -> Result<Value, String> {
        if value.is_null() {
            return Ok(Value::Null);
        }
        let text = scalar_text(value);
        match rule.action {
            ResultProtectionAction::Mask => Ok(Value::String(MASK.to_string())),
            ResultProtectionAction::Partial => {
                if value.is_object()
                    || value.is_array()
                    || value.as_str().is_some_and(|text| text.trim_start().starts_with(['{', '[']))
                {
                    return Err(RESULT_DENIED.to_string());
                }
                let chars: Vec<char> = text.chars().collect();
                let masked = if chars.len() <= rule.keep_prefix + rule.keep_suffix {
                    MASK.to_string()
                } else {
                    let prefix: String = chars[..rule.keep_prefix].iter().collect();
                    let suffix: String = chars[chars.len() - rule.keep_suffix..].iter().collect();
                    format!("{prefix}***{suffix}")
                };
                Ok(Value::String(masked))
            }
            ResultProtectionAction::Hash => {
                let mut mac =
                    Hmac::<Sha256>::new_from_slice(self.hash_key.as_bytes()).map_err(|_| POLICY_INVALID.to_string())?;
                mac.update(text.as_bytes());
                let digest = mac.finalize().into_bytes();
                Ok(Value::String(format!("hmac-sha256:{digest:x}")))
            }
            ResultProtectionAction::Deny => Err(RESULT_DENIED.to_string()),
            ResultProtectionAction::Remove => Ok(Value::Null),
        }
    }

    fn protect_json(
        &self,
        value: &mut Value,
        source: Option<&ResultSource>,
        hits: &mut Vec<ResultProtectionHit>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(RESULT_DENIED.to_string());
        }
        if let Value::String(text) = value {
            if text.trim_start().starts_with(['{', '[']) {
                match serde_json::from_str::<Value>(text) {
                    Ok(mut json) if json.is_object() || json.is_array() => {
                        self.protect_json(&mut json, source, hits, depth + 1)?;
                        *text = serde_json::to_string(&json).map_err(|_| RESULT_DENIED.to_string())?;
                    }
                    Err(_) if self.is_strict() => return Err(RESULT_DENIED.to_string()),
                    _ => {}
                }
            }
            return Ok(());
        }
        match value {
            Value::Object(object) => {
                let mut removed = Vec::new();
                for (key, value) in object.iter_mut() {
                    let mut matching = Vec::new();
                    for rule in &self.rules {
                        if rule.matches_column(key, key, Some(json_type(value)), source)? && rule.matches_value(value) {
                            push_hit(hits, &rule.rule, key);
                            matching.push(rule);
                        }
                    }
                    if matching.iter().any(|rule| rule.rule.action == ResultProtectionAction::Deny) {
                        return Err(RESULT_DENIED.to_string());
                    }
                    if matching.iter().any(|rule| rule.rule.action == ResultProtectionAction::Remove) {
                        removed.push(key.clone());
                    } else if let Some(rule) = matching.first() {
                        *value = self.transform(value, &rule.rule)?;
                    } else {
                        self.protect_json(value, source, hits, depth + 1)?;
                    }
                }
                for key in removed {
                    object.remove(&key);
                }
            }
            Value::Array(values) => {
                for value in values {
                    // Value-only rules also cover scalar array elements.
                    let mut matching = Vec::new();
                    for rule in &self.rules {
                        if rule.column.is_none()
                            && rule.matches_column("", "", Some(json_type(value)), source)?
                            && rule.matches_value(value)
                        {
                            matching.push(rule);
                        }
                    }
                    if matching.iter().any(|rule| rule.rule.action == ResultProtectionAction::Deny) {
                        return Err(RESULT_DENIED.to_string());
                    }
                    if matching.iter().any(|rule| rule.rule.action == ResultProtectionAction::Remove) {
                        *value = Value::Null;
                    } else if let Some(rule) = matching.first() {
                        *value = self.transform(value, &rule.rule)?;
                    } else {
                        self.protect_json(value, source, hits, depth + 1)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

impl CompiledRule {
    fn matches_column(
        &self,
        output: &str,
        source_column: &str,
        data_type: Option<&str>,
        source: Option<&ResultSource>,
    ) -> Result<bool, String> {
        if let Some(schema) = &self.rule.schema {
            let source = source.ok_or_else(|| SOURCE_UNRESOLVED.to_string())?;
            if source.schema.is_empty() {
                return Err(SOURCE_UNRESOLVED.to_string());
            }
            if !schema.eq_ignore_ascii_case(&source.schema) {
                return Ok(false);
            }
        }
        if let Some(table) = &self.rule.table {
            let source = source.ok_or_else(|| SOURCE_UNRESOLVED.to_string())?;
            if !table.eq_ignore_ascii_case(&source.table) {
                return Ok(false);
            }
        }
        if self.column.as_ref().is_some_and(|pattern| !pattern.is_match(output) && !pattern.is_match(source_column)) {
            return Ok(false);
        }
        if let Some(pattern) = &self.data_type {
            let data_type = data_type.ok_or_else(|| SOURCE_UNRESOLVED.to_string())?;
            if !pattern.is_match(data_type) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn matches_value(&self, value: &Value) -> bool {
        self.value.as_ref().is_none_or(|pattern| !value.is_null() && pattern.is_match(&scalar_text(value)))
    }
}

fn scalar_text(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn push_hit(hits: &mut Vec<ResultProtectionHit>, rule: &ResultProtectionRule, column: &str) {
    let hit = ResultProtectionHit { rule_id: rule.id.clone(), column: column.to_string(), action: rule.action };
    if !hits.contains(&hit) {
        hits.push(hit);
    }
}

pub fn audit_hits(connection: &str, database: &str, hits: &[ResultProtectionHit]) {
    // Do not log SQL, cell values, JSON keys, or driver-generated column labels.
    // Rule IDs are validated identifiers; counts suffice for operational logs.
    for hit in hits {
        log::info!(
            "MCP result protection connection={connection:?} database={database:?} rule={} action={:?}",
            hit.rule_id,
            hit.action
        );
    }
}

fn direct_projection(sql: &str, db_type: DatabaseType, database: &str, schema: &str) -> Result<ResultProjection, ()> {
    if sql.contains("/*!") || sql.to_ascii_uppercase().contains("/*M!") {
        return Err(());
    }
    let statements = crate::sql_risk::parse_sql_for_result_protection(sql, db_type)?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return Err(());
    };
    if query.with.is_some() {
        return Err(());
    }
    // Subqueries can hide protected origins in an otherwise direct projection.
    if visit_expressions(query.as_ref(), |expr| {
        if matches!(expr, Expr::Subquery(_) | Expr::Exists { .. } | Expr::InSubquery { .. }) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .is_break()
    {
        return Err(());
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err(());
    };
    if select.into.is_some() || select.from.len() != 1 {
        return Err(());
    }
    let relation = &select.from[0];
    if !relation.joins.is_empty() {
        return Err(());
    }
    let TableFactor::Table { name, alias, args, .. } = &relation.relation else {
        return Err(());
    };
    if args.is_some() || alias.as_ref().is_some_and(|alias| !alias.columns.is_empty()) {
        return Err(());
    }
    let parts: Vec<&str> = name
        .0
        .iter()
        .map(|part| part.as_ident().map(|ident| ident.value.as_str()).ok_or(()))
        .collect::<Result<_, _>>()?;
    let schema_aware = crate::sql_dialect::is_schema_aware(db_type);
    let schema = if !schema_aware {
        database
    } else if schema.is_empty() && db_type == DatabaseType::Sqlite {
        "main"
    } else {
        schema
    };
    let (source_schema, table) = match parts.as_slice() {
        [table] => (schema, *table),
        [qualifier, table] if schema_aware => (*qualifier, *table),
        [qualifier, table] if qualifier.eq_ignore_ascii_case(database) => (schema, *table),
        [catalog, source_schema, table] if schema_aware && catalog.eq_ignore_ascii_case(database) => {
            (*source_schema, *table)
        }
        _ => return Err(()),
    };
    let qualifier = alias.as_ref().map(|alias| alias.name.value.as_str()).unwrap_or(table);
    let mut columns = Vec::new();
    let mut wildcard = false;
    for projection in &select.projection {
        let expression = match projection {
            SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } => expr,
            SelectItem::Wildcard(options) if *options == WildcardAdditionalOptions::default() => {
                wildcard = true;
                continue;
            }
            // Qualified wildcards and wildcard modifiers are intentionally
            // rejected until their complete expansion can be verified.
            _ => return Err(()),
        };
        let column = match expression {
            Expr::Identifier(ident) => &ident.value,
            Expr::CompoundIdentifier(parts) if parts.len() == 2 && parts[0].value.eq_ignore_ascii_case(qualifier) => {
                &parts[1].value
            }
            _ => return Err(()),
        };
        columns.push(column.clone());
    }
    if wildcard && select.projection.len() != 1 {
        return Err(());
    }
    let qualified_sql = if source_schema.is_empty() {
        None
    } else {
        let quote = match db_type {
            DatabaseType::Mysql => '`',
            DatabaseType::SqlServer => '[',
            _ => '"',
        };
        let original_table = name.0.last().ok_or(())?.clone();
        let mut statement = statements[0].clone();
        let Statement::Query(query) = &mut statement else {
            return Err(());
        };
        let SetExpr::Select(select) = query.body.as_mut() else {
            return Err(());
        };
        let TableFactor::Table { name, .. } = &mut select.from[0].relation else {
            return Err(());
        };
        name.0 = vec![ObjectNamePart::Identifier(Ident::with_quote(quote, source_schema)), original_table];
        let qualified_sql = statement.to_string();
        // Rendering must not change escaped identifiers or introduce SQL from
        // the configured schema (notably SQL Server bracket identifiers).
        let reparsed = crate::sql_risk::parse_sql_for_result_protection(&qualified_sql, db_type)?;
        if reparsed.as_slice() != std::slice::from_ref(&statement) {
            return Err(());
        }
        Some(qualified_sql)
    };
    Ok(ResultProjection {
        source: Some(ResultSource { schema: source_schema.to_string(), table: table.to_string() }),
        columns: (!wildcard).then_some(columns),
        expected_output_columns: None,
        qualified_sql,
    })
}

#[cfg(test)]
mod tests;
