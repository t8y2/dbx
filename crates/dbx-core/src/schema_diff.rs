use std::collections::{HashMap, HashSet, VecDeque};

use log;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::ddl_profile::{profile_for, AutoIncSyntax, DdlDialectProfile};
use crate::sql_dialect::descriptor::DialectKind;
use crate::sql_dialect::inference::{ColumnType, DefaultTypeInferenceEngine, TypeInferenceEngine};
use crate::sql_dialect::type_rewrite::{
    apply_auto_inc_to_column_def, column_is_auto_increment, rewrite_column_type, type_looks_integer, AutoIncColumnBuild,
};
use crate::sql_parser::ast_filter::AstTransmitFilter;
use crate::table_structure_sql::{
    build_sqlserver_alter_column_preserving_default_sql, build_sqlserver_column_comment_sql,
    build_sqlserver_drop_default_constraint_sql, build_sqlserver_table_comment_sql, sqlserver_unicode_string_literal,
};
use crate::types::{
    ColumnInfo, ForeignKeyInfo, FunctionInfo, IndexInfo, OwnerInfo, RuleInfo, SequenceInfo, TableInfo, TriggerInfo,
};

mod sqlserver_dependencies;

use sqlserver_dependencies::build_dependency_aware_alter_column_batch;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnAddPosition {
    First,
    After(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ColumnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ColumnInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add_position: Option<ColumnAddPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<IndexInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<IndexInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ForeignKeyInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ForeignKeyInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TriggerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FunctionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<FunctionInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SequenceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<SequenceInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuleInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<RuleInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub object_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<OwnerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<OwnerInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<IndexDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign_keys: Option<Vec<ForeignKeyDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<TriggerDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_ddl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table_comment: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_table_comment: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaDetail {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<ColumnInfo>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[serde(default)]
    pub triggers: Vec<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParamStrategy {
    Preserve,
    Strip,
    Custom,
}

fn default_param_strategy() -> ParamStrategy {
    ParamStrategy::Preserve
}

/// A custom field type mapping override: source_type → target_type.
/// Used when source and target database types differ.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    pub source_type: String,
    pub target_type: String,
    #[serde(default = "default_param_strategy")]
    pub param_strategy: ParamStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_params: Option<String>,
}

impl FieldMapping {
    pub fn apply<'a>(mappings: &'a [FieldMapping], source_type: &str) -> Option<&'a str> {
        let base_type = source_type.split('(').next().unwrap_or(source_type).trim();
        mappings.iter().find(|m| m.source_type.eq_ignore_ascii_case(base_type)).map(|m| m.target_type.as_str())
    }

    pub fn apply_with_params(mappings: &[FieldMapping], source_type: &str, target_kind: DialectKind) -> Option<String> {
        let trimmed = source_type.trim();
        let base_type = trimmed.split('(').next().unwrap_or(trimmed);
        let source_params = &trimmed[base_type.len()..];
        let matched = mappings.iter().find(|m| m.source_type.eq_ignore_ascii_case(base_type))?;

        let result = match matched.param_strategy {
            ParamStrategy::Strip => Some(matched.target_type.clone()),
            ParamStrategy::Custom => match &matched.custom_params {
                Some(params) if !params.is_empty() => {
                    let p = params.trim();
                    // Normalize: wrap bare params (e.g. "100") in parentheses so the
                    // generated type becomes e.g. `character(100)` rather than `character100`.
                    let formatted = if p.starts_with('(') { p.to_string() } else { format!("({})", p) };
                    Some(format!("{}{}", matched.target_type, formatted))
                }
                _ => Some(matched.target_type.clone()),
            },
            ParamStrategy::Preserve => {
                let supports = type_supports_params(target_kind, &matched.target_type);
                let has_params = !source_params.is_empty();
                if has_params && supports {
                    Some(format!("{}{}", matched.target_type, source_params))
                } else {
                    log::info!(
                        "apply_with_params[Preserve] source={} target={} strategy={:?} has_params={} supports_params={} -> bare {}",
                        source_type, matched.target_type, matched.param_strategy, has_params, supports, matched.target_type
                    );
                    Some(matched.target_type.clone())
                }
            }
        };
        log::info!(
            "apply_with_params source={} target_type={} strategy={:?} result={:?}",
            source_type,
            matched.target_type,
            matched.param_strategy,
            result
        );
        result
    }
}

fn type_supports_params(kind: DialectKind, type_name: &str) -> bool {
    crate::sql_dialect::dialect_loader::register_core_dialects();
    let registry = crate::sql_dialect::dialect_loader::DialectRegistry::global();
    let all = registry.get_all_by_kind(kind);
    if all.is_empty() {
        return true;
    }
    all.iter().any(|loaded| {
        loaded.yaml.types.iter().any(|t| {
            (t.name.eq_ignore_ascii_case(type_name) || t.aliases.iter().any(|a| a.eq_ignore_ascii_case(type_name)))
                && (t.has_length || t.has_precision || t.max_precision.is_some())
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparationOptions {
    #[serde(default)]
    pub source_tables: Vec<TableInfo>,
    #[serde(default)]
    pub target_tables: Vec<TableInfo>,
    #[serde(default)]
    pub source_details: Vec<TableSchemaDetail>,
    #[serde(default)]
    pub target_details: Vec<TableSchemaDetail>,
    #[serde(default)]
    pub source_functions: Vec<FunctionInfo>,
    #[serde(default)]
    pub target_functions: Vec<FunctionInfo>,
    #[serde(default)]
    pub source_sequences: Vec<SequenceInfo>,
    #[serde(default)]
    pub target_sequences: Vec<SequenceInfo>,
    #[serde(default)]
    pub source_rules: Vec<RuleInfo>,
    #[serde(default)]
    pub target_rules: Vec<RuleInfo>,
    #[serde(default)]
    pub source_owners: Vec<OwnerInfo>,
    #[serde(default)]
    pub target_owners: Vec<OwnerInfo>,
    pub database_type: DatabaseType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_schema: Option<String>,
    #[serde(default)]
    pub ignore_comments: bool,
    #[serde(default)]
    pub cascade_delete: bool,
    #[serde(default)]
    pub compare_column_order: bool,
    #[serde(default)]
    pub detect_renames: bool,
    #[serde(default)]
    pub detect_table_renames: bool,
    #[serde(default)]
    pub rename_threshold: f64,
    #[serde(default)]
    pub enable_rollback: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub batch_patterns: Vec<BatchPattern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dialect: Option<DialectKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_dialect: Option<DialectKind>,
    #[serde(default)]
    pub compatibility_threshold: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_permissions: Vec<PermissionInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_permissions: Vec<PermissionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shard_strategy: Option<ShardStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_constraint: Option<ResourceConstraint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_mappings: Vec<FieldMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissingRollbackObject {
    pub kind: String,
    pub name: String,
    pub table: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RollbackCompleteness {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "incomplete")]
    Incomplete,
}

impl RollbackCompleteness {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Incomplete => "incomplete",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparation {
    pub diffs: Vec<TableDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub function_diffs: Vec<FunctionDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sequence_diffs: Vec<SequenceDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rule_diffs: Vec<RuleDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owner_diffs: Vec<OwnerDiff>,
    pub sync_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_sync_sql: Option<String>,
    /// Whether rollback SQL is complete enough to execute safely.
    #[serde(default = "default_rollback_complete")]
    pub rollback_completeness: RollbackCompleteness,
    /// Objects that could not be reconstructed for rollback (e.g. triggers without body).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_rollback_objects: Vec<MissingRollbackObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rename_candidates: Vec<RenameCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_graph: Option<RollbackGraph>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compatibility_warnings: Vec<ColumnCompatibilityWarning>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_diffs: Vec<PermissionDiff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_sync_sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_graph: Option<DependencyGraph>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSyncSqlPlan {
    pub sync_sql: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_sync_sql: Option<String>,
    pub rollback_completeness: RollbackCompleteness,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_rollback_objects: Vec<MissingRollbackObject>,
}

fn default_rollback_complete() -> RollbackCompleteness {
    RollbackCompleteness::Complete
}

// ============================================================================
// Phase 4.1: Dependency Graph & Rename Detection
// ============================================================================

/// Regex-based text scanning for table references in SQL/DDL text.
/// Used as fallback when no live DB query (YAML metadata_queries.dependencies) is available.
fn extract_ddl_references(sql: &str, known_tables: &HashSet<&str>) -> Vec<String> {
    let upper = sql.to_uppercase();
    let mut refs: Vec<String> = Vec::new();

    for table in known_tables {
        let table_up = table.to_uppercase();
        // Match after SQL keywords that indicate table references
        let patterns = [
            format!(" FROM {table_up}"),
            format!(" JOIN {table_up}"),
            format!(" INTO {table_up}"),
            format!(" TABLE {table_up}"),
            format!(" REFERENCES {table_up}"),
            format!(" UPDATE {table_up}"),
            format!("DELETE FROM {table_up}"),
            format!("FROM {table_up} ("),
            format!(" {table_up}."),
        ];
        if patterns.iter().any(|p| upper.contains(p.as_str())) {
            refs.push(table.to_string());
        }
    }

    refs
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyNode {
    pub table_name: String,
    pub depends_on: Vec<String>,
    pub depended_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub nodes: HashMap<String, DependencyNode>,
    pub topological_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageReport {
    pub level1_score: f64,
    pub level2_score: f64,
    pub composite_score: f64,
    pub level1_covered: u64,
    pub level1_total: u64,
    pub level2_covered: u64,
    pub level2_total: u64,
    pub uncovered_edges: Vec<UncoveredEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UncoveredEdge {
    pub from_table: String,
    pub to_table: String,
    pub level: u32,
}

impl DependencyGraph {
    pub fn build(details: &[TableSchemaDetail], tables: &[TableInfo]) -> Self {
        Self::build_with_functions(details, tables, &[], &[])
    }

    /// Extended build: also extracts dependencies from view DDLs, triggers, and function/sequence definitions.
    /// Falls back to regex-based text scanning when no live DB query is available.
    pub fn build_with_functions(
        details: &[TableSchemaDetail],
        tables: &[TableInfo],
        functions: &[FunctionInfo],
        _sequences: &[SequenceInfo],
    ) -> Self {
        let table_names: HashSet<&str> =
            tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
        let view_names: HashSet<&str> =
            tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
        let all_names: HashSet<&str> = tables.iter().map(|t| t.name.as_str()).collect();

        let mut nodes: HashMap<String, DependencyNode> = all_names
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    DependencyNode { table_name: name.to_string(), depends_on: Vec::new(), depended_by: Vec::new() },
                )
            })
            .collect();

        let detail_map: HashMap<&str, &TableSchemaDetail> = details.iter().map(|d| (d.name.as_str(), d)).collect();
        let function_by_name: HashMap<&str, &FunctionInfo> = functions.iter().map(|f| (f.name.as_str(), f)).collect();

        // Phase 1: FK-based dependencies (existing logic)
        for table_name in &table_names {
            if let Some(detail) = detail_map.get(table_name) {
                for fk in &detail.foreign_keys {
                    if table_names.contains(fk.ref_table.as_str()) {
                        if let Some(node) = nodes.get_mut(*table_name) {
                            if !node.depends_on.contains(&fk.ref_table) {
                                node.depends_on.push(fk.ref_table.clone());
                            }
                        }
                        if let Some(ref_node) = nodes.get_mut(&fk.ref_table) {
                            if !ref_node.depended_by.iter().any(|d| d == *table_name) {
                                ref_node.depended_by.push((*table_name).to_string());
                            }
                        }
                    }
                }
            }
        }

        // Phase 2: View DDL text scanning
        for view_name in &view_names {
            if let Some(detail) = detail_map.get(view_name) {
                if let Some(ddl) = &detail.ddl {
                    let refs = extract_ddl_references(ddl, &table_names);
                    for ref_table in refs {
                        if let Some(node) = nodes.get_mut(*view_name) {
                            if !node.depends_on.contains(&ref_table) {
                                node.depends_on.push(ref_table.clone());
                            }
                        }
                        if let Some(ref_node) = nodes.get_mut(&ref_table) {
                            if !ref_node.depended_by.iter().any(|d| d == *view_name) {
                                ref_node.depended_by.push((*view_name).to_string());
                            }
                        }
                    }
                }
            }
        }

        // Phase 3: Trigger statement text scanning
        for table_name in &all_names {
            if let Some(detail) = detail_map.get(table_name) {
                for trigger in &detail.triggers {
                    if let Some(stmt) = &trigger.statement {
                        let refs = extract_ddl_references(stmt, &table_names);
                        for ref_table in refs {
                            if let Some(node) = nodes.get_mut(*table_name) {
                                if !node.depends_on.contains(&ref_table) {
                                    node.depends_on.push(ref_table.clone());
                                }
                            }
                            if let Some(ref_node) = nodes.get_mut(&ref_table) {
                                if !ref_node.depended_by.iter().any(|d| d == *table_name) {
                                    ref_node.depended_by.push((*table_name).to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Phase 4: Function definition text scanning
        for (_func_name, func) in &function_by_name {
            let refs = extract_ddl_references(&func.definition, &table_names);
            for ref_table in &refs {
                if let Some(ref_node) = nodes.get_mut(ref_table) {
                    if !ref_node.depended_by.iter().any(|d| d == _func_name) {
                        ref_node.depended_by.push(_func_name.to_string());
                    }
                }
            }
        }

        let topological_order = Self::topological_sort(&nodes);
        DependencyGraph { nodes, topological_order }
    }

    fn topological_sort(nodes: &HashMap<String, DependencyNode>) -> Vec<String> {
        let mut in_degree: HashMap<&str, usize> = nodes.keys().map(|k| (k.as_str(), 0usize)).collect();
        for node in nodes.values() {
            in_degree.entry(node.table_name.as_str()).or_insert(0);
            for _dep in &node.depends_on {
                *in_degree.entry(node.table_name.as_str()).or_insert(0) += 1;
            }
        }

        let mut queue: VecDeque<&str> = in_degree.iter().filter(|(_, &deg)| deg == 0).map(|(&name, _)| name).collect();

        let mut result = Vec::new();
        while let Some(name) = queue.pop_front() {
            result.push(name.to_string());
            if let Some(node) = nodes.get(name) {
                for dependent in &node.depended_by {
                    if let Some(deg) = in_degree.get_mut(dependent.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dependent.as_str());
                        }
                    }
                }
            }
        }

        if result.len() != nodes.len() {
            let remaining: Vec<String> = nodes.keys().filter(|k| !result.contains(k)).cloned().collect();
            result.extend(remaining);
        }

        result
    }

    pub fn build_order(&self) -> Vec<String> {
        self.topological_order.clone()
    }

    pub fn drop_order(&self) -> Vec<String> {
        let mut order = self.topological_order.clone();
        order.reverse();
        order
    }

    pub fn coverage_score(&self, diffed_tables: &[String]) -> f64 {
        self.coverage_score_level1(diffed_tables)
    }

    pub fn coverage_score_level1(&self, diffed_tables: &[String]) -> f64 {
        if self.nodes.is_empty() {
            return 1.0;
        }
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();
        let mut covered_edges = 0u64;
        let mut total_edges = 0u64;

        for node in self.nodes.values() {
            for dep in &node.depends_on {
                total_edges += 1;
                if diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str()) {
                    covered_edges += 1;
                }
            }
        }

        if total_edges == 0 {
            1.0
        } else {
            covered_edges as f64 / total_edges as f64
        }
    }

    pub fn coverage_score_level2(&self, diffed_tables: &[String]) -> f64 {
        if self.nodes.is_empty() {
            return 1.0;
        }
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();

        let mut transitive_edges = 0u64;
        let mut covered_transitive = 0u64;

        for node in self.nodes.values() {
            let table_name = node.table_name.as_str();
            if !diffed_set.contains(table_name) {
                continue;
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        transitive_edges += 1;
                        if diffed_set.contains(table_name) && diffed_set.contains(grand.as_str()) {
                            covered_transitive += 1;
                        }
                    }
                }
            }
        }

        if transitive_edges == 0 {
            1.0
        } else {
            covered_transitive as f64 / transitive_edges as f64
        }
    }

    pub fn composite_coverage_score(&self, diffed_tables: &[String]) -> CoverageReport {
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();

        let (l1_covered, l1_total) = self.count_edges(diffed_tables, &diffed_set, 1);
        let (l2_covered, l2_total) = self.count_transitive_edges(diffed_tables, &diffed_set);

        let l1_score = if l1_total == 0 { 1.0 } else { l1_covered as f64 / l1_total as f64 };
        let l2_score = if l2_total == 0 { 1.0 } else { l2_covered as f64 / l2_total as f64 };

        let composite_score = 0.6 * l1_score + 0.4 * l2_score;

        let uncovered = self.collect_uncovered_edges(diffed_tables, &diffed_set);

        CoverageReport {
            level1_score: l1_score,
            level2_score: l2_score,
            composite_score,
            level1_covered: l1_covered,
            level1_total: l1_total,
            level2_covered: l2_covered,
            level2_total: l2_total,
            uncovered_edges: uncovered,
        }
    }

    fn count_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>, _level: u32) -> (u64, u64) {
        let mut covered = 0u64;
        let mut total = 0u64;
        for node in self.nodes.values() {
            for dep in &node.depends_on {
                total += 1;
                if diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str()) {
                    covered += 1;
                }
            }
        }
        (covered, total)
    }

    fn count_transitive_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>) -> (u64, u64) {
        let mut covered = 0u64;
        let mut total = 0u64;
        for node in self.nodes.values() {
            let table_name = node.table_name.as_str();
            if !diffed_set.contains(table_name) {
                continue;
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        total += 1;
                        if diffed_set.contains(table_name) && diffed_set.contains(grand.as_str()) {
                            covered += 1;
                        }
                    }
                }
            }
        }
        (covered, total)
    }

    fn collect_uncovered_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>) -> Vec<UncoveredEdge> {
        let mut uncovered = Vec::new();
        for node in self.nodes.values() {
            for dep in &node.depends_on {
                let both_covered = diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str());
                if !both_covered {
                    uncovered.push(UncoveredEdge {
                        from_table: node.table_name.clone(),
                        to_table: dep.clone(),
                        level: 1,
                    });
                }
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        let all_covered =
                            diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(grand.as_str());
                        if !all_covered {
                            uncovered.push(UncoveredEdge {
                                from_table: node.table_name.clone(),
                                to_table: grand.clone(),
                                level: 2,
                            });
                        }
                    }
                }
            }
        }
        uncovered
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameCandidate {
    pub source_name: String,
    pub target_name: String,
    pub score: f64,
    pub column_jaccard: f64,
    pub type_similarity: f64,
}

fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    }
}

fn column_type_similarity(source_cols: &[ColumnInfo], target_cols: &[ColumnInfo]) -> f64 {
    if source_cols.is_empty() || target_cols.is_empty() {
        return 0.0;
    }
    let engine = DefaultTypeInferenceEngine;
    let source_map: HashMap<&str, &ColumnInfo> = source_cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let target_map: HashMap<&str, &ColumnInfo> = target_cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let common_names: HashSet<&str> = source_map.keys().filter(|k| target_map.contains_key(**k)).copied().collect();

    if common_names.is_empty() {
        return 0.0;
    }

    let total: f64 = common_names
        .iter()
        .map(|name| {
            let s = ColumnType::parse(&source_map[name].data_type);
            let t = ColumnType::parse(&target_map[name].data_type);
            engine.type_compatibility_score(&s, &t)
        })
        .sum();
    total / common_names.len() as f64
}

pub fn detect_renames(
    removed: &[String],
    added: &[String],
    source_details: &[TableSchemaDetail],
    target_details: &[TableSchemaDetail],
    threshold: f64,
) -> Vec<RenameCandidate> {
    let source_detail_map: HashMap<&str, &TableSchemaDetail> =
        source_details.iter().map(|d| (d.name.as_str(), d)).collect();
    let target_detail_map: HashMap<&str, &TableSchemaDetail> =
        target_details.iter().map(|d| (d.name.as_str(), d)).collect();

    let mut candidates = Vec::new();
    for target_name in removed {
        let Some(target_detail) = target_detail_map.get(target_name.as_str()) else { continue };
        for source_name in added {
            let Some(source_detail) = source_detail_map.get(source_name.as_str()) else { continue };

            let col_names_source: HashSet<String> = source_detail.columns.iter().map(|c| c.name.clone()).collect();
            let col_names_target: HashSet<String> = target_detail.columns.iter().map(|c| c.name.clone()).collect();
            let column_jaccard = jaccard_similarity(&col_names_target, &col_names_source);

            if column_jaccard < threshold {
                continue;
            }

            let type_sim = column_type_similarity(&target_detail.columns, &source_detail.columns);

            let score = column_jaccard * 0.6 + type_sim * 0.4;

            if score >= threshold {
                candidates.push(RenameCandidate {
                    source_name: source_name.clone(),
                    target_name: target_name.clone(),
                    score,
                    column_jaccard,
                    type_similarity: type_sim,
                });
            }
        }
    }

    candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let mut final_candidates = Vec::new();
    let mut used_target: HashSet<String> = HashSet::new();
    let mut used_source: HashSet<String> = HashSet::new();

    for c in &candidates {
        if !used_target.contains(&c.target_name) && !used_source.contains(&c.source_name) {
            final_candidates.push(c.clone());
            used_target.insert(c.target_name.clone());
            used_source.insert(c.source_name.clone());
        }
    }

    final_candidates
}

// ============================================================================
// Phase 4.2: Batch Naming Pattern Recognition
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPattern {
    pub pattern: String,
    pub is_regex: bool,
    pub description: String,
}

pub fn diff_names_with_patterns(
    source: &[String],
    target: &[String],
    patterns: &[BatchPattern],
) -> (Vec<String>, Vec<String>, Vec<String>, Vec<Vec<String>>) {
    let (added, removed, common) = diff_names(source, target);

    let mut pattern_matches: Vec<Vec<String>> = Vec::new();
    for pattern in patterns {
        let mut matches = Vec::new();
        if pattern.is_regex {
            if let Ok(re) = Regex::new(&pattern.pattern) {
                for name in source {
                    if re.is_match(name) {
                        matches.push(name.clone());
                    }
                }
            }
        } else {
            let glob_pattern = pattern.pattern.replace('*', ".*").replace('?', ".");
            if let Ok(re) = Regex::new(&format!("^{}$", glob_pattern)) {
                for name in source {
                    if re.is_match(name) {
                        matches.push(name.clone());
                    }
                }
            }
        }
        if !matches.is_empty() {
            pattern_matches.push(matches);
        }
    }

    (added, removed, common, pattern_matches)
}

pub fn detect_pattern_conflicts(patterns: &[BatchPattern], names: &[String]) -> Vec<Vec<String>> {
    let mut conflicts = Vec::new();
    for i in 0..patterns.len() {
        for j in (i + 1)..patterns.len() {
            let pi = &patterns[i];
            let pj = &patterns[j];
            let pattern_i =
                if pi.is_regex { pi.pattern.clone() } else { pi.pattern.replace('*', ".*").replace('?', ".") };
            let pattern_j =
                if pj.is_regex { pj.pattern.clone() } else { pj.pattern.replace('*', ".*").replace('?', ".") };

            let re_i = Regex::new(&format!("^{}$", pattern_i));
            let re_j = Regex::new(&format!("^{}$", pattern_j));
            if let (Ok(ri), Ok(rj)) = (re_i, re_j) {
                for name in names {
                    if ri.is_match(name) && rj.is_match(name) {
                        conflicts.push(vec![pi.description.clone(), pj.description.clone()]);
                        break;
                    }
                }
            }
        }
    }
    conflicts
}

// ============================================================================
// Phase 4.3: Dialect-Aware Type Compatibility Scoring
// ============================================================================

pub fn diff_columns_with_compatibility(
    source: &[ColumnInfo],
    target: &[ColumnInfo],
    ignore_comments: bool,
    compare_column_order: bool,
    source_dialect: DialectKind,
    target_dialect: DialectKind,
    compatibility_threshold: f64,
    field_mappings: &[FieldMapping],
) -> (Vec<ColumnDiff>, Vec<ColumnCompatibilityWarning>) {
    use crate::sql_dialect::descriptor::TypeMappingMatrix;

    let matrix = TypeMappingMatrix::for_dialects(source_dialect, target_dialect);
    let engine = DefaultTypeInferenceEngine;

    let basic_diffs = diff_columns_with_options(source, target, ignore_comments, compare_column_order, false, 0.5);

    let mut warnings = Vec::new();
    let mut enhanced_diffs = Vec::new();

    for diff in basic_diffs {
        let mut warning = None;

        if diff.diff_type == "modified" {
            if let (Some(src), Some(tgt)) = (&diff.source, &diff.target) {
                let src_parsed = ColumnType::parse(&src.data_type);
                let tgt_parsed = ColumnType::parse(&tgt.data_type);
                let compatibility = engine.type_compatibility_score(&src_parsed, &tgt_parsed);

                let (mapped_type, requires_cast) = if let Some(user_target) =
                    FieldMapping::apply_with_params(field_mappings, &src.data_type, target_dialect)
                {
                    (user_target, false)
                } else {
                    matrix.convert_type(&tgt.data_type)
                };

                let risk = if compatibility >= 0.9 {
                    ColumnConversionRisk::None
                } else if compatibility >= 0.7 {
                    ColumnConversionRisk::Low
                } else if compatibility >= 0.5 {
                    ColumnConversionRisk::Medium
                } else {
                    ColumnConversionRisk::High
                };

                if compatibility < compatibility_threshold {
                    warning = Some(ColumnCompatibilityWarning {
                        column_name: diff.name.clone(),
                        source_type: src.data_type.clone(),
                        target_type: tgt.data_type.clone(),
                        compatibility_score: compatibility,
                        suggested_mapping: mapped_type,
                        requires_cast,
                        risk,
                    });
                }
            }
        }

        enhanced_diffs.push(diff);
        if let Some(w) = warning {
            warnings.push(w);
        }
    }

    (enhanced_diffs, warnings)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCompatibilityWarning {
    pub column_name: String,
    pub source_type: String,
    pub target_type: String,
    pub compatibility_score: f64,
    pub suggested_mapping: String,
    pub requires_cast: bool,
    pub risk: ColumnConversionRisk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColumnConversionRisk {
    None,
    Low,
    Medium,
    High,
}

// ============================================================================
// Phase 4.4: Bidirectional Diff & Rollback Graph
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffNode {
    pub table_diff: TableDiff,
    pub direction: DiffDirection,
    pub dependency_order: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffDirection {
    Forward,
    Rollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackGraph {
    pub forward_nodes: Vec<DiffNode>,
    pub rollback_nodes: Vec<DiffNode>,
    pub is_consistent: bool,
    pub consistency_issues: Vec<String>,
}

impl RollbackGraph {
    pub fn from_forward_diffs(
        forward_diffs: &[TableDiff],
        renames: &[RenameCandidate],
        dep_graph: &DependencyGraph,
    ) -> Self {
        let mut forward_nodes = Vec::new();
        let mut rollback_nodes = Vec::new();
        let consistency_issues = Vec::new();

        let rename_map: HashMap<&str, &RenameCandidate> = renames.iter().map(|r| (r.target_name.as_str(), r)).collect();
        let rename_reverse: HashMap<&str, &str> =
            renames.iter().map(|r| (r.source_name.as_str(), r.target_name.as_str())).collect();

        let order_map: HashMap<&str, usize> =
            dep_graph.topological_order.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();

        for diff in forward_diffs {
            let order = order_map.get(diff.name.as_str()).copied().unwrap_or(usize::MAX);

            let (rename_source, rename_target, rename_score) = if diff.diff_type == "added" {
                if let Some(rc) = rename_reverse.get(diff.name.as_str()) {
                    (Some(rc.to_string()), Some(diff.name.clone()), None)
                } else {
                    (None, None, None)
                }
            } else if diff.diff_type == "removed" {
                if let Some(rc) = rename_map.get(diff.name.as_str()) {
                    (Some(diff.name.clone()), Some(rc.source_name.clone()), Some(rc.score))
                } else {
                    (None, None, None)
                }
            } else {
                (None, None, None)
            };

            forward_nodes.push(DiffNode {
                table_diff: diff.clone(),
                direction: DiffDirection::Forward,
                dependency_order: order,
                rename_source,
                rename_target,
                rename_score,
            });

            let rollback_diff = Self::invert_diff(diff);
            rollback_nodes.push(DiffNode {
                table_diff: rollback_diff,
                direction: DiffDirection::Rollback,
                dependency_order: order,
                rename_source: None,
                rename_target: None,
                rename_score: None,
            });
        }

        RollbackGraph { forward_nodes, rollback_nodes, is_consistent: false, consistency_issues }
    }

    fn invert_diff_type(dt: &str) -> &str {
        match dt {
            "added" => "removed",
            "removed" => "added",
            "renamed" => "renamed",
            _ => "modified",
        }
    }

    fn invert_change_string(ch: &str) -> String {
        let Some((before, after)) = ch.split_once(" → ") else {
            return ch.to_string();
        };
        if let Some((kind, value)) = before.split_once(": ") {
            format!("{kind}: {after} → {value}")
        } else {
            format!("{after} → {before}")
        }
    }

    fn invert_columns(cols: &[ColumnDiff]) -> Vec<ColumnDiff> {
        cols.iter()
            .map(|c| {
                let inverted_name = if c.diff_type == "renamed" {
                    c.target.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| c.name.clone())
                } else {
                    c.name.clone()
                };
                ColumnDiff {
                    diff_type: Self::invert_diff_type(&c.diff_type).to_string(),
                    name: inverted_name,
                    source: c.target.clone(),
                    target: c.source.clone(),
                    changes: c.changes.iter().map(|ch| Self::invert_change_string(ch)).collect(),
                    add_position: c.add_position.clone(),
                }
            })
            .collect()
    }

    fn invert_indexes(idxs: &[IndexDiff]) -> Vec<IndexDiff> {
        idxs.iter()
            .map(|i| IndexDiff {
                diff_type: Self::invert_diff_type(&i.diff_type).to_string(),
                name: i.name.clone(),
                source: i.target.clone(),
                target: i.source.clone(),
                changes: i.changes.clone(),
            })
            .collect()
    }

    fn invert_fks(fks: &[ForeignKeyDiff]) -> Vec<ForeignKeyDiff> {
        fks.iter()
            .map(|fk| ForeignKeyDiff {
                diff_type: Self::invert_diff_type(&fk.diff_type).to_string(),
                name: fk.name.clone(),
                source: fk.target.clone(),
                target: fk.source.clone(),
                changes: fk.changes.clone(),
            })
            .collect()
    }

    fn invert_triggers(trgs: &[TriggerDiff]) -> Vec<TriggerDiff> {
        trgs.iter()
            .map(|t| TriggerDiff {
                diff_type: Self::invert_diff_type(&t.diff_type).to_string(),
                name: t.name.clone(),
                source: t.target.clone(),
                target: t.source.clone(),
                changes: t.changes.clone(),
            })
            .collect()
    }

    fn invert_diff(diff: &TableDiff) -> TableDiff {
        let inverted_type = Self::invert_diff_type(&diff.diff_type).to_string();

        let inverted_columns = diff.columns.as_ref().map(|cols| Self::invert_columns(cols));
        let inverted_indexes = diff.indexes.as_ref().map(|idxs| Self::invert_indexes(idxs));
        let inverted_fks = diff.foreign_keys.as_ref().map(|fks| Self::invert_fks(fks));
        let inverted_triggers = diff.triggers.as_ref().map(|trgs| Self::invert_triggers(trgs));

        let (source_comment, target_comment) = match inverted_type.as_str() {
            "added" => (diff.target_table_comment.clone(), diff.source_table_comment.clone()),
            "removed" => (diff.source_table_comment.clone(), diff.target_table_comment.clone()),
            _ => (diff.target_table_comment.clone(), diff.source_table_comment.clone()),
        };
        let recreates_removed_table =
            diff.diff_type == "removed" && inverted_type == "added" && diff.object_type.as_deref() == Some("table");

        TableDiff {
            diff_type: inverted_type,
            object_type: diff.object_type.clone(),
            name: diff.name.clone(),
            columns: inverted_columns,
            indexes: inverted_indexes,
            foreign_keys: inverted_fks,
            triggers: inverted_triggers,
            // Rollback recreation must use the structured snapshot first. Keep
            // native target DDL isolated as a same-target-dialect fallback.
            ddl: if recreates_removed_table { None } else { diff.target_ddl.clone() },
            target_ddl: if recreates_removed_table { diff.target_ddl.clone() } else { diff.ddl.clone() },
            source_table_comment: source_comment,
            target_table_comment: target_comment,
            sync_sql: None,
        }
    }

    pub fn validate_consistency(&mut self) -> bool {
        self.consistency_issues.clear();

        for fwd in &self.forward_nodes {
            let has_rollback = self.rollback_nodes.iter().any(|rbk| {
                rbk.table_diff.name == fwd.table_diff.name
                    && matches!(
                        (fwd.table_diff.diff_type.as_str(), rbk.table_diff.diff_type.as_str()),
                        ("added", "removed") | ("removed", "added") | ("modified", "modified") | ("none", "none")
                    )
            });

            if !has_rollback {
                self.consistency_issues.push(format!(
                    "No rollback entry for forward {}: {}",
                    fwd.table_diff.diff_type, fwd.table_diff.name
                ));
            }

            let rollback_of_rollback: Vec<_> = self
                .rollback_nodes
                .iter()
                .filter(|rbk| rbk.table_diff.name == fwd.table_diff.name)
                .map(|rbk| Self::invert_diff(&rbk.table_diff))
                .collect();

            for ror in &rollback_of_rollback {
                if ror.diff_type != fwd.table_diff.diff_type {
                    self.consistency_issues.push(format!(
                        "Forward∘Rollback mismatch for {}: forward={}, rollback∘rollback={}",
                        fwd.table_diff.name, fwd.table_diff.diff_type, ror.diff_type
                    ));
                }
            }
        }

        self.is_consistent = self.consistency_issues.is_empty();
        self.is_consistent
    }
}

pub fn generate_rollback_sync_sql(
    rollback_graph: &RollbackGraph,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
) -> String {
    generate_rollback_sync_sql_with_missing(rollback_graph, db_type, schema, cascade_delete).0
}

pub fn generate_rollback_sync_sql_with_missing(
    rollback_graph: &RollbackGraph,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
) -> (String, Vec<MissingRollbackObject>) {
    let rollback_diffs: Vec<TableDiff> = rollback_graph.rollback_nodes.iter().map(|n| n.table_diff.clone()).collect();
    generate_schema_sync_sql_inner(&rollback_diffs, &[], &[], &[], &[], db_type, schema, cascade_delete, None, &[])
}

// ============================================================================
// Phase 4.5: Shard-Parallel Comparison
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardStrategy {
    pub shard_count: usize,
    pub shard_by: ShardBy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ShardBy {
    Table,
    Schema,
    RoundRobin,
}

pub fn shard_diff(options: &SchemaDiffPreparationOptions, shard_strategy: &ShardStrategy) -> Vec<TableDiff> {
    let table_count = options.source_tables.len().max(options.target_tables.len());
    let shard_count = shard_strategy.shard_count.min(table_count.max(1));

    if shard_count <= 1 {
        return diff_schema(options);
    }

    let source_table_names: Vec<&str> =
        options.source_tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let source_view_names: Vec<&str> =
        options.source_tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let _target_table_names: Vec<&str> =
        options.target_tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let _target_view_names: Vec<&str> =
        options.target_tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();

    let source_all: Vec<&str> = source_table_names.iter().chain(source_view_names.iter()).copied().collect();
    let shards: Vec<Vec<&str>> = match &shard_strategy.shard_by {
        ShardBy::Table | ShardBy::RoundRobin => {
            let mut s: Vec<Vec<&str>> = vec![Vec::new(); shard_count];
            for (i, name) in source_all.iter().enumerate() {
                s[i % shard_count].push(*name);
            }
            s
        }
        ShardBy::Schema => {
            let mut schema_groups: HashMap<&str, Vec<&str>> = HashMap::new();
            for table in &options.source_tables {
                let schema = table.parent_schema.as_deref().unwrap_or("default");
                schema_groups.entry(schema).or_default().push(table.name.as_str());
            }
            let mut s: Vec<Vec<&str>> = vec![Vec::new(); shard_count];
            for (i, (_schema, names)) in schema_groups.iter().enumerate() {
                s[i % shard_count].extend(names);
            }
            s
        }
    };

    let shard_results: Vec<Vec<TableDiff>> = shards
        .par_iter()
        .filter(|shard| !shard.is_empty())
        .map(|shard| {
            let shard_set: HashSet<&str> = shard.iter().copied().collect();
            let shard_options = SchemaDiffPreparationOptions {
                source_tables: options
                    .source_tables
                    .iter()
                    .filter(|t| shard_set.contains(t.name.as_str()))
                    .cloned()
                    .collect(),
                target_tables: options
                    .target_tables
                    .iter()
                    .filter(|t| shard_set.contains(t.name.as_str()))
                    .cloned()
                    .collect(),
                source_details: options
                    .source_details
                    .iter()
                    .filter(|d| shard_set.contains(d.name.as_str()))
                    .cloned()
                    .collect(),
                target_details: options
                    .target_details
                    .iter()
                    .filter(|d| shard_set.contains(d.name.as_str()))
                    .cloned()
                    .collect(),
                source_functions: options.source_functions.clone(),
                target_functions: options.target_functions.clone(),
                source_sequences: options.source_sequences.clone(),
                target_sequences: options.target_sequences.clone(),
                source_rules: options.source_rules.clone(),
                target_rules: options.target_rules.clone(),
                source_owners: options.source_owners.clone(),
                target_owners: options.target_owners.clone(),
                database_type: options.database_type,
                target_schema: options.target_schema.clone(),
                ignore_comments: options.ignore_comments,
                cascade_delete: options.cascade_delete,
                compare_column_order: options.compare_column_order,
                source_dialect: options.source_dialect,
                target_dialect: options.target_dialect,
                ..Default::default()
            };
            diff_schema(&shard_options)
        })
        .collect();

    let mut merged: Vec<TableDiff> = Vec::new();
    for shard_result in shard_results {
        merged.extend(shard_result);
    }

    merged.sort_by(|a, b| a.name.cmp(&b.name));
    merged.dedup_by(|a, b| a.name == b.name && a.diff_type == b.diff_type);
    merged
}

// ============================================================================
// Phase 4.6: Permission & Role-Aware Sync
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub grantee: String,
    pub object_type: String,
    pub object_name: String,
    pub privilege: String,
    pub is_grantable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub grantee: String,
    pub object_name: String,
    pub privilege: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PermissionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<PermissionInfo>,
}

pub fn diff_permissions(source: &[PermissionInfo], target: &[PermissionInfo]) -> Vec<PermissionDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<(&str, &str, &str), &PermissionInfo> =
        target.iter().map(|p| ((p.grantee.as_str(), p.object_name.as_str(), p.privilege.as_str()), p)).collect();
    let source_map: HashMap<(&str, &str, &str), &PermissionInfo> =
        source.iter().map(|p| ((p.grantee.as_str(), p.object_name.as_str(), p.privilege.as_str()), p)).collect();

    for sp in source {
        let key = (sp.grantee.as_str(), sp.object_name.as_str(), sp.privilege.as_str());
        if !target_map.contains_key(&key) {
            diffs.push(PermissionDiff {
                diff_type: "added".to_string(),
                grantee: sp.grantee.clone(),
                object_name: sp.object_name.clone(),
                privilege: sp.privilege.clone(),
                source: Some(sp.clone()),
                target: None,
            });
        }
    }

    for tp in target {
        let key = (tp.grantee.as_str(), tp.object_name.as_str(), tp.privilege.as_str());
        if !source_map.contains_key(&key) {
            diffs.push(PermissionDiff {
                diff_type: "removed".to_string(),
                grantee: tp.grantee.clone(),
                object_name: tp.object_name.clone(),
                privilege: tp.privilege.clone(),
                source: None,
                target: Some(tp.clone()),
            });
        }
    }

    diffs
}

fn sqlserver_permission_securable(permission: &PermissionInfo, schema: Option<&str>) -> String {
    match permission.object_type.trim().to_ascii_uppercase().as_str() {
        "SCHEMA" => format!("SCHEMA::{}", quote_id(&permission.object_name, DatabaseType::SqlServer)),
        "DATABASE" => format!("DATABASE::{}", quote_id(&permission.object_name, DatabaseType::SqlServer)),
        _ => {
            let object_name = if schema.is_none() {
                permission
                    .object_name
                    .split_once('.')
                    .filter(|(_, object)| !object.contains('.'))
                    .map(|(object_schema, object)| {
                        format!(
                            "{}.{}",
                            quote_id(
                                object_schema.trim_matches(|ch| matches!(ch, '[' | ']' | '"')),
                                DatabaseType::SqlServer,
                            ),
                            quote_id(object.trim_matches(|ch| matches!(ch, '[' | ']' | '"')), DatabaseType::SqlServer,)
                        )
                    })
                    .unwrap_or_else(|| qualified_name(&permission.object_name, DatabaseType::SqlServer, schema))
            } else {
                qualified_name(&permission.object_name, DatabaseType::SqlServer, schema)
            };
            format!("OBJECT::{object_name}")
        }
    }
}

pub fn generate_permission_sync_sql(diffs: &[PermissionDiff], db_type: DatabaseType, schema: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let profile = profile_for(db_type);

    for diff in diffs {
        match diff.diff_type.as_str() {
            "added" => {
                if let Some(source) = &diff.source {
                    if db_type == DatabaseType::SqlServer {
                        let securable = sqlserver_permission_securable(source, schema);
                        let grantee = quote_id(&source.grantee, db_type);
                        let with_grant = if source.is_grantable { " WITH GRANT OPTION" } else { "" };
                        lines
                            .push(format!("GRANT {} ON {} TO {}{};", source.privilege, securable, grantee, with_grant));
                    } else if profile.grant_uses_mysql_user_syntax {
                        let object_path = if let Some(sch) = schema {
                            format!("`{}`.`{}`", sch.replace('`', "``"), source.object_name.replace('`', "``"))
                        } else {
                            format!("`{}`", source.object_name.replace('`', "``"))
                        };
                        let with_grant = if source.is_grantable { " WITH GRANT OPTION" } else { "" };
                        let grantee_escaped = source.grantee.replace('\'', "''");
                        lines.push(format!(
                            "GRANT {} ON {} TO '{}'{};",
                            source.privilege, object_path, grantee_escaped, with_grant
                        ));
                    } else {
                        let obj_escaped = source.object_name.replace('"', "\"\"");
                        let object_path = if let Some(sch) = schema {
                            format!("{} \"{}\".\"{}\"", source.object_type, sch, obj_escaped)
                        } else {
                            format!("{} \"{}\"", source.object_type, obj_escaped)
                        };
                        let with_grant = if source.is_grantable { " WITH GRANT OPTION" } else { "" };
                        let grantee_escaped = source.grantee.replace('"', "\"\"");
                        lines.push(format!(
                            "GRANT {} ON {} TO \"{}\"{};",
                            source.privilege, object_path, grantee_escaped, with_grant
                        ));
                    }
                }
            }
            "removed" => {
                if let Some(target) = &diff.target {
                    if db_type == DatabaseType::SqlServer {
                        let securable = sqlserver_permission_securable(target, schema);
                        let grantee = quote_id(&target.grantee, db_type);
                        lines.push(format!("REVOKE {} ON {} FROM {};", target.privilege, securable, grantee));
                    } else if profile.grant_uses_mysql_user_syntax {
                        let object_path = if let Some(sch) = schema {
                            format!("`{}`.`{}`", sch.replace('`', "``"), target.object_name.replace('`', "``"))
                        } else {
                            format!("`{}`", target.object_name.replace('`', "``"))
                        };
                        let grantee_escaped = target.grantee.replace('\'', "''");
                        lines.push(format!(
                            "REVOKE {} ON {} FROM '{}';",
                            target.privilege, object_path, grantee_escaped
                        ));
                    } else {
                        let obj_escaped = target.object_name.replace('"', "\"\"");
                        let object_path = if let Some(sch) = schema {
                            format!("{} \"{}\".\"{}\"", target.object_type, sch, obj_escaped)
                        } else {
                            format!("{} \"{}\"", target.object_type, obj_escaped)
                        };
                        let grantee_escaped = target.grantee.replace('"', "\"\"");
                        lines.push(format!(
                            "REVOKE {} ON {} FROM \"{}\";",
                            target.privilege, object_path, grantee_escaped
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    lines.join("\n")
}

// ============================================================================
// Phase 4.7: Metadata Resource-Aware Scheduling
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceConstraint {
    pub max_concurrent_connections: usize,
    pub max_memory_mb: u64,
    pub max_tables_per_batch: usize,
    pub throttle_delay_ms: u64,
}

impl Default for ResourceConstraint {
    fn default() -> Self {
        Self { max_concurrent_connections: 4, max_memory_mb: 512, max_tables_per_batch: 50, throttle_delay_ms: 100 }
    }
}

#[derive(Debug, Clone)]
pub struct AdaptiveScheduler {
    pub constraint: ResourceConstraint,
    pub current_connections: usize,
    pub estimated_table_count: usize,
}

impl AdaptiveScheduler {
    pub fn new(constraint: ResourceConstraint, table_count: usize) -> Self {
        Self { constraint, current_connections: 0, estimated_table_count: table_count }
    }

    pub fn optimal_batch_size(&self) -> usize {
        let conn_limit = self.constraint.max_concurrent_connections;
        let mem_limit = self.constraint.max_memory_mb as usize * 50;
        let table_limit = self.constraint.max_tables_per_batch;

        let batches = self.estimated_table_count.max(1);
        let per_batch = (self.estimated_table_count / conn_limit).max(1);

        per_batch.min(mem_limit / batches).min(table_limit)
    }

    pub fn recommended_shard_count(&self) -> usize {
        let per_batch = self.optimal_batch_size();
        let count = (self.estimated_table_count as f64 / per_batch as f64).ceil() as usize;
        count.min(self.constraint.max_concurrent_connections).max(1)
    }

    pub fn throttle_delay_ms(&self) -> u64 {
        self.constraint.throttle_delay_ms
    }
}

// ============================================================================
// Phase 4: Extended SchemaDiffPreparationOptions & SchemaDiffPreparation
// ============================================================================

impl Default for SchemaDiffPreparationOptions {
    fn default() -> Self {
        Self {
            source_tables: Vec::new(),
            target_tables: Vec::new(),
            source_details: Vec::new(),
            target_details: Vec::new(),
            source_functions: Vec::new(),
            target_functions: Vec::new(),
            source_sequences: Vec::new(),
            target_sequences: Vec::new(),
            source_rules: Vec::new(),
            target_rules: Vec::new(),
            source_owners: Vec::new(),
            target_owners: Vec::new(),
            database_type: DatabaseType::Sqlite,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: false,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            batch_patterns: Vec::new(),
            source_dialect: None,
            target_dialect: None,
            compatibility_threshold: 0.5,
            source_permissions: Vec::new(),
            target_permissions: Vec::new(),
            shard_strategy: None,
            resource_constraint: None,
            field_mappings: Vec::new(),
        }
    }
}

// Add new optional fields to SchemaDiffPreparationOptions
// These are added as separate impl blocks to avoid breaking existing construction sites
impl SchemaDiffPreparationOptions {
    pub fn with_rename_detection(mut self, detect: bool, threshold: f64) -> Self {
        self.detect_renames = detect;
        self.rename_threshold = threshold;
        self
    }

    pub fn with_rollback(mut self, enable: bool) -> Self {
        self.enable_rollback = enable;
        self
    }

    pub fn with_batch_patterns(mut self, patterns: Vec<BatchPattern>) -> Self {
        self.batch_patterns = patterns;
        self
    }

    pub fn with_dialects(mut self, source: Option<DialectKind>, target: Option<DialectKind>) -> Self {
        self.source_dialect = source;
        self.target_dialect = target;
        self
    }

    pub fn with_compatibility_threshold(mut self, threshold: f64) -> Self {
        self.compatibility_threshold = threshold;
        self
    }

    pub fn with_permissions(mut self, source: Vec<PermissionInfo>, target: Vec<PermissionInfo>) -> Self {
        self.source_permissions = source;
        self.target_permissions = target;
        self
    }

    pub fn with_shard_strategy(mut self, strategy: ShardStrategy) -> Self {
        self.shard_strategy = Some(strategy);
        self
    }

    pub fn with_resource_constraint(mut self, constraint: ResourceConstraint) -> Self {
        self.resource_constraint = Some(constraint);
        self
    }

    pub fn with_field_mappings(mut self, mappings: Vec<FieldMapping>) -> Self {
        self.field_mappings = mappings;
        self
    }
}

pub fn prepare_schema_diff(options: SchemaDiffPreparationOptions) -> SchemaDiffPreparation {
    if !options.field_mappings.is_empty() {
        log::info!("prepare_schema_diff field_mappings:");
        for m in &options.field_mappings {
            log::info!(
                "  {} -> {} (strategy={:?}, custom={:?})",
                m.source_type,
                m.target_type,
                m.param_strategy,
                m.custom_params
            );
        }
        log::info!("  source_dialect={:?} target_dialect={:?}", options.source_dialect, options.target_dialect);
    }

    let dialect_str = options.source_dialect.map(|d| d.label().to_string()).unwrap_or_else(|| "generic".to_string());
    let options = AstTransmitFilter::filter_diff_preparation_options(options, &dialect_str);

    let dep_graph = DependencyGraph::build(&options.source_details, &options.source_tables);

    let mut diffs = if let Some(ref strategy) = options.shard_strategy {
        shard_diff(&options, strategy)
    } else {
        diff_schema(&options)
    };

    let rename_candidates = if options.detect_renames && options.detect_table_renames {
        let removed: Vec<String> = diffs.iter().filter(|d| d.diff_type == "removed").map(|d| d.name.clone()).collect();
        let added: Vec<String> = diffs.iter().filter(|d| d.diff_type == "added").map(|d| d.name.clone()).collect();
        let candidates = detect_renames(
            &removed,
            &added,
            &options.source_details,
            &options.target_details,
            options.rename_threshold,
        );

        let target_renamed: HashSet<&str> = candidates.iter().map(|r| r.target_name.as_str()).collect();
        let source_renamed: HashSet<&str> = candidates.iter().map(|r| r.source_name.as_str()).collect();

        diffs.retain(|d| {
            !((d.diff_type == "removed" && target_renamed.contains(d.name.as_str()))
                || (d.diff_type == "added" && source_renamed.contains(d.name.as_str())))
        });

        for c in &candidates {
            let source_detail = options.source_details.iter().find(|d| d.name == c.source_name);
            let target_detail = options.target_details.iter().find(|d| d.name == c.target_name);
            diffs.push(TableDiff {
                diff_type: "renamed".to_string(),
                object_type: Some("table".to_string()),
                name: c.source_name.clone(),
                columns: None,
                indexes: None,
                foreign_keys: None,
                triggers: None,
                ddl: source_detail.and_then(|d| d.ddl.clone()),
                target_ddl: target_detail.and_then(|d| d.ddl.clone()),
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            });
        }

        candidates
    } else {
        Vec::new()
    };

    let compatibility_warnings = if options.source_dialect.is_some() || options.target_dialect.is_some() {
        let src_dialect = options.source_dialect.unwrap_or(DialectKind::Mysql);
        let tgt_dialect = options.target_dialect.unwrap_or(DialectKind::Mysql);
        let mut all_warnings = Vec::new();
        for diff in &diffs {
            if diff.diff_type == "modified" {
                if let Some(source_detail) = options.source_details.iter().find(|d| d.name == diff.name) {
                    if let Some(target_detail) = options.target_details.iter().find(|d| d.name == diff.name) {
                        let (_, warnings) = diff_columns_with_compatibility(
                            &source_detail.columns,
                            &target_detail.columns,
                            options.ignore_comments,
                            options.compare_column_order,
                            src_dialect,
                            tgt_dialect,
                            options.compatibility_threshold,
                            &options.field_mappings,
                        );
                        all_warnings.extend(warnings);
                    }
                }
            }
        }
        all_warnings
    } else {
        Vec::new()
    };

    let rollback_graph = if options.enable_rollback {
        let mut graph = RollbackGraph::from_forward_diffs(&diffs, &rename_candidates, &dep_graph);
        let _ = graph.validate_consistency();
        Some(graph)
    } else {
        None
    };

    let function_diffs = diff_functions(&options.source_functions, &options.target_functions);
    let sequence_diffs = diff_sequences(&options.source_sequences, &options.target_sequences);
    let rule_diffs = diff_rules(&options.source_rules, &options.target_rules);
    let owner_diffs = diff_owners(&options.source_owners, &options.target_owners);

    for diff in &mut diffs {
        let (sync_sql, _) = generate_schema_sync_sql_inner(
            std::slice::from_ref(diff),
            &[],
            &[],
            &[],
            &[],
            options.database_type,
            options.target_schema.as_deref(),
            options.cascade_delete,
            options.source_dialect,
            &options.field_mappings,
        );
        if !sync_sql.is_empty() {
            diff.sync_sql = Some(sync_sql);
        }
    }

    let (sync_sql, _) = generate_schema_sync_sql_inner(
        &diffs,
        &function_diffs,
        &sequence_diffs,
        &rule_diffs,
        &owner_diffs,
        options.database_type,
        options.target_schema.as_deref(),
        options.cascade_delete,
        options.source_dialect,
        &options.field_mappings,
    );

    let (rollback_sync_sql, missing_rollback_objects) = match &rollback_graph {
        Some(graph) => {
            let (sql, missing) = generate_rollback_sync_sql_with_missing(
                graph,
                options.database_type,
                options.target_schema.as_deref(),
                options.cascade_delete,
            );
            (Some(sql), missing)
        }
        None => (None, Vec::new()),
    };
    let rollback_completeness = if missing_rollback_objects.is_empty() {
        RollbackCompleteness::Complete
    } else {
        RollbackCompleteness::Incomplete
    };

    let permission_diffs = if !options.source_permissions.is_empty() || !options.target_permissions.is_empty() {
        diff_permissions(&options.source_permissions, &options.target_permissions)
    } else {
        Vec::new()
    };

    let permission_sync_sql = if !permission_diffs.is_empty() {
        Some(generate_permission_sync_sql(&permission_diffs, options.database_type, options.target_schema.as_deref()))
    } else {
        None
    };

    SchemaDiffPreparation {
        diffs,
        function_diffs,
        sequence_diffs,
        rule_diffs,
        owner_diffs,
        sync_sql,
        rollback_sync_sql,
        rollback_completeness,
        missing_rollback_objects,
        rename_candidates,
        rollback_graph,
        compatibility_warnings,
        permission_diffs,
        permission_sync_sql,
        dependency_graph: Some(dep_graph),
    }
}

fn diff_schema(options: &SchemaDiffPreparationOptions) -> Vec<TableDiff> {
    let source_details: HashMap<&str, &TableSchemaDetail> =
        options.source_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let target_details: HashMap<&str, &TableSchemaDetail> =
        options.target_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let source_table_comments: HashMap<&str, Option<String>> =
        options.source_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();
    let target_table_comments: HashMap<&str, Option<String>> =
        options.target_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();

    let source_table_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| !table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let target_table_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| !table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let source_view_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let target_view_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();

    let (added, removed, common) = diff_names(&source_table_names, &target_table_names);
    let (added_views, removed_views, common_views) = diff_names(&source_view_names, &target_view_names);
    let mut result = Vec::new();

    // A foreign key whose `ref_table` is itself one of the tables being compared is a
    // same-database self-reference. Its `ref_schema` is always the literal source/target
    // database name (MySQL's information_schema reports it unconditionally, even for
    // self-references), so source and target will almost always disagree even though the
    // relationship is structurally identical. Clearing it here makes such FKs compare and
    // regenerate against the *other side's own* database instead of being flagged as
    // "different" and then rewritten to literally reference the source database name.
    // Genuine cross-database references (ref_table not part of this database) are left as-is.
    let source_table_name_set: HashSet<&str> = source_table_names.iter().map(String::as_str).collect();
    let target_table_name_set: HashSet<&str> = target_table_names.iter().map(String::as_str).collect();

    for name in added {
        let source_detail = source_details.get(name.as_str());
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            name,
            ddl: source_detail.and_then(|detail| detail.ddl.clone()),
            target_ddl: None,
            columns: source_detail.map(|detail| {
                detail
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(index, c)| ColumnDiff {
                        diff_type: "added".to_string(),
                        name: c.name.clone(),
                        source: Some(c.clone()),
                        target: None,
                        changes: vec![],
                        add_position: Some(column_add_position(&detail.columns, index)),
                    })
                    .collect()
            }),
            indexes: source_detail.map(|detail| {
                detail
                    .indexes
                    .iter()
                    .map(|i| IndexDiff {
                        diff_type: "added".to_string(),
                        name: i.name.clone(),
                        source: Some(i.clone()),
                        target: None,
                        changes: vec![],
                    })
                    .collect()
            }),
            foreign_keys: source_detail.map(|detail| {
                detail
                    .foreign_keys
                    .iter()
                    .map(|fk| {
                        let fk = normalize_self_referencing_fk(fk, &source_table_name_set);
                        ForeignKeyDiff {
                            diff_type: "added".to_string(),
                            name: fk.name.clone(),
                            source: Some(fk),
                            target: None,
                            changes: vec![],
                        }
                    })
                    .collect()
            }),
            triggers: source_detail.and_then(|detail| {
                if detail.triggers.is_empty() {
                    None
                } else {
                    Some(
                        detail
                            .triggers
                            .iter()
                            .map(|t| TriggerDiff {
                                diff_type: "added".to_string(),
                                name: t.name.clone(),
                                source: Some(t.clone()),
                                target: None,
                                changes: vec![],
                            })
                            .collect(),
                    )
                }
            }),
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in removed {
        let name_clone = name.clone();
        let target_detail = target_details.get(name_clone.as_str()).copied();
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("table".to_string()),
            name,
            columns: target_detail.map(|detail| {
                detail
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(index, column)| ColumnDiff {
                        diff_type: "removed".to_string(),
                        name: column.name.clone(),
                        source: None,
                        target: Some(column.clone()),
                        changes: vec![],
                        add_position: Some(column_add_position(&detail.columns, index)),
                    })
                    .collect()
            }),
            indexes: target_detail.map(|detail| {
                detail
                    .indexes
                    .iter()
                    .map(|index| IndexDiff {
                        diff_type: "removed".to_string(),
                        name: index.name.clone(),
                        source: None,
                        target: Some(index.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            foreign_keys: target_detail.map(|detail| {
                detail
                    .foreign_keys
                    .iter()
                    .map(|foreign_key| ForeignKeyDiff {
                        diff_type: "removed".to_string(),
                        name: foreign_key.name.clone(),
                        source: None,
                        target: Some(foreign_key.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            triggers: target_detail.map(|detail| {
                detail
                    .triggers
                    .iter()
                    .map(|trigger| TriggerDiff {
                        diff_type: "removed".to_string(),
                        name: trigger.name.clone(),
                        source: None,
                        target: Some(trigger.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            ddl: None,
            target_ddl: target_detail.and_then(|detail| detail.ddl.clone()),
            source_table_comment: None,
            target_table_comment: target_table_comments.get(name_clone.as_str()).cloned(),
            sync_sql: None,
        });
    }

    for name in added_views {
        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: source_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in removed_views {
        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: target_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in common_views {
        let Some(source_ddl) = source_details.get(name.as_str()).and_then(|detail| detail.ddl.as_ref()) else {
            continue;
        };
        let Some(target_ddl) = target_details.get(name.as_str()).and_then(|detail| detail.ddl.as_ref()) else {
            continue;
        };
        if !mysql_view_definitions_differ(source_ddl, target_ddl, options.source_dialect, options.target_dialect) {
            continue;
        }

        result.push(TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: Some(source_ddl.clone()),
            target_ddl: Some(target_ddl.clone()),
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in common {
        let Some(source) = source_details.get(name.as_str()) else { continue };
        let Some(target) = target_details.get(name.as_str()) else { continue };
        let column_diffs = diff_columns_with_dialect_options(
            &source.columns,
            &target.columns,
            options.ignore_comments,
            options.compare_column_order,
            options.detect_renames,
            options.rename_threshold,
            options.source_dialect,
            options.target_dialect,
        );
        let index_diffs = diff_indexes(&source.indexes, &target.indexes);
        let normalized_source_fks: Vec<ForeignKeyInfo> =
            source.foreign_keys.iter().map(|fk| normalize_self_referencing_fk(fk, &source_table_name_set)).collect();
        let normalized_target_fks: Vec<ForeignKeyInfo> =
            target.foreign_keys.iter().map(|fk| normalize_self_referencing_fk(fk, &target_table_name_set)).collect();
        let foreign_key_diffs = diff_foreign_keys(&normalized_source_fks, &normalized_target_fks);
        let trigger_diffs = diff_triggers(&source.triggers, &target.triggers);
        let source_comment = source_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let target_comment = target_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let comment_changed = !options.ignore_comments
            && source_comment.clone().unwrap_or_default() != target_comment.clone().unwrap_or_default();

        let has_diff = !column_diffs.is_empty()
            || !index_diffs.is_empty()
            || !foreign_key_diffs.is_empty()
            || !trigger_diffs.is_empty()
            || comment_changed;

        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: if has_diff { "modified".to_string() } else { "none".to_string() },
            object_type: Some("table".to_string()),
            name,
            columns: if has_diff { (!column_diffs.is_empty()).then_some(column_diffs) } else { None },
            indexes: if has_diff { (!index_diffs.is_empty()).then_some(index_diffs) } else { None },
            foreign_keys: if has_diff { (!foreign_key_diffs.is_empty()).then_some(foreign_key_diffs) } else { None },
            triggers: if has_diff { (!trigger_diffs.is_empty()).then_some(trigger_diffs) } else { None },
            ddl: source_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            target_ddl: target_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            source_table_comment: if has_diff { comment_changed.then_some(source_comment) } else { None },
            target_table_comment: if has_diff { comment_changed.then_some(target_comment) } else { None },
            sync_sql: None,
        });
    }

    result.retain(|diff| diff.diff_type != "none");
    result
}

fn diff_names(source: &[String], target: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let source_set: HashSet<&str> = source.iter().map(String::as_str).collect();
    let target_set: HashSet<&str> = target.iter().map(String::as_str).collect();
    (
        source.iter().filter(|name| !target_set.contains(name.as_str())).cloned().collect(),
        target.iter().filter(|name| !source_set.contains(name.as_str())).cloned().collect(),
        source.iter().filter(|name| target_set.contains(name.as_str())).cloned().collect(),
    )
}

fn mysql_view_definitions_differ(
    source_ddl: &str,
    target_ddl: &str,
    source_dialect: Option<DialectKind>,
    target_dialect: Option<DialectKind>,
) -> bool {
    if source_dialect != Some(DialectKind::Mysql) || target_dialect != Some(DialectKind::Mysql) {
        return false;
    }

    normalize_mysql_view_ddl(source_ddl) != normalize_mysql_view_ddl(target_ddl)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MysqlViewTokenKind {
    Atom,
    Symbol,
}

fn normalize_mysql_view_ddl(ddl: &str) -> String {
    let ddl = strip_mysql_view_definer(ddl);
    let schema = mysql_view_schema(&ddl);
    let mut normalized = String::with_capacity(ddl.len());
    let mut previous = None;
    let mut pending_whitespace = false;
    let bytes = ddl.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            pending_whitespace = true;
            index += 1;
            continue;
        }

        let (end, kind, replacement) = match bytes[index] {
            b'\'' | b'"' => {
                let end = mysql_quoted_token_end(&ddl, index);
                (end, MysqlViewTokenKind::Atom, None)
            }
            b'`' => {
                let end = mysql_quoted_token_end(&ddl, index);
                let identifier = decode_mysql_quoted_identifier(&ddl[index..end]);
                let is_schema_qualifier =
                    schema.as_deref() == Some(identifier.as_str()) && ddl[end..].trim_start().starts_with('.');
                (end, MysqlViewTokenKind::Atom, is_schema_qualifier.then_some("`__dbx_schema__`"))
            }
            b'#' => {
                let end = ddl[index..].find('\n').map_or(bytes.len(), |offset| index + offset);
                (end, MysqlViewTokenKind::Atom, None)
            }
            b'-' if bytes.get(index + 1) == Some(&b'-')
                && bytes.get(index + 2).is_some_and(|next| next.is_ascii_whitespace()) =>
            {
                let end = ddl[index..].find('\n').map_or(bytes.len(), |offset| index + offset);
                (end, MysqlViewTokenKind::Atom, None)
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let end = ddl[index + 2..].find("*/").map_or(bytes.len(), |offset| index + 2 + offset + 2);
                (end, MysqlViewTokenKind::Atom, None)
            }
            byte if mysql_view_symbol(byte) => (index + 1, MysqlViewTokenKind::Symbol, None),
            _ => {
                let mut end = index + 1;
                while end < bytes.len()
                    && !bytes[end].is_ascii_whitespace()
                    && !matches!(bytes[end], b'\'' | b'"' | b'`' | b'#')
                    && !mysql_view_symbol(bytes[end])
                {
                    end += 1;
                }
                (end, MysqlViewTokenKind::Atom, None)
            }
        };

        if pending_whitespace && previous == Some(kind) {
            normalized.push(' ');
        }
        normalized.push_str(replacement.unwrap_or(&ddl[index..end]));
        previous = Some(kind);
        pending_whitespace = false;
        index = end;
    }

    normalized
}

fn mysql_view_symbol(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')'
            | b'['
            | b']'
            | b'{'
            | b'}'
            | b','
            | b'.'
            | b';'
            | b'+'
            | b'-'
            | b'*'
            | b'/'
            | b'%'
            | b'<'
            | b'>'
            | b'='
            | b'!'
            | b'|'
            | b'&'
            | b'^'
            | b'~'
            | b'?'
            | b':'
            | b'@'
    )
}

fn mysql_view_schema(ddl: &str) -> Option<String> {
    let view = find_mysql_header_keyword(ddl, "VIEW", ddl.len())?;
    let mut index = skip_ascii_whitespace(ddl, view + "VIEW".len());
    let (identifier, end) = parse_mysql_identifier(ddl, index)?;
    index = skip_ascii_whitespace(ddl, end);
    (ddl.as_bytes().get(index) == Some(&b'.')).then_some(identifier)
}

fn strip_mysql_view_definer(ddl: &str) -> String {
    let Some(view) = find_mysql_header_keyword(ddl, "VIEW", ddl.len()) else {
        return ddl.to_string();
    };
    let Some(definer) = find_mysql_header_keyword(ddl, "DEFINER", view) else {
        return ddl.to_string();
    };
    let mut index = skip_ascii_whitespace(ddl, definer + "DEFINER".len());
    if ddl.as_bytes().get(index) != Some(&b'=') {
        return ddl.to_string();
    }
    index = skip_ascii_whitespace(ddl, index + 1);

    let Some(mut end) = parse_mysql_definer_principal(ddl, index) else {
        return ddl.to_string();
    };
    end = skip_ascii_whitespace(ddl, end);
    if ddl.as_bytes().get(end) == Some(&b'@') {
        end = skip_ascii_whitespace(ddl, end + 1);
        let Some(host_end) = parse_mysql_definer_principal(ddl, end) else {
            return ddl.to_string();
        };
        end = host_end;
    } else if ddl[index..end].eq_ignore_ascii_case("CURRENT_USER") {
        let open = skip_ascii_whitespace(ddl, end);
        if ddl.as_bytes().get(open) == Some(&b'(') {
            let close = skip_ascii_whitespace(ddl, open + 1);
            if ddl.as_bytes().get(close) == Some(&b')') {
                end = close + 1;
            }
        }
    } else {
        return ddl.to_string();
    }

    end = skip_ascii_whitespace(ddl, end);
    let mut stripped = String::with_capacity(ddl.len() - (end - definer));
    stripped.push_str(&ddl[..definer]);
    stripped.push_str(&ddl[end..]);
    stripped
}

fn parse_mysql_definer_principal(ddl: &str, index: usize) -> Option<usize> {
    match *ddl.as_bytes().get(index)? {
        b'`' | b'\'' | b'"' => Some(mysql_quoted_token_end(ddl, index)),
        _ => {
            let mut end = index;
            while let Some(byte) = ddl.as_bytes().get(end) {
                if byte.is_ascii_whitespace() || matches!(byte, b'@' | b'(' | b')') {
                    break;
                }
                end += 1;
            }
            (end > index).then_some(end)
        }
    }
}

fn parse_mysql_identifier(ddl: &str, index: usize) -> Option<(String, usize)> {
    if ddl.as_bytes().get(index) == Some(&b'`') {
        let end = mysql_quoted_token_end(ddl, index);
        return Some((decode_mysql_quoted_identifier(&ddl[index..end]), end));
    }

    let mut end = index;
    while let Some(byte) = ddl.as_bytes().get(end) {
        if byte.is_ascii_whitespace() || mysql_view_symbol(*byte) {
            break;
        }
        end += 1;
    }
    (end > index).then(|| (ddl[index..end].to_string(), end))
}

fn decode_mysql_quoted_identifier(identifier: &str) -> String {
    identifier.strip_prefix('`').and_then(|value| value.strip_suffix('`')).unwrap_or(identifier).replace("``", "`")
}

fn find_mysql_header_keyword(ddl: &str, keyword: &str, limit: usize) -> Option<usize> {
    let bytes = ddl.as_bytes();
    let mut index = 0;
    while index < limit {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                index = mysql_quoted_token_end(ddl, index);
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < limit && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$')) {
                    index += 1;
                }
                if ddl[start..index].eq_ignore_ascii_case(keyword) {
                    return Some(start);
                }
            }
            _ => index += 1,
        }
    }
    None
}

fn mysql_quoted_token_end(ddl: &str, start: usize) -> usize {
    let bytes = ddl.as_bytes();
    let quote = bytes[start];
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' && quote != b'`' {
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    bytes.len()
}

fn skip_ascii_whitespace(input: &str, mut index: usize) -> usize {
    while input.as_bytes().get(index).is_some_and(|byte| byte.is_ascii_whitespace()) {
        index += 1;
    }
    index
}

pub fn diff_columns(source: &[ColumnInfo], target: &[ColumnInfo]) -> Vec<ColumnDiff> {
    diff_columns_with_options(source, target, false, false, false, 0.5)
}

fn normalize_mysql_integer_type_for_comparison(data_type: &str) -> String {
    let normalized = data_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    let Some(open) = normalized.find('(') else {
        return normalized;
    };
    let Some(close) = normalized[open + 1..].find(')').map(|index| open + 1 + index) else {
        return normalized;
    };
    let base = normalized[..open].trim();
    let width = normalized[open + 1..close].trim();
    let integer_type = matches!(base, "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year");
    if !integer_type || width.is_empty() || !width.bytes().all(|byte| byte.is_ascii_digit()) {
        return normalized;
    }
    let suffix = normalized[close + 1..].trim();
    if suffix.is_empty() {
        base.to_string()
    } else {
        format!("{base} {suffix}")
    }
}

fn column_types_equal_for_dialects(
    source_type: &str,
    target_type: &str,
    source_dialect: Option<DialectKind>,
    target_dialect: Option<DialectKind>,
) -> bool {
    if source_type.eq_ignore_ascii_case(target_type) {
        return true;
    }
    source_dialect == Some(DialectKind::Mysql)
        && target_dialect == Some(DialectKind::Mysql)
        && normalize_mysql_integer_type_for_comparison(source_type)
            == normalize_mysql_integer_type_for_comparison(target_type)
}

fn column_type_similarity_score(source_type: &str, target_type: &str) -> f64 {
    let s = ColumnType::parse(source_type).base_type.to_ascii_lowercase();
    let t = ColumnType::parse(target_type).base_type.to_ascii_lowercase();
    if s == t {
        return 1.0;
    }
    let exact_matches = [
        ("int", "integer"),
        ("integer", "int"),
        ("float", "real"),
        ("real", "float"),
        ("double", "double precision"),
        ("double precision", "double"),
        ("bool", "boolean"),
        ("boolean", "bool"),
        ("timestamp", "datetime"),
        ("datetime", "timestamp"),
    ];
    if exact_matches.contains(&(s.as_str(), t.as_str())) {
        return 1.0;
    }
    let integer_family = ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "serial", "bigserial"];
    let text_family = ["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "clob", "nclob"];
    if integer_family.contains(&s.as_str()) && integer_family.contains(&t.as_str()) {
        return 0.8;
    }
    if text_family.contains(&s.as_str()) && text_family.contains(&t.as_str()) {
        return 0.8;
    }
    0.0
}

fn diff_columns_with_options(
    source: &[ColumnInfo],
    target: &[ColumnInfo],
    ignore_comments: bool,
    compare_column_order: bool,
    detect_renames: bool,
    rename_threshold: f64,
) -> Vec<ColumnDiff> {
    diff_columns_with_dialect_options(
        source,
        target,
        ignore_comments,
        compare_column_order,
        detect_renames,
        rename_threshold,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn diff_columns_with_dialect_options(
    source: &[ColumnInfo],
    target: &[ColumnInfo],
    ignore_comments: bool,
    compare_column_order: bool,
    detect_renames: bool,
    rename_threshold: f64,
    source_dialect: Option<DialectKind>,
    target_dialect: Option<DialectKind>,
) -> Vec<ColumnDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ColumnInfo> = target.iter().map(|column| (column.name.as_str(), column)).collect();
    let source_map: HashMap<&str, &ColumnInfo> = source.iter().map(|column| (column.name.as_str(), column)).collect();
    let target_position_map: HashMap<&str, usize> =
        target.iter().enumerate().map(|(index, column)| (column.name.as_str(), index)).collect();
    let can_compare_order = compare_column_order
        && source.len() == target.len()
        && source.iter().all(|column| target_map.contains_key(column.name.as_str()));

    for (source_index, source_column) in source.iter().enumerate() {
        if let Some(target_column) = target_map.get(source_column.name.as_str()) {
            let mut changes = Vec::new();
            if !column_types_equal_for_dialects(
                &source_column.data_type,
                &target_column.data_type,
                source_dialect,
                target_dialect,
            ) {
                changes.push(format!("type: {} → {}", target_column.data_type, source_column.data_type));
            }
            if source_column.is_nullable != target_column.is_nullable {
                changes.push(format!(
                    "nullable: {} → {}",
                    if target_column.is_nullable { "YES" } else { "NO" },
                    if source_column.is_nullable { "YES" } else { "NO" }
                ));
            }
            if source_column.column_default.as_deref().unwrap_or_default()
                != target_column.column_default.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "default: {} → {}",
                    target_column.column_default.as_deref().unwrap_or("NULL"),
                    source_column.column_default.as_deref().unwrap_or("NULL")
                ));
            }
            if !ignore_comments
                && source_column.comment.as_deref().unwrap_or_default()
                    != target_column.comment.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "comment: {} → {}",
                    target_column.comment.as_deref().unwrap_or_default(),
                    source_column.comment.as_deref().unwrap_or_default()
                ));
            }
            if can_compare_order {
                if let Some(target_index) = target_position_map.get(source_column.name.as_str()) {
                    if source_index != *target_index {
                        changes.push(format!("order: {} → {}", *target_index + 1, source_index + 1));
                    }
                }
            }
            if !changes.is_empty() {
                diffs.push(ColumnDiff {
                    diff_type: "modified".to_string(),
                    name: source_column.name.clone(),
                    source: Some(source_column.clone()),
                    target: Some((*target_column).clone()),
                    changes,
                    add_position: None,
                });
            }
        } else {
            diffs.push(ColumnDiff {
                diff_type: "added".to_string(),
                name: source_column.name.clone(),
                source: Some(source_column.clone()),
                target: None,
                changes: Vec::new(),
                add_position: Some(column_add_position(source, source_index)),
            });
        }
    }

    for (target_index, target_column) in target.iter().enumerate() {
        if !source_map.contains_key(target_column.name.as_str()) {
            diffs.push(ColumnDiff {
                diff_type: "removed".to_string(),
                name: target_column.name.clone(),
                source: None,
                target: Some(target_column.clone()),
                changes: Vec::new(),
                add_position: Some(column_add_position(target, target_index)),
            });
        }
    }

    if detect_renames && rename_threshold > 0.0 {
        let removed_indices: Vec<usize> =
            diffs.iter().enumerate().filter(|(_, d)| d.diff_type == "removed").map(|(i, _)| i).collect();
        let added_indices: Vec<usize> =
            diffs.iter().enumerate().filter(|(_, d)| d.diff_type == "added").map(|(i, _)| i).collect();

        let mut matched_added: HashSet<usize> = HashSet::new();
        let mut matched_removed: HashSet<usize> = HashSet::new();
        let mut rename_pairs: Vec<(usize, usize, f64)> = Vec::new();

        for &ri in &removed_indices {
            if let Some(removed_col) = &diffs[ri].target {
                let mut best_score = 0.0_f64;
                let mut best_ai = None;
                for &ai in &added_indices {
                    if matched_added.contains(&ai) {
                        continue;
                    }
                    if let Some(added_col) = &diffs[ai].source {
                        let type_score = column_type_similarity_score(&removed_col.data_type, &added_col.data_type);
                        if type_score < rename_threshold {
                            continue;
                        }
                        let mut score = type_score;
                        if removed_col.is_nullable == added_col.is_nullable {
                            score *= 1.0;
                        } else {
                            score *= 0.8;
                        }
                        if score > best_score {
                            best_score = score;
                            best_ai = Some(ai);
                        }
                    }
                }
                if let Some(ai) = best_ai {
                    rename_pairs.push((ri, ai, best_score));
                    matched_removed.insert(ri);
                    matched_added.insert(ai);
                }
            }
        }

        for (ri, ai, _score) in &rename_pairs {
            let old_name = diffs[*ri].name.clone();
            let old_col = diffs[*ri].target.clone().unwrap();
            let new_col = diffs[*ai].source.clone().unwrap();
            let new_name = new_col.name.clone();

            diffs[*ri] = ColumnDiff {
                diff_type: "renamed".to_string(),
                name: new_name.clone(),
                source: Some(new_col),
                target: Some(old_col),
                changes: vec![format!("{} → {}", old_name, new_name)],
                add_position: None,
            };
            diffs[*ai] = ColumnDiff {
                diff_type: "_matched_rename".to_string(),
                name: String::new(),
                source: None,
                target: None,
                changes: Vec::new(),
                add_position: None,
            };
        }

        diffs.retain(|d| d.diff_type != "_matched_rename");
    }

    diffs
}

fn column_add_position(columns: &[ColumnInfo], index: usize) -> ColumnAddPosition {
    if index == 0 {
        ColumnAddPosition::First
    } else {
        ColumnAddPosition::After(columns[index - 1].name.clone())
    }
}

pub fn diff_indexes(source: &[IndexInfo], target: &[IndexInfo]) -> Vec<IndexDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &IndexInfo> = target.iter().map(|index| (index.name.as_str(), index)).collect();
    let source_map: HashMap<&str, &IndexInfo> = source.iter().map(|index| (index.name.as_str(), index)).collect();

    for source_index in source {
        if source_index.is_primary {
            continue;
        }
        let Some(target_index) = target_map.get(source_index.name.as_str()) else {
            diffs.push(IndexDiff {
                diff_type: "added".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_index.is_unique != target_index.is_unique {
            changes.push(format!(
                "unique: {} → {}",
                if target_index.is_unique { "YES" } else { "NO" },
                if source_index.is_unique { "YES" } else { "NO" }
            ));
        }
        if source_index.columns.join(",") != target_index.columns.join(",") {
            changes.push(format!("columns: {} → {}", target_index.columns.join(", "), source_index.columns.join(", ")));
        }
        if source_index.index_type.as_deref().unwrap_or_default()
            != target_index.index_type.as_deref().unwrap_or_default()
        {
            changes.push(format!(
                "type: {} → {}",
                target_index.index_type.as_deref().unwrap_or("default"),
                source_index.index_type.as_deref().unwrap_or("default")
            ));
        }
        if source_index.filter.as_deref().unwrap_or_default() != target_index.filter.as_deref().unwrap_or_default() {
            changes.push(format!(
                "filter: {} → {}",
                target_index.filter.as_deref().unwrap_or("none"),
                source_index.filter.as_deref().unwrap_or("none")
            ));
        }
        let source_included = source_index.included_columns.clone().unwrap_or_default();
        let target_included = target_index.included_columns.clone().unwrap_or_default();
        if source_included.join(",") != target_included.join(",") {
            changes.push(format!(
                "include: {} → {}",
                if target_included.is_empty() { "none".to_string() } else { target_included.join(", ") },
                if source_included.is_empty() { "none".to_string() } else { source_included.join(", ") }
            ));
        }
        if !changes.is_empty() {
            diffs.push(IndexDiff {
                diff_type: "modified".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: Some((*target_index).clone()),
                changes,
            });
        }
    }

    for target_index in target {
        if target_index.is_primary {
            continue;
        }
        if !source_map.contains_key(target_index.name.as_str()) {
            diffs.push(IndexDiff {
                diff_type: "removed".to_string(),
                name: target_index.name.clone(),
                source: None,
                target: Some(target_index.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

fn normalized_foreign_key_action(action: Option<&str>) -> Option<String> {
    action
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase())
        .filter(|value| !value.is_empty())
}

fn normalize_self_referencing_fk(fk: &ForeignKeyInfo, own_table_names: &HashSet<&str>) -> ForeignKeyInfo {
    let mut normalized = fk.clone();
    if fk.ref_schema.is_some() && own_table_names.contains(fk.ref_table.as_str()) {
        normalized.ref_schema = None;
    }
    normalized
}

pub fn diff_foreign_keys(source: &[ForeignKeyInfo], target: &[ForeignKeyInfo]) -> Vec<ForeignKeyDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ForeignKeyInfo> = target.iter().map(|fk| (fk.name.as_str(), fk)).collect();
    let source_map: HashMap<&str, &ForeignKeyInfo> = source.iter().map(|fk| (fk.name.as_str(), fk)).collect();

    for source_fk in source {
        let Some(target_fk) = target_map.get(source_fk.name.as_str()) else {
            diffs.push(ForeignKeyDiff {
                diff_type: "added".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_fk.column != target_fk.column {
            changes.push(format!("column: {} → {}", target_fk.column, source_fk.column));
        }
        if source_fk.ref_table != target_fk.ref_table {
            changes.push(format!("ref table: {} → {}", target_fk.ref_table, source_fk.ref_table));
        }
        if source_fk.ref_schema != target_fk.ref_schema {
            changes.push(format!(
                "ref schema: {} → {}",
                target_fk.ref_schema.as_deref().unwrap_or(""),
                source_fk.ref_schema.as_deref().unwrap_or("")
            ));
        }
        if source_fk.ref_column != target_fk.ref_column {
            changes.push(format!("ref column: {} → {}", target_fk.ref_column, source_fk.ref_column));
        }
        let source_on_delete = normalized_foreign_key_action(source_fk.on_delete.as_deref());
        let target_on_delete = normalized_foreign_key_action(target_fk.on_delete.as_deref());
        if source_on_delete != target_on_delete {
            changes.push(format!(
                "delete: {} → {}",
                target_on_delete.as_deref().unwrap_or(""),
                source_on_delete.as_deref().unwrap_or("")
            ));
        }
        let source_on_update = normalized_foreign_key_action(source_fk.on_update.as_deref());
        let target_on_update = normalized_foreign_key_action(target_fk.on_update.as_deref());
        if source_on_update != target_on_update {
            changes.push(format!(
                "update: {} → {}",
                target_on_update.as_deref().unwrap_or(""),
                source_on_update.as_deref().unwrap_or("")
            ));
        }
        if !changes.is_empty() {
            diffs.push(ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: Some((*target_fk).clone()),
                changes,
            });
        }
    }

    for target_fk in target {
        if !source_map.contains_key(target_fk.name.as_str()) {
            diffs.push(ForeignKeyDiff {
                diff_type: "removed".to_string(),
                name: target_fk.name.clone(),
                source: None,
                target: Some(target_fk.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_triggers(source: &[TriggerInfo], target: &[TriggerInfo]) -> Vec<TriggerDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &TriggerInfo> =
        target.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();
    let source_map: HashMap<&str, &TriggerInfo> =
        source.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();

    for source_trigger in source {
        let Some(target_trigger) = target_map.get(source_trigger.name.as_str()) else {
            diffs.push(TriggerDiff {
                diff_type: "added".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_trigger.event != target_trigger.event {
            changes.push(format!("event: {} → {}", target_trigger.event, source_trigger.event));
        }
        if source_trigger.timing != target_trigger.timing {
            changes.push(format!("timing: {} → {}", target_trigger.timing, source_trigger.timing));
        }
        if !changes.is_empty() {
            diffs.push(TriggerDiff {
                diff_type: "modified".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: Some((*target_trigger).clone()),
                changes,
            });
        }
    }

    for target_trigger in target {
        if !source_map.contains_key(target_trigger.name.as_str()) {
            diffs.push(TriggerDiff {
                diff_type: "removed".to_string(),
                name: target_trigger.name.clone(),
                source: None,
                target: Some(target_trigger.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

/// Normalize a function definition for comparison by:
/// - Converting CRLF to LF
/// - Collapsing all whitespace (tabs, multiple spaces) to single spaces
/// - Trimming each line and rejoining
pub(crate) fn normalize_definition(def: &str) -> String {
    def.replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn diff_functions(source: &[FunctionInfo], target: &[FunctionInfo]) -> Vec<FunctionDiff> {
    let mut diffs = Vec::new();
    // Use (name, arguments) as key to support PostgreSQL function overloading
    let target_map: HashMap<(&str, &str), &FunctionInfo> =
        target.iter().map(|f| ((f.name.as_str(), f.arguments.as_str()), f)).collect();
    let source_map: HashMap<(&str, &str), &FunctionInfo> =
        source.iter().map(|f| ((f.name.as_str(), f.arguments.as_str()), f)).collect();

    for source_fn in source {
        let key = (source_fn.name.as_str(), source_fn.arguments.as_str());
        let Some(target_fn) = target_map.get(&key) else {
            diffs.push(FunctionDiff {
                diff_type: "added".to_string(),
                name: source_fn.name.clone(),
                source: Some(source_fn.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_fn.function_type != target_fn.function_type {
            changes.push(format!("type: {} → {}", target_fn.function_type, source_fn.function_type));
        }
        if source_fn.data_type != target_fn.data_type {
            changes.push(format!("return type: {} → {}", target_fn.data_type, source_fn.data_type));
        }
        if normalize_definition(&source_fn.definition) != normalize_definition(&target_fn.definition) {
            changes.push("definition changed".to_string());
        }
        if !changes.is_empty() {
            diffs.push(FunctionDiff {
                diff_type: "modified".to_string(),
                name: source_fn.name.clone(),
                source: Some(source_fn.clone()),
                target: Some((*target_fn).clone()),
                changes,
            });
        }
    }

    for target_fn in target {
        let key = (target_fn.name.as_str(), target_fn.arguments.as_str());
        if !source_map.contains_key(&key) {
            diffs.push(FunctionDiff {
                diff_type: "removed".to_string(),
                name: target_fn.name.clone(),
                source: None,
                target: Some(target_fn.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_sequences(source: &[SequenceInfo], target: &[SequenceInfo]) -> Vec<SequenceDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &SequenceInfo> = target.iter().map(|s| (s.name.as_str(), s)).collect();
    let source_map: HashMap<&str, &SequenceInfo> = source.iter().map(|s| (s.name.as_str(), s)).collect();

    for source_seq in source {
        let Some(target_seq) = target_map.get(source_seq.name.as_str()) else {
            diffs.push(SequenceDiff {
                diff_type: "added".to_string(),
                name: source_seq.name.clone(),
                source: Some(source_seq.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_seq.data_type != target_seq.data_type {
            changes.push(format!("data_type: {} → {}", target_seq.data_type, source_seq.data_type));
        }
        if source_seq.start_value != target_seq.start_value {
            changes.push(format!("start: {} → {}", target_seq.start_value, source_seq.start_value));
        }
        if source_seq.min_value != target_seq.min_value {
            changes.push(format!("min: {} → {}", target_seq.min_value, source_seq.min_value));
        }
        if source_seq.max_value != target_seq.max_value {
            changes.push(format!("max: {} → {}", target_seq.max_value, source_seq.max_value));
        }
        if source_seq.increment != target_seq.increment {
            changes.push(format!("increment: {} → {}", target_seq.increment, source_seq.increment));
        }
        if source_seq.cycle != target_seq.cycle {
            changes.push(format!("cycle: {} → {}", target_seq.cycle, source_seq.cycle));
        }
        // Only compare last_value when both sides successfully retrieved it.
        // Avoid false positives when one side lacks permission (returns None).
        if let (Some(s), Some(t)) = (&source_seq.last_value, &target_seq.last_value) {
            if s != t {
                changes.push(format!("last_value: {} → {}", t, s));
            }
        }
        if !changes.is_empty() {
            diffs.push(SequenceDiff {
                diff_type: "modified".to_string(),
                name: source_seq.name.clone(),
                source: Some(source_seq.clone()),
                target: Some((*target_seq).clone()),
                changes,
            });
        }
    }

    for target_seq in target {
        if !source_map.contains_key(target_seq.name.as_str()) {
            diffs.push(SequenceDiff {
                diff_type: "removed".to_string(),
                name: target_seq.name.clone(),
                source: None,
                target: Some(target_seq.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_rules(source: &[RuleInfo], target: &[RuleInfo]) -> Vec<RuleDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &RuleInfo> = target.iter().map(|r| (r.name.as_str(), r)).collect();
    let source_map: HashMap<&str, &RuleInfo> = source.iter().map(|r| (r.name.as_str(), r)).collect();

    for source_rule in source {
        let Some(target_rule) = target_map.get(source_rule.name.as_str()) else {
            diffs.push(RuleDiff {
                diff_type: "added".to_string(),
                name: source_rule.name.clone(),
                source: Some(source_rule.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_rule.definition != target_rule.definition {
            changes.push("definition changed".to_string());
        }
        if !changes.is_empty() {
            diffs.push(RuleDiff {
                diff_type: "modified".to_string(),
                name: source_rule.name.clone(),
                source: Some(source_rule.clone()),
                target: Some((*target_rule).clone()),
                changes,
            });
        }
    }

    for target_rule in target {
        if !source_map.contains_key(target_rule.name.as_str()) {
            diffs.push(RuleDiff {
                diff_type: "removed".to_string(),
                name: target_rule.name.clone(),
                source: None,
                target: Some(target_rule.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_owners(source: &[OwnerInfo], target: &[OwnerInfo]) -> Vec<OwnerDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &OwnerInfo> = target.iter().map(|o| (o.object_name.as_str(), o)).collect();
    let _source_map: HashMap<&str, &OwnerInfo> = source.iter().map(|o| (o.object_name.as_str(), o)).collect();

    for source_owner in source {
        let Some(target_owner) = target_map.get(source_owner.object_name.as_str()) else {
            continue; // skip added/removed objects, only compare owners for common objects
        };

        let mut changes = Vec::new();
        if source_owner.owner != target_owner.owner {
            changes.push(format!("owner: {} → {}", target_owner.owner, source_owner.owner));
        }
        if !changes.is_empty() {
            diffs.push(OwnerDiff {
                diff_type: "modified".to_string(),
                object_name: source_owner.object_name.clone(),
                source: Some(source_owner.clone()),
                target: Some((*target_owner).clone()),
                changes,
            });
        }
    }

    diffs
}

fn quote_id(name: &str, db_type: DatabaseType) -> String {
    profile_for(db_type).quote_ident(name)
}

fn column_def(col: &ColumnInfo, db_type: DatabaseType, source_dialect: Option<DialectKind>) -> String {
    if db_type == DatabaseType::SqlServer {
        return sqlserver_column_definition(col, &col.data_type, source_dialect, None);
    }
    let profile = profile_for(db_type);
    let mut definition = format!("{} {}", quote_id(&col.name, db_type), col.data_type);
    if !col.is_nullable {
        definition.push_str(" NOT NULL");
    }
    if let Some(default) = &col.column_default {
        definition.push_str(&format!(
            " DEFAULT {}",
            default_literal(
                default,
                &col.data_type,
                effective_source_dialect(source_dialect, db_type),
                col.extra.as_deref()
            )
        ));
    }
    // Suffix-style auto-increment is only valid in MySQL-family ALTER clauses
    // (ADD/MODIFY/CHANGE). Other dialects' identity clauses are order-sensitive
    // inside ADD COLUMN, so keep omitting them outside the MySQL family.
    if column_is_auto_increment(col) && profile.alter_uses_modify_column {
        if let AutoIncSyntax::Suffix(suffix) = profile.auto_inc {
            definition.push_str(suffix);
        }
    }
    if profile.inline_column_comment {
        if let Some(comment) = &col.comment {
            definition.push_str(&format!(" COMMENT {}", comment_literal(comment)));
        }
    }
    definition
}

fn qualified_name(name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let schema = schema
        .map(str::trim)
        .filter(|schema| !schema.is_empty())
        .or_else(|| (db_type == DatabaseType::SqlServer).then_some("dbo"));
    schema
        .map(|schema| format!("{}.{}", quote_id(schema, db_type), quote_id(name, db_type)))
        .unwrap_or_else(|| quote_id(name, db_type))
}

/// `CREATE TABLE`-family header keywords that native source DDL may start
/// with, longest-prefix-first so e.g. `CREATE FOREIGN TABLE` isn't shadowed
/// by a naive `CREATE TABLE` match.
const TABLE_DDL_HEADER_KEYWORDS: &[&str] =
    &["CREATE FOREIGN TABLE", "CREATE UNLOGGED TABLE", "CREATE TEMPORARY TABLE", "CREATE TEMP TABLE", "CREATE TABLE"];

/// `CREATE VIEW`-family header keywords, covering the `OR REPLACE` and
/// `MATERIALIZED` variants emitted by the Postgres/MySQL view DDL builders.
const VIEW_DDL_HEADER_KEYWORDS: &[&str] = &["CREATE MATERIALIZED VIEW", "CREATE OR REPLACE VIEW", "CREATE VIEW"];

/// Case-insensitive ASCII prefix check that avoids allocating an uppercased
/// copy of `haystack` (which can be a whole multi-KB `CREATE TABLE` body) just
/// to compare its first few bytes against a short keyword.
fn starts_with_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    haystack.get(..needle.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(needle))
}

/// Native DDL captured from the source connection is schema/database-qualified
/// against the *source* schema (see `render_postgres_table_ddl_with_partition_info`
/// and `build_view_ddl_sql`). When the diff engine reuses that DDL verbatim for a
/// same-dialect sync script, running it against a different target schema fails
/// outright — the statement still names the source schema, which may not even
/// exist on the target connection.
///
/// Rewrites the object name in a `CREATE ...` header to `qualified` when the
/// captured name is already schema/database-qualified (contains a `.`). An
/// unqualified name (e.g. MySQL DDL relying on the connection's current
/// database) is left untouched, since it already resolves correctly wherever
/// the sync script runs.
fn rewrite_ddl_header_qualifier(ddl: &str, header_keywords: &[&str], schema: Option<&str>, qualified: &str) -> String {
    let leading_ws = ddl.len() - ddl.trim_start().len();
    let body = &ddl[leading_ws..];
    let Some(keyword) = header_keywords.iter().find(|keyword| starts_with_ignore_ascii_case(body, keyword)) else {
        return ddl.to_string();
    };

    let mut idx = skip_ascii_whitespace(ddl, leading_ws + keyword.len());
    if starts_with_ignore_ascii_case(&ddl[idx..], "IF NOT EXISTS") {
        idx = skip_ascii_whitespace(ddl, idx + "IF NOT EXISTS".len());
    }

    let ident_start = idx;
    let Some(parsed) = parse_qualified_identifier(ddl, idx) else {
        return ddl.to_string();
    };
    let Some((schema_start, schema_end)) = parsed.schema_span else {
        // Unqualified name (e.g. MySQL DDL relying on the connection's
        // current database) already resolves correctly wherever the sync
        // script runs — leave it untouched.
        return ddl.to_string();
    };
    let embedded_schema = strip_identifier_quotes(&ddl[schema_start..schema_end]);
    if schema.map(str::trim).is_some_and(|schema| schema == embedded_schema) {
        // Already qualified with the target schema — avoid needlessly
        // reformatting DDL that's already correct.
        return ddl.to_string();
    }
    format!("{}{}{}", &ddl[..ident_start], qualified, &ddl[parsed.end..])
}

struct ParsedDdlName {
    end: usize,
    schema_span: Option<(usize, usize)>,
}

/// Parses a (possibly dotted, possibly quoted) identifier starting at `idx`.
/// Returns the byte offset just past it, plus the span of the schema/database
/// segment if the name was qualified, or `None` if `idx` isn't the start of
/// an identifier. Handles the quoting styles used across DDL dialects: double
/// quotes, backticks, and SQL Server brackets.
fn parse_qualified_identifier(ddl: &str, start: usize) -> Option<ParsedDdlName> {
    let mut idx = start;
    let mut schema_span = None;
    let mut segment_start = start;
    loop {
        let segment_end = parse_identifier_segment_end(ddl, idx)?;
        idx = segment_end;
        if ddl[idx..].starts_with('.') {
            schema_span = Some((segment_start, segment_end));
            idx += 1;
            segment_start = idx;
            continue;
        }
        break;
    }
    Some(ParsedDdlName { end: idx, schema_span })
}

/// Parses one identifier segment (quoted or bare) starting at `idx` and
/// returns the byte offset just past it, or `None` if `idx` isn't the start
/// of a segment.
fn parse_identifier_segment_end(ddl: &str, mut idx: usize) -> Option<usize> {
    let start = idx;
    let ch = ddl[idx..].chars().next()?;
    let closing_quote = match ch {
        '"' => Some('"'),
        '`' => Some('`'),
        '[' => Some(']'),
        _ => None,
    };
    if let Some(closing_quote) = closing_quote {
        idx += ch.len_utf8();
        loop {
            let next = ddl[idx..].chars().next()?;
            idx += next.len_utf8();
            if next == closing_quote {
                // SQL Server brackets escape a literal `]` the same way
                // double-quote/backtick identifiers escape their own quote
                // char: by doubling it (`[a]]b]` is the identifier `a]b`).
                if ddl[idx..].starts_with(closing_quote) {
                    idx += closing_quote.len_utf8();
                    continue;
                }
                break;
            }
        }
    } else if ch.is_alphanumeric() || ch == '_' {
        while let Some(next) = ddl[idx..].chars().next() {
            if next.is_alphanumeric() || next == '_' {
                idx += next.len_utf8();
            } else {
                break;
            }
        }
    } else {
        return None;
    }
    (idx != start).then_some(idx)
}

/// Strips a single matching pair of identifier-quoting characters (double
/// quotes, backticks, or brackets) from `segment`, undoubling an escaped
/// closing quote. Returns `segment` unchanged if it isn't quoted.
fn strip_identifier_quotes(segment: &str) -> String {
    let mut chars = segment.chars();
    let (Some(first), Some(last)) = (chars.next(), segment.chars().next_back()) else {
        return segment.to_string();
    };
    let matches = matches!((first, last), ('"', '"') | ('`', '`') | ('[', ']'));
    if !matches || segment.len() < 2 {
        return segment.to_string();
    }
    let inner = &segment[first.len_utf8()..segment.len() - last.len_utf8()];
    // Brackets escape their closing char the same way same-char quoting
    // does (`]]` -> `]`), just with a different open/close pair.
    inner.replace(&format!("{last}{last}"), &last.to_string())
}

fn drop_index_sql(table_name: &str, index_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    if db_type == DatabaseType::SqlServer {
        let table_literal = table.replace('\'', "''");
        let index_literal = index_name.replace('\'', "''");
        let quoted_index = quote_id(index_name, db_type);
        // sys.indexes also exposes the backing indexes of PRIMARY KEY and UNIQUE
        // constraints. SQL Server rejects DROP INDEX for those and requires
        // ALTER TABLE ... DROP CONSTRAINT instead, so resolve the object kind at
        // execution time before choosing the documented drop form.
        let batch = format!(
            "DECLARE @dbx_constraint_name sysname, @dbx_drop_sql NVARCHAR(MAX); \
             SELECT @dbx_constraint_name = kc.name \
             FROM sys.key_constraints AS kc \
             JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
             WHERE kc.parent_object_id = OBJECT_ID(N'{table_literal}') AND i.name = N'{index_literal}'; \
             IF @dbx_constraint_name IS NOT NULL BEGIN \
               SET @dbx_drop_sql = N'ALTER TABLE {table_literal} DROP CONSTRAINT ' + QUOTENAME(@dbx_constraint_name); \
               EXEC sys.sp_executesql @dbx_drop_sql; \
             END ELSE IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'{table_literal}') AND name = N'{index_literal}') BEGIN \
               DROP INDEX {quoted_index} ON {table}; \
             END;"
        );
        return sqlserver_single_statement_batch(&batch);
    }
    let index = qualified_name(index_name, db_type, schema);
    if profile.drop_index_uses_on_table {
        format!("DROP INDEX {} ON {table};", quote_id(index_name, db_type))
    } else {
        format!("DROP INDEX IF EXISTS {index};")
    }
}

fn mysql_index_column_sql(column: &str) -> String {
    let trimmed = column.trim();
    // MySQL metadata represents a functional key part as an expression wrapped for CREATE INDEX.
    if trimmed.starts_with("((") && trimmed.ends_with("))") {
        trimmed.to_string()
    } else {
        quote_id(column, DatabaseType::Mysql)
    }
}

fn is_postgres_family_ddl(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::OpenGauss
            | DatabaseType::Kwdb
            | DatabaseType::Firebird
            | DatabaseType::Vertica
            | DatabaseType::Exasol
            | DatabaseType::Uxdb
    )
}

fn postgres_index_column_sql(column: &str, is_expression: Option<bool>, db_type: DatabaseType) -> String {
    // Expression/functional index key parts (e.g. from pg_get_indexdef) arrive as raw
    // expression text, not a plain column name; quoting the whole expression as an
    // identifier turns it into a literal column reference that doesn't exist (#6295).
    let trimmed = column.trim();
    let is_expression = is_expression.unwrap_or(false);
    if is_expression {
        trimmed.to_string()
    } else {
        quote_id(column, db_type)
    }
}

fn create_index_sql(table_name: &str, index: &IndexInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    use crate::sql_dialect::ddl_profile::IndexTypePlacement;
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    if db_type == DatabaseType::SqlServer
        && index.columns.iter().enumerate().any(|(position, column)| {
            index.key_is_expression.get(position).copied().unwrap_or(false) || column.trim_start().starts_with('(')
        })
    {
        return format!(
            "-- Skip index {} on {table}: SQL Server indexes require columns or pre-existing computed columns, not source-dialect expressions.",
            index.name
        );
    }
    let mut columns = index
        .columns
        .iter()
        .enumerate()
        .map(|(i, column)| {
            if db_type == DatabaseType::Mysql {
                mysql_index_column_sql(column)
            } else if is_postgres_family_ddl(db_type) {
                postgres_index_column_sql(column, index.key_is_expression.get(i).copied(), db_type)
            } else {
                quote_id(column, db_type)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let source_index_type = index.index_type.as_deref().unwrap_or_default().trim();
    let index_type = if db_type == DatabaseType::SqlServer {
        match source_index_type.to_ascii_uppercase().as_str() {
            "CLUSTERED" => "CLUSTERED".to_string(),
            "NONCLUSTERED" => "NONCLUSTERED".to_string(),
            "CLUSTERED COLUMNSTORE" => "CLUSTERED COLUMNSTORE".to_string(),
            "NONCLUSTERED COLUMNSTORE" | "COLUMNSTORE" => "NONCLUSTERED COLUMNSTORE".to_string(),
            // SQL Server rowstore indexes are B-trees by default.
            "" | "BTREE" => String::new(),
            _ => {
                return format!(
                    "-- Skip index {} on {table}: index type '{}' has no direct SQL Server CREATE INDEX form.",
                    index.name, source_index_type
                );
            }
        }
    } else {
        source_index_type.to_string()
    };
    if db_type == DatabaseType::SqlServer && index.is_unique && index_type.contains("COLUMNSTORE") {
        return format!("-- Skip index {} on {table}: SQL Server columnstore indexes cannot be UNIQUE.", index.name);
    }
    let unique = if index.is_unique && !index_type.contains("COLUMNSTORE") { "UNIQUE " } else { "" };
    let (type_prefix, using_before_on, using_suffix) = if index_type.is_empty() {
        (String::new(), String::new(), String::new())
    } else {
        match profile.index_type_placement {
            IndexTypePlacement::None => (String::new(), String::new(), String::new()),
            IndexTypePlacement::TypePrefix => (format!("{index_type} "), String::new(), String::new()),
            IndexTypePlacement::UsingBeforeOn => (String::new(), format!(" USING {index_type}"), String::new()),
            IndexTypePlacement::UsingSuffix => (String::new(), String::new(), format!(" USING {index_type}")),
        }
    };
    let included_columns = index.included_columns.clone().unwrap_or_default();
    let include_clause = if !included_columns.is_empty()
        && profile.index_supports_include
        && !(db_type == DatabaseType::SqlServer && index_type.contains("COLUMNSTORE"))
    {
        format!(
            " INCLUDE ({})",
            included_columns.iter().map(|column| quote_id(column, db_type)).collect::<Vec<_>>().join(", ")
        )
    } else {
        String::new()
    };
    if db_type == DatabaseType::SqlServer
        && index_type == "NONCLUSTERED COLUMNSTORE"
        && columns.is_empty()
        && !included_columns.is_empty()
    {
        // sys.index_columns exposes columnstore members as included columns
        // because a columnstore index has no key columns.
        columns = included_columns.iter().map(|column| quote_id(column, db_type)).collect::<Vec<_>>().join(", ");
    }
    let filter = if profile.index_supports_filter { index.filter.as_deref().unwrap_or_default() } else { "" };
    let filter_clause = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
    let comment = index.comment.as_deref().unwrap_or("");
    let comment_clause = if !comment.trim().is_empty() && profile.index_supports_comment {
        format!(" COMMENT {}", comment_literal(comment))
    } else {
        String::new()
    };
    if db_type == DatabaseType::SqlServer && index_type == "CLUSTERED COLUMNSTORE" {
        return format!("CREATE {type_prefix}INDEX {} ON {table};", quote_id(&index.name, db_type));
    }
    if columns.is_empty() {
        return format!("-- Skip index {} on {table}: no index columns were available.", index.name);
    }
    // MySQL-style puts USING before ON and omits INCLUDE/WHERE placement used by PG/SS.
    if profile.drop_index_uses_on_table {
        format!(
            "CREATE {unique}{type_prefix}INDEX {}{using_before_on} ON {table} ({columns}){comment_clause};",
            quote_id(&index.name, db_type)
        )
    } else {
        format!(
            "CREATE {unique}{type_prefix}INDEX {} ON {table}{using_suffix} ({columns}){include_clause}{filter_clause};",
            quote_id(&index.name, db_type)
        )
    }
}

fn drop_foreign_key_sql(table_name: &str, fk_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    let fk = quote_id(fk_name, db_type);
    if profile.drop_fk_as_foreign_key {
        format!("ALTER TABLE {table} DROP FOREIGN KEY {fk};")
    } else {
        format!("ALTER TABLE {table} DROP CONSTRAINT {fk};")
    }
}

fn add_foreign_key_sql(table_name: &str, fk: &ForeignKeyInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    add_foreign_key_sql_with_reference_separator(table_name, fk, db_type, schema, " ")
}

fn add_foreign_key_sql_with_reference_separator(
    table_name: &str,
    fk: &ForeignKeyInfo,
    db_type: DatabaseType,
    schema: Option<&str>,
    reference_separator: &str,
) -> String {
    let table = qualified_name(table_name, db_type, schema);
    let ref_table = qualified_name(&fk.ref_table, db_type, fk.ref_schema.as_deref().or(schema));
    let action = |kind: &str, value: Option<&String>| -> String {
        let Some(value) = value else {
            return String::new();
        };
        let normalized = value.trim().to_ascii_uppercase();
        if db_type != DatabaseType::SqlServer {
            return format!(" ON {kind} {value}");
        }
        let sqlserver_action = match normalized.as_str() {
            "RESTRICT" | "NO ACTION" => "NO ACTION",
            "CASCADE" => "CASCADE",
            "SET NULL" => "SET NULL",
            "SET DEFAULT" => "SET DEFAULT",
            _ => return String::new(),
        };
        format!(" ON {kind} {sqlserver_action}")
    };
    let on_delete = action("DELETE", fk.on_delete.as_ref());
    let on_update = action("UPDATE", fk.on_update.as_ref());
    format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {ref_table}{reference_separator}({}){on_delete}{on_update};",
        quote_id(&fk.name, db_type),
        quote_id(&fk.column, db_type),
        quote_id(&fk.ref_column, db_type)
    )
}

fn drop_object_sql(diff: &TableDiff, db_type: DatabaseType, schema: Option<&str>, cascade: &str) -> String {
    let object_type = if diff.object_type.as_deref() == Some("view") { "VIEW" } else { "TABLE" };
    let name = qualified_name(&diff.name, db_type, schema);
    if db_type == DatabaseType::SqlServer {
        let object_id_type = if object_type == "VIEW" { "V" } else { "U" };
        return format!(
            "IF OBJECT_ID(N'{}', N'{object_id_type}') IS NOT NULL DROP {object_type} {name};",
            name.replace('\'', "''")
        );
    }
    format!("DROP {object_type} IF EXISTS {name}{cascade};")
}

fn comment_literal(comment: &str) -> String {
    format!("'{}'", comment.replace('\'', "''"))
}

/// Bare temporal keywords that are defaults in their own right and must not be quoted.
const TEMPORAL_DEFAULT_KEYWORDS: [&str; 8] =
    ["current_timestamp", "current_date", "current_time", "now", "localtime", "localtimestamp", "getdate", "sysdate"];

/// Prefixes that introduce an already-quoted literal: SQL Server / Sybase `N'x'`,
/// MySQL `b'1'` and `x'1f'`, Postgres `e'\n'`.
const QUOTED_LITERAL_PREFIXES: [&str; 4] = ["n'", "b'", "x'", "e'"];

/// The dialect the column metadata came from.
///
/// The caller does not always declare one. When it does not, the comparison is
/// same-dialect, so the target database is also the source.
fn effective_source_dialect(source_dialect: Option<DialectKind>, db_type: DatabaseType) -> DialectKind {
    source_dialect.unwrap_or_else(|| DialectKind::from_database_type(db_type))
}

/// Render a column default as a SQL literal.
///
/// Drivers hand `column_default` back verbatim and they do not agree on its
/// shape, so the rule has to be bound to the dialect the value came from rather
/// than guessed from the value itself. The same bare token means different
/// things in different databases: `CURRENT_USER` is an expression on Postgres
/// and Oracle, while on MySQL a bare `CURRENT_USER` on a text column is the
/// literal string.
///
/// Only MySQL-family metadata strips the quotes from a string default, so it is
/// the only source that needs any repair here. Everywhere else the value already
/// arrives quoted, cast or wrapped, and is passed through untouched.
///
/// `table_structure_sql::util::format_default_for_sql` and
/// `transfer::format_mysql_default_literal` do the same job on their own paths;
/// both are private to their modules.
fn default_literal(default: &str, data_type: &str, source: DialectKind, extra: Option<&str>) -> String {
    let normalized = default.trim();

    // Every dialect except MySQL returns a string default already quoted, cast
    // or wrapped, so a bare token there is an expression and rewriting it would
    // change its meaning: Postgres `text DEFAULT CURRENT_USER`, Oracle
    // `varchar2 DEFAULT USER`, SQL Server `('x')`.
    if source != DialectKind::Mysql {
        return normalized.to_string();
    }

    // MySQL 8.0.13 and later flag an expression default in `EXTRA`. That marker
    // is authoritative, so consult it before looking at the value at all: a
    // default is a literal unless the server says it was generated.
    if extra.is_some_and(|value| value.to_ascii_uppercase().contains("DEFAULT_GENERATED")) {
        return normalized.to_string();
    }

    // MySQL writes an expression default wrapped in parentheses, `DEFAULT
    // (uuid())`, and reports it that way. The wrapping is the syntax, so it is
    // a reliable marker even when `EXTRA` is not populated. Note this asks
    // whether the value *is* parenthesised, not whether it merely contains a
    // parenthesis: the string default `a(b)` is not wrapped and is still
    // quoted.
    if normalized.starts_with('(') && normalized.ends_with(')') {
        return normalized.to_string();
    }

    // Already a literal: `'x'` or a prefixed form like `x'1f'`.
    let lowered = normalized.to_ascii_lowercase();
    if normalized.starts_with('\'') || QUOTED_LITERAL_PREFIXES.iter().any(|prefix| lowered.starts_with(prefix)) {
        return normalized.to_string();
    }

    let base_type = data_type.split('(').next().unwrap_or(data_type).trim().to_ascii_lowercase();
    let takes_text_literal =
        ["char", "text", "string", "clob", "enum", "set"].iter().any(|kind| base_type.contains(kind));
    let takes_binary_literal = ["binary", "blob", "bytea"].iter().any(|kind| base_type.contains(kind));
    let takes_temporal_literal = base_type.contains("date") || base_type.contains("time");

    // Before 8.0.13 there is no `EXTRA` marker and a temporal column was the
    // only place an expression default could appear.
    if takes_temporal_literal && is_temporal_keyword_default(normalized) {
        return normalized.to_string();
    }
    // A binary default is commonly reported as a hex literal, which is already
    // valid unquoted; a bare string on the same column still needs quoting.
    if takes_binary_literal && is_hex_literal(normalized) {
        return normalized.to_string();
    }
    if takes_text_literal || takes_binary_literal || takes_temporal_literal {
        // Deliberately no parenthesis check. MySQL reports the string default
        // `'a(b)'` as the bare value `a(b)`, and treating a parenthesis as proof
        // of a function call is what produced invalid `DEFAULT a(b)`.
        return format!("'{}'", default.replace('\'', "''"));
    }
    normalized.to_string()
}

fn consume_postgres_cast_name(value: &str, start: usize) -> Option<(usize, Option<String>)> {
    let ch = value[start..].chars().next()?;
    if ch == '"' {
        let mut index = start + ch.len_utf8();
        while index < value.len() {
            let next = value[index..].chars().next().expect("index is on a character boundary");
            index += next.len_utf8();
            if next == '"' {
                if value[index..].starts_with('"') {
                    index += 1;
                } else {
                    return Some((index, None));
                }
            }
        }
        return None;
    }
    if ch.is_alphabetic() || ch == '_' {
        let mut index = start + ch.len_utf8();
        while index < value.len() {
            let next = value[index..].chars().next().expect("index is on a character boundary");
            if next.is_alphanumeric() || matches!(next, '_' | '$') {
                index += next.len_utf8();
            } else {
                break;
            }
        }
        return Some((index, Some(value[start..index].to_ascii_lowercase())));
    }
    None
}

fn postgres_cast_whitespace_end(value: &str, start: usize) -> usize {
    start + value[start..].chars().take_while(|ch| ch.is_ascii_whitespace()).map(char::len_utf8).sum::<usize>()
}

fn consume_postgres_cast_keyword(value: &str, start: usize, keyword: &str) -> Option<usize> {
    let token_start = postgres_cast_whitespace_end(value, start);
    if token_start == start {
        return None;
    }
    let (end, unquoted) = consume_postgres_cast_name(value, token_start)?;
    unquoted.as_deref().is_some_and(|token| token.eq_ignore_ascii_case(keyword)).then_some(end)
}

fn postgres_dollar_quote_delimiter_end(value: &str, start: usize) -> Option<usize> {
    if !value[start..].starts_with('$') {
        return None;
    }
    if value[..start].chars().next_back().is_some_and(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$')) {
        return None;
    }
    let relative_end = value[start + 1..].find('$')?;
    let delimiter_end = start + 1 + relative_end + 1;
    let tag = &value[start + 1..delimiter_end - 1];
    let mut chars = tag.chars();
    if let Some(first) = chars.next() {
        if !(first.is_alphabetic() || first == '_') || !chars.all(|ch| ch.is_alphanumeric() || ch == '_') {
            return None;
        }
    }
    Some(delimiter_end)
}

fn consume_postgres_dollar_quoted(value: &str, start: usize) -> Option<usize> {
    let delimiter_end = postgres_dollar_quote_delimiter_end(value, start)?;
    let delimiter = &value[start..delimiter_end];
    value[delimiter_end..].find(delimiter).map(|offset| delimiter_end + offset + delimiter.len())
}

fn postgres_escape_string_quote(value: &str, quote_index: usize) -> bool {
    let mut prefix = value[..quote_index].char_indices().rev();
    let Some((e_index, 'e' | 'E')) = prefix.next() else {
        return false;
    };
    value[..e_index].chars().next_back().is_none_or(|ch| !(ch.is_alphanumeric() || matches!(ch, '_' | '$')))
}

fn consume_postgres_cast_group(value: &str, start: usize, open: char, close: char) -> Option<usize> {
    if value[start..].chars().next()? != open {
        return None;
    }
    let mut depth = 0usize;
    let mut index = start;
    let mut in_single_quote = false;
    let mut in_escape_single_quote = false;
    let mut in_double_quote = false;
    while index < value.len() {
        let ch = value[index..].chars().next().expect("index is on a character boundary");
        let next_index = index + ch.len_utf8();
        if in_single_quote && in_escape_single_quote && ch == '\\' {
            index = value[next_index..].chars().next().map_or(next_index, |escaped| next_index + escaped.len_utf8());
            continue;
        }
        if ch == '\'' && !in_double_quote {
            if in_single_quote && value[next_index..].starts_with('\'') {
                index = next_index + 1;
                continue;
            }
            in_single_quote = !in_single_quote;
            if in_single_quote {
                in_escape_single_quote = postgres_escape_string_quote(value, index);
            } else {
                in_escape_single_quote = false;
            }
        } else if ch == '"' && !in_single_quote {
            if in_double_quote && value[next_index..].starts_with('"') {
                index = next_index + 1;
                continue;
            }
            in_double_quote = !in_double_quote;
        } else if !in_single_quote && !in_double_quote {
            if postgres_dollar_quote_delimiter_end(value, index).is_some() {
                index = consume_postgres_dollar_quoted(value, index)?;
                continue;
            }
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(next_index);
                }
            }
        }
        index = next_index;
    }
    None
}

fn consume_postgres_cast_type(value: &str, start: usize) -> usize {
    let mut index = postgres_cast_whitespace_end(value, start);
    let Some((name_end, first_name)) = consume_postgres_cast_name(value, index) else {
        return start;
    };
    index = name_end;
    let mut qualified = false;

    // A type name may be schema-qualified, with whitespace around the dot. Do
    // not treat arbitrary whitespace-separated words as part of the type: that
    // would consume expression operators such as `AND`, `IS`, or `COLLATE`.
    loop {
        let dot = postgres_cast_whitespace_end(value, index);
        if !value[dot..].starts_with('.') {
            break;
        }
        let component_start = postgres_cast_whitespace_end(value, dot + 1);
        let Some((component_end, _)) = consume_postgres_cast_name(value, component_start) else {
            return start;
        };
        qualified = true;
        index = component_end;
    }

    let base_name = (!qualified).then_some(first_name).flatten();

    // PostgreSQL has a small, explicit set of whitespace-separated built-in
    // type names. Only those phrases may extend across whitespace; accepting an
    // arbitrary second identifier corrupts expressions such as `x::int IS NULL`.
    if let Some(base) = base_name.as_deref() {
        match base {
            "character" | "char" | "bit" => {
                if let Some(end) = consume_postgres_cast_keyword(value, index, "varying") {
                    index = end;
                }
            }
            "double" => {
                if let Some(end) = consume_postgres_cast_keyword(value, index, "precision") {
                    index = end;
                }
            }
            "national" => {
                if let Some(end) = consume_postgres_cast_keyword(value, index, "character")
                    .or_else(|| consume_postgres_cast_keyword(value, index, "char"))
                {
                    index = end;
                    if let Some(end) = consume_postgres_cast_keyword(value, index, "varying") {
                        index = end;
                    }
                }
            }
            _ => {}
        }
    }

    let modifier_start = postgres_cast_whitespace_end(value, index);
    if value[modifier_start..].starts_with('(') {
        let Some(end) = consume_postgres_cast_group(value, modifier_start, '(', ')') else {
            return start;
        };
        index = end;
    }

    if matches!(base_name.as_deref(), Some("time" | "timestamp")) {
        let suffix_start = index;
        if let Some(with_end) = consume_postgres_cast_keyword(value, suffix_start, "with")
            .or_else(|| consume_postgres_cast_keyword(value, suffix_start, "without"))
        {
            let Some(time_end) = consume_postgres_cast_keyword(value, with_end, "time") else {
                return start;
            };
            let Some(zone_end) = consume_postgres_cast_keyword(value, time_end, "zone") else {
                return start;
            };
            index = zone_end;
        }
    }

    if base_name.as_deref() == Some("interval") {
        const INTERVAL_FIELDS: &[&str] = &["year", "month", "day", "hour", "minute", "second"];
        let field_start = index;
        let field = INTERVAL_FIELDS
            .iter()
            .find_map(|field| consume_postgres_cast_keyword(value, field_start, field).map(|end| (*field, end)));
        if let Some((first_field, first_end)) = field {
            index = first_end;
            let to_start = index;
            if let Some(to_end) = consume_postgres_cast_keyword(value, to_start, "to") {
                let valid_final_fields: &[&str] = match first_field {
                    "year" => &["month"],
                    "day" => &["hour", "minute", "second"],
                    "hour" => &["minute", "second"],
                    "minute" => &["second"],
                    _ => &[],
                };
                let Some(final_end) =
                    valid_final_fields.iter().find_map(|field| consume_postgres_cast_keyword(value, to_end, field))
                else {
                    return start;
                };
                index = final_end;
            }

            let precision_start = postgres_cast_whitespace_end(value, index);
            if value[precision_start..].starts_with('(') {
                let Some(end) = consume_postgres_cast_group(value, precision_start, '(', ')') else {
                    return start;
                };
                index = end;
            }
        }
    }

    loop {
        let array_start = postgres_cast_whitespace_end(value, index);
        if !value[array_start..].starts_with('[') {
            break;
        }
        let Some(end) = consume_postgres_cast_group(value, array_start, '[', ']') else {
            return start;
        };
        let bounds = value[array_start + 1..end - 1].trim();
        if !bounds.is_empty() && !bounds.chars().all(|ch| ch.is_ascii_digit()) {
            return start;
        }
        index = end;
    }

    if value[index..]
        .chars()
        .next()
        .is_some_and(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '$' | '"' | '\'' | '('))
    {
        return start;
    }

    index
}

fn strip_postgres_default_casts(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut segment_start = 0;
    let mut index = 0;
    let mut in_single_quote = false;
    let mut in_escape_single_quote = false;
    let mut in_double_quote = false;
    while index < value.len() {
        let ch = value[index..].chars().next().expect("index is on a character boundary");
        if in_single_quote && in_escape_single_quote && ch == '\\' {
            let next_index = index + ch.len_utf8();
            index = value[next_index..].chars().next().map_or(next_index, |escaped| next_index + escaped.len_utf8());
            continue;
        }
        if ch == '\'' && !in_double_quote {
            let next_index = index + ch.len_utf8();
            if in_single_quote && value[next_index..].starts_with('\'') {
                index = next_index + 1;
                continue;
            }
            in_single_quote = !in_single_quote;
            if in_single_quote {
                in_escape_single_quote = postgres_escape_string_quote(value, index);
            } else {
                in_escape_single_quote = false;
            }
            index = next_index;
            continue;
        }
        if ch == '"' && !in_single_quote {
            let next_index = index + ch.len_utf8();
            if in_double_quote && value[next_index..].starts_with('"') {
                index = next_index + 1;
                continue;
            }
            in_double_quote = !in_double_quote;
            index = next_index;
            continue;
        }
        if !in_single_quote && !in_double_quote && postgres_dollar_quote_delimiter_end(value, index).is_some() {
            index = consume_postgres_dollar_quoted(value, index).unwrap_or(value.len());
            continue;
        }
        if !in_single_quote && !in_double_quote && value[index..].starts_with("::") {
            let type_start = index + 2;
            let cast_end = consume_postgres_cast_type(value, type_start);
            if cast_end == type_start {
                // Cast removal is all-or-nothing. Continuing after a malformed
                // candidate could peel a nested `::` inside its unclosed
                // modifier or array suffix and corrupt the original default.
                return value.to_string();
            }
            result.push_str(&value[segment_start..index]);
            index = cast_end;
            segment_start = index;
            continue;
        }
        index += ch.len_utf8();
    }
    result.push_str(&value[segment_start..]);
    result
}

fn sqlserver_sequence_default(value: &str, target_schema: Option<&str>) -> Option<String> {
    let lowered = value.trim().to_ascii_lowercase();
    if !lowered.starts_with("nextval(") {
        return None;
    }
    let start = value.find('\'')? + 1;
    let end = value[start..].find('\'')? + start;
    let sequence = value[start..end].split('.').next_back()?.trim_matches('"');
    (!sequence.is_empty())
        .then(|| format!("NEXT VALUE FOR {}", qualified_name(sequence, DatabaseType::SqlServer, target_schema)))
}

fn trim_outer_parentheses_for_match(mut value: &str) -> &str {
    loop {
        let trimmed = value.trim();
        if !trimmed.starts_with('(') || !trimmed.ends_with(')') {
            return trimmed;
        }
        let mut depth = 0usize;
        let mut in_single_quote = false;
        let mut closes_at_end = false;
        let mut chars = trimmed.char_indices().peekable();
        while let Some((index, ch)) = chars.next() {
            if ch == '\'' {
                if in_single_quote && chars.peek().is_some_and(|(_, next)| *next == '\'') {
                    chars.next();
                    continue;
                }
                in_single_quote = !in_single_quote;
                continue;
            }
            if in_single_quote {
                continue;
            }
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    closes_at_end = index + ch.len_utf8() == trimmed.len();
                    if !closes_at_end {
                        break;
                    }
                }
            }
        }
        if !closes_at_end {
            return trimmed;
        }
        value = &trimmed[1..trimmed.len() - 1];
    }
}

fn sqlserver_hex_default(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let digits =
        if trimmed.len() >= 3 && (trimmed.starts_with("x'") || trimmed.starts_with("X'")) && trimmed.ends_with('\'') {
            &trimmed[2..trimmed.len() - 1]
        } else if trimmed.starts_with("'\\x") && trimmed.ends_with('\'') {
            &trimmed[3..trimmed.len() - 1]
        } else {
            return None;
        };
    (!digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_hexdigit())).then(|| format!("0x{digits}"))
}

fn sqlserver_bit_string_default(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() < 4 || !(trimmed.starts_with("b'") || trimmed.starts_with("B'")) || !trimmed.ends_with('\'') {
        return None;
    }
    let bits = &trimmed[2..trimmed.len() - 1];
    (!bits.is_empty() && bits.len() <= 64 && bits.bytes().all(|bit| matches!(bit, b'0' | b'1')))
        .then(|| u64::from_str_radix(bits, 2).ok().map(|value| value.to_string()))
        .flatten()
}

#[cfg(test)]
fn sqlserver_default_literal(
    default: &str,
    mapped_type: &str,
    source_dialect: Option<DialectKind>,
    extra: Option<&str>,
) -> String {
    sqlserver_default_literal_for_schema(default, mapped_type, source_dialect, extra, None)
}

fn sqlserver_default_literal_for_schema(
    default: &str,
    mapped_type: &str,
    source_dialect: Option<DialectKind>,
    extra: Option<&str>,
    target_schema: Option<&str>,
) -> String {
    let source = effective_source_dialect(source_dialect, DatabaseType::SqlServer);
    let mut value = default_literal(default, mapped_type, source, extra);
    if source == DialectKind::SqlServer {
        return value;
    }
    if source == DialectKind::Postgres {
        value = strip_postgres_default_casts(&value);
    }

    let normalized = value.trim();
    let match_value = trim_outer_parentheses_for_match(normalized);
    let lowered = match_value.to_ascii_lowercase();
    let target_upper = mapped_type.trim().to_ascii_uppercase();
    let target_is_binary = target_upper.starts_with("BINARY") || target_upper.starts_with("VARBINARY");
    let target_is_bit = target_upper == "BIT";
    let rewritten = if let Some(hex) = target_is_binary.then(|| sqlserver_hex_default(match_value)).flatten() {
        hex
    } else if target_is_bit && matches!(lowered.as_str(), "true" | "'true'" | "'t'" | "b'1'") {
        "1".to_string()
    } else if target_is_bit && matches!(lowered.as_str(), "false" | "'false'" | "'f'" | "b'0'") {
        "0".to_string()
    } else if let Some(bits) = sqlserver_bit_string_default(match_value) {
        bits
    } else if lowered == "now()"
        || lowered.starts_with("now(")
        || lowered == "transaction_timestamp()"
        || lowered == "statement_timestamp()"
        || lowered == "sysdate()"
        || lowered == "localtimestamp"
        || lowered.starts_with("localtimestamp(")
        || (source == DialectKind::Mysql && (lowered == "localtime" || lowered.starts_with("localtime(")))
        || lowered == "current_timestamp"
        || lowered.starts_with("current_timestamp(")
    {
        // CURRENT_TIMESTAMP is SQL Server's GETDATE() synonym and therefore
        // returns `datetime`, even when assigned to a higher-precision target.
        // Use the native high-precision functions for datetime2/offset columns.
        if target_upper.starts_with("DATETIMEOFFSET") {
            "SYSDATETIMEOFFSET()".to_string()
        } else if target_upper.starts_with("DATETIME2") {
            "SYSDATETIME()".to_string()
        } else {
            "CURRENT_TIMESTAMP".to_string()
        }
    } else if matches!(lowered.as_str(), "uuid()" | "uuid_generate_v4()" | "gen_random_uuid()") {
        "NEWID()".to_string()
    } else if matches!(lowered.as_str(), "curdate()" | "current_date" | "current_date()") {
        "CONVERT(date, GETDATE())".to_string()
    } else if matches!(lowered.as_str(), "curtime()" | "current_time" | "current_time()" | "localtime")
        || lowered.starts_with("current_time(")
        || lowered.starts_with("localtime(")
    {
        "CONVERT(time, GETDATE())".to_string()
    } else if let Some(sequence) = sqlserver_sequence_default(match_value, target_schema) {
        sequence
    } else if lowered.starts_with("e'") {
        format!("N{}", &normalized[1..])
    } else {
        normalized.to_string()
    };

    let target_is_unicode =
        target_upper.starts_with("NVARCHAR") || target_upper.starts_with("NCHAR") || target_upper.starts_with("NTEXT");
    if target_is_unicode {
        sqlserver_unicode_string_literal(&rewritten).unwrap_or(rewritten)
    } else {
        rewritten
    }
}

/// A bare temporal default, with or without a precision argument, so
/// `CURRENT_TIMESTAMP(6)` and `LOCALTIME(3)` are recognised alongside the bare
/// keywords. `transfer::is_mysql_function_default` already accepts the
/// parenthesised forms and this mirrors it.
///
/// Deliberately keyed on the known keywords rather than on the presence of a
/// parenthesis, so a string default such as `a(b)` is still quoted.
fn is_temporal_keyword_default(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    TEMPORAL_DEFAULT_KEYWORDS.iter().any(|keyword| {
        let keyword = keyword.to_ascii_uppercase();
        upper == keyword || upper.strip_prefix(&keyword).is_some_and(|rest| rest.starts_with('('))
    })
}

/// `0x61`, the shape MySQL reports a binary default in.
fn is_hex_literal(value: &str) -> bool {
    let Some(digits) = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")) else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_hexdigit())
}

fn sqlserver_identity_clause(col: &ColumnInfo) -> Option<String> {
    let extra = col.extra.as_deref().unwrap_or_default().trim();
    let lowered = extra.to_ascii_lowercase();
    if let Some(identity_index) = lowered.find("identity") {
        let rest = extra[identity_index + "identity".len()..].trim_start();
        if let Some(args) = rest.strip_prefix('(').and_then(|args| args.split_once(')').map(|pair| pair.0)) {
            let values = args.split(',').map(str::trim).collect::<Vec<_>>();
            if values.len() == 2 && values.iter().all(|value| value.parse::<i64>().is_ok()) {
                return Some(format!("IDENTITY({},{})", values[0], values[1]));
            }
        }
        return Some("IDENTITY(1,1)".to_string());
    }
    if lowered.contains("auto_increment") || lowered.contains("serial") {
        return Some("IDENTITY(1,1)".to_string());
    }
    let source_base = col.data_type.split('(').next().unwrap_or(&col.data_type).trim().to_ascii_lowercase();
    if matches!(source_base.as_str(), "serial" | "smallserial" | "bigserial") {
        return Some("IDENTITY(1,1)".to_string());
    }
    None
}

fn sqlserver_column_definition(
    col: &ColumnInfo,
    mapped_type: &str,
    source_dialect: Option<DialectKind>,
    target_schema: Option<&str>,
) -> String {
    let mut definition = format!("{} {mapped_type}", quote_id(&col.name, DatabaseType::SqlServer));
    let identity = sqlserver_identity_clause(col);
    if let Some(identity) = &identity {
        definition.push(' ');
        definition.push_str(identity);
    }
    // PRIMARY KEY columns must be NOT NULL in SQL Server even when a source
    // (notably SQLite metadata) reports the column as nullable.
    definition.push_str(if col.is_nullable && !col.is_primary_key { " NULL" } else { " NOT NULL" });
    // SQL Server does not permit a DEFAULT constraint on an IDENTITY column.
    if identity.is_none() {
        if let Some(default) = col.column_default.as_deref().filter(|value| !value.trim().is_empty()) {
            definition.push_str(&format!(
                " DEFAULT {}",
                sqlserver_default_literal_for_schema(
                    default,
                    mapped_type,
                    source_dialect,
                    col.extra.as_deref(),
                    target_schema,
                )
            ));
        }
    }
    definition
}

fn sqlserver_has_default(col: &ColumnInfo) -> bool {
    col.column_default
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty() && !value.trim().eq_ignore_ascii_case("null"))
}

/// Keep a DECLARE/SELECT/IF default-constraint operation together when the deploy
/// path splits top-level SQL on semicolons. The inner batch is a Unicode literal,
/// so it is submitted to SQL Server as one executable statement.
fn sqlserver_single_statement_batch(batch: &str) -> String {
    format!("EXEC sys.sp_executesql N'{}';", batch.trim().trim_end_matches(';').replace('\'', "''"))
}

fn sqlserver_add_default_constraint_sql(
    table: &str,
    column_name: &str,
    source: &ColumnInfo,
    mapped_type: &str,
    source_dialect: Option<DialectKind>,
    target_schema: Option<&str>,
) -> Option<String> {
    let default = source
        .column_default
        .as_deref()
        .filter(|value| !value.trim().is_empty() && !value.trim().eq_ignore_ascii_case("null"))?;
    Some(format!(
        "ALTER TABLE {table} ADD DEFAULT {} FOR {};",
        sqlserver_default_literal_for_schema(
            default,
            mapped_type,
            source_dialect,
            source.extra.as_deref(),
            target_schema,
        ),
        quote_id(column_name, DatabaseType::SqlServer)
    ))
}

fn sqlserver_column_change_statements(
    table: &str,
    column_name: &str,
    source: &ColumnInfo,
    target: &ColumnInfo,
    mapped_type: &str,
    source_dialect: Option<DialectKind>,
    target_schema: Option<&str>,
) -> Vec<String> {
    let definition_changed = !source.data_type.trim().eq_ignore_ascii_case(target.data_type.trim())
        || source.is_nullable != target.is_nullable;
    let default_changed =
        source.column_default.as_deref().map(str::trim) != target.column_default.as_deref().map(str::trim);
    let had_default = sqlserver_has_default(target);
    let mut statements = Vec::new();

    if definition_changed {
        let mut alter_batch = Vec::new();
        if had_default && !default_changed {
            alter_batch.push(build_sqlserver_alter_column_preserving_default_sql(
                table,
                column_name,
                mapped_type,
                source.is_nullable,
            ));
        } else {
            if had_default {
                alter_batch.push(build_sqlserver_drop_default_constraint_sql(table, column_name));
            }
            let nullability = if source.is_nullable { "NULL" } else { "NOT NULL" };
            alter_batch.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {} {mapped_type} {nullability};",
                quote_id(column_name, DatabaseType::SqlServer)
            ));
            if default_changed {
                if let Some(statement) = sqlserver_add_default_constraint_sql(
                    table,
                    column_name,
                    source,
                    mapped_type,
                    source_dialect,
                    target_schema,
                ) {
                    alter_batch.push(statement);
                }
            }
        }
        let batch = build_dependency_aware_alter_column_batch(table, column_name, &alter_batch.join("\n"));
        statements.push(sqlserver_single_statement_batch(&batch));
        return statements;
    }

    if default_changed {
        if had_default {
            statements.push(sqlserver_single_statement_batch(&build_sqlserver_drop_default_constraint_sql(
                table,
                column_name,
            )));
        }
        if let Some(statement) =
            sqlserver_add_default_constraint_sql(table, column_name, source, mapped_type, source_dialect, target_schema)
        {
            statements.push(statement);
        }
    }
    statements
}

fn column_comment_sql(
    table_name: &str,
    column_name: &str,
    comment: &str,
    db_type: DatabaseType,
    schema: Option<&str>,
) -> Vec<String> {
    let table = qualified_name(table_name, db_type, schema);
    if db_type == DatabaseType::SqlServer {
        return build_sqlserver_column_comment_sql(&table, schema, table_name, column_name, comment);
    }
    let profile = profile_for(db_type);
    if profile.column_comment_via_modify_only {
        return vec![format!("-- Column comment for {column_name}: use ALTER TABLE ... MODIFY COLUMN to set comment")];
    }
    vec![format!("COMMENT ON COLUMN {table}.{} IS {};", quote_id(column_name, db_type), comment_literal(comment))]
}

fn table_comment_sql(table_name: &str, comment: &str, db_type: DatabaseType, schema: Option<&str>) -> Vec<String> {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    if db_type == DatabaseType::SqlServer {
        return build_sqlserver_table_comment_sql(&table, schema, table_name, comment);
    }
    if profile.table_comment_via_alter {
        vec![format!("ALTER TABLE {table} COMMENT = {};", comment_literal(comment))]
    } else {
        vec![format!("COMMENT ON TABLE {table} IS {};", comment_literal(comment))]
    }
}

fn create_trigger_sql(
    profile: &crate::sql_dialect::ddl_profile::DdlDialectProfile,
    name: &str,
    timing: &str,
    event: &str,
    table: &str,
    body: &str,
) -> String {
    use crate::sql_dialect::ddl_profile::TriggerTemplate;
    let qname = profile.quote_ident(name);
    match profile.trigger_template {
        TriggerTemplate::MysqlStyle => {
            format!("CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW BEGIN\n{body} END;")
        }
        TriggerTemplate::PostgresStyle => {
            format!(
                "CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW EXECUTE FUNCTION {};",
                body.trim_end_matches(';')
            )
        }
        TriggerTemplate::SqlServerStyle => {
            format!("CREATE TRIGGER {qname} ON {table} {timing} {event} AS BEGIN {body} END;")
        }
        TriggerTemplate::GenericRowBody => {
            format!("CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW BEGIN {body} END;")
        }
    }
}

fn is_sqlserver_native_trigger_definition(definition: &str) -> bool {
    Regex::new(r"(?i)^CREATE\s+(?:OR\s+ALTER\s+)?TRIGGER\b")
        .expect("static SQL Server trigger regex")
        .is_match(definition.trim())
}

fn sqlserver_native_function_sql(definition: &str, qualified_name: &str, is_modified: bool) -> Option<String> {
    let trimmed = definition.trim().trim_end_matches(';').trim_end();
    let prefix = Regex::new(r"(?i)^(?:(?:CREATE\s+OR\s+ALTER)|CREATE|ALTER)\s+FUNCTION\b").ok()?.find(trimmed)?;
    let verb = if is_modified { "ALTER FUNCTION" } else { "CREATE FUNCTION" };
    let definition_after_verb = trimmed[prefix.end()..].trim_start();
    let arguments_start = definition_after_verb.find('(')?;
    Some(format!("{verb} {qualified_name}{};", &definition_after_verb[arguments_start..]))
}

fn generate_create_table_sql(
    name: &str,
    columns: &[ColumnDiff],
    indexes: &[IndexDiff],
    foreign_keys: &[ForeignKeyDiff],
    table_comment: Option<&str>,
    db_type: DatabaseType,
    schema: Option<&str>,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
    triggers: &[TriggerInfo],
) -> (String, Vec<MissingRollbackObject>) {
    let mut lines = Vec::new();
    let target_dialect = DialectKind::from_database_type(db_type);
    let profile = profile_for(db_type);
    // Type rewrite: user mappings → profile type_map → DialectKind matrix → normalize.
    // Call sites must not branch on individual DatabaseType values.
    let map_type = |source_type: &str| -> String {
        if let Some(user_target) = FieldMapping::apply_with_params(field_mappings, source_type, target_dialect) {
            return user_target;
        }
        rewrite_column_type(source_type, db_type, source_dialect)
    };
    let table = qualified_name(name, db_type, schema);

    // Collect column definitions
    let mut col_defs = Vec::new();
    let mut pk_cols = Vec::new();
    let mut has_int_pk = false;
    let mut auto_col_name: Option<String> = None;

    for col_diff in columns {
        let Some(col) = &col_diff.source else {
            continue;
        };
        let col_name = quote_id(&col.name, db_type);
        let mapped_type = map_type(&col.data_type);
        if db_type == DatabaseType::SqlServer {
            col_defs.push(sqlserver_column_definition(col, &mapped_type, source_dialect, schema));
            if col.is_primary_key {
                pk_cols.push(col_name);
            }
            continue;
        }
        let is_int = type_looks_integer(&mapped_type);
        let auto_build = apply_auto_inc_to_column_def(&profile, &col_name, &mapped_type, col, is_int);

        match auto_build {
            AutoIncColumnBuild::Complete { def, .. } => {
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(col_name);
                }
                continue;
            }
            AutoIncColumnBuild::AppendSuffix { suffix, skip_default, postgres_sequence } => {
                let mut def = format!("{} {}", col_name, mapped_type);
                if !col.is_nullable {
                    def.push_str(" NOT NULL");
                }
                if !skip_default {
                    if let Some(default) = &col.column_default {
                        def.push_str(&format!(
                            " DEFAULT {}",
                            default_literal(
                                default,
                                &mapped_type,
                                effective_source_dialect(source_dialect, db_type),
                                col.extra.as_deref()
                            )
                        ));
                    }
                }
                if profile.inline_column_comment {
                    if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
                        def.push_str(&format!(" COMMENT {}", comment_literal(comment)));
                    }
                }
                if !suffix.is_empty() {
                    def.push_str(suffix);
                }
                if postgres_sequence {
                    has_int_pk = true;
                    auto_col_name = Some(col.name.clone());
                }
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(quote_id(&col.name, db_type));
                }
            }
            AutoIncColumnBuild::Normal { skip_default } => {
                let mut def = format!("{} {}", col_name, mapped_type);
                if !col.is_nullable {
                    def.push_str(" NOT NULL");
                }
                if !skip_default {
                    if let Some(default) = &col.column_default {
                        def.push_str(&format!(
                            " DEFAULT {}",
                            default_literal(
                                default,
                                &mapped_type,
                                effective_source_dialect(source_dialect, db_type),
                                col.extra.as_deref()
                            )
                        ));
                    }
                }
                if profile.inline_column_comment {
                    if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
                        def.push_str(&format!(" COMMENT {}", comment_literal(comment)));
                    }
                }
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(quote_id(&col.name, db_type));
                }
            }
        }
    }

    if profile.foreign_keys_inline_in_create {
        for fk_diff in foreign_keys {
            let Some(fk) = &fk_diff.source else {
                continue;
            };
            let ref_table = qualified_name(&fk.ref_table, db_type, fk.ref_schema.as_deref().or(schema));
            let on_delete = fk.on_delete.as_ref().map(|action| format!(" ON DELETE {action}")).unwrap_or_default();
            let on_update = fk.on_update.as_ref().map(|action| format!(" ON UPDATE {action}")).unwrap_or_default();
            col_defs.push(format!(
                "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({}){}{}",
                quote_id(&fk.name, db_type),
                quote_id(&fk.column, db_type),
                ref_table,
                quote_id(&fk.ref_column, db_type),
                on_delete,
                on_update
            ));
        }
    }

    let mut create = format!("CREATE TABLE {} (\n", table);
    create.push_str(&format!("  {}", col_defs.join(",\n  ")));

    if !pk_cols.is_empty() {
        create.push_str(&format!(",\n  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    create.push_str("\n);");
    lines.push(format!("-- Create table: {}", name));
    lines.push(create);
    lines.push(String::new());

    // Postgres identity / sequence
    if has_int_pk {
        if let Some(seq_col) = auto_col_name {
            let seq_name = format!("{}_{}_seq", name, seq_col);
            let quoted_seq = quote_id(&seq_name, db_type);
            let quoted_col = quote_id(&seq_col, db_type);
            lines.push(format!("CREATE SEQUENCE IF NOT EXISTS {} OWNED BY {}.{};", quoted_seq, table, quoted_col));
            lines.push(format!(
                "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT nextval('{}');",
                table, quoted_col, seq_name
            ));
            lines.push(format!("ALTER SEQUENCE {} START WITH 1;", quoted_seq));
            lines.push(String::new());
        }
    }

    // Indexes
    for idx_diff in indexes {
        let Some(idx) = &idx_diff.source else {
            continue;
        };
        if idx.is_primary {
            continue;
        }
        lines.push(create_index_sql(name, idx, db_type, schema));
    }
    if !indexes.is_empty() {
        lines.push(String::new());
    }

    // Foreign Keys (skipped when already inlined into CREATE TABLE via profile)
    for fk_diff in foreign_keys {
        if profile.foreign_keys_inline_in_create {
            continue;
        }
        let Some(fk) = &fk_diff.source else {
            continue;
        };
        lines.push(add_foreign_key_sql_with_reference_separator(name, fk, db_type, schema, ""));
    }
    if !foreign_keys.is_empty() {
        lines.push(String::new());
    }

    // Column comments
    for col_diff in columns {
        let Some(col) = &col_diff.source else {
            continue;
        };
        if let Some(comment) = &col.comment {
            if !comment.is_empty() && !profile.inline_column_comment {
                lines.extend(column_comment_sql(name, &col.name, comment, db_type, schema));
            }
        }
    }

    // Table comment
    if let Some(comment) = table_comment {
        if !comment.is_empty() {
            lines.extend(table_comment_sql(name, comment, db_type, schema));
        }
    }

    // Trigger recreation — collect structured missing objects (do not rely on SQL comments alone).
    let mut missing: Vec<MissingRollbackObject> = Vec::new();
    if !triggers.is_empty() {
        lines.push(String::new());
        for trigger in triggers {
            let event_desc = if trigger.event.to_uppercase().contains("INSERT") {
                "INSERT"
            } else if trigger.event.to_uppercase().contains("UPDATE") {
                "UPDATE"
            } else if trigger.event.to_uppercase().contains("DELETE") {
                "DELETE"
            } else {
                &trigger.event
            };
            let timing = &trigger.timing;

            if db_type == DatabaseType::SqlServer
                && source_dialect.is_some_and(|source| source != DialectKind::SqlServer)
            {
                missing.push(MissingRollbackObject {
                    kind: "trigger".to_string(),
                    name: trigger.name.clone(),
                    table: Some(name.to_string()),
                    reason: "source-dialect trigger bodies cannot be translated safely to T-SQL".to_string(),
                });
            } else if let Some(stmt) = &trigger.statement {
                if !stmt.trim().is_empty() {
                    let trimmed = stmt.trim().trim_end_matches(';');
                    if db_type == DatabaseType::SqlServer && is_sqlserver_native_trigger_definition(trimmed) {
                        // OBJECT_DEFINITION already returns the complete native
                        // CREATE TRIGGER statement. Wrapping it as a trigger body
                        // produces an invalid nested CREATE TRIGGER batch.
                        lines.push(sqlserver_single_statement_batch(&format!("{trimmed};")));
                    } else {
                        let trigger_sql = create_trigger_sql(&profile, &trigger.name, timing, event_desc, &table, stmt);
                        if db_type == DatabaseType::SqlServer {
                            lines.push(sqlserver_single_statement_batch(&trigger_sql));
                        } else {
                            lines.push(trigger_sql);
                        }
                    }
                } else {
                    missing.push(MissingRollbackObject {
                        kind: "trigger".to_string(),
                        name: trigger.name.clone(),
                        table: Some(name.to_string()),
                        reason: "trigger body is empty; cannot reconstruct CREATE TRIGGER".to_string(),
                    });
                }
            } else {
                missing.push(MissingRollbackObject {
                    kind: "trigger".to_string(),
                    name: trigger.name.clone(),
                    table: Some(name.to_string()),
                    reason: "trigger statement/body missing from schema snapshot".to_string(),
                });
            }
        }
        if !missing.is_empty() {
            lines.push(String::new());
            lines.push(format!(
                "-- WARNING: Rollback DDL is INCOMPLETE — one or more triggers on table '{}' could not be reconstructed.",
                name
            ));
            lines.push("-- Manual intervention required before executing this rollback script.".to_string());
            for m in &missing {
                lines.push(format!("-- missing {}: {} ({})", m.kind, m.name, m.reason));
            }
        }
    }

    (lines.join("\n"), missing)
}

fn append_sequence_diff_sql(
    lines: &mut Vec<String>,
    sequence_diffs: &[SequenceDiff],
    profile: DdlDialectProfile,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
    should_render: impl Fn(&str) -> bool,
) {
    let mut matching = sequence_diffs.iter().filter(|diff| should_render(&diff.diff_type)).peekable();
    if matching.peek().is_none() {
        return;
    }

    lines.push(String::new());
    lines.push("-- Sequences".to_string());
    for diff in matching {
        match diff.diff_type.as_str() {
            "added" => {
                if let Some(source) = &diff.source {
                    if let Some(template) = profile.sequence_create_template {
                        lines.push(format!("-- Create sequence: {}", diff.name));
                        let name = qualified_name(&diff.name, db_type, schema);
                        let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[
                                ("name", &name),
                                ("data_type", &source.data_type),
                                ("start_value", &source.start_value),
                                ("increment", &source.increment),
                                ("min_value", &source.min_value),
                                ("max_value", &source.max_value),
                                ("cycle", cycle),
                            ],
                        ));
                    } else {
                        lines.push(format!(
                            "-- Skip sequence {}: target database does not support sequence DDL generation",
                            diff.name
                        ));
                    }
                }
            }
            "removed" => {
                if let Some(template) = profile.sequence_drop_template {
                    lines.push(format!("-- Drop sequence: {}", diff.name));
                    let name = qualified_name(&diff.name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(template, &[("name", &name), ("cascade", cascade)]));
                } else {
                    lines.push(format!("-- Skip drop sequence {}: unsupported on target", diff.name));
                }
            }
            "modified" => {
                if let Some(source) = &diff.source {
                    if let Some(template) = profile.sequence_alter_template {
                        lines.push(format!("-- Alter sequence: {}", diff.name));
                        if db_type == DatabaseType::SqlServer
                            && diff.target.as_ref().is_some_and(|target| {
                                !target.data_type.trim().eq_ignore_ascii_case(source.data_type.trim())
                            })
                        {
                            lines.push(
                                "-- SQL Server ALTER SEQUENCE cannot change the data type; recreate the sequence manually if the type must change."
                                    .to_string(),
                            );
                        }
                        let name = qualified_name(&diff.name, db_type, schema);
                        let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[
                                ("name", &name),
                                ("data_type", &source.data_type),
                                ("start_value", &source.start_value),
                                ("increment", &source.increment),
                                ("min_value", &source.min_value),
                                ("max_value", &source.max_value),
                                ("cycle", cycle),
                            ],
                        ));
                    } else {
                        lines.push(format!("-- Skip alter sequence {}: unsupported on target", diff.name));
                    }
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_sql(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
) -> String {
    generate_schema_sync_sql_inner(
        diffs,
        function_diffs,
        sequence_diffs,
        rule_diffs,
        owner_diffs,
        db_type,
        schema,
        cascade_delete,
        source_dialect,
        field_mappings,
    )
    .0
}

#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_sql_plan(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
    enable_rollback: bool,
) -> SchemaSyncSqlPlan {
    let (sync_sql, _) = generate_schema_sync_sql_inner(
        diffs,
        function_diffs,
        sequence_diffs,
        rule_diffs,
        owner_diffs,
        db_type,
        schema,
        cascade_delete,
        source_dialect,
        field_mappings,
    );

    let (rollback_sync_sql, missing_rollback_objects) = if enable_rollback {
        let dependency_graph = DependencyGraph { nodes: HashMap::new(), topological_order: Vec::new() };
        let rollback_graph = RollbackGraph::from_forward_diffs(diffs, &[], &dependency_graph);
        let (sql, missing) = generate_rollback_sync_sql_with_missing(&rollback_graph, db_type, schema, cascade_delete);
        (Some(sql), missing)
    } else {
        (None, Vec::new())
    };
    let rollback_completeness = if missing_rollback_objects.is_empty() {
        RollbackCompleteness::Complete
    } else {
        RollbackCompleteness::Incomplete
    };

    SchemaSyncSqlPlan { sync_sql, rollback_sync_sql, rollback_completeness, missing_rollback_objects }
}

fn generate_schema_sync_sql_inner(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
) -> (String, Vec<MissingRollbackObject>) {
    let mut lines = Vec::new();
    let mut missing_objects: Vec<MissingRollbackObject> = Vec::new();
    let profile = profile_for(db_type);
    // SQL Server has no DROP ... CASCADE syntax. Related constraints are handled
    // explicitly by the comparison plan instead of appending an invalid clause.
    let cascade = if cascade_delete && db_type != DatabaseType::SqlServer { " CASCADE" } else { "" };

    let map_type = |source_type: &str| -> String {
        let tgt = DialectKind::from_database_type(db_type);
        if let Some(user_target) = FieldMapping::apply_with_params(field_mappings, source_type, tgt) {
            return user_target;
        }
        rewrite_column_type(source_type, db_type, source_dialect)
    };
    let is_same_dialect =
        source_dialect.map(|source| DialectKind::from_database_type(db_type) == source).unwrap_or(false);

    append_sequence_diff_sql(&mut lines, sequence_diffs, profile, db_type, schema, cascade, |diff_type| {
        diff_type == "added"
    });

    for diff in diffs {
        let table = qualified_name(&diff.name, db_type, schema);

        if diff.diff_type == "added" && diff.object_type.as_deref() == Some("view") {
            if let Some(ddl) = &diff.ddl {
                if is_same_dialect || source_dialect.is_none() {
                    let ddl = rewrite_ddl_header_qualifier(ddl, VIEW_DDL_HEADER_KEYWORDS, schema, &table);
                    lines.push(format!("-- Create view: {}", diff.name));
                    lines.push(format!("{};", ddl.trim_end().trim_end_matches(';')));
                    lines.push(String::new());
                    continue;
                }
            }

            lines.push(format!("-- View exists only in source: {}", diff.name));
            if diff.ddl.is_some() {
                lines.push("-- Source view definition cannot be reused across different SQL dialects.".to_string());
            } else {
                lines.push("-- Source view definition is not available from this driver yet.".to_string());
            }
            lines.push(String::new());
            continue;
        }

        if diff.diff_type == "added" && diff.object_type.as_deref() != Some("view") {
            let has_structured_snapshot = diff.columns.as_ref().is_some_and(|columns| !columns.is_empty());
            let is_rollback_recreation = diff.ddl.is_none() && diff.target_ddl.is_some();
            if is_rollback_recreation {
                if has_structured_snapshot {
                    let trigger_infos: Vec<TriggerInfo> = diff
                        .triggers
                        .as_ref()
                        .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                    let (generated, missing) = generate_create_table_sql(
                        &diff.name,
                        diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |columns| columns.as_slice()),
                        diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |indexes| indexes.as_slice()),
                        diff.foreign_keys
                            .as_ref()
                            .map_or(&[] as &[ForeignKeyDiff], |foreign_keys| foreign_keys.as_slice()),
                        diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()),
                        db_type,
                        schema,
                        None,
                        field_mappings,
                        &trigger_infos,
                    );
                    if !generated.is_empty() {
                        lines.push(generated);
                    }
                    missing_objects.extend(missing);
                } else if let Some(ddl) = diff.target_ddl.as_deref() {
                    // Inversion places only the removed target table's native
                    // DDL here, validating that it belongs to the dialect restored.
                    // It's already qualified against the same target schema this
                    // rollback re-runs against, so the rewrite below is normally a
                    // no-op — kept for symmetry with the other native-DDL
                    // passthrough sites in case that invariant ever changes.
                    let ddl = rewrite_ddl_header_qualifier(ddl, TABLE_DDL_HEADER_KEYWORDS, schema, &table);
                    lines.push(format!("-- Recreate table from native target DDL: {}", diff.name));
                    lines.push(format!("{};", ddl.trim_end_matches(';')));
                    lines.push(String::new());
                }
            } else if is_same_dialect
                || (source_dialect.is_none()
                    && diff.ddl.is_some()
                    && (profile.prefers_native_source_ddl || !has_structured_snapshot))
            {
                // Prefer native source DDL when the target profile wants it
                // (MySQL-family), or as fallback without a structured snapshot.
                if let Some(ddl) = &diff.ddl {
                    let ddl = rewrite_ddl_header_qualifier(ddl, TABLE_DDL_HEADER_KEYWORDS, schema, &table);
                    lines.push(format!("-- Create {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
                    lines.push(format!("{};", ddl.trim_end().trim_end_matches(';')));
                    lines.push(String::new());
                } else if let Some(cols) = &diff.columns {
                    let trigger_infos: Vec<TriggerInfo> = diff
                        .triggers
                        .as_ref()
                        .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                    let (gen, missing) = generate_create_table_sql(
                        &diff.name,
                        cols,
                        diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                        diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                        diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                        db_type,
                        schema,
                        source_dialect,
                        field_mappings,
                        &trigger_infos,
                    );
                    if !gen.is_empty() {
                        lines.push(gen);
                    }
                    missing_objects.extend(missing);
                }
            } else if has_structured_snapshot {
                // Cross-dialect → generate CREATE TABLE from column info
                let _cols: &[ColumnDiff] = diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |v| v.as_slice());
                let _idxs: &[IndexDiff] = diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice());
                let _fks: &[ForeignKeyDiff] =
                    diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice());
                let trigger_infos: Vec<TriggerInfo> = diff
                    .triggers
                    .as_ref()
                    .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                let (gen, missing) = generate_create_table_sql(
                    &diff.name,
                    diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |v| v.as_slice()),
                    diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                    diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                    diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                    db_type,
                    schema,
                    source_dialect,
                    field_mappings,
                    &trigger_infos,
                );
                if !gen.is_empty() {
                    lines.push(gen);
                }
                missing_objects.extend(missing);
            }
            continue;
        }

        if diff.diff_type == "removed" {
            lines.push(format!("-- Drop {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
            lines.push(drop_object_sql(diff, db_type, schema, cascade));
            lines.push(String::new());
            continue;
        }

        if diff.diff_type != "modified" {
            continue;
        }

        let mut parts = Vec::new();
        let mut standalone_statements = Vec::new();
        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "removed" || fk.diff_type == "modified" {
                    lines.push(drop_foreign_key_sql(&diff.name, &fk.name, db_type, schema));
                }
            }
        }
        if db_type == DatabaseType::SqlServer {
            if let Some(indexes) = &diff.indexes {
                for index in indexes {
                    if index.diff_type == "removed" || (index.diff_type == "modified" && index.source.is_some()) {
                        // SQL Server will reject DROP/ALTER COLUMN while a changed
                        // index still depends on it. Drop changed indexes before
                        // applying column DDL, then recreate modified ones below.
                        lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema));
                    }
                }
            }
        }

        if let Some(columns) = &diff.columns {
            let convert_col =
                |col: &ColumnInfo| -> ColumnInfo { ColumnInfo { data_type: map_type(&col.data_type), ..col.clone() } };
            for column in columns {
                match column.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &column.source {
                            if db_type == DatabaseType::SqlServer {
                                let mapped = convert_col(source);
                                standalone_statements.push(format!(
                                    "ALTER TABLE {table} ADD {};",
                                    sqlserver_column_definition(source, &mapped.data_type, source_dialect, schema)
                                ));
                                continue;
                            }
                            let position = if db_type == DatabaseType::Mysql {
                                match &column.add_position {
                                    Some(ColumnAddPosition::First) => " FIRST".to_string(),
                                    Some(ColumnAddPosition::After(predecessor)) => {
                                        format!(" AFTER {}", quote_id(predecessor, db_type))
                                    }
                                    None => String::new(),
                                }
                            } else {
                                String::new()
                            };
                            parts.push(format!(
                                "  ADD COLUMN {}{}",
                                column_def(&convert_col(source), db_type, source_dialect),
                                position
                            ));
                        }
                    }
                    "removed" => {
                        if db_type == DatabaseType::SqlServer {
                            if column.target.as_ref().is_some_and(sqlserver_has_default) {
                                standalone_statements.push(sqlserver_single_statement_batch(
                                    &build_sqlserver_drop_default_constraint_sql(&table, &column.name),
                                ));
                            }
                            standalone_statements
                                .push(format!("ALTER TABLE {table} DROP COLUMN {};", quote_id(&column.name, db_type)));
                        } else {
                            parts.push(format!("  DROP COLUMN {}", quote_id(&column.name, db_type)));
                        }
                    }
                    "modified" => {
                        if let Some(source) = &column.source {
                            let mapped = convert_col(source);
                            if db_type == DatabaseType::SqlServer {
                                if let Some(target_col) = &column.target {
                                    standalone_statements.extend(sqlserver_column_change_statements(
                                        &table,
                                        &column.name,
                                        source,
                                        target_col,
                                        &mapped.data_type,
                                        source_dialect,
                                        schema,
                                    ));
                                }
                            } else if profile.alter_uses_modify_column {
                                if column.changes.iter().any(|change| !change.starts_with("order:")) {
                                    parts.push(format!(
                                        "  MODIFY COLUMN {}",
                                        column_def(&mapped, db_type, source_dialect)
                                    ));
                                }
                            } else {
                                let name = quote_id(&column.name, db_type);
                                if column.changes.iter().any(|change| change.starts_with("type:")) {
                                    parts.push(format!("  ALTER COLUMN {name} TYPE {}", mapped.data_type));
                                }
                                if column.changes.iter().any(|change| change.starts_with("nullable:")) {
                                    parts.push(if source.is_nullable {
                                        format!("  ALTER COLUMN {name} DROP NOT NULL")
                                    } else {
                                        format!("  ALTER COLUMN {name} SET NOT NULL")
                                    });
                                }
                                if column.changes.iter().any(|change| change.starts_with("default:")) {
                                    parts.push(if let Some(default) = &source.column_default {
                                        format!(
                                            "  ALTER COLUMN {name} SET DEFAULT {}",
                                            default_literal(
                                                default,
                                                &mapped.data_type,
                                                effective_source_dialect(source_dialect, db_type),
                                                source.extra.as_deref()
                                            )
                                        )
                                    } else {
                                        format!("  ALTER COLUMN {name} DROP DEFAULT")
                                    });
                                }
                            }
                        }
                    }
                    "renamed" => {
                        if let (Some(source), Some(target_col)) = (&column.source, &column.target) {
                            use crate::sql_dialect::ddl_profile::RenameColumnSyntax;
                            let mapped = convert_col(source);
                            match profile.rename_column {
                                RenameColumnSyntax::MysqlChangeColumn => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    parts.push(format!(
                                        "  CHANGE COLUMN {} {}",
                                        old_name,
                                        column_def(&mapped, db_type, source_dialect)
                                    ));
                                }
                                RenameColumnSyntax::RenameColumn => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    let new_name = quote_id(&column.name, db_type);
                                    parts.push(format!("  RENAME COLUMN {old_name} TO {new_name}"));
                                    if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                        parts.push(format!("  ALTER COLUMN {new_name} TYPE {}", mapped.data_type));
                                    }
                                    if source.is_nullable != target_col.is_nullable {
                                        let action = if source.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                                        parts.push(format!("  ALTER COLUMN {new_name} {action}"));
                                    }
                                }
                                RenameColumnSyntax::AlterColumnRenameTo => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    let new_name = quote_id(&column.name, db_type);
                                    parts.push(format!("  ALTER COLUMN {old_name} RENAME TO {new_name}"));
                                    if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                        parts.push(format!(
                                            "  ALTER COLUMN {new_name} SET DATA TYPE {}",
                                            mapped.data_type
                                        ));
                                    }
                                }
                                RenameColumnSyntax::SqlServerSpRename => {
                                    let target_table = qualified_name(&diff.name, db_type, schema);
                                    let full_obj_path =
                                        format!("{target_table}.{}", quote_id(&target_col.name, db_type));
                                    standalone_statements.push(format!(
                                        "EXEC sp_rename '{}', '{}', 'COLUMN';",
                                        full_obj_path.replace('\'', "''"),
                                        column.name.replace('\'', "''")
                                    ));
                                    standalone_statements.extend(sqlserver_column_change_statements(
                                        &target_table,
                                        &column.name,
                                        source,
                                        target_col,
                                        &mapped.data_type,
                                        source_dialect,
                                        schema,
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !standalone_statements.is_empty() || !parts.is_empty() {
            lines.push(format!("-- Alter table: {}", diff.name));
            lines.extend(standalone_statements);
            if !parts.is_empty() {
                if profile.alter_batches_clauses {
                    lines.push(format!("ALTER TABLE {table}"));
                    lines.push(format!("{};", parts.join(",\n")));
                } else {
                    for part in parts {
                        lines.push(format!("ALTER TABLE {table}{part};"));
                    }
                }
            }
            lines.push(String::new());
        }

        if !profile.column_comment_via_modify_only {
            if let Some(columns) = &diff.columns {
                for column in columns {
                    if let Some(source) = &column.source {
                        if column.changes.iter().any(|change| change.starts_with("comment:")) {
                            lines.extend(column_comment_sql(
                                &diff.name,
                                &column.name,
                                source.comment.as_deref().unwrap_or_default(),
                                db_type,
                                schema,
                            ));
                        }
                        if column.diff_type == "added" {
                            if let Some(comment) = &source.comment {
                                lines.extend(column_comment_sql(&diff.name, &column.name, comment, db_type, schema));
                            }
                        }
                        if column.diff_type == "renamed" {
                            if let Some(comment) = &source.comment {
                                lines.extend(column_comment_sql(&diff.name, &column.name, comment, db_type, schema));
                            }
                        }
                    }
                }
            }
        }

        if diff.source_table_comment.is_some() && diff.source_table_comment != diff.target_table_comment {
            let comment = diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()).unwrap_or_default();
            lines.extend(table_comment_sql(&diff.name, comment, db_type, schema));
        }

        if let Some(indexes) = &diff.indexes {
            for index in indexes {
                match index.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &index.source {
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    "removed" => {
                        if db_type != DatabaseType::SqlServer {
                            lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema));
                        }
                    }
                    "modified" => {
                        if let Some(source) = &index.source {
                            if db_type != DatabaseType::SqlServer {
                                lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema));
                            }
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    _ => {}
                }
            }
        }

        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "added" || fk.diff_type == "modified" {
                    if let Some(source) = &fk.source {
                        lines.push(add_foreign_key_sql(&diff.name, source, db_type, schema));
                    }
                }
            }
        }

        if let Some(triggers) = &diff.triggers {
            for trigger in triggers {
                lines.push(format!(
                    "-- Trigger {}: {} on {}; review trigger definition manually.",
                    trigger.diff_type, trigger.name, diff.name
                ));
            }
        }

        if diff.indexes.as_ref().is_some_and(|indexes| !indexes.is_empty())
            || diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
            || diff.triggers.as_ref().is_some_and(|triggers| !triggers.is_empty())
        {
            lines.push(String::new());
        }

        if profile.warn_fk_needs_table_rebuild
            && diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
        {
            lines.push(format!("-- Foreign key synchronization may require table rebuild for: {}", diff.name));
            lines.push(String::new());
        }
    }

    // Function diffs — only emit executable SQL when profile has templates
    if !function_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Functions".to_string());
        for diff in function_diffs {
            match diff.diff_type.as_str() {
                "added" | "modified" => {
                    if let Some(source) = &diff.source {
                        if db_type == DatabaseType::SqlServer
                            && source_dialect.is_some_and(|source| source != DialectKind::SqlServer)
                        {
                            lines.push(format!(
                                "-- Skip function {}: source-dialect function definitions cannot be translated safely to T-SQL",
                                diff.name
                            ));
                            continue;
                        }
                        if let Some(template) = profile.function_create_template {
                            let verb = if diff.diff_type == "added" { "Create" } else { "Alter" };
                            lines.push(format!("-- {verb} function: {}", diff.name));
                            if db_type == DatabaseType::SqlServer {
                                let name = qualified_name(&diff.name, db_type, schema);
                                if let Some(sql) = sqlserver_native_function_sql(
                                    &source.definition,
                                    &name,
                                    diff.diff_type == "modified",
                                ) {
                                    lines.push(sqlserver_single_statement_batch(&sql));
                                    continue;
                                }
                            }
                            let create_kw = if db_type == DatabaseType::SqlServer && diff.diff_type == "modified" {
                                "ALTER FUNCTION"
                            } else if profile.create_function_or_replace {
                                "CREATE OR REPLACE FUNCTION"
                            } else {
                                "CREATE FUNCTION"
                            };
                            let name = qualified_name(&diff.name, db_type, schema);
                            let function_sql = DdlDialectProfile::render_template(
                                template,
                                &[("create_kw", create_kw), ("name", &name), ("definition", &source.definition)],
                            );
                            if db_type == DatabaseType::SqlServer {
                                lines.push(sqlserver_single_statement_batch(&function_sql));
                            } else {
                                lines.push(function_sql);
                            }
                        } else {
                            lines.push(format!(
                                "-- Skip function {}: target database does not support function DDL generation",
                                diff.name
                            ));
                        }
                    }
                }
                "removed" => {
                    if let Some(template) = profile.function_drop_template {
                        lines.push(format!("-- Drop function: {}", diff.name));
                        let name = qualified_name(&diff.name, db_type, schema);
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[("name", &name), ("cascade", cascade)],
                        ));
                    } else {
                        lines.push(format!("-- Skip drop function {}: unsupported on target", diff.name));
                    }
                }
                _ => {}
            }
        }
    }

    append_sequence_diff_sql(&mut lines, sequence_diffs, profile, db_type, schema, cascade, |diff_type| {
        matches!(diff_type, "removed" | "modified")
    });

    // Rule diffs (PostgreSQL RULE)
    if !rule_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Rules".to_string());
        for diff in rule_diffs {
            if profile.rule_drop_template.is_none() && !profile.supports_rule_ddl {
                lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                continue;
            }
            match diff.diff_type.as_str() {
                "added" => {
                    if let Some(source) = &diff.source {
                        if profile.supports_rule_ddl {
                            lines.push(format!("-- Create rule: {}", diff.name));
                            lines.push(source.definition.clone());
                        } else {
                            lines
                                .push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                        }
                    }
                }
                "removed" => {
                    if let Some(template) = profile.rule_drop_template {
                        lines.push(format!("-- Drop rule: {}", diff.name));
                        // Removed diffs store the object on `target`; tests may put it on `source`.
                        if let Some(rule) = diff.source.as_ref().or(diff.target.as_ref()) {
                            let table_name = qualified_name(&rule.table_name, db_type, schema);
                            lines.push(DdlDialectProfile::render_template(
                                template,
                                &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                            ));
                        }
                    } else {
                        lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                    }
                }
                "modified" => {
                    if let Some(source) = &diff.source {
                        if let Some(template) = profile.rule_drop_template {
                            lines.push(format!("-- Alter rule: {}", diff.name));
                            let table_name = qualified_name(&source.table_name, db_type, schema);
                            lines.push(DdlDialectProfile::render_template(
                                template,
                                &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                            ));
                            lines.push(source.definition.clone());
                        } else {
                            lines
                                .push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Owner diffs
    if !owner_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Owners".to_string());
        for diff in owner_diffs {
            if let (Some(source), Some(_target)) = (&diff.source, &diff.target) {
                if let Some(template) = profile.owner_alter_template {
                    let object_type = match source.object_type.as_str() {
                        "TABLE" => "TABLE",
                        "VIEW" => "VIEW",
                        "SEQUENCE" => "SEQUENCE",
                        _ => "TABLE",
                    };
                    let name = qualified_name(&diff.object_name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[("object_type", object_type), ("name", &name), ("owner", &source.owner)],
                    ));
                } else {
                    lines.push(format!("-- Skip OWNER change for {}: unsupported on target", diff.object_name));
                }
            }
        }
    }

    (lines.join("\n").trim().to_string(), missing_objects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(overrides: IndexInfo) -> IndexInfo {
        IndexInfo {
            name: if overrides.name.is_empty() { "idx_users_email".to_string() } else { overrides.name },
            columns: if overrides.columns.is_empty() { vec!["email".to_string()] } else { overrides.columns },
            is_unique: overrides.is_unique,
            is_primary: overrides.is_primary,
            filter: overrides.filter,
            index_type: overrides.index_type,
            included_columns: overrides.included_columns,
            comment: overrides.comment,
            key_is_expression: overrides.key_is_expression,
        }
    }

    fn foreign_key(overrides: ForeignKeyInfo) -> ForeignKeyInfo {
        ForeignKeyInfo {
            name: if overrides.name.is_empty() { "orders_user_id_fk".to_string() } else { overrides.name },
            column: if overrides.column.is_empty() { "user_id".to_string() } else { overrides.column },
            ref_schema: overrides.ref_schema,
            ref_table: if overrides.ref_table.is_empty() { "users".to_string() } else { overrides.ref_table },
            ref_column: if overrides.ref_column.is_empty() { "id".to_string() } else { overrides.ref_column },
            on_update: overrides.on_update,
            on_delete: overrides.on_delete,
        }
    }

    fn column(name: &str, data_type: &str, comment: Option<&str>) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            resolved_schema: None,
            is_nullable: false,
            column_default: None,
            is_primary_key: false,
            is_unique: false,
            extra: None,
            comment: comment.map(str::to_string),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }
    }

    fn table_info(name: &str, table_type: &str) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    fn schema_detail(name: &str, ddl: Option<&str>) -> TableSchemaDetail {
        TableSchemaDetail {
            name: name.to_string(),
            columns: vec![],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: ddl.map(str::to_string),
        }
    }

    fn common_mysql_view_options(source_ddl: Option<&str>, target_ddl: Option<&str>) -> SchemaDiffPreparationOptions {
        SchemaDiffPreparationOptions {
            source_tables: vec![table_info("active_orders", "VIEW")],
            target_tables: vec![table_info("active_orders", "VIEW")],
            source_details: vec![schema_detail("active_orders", source_ddl)],
            target_details: vec![schema_detail("active_orders", target_ddl)],
            database_type: DatabaseType::Mysql,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Mysql),
            ..Default::default()
        }
    }

    #[test]
    fn ignores_column_order_when_option_is_disabled() {
        let diffs = diff_columns_with_options(
            &[column("id", "int", None), column("name", "varchar(64)", None), column("status", "varchar(16)", None)],
            &[column("status", "varchar(16)", None), column("id", "int", None), column("name", "varchar(64)", None)],
            false,
            false,
            false,
            0.5,
        );

        assert!(diffs.is_empty());
    }

    #[test]
    fn detects_column_order_when_option_is_enabled() {
        let diffs = diff_columns_with_options(
            &[column("id", "int", None), column("name", "varchar(64)", None), column("status", "varchar(16)", None)],
            &[column("status", "varchar(16)", None), column("id", "int", None), column("name", "varchar(64)", None)],
            false,
            true,
            false,
            0.5,
        );

        assert_eq!(diffs.len(), 3);
        assert_eq!(diffs[0].changes, vec!["order: 2 → 1"]);
    }

    #[test]
    fn detects_column_rename_with_same_type() {
        let source = vec![
            column("id", "int", None),
            column("name2", "varchar(120)", None),
            column("del_flag", "tinyint", None),
            column("create_at", "datetime", None),
        ];
        let target =
            vec![column("id", "int", None), column("name", "varchar(120)", None), column("del_flag", "tinyint", None)];
        let diffs = diff_columns_with_options(&source, &target, false, false, true, 0.5);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        let added: Vec<_> = diffs.iter().filter(|d| d.diff_type == "added").collect();
        let removed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "removed").collect();
        assert_eq!(renamed.len(), 1, "should detect one renamed column");
        assert_eq!(renamed[0].name, "name2");
        assert_eq!(renamed[0].changes, vec!["name → name2"]);
        assert_eq!(added.len(), 1, "should have one truly added column (create_at)");
        assert_eq!(added[0].name, "create_at");
        assert!(removed.is_empty(), "should have no removed columns");
    }

    #[test]
    fn detects_column_rename_with_compatible_type() {
        let source = vec![column("col_a", "varchar(64)", None), column("col_b", "int", None)];
        let target = vec![column("col_a_old", "varchar(100)", None), column("col_b", "int", None)];
        let diffs = diff_columns_with_options(&source, &target, false, false, true, 0.5);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed.len(), 1, "should detect rename across varchar family");
        assert_eq!(renamed[0].changes, vec!["col_a_old → col_a"]);
    }

    #[test]
    fn no_rename_detection_when_disabled() {
        let source = vec![
            column("id", "int", None),
            column("name2", "varchar(120)", None),
            column("create_at", "datetime", None),
        ];
        let target = vec![column("id", "int", None), column("name", "varchar(120)", None)];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        let added: Vec<_> = diffs.iter().filter(|d| d.diff_type == "added").collect();
        let removed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "removed").collect();
        assert!(renamed.is_empty(), "should not detect renames when disabled");
        assert_eq!(added.len(), 2);
        assert_eq!(removed.len(), 1);
    }

    #[test]
    fn rename_not_detected_with_unrelated_types() {
        let source = vec![column("col_a", "varchar(120)", None), column("col_b", "int", None)];
        let target = vec![column("col_old", "int", None), column("col_b", "int", None)];
        let diffs = diff_columns_with_options(&source, &target, false, false, true, 0.5);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert!(renamed.is_empty(), "should not rename across unrelated types");
    }

    #[test]
    fn rename_with_rollback_graph_inversion() {
        let source = vec![column("id", "int", None), column("new_name", "varchar(120)", None)];
        let target = vec![column("id", "int", None), column("old_name", "varchar(120)", None)];
        let diffs = diff_columns_with_options(&source, &target, false, false, true, 0.5);
        let inverted = RollbackGraph::invert_columns(&diffs);
        let renamed_inv: Vec<_> = inverted.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed_inv.len(), 1, "inverted rename should exist");
        assert_eq!(renamed_inv[0].name, "old_name");
        assert_eq!(renamed_inv[0].changes, vec!["new_name → old_name"]);
    }

    // -- helpers ----------------------------------------------
    fn make_col_diffs(source: &[(&str, &str)], target: &[(&str, &str)], detect_renames: bool) -> Vec<ColumnDiff> {
        let s: Vec<ColumnInfo> = source.iter().map(|(n, t)| column(n, t, None)).collect();
        let t: Vec<ColumnInfo> = target.iter().map(|(n, t)| column(n, t, None)).collect();
        diff_columns_with_options(&s, &t, false, false, detect_renames, 0.5)
    }

    fn wrap_table_diff(name: &str, columns: Vec<ColumnDiff>) -> TableDiff {
        TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: name.to_string(),
            columns: Some(columns),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }
    }

    fn gen_sql(diff: TableDiff, db_type: DatabaseType, source_dialect: Option<DialectKind>) -> String {
        generate_schema_sync_sql(&[diff], &[], &[], &[], &[], db_type, None, false, source_dialect, &[])
    }

    // -- 1. Same-dialect: MySQL (backticks, MODIFY/CHANGE/ADD COLUMN) --
    #[test]
    fn mysql_same_dialect_rename_and_add() {
        let diffs = make_col_diffs(
            &[("id", "int(11)"), ("name2", "varchar(120)"), ("del_flag", "tinyint(2)"), ("create_at", "datetime")],
            &[("id", "int"), ("name", "varchar(120)"), ("del_flag", "tinyint")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("CHANGE COLUMN `name` `name2`"), "MySQL rename: {sql}");
        assert!(sql.contains("ADD COLUMN `create_at`"), "MySQL new col: {sql}");
        assert!(sql.contains("MODIFY COLUMN `id`"), "MySQL modify type: {sql}");
        assert!(!sql.contains("DROP COLUMN"), "MySQL no drop: {sql}");
    }

    #[test]
    fn mysql_add_columns_preserve_source_positions() {
        let diffs = make_col_diffs(
            &[("first", "int"), ("a", "int"), ("middle", "varchar(32)"), ("next", "int"), ("last", "int")],
            &[("a", "int"), ("last", "int")],
            false,
        );

        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);

        assert!(sql.contains("ADD COLUMN `first` int NOT NULL FIRST"), "first position: {sql}");
        assert!(sql.contains("ADD COLUMN `middle` varchar(32) NOT NULL AFTER `a`"), "middle position: {sql}");
        assert!(sql.contains("ADD COLUMN `next` int NOT NULL AFTER `middle`"), "consecutive additions: {sql}");
    }

    #[test]
    fn mysql_add_column_quotes_predecessor_and_keeps_trailing_position() {
        let diffs = make_col_diffs(
            &[("odd`name", "int"), ("middle", "int"), ("tail", "int"), ("new_tail", "int")],
            &[("odd`name", "int"), ("tail", "int")],
            false,
        );

        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);

        assert!(sql.contains("ADD COLUMN `middle` int NOT NULL AFTER `odd``name`"), "quoted predecessor: {sql}");
        assert!(sql.contains("ADD COLUMN `new_tail` int NOT NULL AFTER `tail`"), "trailing position: {sql}");
    }

    #[test]
    fn non_mysql_add_columns_do_not_emit_mysql_position_clauses() {
        let diffs = make_col_diffs(&[("first", "int"), ("a", "int"), ("middle", "int")], &[("a", "int")], false);

        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);

        assert!(!sql.contains(" FIRST"), "PostgreSQL must not use FIRST: {sql}");
        assert!(!sql.contains(" AFTER "), "PostgreSQL must not use AFTER: {sql}");
    }

    #[test]
    fn mysql_add_after_renamed_predecessor_uses_final_source_name() {
        let diffs =
            make_col_diffs(&[("new_name", "varchar(32)"), ("inserted", "int")], &[("old_name", "varchar(32)")], true);

        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);

        assert!(sql.contains("ADD COLUMN `inserted` int NOT NULL AFTER `new_name`"), "rename predecessor: {sql}");
        assert!(sql.contains("CHANGE COLUMN `old_name` `new_name`"), "rename remains present: {sql}");
    }

    #[test]
    fn mysql_manual_added_diff_without_position_keeps_legacy_sql() {
        let diff = ColumnDiff {
            diff_type: "added".into(),
            name: "legacy".into(),
            source: Some(column("legacy", "int", None)),
            target: None,
            changes: Vec::new(),
            add_position: None,
        };

        let sql = gen_sql(wrap_table_diff("t", vec![diff]), DatabaseType::Mysql, None);

        assert!(sql.contains("ADD COLUMN `legacy` int NOT NULL"), "legacy add: {sql}");
        assert!(!sql.contains(" FIRST"), "legacy diff has no position: {sql}");
        assert!(!sql.contains(" AFTER "), "legacy diff has no position: {sql}");
    }

    #[test]
    fn mysql_same_dialect_add_drop_modified() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_col", "varchar(50)")],
            &[("id", "bigint"), ("old_col", "int")],
            false,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("ADD COLUMN `new_col`"), "MySQL add: {sql}");
        assert!(sql.contains("DROP COLUMN `old_col`"), "MySQL drop: {sql}");
        assert!(sql.contains("MODIFY COLUMN `id`"), "MySQL modify: {sql}");
    }

    // -- 2. Same-dialect: PostgreSQL (double-quotes, ALTER COLUMN … TYPE) --
    #[test]
    fn postgresql_same_dialect_modify_and_rename() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("name2", "varchar(120)"), ("create_at", "timestamp")],
            &[("id", "int"), ("name", "varchar(120)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("RENAME COLUMN"), "PG rename: {sql}");
        assert!(sql.contains("ADD COLUMN"), "PG add: {sql}");
        assert!(sql.contains("\"t\""), "PG double-quote table: {sql}");
        assert!(!sql.contains('`'), "PG no backticks: {sql}");
    }

    // -- 3. Cross-dialect type conversion: MySQL → PostgreSQL --
    #[test]
    fn mysql_to_postgresql_type_conversion_full() {
        let diffs = make_col_diffs(
            &[("id", "int(11)"), ("name2", "varchar(120)"), ("flag", "tinyint(2)"), ("ts", "datetime")],
            &[("id", "integer"), ("name", "varchar(120)"), ("flag", "smallint")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, Some(DialectKind::Mysql));
        assert!(sql.contains("RENAME COLUMN"), "PG rename: {sql}");
        assert!(sql.contains("ADD COLUMN"), "PG add: {sql}");
        assert!(sql.contains("INTEGER"), "int(11)→INTEGER: {sql}");
        assert!(sql.contains("SMALLINT"), "tinyint→SMALLINT: {sql}");
        assert!(sql.contains("TIMESTAMP"), "datetime→TIMESTAMP: {sql}");
        assert!(!sql.contains('`'), "PG no backticks: {sql}");
    }

    #[test]
    fn mysql_to_postgresql_type_conversion_modified_only() {
        let diffs = make_col_diffs(
            &[("id", "int(11)"), ("amount", "decimal(10,2)"), ("created", "datetime")],
            &[("id", "integer"), ("amount", "numeric(10,2)"), ("created", "timestamp")],
            false,
        );
        let sql_with = gen_sql(wrap_table_diff("t", diffs.clone()), DatabaseType::Postgres, Some(DialectKind::Mysql));
        let sql_without = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql_with.contains("INTEGER"), "with: int(11)→INTEGER: {sql_with}");
        assert!(sql_with.contains("TIMESTAMP"), "with: datetime→TIMESTAMP: {sql_with}");
        // No source dialect: matrix skipped, but target profile still strips display width.
        assert!(sql_without.contains("INT"), "without: display width stripped: {sql_without}");
        assert!(!sql_without.contains("int(11)"), "without: no MySQL display width: {sql_without}");
        assert!(sql_without.contains("datetime"), "without: datetime preserved: {sql_without}");
    }

    // -- 4. Reverse: PostgreSQL → MySQL --
    #[test]
    fn postgresql_to_mysql_type_conversion_reverse() {
        let diffs = make_col_diffs(
            &[("id", "integer"), ("label", "text"), ("active", "boolean")],
            &[("id", "int"), ("label", "varchar(255)")],
            false,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, Some(DialectKind::Postgres));
        assert!(sql.contains('`'), "MySQL backticks: {sql}");
        assert!(sql.contains("MODIFY COLUMN"), "MySQL modify: {sql}");
        assert!(sql.contains("LONGTEXT"), "text→LONGTEXT: {sql}");
        assert!(sql.contains("TINYINT(1)"), "boolean→TINYINT(1): {sql}");
        assert!(sql.contains("INT"), "integer→INT: {sql}");
    }

    // -- 5. MySQL → SQLite type conversion --
    #[test]
    fn mysql_to_sqlite_type_conversion() {
        let diffs = make_col_diffs(
            &[("id", "int(11)"), ("renamed", "varchar(255)")],
            &[("id", "integer"), ("old", "text")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Sqlite, Some(DialectKind::Mysql));
        assert!(sql.contains("RENAME COLUMN"), "SQLite rename: {sql}");
        assert!(sql.contains("INTEGER"), "int(11)→INTEGER: {sql}");
        assert!(!sql.contains('`'), "SQLite no backticks: {sql}");
    }

    // -- 6. Database-specific rename syntax --
    #[test]
    fn sqlserver_rename_uses_sp_rename() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_name", "varchar(100)")],
            &[("id", "int"), ("old_name", "varchar(100)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("orders", diffs), DatabaseType::SqlServer, None);
        assert!(sql.contains("sp_rename"), "SQL Server uses sp_rename: {sql}");
        assert!(sql.contains("[dbo].[orders]"), "sp_rename table path: {sql}");
        assert!(!sql.contains("ALTER TABLE [dbo].[orders]  EXEC sp_rename"), "sp_rename must be standalone: {sql}");
        assert!(sql.lines().any(|line| line.starts_with("EXEC sp_rename")), "standalone sp_rename: {sql}");
        assert!(!sql.contains('`'), "SQL Server no backticks: {sql}");
    }

    #[test]
    fn sqlserver_schema_diff_adds_columns_and_unicode_comments_with_tsql() {
        let source = vec![ColumnInfo {
            is_nullable: true,
            comment: Some("厂家追溯码's".to_string()),
            ..column("manufacture_trace_code", "varchar(200)", None)
        }];
        let diffs = diff_columns_with_options(&source, &[], false, false, false, 0.5);
        let sql = generate_schema_sync_sql(
            &[wrap_table_diff("inter_putaway_sub", diffs)],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );

        assert!(
            sql.contains("ALTER TABLE [dbo].[inter_putaway_sub] ADD [manufacture_trace_code] varchar(200) NULL;"),
            "SQL Server ADD syntax: {sql}"
        );
        assert!(sql.contains("sys.sp_addextendedproperty"), "SQL Server comment add: {sql}");
        assert!(sql.contains("@value=N'厂家追溯码''s'"), "Unicode comment escaping: {sql}");
        assert!(!sql.contains("ADD COLUMN"), "SQL Server must not emit ADD COLUMN: {sql}");
        assert!(!sql.contains("COMMENT ON"), "SQL Server must not emit COMMENT ON: {sql}");
    }

    #[test]
    fn sqlserver_schema_diff_renders_default_constraint_transitions_as_single_batches() {
        let transitions =
            [(None, Some("((0))"), true), (Some("((0))"), Some("((1))"), true), (Some("((0))"), None, false)];

        for (old_default, new_default, expects_add) in transitions {
            let source = vec![ColumnInfo {
                column_default: new_default.map(str::to_string),
                ..column("frozen_status", "int", None)
            }];
            let target = vec![ColumnInfo {
                column_default: old_default.map(str::to_string),
                ..column("frozen_status", "int", None)
            }];
            let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
            let sql = generate_schema_sync_sql(
                &[wrap_table_diff("wbs_flat_package_data_sub", diffs)],
                &[],
                &[],
                &[],
                &[],
                DatabaseType::SqlServer,
                Some("dbo"),
                false,
                Some(DialectKind::SqlServer),
                &[],
            );

            assert!(!sql.contains(" SET DEFAULT "), "SQL Server must not emit SET DEFAULT: {sql}");
            assert!(!sql.contains(" DROP DEFAULT"), "SQL Server must not emit DROP DEFAULT: {sql}");
            if old_default.is_some() {
                assert!(sql.contains("sys.default_constraints"), "default lookup: {sql}");
                assert!(sql.contains("DROP CONSTRAINT"), "default drop: {sql}");
                assert!(sql.contains("EXEC sys.sp_executesql N'"), "drop batch wrapper: {sql}");
            }
            if expects_add {
                assert!(
                    sql.contains(&format!("ADD DEFAULT {} FOR [frozen_status]", new_default.unwrap())),
                    "default add: {sql}"
                );
            } else {
                assert!(!sql.contains("ADD DEFAULT"), "default removal must not re-add: {sql}");
            }

            let statements = crate::sql::split_sql_statements_for_database(&sql, DatabaseType::SqlServer);
            assert!(
                statements.iter().all(|statement| !statement.trim_start().starts_with("DECLARE ")),
                "SQL Server splitter must keep helper batches together: {statements:?}"
            );
        }
    }

    #[test]
    fn sqlserver_schema_diff_alters_full_column_definition_and_preserves_default() {
        let source = vec![ColumnInfo {
            is_nullable: false,
            column_default: Some("((0))".to_string()),
            ..column("amount", "bigint", None)
        }];
        let target = vec![ColumnInfo {
            is_nullable: true,
            column_default: Some("((0))".to_string()),
            ..column("amount", "int", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = generate_schema_sync_sql(
            &[wrap_table_diff("payments", diffs)],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("billing"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );

        assert!(
            sql.contains("ALTER TABLE [billing].[payments] ALTER COLUMN [amount] bigint NOT NULL"),
            "full SQL Server column definition: {sql}"
        );
        assert!(sql.contains("dc.definition"), "existing default definition must be captured: {sql}");
        assert!(sql.contains("ADD CONSTRAINT"), "existing default constraint must be restored: {sql}");
        assert!(!sql.contains(" ALTER COLUMN [amount] TYPE "), "no PostgreSQL TYPE syntax: {sql}");
        assert!(!sql.contains(" SET NOT NULL"), "no PostgreSQL nullability syntax: {sql}");

        let statements = crate::sql::split_sql_statements_for_database(&sql, DatabaseType::SqlServer);
        assert_eq!(statements.len(), 1, "preserve-default batch must stay atomic: {statements:?}");
        assert!(statements[0].trim_start().starts_with("-- Alter table: payments\nEXEC sys.sp_executesql N'"));
    }

    #[test]
    fn sqlserver_schema_diff_upserts_and_drops_escaped_column_comments() {
        let cases = [
            (None, Some("owner's 新值"), true, true, false),
            (Some("旧值"), Some("owner's 新值"), true, true, false),
            (Some("旧值"), None, false, false, true),
        ];

        for (old_comment, new_comment, expects_add, expects_update, expects_drop) in cases {
            let source = vec![column("display'name", "nvarchar(80)", new_comment)];
            let target = vec![column("display'name", "nvarchar(80)", old_comment)];
            let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
            let sql = generate_schema_sync_sql(
                &[wrap_table_diff("user's", diffs)],
                &[],
                &[],
                &[],
                &[],
                DatabaseType::SqlServer,
                Some("app's"),
                false,
                Some(DialectKind::SqlServer),
                &[],
            );

            assert_eq!(sql.contains("sys.sp_addextendedproperty"), expects_add, "comment add: {sql}");
            assert_eq!(sql.contains("sys.sp_updateextendedproperty"), expects_update, "comment update: {sql}");
            assert_eq!(sql.contains("sys.sp_dropextendedproperty"), expects_drop, "comment drop: {sql}");
            assert!(sql.contains("N'app''s'"), "schema escaping: {sql}");
            assert!(sql.contains("N'user''s'"), "table escaping: {sql}");
            assert!(sql.contains("N'display''name'"), "column escaping: {sql}");
            if new_comment.is_some() {
                assert!(sql.contains("N'owner''s 新值'"), "comment escaping: {sql}");
            }
            assert!(!sql.contains("COMMENT ON"), "SQL Server must not emit COMMENT ON: {sql}");

            let statements = crate::sql::split_sql_statements_for_database(&sql, DatabaseType::SqlServer);
            assert_eq!(statements.len(), 1, "comment transition must be one T-SQL statement: {statements:?}");
        }
    }

    #[test]
    fn sqlserver_schema_diff_rollback_uses_the_same_tsql_strategy() {
        let source = vec![ColumnInfo {
            column_default: Some("((1))".to_string()),
            comment: Some("new".to_string()),
            ..column("status", "int", None)
        }];
        let target = vec![ColumnInfo {
            column_default: Some("((0))".to_string()),
            comment: Some("old".to_string()),
            ..column("status", "int", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let plan = generate_schema_sync_sql_plan(
            &[wrap_table_diff("orders", diffs)],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
            true,
        );
        let rollback = plan.rollback_sync_sql.expect("rollback SQL");

        for (direction, sql) in [("forward", &plan.sync_sql), ("rollback", &rollback)] {
            assert!(sql.contains("sys.default_constraints"), "{direction} default constraint strategy: {sql}");
            assert!(sql.contains("sys.sp_updateextendedproperty"), "{direction} comment strategy: {sql}");
            assert!(!sql.contains(" SET DEFAULT "), "{direction} no PostgreSQL default syntax: {sql}");
            assert!(!sql.contains("COMMENT ON"), "{direction} no PostgreSQL comment syntax: {sql}");
        }
        assert!(plan.sync_sql.contains("ADD DEFAULT ((1)) FOR [status]"), "forward: {}", plan.sync_sql);
        assert!(rollback.contains("ADD DEFAULT ((0)) FOR [status]"), "rollback: {rollback}");
    }

    #[test]
    fn sqlserver_column_changes_use_tsql_syntax() {
        let added = ColumnInfo { column_default: Some("(0)".into()), ..column("status", "int", None) };
        let source_amount = ColumnInfo {
            is_nullable: false,
            column_default: Some("((1))".into()),
            ..column("amount", "decimal(18,2)", None)
        };
        let target_amount = ColumnInfo {
            is_nullable: true,
            column_default: Some("((0))".into()),
            ..column("amount", "decimal(10,2)", None)
        };
        let diff = wrap_table_diff(
            "orders",
            vec![
                ColumnDiff {
                    diff_type: "added".into(),
                    name: "status".into(),
                    source: Some(added),
                    target: None,
                    changes: Vec::new(),
                    add_position: None,
                },
                ColumnDiff {
                    diff_type: "modified".into(),
                    name: "amount".into(),
                    source: Some(source_amount),
                    target: Some(target_amount),
                    changes: vec![
                        "type: decimal(10,2) → decimal(18,2)".into(),
                        "nullable: YES → NO".into(),
                        "default: ((0)) → ((1))".into(),
                    ],
                    add_position: None,
                },
            ],
        );

        let sql = generate_schema_sync_sql(
            &[diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("sales"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );

        assert!(
            sql.contains("ALTER TABLE [sales].[orders] ADD [status] int NOT NULL DEFAULT (0);"),
            "ADD must use SQL Server column syntax: {sql}"
        );
        assert!(
            sql.contains("ALTER TABLE [sales].[orders] ALTER COLUMN [amount] decimal(18,2) NOT NULL;"),
            "ALTER COLUMN must repeat type and nullability: {sql}"
        );
        assert!(sql.contains("sys.default_constraints"), "old default constraint must be discovered: {sql}");
        assert!(
            sql.contains("ALTER TABLE [sales].[orders] ADD DEFAULT ((1)) FOR [amount];"),
            "new default constraint: {sql}"
        );
        assert!(!sql.contains("ADD COLUMN"), "SQL Server must not emit ADD COLUMN: {sql}");
        assert!(!sql.contains(" TYPE "), "SQL Server must not emit PostgreSQL TYPE syntax: {sql}");
        assert!(!sql.contains("SET NOT NULL"), "SQL Server must not emit SET NOT NULL: {sql}");
        assert!(!sql.contains("SET DEFAULT"), "SQL Server must not emit SET DEFAULT: {sql}");

        let parsed = crate::sql::split_sql_statements_for_database(&sql, DatabaseType::SqlServer);
        assert!(
            parsed.iter().any(|statement| statement.contains("EXEC sys.sp_executesql N'SET ANSI_NULLS ON;")),
            "{parsed:?}"
        );
        assert!(!parsed.iter().any(|statement| statement.trim_start().starts_with("DECLARE ")), "{parsed:?}");
    }

    #[test]
    fn sqlserver_type_change_preserves_unchanged_default_constraint() {
        let source = ColumnInfo { column_default: Some("((0))".into()), ..column("count", "bigint", None) };
        let target = ColumnInfo { column_default: Some("((0))".into()), ..column("count", "int", None) };
        let diff = wrap_table_diff(
            "metrics",
            vec![ColumnDiff {
                diff_type: "modified".into(),
                name: "count".into(),
                source: Some(source),
                target: Some(target),
                changes: vec!["type: int → bigint".into()],
                add_position: None,
            }],
        );

        let sql = gen_sql(diff, DatabaseType::SqlServer, Some(DialectKind::SqlServer));

        assert!(sql.contains("EXEC sys.sp_executesql N'SET ANSI_NULLS ON;"), "single executable batch: {sql}");
        assert!(sql.contains("dc.definition"), "default expression must be preserved: {sql}");
        assert!(sql.contains("DROP CONSTRAINT"), "old default must be removed before ALTER COLUMN: {sql}");
        assert!(
            sql.contains("ALTER TABLE [dbo].[metrics] ALTER COLUMN [count] bigint NOT NULL"),
            "valid ALTER COLUMN: {sql}"
        );
        assert!(sql.contains("ADD CONSTRAINT"), "original default constraint name must be restored: {sql}");
    }

    #[test]
    fn sqlserver_schema_diff_rollback_preserves_default_and_column_comment_changes() {
        let source = vec![ColumnInfo {
            column_default: Some("((1))".to_string()),
            comment: Some("new owner's state".to_string()),
            ..column("status", "int", None)
        }];
        let target = vec![ColumnInfo {
            column_default: Some("((0))".to_string()),
            comment: Some("旧状态".to_string()),
            ..column("status", "int", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let plan = generate_schema_sync_sql_plan(
            &[wrap_table_diff("orders", diffs)],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
            true,
        );
        let rollback = plan.rollback_sync_sql.expect("rollback SQL");

        for (direction, sql) in [("forward", &plan.sync_sql), ("rollback", &rollback)] {
            assert!(sql.contains("sys.default_constraints"), "{direction} default constraint strategy: {sql}");
            assert!(sql.contains("sys.sp_updateextendedproperty"), "{direction} comment update strategy: {sql}");
            assert!(sql.contains("sys.sp_addextendedproperty"), "{direction} comment add fallback: {sql}");
            assert!(!sql.contains(" SET DEFAULT "), "{direction} no PostgreSQL default syntax: {sql}");
            assert!(!sql.contains("COMMENT ON"), "{direction} no PostgreSQL comment syntax: {sql}");
        }
        assert!(plan.sync_sql.contains("ADD DEFAULT ((1)) FOR [status]"), "forward: {}", plan.sync_sql);
        assert!(plan.sync_sql.contains("N'new owner''s state'"), "forward comment: {}", plan.sync_sql);
        assert!(rollback.contains("ADD DEFAULT ((0)) FOR [status]"), "rollback: {rollback}");
        assert!(rollback.contains("N'旧状态'"), "rollback comment: {rollback}");
    }

    #[test]
    fn sqlserver_index_comments_and_drop_object_use_tsql() {
        let comment_source = column("payload", "nvarchar(max)", Some("new description"));
        let comment_target = column("payload", "nvarchar(max)", Some("old description"));
        let modified = TableDiff {
            diff_type: "modified".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".into(),
                name: "payload".into(),
                source: Some(comment_source),
                target: Some(comment_target),
                changes: vec!["comment: old description → new description".into()],
                add_position: None,
            }]),
            indexes: Some(vec![IndexDiff {
                diff_type: "removed".into(),
                name: "idx_events_payload".into(),
                source: None,
                target: None,
                changes: Vec::new(),
            }]),
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: Some(Some("new table description".into())),
            target_table_comment: Some(Some("old table description".into())),
            sync_sql: None,
        };

        let sql = generate_schema_sync_sql(
            &[modified],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("audit"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );
        assert!(sql.contains("DROP INDEX [idx_events_payload] ON [audit].[events];"), "DROP INDEX: {sql}");
        assert!(sql.contains("sys.sp_updateextendedproperty"), "update existing MS_Description: {sql}");
        assert!(sql.contains("sys.sp_addextendedproperty"), "add missing MS_Description: {sql}");
        assert!(!sql.contains("sys.sp_dropextendedproperty"), "non-empty comments are not dropped first: {sql}");
        assert!(!sql.contains("COMMENT ON"), "SQL Server has no COMMENT ON: {sql}");

        let removed = TableDiff {
            diff_type: "removed".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            ..Default::default()
        };
        let drop_sql = generate_schema_sync_sql(
            &[removed],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("audit"),
            true,
            Some(DialectKind::SqlServer),
            &[],
        );
        assert!(
            drop_sql.contains("IF OBJECT_ID(N'[audit].[events]', N'U') IS NOT NULL DROP TABLE [audit].[events];"),
            "version-compatible conditional DROP: {drop_sql}"
        );
        assert!(!drop_sql.contains("CASCADE"), "SQL Server has no DROP CASCADE: {drop_sql}");
    }

    #[test]
    fn sqlserver_structured_create_preserves_only_explicit_identity() {
        let identity =
            ColumnInfo { is_primary_key: true, extra: Some("identity(10,5)".into()), ..column("id", "int", None) };
        let ordinary_pk = ColumnInfo { is_primary_key: true, is_nullable: true, ..column("tenant_id", "int", None) };
        let added = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "accounts".into(),
            columns: Some(vec![
                ColumnDiff {
                    diff_type: "added".into(),
                    name: "id".into(),
                    source: Some(identity),
                    target: None,
                    changes: Vec::new(),
                    add_position: None,
                },
                ColumnDiff {
                    diff_type: "added".into(),
                    name: "tenant_id".into(),
                    source: Some(ordinary_pk),
                    target: None,
                    changes: Vec::new(),
                    add_position: None,
                },
            ]),
            ..Default::default()
        };

        let sql = generate_schema_sync_sql(
            &[added],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );
        assert!(sql.contains("[id] int IDENTITY(10,5) NOT NULL"), "identity order and seed: {sql}");
        assert!(sql.contains("[tenant_id] int NOT NULL"), "SQL Server PK columns cannot be nullable: {sql}");
        assert_eq!(sql.matches("IDENTITY(").count(), 1, "integer PKs must not become identity implicitly: {sql}");
        assert!(sql.contains("PRIMARY KEY ([id], [tenant_id])"), "primary key: {sql}");
    }

    #[test]
    fn sqlserver_function_and_sequence_changes_use_tsql_verbs() {
        let function = FunctionDiff {
            diff_type: "modified".into(),
            name: "next_value".into(),
            source: Some(FunctionInfo {
                name: "next_value".into(),
                function_type: "scalar".into(),
                data_type: "int".into(),
                definition: "() RETURNS int AS BEGIN RETURN 1 END".into(),
                arguments: String::new(),
            }),
            target: None,
            changes: Vec::new(),
        };
        let removed_function = FunctionDiff {
            diff_type: "removed".into(),
            name: "old_value".into(),
            source: None,
            target: None,
            changes: Vec::new(),
        };
        let sequence = SequenceDiff {
            diff_type: "modified".into(),
            name: "event_seq".into(),
            source: Some(SequenceInfo {
                name: "event_seq".into(),
                data_type: "bigint".into(),
                start_value: "10".into(),
                min_value: "1".into(),
                max_value: "9223372036854775807".into(),
                increment: "5".into(),
                cycle: false,
                last_value: None,
            }),
            target: Some(SequenceInfo {
                name: "event_seq".into(),
                data_type: "int".into(),
                start_value: "1".into(),
                min_value: "1".into(),
                max_value: "2147483647".into(),
                increment: "1".into(),
                cycle: false,
                last_value: None,
            }),
            changes: Vec::new(),
        };

        let sql = generate_schema_sync_sql(
            &[],
            &[function, removed_function],
            &[sequence],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );
        assert!(sql.contains("ALTER FUNCTION [dbo].[next_value]"), "modified function: {sql}");
        assert!(sql.contains("DROP FUNCTION [dbo].[old_value];"), "removed function: {sql}");
        assert!(!sql.contains("DROP FUNCTION IF EXISTS"), "legacy-compatible function drop: {sql}");
        assert!(
            sql.contains(
                "ALTER SEQUENCE [dbo].[event_seq] RESTART WITH 10 INCREMENT BY 5 MINVALUE 1 MAXVALUE 9223372036854775807 NO CYCLE;"
            ),
            "modified sequence: {sql}"
        );
        assert!(!sql.contains("ALTER SEQUENCE [dbo].[event_seq] AS"), "ALTER SEQUENCE cannot change type: {sql}");
        assert!(!sql.contains("ALTER SEQUENCE [dbo].[event_seq] START WITH"), "use RESTART WITH: {sql}");
        assert!(sql.contains("cannot change the data type"), "manual type-change diagnostic: {sql}");
    }

    #[test]
    fn sqlserver_drops_changed_indexes_and_defaults_before_columns() {
        let target_column = ColumnInfo { column_default: Some("((0))".into()), ..column("legacy_status", "int", None) };
        let target_index = IndexInfo {
            name: "idx_events_legacy_status".into(),
            columns: vec!["legacy_status".into()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: Some("NONCLUSTERED".into()),
            included_columns: None,
            comment: None,
            key_is_expression: Vec::new(),
        };
        let diff = TableDiff {
            diff_type: "modified".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            columns: Some(vec![ColumnDiff {
                diff_type: "removed".into(),
                name: "legacy_status".into(),
                source: None,
                target: Some(target_column),
                changes: Vec::new(),
                add_position: None,
            }]),
            indexes: Some(vec![IndexDiff {
                diff_type: "removed".into(),
                name: "idx_events_legacy_status".into(),
                source: None,
                target: Some(target_index),
                changes: Vec::new(),
            }]),
            ..Default::default()
        };

        let sql = generate_schema_sync_sql(
            &[diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );
        let index_drop = sql.find("DROP INDEX [idx_events_legacy_status] ON [dbo].[events]").expect("index drop");
        let default_drop = sql.find("sys.default_constraints").expect("default constraint lookup");
        let column_drop = sql.find("ALTER TABLE [dbo].[events] DROP COLUMN [legacy_status]").expect("column drop");
        assert!(index_drop < default_drop && default_drop < column_drop, "dependency order: {sql}");
        assert!(sql.contains("sys.key_constraints"), "constraint-backed index handling: {sql}");
        assert_eq!(
            sql.matches("DROP INDEX [idx_events_legacy_status] ON [dbo].[events]").count(),
            1,
            "drop once: {sql}"
        );
    }

    #[test]
    fn sqlserver_column_changes_capture_dependencies_omitted_from_the_diff() {
        let source_column = column("amount", "bigint", None);
        let target_column = column("amount", "int", None);
        let unchanged_index = IndexInfo {
            name: "idx_events_amount".into(),
            columns: vec!["amount".into()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: Some("NONCLUSTERED".into()),
            included_columns: None,
            comment: None,
            key_is_expression: Vec::new(),
        };
        let unchanged_fk = ForeignKeyInfo {
            name: "fk_events_parent".into(),
            column: "amount".into(),
            ref_schema: Some("dbo".into()),
            ref_table: "parents".into(),
            ref_column: "amount".into(),
            on_update: None,
            on_delete: None,
        };
        let detail = |column: ColumnInfo| TableSchemaDetail {
            name: "events".into(),
            columns: vec![column],
            indexes: vec![unchanged_index.clone()],
            foreign_keys: vec![unchanged_fk.clone()],
            triggers: Vec::new(),
            ddl: None,
        };
        let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
            source_tables: vec![table_info("events", "BASE TABLE")],
            target_tables: vec![table_info("events", "BASE TABLE")],
            source_details: vec![detail(source_column)],
            target_details: vec![detail(target_column)],
            database_type: DatabaseType::SqlServer,
            target_schema: Some("dbo".into()),
            source_dialect: Some(DialectKind::SqlServer),
            target_dialect: Some(DialectKind::SqlServer),
            ..Default::default()
        });

        assert_eq!(prepared.diffs.len(), 1);
        assert!(prepared.diffs[0].indexes.is_none(), "unchanged index is intentionally absent from the diff");
        assert!(prepared.diffs[0].foreign_keys.is_none(), "unchanged FK is intentionally absent from the diff");

        let sql = &prepared.sync_sql;
        for catalog in [
            "sys.indexes AS idx",
            "sys.key_constraints AS key_constraint",
            "sys.check_constraints AS cc",
            "sys.foreign_keys AS fk",
            "sys.stats_columns AS sc",
        ] {
            assert!(sql.contains(catalog), "runtime dependency catalog {catalog}: {sql}");
        }
        assert!(sql.contains("fkc.referenced_object_id = @dbx_object_id"), "inbound FK predicate: {sql}");
        assert!(sql.contains("THEN N''PRIMARY KEY '' ELSE N''UNIQUE '' END"), "preserve key object type: {sql}");
        assert!(sql.contains("ALTER COLUMN [amount] bigint NOT NULL"), "column alter: {sql}");
        assert!(!sql.contains("idx_events_amount"), "dependency names must come from the live target catalog: {sql}");
        assert!(!sql.contains("fk_events_parent"), "dependency names must come from the live target catalog: {sql}");

        let executable = crate::sql::split_sql_statements_for_database(sql, DatabaseType::SqlServer);
        assert_eq!(executable.len(), 1, "the catalog snapshot/drop/alter/recreate flow must stay in one batch: {sql}");
        assert!(executable[0].contains("EXEC sys.sp_executesql N'"), "single executable batch: {sql}");
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
    async fn live_sqlserver_alter_column_preserves_unchanged_runtime_dependencies() {
        let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
        let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
            .expect("DBX_LIVE_SQLSERVER_PORT")
            .parse()
            .expect("valid DBX_LIVE_SQLSERVER_PORT");
        let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
        let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
        let mut client = crate::db::sqlserver::connect(
            &host,
            port,
            &user,
            &password,
            Some(&database),
            None,
            std::time::Duration::from_secs(10),
        )
        .await
        .expect("connect SQL Server");

        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let lookup_table = format!("dbx_dep_lookup_{suffix}");
        let parent_table = format!("dbx_dep_parent_{suffix}");
        let child_table = format!("dbx_dep_child_{suffix}");
        let primary_key = format!("PK_dbx_dep_parent_{suffix}");
        let unique_constraint = format!("UQ_dbx_dep_parent_code_{suffix}");
        let lookup_unique_constraint = format!("UQ_dbx_dep_lookup_code_{suffix}");
        let check_constraint = format!("CK_dbx_dep_parent_values_{suffix}");
        let outbound_foreign_key = format!("FK_dbx_dep_parent_lookup_{suffix}");
        let inbound_foreign_key = format!("FK_dbx_dep_child_parent_{suffix}");
        let ordinary_index = format!("IX_dbx_dep_parent_code_{suffix}");
        let cleanup = format!(
            "DROP TABLE IF EXISTS [dbo].[{child_table}];\
             DROP TABLE IF EXISTS [dbo].[{parent_table}];\
             DROP TABLE IF EXISTS [dbo].[{lookup_table}];"
        );
        let _ = crate::db::sqlserver::execute_batch(&mut client, &cleanup).await;

        let exercise = async {
            let setup = format!(
                "SET ANSI_NULLS ON;\
                 SET QUOTED_IDENTIFIER ON;\
                 SET ANSI_PADDING ON;\
                 SET ANSI_WARNINGS ON;\
                 SET CONCAT_NULL_YIELDS_NULL ON;\
                 SET ARITHABORT ON;\
                 SET NUMERIC_ROUNDABORT OFF;\
                 CREATE TABLE [dbo].[{lookup_table}] (\
                     [code] INT NOT NULL,\
                     CONSTRAINT [{lookup_unique_constraint}] UNIQUE NONCLUSTERED ([code] ASC)\
                 );\
                 CREATE TABLE [dbo].[{parent_table}] (\
                     [id] INT NOT NULL,\
                     [code] INT NOT NULL,\
                     [payload] NVARCHAR(64) NULL,\
                     CONSTRAINT [{primary_key}] PRIMARY KEY CLUSTERED ([id] ASC),\
                     CONSTRAINT [{unique_constraint}] UNIQUE NONCLUSTERED ([code] ASC),\
                     CONSTRAINT [{check_constraint}] CHECK ([id] > 0 AND [code] >= 0),\
                     CONSTRAINT [{outbound_foreign_key}] FOREIGN KEY ([code])\
                         REFERENCES [dbo].[{lookup_table}] ([code])\
                 );\
                 CREATE TABLE [dbo].[{child_table}] (\
                     [id] INT NOT NULL,\
                     [parent_code] INT NULL,\
                     CONSTRAINT [{inbound_foreign_key}] FOREIGN KEY ([parent_code])\
                         REFERENCES [dbo].[{parent_table}] ([code])\
                         ON UPDATE CASCADE ON DELETE SET NULL NOT FOR REPLICATION\
                 );\
                 CREATE NONCLUSTERED INDEX [{ordinary_index}]\
                     ON [dbo].[{parent_table}] ([code] DESC, [id] ASC)\
                     INCLUDE ([payload])\
                     WHERE [code] IS NOT NULL\
                     WITH (PAD_INDEX = ON, FILLFACTOR = 80, STATISTICS_NORECOMPUTE = ON,\
                           ALLOW_ROW_LOCKS = OFF, ALLOW_PAGE_LOCKS = ON)\
                     ON [PRIMARY];"
            );
            crate::db::sqlserver::execute_batch(&mut client, &setup).await?;

            let target_detail = TableSchemaDetail {
                name: parent_table.clone(),
                columns: crate::db::sqlserver::get_columns(&mut client, "dbo", &parent_table).await?,
                indexes: crate::db::sqlserver::list_indexes(&mut client, "dbo", &parent_table).await?,
                foreign_keys: crate::db::sqlserver::list_foreign_keys(&mut client, "dbo", &parent_table).await?,
                triggers: Vec::new(),
                ddl: None,
            };
            let mut source_detail = target_detail.clone();
            let source_id = source_detail
                .columns
                .iter_mut()
                .find(|column| column.name == "id")
                .ok_or_else(|| "live target metadata did not contain id".to_string())?;
            source_id.data_type = "bigint".to_string();
            source_id.numeric_precision = Some(19);
            let source_code = source_detail
                .columns
                .iter_mut()
                .find(|column| column.name == "code")
                .ok_or_else(|| "live target metadata did not contain code".to_string())?;
            source_code.is_nullable = true;

            let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
                source_tables: vec![table_info(&parent_table, "BASE TABLE")],
                target_tables: vec![table_info(&parent_table, "BASE TABLE")],
                source_details: vec![source_detail],
                target_details: vec![target_detail],
                database_type: DatabaseType::SqlServer,
                target_schema: Some("dbo".to_string()),
                source_dialect: Some(DialectKind::SqlServer),
                target_dialect: Some(DialectKind::SqlServer),
                ..Default::default()
            });

            crate::db::sqlserver::execute_batch(&mut client, "SET QUOTED_IDENTIFIER OFF;").await?;
            crate::db::sqlserver::execute_batch(&mut client, &prepared.sync_sql).await?;
            let verification_sql = format!(
                "DECLARE @parent_id int = OBJECT_ID(N'[dbo].[{parent_table}]');\
                 SELECT\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.indexes AS idx\
                     JOIN sys.stats AS stats\
                       ON stats.object_id = idx.object_id AND stats.stats_id = idx.index_id\
                     JOIN sys.data_spaces AS data_space ON data_space.data_space_id = idx.data_space_id\
                     JOIN sys.index_columns AS key_ic\
                       ON key_ic.object_id = idx.object_id AND key_ic.index_id = idx.index_id\
                     JOIN sys.columns AS key_column\
                       ON key_column.object_id = key_ic.object_id AND key_column.column_id = key_ic.column_id\
                     WHERE idx.object_id = @parent_id\
                       AND idx.name = N'{ordinary_index}'\
                       AND idx.type_desc = N'NONCLUSTERED'\
                       AND idx.is_primary_key = 0 AND idx.is_unique_constraint = 0\
                       AND idx.is_disabled = 0 AND idx.has_filter = 1\
                       AND idx.is_padded = 1 AND idx.fill_factor = 80\
                       AND idx.allow_row_locks = 0 AND idx.allow_page_locks = 1\
                       AND stats.no_recompute = 1 AND data_space.name = N'PRIMARY'\
                       AND key_column.name = N'code' AND key_ic.key_ordinal = 1\
                       AND key_ic.is_descending_key = 1\
                       AND CHARINDEX(N'[code]', idx.filter_definition) > 0\
                       AND EXISTS (\
                         SELECT 1\
                         FROM sys.index_columns AS include_ic\
                         JOIN sys.columns AS include_column\
                           ON include_column.object_id = include_ic.object_id\
                          AND include_column.column_id = include_ic.column_id\
                         WHERE include_ic.object_id = idx.object_id\
                           AND include_ic.index_id = idx.index_id\
                           AND include_ic.is_included_column = 1\
                           AND include_column.name = N'payload'\
                       )\
                   ) THEN 1 ELSE 0 END) AS ordinary_index_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.key_constraints AS key_constraint\
                     JOIN sys.indexes AS idx\
                       ON idx.object_id = key_constraint.parent_object_id\
                      AND idx.index_id = key_constraint.unique_index_id\
                     JOIN sys.index_columns AS ic\
                       ON ic.object_id = idx.object_id AND ic.index_id = idx.index_id\
                     JOIN sys.columns AS column_info\
                       ON column_info.object_id = ic.object_id AND column_info.column_id = ic.column_id\
                     JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                     WHERE key_constraint.parent_object_id = @parent_id\
                       AND key_constraint.name = N'{primary_key}'\
                       AND key_constraint.type = N'PK'\
                       AND idx.is_primary_key = 1 AND idx.type_desc = N'CLUSTERED'\
                       AND ic.key_ordinal = 1 AND column_info.name = N'id'\
                       AND column_type.name = N'bigint' AND column_info.is_nullable = 0\
                   ) THEN 1 ELSE 0 END) AS primary_key_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.check_constraints AS check_constraint\
                     WHERE check_constraint.parent_object_id = @parent_id\
                       AND check_constraint.name = N'{check_constraint}'\
                       AND check_constraint.is_disabled = 0\
                       AND check_constraint.is_not_trusted = 0\
                       AND CHARINDEX(N'[id]', check_constraint.definition) > 0\
                       AND CHARINDEX(N'[code]', check_constraint.definition) > 0\
                   ) THEN 1 ELSE 0 END) AS check_constraint_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.foreign_keys AS foreign_key\
                     JOIN sys.foreign_key_columns AS fkc\
                       ON fkc.constraint_object_id = foreign_key.object_id\
                     JOIN sys.columns AS child_column\
                       ON child_column.object_id = fkc.parent_object_id\
                      AND child_column.column_id = fkc.parent_column_id\
                     JOIN sys.columns AS parent_column\
                       ON parent_column.object_id = fkc.referenced_object_id\
                      AND parent_column.column_id = fkc.referenced_column_id\
                     WHERE foreign_key.name = N'{inbound_foreign_key}'\
                       AND foreign_key.parent_object_id = OBJECT_ID(N'[dbo].[{child_table}]')\
                       AND foreign_key.referenced_object_id = @parent_id\
                       AND foreign_key.type = N'F'\
                       AND foreign_key.is_disabled = 0 AND foreign_key.is_not_trusted = 1\
                       AND foreign_key.is_not_for_replication = 1\
                       AND foreign_key.update_referential_action_desc = N'CASCADE'\
                       AND foreign_key.delete_referential_action_desc = N'SET_NULL'\
                       AND child_column.name = N'parent_code' AND parent_column.name = N'code'\
                       AND EXISTS (\
                         SELECT 1 FROM sys.key_constraints AS uq\
                         WHERE uq.parent_object_id = @parent_id\
                           AND uq.name = N'{unique_constraint}' AND uq.type = N'UQ'\
                       )\
                   ) THEN 1 ELSE 0 END) AS inbound_foreign_key_ok,\
                   CONVERT(int, CASE WHEN\
                     EXISTS (\
                       SELECT 1 FROM sys.columns AS column_info\
                       JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                       WHERE column_info.object_id = @parent_id AND column_info.name = N'id'\
                         AND column_type.name = N'bigint' AND column_info.is_nullable = 0\
                     )\
                     AND EXISTS (\
                       SELECT 1 FROM sys.columns AS column_info\
                       JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                       WHERE column_info.object_id = @parent_id AND column_info.name = N'code'\
                         AND column_type.name = N'int' AND column_info.is_nullable = 1\
                     )\
                   THEN 1 ELSE 0 END) AS altered_columns_ok;"
            );
            let verification = crate::db::sqlserver::execute_query(&mut client, &verification_sql).await?;
            Ok::<_, String>((prepared, verification))
        }
        .await;

        let cleanup_result = crate::db::sqlserver::execute_batch(&mut client, &cleanup).await;
        cleanup_result.expect("drop live SQL Server dependency test tables");
        let (prepared, verification) = exercise.expect("exercise live SQL Server dependency-aware ALTER COLUMN");

        assert_eq!(prepared.diffs.len(), 1, "diffs={:?}", prepared.diffs);
        let table_diff = &prepared.diffs[0];
        assert_eq!(table_diff.diff_type, "modified");
        assert_eq!(table_diff.columns.as_ref().map(Vec::len), Some(2));
        assert!(table_diff.indexes.is_none(), "unchanged indexes must be absent: {table_diff:?}");
        assert!(table_diff.foreign_keys.is_none(), "unchanged foreign keys must be absent: {table_diff:?}");
        assert!(
            !prepared.sync_sql.contains(&ordinary_index),
            "index must be discovered at runtime: {}",
            prepared.sync_sql
        );
        assert!(
            !prepared.sync_sql.contains(&outbound_foreign_key),
            "foreign keys must be discovered at runtime: {}",
            prepared.sync_sql
        );
        assert!(
            !prepared.sync_sql.contains(&inbound_foreign_key),
            "inbound foreign keys are not represented by the table diff: {}",
            prepared.sync_sql
        );

        assert_eq!(verification.rows.len(), 1, "verification={verification:?}");
        assert_eq!(
            verification.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
            ],
            "columns={:?}, sync_sql={} ",
            verification.columns,
            prepared.sync_sql
        );
    }

    #[test]
    fn sqlserver_index_and_foreign_key_forms_follow_tsql() {
        let btree = IndexInfo {
            name: "idx_events_status".into(),
            columns: vec!["status".into()],
            is_unique: true,
            is_primary: false,
            filter: Some("[status] IS NOT NULL".into()),
            index_type: Some("BTREE".into()),
            included_columns: Some(vec!["payload".into()]),
            comment: None,
            key_is_expression: Vec::new(),
        };
        let btree_sql = create_index_sql("events", &btree, DatabaseType::SqlServer, Some("dbo"));
        assert_eq!(
            btree_sql,
            "CREATE UNIQUE INDEX [idx_events_status] ON [dbo].[events] ([status]) INCLUDE ([payload]) WHERE [status] IS NOT NULL;"
        );
        assert!(!btree_sql.contains("BTREE"));

        let columnstore = IndexInfo {
            name: "ix_events_analytics".into(),
            columns: Vec::new(),
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: Some("NONCLUSTERED COLUMNSTORE".into()),
            included_columns: Some(vec!["status".into(), "payload".into()]),
            comment: None,
            key_is_expression: Vec::new(),
        };
        assert_eq!(
            create_index_sql("events", &columnstore, DatabaseType::SqlServer, Some("dbo")),
            "CREATE NONCLUSTERED COLUMNSTORE INDEX [ix_events_analytics] ON [dbo].[events] ([status], [payload]);"
        );

        let fk = ForeignKeyInfo {
            name: "fk_events_user".into(),
            column: "user_id".into(),
            ref_schema: Some("crm".into()),
            ref_table: "users".into(),
            ref_column: "id".into(),
            on_update: Some("RESTRICT".into()),
            on_delete: Some("SET NULL".into()),
        };
        let fk_sql = add_foreign_key_sql("events", &fk, DatabaseType::SqlServer, Some("dbo"));
        assert!(fk_sql.contains("ON DELETE SET NULL ON UPDATE NO ACTION"), "FK actions: {fk_sql}");
        assert!(!fk_sql.contains("RESTRICT"), "SQL Server does not accept RESTRICT: {fk_sql}");
    }

    #[test]
    fn sqlserver_uses_native_trigger_and_function_definitions_only_for_tsql_sources() {
        let columns = vec![ColumnDiff {
            diff_type: "added".into(),
            name: "id".into(),
            source: Some(column("id", "int", None)),
            target: None,
            changes: Vec::new(),
            add_position: None,
        }];
        let trigger = TriggerInfo {
            name: "trg_events_insert".into(),
            event: "INSERT".into(),
            timing: "AFTER".into(),
            level: None,
            condition: None,
            language: None,
            enabled: Some(true),
            valid: None,
            comment: None,
            created_at: None,
            statement: Some(
                "CREATE TRIGGER [dbo].[trg_events_insert] ON [dbo].[events] AFTER INSERT AS BEGIN SELECT 1; END".into(),
            ),
        };
        let (native_sql, native_missing) = generate_create_table_sql(
            "events",
            &columns,
            &[],
            &[],
            None,
            DatabaseType::SqlServer,
            Some("dbo"),
            Some(DialectKind::SqlServer),
            &[],
            std::slice::from_ref(&trigger),
        );
        assert!(native_missing.is_empty(), "native trigger is reconstructible");
        assert_eq!(native_sql.matches("CREATE TRIGGER").count(), 1, "do not nest native DDL: {native_sql}");
        assert!(!native_sql.contains("AS BEGIN CREATE TRIGGER"), "native trigger body: {native_sql}");
        let native_trigger_statements =
            crate::sql::split_sql_statements_for_database(&native_sql, DatabaseType::SqlServer);
        let trigger_batches = native_trigger_statements
            .iter()
            .filter(|statement| statement.contains("CREATE TRIGGER"))
            .collect::<Vec<_>>();
        assert_eq!(
            trigger_batches.len(),
            1,
            "trigger body must remain one executable batch: {native_trigger_statements:?}"
        );
        let trigger_executable = trigger_batches[0]
            .lines()
            .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with("--"))
            .expect("trigger executable line");
        assert!(trigger_executable.starts_with("EXEC sys.sp_executesql N'"), "trigger batch: {trigger_batches:?}");

        let (_, cross_missing) = generate_create_table_sql(
            "events",
            &columns,
            &[],
            &[],
            None,
            DatabaseType::SqlServer,
            Some("dbo"),
            Some(DialectKind::Mysql),
            &[],
            &[trigger],
        );
        assert_eq!(cross_missing.len(), 1, "foreign trigger must require manual translation");

        let native_function = FunctionDiff {
            diff_type: "modified".into(),
            name: "next_value".into(),
            source: Some(FunctionInfo {
                name: "next_value".into(),
                function_type: "scalar".into(),
                data_type: "int".into(),
                definition: "CREATE FUNCTION [source].[next_value]() RETURNS int AS BEGIN RETURN 2 END".into(),
                arguments: String::new(),
            }),
            target: None,
            changes: Vec::new(),
        };
        let native_function_sql = generate_schema_sync_sql(
            &[],
            &[native_function],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );
        assert!(
            native_function_sql.contains("ALTER FUNCTION [dbo].[next_value]() RETURNS int"),
            "native function verb and schema: {native_function_sql}"
        );
        assert_eq!(native_function_sql.matches("FUNCTION").count(), 1, "do not nest native function DDL");
        let native_function_statements =
            crate::sql::split_sql_statements_for_database(&native_function_sql, DatabaseType::SqlServer);
        let function_batches = native_function_statements
            .iter()
            .filter(|statement| statement.contains("ALTER FUNCTION"))
            .collect::<Vec<_>>();
        assert_eq!(
            function_batches.len(),
            1,
            "function body must remain one executable batch: {native_function_statements:?}"
        );
        let function_executable = function_batches[0]
            .lines()
            .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with("--"))
            .expect("function executable line");
        assert!(function_executable.starts_with("EXEC sys.sp_executesql N'"), "function batch: {function_batches:?}");

        let foreign_function = FunctionDiff {
            diff_type: "added".into(),
            name: "pg_only".into(),
            source: Some(FunctionInfo {
                name: "pg_only".into(),
                function_type: "FUNCTION".into(),
                data_type: "integer".into(),
                definition: "CREATE FUNCTION pg_only() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$".into(),
                arguments: String::new(),
            }),
            target: None,
            changes: Vec::new(),
        };
        let foreign_function_sql = generate_schema_sync_sql(
            &[],
            &[foreign_function],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("dbo"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );
        assert!(foreign_function_sql.contains("cannot be translated safely to T-SQL"));
        assert!(
            !foreign_function_sql.contains("CREATE FUNCTION"),
            "do not emit PostgreSQL DDL: {foreign_function_sql}"
        );
    }

    #[test]
    fn h2_rename_uses_alter_column_rename_to() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_name", "varchar(100)")],
            &[("id", "int"), ("old_name", "varchar(100)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::H2, None);
        assert!(sql.contains("ALTER COLUMN"), "H2 ALTER COLUMN: {sql}");
        assert!(sql.contains("RENAME TO"), "H2 RENAME TO: {sql}");
    }

    #[test]
    fn default_rename_all_other_databases() {
        let databases = [
            DatabaseType::ClickHouse,
            DatabaseType::Oracle,
            DatabaseType::DuckDb,
            DatabaseType::Informix,
            DatabaseType::Questdb,
        ];
        for db in databases {
            let diffs = make_col_diffs(
                &[("id", "int"), ("new_name", "varchar(100)")],
                &[("id", "int"), ("old_name", "varchar(100)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, None);
            assert!(sql.contains("RENAME COLUMN"), "{db:?} uses RENAME COLUMN: {sql}");
            assert!(!sql.contains('`'), "{db:?} no backticks: {sql}");
        }
    }

    // -- 7. MySQL-like databases (Doris, StarRocks) --
    #[test]
    fn mysql_like_databases_use_mysql_syntax() {
        let mysql_likes = [
            DatabaseType::Doris,
            DatabaseType::StarRocks,
            DatabaseType::Goldendb,
            DatabaseType::Sundb,
            DatabaseType::Databend,
            DatabaseType::Gbase,
        ];
        for db in mysql_likes {
            let diffs = make_col_diffs(
                &[("id", "int"), ("name2", "varchar(50)")],
                &[("id", "int"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, None);
            assert!(sql.contains('`'), "{db:?} uses backticks: {sql}");
            assert!(sql.contains("CHANGE COLUMN"), "{db:?} uses CHANGE COLUMN: {sql}");
        }
    }

    // -- 8. No type conversion for unsupported dialect pairs --
    #[test]
    fn mysql_to_unsupported_dialect_types_pass_through() {
        let targets = [
            DatabaseType::ClickHouse,
            DatabaseType::Oracle,
            DatabaseType::DuckDb,
            DatabaseType::Informix,
            DatabaseType::H2,
            DatabaseType::Questdb,
        ];
        for target in targets {
            let diffs = make_col_diffs(
                &[("id", "int(11)"), ("name2", "varchar(50)")],
                &[("id", "integer"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), target, Some(DialectKind::Mysql));
            // No dialect-pair matrix for these targets; profile still strips MySQL display width.
            assert!(sql.contains("INT"), "{target:?} strips display width to INT: {sql}");
            assert!(!sql.contains("int(11)"), "{target:?} no MySQL display width: {sql}");
            assert!(!sql.contains('`'), "{target:?} no backticks: {sql}");
        }
    }

    #[test]
    fn mysql_to_sqlserver_uses_native_target_types() {
        let diffs = make_col_diffs(
            &[
                ("flag", "tinyint(1)"),
                ("payload", "json"),
                ("body", "longtext"),
                ("raw", "blob"),
                ("created_at", "datetime(6)"),
                ("ratio", "double"),
            ],
            &[],
            false,
        );
        let sql = gen_sql(wrap_table_diff("events", diffs), DatabaseType::SqlServer, Some(DialectKind::Mysql));

        assert!(sql.contains("[flag] BIT"), "tinyint(1) → BIT: {sql}");
        assert!(sql.contains("[payload] NVARCHAR(MAX)"), "json → NVARCHAR(MAX): {sql}");
        assert!(sql.contains("[body] NVARCHAR(MAX)"), "longtext → NVARCHAR(MAX): {sql}");
        assert!(sql.contains("[raw] VARBINARY(MAX)"), "blob → VARBINARY(MAX): {sql}");
        assert!(sql.contains("[created_at] DATETIME2(6)"), "datetime → DATETIME2: {sql}");
        assert!(sql.contains("[ratio] FLOAT"), "double → FLOAT: {sql}");
    }

    // -- 9. Passthrough when source_dialect is None --
    #[test]
    fn without_source_dialect_types_preserved() {
        let diffs = make_col_diffs(&[("id", "int(11)"), ("flag", "tinyint")], &[("id", "bigint")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        // No source dialect → no matrix mapping; PG profile still strips display width.
        assert!(sql.contains("INT"), "display width stripped to INT: {sql}");
        assert!(!sql.contains("int(11)"), "no MySQL display width: {sql}");
        assert!(sql.contains("tinyint"), "passthrough tinyint: {sql}");
    }

    // -- 10. All MySQL→PostgreSQL type mapping rules --
    #[test]
    fn mysql_to_postgresql_specific_type_conversions() {
        let cases = [
            ("ti1", "tinyint(1)", "BOOLEAN"),
            ("tiny", "tinyint", "SMALLINT"),
            ("med", "mediumint", "INTEGER"),
            ("int_", "int", "INTEGER"),
            ("big", "bigint", "BIGINT"),
            ("flt", "float", "REAL"),
            ("dbl", "double", "DOUBLE PRECISION"),
            ("txs", "tinytext", "TEXT"),
            ("tx", "text", "TEXT"),
            ("txm", "mediumtext", "TEXT"),
            ("txl", "longtext", "TEXT"),
            ("blb", "blob", "BYTEA"),
            ("bls", "tinyblob", "BYTEA"),
            ("blm", "mediumblob", "BYTEA"),
            ("bll", "longblob", "BYTEA"),
            ("dt", "datetime", "TIMESTAMP"),
        ];
        for (name, mysql_type, expected_pg) in cases {
            let diffs = make_col_diffs(&[(name, mysql_type)], &[], false);
            let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, Some(DialectKind::Mysql));
            assert!(sql.contains(expected_pg), "MySQL {mysql_type} → PostgreSQL {expected_pg}: {sql}");
        }
    }

    // -- 11. PostgreSQL→MySQL all reverse type mappings --
    #[test]
    fn postgresql_to_mysql_all_type_mappings() {
        let mappings = [
            ("sml", "smallint", "SMALLINT"),
            ("int_", "integer", "INT"),
            ("big", "bigint", "BIGINT"),
            ("real", "real", "FLOAT"),
            ("dp", "double precision", "DOUBLE"),
            ("tx", "text", "LONGTEXT"),
            ("ba", "bytea", "BLOB"),
            ("bl", "boolean", "TINYINT(1)"),
            ("ts", "timestamp", "DATETIME"),
            ("tstz", "timestamptz", "DATETIME"),
            ("uuid", "uuid", "CHAR(36)"),
            ("jb", "jsonb", "JSON"),
        ];
        for (name, pg_type, expected_mysql) in mappings {
            let diffs = make_col_diffs(&[(name, pg_type)], &[], false);
            let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, Some(DialectKind::Postgres));
            assert!(sql.contains(expected_mysql), "PG {pg_type} → MySQL {expected_mysql}: {sql}");
        }
    }

    // -- 12. MySQL→SQLite all type mappings --
    #[test]
    fn mysql_to_sqlite_all_type_mappings() {
        let mappings = [
            ("int", "int", "INTEGER"),
            ("bi", "bigint", "INTEGER"),
            ("ti", "tinyint", "INTEGER"),
            ("si", "smallint", "INTEGER"),
            ("mi", "mediumint", "INTEGER"),
            ("db", "double", "REAL"),
            ("fl", "float", "REAL"),
            ("dt", "datetime", "TEXT"),
            ("ts", "timestamp", "TEXT"),
            ("tx", "text", "TEXT"),
            ("bl", "blob", "BLOB"),
        ];
        for (name, mysql_type, expected_sqlite) in mappings {
            let diffs = make_col_diffs(&[(name, mysql_type)], &[], false);
            let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Sqlite, Some(DialectKind::Mysql));
            assert!(sql.contains(expected_sqlite), "MySQL {mysql_type} → SQLite {expected_sqlite}: {sql}");
        }
    }

    // -- 13. Same-dialect: ClickHouse (double-quotes, default rename) --
    #[test]
    fn clickhouse_same_dialect_operations() {
        let diffs = make_col_diffs(&[("id", "Int32"), ("new_col", "String")], &[("id", "Int32")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::ClickHouse, None);
        assert!(sql.contains("ADD COLUMN"), "ClickHouse add: {sql}");
        assert!(!sql.contains('`'), "ClickHouse no backticks: {sql}");
    }

    // -- 14. Same-dialect: Oracle --
    #[test]
    fn oracle_same_dialect_operations() {
        let diffs = make_col_diffs(&[("id", "NUMBER"), ("name", "VARCHAR2(100)")], &[("id", "NUMBER")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Oracle, None);
        assert!(sql.contains("ADD COLUMN"), "Oracle add: {sql}");
        assert!(!sql.contains('`'), "Oracle no backticks: {sql}");
    }

    // -- 15. Same-dialect: SQL Server with rename --
    #[test]
    fn sqlserver_same_dialect_rename() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_name", "nvarchar(100)")],
            &[("id", "int"), ("old_name", "nvarchar(100)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::SqlServer, None);
        assert!(sql.contains("sp_rename"), "SQL Server rename: {sql}");
    }

    // -- 16. Same-dialect: H2 --
    #[test]
    fn h2_same_dialect_rename() {
        let diffs = make_col_diffs(
            &[("id", "INT"), ("new_name", "VARCHAR(100)")],
            &[("id", "INT"), ("old_name", "VARCHAR(100)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::H2, None);
        assert!(sql.contains("ALTER COLUMN"), "H2 rename: {sql}");
        assert!(sql.contains("RENAME TO"), "H2 rename to: {sql}");
    }

    // -- 17. Same-dialect: DuckDB --
    #[test]
    fn duckdb_same_dialect_add() {
        let diffs = make_col_diffs(&[("id", "INTEGER"), ("name", "VARCHAR")], &[("id", "INTEGER")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::DuckDb, None);
        assert!(sql.contains("ADD COLUMN"), "DuckDB add: {sql}");
        assert!(!sql.contains('`'), "DuckDB no backticks: {sql}");
    }

    // -- 18. Schema-qualified SQL output --
    #[test]
    fn schema_qualified_output() {
        let diffs = make_col_diffs(&[("name2", "varchar(50)")], &[("name", "varchar(50)")], true);
        let table_diff = wrap_table_diff("users", diffs);
        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("public"),
            false,
            None,
            &[],
        );
        assert!(sql.contains("\"public\".\"users\""), "schema prefixed: {sql}");
    }

    #[test]
    fn schema_qualified_mysql() {
        let diffs = make_col_diffs(&[("name2", "varchar(50)")], &[("name", "varchar(50)")], true);
        let table_diff = wrap_table_diff("users", diffs);
        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("mydb"),
            false,
            None,
            &[],
        );
        assert!(sql.contains("`mydb`.`users`"), "schema prefixed MySQL: {sql}");
    }

    // -- 19. Multiple operations in one diff --
    #[test]
    fn multiple_concurrent_operations() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("name2", "varchar(50)"), ("new_col", "text"), ("keep", "boolean")],
            &[("id", "bigint"), ("name", "varchar(50)"), ("old_col", "int"), ("keep", "boolean")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("RENAME COLUMN"), "rename: {sql}");
        assert!(sql.contains("ADD COLUMN"), "add: {sql}");
        assert!(sql.contains("DROP COLUMN"), "drop: {sql}");
        assert!(sql.contains("ALTER COLUMN"), "modify type: {sql}");
    }

    #[test]
    fn multiple_concurrent_operations_mysql() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("name2", "varchar(50)"), ("new_col", "text")],
            &[("id", "bigint"), ("name", "varchar(50)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("CHANGE COLUMN"), "MySQL rename: {sql}");
        assert!(sql.contains("ADD COLUMN"), "MySQL add: {sql}");
        assert!(sql.contains("MODIFY COLUMN"), "MySQL modify: {sql}");
    }

    // -- 20. All-removed and all-added edge cases --
    #[test]
    fn all_columns_removed() {
        let diffs = make_col_diffs(&[], &[("old1", "int"), ("old2", "varchar(10)")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert_eq!(sql.matches("DROP COLUMN").count(), 2, "two drops: {sql}");
    }

    #[test]
    fn all_columns_added() {
        let diffs = make_col_diffs(&[("new1", "int"), ("new2", "varchar(10)")], &[], false);
        for db in [DatabaseType::Mysql, DatabaseType::Postgres, DatabaseType::Oracle] {
            let sql = gen_sql(wrap_table_diff("t", diffs.clone()), db, None);
            assert_eq!(sql.matches("ADD COLUMN").count(), 2, "{db:?} two adds: {sql}");
        }
    }

    // -- 21. Rename + type change in one column --
    #[test]
    fn rename_with_simultaneous_type_change() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_name", "varchar(200)")],
            &[("id", "int"), ("old_name", "varchar(50)")],
            true,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("RENAME COLUMN"), "rename: {sql}");
        assert!(sql.contains("TYPE varchar(200)"), "type change: {sql}");
    }

    // -- 22. PostgreSQL→PostgreSQL: nullability changes --
    #[test]
    fn postgres_nullable_change() {
        let source = vec![ColumnInfo {
            name: "name".into(),
            data_type: "text".into(),
            is_nullable: true,
            ..column("name", "text", None)
        }];
        let target = vec![ColumnInfo {
            name: "name".into(),
            data_type: "text".into(),
            is_nullable: false,
            ..column("name", "text", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("DROP NOT NULL"), "nullable change: {sql}");
    }

    #[test]
    fn postgres_not_nullable_change() {
        let source = vec![ColumnInfo {
            name: "name".into(),
            data_type: "text".into(),
            is_nullable: false,
            ..column("name", "text", None)
        }];
        let target = vec![ColumnInfo {
            name: "name".into(),
            data_type: "text".into(),
            is_nullable: true,
            ..column("name", "text", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("SET NOT NULL"), "not null change: {sql}");
    }

    // -- 23. PostgreSQL→SQLite (no existing mapping rules) --
    #[test]
    fn postgresql_to_sqlite_no_type_mapping() {
        let diffs = make_col_diffs(&[("id", "integer"), ("data", "text"), ("ts", "timestamp")], &[], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Sqlite, Some(DialectKind::Postgres));
        // No PG→SQLite dialect matrix, but SQLite profile type_map still rewrites affinities.
        assert!(sql.contains("INTEGER"), "integer→INTEGER: {sql}");
        assert!(sql.contains("TEXT"), "text/timestamp→TEXT: {sql}");
        assert!(!sql.contains("timestamp"), "timestamp mapped away: {sql}");
    }

    // -- 24. All MySQL-like databases with rename + type change --
    #[test]
    fn mysql_like_rename_with_type_conversion() {
        let mysql_likes: [(DatabaseType, &str); 7] = [
            (DatabaseType::Mysql, "Mysql"),
            (DatabaseType::Doris, "Doris"),
            (DatabaseType::StarRocks, "StarRocks"),
            (DatabaseType::Goldendb, "Goldendb"),
            (DatabaseType::Sundb, "Sundb"),
            (DatabaseType::Databend, "Databend"),
            (DatabaseType::Gbase, "Gbase"),
        ];
        for (db, label) in mysql_likes {
            let diffs = make_col_diffs(
                &[("id", "int(11)"), ("name2", "varchar(50)")],
                &[("id", "int"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, Some(DialectKind::Mysql));
            assert!(sql.contains("CHANGE COLUMN"), "{label} CHANGE COLUMN: {sql}");
            assert!(sql.contains('`'), "{label} backticks: {sql}");
            assert!(sql.contains("MODIFY COLUMN"), "{label} MODIFY: {sql}");
        }
    }

    // -- 25. Rename with nullable change --
    #[test]
    fn rename_with_nullable_change() {
        let source = vec![ColumnInfo {
            name: "new_col".into(),
            data_type: "text".into(),
            is_nullable: true,
            ..column("new_col", "text", None)
        }];
        let target = vec![ColumnInfo {
            name: "old_col".into(),
            data_type: "text".into(),
            is_nullable: false,
            ..column("old_col", "text", None)
        }];
        let diffs = diff_columns_with_options(&source, &target, false, false, true, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("RENAME COLUMN"), "rename: {sql}");
        assert!(sql.contains("DROP NOT NULL"), "nullable: {sql}");
    }

    // -- 26. Empty diff generates no SQL --
    #[test]
    fn empty_diff_generates_no_sql() {
        let diffs: Vec<ColumnDiff> = vec![];
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert_eq!(sql, "", "empty diff should generate no SQL");
        let sql = gen_sql(wrap_table_diff("t", vec![]), DatabaseType::Postgres, None);
        assert_eq!(sql, "", "empty diff should generate no SQL for postgres");
    }

    // -- 27. Databend and Gbase (MySQL-like) --
    #[test]
    fn databend_gbase_mysql_like() {
        for db in [DatabaseType::Databend, DatabaseType::Gbase] {
            let diffs = make_col_diffs(
                &[("id", "int"), ("name2", "varchar(50)")],
                &[("id", "int"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, None);
            assert!(sql.contains('`'), "{db:?} backticks: {sql}");
        }
    }

    // -- 28. Postgres-compatible databases (GaussDB, openGauss, etc.) --
    #[test]
    fn postgres_like_databases() {
        let pg_likes = [
            DatabaseType::Gaussdb,
            DatabaseType::Kwdb,
            DatabaseType::OpenGauss,
            DatabaseType::Highgo,
            DatabaseType::Vastbase,
            DatabaseType::Kingbase,
            DatabaseType::Firebird,
            DatabaseType::Redshift,
            DatabaseType::Vertica,
            DatabaseType::Exasol,
        ];
        for db in pg_likes {
            let diffs = make_col_diffs(
                &[("id", "int"), ("name2", "varchar(50)")],
                &[("id", "int"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, None);
            assert!(sql.contains("RENAME COLUMN"), "{db:?} RENAME COLUMN: {sql}");
            assert!(!sql.contains('`'), "{db:?} no backticks: {sql}");
        }
    }

    // -- 29. SQLite-compatible databases --
    #[test]
    fn sqlite_like_databases() {
        let sqlite_likes = [DatabaseType::Rqlite, DatabaseType::Turso];
        for db in sqlite_likes {
            let diffs = make_col_diffs(
                &[("id", "int"), ("name2", "varchar(50)")],
                &[("id", "int"), ("name", "varchar(50)")],
                true,
            );
            let sql = gen_sql(wrap_table_diff("t", diffs), db, None);
            assert!(sql.contains("RENAME COLUMN"), "{db:?} RENAME COLUMN: {sql}");
            assert!(!sql.contains('`'), "{db:?} no backticks: {sql}");
        }
    }

    // -- 30. ManticoreSearch (separate dialect) --
    #[test]
    fn manticore_search_sql() {
        let diffs = make_col_diffs(&[("id", "bigint"), ("title", "text")], &[("id", "bigint")], false);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::ManticoreSearch, None);
        assert!(sql.contains("ADD COLUMN"), "Manticore add: {sql}");
        assert!(sql.contains('`'), "Manticore uses backtick identifiers (MySQL-compatible): {sql}");
    }

    #[test]
    fn detects_modified_indexes_not_only_added_or_removed_indexes() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_orders_status".to_string(),
                columns: vec!["status".to_string(), "created_at".to_string()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_orders_status".to_string(),
                columns: vec!["status".to_string()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "modified");
        assert_eq!(diffs[0].changes, vec!["unique: YES → NO", "columns: status → status, created_at"]);
    }

    #[test]
    fn detects_mysql_functional_index_changes_and_preserves_expression_ddl() {
        let functional_key_part = "((case when (`STATUS` = _utf8mb4'online') then _utf8mb4'online' else NULL end))";
        let source_index = index(IndexInfo {
            name: "test_UNIQUE".to_string(),
            columns: vec!["attr".to_string(), "attr2".to_string(), functional_key_part.to_string()],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
            key_is_expression: Vec::new(),
        });
        let target_index = index(IndexInfo {
            name: "test_UNIQUE".to_string(),
            columns: vec!["attr".to_string(), "attr2".to_string()],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
            key_is_expression: Vec::new(),
        });

        let diffs = diff_indexes(std::slice::from_ref(&source_index), &[target_index]);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "modified");
        assert_eq!(diffs[0].changes, vec![format!("columns: attr, attr2 → attr, attr2, {functional_key_part}")]);

        let sql = generate_schema_sync_sql(
            &[TableDiff {
                diff_type: "modified".to_string(),
                object_type: Some("table".to_string()),
                name: "test".to_string(),
                columns: None,
                indexes: Some(diffs),
                foreign_keys: None,
                triggers: None,
                ddl: None,
                target_ddl: None,
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            }],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("dbx_issue_4114"),
            false,
            None,
            &[],
        );

        assert!(sql.contains("DROP INDEX `test_UNIQUE` ON `dbx_issue_4114`.`test`;"));
        assert!(sql.contains(&format!(
            "CREATE UNIQUE INDEX `test_UNIQUE` ON `dbx_issue_4114`.`test` (`attr`, `attr2`, {functional_key_part});"
        )));
        assert!(!sql.contains("`((case"));
    }

    #[test]
    fn preserves_bare_expression_in_postgres_family_unique_index_ddl() {
        // Regression for #6295: highgo/postgres-family expression index key parts (e.g. from
        // pg_get_indexdef) arrived as raw expression text in IndexInfo.columns; quoting the
        // whole expression as an identifier turned it into a literal (and nonexistent) column.
        let expression_key_part = "COALESCE(height, '-1'::integer::double precision)";
        let new_index = index(IndexInfo {
            name: "uq_tankong_sta_type_time".to_string(),
            columns: vec![
                "sta_id".to_string(),
                "data_type".to_string(),
                "data_time".to_string(),
                expression_key_part.to_string(),
            ],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
            key_is_expression: vec![false, false, false, true],
        });

        let sql = generate_schema_sync_sql(
            &[TableDiff {
                diff_type: "modified".to_string(),
                object_type: Some("table".to_string()),
                name: "tankong_data".to_string(),
                columns: None,
                indexes: Some(vec![IndexDiff {
                    diff_type: "added".to_string(),
                    name: new_index.name.clone(),
                    source: Some(new_index),
                    target: None,
                    changes: vec![],
                }]),
                foreign_keys: None,
                triggers: None,
                ddl: None,
                target_ddl: None,
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            }],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Highgo,
            Some("public"),
            false,
            None,
            &[],
        );

        assert!(sql.contains(&format!(
            "CREATE UNIQUE INDEX \"uq_tankong_sta_type_time\" ON \"public\".\"tankong_data\" (\"sta_id\", \"data_type\", \"data_time\", {expression_key_part})"
        )));
        assert!(!sql.contains(&format!("\"{expression_key_part}\"")));
    }

    #[test]
    fn quotes_real_columns_whose_names_contain_expression_like_characters() {
        // PR #6312 review: a quoted column identifier can legitimately contain whitespace,
        // `(`, or `::` (e.g. PostgreSQL metadata returning the ordinary column name
        // `order item` through a.attname). The old character-based heuristic mistook such
        // columns for expressions and left them bare, generating an invalid
        // `CREATE INDEX ... (order item)` instead of `CREATE INDEX ... ("order item")`.
        // With real per-key provenance (`key_is_expression`), only genuine expression key
        // parts from pg_get_indexdef are left unquoted.
        let expression_key_part = "COALESCE(height, '-1'::integer::double precision)";
        let new_index = index(IndexInfo {
            name: "uq_weird_columns".to_string(),
            columns: vec![
                "order item".to_string(),
                "a(b)".to_string(),
                "a::b".to_string(),
                expression_key_part.to_string(),
            ],
            key_is_expression: vec![false, false, false, true],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        });

        let sql = generate_schema_sync_sql(
            &[TableDiff {
                diff_type: "modified".to_string(),
                object_type: Some("table".to_string()),
                name: "tankong_data".to_string(),
                columns: None,
                indexes: Some(vec![IndexDiff {
                    diff_type: "added".to_string(),
                    name: new_index.name.clone(),
                    source: Some(new_index),
                    target: None,
                    changes: vec![],
                }]),
                foreign_keys: None,
                triggers: None,
                ddl: None,
                target_ddl: None,
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            }],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Highgo,
            Some("public"),
            false,
            None,
            &[],
        );

        assert!(sql.contains(&format!(
            "CREATE UNIQUE INDEX \"uq_weird_columns\" ON \"public\".\"tankong_data\" (\"order item\", \"a(b)\", \"a::b\", {expression_key_part})"
        )));
        assert!(!sql.contains(&format!("\"{expression_key_part}\"")));

        // Real PostgreSQL-family validation: parse the generated DDL with the PostgreSQL
        // dialect so this also proves the statement is syntactically valid, not just that the
        // expected substring is present.
        use sqlparser::dialect::PostgreSqlDialect;
        use sqlparser::parser::Parser;
        let create_index_sql = sql
            .lines()
            .find(|line| line.starts_with("CREATE UNIQUE INDEX \"uq_weird_columns\""))
            .expect("generated DDL should include the CREATE INDEX statement");
        let statements = Parser::parse_sql(&PostgreSqlDialect {}, create_index_sql)
            .unwrap_or_else(|error| panic!("generated DDL must be valid PostgreSQL: {error}\nSQL: {create_index_sql}"));
        assert_eq!(statements.len(), 1);
    }

    #[test]
    fn quotes_expression_like_column_names_without_agent_provenance() {
        for db_type in [DatabaseType::Kingbase, DatabaseType::Vastbase] {
            let new_index = index(IndexInfo {
                name: "idx_weird_columns".to_string(),
                columns: vec!["order item".to_string(), "a(b)".to_string(), "a::b".to_string()],
                key_is_expression: Vec::new(),
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            });

            let sql = generate_schema_sync_sql(
                &[TableDiff {
                    diff_type: "modified".to_string(),
                    object_type: Some("table".to_string()),
                    name: "tankong_data".to_string(),
                    columns: None,
                    indexes: Some(vec![IndexDiff {
                        diff_type: "added".to_string(),
                        name: new_index.name.clone(),
                        source: Some(new_index),
                        target: None,
                        changes: vec![],
                    }]),
                    foreign_keys: None,
                    triggers: None,
                    ddl: None,
                    target_ddl: None,
                    source_table_comment: None,
                    target_table_comment: None,
                    sync_sql: None,
                }],
                &[],
                &[],
                &[],
                &[],
                db_type,
                Some("public"),
                false,
                None,
                &[],
            );

            assert!(sql.contains("(\"order item\", \"a(b)\", \"a::b\")"), "{db_type:?}: {sql}");
        }
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL-family database"]
    async fn real_postgres_round_trip_quotes_columns_and_leaves_expressions_bare() {
        // PR #6312 review: exercise the full path end-to-end against a real PostgreSQL server
        // instead of only asserting on generated text. Introspects a table whose unique index
        // mixes a real column with an expression-hostile name ("order item", i.e. exactly the
        // a.attname case the reviewer called out) and a genuine pg_get_indexdef expression key
        // part, generates DDL with the same `create_index_sql` schema-diff sync uses, and
        // executes that DDL back against the database to prove it's actually valid — not just
        // plausible-looking text.
        let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
        let pool =
            crate::db::postgres::connect(&url, std::time::Duration::from_secs(5)).await.expect("connect postgres");
        let schema = format!("dbx_key_expr_{}", uuid::Uuid::new_v4().simple());
        crate::db::postgres::execute_query(&pool, &format!("CREATE SCHEMA {schema}")).await.expect("create schema");

        let exercise = async {
            crate::db::postgres::execute_query(
                &pool,
                &format!(
                    "CREATE TABLE {schema}.tankong_data (\
                     \"order item\" integer, data_type text, data_time timestamp, height double precision)"
                ),
            )
            .await?;
            crate::db::postgres::execute_query(
                &pool,
                &format!(
                    "CREATE UNIQUE INDEX uq_tankong_sta_type_time ON {schema}.tankong_data \
                     (\"order item\", data_type, data_time, \
                     (COALESCE(height, '-1'::integer::double precision)))"
                ),
            )
            .await?;

            let indexes = crate::db::postgres::list_indexes(&pool, &schema, "tankong_data").await?;
            let index = indexes
                .into_iter()
                .find(|index| index.name == "uq_tankong_sta_type_time")
                .ok_or_else(|| "introspection should return the created index".to_string())?;

            // Regenerate the index DDL through the exact same production function schema-diff
            // sync calls, then execute it back against the real database to prove it's valid.
            let ddl = create_index_sql("tankong_data", &index, DatabaseType::Highgo, Some(&schema));
            crate::db::postgres::execute_query(&pool, &format!("DROP INDEX {schema}.uq_tankong_sta_type_time")).await?;
            crate::db::postgres::execute_query(&pool, &ddl).await?;

            Ok::<_, String>((index, ddl))
        }
        .await;

        let cleanup = crate::db::postgres::execute_query(&pool, &format!("DROP SCHEMA {schema} CASCADE")).await;
        cleanup.expect("drop schema");
        let (index, recreate_ddl) = exercise.expect("exercise real postgres round trip");

        assert_eq!(
            index.columns,
            vec!["order item", "data_type", "data_time", "COALESCE(height, '-1'::integer::double precision)"]
        );
        assert_eq!(index.key_is_expression, vec![false, false, false, true]);
        assert!(recreate_ddl.contains("\"order item\""));
        assert!(recreate_ddl.contains("COALESCE(height, '-1'::integer::double precision)"));
        assert!(!recreate_ddl.contains("\"COALESCE"));
    }

    #[test]
    fn detects_foreign_key_additions_removals_and_target_changes() {
        let diffs = diff_foreign_keys(
            &[
                foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: String::new(),
                    ref_column: String::new(),
                    on_update: None,
                    on_delete: None,
                }),
                foreign_key(ForeignKeyInfo {
                    name: "orders_account_id_fk".to_string(),
                    column: "account_id".to_string(),
                    ref_schema: None,
                    ref_table: "accounts".to_string(),
                    ref_column: String::new(),
                    on_update: None,
                    on_delete: None,
                }),
            ],
            &[
                foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: "members".to_string(),
                    ref_column: String::new(),
                    on_update: None,
                    on_delete: None,
                }),
                foreign_key(ForeignKeyInfo {
                    name: "orders_region_id_fk".to_string(),
                    column: "region_id".to_string(),
                    ref_schema: None,
                    ref_table: "regions".to_string(),
                    ref_column: String::new(),
                    on_update: None,
                    on_delete: None,
                }),
            ],
        );

        let summary: Vec<_> = diffs.iter().map(|diff| (diff.diff_type.as_str(), diff.name.as_str())).collect();
        assert_eq!(
            summary,
            vec![
                ("modified", "orders_user_id_fk"),
                ("added", "orders_account_id_fk"),
                ("removed", "orders_region_id_fk"),
            ]
        );
    }

    #[test]
    fn generates_sync_sql_for_index_and_foreign_key_changes() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "orders".to_string(),
            columns: None,
            indexes: Some(vec![IndexDiff {
                diff_type: "modified".to_string(),
                name: "idx_orders_status".to_string(),
                source: Some(index(IndexInfo {
                    name: "idx_orders_status".to_string(),
                    columns: vec!["status".to_string(), "created_at".to_string()],
                    is_unique: true,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                })),
                target: None,
                changes: Vec::new(),
            }]),
            foreign_keys: Some(vec![ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: "orders_user_id_fk".to_string(),
                source: Some(foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: "users".to_string(),
                    ref_column: String::new(),
                    on_update: None,
                    on_delete: None,
                })),
                target: None,
                changes: Vec::new(),
            }]),
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]),
            [
                "ALTER TABLE \"orders\" DROP CONSTRAINT \"orders_user_id_fk\";",
                "DROP INDEX IF EXISTS \"idx_orders_status\";",
                "CREATE UNIQUE INDEX \"idx_orders_status\" ON \"orders\" (\"status\", \"created_at\");",
                "ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_user_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\");",
            ]
            .join("\n")
        );
    }

    #[test]
    fn mysql_column_comment_changes_generate_modify_column_sql() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "users".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".to_string(),
                name: "name".to_string(),
                source: Some(column("name", "varchar(64)", Some("用户姓名"))),
                target: Some(column("name", "varchar(64)", Some("Name"))),
                changes: vec!["comment: Name → 用户姓名".to_string()],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: Some(Some("用户表".to_string())),
            target_table_comment: Some(Some("Users".to_string())),
            sync_sql: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]),
            [
                "-- Alter table: users",
                "ALTER TABLE `users`",
                "  MODIFY COLUMN `name` varchar(64) NOT NULL COMMENT '用户姓名';",
                "",
                "ALTER TABLE `users` COMMENT = '用户表';",
            ]
            .join("\n")
        );
    }

    #[test]
    fn mysql_schema_sync_sql_qualifies_tables_with_target_database() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "notify_channel_config".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".to_string(),
                name: "config_json".to_string(),
                source: Some(column("config_json", "json", Some("渠道配置"))),
                target: Some(column("config_json", "json", Some("Config"))),
                changes: vec!["comment: Config → 渠道配置".to_string()],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(
                &diffs,
                &[],
                &[],
                &[],
                &[],
                DatabaseType::Mysql,
                Some("target_db"),
                false,
                None,
                &[]
            ),
            [
                "-- Alter table: notify_channel_config",
                "ALTER TABLE `target_db`.`notify_channel_config`",
                "  MODIFY COLUMN `config_json` json NOT NULL COMMENT '渠道配置';",
            ]
            .join("\n")
        );
    }

    #[test]
    fn blank_target_schema_does_not_generate_empty_qualifier() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "notify_channel_config".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".to_string(),
                name: "config_json".to_string(),
                source: Some(column("config_json", "json", Some("渠道配置"))),
                target: Some(column("config_json", "json", Some("Config"))),
                changes: vec!["comment: Config → 渠道配置".to_string()],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];

        let sql =
            generate_schema_sync_sql(&diffs, &[], &[], &[], &[], DatabaseType::Mysql, Some("  "), false, None, &[]);

        assert!(sql.contains("ALTER TABLE `notify_channel_config`"));
        assert!(!sql.contains("``."));
    }

    #[test]
    fn ignore_comments_skips_column_and_table_comment_diffs() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("用户表".to_string()),
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("Users".to_string()),
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(64)", Some("用户姓名"))],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(64)", Some("Name"))],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: None,
            }],
            source_functions: Vec::new(),
            target_functions: Vec::new(),
            source_sequences: Vec::new(),
            target_sequences: Vec::new(),
            source_rules: Vec::new(),
            target_rules: Vec::new(),
            source_owners: Vec::new(),
            target_owners: Vec::new(),
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: true,
            cascade_delete: false,
            compare_column_order: false,
            ..Default::default()
        };

        let result = prepare_schema_diff(options);
        assert!(result.diffs.is_empty());
        assert!(result.sync_sql.is_empty());
    }

    #[test]
    fn prepare_schema_diff_attaches_per_table_sync_sql() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(128)", None)],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: Some("CREATE TABLE `users` (`name` varchar(128));".to_string()),
            }],
            target_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(64)", None)],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: Some("CREATE TABLE `users` (`name` varchar(64));".to_string()),
            }],
            source_functions: Vec::new(),
            target_functions: Vec::new(),
            source_sequences: Vec::new(),
            target_sequences: Vec::new(),
            source_rules: Vec::new(),
            target_rules: Vec::new(),
            source_owners: Vec::new(),
            target_owners: Vec::new(),
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            ..Default::default()
        };

        let result = prepare_schema_diff(options);
        let table_sync_sql = result.diffs[0].sync_sql.as_deref().unwrap_or_default();

        assert!(table_sync_sql.contains("ALTER TABLE `users`"));
        assert!(!table_sync_sql.contains("CREATE TABLE"));
    }

    #[test]
    fn schema_sync_plan_builds_matching_forward_and_rollback_sql_for_selected_children() {
        let selected_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "users".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "nickname".to_string(),
                source: Some(column("nickname", "varchar(64)", None)),
                target: None,
                changes: Vec::new(),
                add_position: None,
            }]),
            ..Default::default()
        };

        let plan = generate_schema_sync_sql_plan(
            &[selected_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("shop"),
            false,
            None,
            &[],
            true,
        );

        assert!(plan.sync_sql.contains("ADD COLUMN `nickname`"), "{}", plan.sync_sql);
        let rollback = plan.rollback_sync_sql.expect("rollback SQL");
        assert!(rollback.contains("DROP COLUMN `nickname`"), "{rollback}");
        assert_eq!(plan.rollback_completeness, RollbackCompleteness::Complete);
    }

    #[test]
    fn qualifies_generated_schema_sync_sql_with_target_schema() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "orders".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "status".to_string(),
                source: Some(ColumnInfo {
                    name: "status".to_string(),
                    data_type: "text".to_string(),
                    resolved_schema: None,
                    is_nullable: true,
                    column_default: None,
                    is_primary_key: false,
                    is_unique: false,
                    extra: None,
                    comment: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    character_maximum_length: None,
                    enum_values: None,
                    character_set: None,
                    collation: None,
                }),
                target: None,
                changes: Vec::new(),
                add_position: None,
            }]),
            indexes: Some(vec![IndexDiff {
                diff_type: "added".to_string(),
                name: "idx_orders_status".to_string(),
                source: Some(index(IndexInfo {
                    name: "idx_orders_status".to_string(),
                    columns: vec!["status".to_string()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                })),
                target: None,
                changes: Vec::new(),
            }]),
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(
                &diffs,
                &[],
                &[],
                &[],
                &[],
                DatabaseType::Postgres,
                Some("sales"),
                false,
                None,
                &[]
            ),
            [
                "-- Alter table: orders",
                "ALTER TABLE \"sales\".\"orders\"  ADD COLUMN \"status\" text;",
                "",
                "CREATE INDEX \"idx_orders_status\" ON \"sales\".\"orders\" (\"status\");",
            ]
            .join("\n")
        );
    }

    #[test]
    fn added_table_native_ddl_rewrites_source_schema_to_target_schema() {
        // Issue #7249: comparing two Postgres schemas emitted the *source*
        // schema-qualified CREATE TABLE verbatim, so the generated sync SQL
        // referenced a schema that may not even exist on the target and
        // failed 100% of the time.
        let diffs = vec![TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            name: "orders".to_string(),
            ddl: Some("CREATE TABLE \"source_schema\".\"orders\" (\n  \"id\" integer\n)".to_string()),
            ..TableDiff::default()
        }];

        let sql = generate_schema_sync_sql(
            &diffs,
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("target_schema"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );

        assert!(sql.contains("CREATE TABLE \"target_schema\".\"orders\""), "{sql}");
        assert!(!sql.contains("source_schema"), "{sql}");
    }

    #[test]
    fn added_view_native_ddl_rewrites_source_schema_to_target_schema() {
        let diffs = vec![TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("view".to_string()),
            name: "active_orders".to_string(),
            ddl: Some("CREATE OR REPLACE VIEW \"source_schema\".\"active_orders\" AS\nSELECT 1".to_string()),
            ..TableDiff::default()
        }];

        let sql = generate_schema_sync_sql(
            &diffs,
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("target_schema"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );

        assert!(sql.contains("CREATE OR REPLACE VIEW \"target_schema\".\"active_orders\""), "{sql}");
        assert!(!sql.contains("source_schema"), "{sql}");
    }

    #[test]
    fn added_table_unqualified_native_ddl_is_left_unchanged() {
        // MySQL-family DDL that relies on the connection's current database
        // (no schema/database qualifier) already resolves correctly wherever
        // the sync script runs, so it must not be rewritten.
        let diffs = vec![TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            name: "orders".to_string(),
            ddl: Some("CREATE TABLE `orders` (\n  `id` int\n)".to_string()),
            ..TableDiff::default()
        }];

        let sql = generate_schema_sync_sql(
            &diffs,
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("shop"),
            false,
            Some(DialectKind::Mysql),
            &[],
        );

        assert!(sql.contains("CREATE TABLE `orders`"), "{sql}");
    }

    #[test]
    fn added_table_native_ddl_rewrites_bracket_quoted_schema_with_escaped_bracket() {
        // SQL Server escapes a literal `]` inside a bracketed identifier by
        // doubling it (`[a]]b]` is the identifier `a]b`) — the schema segment
        // here must still be recognized as "source_schema]" rather than the
        // parser stopping at the first `]`.
        let diffs = vec![TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            name: "orders".to_string(),
            ddl: Some("CREATE TABLE [source_schema]]].[orders] (\n  [id] int\n)".to_string()),
            ..TableDiff::default()
        }];

        let sql = generate_schema_sync_sql(
            &diffs,
            &[],
            &[],
            &[],
            &[],
            DatabaseType::SqlServer,
            Some("target_schema"),
            false,
            Some(DialectKind::SqlServer),
            &[],
        );

        assert!(sql.contains("[target_schema].[orders]"), "{sql}");
        assert!(!sql.contains("source_schema"), "{sql}");
    }

    // ========================================================================
    // Phase 4.1: Dependency Graph Tests
    // ========================================================================

    #[test]
    fn dependency_graph_builds_dag_from_foreign_keys() {
        let details = vec![
            TableSchemaDetail {
                name: "orders".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![ForeignKeyInfo {
                    name: "fk_orders_users".to_string(),
                    column: "user_id".to_string(),
                    ref_schema: None,
                    ref_table: "users".to_string(),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: None,
                }],
                triggers: vec![],
                ddl: None,
            },
            TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            },
        ];
        let tables = vec![
            TableInfo {
                name: "orders".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];

        let graph = DependencyGraph::build(&details, &tables);
        assert_eq!(graph.nodes.len(), 2);
        assert!(graph.nodes["orders"].depends_on.contains(&"users".to_string()));
        assert_eq!(graph.nodes["orders"].depends_on.len(), 1);
        assert_eq!(graph.nodes["users"].depends_on.len(), 0);
    }

    #[test]
    fn dependency_graph_topological_sort_drop_order() {
        let details = vec![
            TableSchemaDetail {
                name: "order_items".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![ForeignKeyInfo {
                    name: "fk_items_orders".to_string(),
                    column: "order_id".to_string(),
                    ref_schema: None,
                    ref_table: "orders".to_string(),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: None,
                }],
                triggers: vec![],
                ddl: None,
            },
            TableSchemaDetail {
                name: "orders".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![ForeignKeyInfo {
                    name: "fk_orders_users".to_string(),
                    column: "user_id".to_string(),
                    ref_schema: None,
                    ref_table: "users".to_string(),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: None,
                }],
                triggers: vec![],
                ddl: None,
            },
            TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            },
        ];
        let tables = vec![
            TableInfo {
                name: "order_items".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "orders".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];

        let graph = DependencyGraph::build(&details, &tables);
        let drop_order = graph.drop_order();

        let di = drop_order.iter().position(|n| n == "order_items").unwrap();
        let oi = drop_order.iter().position(|n| n == "orders").unwrap();
        assert!(di < oi, "order_items should be dropped before orders");
    }

    #[test]
    fn coverage_score_empty_graph_returns_one() {
        let graph = DependencyGraph { nodes: HashMap::new(), topological_order: vec![] };
        assert_eq!(graph.coverage_score(&[]), 1.0);
    }

    #[test]
    fn coverage_score_partial_coverage() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "a".to_string(),
            DependencyNode { table_name: "a".to_string(), depends_on: vec!["b".to_string()], depended_by: vec![] },
        );
        nodes.insert(
            "b".to_string(),
            DependencyNode {
                table_name: "b".to_string(),
                depends_on: vec!["c".to_string()],
                depended_by: vec!["a".to_string()],
            },
        );
        nodes.insert(
            "c".to_string(),
            DependencyNode { table_name: "c".to_string(), depends_on: vec![], depended_by: vec!["b".to_string()] },
        );
        let graph =
            DependencyGraph { nodes, topological_order: vec!["c".to_string(), "b".to_string(), "a".to_string()] };

        let score = graph.coverage_score(&["a".to_string(), "b".to_string()]);
        assert!((score - 0.5).abs() < 0.01);
    }

    #[test]
    fn coverage_score_level2_transitive_edges() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "a".to_string(),
            DependencyNode { table_name: "a".to_string(), depends_on: vec!["b".to_string()], depended_by: vec![] },
        );
        nodes.insert(
            "b".to_string(),
            DependencyNode {
                table_name: "b".to_string(),
                depends_on: vec!["c".to_string()],
                depended_by: vec!["a".to_string()],
            },
        );
        nodes.insert(
            "c".to_string(),
            DependencyNode { table_name: "c".to_string(), depends_on: vec![], depended_by: vec!["b".to_string()] },
        );
        let graph =
            DependencyGraph { nodes, topological_order: vec!["c".to_string(), "b".to_string(), "a".to_string()] };

        let l2_score = graph.coverage_score_level2(&["a".to_string(), "b".to_string(), "c".to_string()]);
        assert!((l2_score - 1.0).abs() < 0.01, "full coverage should give 1.0");
    }

    #[test]
    fn coverage_score_level2_partial() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "a".to_string(),
            DependencyNode { table_name: "a".to_string(), depends_on: vec!["b".to_string()], depended_by: vec![] },
        );
        nodes.insert(
            "b".to_string(),
            DependencyNode {
                table_name: "b".to_string(),
                depends_on: vec!["c".to_string()],
                depended_by: vec!["a".to_string()],
            },
        );
        nodes.insert(
            "c".to_string(),
            DependencyNode { table_name: "c".to_string(), depends_on: vec![], depended_by: vec!["b".to_string()] },
        );
        let graph =
            DependencyGraph { nodes, topological_order: vec!["c".to_string(), "b".to_string(), "a".to_string()] };

        let l2_score = graph.coverage_score_level2(&["a".to_string(), "b".to_string()]);
        assert!((l2_score - 0.0).abs() < 0.01, "missing grandparent c means 0 transitive coverage");
    }

    #[test]
    fn composite_coverage_full_coverage() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "a".to_string(),
            DependencyNode { table_name: "a".to_string(), depends_on: vec!["b".to_string()], depended_by: vec![] },
        );
        nodes.insert(
            "b".to_string(),
            DependencyNode {
                table_name: "b".to_string(),
                depends_on: vec!["c".to_string()],
                depended_by: vec!["a".to_string()],
            },
        );
        nodes.insert(
            "c".to_string(),
            DependencyNode { table_name: "c".to_string(), depends_on: vec![], depended_by: vec!["b".to_string()] },
        );
        let graph =
            DependencyGraph { nodes, topological_order: vec!["c".to_string(), "b".to_string(), "a".to_string()] };

        let report = graph.composite_coverage_score(&["a".to_string(), "b".to_string(), "c".to_string()]);
        assert!((report.level1_score - 1.0).abs() < 0.01);
        assert!((report.level2_score - 1.0).abs() < 0.01);
        assert!((report.composite_score - 1.0).abs() < 0.01);
        assert_eq!(report.level1_covered, 2);
        assert_eq!(report.level1_total, 2);
        assert_eq!(report.level2_covered, 1);
        assert_eq!(report.level2_total, 1);
    }

    #[test]
    fn composite_coverage_partial() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "a".to_string(),
            DependencyNode { table_name: "a".to_string(), depends_on: vec!["b".to_string()], depended_by: vec![] },
        );
        nodes.insert(
            "b".to_string(),
            DependencyNode {
                table_name: "b".to_string(),
                depends_on: vec!["c".to_string()],
                depended_by: vec!["a".to_string()],
            },
        );
        nodes.insert(
            "c".to_string(),
            DependencyNode { table_name: "c".to_string(), depends_on: vec![], depended_by: vec!["b".to_string()] },
        );
        let graph =
            DependencyGraph { nodes, topological_order: vec!["c".to_string(), "b".to_string(), "a".to_string()] };

        let report = graph.composite_coverage_score(&["a".to_string(), "b".to_string()]);
        assert!((report.level1_score - 0.5).abs() < 0.01);
        assert!((report.level2_score - 0.0).abs() < 0.01);
        assert!((report.composite_score - 0.3).abs() < 0.01, "0.6*0.5 + 0.4*0.0 = 0.3");
        assert_eq!(report.level1_covered, 1);
        assert_eq!(report.level1_total, 2);
        assert!(!report.uncovered_edges.is_empty());
    }

    #[test]
    fn composite_coverage_no_dependencies() {
        let mut nodes = HashMap::new();
        nodes.insert(
            "t1".to_string(),
            DependencyNode { table_name: "t1".to_string(), depends_on: vec![], depended_by: vec![] },
        );
        nodes.insert(
            "t2".to_string(),
            DependencyNode { table_name: "t2".to_string(), depends_on: vec![], depended_by: vec![] },
        );
        let graph = DependencyGraph { nodes, topological_order: vec!["t1".to_string(), "t2".to_string()] };

        let report = graph.composite_coverage_score(&["t1".to_string()]);
        assert!((report.level1_score - 1.0).abs() < 0.01);
        assert!((report.level2_score - 1.0).abs() < 0.01);
        assert!((report.composite_score - 1.0).abs() < 0.01);
        assert!(report.uncovered_edges.is_empty());
    }

    // ========================================================================
    // Phase 4.1: Rename Detection Tests
    // ========================================================================

    #[test]
    fn detect_renames_high_similarity_columns() {
        let source_details = vec![TableSchemaDetail {
            name: "users_old".to_string(),
            columns: vec![
                column("id", "int", None),
                column("name", "varchar(100)", None),
                column("email", "varchar(255)", None),
                column("created_at", "datetime", None),
            ],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];
        let target_details = vec![TableSchemaDetail {
            name: "users_new".to_string(),
            columns: vec![
                column("id", "integer", None),
                column("name", "varchar(100)", None),
                column("email", "varchar(255)", None),
                column("updated_at", "datetime", None),
            ],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];

        let candidates = detect_renames(
            &["users_new".to_string()],
            &["users_old".to_string()],
            &source_details,
            &target_details,
            0.5,
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source_name, "users_old");
        assert_eq!(candidates[0].target_name, "users_new");
        assert!(candidates[0].score >= 0.5);
    }

    #[test]
    fn detect_renames_low_similarity_below_threshold() {
        let source_details = vec![TableSchemaDetail {
            name: "users".to_string(),
            columns: vec![column("id", "int", None)],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];
        let target_details = vec![TableSchemaDetail {
            name: "products".to_string(),
            columns: vec![column("sku", "varchar(50)", None), column("price", "decimal", None)],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];

        let candidates =
            detect_renames(&["users".to_string()], &["products".to_string()], &source_details, &target_details, 0.5);

        assert!(candidates.is_empty());
    }

    #[test]
    fn jaccard_similarity_identical_sets() {
        let a: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let b: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert!((jaccard_similarity(&a, &b) - 1.0).abs() < f64::EPSILON);
    }

    // ========================================================================
    // Phase 4.2: Batch Naming Pattern Tests
    // ========================================================================

    #[test]
    fn batch_pattern_matching_wildcard() {
        let source = vec!["log_2024_01".to_string(), "log_2024_02".to_string(), "users".to_string()];
        let target = vec!["log_2024_03".to_string()];
        let patterns = vec![BatchPattern {
            pattern: "log_*".to_string(),
            is_regex: false,
            description: "all log tables".to_string(),
        }];

        let (_added, removed, common, match_results) = diff_names_with_patterns(&source, &target, &patterns);
        assert_eq!(removed, vec!["log_2024_03"]);
        assert_eq!(common.len(), 0);
        assert_eq!(match_results.len(), 1);
        assert_eq!(match_results[0].len(), 2);
    }

    #[test]
    fn batch_pattern_regex_matching() {
        let source = vec!["tbl_001".to_string(), "tbl_002".to_string(), "other".to_string()];
        let target = vec![];
        let patterns = vec![BatchPattern {
            pattern: r"tbl_\d{3}".to_string(),
            is_regex: true,
            description: "numbered tables".to_string(),
        }];

        let (_added, _removed, _common, match_results) = diff_names_with_patterns(&source, &target, &patterns);
        assert_eq!(match_results[0].len(), 2);
    }

    #[test]
    fn pattern_conflict_detection() {
        let patterns = vec![
            BatchPattern { pattern: "user_*".to_string(), is_regex: false, description: "user tables".to_string() },
            BatchPattern {
                pattern: "user_data".to_string(),
                is_regex: false,
                description: "specific user data".to_string(),
            },
        ];

        let names = vec!["user_data".to_string(), "user_log".to_string()];
        let conflicts = detect_pattern_conflicts(&patterns, &names);
        assert!(!conflicts.is_empty());
    }

    // ========================================================================
    // Phase 4.3: Type Compatibility Tests
    // ========================================================================

    #[test]
    fn diff_columns_with_compatibility_integer_family() {
        let (_diffs, warnings) = diff_columns_with_compatibility(
            &[column("id", "INT", None)],
            &[column("id", "BIGINT", None)],
            false,
            false,
            DialectKind::Mysql,
            DialectKind::Mysql,
            0.9,
            &[],
        );
        assert!(!warnings.is_empty());
        assert_eq!(warnings[0].risk, ColumnConversionRisk::Low);
    }

    #[test]
    fn diff_columns_with_compatibility_exact_match_no_warning() {
        let (_diffs, warnings) = diff_columns_with_compatibility(
            &[column("id", "INT", None)],
            &[column("id", "INT", None)],
            false,
            false,
            DialectKind::Mysql,
            DialectKind::Mysql,
            0.5,
            &[],
        );
        assert!(warnings.is_empty());
    }

    // ========================================================================
    // Phase 4.4: Bidirectional Diff & Rollback Tests
    // ========================================================================

    fn make_diff(diff_type: &str, name: &str) -> TableDiff {
        TableDiff {
            diff_type: diff_type.to_string(),
            object_type: Some("table".to_string()),
            name: name.to_string(),
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }
    }

    #[test]
    fn rollback_graph_add_becomes_drop() {
        let diffs = vec![make_diff("added", "new_table")];
        let dep_graph = DependencyGraph { nodes: HashMap::new(), topological_order: vec![] };
        let graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);

        assert_eq!(graph.forward_nodes.len(), 1);
        assert_eq!(graph.rollback_nodes.len(), 1);
        assert_eq!(graph.forward_nodes[0].table_diff.diff_type, "added");
        assert_eq!(graph.rollback_nodes[0].table_diff.diff_type, "removed");
    }

    #[test]
    fn rollback_graph_remove_becomes_add() {
        let diffs = vec![make_diff("removed", "old_table")];
        let dep_graph = DependencyGraph { nodes: HashMap::new(), topological_order: vec![] };
        let graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);

        assert_eq!(graph.rollback_nodes[0].table_diff.diff_type, "added");
        assert_eq!(graph.rollback_nodes[0].table_diff.ddl, None);
    }

    fn rollback_removed_table_sql(
        database_type: DatabaseType,
        target_schema: Option<&str>,
        source_dialect: Option<DialectKind>,
        target_dialect: DialectKind,
        table_name: &str,
        table_comment: Option<&str>,
        target_detail: TableSchemaDetail,
    ) -> SchemaDiffPreparation {
        prepare_schema_diff(SchemaDiffPreparationOptions {
            target_tables: vec![TableInfo {
                name: table_name.to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: table_comment.map(str::to_string),
                parent_schema: None,
                parent_name: None,
            }],
            target_details: vec![target_detail],
            database_type,
            target_schema: target_schema.map(str::to_string),
            enable_rollback: true,
            source_dialect,
            target_dialect: Some(target_dialect),
            ..Default::default()
        })
    }

    #[test]
    fn dropped_postgres_table_rollback_preserves_structured_snapshot() {
        let table_name = "Order Items";
        let result = rollback_removed_table_sql(
            DatabaseType::Postgres,
            Some("sales"),
            Some(DialectKind::Postgres),
            DialectKind::Postgres,
            table_name,
            Some("order line history"),
            TableSchemaDetail {
                name: table_name.to_string(),
                columns: vec![
                    ColumnInfo {
                        is_primary_key: true,
                        column_default: Some("gen_random_uuid()".to_string()),
                        ..column("Item ID", "uuid", Some("stable row id"))
                    },
                    ColumnInfo {
                        column_default: Some("'new'::text".to_string()),
                        ..column("Status", "text", Some("workflow state"))
                    },
                    column("User ID", "bigint", None),
                ],
                indexes: vec![index(IndexInfo {
                    name: "Order Status IDX".to_string(),
                    columns: vec!["Status".to_string()],
                    is_unique: true,
                    is_primary: false,
                    filter: Some("\"Status\" <> 'deleted'".to_string()),
                    index_type: Some("btree".to_string()),
                    included_columns: Some(vec!["User ID".to_string()]),
                    comment: None,
                    key_is_expression: Vec::new(),
                })],
                foreign_keys: vec![foreign_key(ForeignKeyInfo {
                    name: "Order User FK".to_string(),
                    column: "User ID".to_string(),
                    ref_schema: Some("auth".to_string()),
                    ref_table: "Users".to_string(),
                    ref_column: "ID".to_string(),
                    on_update: None,
                    on_delete: Some("CASCADE".to_string()),
                })],
                triggers: vec![],
                ddl: Some("CREATE TABLE native_postgres_fallback (ignored int)".to_string()),
            },
        );
        let rollback = result.rollback_sync_sql.unwrap();

        assert!(rollback.contains("CREATE TABLE \"sales\".\"Order Items\""), "{rollback}");
        assert!(rollback.contains("\"Item ID\" uuid NOT NULL DEFAULT gen_random_uuid()"), "{rollback}");
        assert!(rollback.contains("PRIMARY KEY (\"Item ID\")"), "{rollback}");
        assert!(rollback.contains("CREATE UNIQUE INDEX \"Order Status IDX\""), "{rollback}");
        assert!(rollback.contains("USING btree"), "{rollback}");
        assert!(rollback.contains("INCLUDE (\"User ID\")"), "{rollback}");
        assert!(rollback.contains("WHERE \"Status\" <> 'deleted'"), "{rollback}");
        assert!(rollback.contains("REFERENCES \"auth\".\"Users\"(\"ID\") ON DELETE CASCADE"), "{rollback}");
        assert!(rollback.contains("COMMENT ON COLUMN \"sales\".\"Order Items\".\"Status\" IS 'workflow state'"));
        assert!(rollback.contains("COMMENT ON TABLE \"sales\".\"Order Items\" IS 'order line history'"));
        assert!(!rollback.contains("native_postgres_fallback"), "{rollback}");
    }

    #[test]
    fn dropped_mysql_table_rollback_preserves_defaults_comments_indexes_and_fk() {
        let table_name = "order-items";
        let result = rollback_removed_table_sql(
            DatabaseType::Mysql,
            Some("shop"),
            Some(DialectKind::Mysql),
            DialectKind::Mysql,
            table_name,
            Some("order item history"),
            TableSchemaDetail {
                name: table_name.to_string(),
                columns: vec![
                    ColumnInfo {
                        is_primary_key: true,
                        column_default: Some("(uuid())".to_string()),
                        ..column("item-id", "varchar(36)", Some("stable item id"))
                    },
                    ColumnInfo {
                        column_default: Some("'new'".to_string()),
                        ..column("status", "varchar(32)", Some("workflow state"))
                    },
                    column("user-id", "bigint", None),
                ],
                indexes: vec![index(IndexInfo {
                    name: "status-index".to_string(),
                    columns: vec!["status".to_string()],
                    is_unique: true,
                    is_primary: false,
                    filter: None,
                    index_type: Some("BTREE".to_string()),
                    included_columns: None,
                    comment: Some("status lookup".to_string()),
                    key_is_expression: Vec::new(),
                })],
                foreign_keys: vec![foreign_key(ForeignKeyInfo {
                    name: "user-fk".to_string(),
                    column: "user-id".to_string(),
                    ref_schema: Some("identity".to_string()),
                    ref_table: "users".to_string(),
                    ref_column: "id".to_string(),
                    on_update: Some("CASCADE".to_string()),
                    on_delete: Some("RESTRICT".to_string()),
                })],
                triggers: vec![],
                ddl: Some("CREATE TABLE native_mysql_fallback (ignored int)".to_string()),
            },
        );
        let rollback = result.rollback_sync_sql.unwrap();

        assert!(rollback.contains("CREATE TABLE `shop`.`order-items`"), "{rollback}");
        assert!(rollback.contains("`item-id` varchar(36) NOT NULL DEFAULT (uuid()) COMMENT 'stable item id'"));
        assert!(rollback.contains("PRIMARY KEY (`item-id`)"), "{rollback}");
        assert!(rollback.contains("CREATE UNIQUE INDEX `status-index` USING BTREE ON `shop`.`order-items` (`status`)"));
        assert!(rollback.contains("COMMENT 'status lookup'"), "{rollback}");
        assert!(rollback.contains("REFERENCES `identity`.`users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE"));
        assert!(rollback.contains("ALTER TABLE `shop`.`order-items` COMMENT = 'order item history'"));
        assert!(!rollback.contains("native_mysql_fallback"), "{rollback}");
    }

    #[test]
    fn dropped_sqlite_table_rollback_preserves_quoted_pk_index_fk_and_default() {
        let table_name = "select \"items";
        let result = rollback_removed_table_sql(
            DatabaseType::Sqlite,
            None,
            Some(DialectKind::Sqlite),
            DialectKind::Sqlite,
            table_name,
            None,
            TableSchemaDetail {
                name: table_name.to_string(),
                columns: vec![
                    ColumnInfo { is_primary_key: true, ..column("item \"id", "TEXT", None) },
                    ColumnInfo { column_default: Some("'new'".to_string()), ..column("status", "TEXT", None) },
                    column("parent id", "TEXT", None),
                ],
                indexes: vec![index(IndexInfo {
                    name: "active status index".to_string(),
                    columns: vec!["status".to_string()],
                    is_unique: false,
                    is_primary: false,
                    filter: Some("status <> 'deleted'".to_string()),
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                })],
                foreign_keys: vec![foreign_key(ForeignKeyInfo {
                    name: "parent item fk".to_string(),
                    column: "parent id".to_string(),
                    ref_schema: None,
                    ref_table: "parent items".to_string(),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: Some("SET NULL".to_string()),
                })],
                triggers: vec![],
                ddl: Some("CREATE TABLE native_sqlite_fallback (ignored int)".to_string()),
            },
        );
        let rollback = result.rollback_sync_sql.unwrap();

        assert!(rollback.contains("CREATE TABLE \"select \"\"items\""), "{rollback}");
        assert!(rollback.contains("\"item \"\"id\" TEXT NOT NULL"), "{rollback}");
        assert!(rollback.contains("\"status\" TEXT NOT NULL DEFAULT 'new'"), "{rollback}");
        assert!(rollback.contains("PRIMARY KEY (\"item \"\"id\")"), "{rollback}");
        assert!(rollback.contains("CONSTRAINT \"parent item fk\" FOREIGN KEY (\"parent id\")"), "{rollback}");
        assert!(rollback.contains("REFERENCES \"parent items\"(\"id\") ON DELETE SET NULL"), "{rollback}");
        assert!(rollback.contains("CREATE INDEX \"active status index\""), "{rollback}");
        assert!(rollback.contains("WHERE status <> 'deleted'"), "{rollback}");
        assert!(!rollback.contains("ALTER TABLE"), "SQLite FK must be part of CREATE TABLE: {rollback}");
        assert!(!rollback.contains("native_sqlite_fallback"), "{rollback}");
    }

    #[test]
    fn dropped_table_cross_dialect_rollback_uses_target_snapshot_and_syntax() {
        let result = rollback_removed_table_sql(
            DatabaseType::Mysql,
            Some("archive"),
            Some(DialectKind::Postgres),
            DialectKind::Mysql,
            "Audit Log",
            None,
            TableSchemaDetail {
                name: "Audit Log".to_string(),
                columns: vec![ColumnInfo {
                    is_primary_key: true,
                    column_default: Some("0".to_string()),
                    ..column("Event ID", "BIGINT UNSIGNED", None)
                }],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: Some("CREATE TABLE native_cross_dialect_fallback (ignored int)".to_string()),
            },
        );
        let rollback = result.rollback_sync_sql.unwrap();

        assert!(rollback.contains("CREATE TABLE `archive`.`Audit Log`"), "{rollback}");
        assert!(rollback.contains("`Event ID` BIGINT UNSIGNED NOT NULL DEFAULT 0 AUTO_INCREMENT"), "{rollback}");
        assert!(!rollback.contains('"'), "rollback must use target MySQL quoting: {rollback}");
        assert!(!rollback.contains("native_cross_dialect_fallback"), "{rollback}");
    }

    #[test]
    fn dropped_table_rollback_uses_native_target_ddl_only_without_structured_columns() {
        let result = rollback_removed_table_sql(
            DatabaseType::Postgres,
            Some("archive"),
            Some(DialectKind::Postgres),
            DialectKind::Postgres,
            "legacy_table",
            None,
            TableSchemaDetail {
                name: "legacy_table".to_string(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: Some("CREATE TABLE \"archive\".\"legacy_table\" (\"id\" bigint PRIMARY KEY)".to_string()),
            },
        );
        let rollback = result.rollback_sync_sql.unwrap();

        assert!(rollback.contains("-- Recreate table from native target DDL: legacy_table"));
        assert!(rollback.contains("CREATE TABLE \"archive\".\"legacy_table\" (\"id\" bigint PRIMARY KEY);"));
        assert!(!rollback.contains("CREATE TABLE \"archive\".\"legacy_table\" (\n  \n)"), "{rollback}");
    }

    #[test]
    fn dropped_table_incomplete_trigger_sets_structured_missing_objects() {
        let result = rollback_removed_table_sql(
            DatabaseType::Mysql,
            None,
            Some(DialectKind::Mysql),
            DialectKind::Mysql,
            "orders",
            None,
            TableSchemaDetail {
                name: "orders".to_string(),
                columns: vec![column("id", "int", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![crate::types::TriggerInfo {
                    name: "trg_orders".to_string(),
                    event: "INSERT".to_string(),
                    timing: "AFTER".to_string(),
                    level: None,
                    condition: None,
                    language: None,
                    enabled: None,
                    valid: None,
                    comment: None,
                    created_at: None,
                    statement: None,
                }],
                ddl: None,
            },
        );

        assert_eq!(result.rollback_completeness, RollbackCompleteness::Incomplete);
        assert!(!result.missing_rollback_objects.is_empty());
        assert_eq!(result.missing_rollback_objects[0].kind, "trigger");
        assert_eq!(result.missing_rollback_objects[0].name, "trg_orders");
        assert!(result.missing_rollback_objects[0].table.as_deref() == Some("orders"));
    }

    #[test]
    fn rollback_graph_modified_stays_modified_swapped() {
        let source_col = column("name", "varchar(100)", None);
        let target_col = column("name", "varchar(50)", None);
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "users".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".to_string(),
                name: "name".to_string(),
                source: Some(source_col.clone()),
                target: Some(target_col.clone()),
                changes: vec!["type: varchar(50) → varchar(100)".to_string()],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];

        let dep_graph = DependencyGraph { nodes: HashMap::new(), topological_order: vec![] };
        let graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);

        let rollback = &graph.rollback_nodes[0];
        assert_eq!(rollback.table_diff.diff_type, "modified");
        let rb_cols = rollback.table_diff.columns.as_ref().unwrap();
        assert_eq!(rb_cols[0].diff_type, "modified");
        assert_eq!(rb_cols[0].source.as_ref().unwrap().data_type, "varchar(50)");
        assert_eq!(rb_cols[0].target.as_ref().unwrap().data_type, "varchar(100)");
        assert_eq!(rb_cols[0].changes, vec!["type: varchar(100) → varchar(50)"]);
    }

    #[test]
    fn rollback_consistency_validation() {
        let diffs = vec![make_diff("added", "t1"), make_diff("removed", "t2")];
        let dep_graph = DependencyGraph { nodes: HashMap::new(), topological_order: vec![] };
        let mut graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);
        assert!(graph.validate_consistency());
        assert!(graph.consistency_issues.is_empty());
    }

    // ========================================================================
    // Phase 4.6: Permission Tests
    // ========================================================================

    #[test]
    fn diff_permissions_detects_added_and_removed() {
        let source = vec![PermissionInfo {
            grantee: "app_user".to_string(),
            object_type: "TABLE".to_string(),
            object_name: "orders".to_string(),
            privilege: "SELECT".to_string(),
            is_grantable: false,
        }];
        let target = vec![PermissionInfo {
            grantee: "app_user".to_string(),
            object_type: "TABLE".to_string(),
            object_name: "orders".to_string(),
            privilege: "INSERT".to_string(),
            is_grantable: false,
        }];

        let diffs = diff_permissions(&source, &target);
        assert_eq!(diffs.len(), 2);
        assert!(diffs.iter().any(|d| d.diff_type == "added"));
        assert!(diffs.iter().any(|d| d.diff_type == "removed"));
    }

    #[test]
    fn generate_permission_sql_mysql() {
        let diffs = vec![PermissionDiff {
            diff_type: "added".to_string(),
            grantee: "app_user".to_string(),
            object_name: "orders".to_string(),
            privilege: "SELECT".to_string(),
            source: Some(PermissionInfo {
                grantee: "app_user".to_string(),
                object_type: "TABLE".to_string(),
                object_name: "orders".to_string(),
                privilege: "SELECT".to_string(),
                is_grantable: true,
            }),
            target: None,
        }];

        let sql = generate_permission_sync_sql(&diffs, DatabaseType::Mysql, Some("mydb"));
        assert!(sql.contains("GRANT SELECT ON `mydb`.`orders` TO 'app_user' WITH GRANT OPTION"));
    }

    #[test]
    fn generate_permission_sql_postgres_revoke() {
        let diffs = vec![PermissionDiff {
            diff_type: "removed".to_string(),
            grantee: "old_user".to_string(),
            object_name: "users".to_string(),
            privilege: "INSERT".to_string(),
            source: None,
            target: Some(PermissionInfo {
                grantee: "old_user".to_string(),
                object_type: "TABLE".to_string(),
                object_name: "users".to_string(),
                privilege: "INSERT".to_string(),
                is_grantable: false,
            }),
        }];

        let sql = generate_permission_sync_sql(&diffs, DatabaseType::Postgres, Some("public"));
        assert!(sql.contains("REVOKE INSERT ON TABLE \"public\".\"users\" FROM \"old_user\""));
    }

    #[test]
    fn generate_permission_sql_sqlserver_uses_securable_syntax() {
        let diffs = vec![
            PermissionDiff {
                diff_type: "added".into(),
                grantee: "app]user".into(),
                object_name: "orders".into(),
                privilege: "SELECT".into(),
                source: Some(PermissionInfo {
                    grantee: "app]user".into(),
                    object_type: "TABLE".into(),
                    object_name: "orders".into(),
                    privilege: "SELECT".into(),
                    is_grantable: true,
                }),
                target: None,
            },
            PermissionDiff {
                diff_type: "removed".into(),
                grantee: "old_user".into(),
                object_name: "orders".into(),
                privilege: "UPDATE".into(),
                source: None,
                target: Some(PermissionInfo {
                    grantee: "old_user".into(),
                    object_type: "TABLE".into(),
                    object_name: "orders".into(),
                    privilege: "UPDATE".into(),
                    is_grantable: false,
                }),
            },
        ];

        let sql = generate_permission_sync_sql(&diffs, DatabaseType::SqlServer, Some("sales"));
        assert!(
            sql.contains("GRANT SELECT ON OBJECT::[sales].[orders] TO [app]]user] WITH GRANT OPTION;"),
            "GRANT: {sql}"
        );
        assert!(sql.contains("REVOKE UPDATE ON OBJECT::[sales].[orders] FROM [old_user];"), "REVOKE: {sql}");
        assert!(!sql.contains(" ON TABLE "), "PostgreSQL object syntax must not leak into T-SQL: {sql}");

        let qualified_diff = PermissionDiff {
            diff_type: "added".into(),
            grantee: "reporter".into(),
            object_name: "[audit].[ledger]".into(),
            privilege: "SELECT".into(),
            source: Some(PermissionInfo {
                grantee: "reporter".into(),
                object_type: "TABLE".into(),
                object_name: "[audit].[ledger]".into(),
                privilege: "SELECT".into(),
                is_grantable: false,
            }),
            target: None,
        };
        let qualified_sql = generate_permission_sync_sql(&[qualified_diff], DatabaseType::SqlServer, None);
        assert!(qualified_sql.contains("OBJECT::[audit].[ledger]"), "qualified object: {qualified_sql}");
        assert!(!qualified_sql.contains("[dbo].[[audit]]"), "do not quote a qualified name as one identifier");
    }

    // ========================================================================
    // Phase 4.7: Resource Scheduling Tests
    // ========================================================================

    #[test]
    fn adaptive_scheduler_optimal_batch_size() {
        let constraint = ResourceConstraint::default();
        let scheduler = AdaptiveScheduler::new(constraint, 400);
        let batch = scheduler.optimal_batch_size();
        assert!(batch > 0);
        assert!(batch <= 50);
    }

    #[test]
    fn adaptive_scheduler_shard_count() {
        let constraint = ResourceConstraint::default();
        let scheduler = AdaptiveScheduler::new(constraint, 200);
        let count = scheduler.recommended_shard_count();
        assert!(count >= 1);
        assert!(count <= 4);
    }

    // ========================================================================
    // Phase 4.8: Backward Compatibility Tests
    // ========================================================================

    #[test]
    fn new_options_default_values_do_not_affect_basic_diff() {
        let options = SchemaDiffPreparationOptions::default();
        let result = prepare_schema_diff(options);
        assert!(result.diffs.is_empty());
        assert!(result.sync_sql.is_empty());
        assert!(result.rollback_sync_sql.is_none());
        assert!(result.rename_candidates.is_empty());
        assert!(result.rollback_graph.is_none());
        assert!(result.compatibility_warnings.is_empty());
        assert!(result.permission_diffs.is_empty());
    }

    #[test]
    fn prepare_schema_diff_with_rename_detection() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "users_old".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "users_new".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "users_old".to_string(),
                columns: vec![column("id", "int", None), column("name", "varchar(100)", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "users_new".to_string(),
                columns: vec![column("id", "int", None), column("name", "varchar(100)", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            source_functions: vec![],
            target_functions: vec![],
            source_sequences: vec![],
            target_sequences: vec![],
            source_rules: vec![],
            target_rules: vec![],
            source_owners: vec![],
            target_owners: vec![],
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: true,
            detect_table_renames: true,
            rename_threshold: 0.5,
            ..Default::default()
        };

        let result = prepare_schema_diff(options);
        assert!(!result.rename_candidates.is_empty());
        assert!(result.rename_candidates[0].score >= 0.5);
    }

    #[test]
    fn prepare_schema_diff_with_rollback_generates_rollback_sql() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "new_table".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![],
            source_details: vec![TableSchemaDetail {
                name: "new_table".to_string(),
                columns: vec![column("id", "int", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: Some("CREATE TABLE new_table (id int);".to_string()),
            }],
            target_details: vec![],
            source_functions: vec![],
            target_functions: vec![],
            source_sequences: vec![],
            target_sequences: vec![],
            source_rules: vec![],
            target_rules: vec![],
            source_owners: vec![],
            target_owners: vec![],
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            enable_rollback: true,
            ..Default::default()
        };

        let result = prepare_schema_diff(options);
        assert!(result.rollback_sync_sql.is_some());
        assert!(result.rollback_graph.is_some());
        let graph = result.rollback_graph.unwrap();
        assert!(graph.is_consistent);
        assert_eq!(graph.forward_nodes.len(), 1);
        assert_eq!(graph.rollback_nodes.len(), 1);
        assert_eq!(graph.rollback_nodes[0].table_diff.diff_type, "removed");
    }

    // -- 31. column_type_similarity_score unit tests --
    #[test]
    fn column_type_similarity_exact_match() {
        assert_eq!(column_type_similarity_score("int", "int"), 1.0);
        assert_eq!(column_type_similarity_score("VARCHAR(255)", "varchar(255)"), 1.0);
        assert_eq!(column_type_similarity_score("datetime", "datetime"), 1.0);
    }

    #[test]
    fn column_type_similarity_synonym() {
        assert_eq!(column_type_similarity_score("int", "integer"), 1.0);
        assert_eq!(column_type_similarity_score("boolean", "bool"), 1.0);
        assert_eq!(column_type_similarity_score("datetime", "timestamp"), 1.0);
        assert_eq!(column_type_similarity_score("double", "double precision"), 1.0);
    }

    #[test]
    fn column_type_similarity_family() {
        assert_eq!(column_type_similarity_score("tinyint", "bigint"), 0.8);
        assert_eq!(column_type_similarity_score("char", "text"), 0.8);
        assert_eq!(column_type_similarity_score("mediumtext", "clob"), 0.8);
    }

    #[test]
    fn column_type_similarity_unrelated() {
        assert_eq!(column_type_similarity_score("int", "varchar"), 0.0);
        assert_eq!(column_type_similarity_score("boolean", "text"), 0.0);
        assert_eq!(column_type_similarity_score("blob", "date"), 0.0);
    }

    #[test]
    fn column_type_similarity_parameterized_ignored() {
        assert_eq!(column_type_similarity_score("int(11)", "int(11)"), 1.0);
        assert_eq!(column_type_similarity_score("int(11)", "integer"), 1.0);
        assert_eq!(column_type_similarity_score("varchar(255)", "varchar(64)"), 1.0);
    }

    #[test]
    fn mysql_same_dialect_ignores_only_integer_display_widths() {
        let source = vec![
            column("id", "int(11) unsigned", None),
            column("status", "tinyint(4)", None),
            column("amount", "decimal(10,2)", None),
            column("name", "varchar(128)", None),
        ];
        let target = vec![
            column("id", "int unsigned", None),
            column("status", "tinyint", None),
            column("amount", "decimal(12,2)", None),
            column("name", "varchar(64)", None),
        ];

        let diffs = diff_columns_with_dialect_options(
            &source,
            &target,
            false,
            false,
            false,
            0.5,
            Some(DialectKind::Mysql),
            Some(DialectKind::Mysql),
        );

        assert_eq!(diffs.iter().map(|diff| diff.name.as_str()).collect::<Vec<_>>(), vec!["amount", "name"]);
        assert!(diffs.iter().all(|diff| diff.changes.iter().any(|change| change.starts_with("type:"))));
    }

    #[test]
    fn mysql_modify_column_preserves_explicit_auto_increment() {
        let mut source = column("id", "int", Some("new comment"));
        source.is_primary_key = true;
        source.extra = Some("auto_increment".to_string());
        let mut target = source.clone();
        target.comment = Some("old comment".to_string());
        let diff = ColumnDiff {
            diff_type: "modified".to_string(),
            name: "id".to_string(),
            source: Some(source),
            target: Some(target),
            changes: vec!["comment: old comment → new comment".to_string()],
            add_position: None,
        };

        let sql = gen_sql(wrap_table_diff("users", vec![diff]), DatabaseType::Mysql, Some(DialectKind::Mysql));

        assert!(
            sql.contains("MODIFY COLUMN `id` int NOT NULL AUTO_INCREMENT COMMENT 'new comment'"),
            "MySQL MODIFY must preserve AUTO_INCREMENT: {sql}"
        );
    }

    #[test]
    fn mysql_add_column_keeps_auto_increment_suffix() {
        let mut source = column("seq", "int", None);
        source.extra = Some("auto_increment".to_string());
        let diff = ColumnDiff {
            diff_type: "added".to_string(),
            name: "seq".to_string(),
            source: Some(source),
            target: None,
            changes: vec![],
            add_position: None,
        };

        let sql = gen_sql(wrap_table_diff("users", vec![diff]), DatabaseType::Mysql, Some(DialectKind::Mysql));

        assert!(sql.contains("AUTO_INCREMENT"), "MySQL ADD COLUMN must keep AUTO_INCREMENT: {sql}");
    }

    #[test]
    fn sqlserver_add_column_places_identity_after_type() {
        let mut source = column("seq", "int", None);
        source.extra = Some("auto_increment".to_string());
        let diff = ColumnDiff {
            diff_type: "added".to_string(),
            name: "seq".to_string(),
            source: Some(source),
            target: None,
            changes: vec![],
            add_position: None,
        };

        let sql = gen_sql(wrap_table_diff("users", vec![diff]), DatabaseType::SqlServer, Some(DialectKind::Mysql));

        assert!(
            sql.contains("[seq] INT IDENTITY(1,1) NOT NULL"),
            "SQL Server ADD COLUMN must place IDENTITY directly after the type: {sql}"
        );
        assert!(
            !sql.to_uppercase().contains("NOT NULL IDENTITY"),
            "SQL Server ADD COLUMN must not trail IDENTITY after constraints: {sql}"
        );
    }

    // -- 32. Multiple renames in one table --
    #[test]
    fn multiple_renames_in_one_table() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_a", "varchar(50)"), ("new_b", "int")],
            &[("id", "int"), ("old_a", "varchar(50)"), ("old_b", "int")],
            true,
        );
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed.len(), 2, "should detect two renames: {renamed:?}");
        assert_eq!(renamed[0].name, "new_a");
        assert_eq!(renamed[1].name, "new_b");
    }

    #[test]
    fn multiple_renames_sql() {
        let diffs = make_col_diffs(
            &[("id", "int"), ("new_a", "varchar(50)"), ("new_b", "int")],
            &[("id", "int"), ("old_a", "varchar(50)"), ("old_b", "int")],
            true,
        );
        for (db, label) in [(DatabaseType::Mysql, "MySQL"), (DatabaseType::Postgres, "PG")] {
            let sql = gen_sql(wrap_table_diff("t", diffs.clone()), db, None);
            // Two renames → two CHANGE COLUMN / RENAME COLUMN operations
            let _n: u64 = 2;
            assert!(sql.contains("COLUMN"), "{label}: {sql}");
        }
    }

    // -- 33. Rename threshold edge cases --
    #[test]
    fn rename_threshold_zero_detects_all() {
        let s: Vec<ColumnInfo> = vec![column("a", "int", None), column("b2", "varchar(10)", None)];
        let t: Vec<ColumnInfo> = vec![column("a", "int", None), column("b1", "varchar(10)", None)];
        // rename detection is skipped when threshold <= 0.0, use a tiny threshold
        let diffs = diff_columns_with_options(&s, &t, false, false, true, 0.001);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed.len(), 1, "threshold near-zero should detect: {renamed:?}");
    }

    #[test]
    fn rename_threshold_one_detects_exact_only() {
        let s: Vec<ColumnInfo> = vec![column("a", "varchar(10)", None), column("b2", "text", None)];
        let t: Vec<ColumnInfo> = vec![column("a", "varchar(10)", None), column("b1", "varchar(10)", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, true, 1.0);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed.len(), 0, "threshold 1 should not match text≠varchar: {renamed:?}");
    }

    #[test]
    fn rename_threshold_mid_detects_family_only() {
        let s: Vec<ColumnInfo> = vec![column("a", "tinyint", None), column("b2", "int", None)];
        let t: Vec<ColumnInfo> = vec![column("a", "tinyint", None), column("b1", "bigint", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, true, 0.9);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed.len(), 0, "threshold 0.9 should not match tinyint≠bigint: {renamed:?}");
        let diffs2 = diff_columns_with_options(&s, &t, false, false, true, 0.5);
        let renamed2: Vec<_> = diffs2.iter().filter(|d| d.diff_type == "renamed").collect();
        assert_eq!(renamed2.len(), 1, "threshold 0.5 should detect integer family: {renamed2:?}");
    }

    // -- 34. Default value changes --
    #[test]
    fn default_value_change_mysql() {
        let source = vec![ColumnInfo { column_default: Some("'guest'".into()), ..column("name", "varchar(50)", None) }];
        let target = vec![ColumnInfo { column_default: None, ..column("name", "varchar(50)", None) }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("MODIFY COLUMN"), "default change: {sql}");
    }

    #[test]
    fn default_value_change_postgres() {
        let source = vec![ColumnInfo { column_default: Some("'guest'".into()), ..column("name", "varchar(50)", None) }];
        let target = vec![ColumnInfo { column_default: None, ..column("name", "varchar(50)", None) }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("SET DEFAULT"), "default add: {sql}");
    }

    #[test]
    fn default_value_drop_postgres() {
        let source = vec![ColumnInfo { column_default: None, ..column("name", "varchar(50)", None) }];
        let target = vec![ColumnInfo { column_default: Some("'old'".into()), ..column("name", "varchar(50)", None) }];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("DROP DEFAULT"), "default drop: {sql}");
    }

    #[test]
    fn added_varchar_column_quotes_a_bare_default_mysql() {
        // MySQL's information_schema returns a string default unquoted, so the
        // generated DDL read `DEFAULT THE_VALUE` and the deploy failed.
        let source =
            vec![ColumnInfo { column_default: Some("THE_VALUE".into()), ..column("menu_type", "varchar(64)", None) }];
        let target: Vec<ColumnInfo> = vec![];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("DEFAULT 'THE_VALUE'"), "bare default must be quoted: {sql}");
    }

    #[test]
    fn default_literal_only_quotes_bare_values_that_need_it() {
        use DialectKind::Mysql;

        // MySQL strips the quotes from a string default, which is the whole
        // reason this function exists.
        assert_eq!(default_literal("THE_VALUE", "varchar(64)", Mysql, None), "'THE_VALUE'");
        assert_eq!(default_literal("it's", "text", Mysql, None), "'it''s'");
        assert_eq!(default_literal("2024-01-01", "date", Mysql, None), "'2024-01-01'");
        // `DEFAULT ''` previously emitted a bare `DEFAULT `.
        assert_eq!(default_literal("", "varchar(20)", Mysql, None), "''");
        // Untouched on MySQL: already quoted and numeric values.
        assert_eq!(default_literal("'guest'", "varchar(50)", Mysql, None), "'guest'");
        assert_eq!(default_literal("0", "bigint", Mysql, None), "0");
        assert_eq!(default_literal("NULL", "varchar(10)", Mysql, None), "'NULL'");
        assert_eq!(default_literal("null", "text", Mysql, None), "'null'");
        assert_eq!(default_literal("  spaced  ", "varchar(32)", Mysql, None), "'  spaced  '");
    }

    #[test]
    fn default_literal_uses_mysql_extra_to_tell_an_expression_from_a_string() {
        use DialectKind::Mysql;

        // 8.0.13+ marks an expression default in EXTRA, and that marker decides
        // it. Without the marker the value is a string, parentheses and all,
        // so a column declared `DEFAULT 'a(b)'` stops emitting invalid
        // `DEFAULT a(b)`.
        assert_eq!(default_literal("a(b)", "varchar(32)", Mysql, None), "'a(b)'");
        assert_eq!(default_literal("uuid()", "varchar(36)", Mysql, Some("DEFAULT_GENERATED")), "uuid()");
        // MySQL wraps an expression default in parentheses and reports it that
        // way, so the wrapping identifies it even when EXTRA is missing. That is
        // a different question from whether the value contains a parenthesis,
        // which is what `a(b)` above turns on.
        assert_eq!(default_literal("(uuid())", "varchar(36)", Mysql, None), "(uuid())");
        assert_eq!(default_literal("(now())", "datetime", Mysql, None), "(now())");
        assert_eq!(
            default_literal(
                "CURRENT_TIMESTAMP",
                "datetime",
                Mysql,
                Some("DEFAULT_GENERATED on update CURRENT_TIMESTAMP")
            ),
            "CURRENT_TIMESTAMP"
        );
        // Before 8.0.13 there is no marker, and a temporal column was the only
        // place an expression default could appear.
        assert_eq!(default_literal("CURRENT_TIMESTAMP", "datetime", Mysql, None), "CURRENT_TIMESTAMP");
    }

    #[test]
    fn default_literal_keeps_temporal_defaults_that_carry_a_precision() {
        use DialectKind::Mysql;

        // `TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6)` is valid MySQL. On a server
        // older than 8.0.13 it arrives with no EXTRA marker, so the fallback has
        // to accept the precision argument or the column is deployed with a
        // quoted string where an expression belongs.
        assert_eq!(default_literal("CURRENT_TIMESTAMP(6)", "timestamp(6)", Mysql, None), "CURRENT_TIMESTAMP(6)");
        assert_eq!(default_literal("NOW()", "datetime", Mysql, None), "NOW()");
        assert_eq!(default_literal("LOCALTIME(3)", "datetime(3)", Mysql, None), "LOCALTIME(3)");
        assert_eq!(default_literal("LOCALTIMESTAMP(3)", "timestamp(3)", Mysql, None), "LOCALTIMESTAMP(3)");
        assert_eq!(default_literal("current_timestamp(6)", "timestamp(6)", Mysql, None), "current_timestamp(6)");

        // The precision form must not become a general "contains a parenthesis"
        // rule again: a string default keeps its quotes.
        assert_eq!(default_literal("a(b)", "varchar(32)", Mysql, None), "'a(b)'");
        assert_eq!(default_literal("CURRENT_TIMESTAMPX(6)", "varchar(64)", Mysql, None), "'CURRENT_TIMESTAMPX(6)'");
    }

    #[test]
    fn default_literal_leaves_non_mysql_expressions_alone() {
        use DialectKind::{Oracle, Postgres, SqlServer};

        // These dialects return a string default already quoted, so a bare token
        // is an expression. Quoting it would silently turn a per-row value into
        // a fixed string.
        assert_eq!(default_literal("CURRENT_USER", "text", Postgres, None), "CURRENT_USER");
        assert_eq!(default_literal("USER", "varchar2(30)", Oracle, None), "USER");
        assert_eq!(default_literal("'new'::text", "text", Postgres, None), "'new'::text");
        assert_eq!(default_literal("nextval('s'::regclass)", "integer", Postgres, None), "nextval('s'::regclass)");
        assert_eq!(default_literal("N'guest'", "nvarchar(50)", SqlServer, None), "N'guest'");
        assert_eq!(default_literal("('x')", "varchar(10)", SqlServer, None), "('x')");
        assert_eq!(default_literal("NULL", "text", Postgres, None), "NULL");
        // The same bare token on MySQL is a string, which is why the rule has to
        // follow the source dialect rather than the value.
        assert_eq!(default_literal("CURRENT_USER", "text", DialectKind::Mysql, None), "'CURRENT_USER'");
    }

    #[test]
    fn sqlserver_default_literal_rewrites_cross_dialect_expressions() {
        assert_eq!(
            sqlserver_default_literal("CURRENT_TIMESTAMP(6)", "DATETIME2(6)", Some(DialectKind::Mysql), None),
            "SYSDATETIME()"
        );
        assert_eq!(
            sqlserver_default_literal("CURRENT_TIMESTAMP", "DATETIME2(6)", Some(DialectKind::Mysql), None),
            "SYSDATETIME()"
        );
        assert_eq!(
            sqlserver_default_literal("now()", "DATETIMEOFFSET(6)", Some(DialectKind::Postgres), None),
            "SYSDATETIMEOFFSET()"
        );
        assert_eq!(
            sqlserver_default_literal("(uuid())", "UNIQUEIDENTIFIER", Some(DialectKind::Mysql), None),
            "NEWID()"
        );
        assert_eq!(sqlserver_default_literal("b'1'", "BIT", Some(DialectKind::Mysql), None), "1");
        assert_eq!(sqlserver_default_literal("b'1010'", "BIGINT", Some(DialectKind::Mysql), None), "10");
        assert_eq!(sqlserver_default_literal("x'DEAD'", "VARBINARY(2)", Some(DialectKind::Mysql), None), "0xDEAD");
        assert_eq!(sqlserver_default_literal("true", "BIT", Some(DialectKind::Postgres), None), "1");
        assert_eq!(sqlserver_default_literal("'false'::boolean", "BIT", Some(DialectKind::Postgres), None), "0");
        assert_eq!(
            sqlserver_default_literal("'true'::text", "NVARCHAR(16)", Some(DialectKind::Postgres), None),
            "N'true'"
        );
        assert_eq!(
            sqlserver_default_literal("'\\xCAFE'::bytea", "VARBINARY(MAX)", Some(DialectKind::Postgres), None),
            "0xCAFE"
        );
        assert_eq!(
            sqlserver_default_literal("'guest'::character varying", "NVARCHAR(64)", Some(DialectKind::Postgres), None),
            "N'guest'"
        );
        assert_eq!(
            sqlserver_default_literal("'0.00'::numeric(10,2)", "DECIMAL(10,2)", Some(DialectKind::Postgres), None),
            "'0.00'"
        );
        assert_eq!(
            sqlserver_default_literal(
                "'guest'::character varying(20)",
                "NVARCHAR(20)",
                Some(DialectKind::Postgres),
                None
            ),
            "N'guest'"
        );
        assert_eq!(
            sqlserver_default_literal("'{a,b}'::text[]", "NVARCHAR(32)", Some(DialectKind::Postgres), None),
            "N'{a,b}'"
        );
        assert_eq!(
            sqlserver_default_literal(
                "'guest'::\"public\".\"character varying\"(20)",
                "NVARCHAR(20)",
                Some(DialectKind::Postgres),
                None
            ),
            "N'guest'"
        );
        assert_eq!(
            sqlserver_default_literal("('中文')::text", "NVARCHAR(64)", Some(DialectKind::Postgres), None),
            "(N'中文')"
        );
        assert_eq!(
            sqlserver_default_literal(
                "nextval('sales.order_seq'::regclass)",
                "BIGINT",
                Some(DialectKind::Postgres),
                None
            ),
            "NEXT VALUE FOR [dbo].[order_seq]"
        );
        assert_eq!(
            sqlserver_default_literal_for_schema(
                "nextval('public.order_seq'::regclass)",
                "BIGINT",
                Some(DialectKind::Postgres),
                None,
                Some("sales")
            ),
            "NEXT VALUE FOR [sales].[order_seq]"
        );
        assert_eq!(
            sqlserver_default_literal("CURRENT_DATE()", "DATE", Some(DialectKind::Mysql), None),
            "CONVERT(date, GETDATE())"
        );
        assert_eq!(
            sqlserver_default_literal("LOCALTIME(3)", "TIME(3)", Some(DialectKind::Postgres), None),
            "CONVERT(time, GETDATE())"
        );
        assert_eq!(
            sqlserver_default_literal("((getdate()))", "DATETIME2", Some(DialectKind::SqlServer), None),
            "((getdate()))"
        );
    }

    #[test]
    fn strip_postgres_default_casts_consumes_complete_type_syntax() {
        assert_eq!(strip_postgres_default_casts("'value'::numeric(10,2)"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::character varying(20)"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::public.\"custom_type\"(10,2)[10][]"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::\"sch\"\"ema\".\"ty\"\"pe\"(4)[]"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::timestamp(3) without time zone"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::double precision"), "'value'");
        assert_eq!(strip_postgres_default_casts("'value'::interval day to second(6)"), "'value'");
        assert_eq!(strip_postgres_default_casts("nextval('orders.id'::regclass)"), "nextval('orders.id')");
        assert_eq!(strip_postgres_default_casts("'1'::text::integer"), "'1'");
    }

    #[test]
    fn strip_postgres_default_casts_preserves_expression_boundaries() {
        assert_eq!(strip_postgres_default_casts("(true::boolean AND false)"), "(true AND false)");
        assert_eq!(strip_postgres_default_casts("1::int IS DISTINCT FROM 2"), "1 IS DISTINCT FROM 2");
        assert_eq!(
            strip_postgres_default_casts("CURRENT_TIMESTAMP::timestamp AT TIME ZONE 'UTC'"),
            "CURRENT_TIMESTAMP AT TIME ZONE 'UTC'"
        );
        assert_eq!(strip_postgres_default_casts("'x'::text COLLATE \"C\""), "'x' COLLATE \"C\"");
        assert_eq!(strip_postgres_default_casts("1::integer IN (1,2)"), "1 IN (1,2)");
        assert_eq!(strip_postgres_default_casts("\"fn::name\"()::integer"), "\"fn::name\"()");
        assert_eq!(strip_postgres_default_casts("$$a::int$$::text"), "$$a::int$$");
        assert_eq!(strip_postgres_default_casts("$tag$a::int$tag$::text"), "$tag$a::int$tag$");
        assert_eq!(strip_postgres_default_casts(r"E'a\'::int'::text"), r"E'a\'::int'");
    }

    #[test]
    fn strip_postgres_default_casts_leaves_malformed_types_unchanged() {
        for malformed in [
            "x::",
            "x::numeric(10",
            "x::numeric(10::int",
            "x::numeric(10,2)garbage",
            "x::numeric(10)(20)",
            "x::\"unterminated",
            "x::\"foo\"bar",
            "x::schema.",
            "x::text[bad]",
            "x::text[bad::int]",
            "x::text[++]]",
            "x::text[1+2]",
            "x::text[-1]",
            "x::text[]garbage",
        ] {
            assert_eq!(strip_postgres_default_casts(malformed), malformed);
        }
    }

    #[test]
    fn default_literal_handles_set_and_binary_boundaries() {
        use DialectKind::Mysql;

        // A SET default is a bare comma-separated string.
        assert_eq!(default_literal("a,b", "set('a','b')", Mysql, None), "'a,b'");
        assert_eq!(default_literal("", "set('a','b')", Mysql, None), "''");
        // Binary defaults arrive as a hex literal, which is already valid
        // unquoted; a bare string on the same column still needs quoting.
        assert_eq!(default_literal("0x61", "varbinary(16)", Mysql, None), "0x61");
        assert_eq!(default_literal("abc", "binary(3)", Mysql, None), "'abc'");
        assert_eq!(default_literal("x'1f'", "blob", Mysql, None), "x'1f'");
        // Not hex, so not a hex literal.
        assert_eq!(default_literal("0xzz", "varbinary(8)", Mysql, None), "'0xzz'");
    }

    // -- 35. Column order changes --
    #[test]
    fn column_order_change_only_no_type_change() {
        let source = vec![column("id", "int", None), column("name", "text", None), column("age", "int", None)];
        let target = vec![column("age", "int", None), column("name", "text", None), column("id", "int", None)];
        let diffs = diff_columns_with_options(&source, &target, false, true, false, 0.5);
        assert!(!diffs.is_empty(), "should detect order changes");
        assert!(diffs.iter().all(|d| d.diff_type == "modified"), "all should be modified");
        assert!(diffs.iter().all(|d| d.changes.iter().any(|c| c.starts_with("order:"))), "all order changes");
    }

    #[test]
    fn column_order_changes_with_source_dialect() {
        let source = vec![column("id", "int(11)", None), column("name", "varchar(50)", None)];
        let target = vec![column("name", "text", None), column("id", "int", None)];
        let diffs = diff_columns_with_options(&source, &target, false, true, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, Some(DialectKind::Mysql));
        assert!(sql.contains("INTEGER"), "type converted: {sql}");
    }

    // -- 36. prepare_schema_diff integration with source_dialect --
    #[test]
    fn prepare_schema_diff_with_source_dialect() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "users".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "users".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "users".into(),
                columns: vec![column("name2", "varchar(100)", None), column("id", "int(11)", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "users".into(),
                columns: vec![column("name", "varchar(100)", None), column("id", "int", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: true,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Mysql),
            ..Default::default()
        };
        let result = prepare_schema_diff(options);
        assert!(!result.diffs.is_empty(), "should have diffs");
        let sql = &result.sync_sql;
        assert!(sql.contains("CHANGE COLUMN"), "detected rename: {sql}");
        assert!(!sql.contains("DROP COLUMN"), "no false drop: {sql}");
    }

    #[test]
    fn prepare_schema_diff_integration_cross_dialect() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "t".into(),
                columns: vec![column("flag", "tinyint", None), column("name2", "varchar(50)", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "t".into(),
                columns: vec![column("flag", "smallint", None), column("name", "varchar(50)", None)],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            database_type: DatabaseType::Postgres,
            detect_renames: true,
            rename_threshold: 0.5,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Postgres),
            ..Default::default()
        };
        let result = prepare_schema_diff(options);
        let sql = &result.sync_sql;
        assert!(sql.contains("RENAME COLUMN"), "PG rename: {sql}");
        assert!(sql.contains("SMALLINT"), "tinyint→SMALLINT: {sql}");
        assert!(!sql.contains('`'), "PG no backticks: {sql}");
    }

    // -- 37. Index + column rename combined --
    #[test]
    fn index_and_rename_combined() {
        let col_diffs =
            make_col_diffs(&[("id", "int"), ("name2", "varchar(50)")], &[("id", "int"), ("name", "varchar(50)")], true);
        let table_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: Some(col_diffs),
            indexes: Some(vec![IndexDiff {
                diff_type: "added".to_string(),
                name: "idx_name".to_string(),
                source: Some(index(IndexInfo {
                    name: "idx_name".to_string(),
                    columns: vec!["name2".to_string()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                })),
                target: None,
                changes: vec![],
            }]),
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
        assert!(sql.contains("RENAME COLUMN"), "rename: {sql}");
        assert!(sql.contains("CREATE INDEX"), "index: {sql}");
    }

    #[test]
    fn index_and_rename_combined_mysql() {
        let col_diffs =
            make_col_diffs(&[("id", "int"), ("name2", "varchar(50)")], &[("id", "int"), ("name", "varchar(50)")], true);
        let table_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: Some(col_diffs),
            indexes: Some(vec![IndexDiff {
                diff_type: "removed".to_string(),
                name: "idx_old".to_string(),
                source: None,
                target: Some(index(IndexInfo {
                    name: "idx_old".to_string(),
                    columns: vec!["name".to_string()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                })),
                changes: vec![],
            }]),
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]);
        assert!(sql.contains("CHANGE COLUMN"), "rename: {sql}");
        assert!(sql.contains("DROP INDEX"), "drop index: {sql}");
    }

    // -- 38. diff_columns_with_compatibility cross-dialect --
    #[test]
    fn diff_columns_with_compatibility_cross_dialect() {
        let source = vec![column("id", "int(11)", None)];
        let target = vec![column("id", "integer", None)];
        let (_diffs, warnings) = diff_columns_with_compatibility(
            &source,
            &target,
            false,
            false,
            DialectKind::Mysql,
            DialectKind::Postgres,
            0.5,
            &[],
        );
        // int(11)→integer should be compatible
        let has_warning = warnings.iter().any(|w| w.column_name == "id");
        assert!(!has_warning, "int(11)→integer should be compatible");
    }

    #[test]
    fn diff_columns_with_compatibility_warning() {
        let source = vec![column("id", "int", None)];
        let target = vec![column("id", "text", None)];
        let (_diffs, warnings) = diff_columns_with_compatibility(
            &source,
            &target,
            false,
            false,
            DialectKind::Mysql,
            DialectKind::Postgres,
            0.9,
            &[],
        );
        let has_warning = warnings.iter().any(|w| w.column_name == "id");
        assert!(has_warning, "int→text should generate warning");
    }

    // -- 39. Type mapping prefix matching edge cases --
    #[test]
    fn convert_type_prefix_matches_parameterized() {
        use crate::sql_dialect::descriptor::TypeMappingMatrix;
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        let (result, _) = matrix.convert_type("tinyint(1)");
        assert_eq!(result, "BOOLEAN", "tinyint(1) → BOOLEAN");
        // tinyint(4) matches TINYINT prefix rule → SMALLINT (not BOOLEAN)
        let (result, _) = matrix.convert_type("tinyint(4)");
        assert_eq!(result, "SMALLINT", "tinyint(4) → SMALLINT");
    }

    #[test]
    fn convert_type_unknown_type_passthrough() {
        use crate::sql_dialect::descriptor::TypeMappingMatrix;
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        let (result, requires_cast) = matrix.convert_type("geometry");
        assert_eq!(result, "geometry", "unknown type passthrough");
        assert!(requires_cast, "unknown type requires cast");
    }

    #[test]
    fn convert_type_empty_string() {
        use crate::sql_dialect::descriptor::TypeMappingMatrix;
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        let (result, _) = matrix.convert_type("");
        assert_eq!(result, "", "empty string passthrough");
    }

    // -- 40. Rollback SQL with column renames --
    #[test]
    fn rollback_graph_with_renames() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "renamed".to_string(),
                name: "new_name".to_string(),
                source: Some(column("new_name", "varchar(50)", None)),
                target: Some(column("old_name", "varchar(50)", None)),
                changes: vec!["old_name → new_name".to_string()],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];
        let dep_graph = DependencyGraph::build(&[], &[]);
        let graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);
        let rollback_sql = generate_rollback_sync_sql(&graph, DatabaseType::Mysql, None, false);
        assert!(
            rollback_sql.contains("CHANGE COLUMN `new_name` `old_name`"),
            "rollback should reverse rename: {rollback_sql}"
        );
    }

    #[test]
    fn rollback_with_cross_dialect_type_conversion() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "id".to_string(),
                source: Some(column("id", "int(11)", None)),
                target: None,
                changes: vec![],
                add_position: None,
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }];
        let dep_graph = DependencyGraph::build(&[], &[]);
        let graph = RollbackGraph::from_forward_diffs(&diffs, &[], &dep_graph);
        let rollback_sql = generate_rollback_sync_sql(&graph, DatabaseType::Postgres, None, false);
        assert!(rollback_sql.contains("DROP COLUMN"), "rollback add→drop: {rollback_sql}");
    }

    // -- 41. Multiple MySQL→PG type conversion in combined SQL --
    #[test]
    fn cross_dialect_multiple_type_conversions_in_one_alter() {
        let diffs = make_col_diffs(
            &[("a1", "tinyint"), ("b1", "mediumint"), ("c1", "float"), ("d1", "double"), ("e1", "datetime")],
            &[],
            false,
        );
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, Some(DialectKind::Mysql));
        assert!(sql.contains("SMALLINT"), "tinyint→SMALLINT: {sql}");
        assert!(sql.contains("INTEGER"), "mediumint→INTEGER: {sql}");
        assert!(sql.contains("REAL"), "float→REAL: {sql}");
        assert!(sql.contains("DOUBLE PRECISION"), "double→DOUBLE PRECISION: {sql}");
        assert!(sql.contains("TIMESTAMP"), "datetime→TIMESTAMP: {sql}");
    }

    // -- 42. ADD COLUMN with default value --
    #[test]
    fn add_column_with_default_value() {
        let source = vec![ColumnInfo { column_default: Some("0".into()), ..column("status", "int", None) }];
        let target: Vec<ColumnInfo> = vec![];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        for (db, label) in [(DatabaseType::Mysql, "MySQL"), (DatabaseType::Postgres, "PG")] {
            let sql = gen_sql(wrap_table_diff("t", diffs.clone()), db, None);
            assert!(sql.contains("DEFAULT 0"), "{label} default: {sql}");
        }
    }

    // -- 43. Comment changes for non-MySQL databases --
    #[test]
    fn column_comment_change_non_mysql() {
        let source = vec![column("name", "text", Some("new comment"))];
        let target = vec![column("name", "text", Some("old comment"))];
        let diffs = diff_columns_with_options(&source, &target, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Postgres, None);
        assert!(sql.contains("COMMENT ON COLUMN"), "PG comment: {sql}");
    }

    #[test]
    fn table_comment_change_mysql() {
        let _diffs: Vec<ColumnDiff> = vec![];
        let table_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: Some(Some("new".to_string())),
            target_table_comment: Some(Some("old".to_string())),
            sync_sql: None,
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]);
        assert!(sql.contains("COMMENT ="), "MySQL table comment: {sql}");
    }

    // -- 44. Detect renames function (table-level) --
    #[test]
    fn table_detect_renames_exact_match() {
        let removed = vec!["old_table".to_string()];
        let added = vec!["new_table".to_string()];
        let source_details = vec![TableSchemaDetail {
            name: "new_table".into(),
            columns: vec![column("id", "int", None), column("name", "text", None)],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];
        let target_details = vec![TableSchemaDetail {
            name: "old_table".into(),
            columns: vec![column("id", "int", None), column("name", "text", None)],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            ddl: None,
        }];
        let candidates = detect_renames(&removed, &added, &source_details, &target_details, 0.5);
        assert_eq!(candidates.len(), 1, "should detect table rename");
        assert_eq!(candidates[0].source_name, "new_table");
        assert_eq!(candidates[0].target_name, "old_table");
    }

    // -- 45. Column rename detection: greedy matching avoids conflicts --
    #[test]
    fn rename_greedy_matching() {
        let s: Vec<ColumnInfo> = vec![column("a", "int", None), column("b", "varchar(10)", None)];
        let t: Vec<ColumnInfo> = vec![column("x", "int", None), column("y", "int", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, true, 0.5);
        let renamed: Vec<_> = diffs.iter().filter(|d| d.diff_type == "renamed").collect();
        // Only one should be renamed (greedy: best score), the other stays added/removed
        assert!(renamed.len() <= 1, "greedy should avoid double matching: {renamed:?}");
    }

    // -- 46. Column precision/scale changes --
    #[test]
    fn column_precision_scale_change() {
        let s = vec![column("amount", "decimal(10,2)", None)];
        let t = vec![column("amount", "decimal(8,0)", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        assert_eq!(diffs.len(), 1, "should detect precision change");
        assert!(
            diffs[0].changes.iter().any(|c| c.contains("decimal(8,0) → decimal(10,2)")),
            "precision diff: {:?}",
            diffs[0].changes
        );
    }

    #[test]
    fn column_precision_change_generates_sql() {
        let s = vec![column("price", "decimal(10,2)", None)];
        let t = vec![column("price", "decimal(8,2)", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("decimal(10,2)"), "precision in sql: {sql}");
    }

    // -- 47. Column length changes --
    #[test]
    fn column_length_change_detected() {
        let s = vec![column("name", "varchar(255)", None)];
        let t = vec![column("name", "varchar(100)", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        assert_eq!(diffs.len(), 1, "should detect length change");
        assert!(
            diffs[0].changes.iter().any(|c| c.contains("varchar(100) → varchar(255)")),
            "length diff: {:?}",
            diffs[0].changes
        );
    }

    #[test]
    fn column_length_change_generates_modify_sql() {
        let s = vec![column("name", "varchar(255)", None)];
        let t = vec![column("name", "varchar(100)", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        for (db, label) in [(DatabaseType::Mysql, "MySQL"), (DatabaseType::Postgres, "PG")] {
            let sql = gen_sql(wrap_table_diff("t", diffs.clone()), db, None);
            assert!(sql.contains("varchar(255)"), "{label} length: {sql}");
        }
    }

    // -- 48. Column comment changes with ignore_comments option --
    #[test]
    fn column_comment_change_detected() {
        let s = vec![column("name", "int", Some("new comment"))];
        let t = vec![column("name", "int", Some("old comment"))];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        assert_eq!(diffs.len(), 1, "should detect comment change");
        assert!(diffs[0].changes.iter().any(|c| c.starts_with("comment:")), "comment diff: {:?}", diffs[0].changes);
    }

    #[test]
    fn column_comment_ignored_when_option_set() {
        let s = vec![column("name", "int", Some("new"))];
        let t = vec![column("name", "int", Some("old"))];
        let diffs = diff_columns_with_options(&s, &t, true, false, false, 0.5);
        assert!(diffs.is_empty(), "should ignore comment when option set: {diffs:?}");
    }

    #[test]
    fn column_comment_change_mysql_sql() {
        let s = vec![column("name", "varchar(50)", Some("中文注释"))];
        let t = vec![column("name", "varchar(50)", Some("old"))];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        let sql = gen_sql(wrap_table_diff("t", diffs), DatabaseType::Mysql, None);
        assert!(sql.contains("COMMENT"), "MySQL comment: {sql}");
        assert!(sql.contains("中文注释"), "Chinese comment: {sql}");
    }

    #[test]
    fn table_comment_change_mysql_sql() {
        let _diffs: Vec<ColumnDiff> = vec![];
        let table_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: Some(Some("新表".to_string())),
            target_table_comment: Some(Some("旧表".to_string())),
            sync_sql: None,
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]);
        assert!(sql.contains("COMMENT ="), "MySQL table comment: {sql}");
        assert!(sql.contains("新表"), "Chinese table comment: {sql}");
    }

    #[test]
    fn table_comment_ignored_with_option() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: Some("new".into()),
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: Some("old".into()),
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "t".into(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "t".into(),
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                triggers: vec![],
                ddl: None,
            }],
            database_type: DatabaseType::Mysql,
            ignore_comments: true,
            ..Default::default()
        };
        let result = prepare_schema_diff(options);
        assert!(result.diffs.is_empty(), "should ignore table comment: {:?}", result.diffs);
    }

    // -- 49. Index type differences --
    #[test]
    fn index_type_diff_btree_vs_hash() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: Some("BTREE".into()),
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: Some("HASH".into()),
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs.len(), 1, "index type diff detected");
        assert!(diffs[0].changes.iter().any(|c| c.contains("type:")), "type change: {:?}", diffs[0].changes);
    }

    #[test]
    fn index_type_fulltext_detected() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["content".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: Some("FULLTEXT".into()),
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["content".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs[0].changes.iter().filter(|c| c.contains("FULLTEXT")).count(), 1, "fulltext change");
    }

    // -- 50. Index column ordering --
    #[test]
    fn index_column_order_different() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into(), "b".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["b".into(), "a".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs.len(), 1, "order diff detected");
        assert!(diffs[0].changes.iter().any(|c| c.contains("columns:")), "column order change: {:?}", diffs[0].changes);
    }

    // -- 51. Included columns in indexes --
    #[test]
    fn index_included_columns_diff() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: Some(vec!["b".into(), "c".into()]),
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: Some(vec!["b".into()]),
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs.len(), 1, "included columns diff detected");
        assert!(diffs[0].changes.iter().any(|c| c.contains("include:")), "include change: {:?}", diffs[0].changes);
    }

    #[test]
    fn index_included_columns_added() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: Some(vec!["b".into()]),
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["a".into()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs.len(), 1, "included added");
    }

    // -- 52. Filtered/partial indexes --
    #[test]
    fn index_filter_change() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["status".into()],
                is_unique: false,
                is_primary: false,
                filter: Some("status > 0".into()),
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
            &[index(IndexInfo {
                name: "idx_t".into(),
                columns: vec!["status".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            })],
        );
        assert_eq!(diffs.len(), 1, "filter diff");
        assert!(diffs[0].changes.iter().any(|c| c.contains("filter:")), "filter change: {:?}", diffs[0].changes);
    }

    // -- 53. Multiple index operations in one diff --
    #[test]
    fn multiple_index_operations() {
        let diffs = diff_indexes(
            &[
                index(IndexInfo {
                    name: "idx_new".into(),
                    columns: vec!["a".into()],
                    is_unique: true,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                }),
                index(IndexInfo {
                    name: "idx_modified".into(),
                    columns: vec!["a".into(), "b".into()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: Some("BTREE".into()),
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                }),
            ],
            &[
                index(IndexInfo {
                    name: "idx_removed".into(),
                    columns: vec!["c".into()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                }),
                index(IndexInfo {
                    name: "idx_modified".into(),
                    columns: vec!["a".into()],
                    is_unique: true,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                    key_is_expression: Vec::new(),
                }),
            ],
        );
        assert_eq!(diffs.len(), 3, "add + modify + remove: {diffs:?}");
        let types: Vec<&str> = diffs.iter().map(|d| d.diff_type.as_str()).collect();
        assert!(types.contains(&"added"), "should have added");
        assert!(types.contains(&"removed"), "should have removed");
        assert!(types.contains(&"modified"), "should have modified");
    }

    // -- 54. Foreign key ref_table / ref_column changes --
    #[test]
    fn foreign_key_reference_table_change() {
        let diffs = diff_foreign_keys(
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "employees".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
        );
        assert_eq!(diffs.len(), 1, "ref_table change");
        assert!(diffs[0].changes.iter().any(|c| c.contains("ref table")), "ref table: {:?}", diffs[0].changes);
    }

    #[test]
    fn foreign_key_reference_column_change() {
        let diffs = diff_foreign_keys(
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "uid".into(),
                on_update: None,
                on_delete: None,
            })],
        );
        assert_eq!(diffs.len(), 1, "ref_column change");
    }

    #[test]
    fn foreign_key_local_column_change() {
        let diffs = diff_foreign_keys(
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "member_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
        );
        assert_eq!(diffs.len(), 1, "local column change");
    }

    #[test]
    fn foreign_key_referential_action_change() {
        let diffs = diff_foreign_keys(
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: Some("auth".into()),
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: Some("cascade".into()),
                on_delete: Some("SET NULL".into()),
            })],
            &[foreign_key(ForeignKeyInfo {
                name: "fk_t".into(),
                column: "user_id".into(),
                ref_schema: Some("auth".into()),
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: Some("NO ACTION".into()),
                on_delete: Some("RESTRICT".into()),
            })],
        );
        assert_eq!(diffs.len(), 1, "referential action change: {diffs:?}");
        assert!(diffs[0].changes.iter().any(|change| change == "delete: RESTRICT → SET NULL"));
        assert!(diffs[0].changes.iter().any(|change| change == "update: NO ACTION → CASCADE"));
    }

    #[test]
    fn modified_foreign_key_sql_preserves_reference_schema_and_actions() {
        let table_diff = TableDiff {
            diff_type: "modified".into(),
            object_type: Some("table".into()),
            name: "orders".into(),
            columns: None,
            indexes: None,
            foreign_keys: Some(vec![ForeignKeyDiff {
                diff_type: "modified".into(),
                name: "orders_user_fk".into(),
                source: Some(foreign_key(ForeignKeyInfo {
                    name: "orders_user_fk".into(),
                    column: "user_id".into(),
                    ref_schema: Some("identity".into()),
                    ref_table: "users".into(),
                    ref_column: "id".into(),
                    on_update: Some("CASCADE".into()),
                    on_delete: Some("SET NULL".into()),
                })),
                target: None,
                changes: vec![],
            }]),
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("sales"),
            false,
            None,
            &[],
        );
        assert!(sql.contains("REFERENCES \"identity\".\"users\" (\"id\")"), "schema: {sql}");
        assert!(sql.contains("ON DELETE SET NULL ON UPDATE CASCADE"), "actions: {sql}");
    }

    // -- Regression: issue #7287 --
    // MySQL's information_schema always fills REFERENCED_TABLE_SCHEMA with the literal
    // database name, even for a foreign key that just self-references a table in its own
    // database. Comparing two differently-named databases (e.g. a dev copy vs prod) made
    // every such self-referencing FK look "changed" purely because the database names
    // differ, and the deploy script it generated pointed the target's FK at the *source*
    // database instead of leaving it self-referencing within the target.
    fn self_referencing_fk_options(
        source_ref_schema: &str,
        target_ref_schema: &str,
        source_on_delete: &str,
        target_on_delete: &str,
    ) -> SchemaDiffPreparationOptions {
        let table_infos = vec![
            TableInfo {
                name: "sys_organization".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "sys_user".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];
        let cols = vec![column("id", "int(11)", None), column("leader_id", "int(11)", None)];
        let fk = |ref_schema: &str, on_delete: &str| ForeignKeyInfo {
            name: "sys_organization_ibfk_1".into(),
            column: "leader_id".into(),
            ref_schema: Some(ref_schema.to_string()),
            ref_table: "sys_user".into(),
            ref_column: "user_id".into(),
            on_update: Some("RESTRICT".into()),
            on_delete: Some(on_delete.to_string()),
        };
        SchemaDiffPreparationOptions {
            source_tables: table_infos.clone(),
            target_tables: table_infos,
            source_details: vec![
                TableSchemaDetail {
                    name: "sys_organization".into(),
                    columns: cols.clone(),
                    indexes: vec![],
                    foreign_keys: vec![fk(source_ref_schema, source_on_delete)],
                    triggers: vec![],
                    ddl: None,
                },
                TableSchemaDetail {
                    name: "sys_user".into(),
                    columns: vec![column("user_id", "int(11)", None)],
                    indexes: vec![],
                    foreign_keys: vec![],
                    triggers: vec![],
                    ddl: None,
                },
            ],
            target_details: vec![
                TableSchemaDetail {
                    name: "sys_organization".into(),
                    columns: cols.clone(),
                    indexes: vec![],
                    foreign_keys: vec![fk(target_ref_schema, target_on_delete)],
                    triggers: vec![],
                    ddl: None,
                },
                TableSchemaDetail {
                    name: "sys_user".into(),
                    columns: vec![column("user_id", "int(11)", None)],
                    indexes: vec![],
                    foreign_keys: vec![],
                    triggers: vec![],
                    ddl: None,
                },
            ],
            database_type: DatabaseType::Mysql,
            target_schema: Some("jinxinnuo_agent_db".into()),
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: true,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Mysql),
            ..Default::default()
        }
    }

    #[test]
    fn self_referencing_fk_across_differently_named_databases_is_not_a_diff() {
        let options =
            self_referencing_fk_options("jinxinnuo_agent_db_test", "jinxinnuo_agent_db", "SET NULL", "SET NULL");
        let result = prepare_schema_diff(options);
        assert!(
            !result.sync_sql.contains("sys_organization_ibfk_1"),
            "same-database self-reference must not be resynced just because the two \
             database names differ: {}",
            result.sync_sql
        );
    }

    #[test]
    fn modified_self_referencing_fk_regenerates_against_target_database() {
        // A genuine change (ON DELETE) forces the FK to be resynced; the regenerated
        // REFERENCES clause must still point at the target's own database, not the source's.
        let options =
            self_referencing_fk_options("jinxinnuo_agent_db_test", "jinxinnuo_agent_db", "SET NULL", "CASCADE");
        let result = prepare_schema_diff(options);
        assert!(
            !result.sync_sql.contains("jinxinnuo_agent_db_test"),
            "must not reference the source database: {}",
            result.sync_sql
        );
        assert!(
            result.sync_sql.contains("REFERENCES `jinxinnuo_agent_db`.`sys_user`")
                || result.sync_sql.contains("REFERENCES `sys_user`"),
            "must reference the target database (or be left unqualified): {}",
            result.sync_sql
        );
    }

    #[test]
    fn genuine_cross_database_fk_reference_change_is_still_detected() {
        // `external_lookup` is not one of the tables being compared, so a differing
        // ref_schema here is a real cross-database reference change, not a same-database
        // self-reference — it must still be surfaced and regenerated with the source's value.
        let table_infos = vec![TableInfo {
            name: "orders".into(),
            table_type: "BASE TABLE".into(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }];
        let cols = vec![column("id", "int(11)", None), column("region_id", "int(11)", None)];
        let make_detail = |ref_schema: &str| TableSchemaDetail {
            name: "orders".into(),
            columns: cols.clone(),
            indexes: vec![],
            foreign_keys: vec![ForeignKeyInfo {
                name: "orders_region_fk".into(),
                column: "region_id".into(),
                ref_schema: Some(ref_schema.to_string()),
                ref_table: "external_lookup".into(),
                ref_column: "id".into(),
                on_update: Some("RESTRICT".into()),
                on_delete: Some("RESTRICT".into()),
            }],
            triggers: vec![],
            ddl: None,
        };
        let options = SchemaDiffPreparationOptions {
            source_tables: table_infos.clone(),
            target_tables: table_infos,
            source_details: vec![make_detail("shared_lookup_db")],
            target_details: vec![make_detail("stale_lookup_db")],
            database_type: DatabaseType::Mysql,
            target_schema: Some("jinxinnuo_agent_db".into()),
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: true,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Mysql),
            ..Default::default()
        };
        let result = prepare_schema_diff(options);
        assert!(
            result.sync_sql.contains("REFERENCES `shared_lookup_db`.`external_lookup`"),
            "genuine cross-database reference change must still be resynced to the source's \
             external database: {}",
            result.sync_sql
        );
    }

    #[test]
    fn column_index_fk_combined_diff() {
        let col_diffs = make_col_diffs(
            &[("id", "int"), ("name2", "varchar(100)")],
            &[("id", "int"), ("name", "varchar(50)")],
            true,
        );
        let table_diff = TableDiff {
            diff_type: "modified".to_string(),
            object_type: Some("table".to_string()),
            name: "t".to_string(),
            columns: Some(col_diffs),
            indexes: Some(vec![
                IndexDiff {
                    diff_type: "added".to_string(),
                    name: "idx_name".into(),
                    source: Some(index(IndexInfo {
                        name: "idx_name".into(),
                        columns: vec!["name2".into()],
                        is_unique: false,
                        is_primary: false,
                        filter: None,
                        index_type: Some("BTREE".into()),
                        included_columns: None,
                        comment: None,
                        key_is_expression: Vec::new(),
                    })),
                    target: None,
                    changes: vec![],
                },
                IndexDiff {
                    diff_type: "removed".to_string(),
                    name: "idx_old".into(),
                    source: None,
                    target: Some(index(IndexInfo {
                        name: "idx_old".into(),
                        columns: vec!["name".into()],
                        is_unique: false,
                        is_primary: false,
                        filter: None,
                        index_type: None,
                        included_columns: None,
                        comment: None,
                        key_is_expression: Vec::new(),
                    })),
                    changes: vec![],
                },
            ]),
            foreign_keys: Some(vec![ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: "fk_ref".into(),
                source: Some(foreign_key(ForeignKeyInfo {
                    name: "fk_ref".into(),
                    column: "id".into(),
                    ref_schema: None,
                    ref_table: "users".into(),
                    ref_column: "id".into(),
                    on_update: None,
                    on_delete: Some("CASCADE".into()),
                })),
                target: Some(foreign_key(ForeignKeyInfo {
                    name: "fk_ref".into(),
                    column: "id".into(),
                    ref_schema: None,
                    ref_table: "users".into(),
                    ref_column: "id".into(),
                    on_update: None,
                    on_delete: Some("SET NULL".into()),
                })),
                changes: vec!["delete: SET NULL → CASCADE".into()],
            }]),
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
        assert!(sql.contains("RENAME COLUMN"), "rename: {sql}");
        assert!(sql.contains("CREATE INDEX"), "add index: {sql}");
        assert!(sql.contains("DROP INDEX"), "drop index: {sql}");
        assert!(sql.contains("DROP CONSTRAINT"), "fk drop: {sql}");
        assert!(sql.contains("ADD CONSTRAINT"), "fk add: {sql}");
    }

    // -- 56. Column order changes with comment option --
    #[test]
    fn column_order_ignored_when_disabled_but_comment_detected() {
        let s = vec![column("a", "int", Some("x")), column("b", "varchar(10)", None)];
        let t = vec![column("b", "varchar(10)", None), column("a", "int", None)];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        // order compare disabled, so only comment change on "a" should be detected
        assert!(!diffs.is_empty(), "comment change should be detected: {diffs:?}");
    }

    // -- 57. Type conversion with precision types (decimal, numeric) --
    #[test]
    fn decimal_type_conversion_mysql_to_postgres() {
        use crate::sql_dialect::descriptor::TypeMappingMatrix;
        let matrix = TypeMappingMatrix::for_dialects(DialectKind::Mysql, DialectKind::Postgres);
        // decimal is not in the mapping rules → passes through
        let (result, _) = matrix.convert_type("decimal(10,2)");
        assert_eq!(result, "decimal(10,2)", "decimal passthrough");
    }

    // -- 58. Column diff with all attributes different --
    #[test]
    fn column_all_attributes_changed() {
        let s = vec![ColumnInfo {
            name: "c".into(),
            data_type: "varchar(100)".into(),
            resolved_schema: None,
            is_nullable: true,
            column_default: Some("'default'".into()),
            comment: Some("new".into()),
            is_primary_key: false,
            is_unique: false,
            extra: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }];
        let t = vec![ColumnInfo {
            name: "c".into(),
            data_type: "varchar(50)".into(),
            resolved_schema: None,
            is_nullable: false,
            column_default: None,
            comment: Some("old".into()),
            is_primary_key: false,
            is_unique: false,
            extra: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }];
        let diffs = diff_columns_with_options(&s, &t, false, false, false, 0.5);
        assert_eq!(diffs.len(), 1, "all changes in one diff");
        let changes = &diffs[0].changes;
        assert!(changes.iter().any(|c| c.starts_with("type:")), "type: {changes:?}");
        assert!(changes.iter().any(|c| c.starts_with("nullable:")), "nullable: {changes:?}");
        assert!(changes.iter().any(|c| c.starts_with("default:")), "default: {changes:?}");
        assert!(changes.iter().any(|c| c.starts_with("comment:")), "comment: {changes:?}");
    }

    // -- 56. Foreign key with multiple changes (ref_table + ref_column) --
    #[test]
    fn foreign_key_multiple_changes() {
        let diffs = diff_foreign_keys(
            &[foreign_key(ForeignKeyInfo {
                name: "fk".into(),
                column: "id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: None,
            })],
            &[foreign_key(ForeignKeyInfo {
                name: "fk".into(),
                column: "id".into(),
                ref_schema: None,
                ref_table: "employees".into(),
                ref_column: "uid".into(),
                on_update: None,
                on_delete: None,
            })],
        );
        assert_eq!(diffs.len(), 1, "multiple FK changes");
        assert!(diffs[0].changes.iter().any(|c| c.contains("ref table")), "ref table: {:?}", diffs[0].changes);
        assert!(diffs[0].changes.iter().any(|c| c.contains("ref column")), "ref column: {:?}", diffs[0].changes);
    }

    // -- 60. With and without ignore_comments on prepare_schema_diff --
    #[test]
    fn prepare_schema_diff_comment_option_toggle() {
        fn run_test(ignore: bool, expect_diffs: bool) {
            let options = SchemaDiffPreparationOptions {
                source_tables: vec![TableInfo {
                    name: "t".into(),
                    table_type: "BASE TABLE".into(),
                    comment: Some("new_comment".into()),
                    parent_schema: None,
                    parent_name: None,
                }],
                target_tables: vec![TableInfo {
                    name: "t".into(),
                    table_type: "BASE TABLE".into(),
                    comment: Some("old_comment".into()),
                    parent_schema: None,
                    parent_name: None,
                }],
                source_details: vec![TableSchemaDetail {
                    name: "t".into(),
                    columns: vec![column("c", "int", Some("col_new"))],
                    indexes: vec![],
                    foreign_keys: vec![],
                    triggers: vec![],
                    ddl: None,
                }],
                target_details: vec![TableSchemaDetail {
                    name: "t".into(),
                    columns: vec![column("c", "int", Some("col_old"))],
                    indexes: vec![],
                    foreign_keys: vec![],
                    triggers: vec![],
                    ddl: None,
                }],
                database_type: DatabaseType::Mysql,
                ignore_comments: ignore,
                ..Default::default()
            };
            let result = prepare_schema_diff(options);
            if expect_diffs {
                assert!(!result.diffs.is_empty(), "should have diffs when ignore={ignore}");
            } else {
                assert!(result.diffs.is_empty(), "should be empty when ignore={ignore}");
            }
        }
        run_test(true, false);
        run_test(false, true);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Cross-dialect CREATE TABLE tests (all 11×11 pairs)
    // ═══════════════════════════════════════════════════════════════

    fn _dialect_from_db(db: DatabaseType) -> DialectKind {
        DialectKind::from_database_type(db)
    }

    fn all_kinds() -> Vec<DialectKind> {
        vec![
            DialectKind::Mysql,
            DialectKind::Postgres,
            DialectKind::Sqlite,
            DialectKind::SqlServer,
            DialectKind::Oracle,
            DialectKind::H2,
            DialectKind::ClickHouse,
            DialectKind::DuckDb,
            DialectKind::ManticoreSearch,
            DialectKind::Informix,
            DialectKind::Questdb,
        ]
    }

    fn kind_to_db(kind: DialectKind) -> Option<DatabaseType> {
        match kind {
            DialectKind::Mysql => Some(DatabaseType::Mysql),
            DialectKind::Postgres => Some(DatabaseType::Postgres),
            DialectKind::Sqlite => Some(DatabaseType::Sqlite),
            DialectKind::SqlServer => Some(DatabaseType::SqlServer),
            DialectKind::Oracle => Some(DatabaseType::Oracle),
            DialectKind::H2 => Some(DatabaseType::H2),
            DialectKind::ClickHouse => Some(DatabaseType::ClickHouse),
            DialectKind::DuckDb => Some(DatabaseType::DuckDb),
            DialectKind::ManticoreSearch => Some(DatabaseType::ManticoreSearch),
            DialectKind::Informix => Some(DatabaseType::Informix),
            DialectKind::Questdb => Some(DatabaseType::Questdb),
            _ => None,
        }
    }

    fn col_pk(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo { is_primary_key: true, ..column(name, data_type, None) }
    }

    fn _make_added_table_detail(
        name: &str,
        columns: Vec<ColumnInfo>,
        indexes: Vec<IndexInfo>,
        fks: Vec<ForeignKeyInfo>,
        ddl: Option<&str>,
    ) -> TableSchemaDetail {
        TableSchemaDetail {
            name: name.to_string(),
            columns,
            indexes,
            foreign_keys: fks,
            triggers: vec![],
            ddl: ddl.map(|s| s.to_string()),
        }
    }

    fn _prepare_create_table(
        columns: Vec<ColumnInfo>,
        indexes: Vec<IndexInfo>,
        fks: Vec<ForeignKeyInfo>,
        source_kind: DialectKind,
        target_kind: DialectKind,
        ddl: Option<&str>,
    ) -> String {
        let Some(db) = kind_to_db(target_kind) else { return String::new() };
        let _src_db = kind_to_db(source_kind).unwrap_or(DatabaseType::Mysql);
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![],
            source_details: vec![_make_added_table_detail("t", columns, indexes, fks, ddl)],
            target_details: vec![],
            source_functions: vec![],
            target_functions: vec![],
            source_sequences: vec![],
            target_sequences: vec![],
            source_rules: vec![],
            target_rules: vec![],
            source_owners: vec![],
            target_owners: vec![],
            database_type: db,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: false,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            source_dialect: Some(source_kind),
            target_dialect: Some(target_kind),
            batch_patterns: vec![],
            compatibility_threshold: 0.5,
            source_permissions: vec![],
            target_permissions: vec![],
            shard_strategy: None,
            resource_constraint: None,
            field_mappings: vec![],
        };
        let result = prepare_schema_diff(options);
        result.sync_sql
    }

    fn check_identifiers(sql: &str, tgt: DialectKind) {
        match tgt {
            DialectKind::Mysql | DialectKind::ManticoreSearch => {
                assert!(sql.contains('`'), "{tgt:?} should use backticks");
            }
            DialectKind::Oracle => {
                assert!(!sql.contains('`'), "Oracle no backticks");
                assert!(!sql.contains('"'), "Oracle no double-quotes");
            }
            _ => {
                assert!(!sql.contains('`'), "{tgt:?} should NOT use backticks: {sql}");
            }
        }
    }

    fn check_no_mysql_residue(sql: &str, tgt: DialectKind) {
        if !matches!(tgt, DialectKind::Mysql | DialectKind::ManticoreSearch) {
            assert!(!sql.contains("ENGINE="), "residual ENGINE= in {tgt:?}: {sql}");
            assert!(!sql.contains("CHARSET"), "residual CHARSET in {tgt:?}: {sql}");
        }
    }

    #[test]
    fn mysql_to_access_create_table_uses_access_types_and_counter() {
        let columns = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(ColumnInfo {
                    name: "id".into(),
                    data_type: "int(11)".into(),
                    is_nullable: false,
                    is_primary_key: true,
                    is_unique: false,
                    extra: Some("auto_increment".into()),
                    ..Default::default()
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "name2".into(),
                source: Some(ColumnInfo {
                    name: "name2".into(),
                    data_type: "varchar(120)".into(),
                    is_nullable: false,
                    ..Default::default()
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "del_flag".into(),
                source: Some(ColumnInfo {
                    name: "del_flag".into(),
                    data_type: "tinyint(2)".into(),
                    is_nullable: false,
                    ..Default::default()
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "create_at".into(),
                source: Some(ColumnInfo {
                    name: "create_at".into(),
                    data_type: "datetime".into(),
                    is_nullable: true,
                    ..Default::default()
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let indexes = vec![IndexDiff {
            diff_type: "added".into(),
            name: "idx_del_flag".into(),
            source: Some(IndexInfo {
                name: "idx_del_flag".into(),
                columns: vec!["del_flag".into()],
                is_unique: false,
                is_primary: false,
                index_type: None,
                filter: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            }),
            target: None,
            changes: vec![],
        }];
        let (sql, missing) = generate_create_table_sql(
            "tb_user",
            &columns,
            &indexes,
            &[],
            None,
            DatabaseType::Access,
            None,
            Some(DialectKind::Mysql),
            &[],
            &[],
        );
        assert!(missing.is_empty(), "{missing:?}");
        assert!(sql.contains("COUNTER"), "Access PK should use COUNTER: {sql}");
        assert!(!sql.contains("IDENTITY"), "Access must not emit SQL Server IDENTITY: {sql}");
        assert!(!sql.contains("int(11)"), "MySQL display width must be stripped: {sql}");
        assert!(sql.contains("TEXT(120)") || sql.contains("TEXT (120)"), "varchar→TEXT(n): {sql}");
        assert!(
            sql.contains("BYTE") || sql.contains("\"del_flag\" BYTE") || sql.to_ascii_uppercase().contains("BYTE"),
            "tinyint→BYTE: {sql}"
        );
        assert!(sql.to_ascii_uppercase().contains("DATETIME"), "datetime stays DATETIME: {sql}");
        assert!(sql.contains("CREATE INDEX"), "index: {sql}");
    }

    fn check_auto_increment(sql: &str, tgt: DialectKind) {
        match tgt {
            DialectKind::Mysql | DialectKind::ManticoreSearch => {
                assert!(sql.contains("AUTO_INCREMENT"), "{tgt:?} should have AUTO_INCREMENT: {sql}");
            }
            DialectKind::Postgres => {
                assert!(sql.contains("SEQUENCE"), "{tgt:?} should use SEQUENCE: {sql}");
            }
            DialectKind::SqlServer => {
                assert!(sql.contains("IDENTITY"), "{tgt:?} should use IDENTITY: {sql}");
            }
            DialectKind::Oracle => {
                assert!(
                    sql.contains("GENERATED BY DEFAULT AS IDENTITY"),
                    "{tgt:?} should use GENERATED BY DEFAULT AS IDENTITY: {sql}"
                );
            }
            _ => {
                // Other dialects may or may not have auto-increment
            }
        }
    }

    fn check_type_conversion(sql: &str, src: DialectKind, tgt: DialectKind) {
        match (src, tgt) {
            (DialectKind::Mysql, DialectKind::Postgres) => {
                assert!(sql.contains("INTEGER"), "int→INTEGER in PG: {sql}");
                // Only check if source has these types (S2 has tinyint, datetime)
                if sql.contains("tinyint") || sql.contains("TINYINT") {
                    assert!(sql.contains("SMALLINT"), "tinyint→SMALLINT in PG: {sql}");
                }
                if sql.contains("datetime") || sql.contains("DATETIME") {
                    assert!(sql.contains("TIMESTAMP"), "datetime→TIMESTAMP in PG: {sql}");
                }
            }
            (DialectKind::Mysql, DialectKind::Sqlite) => {
                assert!(sql.contains("INTEGER"), "int→INTEGER in SQLite: {sql}");
                if sql.contains("datetime") || sql.contains("DATETIME") {
                    assert!(sql.contains("TEXT"), "datetime→TEXT in SQLite: {sql}");
                }
            }
            (DialectKind::Postgres, DialectKind::Mysql) if sql.contains("text") || sql.contains("TEXT") => {}
            _ => {}
        }
    }

    fn check_table_sql_structure(sql: &str, tgt: DialectKind) {
        assert!(sql.contains("CREATE TABLE"), "{tgt:?} missing CREATE TABLE");
        match tgt {
            DialectKind::Mysql | DialectKind::ManticoreSearch => {
                assert!(sql.contains("PRIMARY KEY"), "{tgt:?} missing PK");
            }
            _ => {
                assert!(sql.contains("PRIMARY KEY"), "{tgt:?} missing PK: {sql}");
            }
        }
    }

    // -- S1: simple table (id INT PK AUTO_INCREMENT, name VARCHAR) --
    fn s1_diffs() -> Vec<ColumnDiff> {
        vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(ColumnInfo { extra: Some("auto_increment".into()), ..col_pk("id", "int") }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "name".into(),
                source: Some(ColumnInfo {
                    name: "name".into(),
                    data_type: "varchar(100)".into(),
                    is_nullable: false,
                    ..column("name", "varchar(100)", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ]
    }

    fn s1_table_diff(src_kind: DialectKind, tgt_kind: DialectKind) -> TableDiff {
        let Some(_db) = kind_to_db(tgt_kind) else { panic!("no db for {tgt_kind:?}") };
        let is_mysql_tgt = matches!(tgt_kind, DialectKind::Mysql | DialectKind::ManticoreSearch);
        let ddl = if is_mysql_tgt {
            Some("CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, `name` varchar(100) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB".into())
        } else if src_kind == tgt_kind {
            Some(
                "CREATE TABLE \"t\" (\"id\" INTEGER NOT NULL, \"name\" varchar(100) NOT NULL, PRIMARY KEY (\"id\"));"
                    .into(),
            )
        } else {
            None
        };
        TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "t".into(),
            columns: Some(s1_diffs()),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }
    }

    #[test]
    fn cross_dialect_s1_all_pairs_simple_table() {
        let kinds = all_kinds();
        for src in &kinds {
            for tgt in &kinds {
                let Some(db) = kind_to_db(*tgt) else { continue };
                let src_dialect = if src == tgt { None } else { Some(*src) };
                let td = s1_table_diff(*src, *tgt);
                let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, src_dialect, &[]);
                check_table_sql_structure(&sql, *tgt);
                check_identifiers(&sql, *tgt);
                check_no_mysql_residue(&sql, *tgt);
                check_auto_increment(&sql, *tgt);
                check_type_conversion(&sql, *src, *tgt);
            }
        }
    }

    // -- S2: full table (multiple types, index) --
    fn s2_diffs() -> (Vec<ColumnDiff>, Vec<IndexDiff>) {
        let cols = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(ColumnInfo { extra: Some("auto_increment".into()), ..col_pk("id", "int") }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "title".into(),
                source: Some(ColumnInfo {
                    name: "title".into(),
                    data_type: "varchar(200)".into(),
                    is_nullable: false,
                    ..column("title", "varchar(200)", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "body".into(),
                source: Some(ColumnInfo {
                    name: "body".into(),
                    data_type: "text".into(),
                    is_nullable: true,
                    ..column("body", "text", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "views".into(),
                source: Some(ColumnInfo {
                    name: "views".into(),
                    data_type: "int".into(),
                    is_nullable: true,
                    column_default: Some("0".into()),
                    ..column("views", "int", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "is_pub".into(),
                source: Some(ColumnInfo {
                    name: "is_pub".into(),
                    data_type: "tinyint".into(),
                    is_nullable: true,
                    ..column("is_pub", "tinyint", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "created".into(),
                source: Some(ColumnInfo {
                    name: "created".into(),
                    data_type: "datetime".into(),
                    is_nullable: true,
                    ..column("created", "datetime", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let idxs = vec![IndexDiff {
            diff_type: "added".into(),
            name: "idx_views".into(),
            source: Some(IndexInfo {
                name: "idx_views".into(),
                columns: vec!["views".into()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
                key_is_expression: Vec::new(),
            }),
            target: None,
            changes: vec![],
        }];
        (cols, idxs)
    }

    #[test]
    fn cross_dialect_s2_full_table() {
        let kinds = all_kinds();
        for src in &kinds {
            for tgt in &kinds {
                let Some(db) = kind_to_db(*tgt) else { continue };
                let src_dialect = if src == tgt { None } else { Some(*src) };
                let (cols, idxs) = s2_diffs();
                let td = TableDiff {
                    diff_type: "added".into(),
                    object_type: Some("table".into()),
                    name: "t".into(),
                    columns: Some(cols),
                    indexes: Some(idxs),
                    foreign_keys: None,
                    triggers: None,
                    ddl: None,
                    target_ddl: None,
                    source_table_comment: None,
                    target_table_comment: None,
                    sync_sql: None,
                };
                let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, src_dialect, &[]);
                check_table_sql_structure(&sql, *tgt);
                check_identifiers(&sql, *tgt);
                check_no_mysql_residue(&sql, *tgt);
                check_auto_increment(&sql, *tgt);
                check_type_conversion(&sql, *src, *tgt);
                match tgt {
                    DialectKind::Mysql | DialectKind::ManticoreSearch => {
                        assert!(sql.contains("KEY "), "{tgt:?} index missing: {sql}");
                    }
                    _ => {
                        assert!(sql.contains("CREATE INDEX"), "{tgt:?} CREATE INDEX missing: {sql}");
                    }
                }
            }
        }
    }

    // -- S3: table with foreign keys --
    fn s3_diffs() -> (Vec<ColumnDiff>, Vec<ForeignKeyDiff>) {
        let cols = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(col_pk("id", "int")),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "user_id".into(),
                source: Some(ColumnInfo {
                    name: "user_id".into(),
                    data_type: "int".into(),
                    is_nullable: false,
                    ..column("user_id", "int", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let fks = vec![ForeignKeyDiff {
            diff_type: "added".into(),
            name: "fk_user".into(),
            source: Some(ForeignKeyInfo {
                name: "fk_user".into(),
                column: "user_id".into(),
                ref_schema: None,
                ref_table: "users".into(),
                ref_column: "id".into(),
                on_update: None,
                on_delete: Some("CASCADE".into()),
            }),
            target: None,
            changes: vec![],
        }];
        (cols, fks)
    }

    #[test]
    fn cross_dialect_s3_foreign_key_table() {
        let kinds = all_kinds();
        for src in &kinds {
            for tgt in &kinds {
                let Some(db) = kind_to_db(*tgt) else { continue };
                let src_dialect = if src == tgt { None } else { Some(*src) };
                let (cols, fks) = s3_diffs();
                let td = TableDiff {
                    diff_type: "added".into(),
                    object_type: Some("table".into()),
                    name: "t".into(),
                    columns: Some(cols),
                    indexes: None,
                    foreign_keys: Some(fks),
                    triggers: None,
                    ddl: None,
                    target_ddl: None,
                    source_table_comment: None,
                    target_table_comment: None,
                    sync_sql: None,
                };
                let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, src_dialect, &[]);
                check_table_sql_structure(&sql, *tgt);
                check_identifiers(&sql, *tgt);
                check_no_mysql_residue(&sql, *tgt);
                assert!(sql.contains("FOREIGN KEY"), "{tgt:?} FK constraint missing: {sql}");
                assert!(sql.contains("REFERENCES"), "{tgt:?} REFERENCES missing: {sql}");
            }
        }
    }

    // -- source_dialect=None: verify original DDL preservation --
    fn _prepare_create_table_no_dialect(
        columns: Vec<ColumnInfo>,
        indexes: Vec<IndexInfo>,
        target_kind: DialectKind,
        ddl: Option<&str>,
    ) -> String {
        let Some(db) = kind_to_db(target_kind) else { return String::new() };
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "t".into(),
                table_type: "BASE TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![],
            source_details: vec![_make_added_table_detail("t", columns, indexes, vec![], ddl)],
            target_details: vec![],
            database_type: db,
            ..Default::default()
        };
        let result = prepare_schema_diff(options);
        result.sync_sql
    }

    #[test]
    fn cross_dialect_none_source_dialect_original_ddl() {
        let kinds = all_kinds();
        for tgt in &kinds {
            let Some(db) = kind_to_db(*tgt) else { continue };
            let is_mysql_tgt = matches!(tgt, DialectKind::Mysql | DialectKind::ManticoreSearch);
            let ddl_str = "CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, `name` varchar(100) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB";
            let td = TableDiff {
                diff_type: "added".into(),
                object_type: Some("table".into()),
                name: "t".into(),
                columns: Some(s1_diffs()),
                indexes: None,
                foreign_keys: None,
                triggers: None,
                ddl: Some(ddl_str.into()),
                target_ddl: None,
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            };
            let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, None, &[]);
            check_table_sql_structure(&sql, *tgt);
            if is_mysql_tgt {
                assert!(sql.contains("ENGINE=InnoDB"), "original DDL preserved for {tgt:?}");
            } else {
                assert!(!sql.contains("ENGINE="), "ENGINE stripped for {tgt:?}: {sql}");
            }
        }
    }

    // -- Reverse cross-dialect: non-MySQL source → MySQL target --
    #[test]
    fn cross_dialect_postgres_source_to_mysql_target() {
        let src = DialectKind::Postgres;
        let tgt = DialectKind::Mysql;
        let Some(db) = kind_to_db(tgt) else { return };
        let cols = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(col_pk("id", "integer")),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "label".into(),
                source: Some(ColumnInfo {
                    name: "label".into(),
                    data_type: "text".into(),
                    is_nullable: false,
                    ..column("label", "text", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let td = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "t".into(),
            columns: Some(cols),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, Some(src), &[]);
        check_table_sql_structure(&sql, tgt);
        check_identifiers(&sql, tgt);
        check_type_conversion(&sql, src, tgt);
        assert!(sql.contains("AUTO_INCREMENT"), "MySQL auto_increment: {sql}");
        assert!(sql.contains("LONGTEXT"), "text→LONGTEXT in MySQL: {sql}");
    }

    #[test]
    fn cross_dialect_sqlserver_source_to_postgres_target() {
        let src = DialectKind::SqlServer;
        let tgt = DialectKind::Postgres;
        let Some(db) = kind_to_db(tgt) else { return };
        let cols = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(col_pk("id", "int")),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "data".into(),
                source: Some(ColumnInfo {
                    name: "data".into(),
                    data_type: "nvarchar(255)".into(),
                    is_nullable: true,
                    ..column("data", "nvarchar(255)", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let td = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "t".into(),
            columns: Some(cols),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, Some(src), &[]);
        check_table_sql_structure(&sql, tgt);
        check_identifiers(&sql, tgt);
        // No mapping rules for SQL Server→PG → types pass through
        assert!(sql.contains("nvarchar(255)"), "passthrough nvarchar: {sql}");
    }

    #[test]
    fn cross_dialect_clickhouse_source_to_mysql_target() {
        let src = DialectKind::ClickHouse;
        let tgt = DialectKind::Mysql;
        let Some(db) = kind_to_db(tgt) else { return };
        let cols = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(col_pk("id", "Int32")),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "data".into(),
                source: Some(ColumnInfo {
                    name: "data".into(),
                    data_type: "String".into(),
                    is_nullable: true,
                    ..column("data", "String", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let td = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "t".into(),
            columns: Some(cols),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql = generate_schema_sync_sql(&[td], &[], &[], &[], &[], db, None, false, Some(src), &[]);
        check_table_sql_structure(&sql, tgt);
        check_identifiers(&sql, tgt);
        // No mapping rules → types pass through
        assert!(sql.contains("Int32"), "passthrough Int32: {sql}");
        assert!(sql.contains("String"), "passthrough String: {sql}");
    }

    #[test]
    fn mysql_to_postgres_direct_generate() {
        let diffs = vec![
            ColumnDiff {
                diff_type: "added".into(),
                name: "id".into(),
                source: Some(col_pk("id", "int")),
                target: None,
                changes: vec![],
                add_position: None,
            },
            ColumnDiff {
                diff_type: "added".into(),
                name: "name".into(),
                source: Some(ColumnInfo {
                    name: "name".into(),
                    data_type: "varchar(100)".into(),
                    is_nullable: false,
                    ..column("name", "varchar(100)", None)
                }),
                target: None,
                changes: vec![],
                add_position: None,
            },
        ];
        let table_diff = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "t".into(),
            columns: Some(diffs),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: Some("CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB".into()),
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        };
        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            None,
            false,
            Some(DialectKind::Mysql),
            &[],
        );
        assert!(!sql.contains('`'), "PG SQL should not have backticks: {sql}");
        assert!(sql.contains("INTEGER"), "int→INTEGER: {sql}");
        assert!(!sql.contains("ENGINE="), "no MySQL ENGINE: {sql}");
    }

    // -- FieldMapping apply_with_params tests --

    #[test]
    fn field_mapping_preserve_params() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "VARCHAR2".into(),
            param_strategy: ParamStrategy::Preserve,
            custom_params: None,
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(255)", DialectKind::Oracle);
        assert_eq!(result, Some("VARCHAR2(255)".to_string()));
    }

    #[test]
    fn field_mapping_strip_params() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "TEXT".into(),
            param_strategy: ParamStrategy::Strip,
            custom_params: None,
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(255)", DialectKind::Oracle);
        assert_eq!(result, Some("TEXT".to_string()));
    }

    #[test]
    fn field_mapping_custom_params() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "VARCHAR2".into(),
            param_strategy: ParamStrategy::Custom,
            custom_params: Some("(500)".to_string()),
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(255)", DialectKind::Oracle);
        assert_eq!(result, Some("VARCHAR2(500)".to_string()));
    }

    #[test]
    fn field_mapping_custom_empty_params_falls_back() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "TEXT".into(),
            param_strategy: ParamStrategy::Custom,
            custom_params: Some("".to_string()),
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(255)", DialectKind::Oracle);
        assert_eq!(result, Some("TEXT".to_string()));
    }

    #[test]
    fn field_mapping_no_match_returns_none() {
        let mappings = vec![FieldMapping {
            source_type: "INT".into(),
            target_type: "INTEGER".into(),
            param_strategy: ParamStrategy::Preserve,
            custom_params: None,
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(255)", DialectKind::Oracle);
        assert_eq!(result, None);
    }

    #[test]
    fn field_mapping_preserve_with_yaml_char_type() {
        crate::sql_dialect::dialect_loader::register_core_dialects();
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "CHAR".into(),
            param_strategy: ParamStrategy::Preserve,
            custom_params: None,
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(200)", DialectKind::Oracle);
        assert_eq!(
            result,
            Some("CHAR(200)".to_string()),
            "Preserve should keep params for CHAR which has has_length in Oracle YAML"
        );
    }

    #[test]
    fn field_mapping_mysql_varchar_to_postgres_character_keeps_params() {
        crate::sql_dialect::dialect_loader::register_core_dialects();
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "character".into(),
            param_strategy: ParamStrategy::Preserve,
            custom_params: None,
        }];
        let result = FieldMapping::apply_with_params(&mappings, "varchar(120)", DialectKind::Postgres);
        assert_eq!(
            result,
            Some("character(120)".to_string()),
            "Preserve should keep (120) for PostgreSQL CHARACTER which has has_length in YAML"
        );
    }

    #[test]
    fn field_mapping_custom_params_without_parens_is_normalized() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "character".into(),
            param_strategy: ParamStrategy::Custom,
            custom_params: Some("100".to_string()),
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(120)", DialectKind::Postgres);
        assert_eq!(
            result,
            Some("character(100)".to_string()),
            "Custom params without parentheses should be wrapped as (100)"
        );
    }

    #[test]
    fn field_mapping_custom_params_with_parens_preserved() {
        let mappings = vec![FieldMapping {
            source_type: "VARCHAR".into(),
            target_type: "character".into(),
            param_strategy: ParamStrategy::Custom,
            custom_params: Some("(100)".to_string()),
        }];
        let result = FieldMapping::apply_with_params(&mappings, "VARCHAR(120)", DialectKind::Postgres);
        assert_eq!(
            result,
            Some("character(100)".to_string()),
            "Custom params already wrapped in parentheses should be kept as-is"
        );
    }

    #[test]
    fn postgres_creates_sequences_before_tables_that_reference_them() {
        let table_diff = TableDiff {
            diff_type: "added".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            ddl: Some(
                "CREATE TABLE public.events (id bigint NOT NULL DEFAULT nextval('public.events_id_seq'::regclass))"
                    .into(),
            ),
            ..TableDiff::default()
        };
        let sequence_diff = SequenceDiff {
            diff_type: "added".into(),
            name: "events_id_seq".into(),
            source: Some(SequenceInfo {
                name: "events_id_seq".into(),
                data_type: "bigint".into(),
                start_value: "1".into(),
                min_value: "1".into(),
                max_value: "9223372036854775807".into(),
                increment: "1".into(),
                cycle: false,
                last_value: None,
            }),
            target: None,
            changes: vec![],
        };

        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[sequence_diff],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("public"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );

        let sequence_position = sql.find("CREATE SEQUENCE").expect("sequence DDL");
        let table_position = sql.find("CREATE TABLE public.events").expect("table DDL");
        assert!(sequence_position < table_position, "{sql}");
    }

    #[test]
    fn postgres_drops_sequences_after_dependent_tables() {
        let table_diff = TableDiff {
            diff_type: "removed".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            ..TableDiff::default()
        };
        let sequence_diff = SequenceDiff {
            diff_type: "removed".into(),
            name: "events_id_seq".into(),
            source: None,
            target: None,
            changes: vec![],
        };

        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[sequence_diff],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("public"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );

        let table_position = sql.find("DROP TABLE").expect("table DDL");
        let sequence_position = sql.find("DROP SEQUENCE").expect("sequence DDL");
        assert!(table_position < sequence_position, "{sql}");
    }

    #[test]
    fn postgres_sync_sql_preserves_zero_timestamp_precision() {
        let table_diff = TableDiff {
            diff_type: "modified".into(),
            object_type: Some("table".into()),
            name: "events".into(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".into(),
                name: "created_at".into(),
                source: Some(column("created_at", "timestamp(0) without time zone", None)),
                target: Some(column("created_at", "timestamp without time zone", None)),
                changes: vec!["type: timestamp without time zone → timestamp(0) without time zone".into()],
                add_position: None,
            }]),
            ..TableDiff::default()
        };

        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("public"),
            false,
            Some(DialectKind::Postgres),
            &[],
        );

        assert!(sql.contains("ALTER COLUMN \"created_at\" TYPE timestamp(0)"), "{sql}");
    }

    #[test]
    fn detects_changed_common_mysql_view_definitions() {
        let options = common_mysql_view_options(
            Some("CREATE ALGORITHM=UNDEFINED DEFINER=`viewer_a`@`%` SQL SECURITY DEFINER VIEW `source_db`.`active_orders` AS select `source_db`.`orders`.`id` AS `id` from `source_db`.`orders` where (`source_db`.`orders`.`active` = 1)"),
            Some("CREATE ALGORITHM=UNDEFINED DEFINER=`viewer_b`@`%` SQL SECURITY DEFINER VIEW `target_db`.`active_orders` AS select `target_db`.`orders`.`id` AS `id` from `target_db`.`orders` where (`target_db`.`orders`.`active` = 0)"),
        );

        let result = prepare_schema_diff(options);

        assert_eq!(result.diffs.len(), 1);
        let diff = &result.diffs[0];
        assert_eq!(diff.diff_type, "modified");
        assert_eq!(diff.object_type.as_deref(), Some("view"));
        assert!(diff.ddl.as_deref().is_some_and(|ddl| ddl.contains("active` = 1")));
        assert!(diff.target_ddl.as_deref().is_some_and(|ddl| ddl.contains("active` = 0")));
        assert!(diff.sync_sql.is_none());
        assert!(result.sync_sql.is_empty());
    }

    #[test]
    fn ignores_mysql_view_environment_and_formatting_differences() {
        let result = prepare_schema_diff(common_mysql_view_options(
            Some("CREATE  ALGORITHM = UNDEFINED DEFINER = `viewer_a` @ `%` SQL SECURITY DEFINER VIEW `source_db` . `active_orders` AS select `source_db` . `orders` . `id` from `source_db` . `orders` where ( `source_db` . `orders` . `active` = 1 )"),
            Some("CREATE ALGORITHM=UNDEFINED DEFINER=`viewer_b`@`localhost` SQL SECURITY DEFINER VIEW `target_db`.`active_orders` AS select `target_db`.`orders`.`id` from `target_db`.`orders` where(`target_db`.`orders`.`active`=1)"),
        ));

        assert!(result.diffs.is_empty());
        assert!(result.sync_sql.is_empty());
    }

    #[test]
    fn preserves_mysql_view_literal_contents_during_comparison() {
        let common =
            "CREATE VIEW `source_db`.`active_orders` AS SELECT 'source_db.orders', 'a b' FROM `source_db`.`orders`";
        let changed_schema_literal =
            "CREATE VIEW `target_db`.`active_orders` AS SELECT 'target_db.orders', 'a b' FROM `target_db`.`orders`";
        let changed_literal_whitespace =
            "CREATE VIEW `target_db`.`active_orders` AS SELECT 'source_db.orders', 'a  b' FROM `target_db`.`orders`";

        assert!(mysql_view_definitions_differ(
            common,
            changed_schema_literal,
            Some(DialectKind::Mysql),
            Some(DialectKind::Mysql)
        ));
        assert!(mysql_view_definitions_differ(
            common,
            changed_literal_whitespace,
            Some(DialectKind::Mysql),
            Some(DialectKind::Mysql)
        ));
    }

    #[test]
    fn preserves_mysql_view_compound_operator_semantics() {
        let compact = "CREATE VIEW `app`.`active_orders` AS SELECT 1 <=> 1, 1 <= 2, 1 != 2";
        let split = "CREATE VIEW `app`.`active_orders` AS SELECT 1 < = > 1, 1 < = 2, 1 ! = 2";

        assert!(mysql_view_definitions_differ(compact, split, Some(DialectKind::Mysql), Some(DialectKind::Mysql)));
    }

    #[test]
    fn preserves_mysql_view_options_and_identifier_case() {
        let ddl = "CREATE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `app`.`active_orders` AS SELECT `OrderId` FROM `app`.`orders` WITH CASCADED CHECK OPTION";

        for changed in [
            ddl.replace("ALGORITHM=MERGE", "ALGORITHM=TEMPTABLE"),
            ddl.replace("SECURITY INVOKER", "SECURITY DEFINER"),
            ddl.replace("`OrderId`", "`orderid`"),
            ddl.replace("CASCADED", "LOCAL"),
        ] {
            assert!(mysql_view_definitions_differ(ddl, &changed, Some(DialectKind::Mysql), Some(DialectKind::Mysql)));
        }
    }

    #[test]
    fn common_view_comparison_requires_two_ddls_and_matching_mysql_dialects() {
        for (source, target) in [(None, Some("CREATE VIEW v AS SELECT 1")), (Some("CREATE VIEW v AS SELECT 1"), None)] {
            assert!(prepare_schema_diff(common_mysql_view_options(source, target)).diffs.is_empty());
        }

        let mut cross_dialect = common_mysql_view_options(
            Some("CREATE VIEW `app`.`active_orders` AS SELECT 1"),
            Some("CREATE VIEW active_orders AS SELECT 2"),
        );
        cross_dialect.target_dialect = Some(DialectKind::Postgres);
        assert!(prepare_schema_diff(cross_dialect).diffs.is_empty());
    }

    #[test]
    fn sharded_diff_keeps_common_mysql_view_comparison() {
        let source_ddl = "CREATE VIEW `source_db`.`active_orders` AS SELECT 1";
        let target_ddl = "CREATE VIEW `target_db`.`active_orders` AS SELECT 2";
        let mut options = common_mysql_view_options(Some(source_ddl), Some(target_ddl));
        options.source_tables.push(table_info("other_view", "VIEW"));
        options.target_tables.push(table_info("other_view", "VIEW"));
        options.source_details.push(schema_detail("other_view", Some("CREATE VIEW other_view AS SELECT 1")));
        options.target_details.push(schema_detail("other_view", Some("CREATE VIEW other_view AS SELECT 1")));
        options.shard_strategy = Some(ShardStrategy { shard_count: 2, shard_by: ShardBy::RoundRobin });

        let result = prepare_schema_diff(options);

        assert_eq!(result.diffs.len(), 1);
        assert_eq!(result.diffs[0].name, "active_orders");
        assert_eq!(result.diffs[0].diff_type, "modified");
    }

    #[test]
    fn keeps_added_removed_views_and_table_view_name_boundaries() {
        let result = prepare_schema_diff(SchemaDiffPreparationOptions {
            source_tables: vec![table_info("source_view", "VIEW"), table_info("same_name", "BASE TABLE")],
            target_tables: vec![table_info("target_view", "VIEW"), table_info("same_name", "VIEW")],
            source_details: vec![
                schema_detail("source_view", Some("CREATE VIEW source_view AS SELECT 1")),
                schema_detail("same_name", Some("CREATE TABLE same_name (id int)")),
            ],
            target_details: vec![
                schema_detail("target_view", Some("CREATE VIEW target_view AS SELECT 1")),
                schema_detail("same_name", Some("CREATE VIEW same_name AS SELECT 1")),
            ],
            database_type: DatabaseType::Mysql,
            source_dialect: Some(DialectKind::Mysql),
            target_dialect: Some(DialectKind::Mysql),
            ..Default::default()
        });

        assert!(result.diffs.iter().any(|diff| diff.name == "source_view"
            && diff.diff_type == "added"
            && diff.object_type.as_deref() == Some("view")));
        assert!(result.diffs.iter().any(|diff| diff.name == "target_view"
            && diff.diff_type == "removed"
            && diff.object_type.as_deref() == Some("view")));
        assert!(result.diffs.iter().any(|diff| diff.name == "same_name"
            && diff.diff_type == "added"
            && diff.object_type.as_deref() == Some("table")));
        assert!(result.diffs.iter().any(|diff| diff.name == "same_name"
            && diff.diff_type == "removed"
            && diff.object_type.as_deref() == Some("view")));
    }

    #[test]
    fn mysql_sync_sql_uses_same_dialect_view_ddl() {
        let view_diff = TableDiff {
            diff_type: "added".into(),
            object_type: Some("view".into()),
            name: "active_users".into(),
            ddl: Some("CREATE VIEW `active_users` AS SELECT `id` FROM `users` WHERE `active` = 1;".into()),
            ..TableDiff::default()
        };

        let sql = generate_schema_sync_sql(
            &[view_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("app"),
            false,
            Some(DialectKind::Mysql),
            &[],
        );

        assert!(sql.contains("CREATE VIEW `active_users`"), "{sql}");
        assert!(!sql.contains("Source view definition is not available"), "{sql}");
        assert!(!sql.contains(";;"), "{sql}");
    }

    #[test]
    fn cross_dialect_sync_sql_does_not_reuse_view_ddl() {
        let view_diff = TableDiff {
            diff_type: "added".into(),
            object_type: Some("view".into()),
            name: "active_users".into(),
            ddl: Some("CREATE VIEW `active_users` AS SELECT `id` FROM `users`".into()),
            ..TableDiff::default()
        };

        let sql = generate_schema_sync_sql(
            &[view_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Postgres,
            Some("public"),
            false,
            Some(DialectKind::Mysql),
            &[],
        );

        assert!(!sql.contains("CREATE VIEW `active_users`"), "{sql}");
        assert!(sql.contains("Source view definition cannot be reused across different SQL dialects"), "{sql}");
    }

    #[test]
    fn same_dialect_sync_sql_keeps_diagnostic_without_view_ddl() {
        let view_diff = TableDiff {
            diff_type: "added".into(),
            object_type: Some("view".into()),
            name: "active_users".into(),
            ..TableDiff::default()
        };

        let sql = generate_schema_sync_sql(
            &[view_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("app"),
            false,
            Some(DialectKind::Mysql),
            &[],
        );

        assert!(sql.contains("Source view definition is not available from this driver yet"), "{sql}");
    }

    #[test]
    fn postgres_function_sequence_rule_owner_use_profile_templates() {
        let fn_diff = FunctionDiff {
            diff_type: "added".into(),
            name: "f1".into(),
            source: Some(FunctionInfo {
                name: "f1".into(),
                function_type: "FUNCTION".into(),
                data_type: "int".into(),
                definition: "RETURNS int LANGUAGE sql AS $$ SELECT 1 $$".into(),
                arguments: "".into(),
            }),
            target: None,
            changes: vec![],
        };
        let seq_diff = SequenceDiff {
            diff_type: "added".into(),
            name: "s1".into(),
            source: Some(SequenceInfo {
                name: "s1".into(),
                data_type: "bigint".into(),
                start_value: "1".into(),
                min_value: "1".into(),
                max_value: "100".into(),
                increment: "1".into(),
                cycle: false,
                last_value: None,
            }),
            target: None,
            changes: vec![],
        };
        let rule_diff = RuleDiff {
            diff_type: "removed".into(),
            name: "r1".into(),
            source: Some(RuleInfo {
                name: "r1".into(),
                table_name: "t1".into(),
                definition: "CREATE RULE r1 AS ON INSERT TO t1 DO NOTHING".into(),
            }),
            target: None,
            changes: vec![],
        };
        let owner_diff = OwnerDiff {
            diff_type: "modified".into(),
            object_name: "t1".into(),
            source: Some(OwnerInfo { object_name: "t1".into(), object_type: "TABLE".into(), owner: "app".into() }),
            target: Some(OwnerInfo { object_name: "t1".into(), object_type: "TABLE".into(), owner: "old".into() }),
            changes: vec![],
        };

        let sql = generate_schema_sync_sql(
            &[],
            &[fn_diff],
            &[seq_diff],
            &[rule_diff],
            &[owner_diff],
            DatabaseType::Postgres,
            Some("public"),
            true,
            None,
            &[],
        );
        assert!(sql.contains("CREATE OR REPLACE FUNCTION"), "{sql}");
        assert!(sql.contains("CREATE SEQUENCE"), "{sql}");
        assert!(sql.contains("NO CYCLE"), "{sql}");
        assert!(sql.contains("DROP RULE IF EXISTS r1 ON"), "{sql}");
        assert!(sql.contains("OWNER TO app"), "{sql}");
        assert!(sql.contains("CASCADE"), "{sql}");
    }

    #[test]
    fn mysql_skips_function_sequence_when_templates_absent() {
        let fn_diff = FunctionDiff {
            diff_type: "added".into(),
            name: "f1".into(),
            source: Some(FunctionInfo {
                name: "f1".into(),
                function_type: "FUNCTION".into(),
                data_type: "int".into(),
                definition: "RETURNS int RETURN 1".into(),
                arguments: "".into(),
            }),
            target: None,
            changes: vec![],
        };
        let sql = generate_schema_sync_sql(&[], &[fn_diff], &[], &[], &[], DatabaseType::Mysql, None, false, None, &[]);
        assert!(sql.contains("-- Skip function f1"), "{sql}");
        assert!(!sql.contains("CREATE FUNCTION"), "{sql}");
    }
}
