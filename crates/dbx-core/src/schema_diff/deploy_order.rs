use std::collections::{HashMap, HashSet};

use regex::Regex;

use super::{
    extract_ddl_references, DeployObjectKind, DeployObjectRef, FunctionDiff, OwnerDiff, RuleDiff, SequenceDiff,
    TableDiff, TableSchemaDetail,
};

#[derive(Debug, Clone, Default)]
pub struct DeployGraph {
    nodes: HashSet<DeployObjectRef>,
    edges: HashMap<DeployObjectRef, Vec<DeployObjectRef>>,
    name_index: HashMap<(DeployObjectKind, String), Vec<DeployObjectRef>>,
}

impl DeployGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: DeployObjectRef) {
        if self.nodes.insert(node.clone()) {
            self.name_index.entry((node.kind, node.name.clone())).or_default().push(node);
        }
    }

    pub fn add_edge(&mut self, from: DeployObjectRef, to: DeployObjectRef) {
        if from == to {
            return;
        }
        self.edges.entry(from).or_default().push(to);
    }

    fn node_cmp(a: &DeployObjectRef, b: &DeployObjectRef) -> std::cmp::Ordering {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.arguments.as_deref().unwrap_or("").cmp(b.arguments.as_deref().unwrap_or("")))
    }

    /// Return a topological order of all nodes. Nodes with no dependencies are
    /// emitted first, breaking ties deterministically by (kind, name, arguments).
    /// Cycles are broken by appending remaining nodes in sorted order.
    pub fn topological_order(&self) -> Vec<DeployObjectRef> {
        let mut in_degree: HashMap<DeployObjectRef, usize> = self.nodes.iter().map(|n| (n.clone(), 0)).collect();
        for (from, to_list) in &self.edges {
            if !self.nodes.contains(from) {
                continue;
            }
            for to in to_list {
                if let Some(deg) = in_degree.get_mut(to) {
                    *deg += 1;
                }
            }
        }

        let mut ready: Vec<DeployObjectRef> =
            in_degree.iter().filter(|(_, d)| **d == 0).map(|(n, _)| n.clone()).collect();
        ready.sort_by(Self::node_cmp);

        let mut result = Vec::new();
        let mut consumed = HashSet::new();

        while !ready.is_empty() {
            let node = ready.remove(0);
            if !consumed.insert(node.clone()) {
                continue;
            }
            result.push(node.clone());

            if let Some(deps) = self.edges.get(&node) {
                let mut newly_ready = Vec::new();
                for dep in deps {
                    if let Some(deg) = in_degree.get_mut(dep) {
                        *deg = deg.saturating_sub(1);
                        if *deg == 0 {
                            newly_ready.push(dep.clone());
                        }
                    }
                }
                if !newly_ready.is_empty() {
                    ready.extend(newly_ready);
                    ready.sort_by(Self::node_cmp);
                }
            }
        }

        if result.len() != self.nodes.len() {
            let mut remaining: Vec<DeployObjectRef> =
                self.nodes.iter().filter(|n| !consumed.contains(n)).cloned().collect();
            remaining.sort_by(Self::node_cmp);
            result.extend(remaining);
        }

        result
    }

    /// Reverse topological order, suitable for dropping objects.
    pub fn reverse_order(&self) -> Vec<DeployObjectRef> {
        self.topological_order().into_iter().rev().collect()
    }
}

fn unqualified_name(name: &str) -> String {
    let s = name.trim();
    let s = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') { &s[1..s.len() - 1] } else { s };
    s.split('.').next_back().map(|part| part.trim_matches('"').to_string()).unwrap_or_else(|| s.to_string())
}

fn sequence_refs(sql: &str) -> Vec<String> {
    let re = Regex::new(r#"(?i)nextval\s*\(\s*(?:'([^']*)'|"([^"]*)")[^)]*\)"#).unwrap();
    re.captures_iter(sql).filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| unqualified_name(m.as_str()))).collect()
}

fn trigger_function_refs(sql: &str) -> Vec<String> {
    let re = Regex::new(r#"(?i)EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([^\s(]+)"#).unwrap();
    re.captures_iter(sql).filter_map(|c| c.get(1).map(|m| unqualified_name(m.as_str()))).collect()
}

fn object_kind_for_name(name: &str, diffs: &[TableDiff]) -> DeployObjectKind {
    if diffs.iter().any(|d| d.name == name && d.object_type.as_deref() == Some("view")) {
        DeployObjectKind::View
    } else {
        DeployObjectKind::Table
    }
}

fn owner_object_kind(object_type: &str) -> Option<DeployObjectKind> {
    match object_type.to_uppercase().as_str() {
        "TABLE" => Some(DeployObjectKind::Table),
        "VIEW" => Some(DeployObjectKind::View),
        "SEQUENCE" => Some(DeployObjectKind::Sequence),
        "FUNCTION" => Some(DeployObjectKind::Function),
        _ => None,
    }
}

pub(crate) fn table_diff_ref(diff: &TableDiff) -> DeployObjectRef {
    let kind =
        if diff.object_type.as_deref() == Some("view") { DeployObjectKind::View } else { DeployObjectKind::Table };
    DeployObjectRef { kind, name: diff.name.clone(), arguments: None }
}

pub(crate) fn function_diff_ref(diff: &FunctionDiff) -> DeployObjectRef {
    let arguments = diff.source.as_ref().or(diff.target.as_ref()).map(|f| f.arguments.clone());
    DeployObjectRef { kind: DeployObjectKind::Function, name: diff.name.clone(), arguments }
}

pub(crate) fn sequence_diff_ref(diff: &SequenceDiff) -> DeployObjectRef {
    DeployObjectRef { kind: DeployObjectKind::Sequence, name: diff.name.clone(), arguments: None }
}

pub(crate) fn rule_diff_ref(diff: &RuleDiff) -> DeployObjectRef {
    DeployObjectRef { kind: DeployObjectKind::Rule, name: diff.name.clone(), arguments: None }
}

pub(crate) fn owner_diff_ref(diff: &OwnerDiff) -> DeployObjectRef {
    DeployObjectRef { kind: DeployObjectKind::Owner, name: diff.object_name.clone(), arguments: None }
}

/// Build a dependency graph for the objects that appear in the given diff arrays.
/// `details` should be the source or target side that matches the deploy direction
/// (source for create/alter, target for drop).
pub(crate) fn build_deploy_graph(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    details: &[TableSchemaDetail],
) -> DeployGraph {
    let mut graph = DeployGraph::new();
    let detail_map: HashMap<&str, &TableSchemaDetail> = details.iter().map(|d| (d.name.as_str(), d)).collect();

    for diff in diffs {
        graph.add_node(table_diff_ref(diff));
    }
    for diff in function_diffs {
        graph.add_node(function_diff_ref(diff));
    }
    for diff in sequence_diffs {
        graph.add_node(sequence_diff_ref(diff));
    }
    for diff in rule_diffs {
        graph.add_node(rule_diff_ref(diff));
    }
    for diff in owner_diffs {
        graph.add_node(owner_diff_ref(diff));
    }

    let known_names: HashSet<&str> = diffs.iter().map(|d| d.name.as_str()).collect();

    for diff in diffs {
        let from = table_diff_ref(diff);
        if let Some(detail) = detail_map.get(diff.name.as_str()) {
            for fk in &detail.foreign_keys {
                let to_kind = object_kind_for_name(&fk.ref_table, diffs);
                let to = DeployObjectRef { kind: to_kind, name: fk.ref_table.clone(), arguments: None };
                graph.add_edge(to, from.clone());
            }

            for col in &detail.columns {
                if let Some(default) = &col.column_default {
                    for seq_name in sequence_refs(default) {
                        let to = DeployObjectRef { kind: DeployObjectKind::Sequence, name: seq_name, arguments: None };
                        graph.add_edge(to, from.clone());
                    }
                }
            }

            for trigger in &detail.triggers {
                if let Some(stmt) = &trigger.statement {
                    for fn_name in trigger_function_refs(stmt) {
                        if let Some(matches) = graph.name_index.get(&(DeployObjectKind::Function, fn_name.clone())) {
                            for to in matches.clone() {
                                graph.add_edge(to, from.clone());
                            }
                        }
                    }
                }
            }

            if diff.object_type.as_deref() == Some("view") {
                if let Some(ddl) = &detail.ddl {
                    for ref_table in extract_ddl_references(ddl, &known_names) {
                        let to_kind = object_kind_for_name(&ref_table, diffs);
                        let to = DeployObjectRef { kind: to_kind, name: ref_table, arguments: None };
                        graph.add_edge(to, from.clone());
                    }
                }
            }
        }
    }

    for diff in rule_diffs {
        let from = rule_diff_ref(diff);
        let table_name = diff.source.as_ref().or(diff.target.as_ref()).map(|r| r.table_name.clone());
        if let Some(table_name) = table_name {
            let to = DeployObjectRef { kind: DeployObjectKind::Table, name: table_name, arguments: None };
            graph.add_edge(to, from);
        }
    }

    for diff in owner_diffs {
        let from = owner_diff_ref(diff);
        let owner = diff.source.as_ref().or(diff.target.as_ref());
        if let Some(owner) = owner {
            if let Some(kind) = owner_object_kind(&owner.object_type) {
                let to = DeployObjectRef { kind, name: owner.object_name.clone(), arguments: None };
                graph.add_edge(to, from);
            }
        }
    }

    graph
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::*;
    use crate::types::{ColumnInfo, ForeignKeyInfo, FunctionInfo, OwnerInfo, RuleInfo, SequenceInfo, TriggerInfo};

    fn column(name: &str, data_type: &str, default: Option<&str>) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: false,
            column_default: default.map(|s| s.to_string()),
            is_primary_key: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }
    }

    fn table_diff(
        name: &str,
        diff_type: &str,
        object_type: Option<&str>,
        columns: Option<Vec<ColumnDiff>>,
        foreign_keys: Option<Vec<ForeignKeyDiff>>,
        triggers: Option<Vec<TriggerDiff>>,
    ) -> TableDiff {
        TableDiff {
            diff_type: diff_type.to_string(),
            object_type: object_type.map(|s| s.to_string()),
            name: name.to_string(),
            columns,
            indexes: None,
            foreign_keys,
            triggers,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        }
    }

    fn table_detail(
        name: &str,
        columns: Vec<ColumnInfo>,
        fks: Vec<ForeignKeyInfo>,
        triggers: Vec<TriggerInfo>,
    ) -> TableSchemaDetail {
        TableSchemaDetail { name: name.to_string(), columns, indexes: vec![], foreign_keys: fks, triggers, ddl: None }
    }

    fn sequence_diff(name: &str, diff_type: &str) -> SequenceDiff {
        SequenceDiff {
            diff_type: diff_type.to_string(),
            name: name.to_string(),
            source: Some(SequenceInfo {
                name: name.to_string(),
                data_type: "integer".to_string(),
                start_value: "1".to_string(),
                min_value: "1".to_string(),
                max_value: "2147483647".to_string(),
                increment: "1".to_string(),
                cycle: false,
                last_value: None,
            }),
            target: None,
            changes: vec![],
        }
    }

    fn function_diff(name: &str, diff_type: &str) -> FunctionDiff {
        FunctionDiff {
            diff_type: diff_type.to_string(),
            name: name.to_string(),
            source: Some(FunctionInfo {
                name: name.to_string(),
                function_type: "FUNCTION".to_string(),
                data_type: "void".to_string(),
                definition: "BEGIN RETURN; END;".to_string(),
                arguments: "()".to_string(),
            }),
            target: None,
            changes: vec![],
        }
    }

    fn owner_diff(object_name: &str, object_type: &str) -> OwnerDiff {
        OwnerDiff {
            diff_type: "modified".to_string(),
            object_name: object_name.to_string(),
            source: Some(OwnerInfo {
                object_name: object_name.to_string(),
                object_type: object_type.to_string(),
                owner: "new_owner".to_string(),
            }),
            target: Some(OwnerInfo {
                object_name: object_name.to_string(),
                object_type: object_type.to_string(),
                owner: "old_owner".to_string(),
            }),
            changes: vec!["owner: old_owner → new_owner".to_string()],
        }
    }

    fn rule_diff(name: &str, table_name: &str, diff_type: &str) -> RuleDiff {
        RuleDiff {
            diff_type: diff_type.to_string(),
            name: name.to_string(),
            source: Some(RuleInfo {
                name: name.to_string(),
                table_name: table_name.to_string(),
                definition: "CREATE RULE ...".to_string(),
            }),
            target: None,
            changes: vec![],
        }
    }

    #[test]
    fn sequence_create_comes_before_table_create() {
        let seq = sequence_diff("user_id_seq", "added");
        let col = ColumnDiff {
            diff_type: "added".to_string(),
            name: "id".to_string(),
            source: Some(column("id", "integer", Some("nextval('user_id_seq'::regclass)"))),
            target: None,
            changes: vec![],
        };
        let table = table_diff("users", "added", None, Some(vec![col.clone()]), None, None);
        let detail = table_detail(
            "users",
            vec![column("id", "integer", Some("nextval('user_id_seq'::regclass)"))],
            vec![],
            vec![],
        );
        let graph = build_deploy_graph(&[table], &[], &[seq], &[], &[], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Sequence);
        assert_eq!(order[0].name, "user_id_seq");
        assert_eq!(order[1].kind, DeployObjectKind::Table);
        assert_eq!(order[1].name, "users");
    }

    #[test]
    fn drop_table_comes_before_sequence_drop() {
        let seq = sequence_diff("user_id_seq", "removed");
        let col = ColumnDiff {
            diff_type: "added".to_string(),
            name: "id".to_string(),
            source: Some(column("id", "integer", Some("nextval('user_id_seq'::regclass)"))),
            target: None,
            changes: vec![],
        };
        let table = table_diff("users", "removed", None, Some(vec![col]), None, None);
        let detail = table_detail(
            "users",
            vec![column("id", "integer", Some("nextval('user_id_seq'::regclass)"))],
            vec![],
            vec![],
        );
        let graph = build_deploy_graph(&[table], &[], &[seq], &[], &[], &[detail]);
        let order = graph.reverse_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Table);
        assert_eq!(order[0].name, "users");
        assert_eq!(order[1].kind, DeployObjectKind::Sequence);
        assert_eq!(order[1].name, "user_id_seq");
    }

    #[test]
    fn function_create_comes_before_table_with_trigger() {
        let func = function_diff("notify_func", "added");
        let trigger = TriggerDiff {
            diff_type: "added".to_string(),
            name: "trg_users".to_string(),
            source: Some(TriggerInfo {
                name: "trg_users".to_string(),
                event: "INSERT".to_string(),
                timing: "BEFORE".to_string(),
                statement: Some("EXECUTE FUNCTION notify_func()".to_string()),
            }),
            target: None,
            changes: vec![],
        };
        let table = table_diff("users", "added", None, None, None, Some(vec![trigger]));
        let detail = table_detail(
            "users",
            vec![],
            vec![],
            vec![TriggerInfo {
                name: "trg_users".to_string(),
                event: "INSERT".to_string(),
                timing: "BEFORE".to_string(),
                statement: Some("EXECUTE FUNCTION notify_func()".to_string()),
            }],
        );
        let graph = build_deploy_graph(&[table], &[func], &[], &[], &[], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Function);
        assert_eq!(order[0].name, "notify_func");
        assert_eq!(order[1].kind, DeployObjectKind::Table);
        assert_eq!(order[1].name, "users");
    }

    #[test]
    fn owner_change_follows_table_create() {
        let table = table_diff("users", "added", None, None, None, None);
        let owner = owner_diff("users", "TABLE");
        let detail = table_detail("users", vec![], vec![], vec![]);
        let graph = build_deploy_graph(&[table], &[], &[], &[], &[owner], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Table);
        assert_eq!(order[0].name, "users");
        assert_eq!(order[1].kind, DeployObjectKind::Owner);
        assert_eq!(order[1].name, "users");
    }

    #[test]
    fn foreign_key_orders_referenced_table_first() {
        let users = table_diff("users", "added", None, None, None, None);
        let orders = table_diff(
            "orders",
            "added",
            None,
            Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "user_id".to_string(),
                source: Some(column("user_id", "integer", None)),
                target: None,
                changes: vec![],
            }]),
            Some(vec![ForeignKeyDiff {
                diff_type: "added".to_string(),
                name: "orders_user_id_fk".to_string(),
                source: Some(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: "user_id".to_string(),
                    ref_schema: None,
                    ref_table: "users".to_string(),
                    ref_column: "id".to_string(),
                    on_update: None,
                    on_delete: None,
                }),
                target: None,
                changes: vec![],
            }]),
            None,
        );
        let detail = table_detail(
            "orders",
            vec![column("user_id", "integer", None)],
            vec![ForeignKeyInfo {
                name: "orders_user_id_fk".to_string(),
                column: "user_id".to_string(),
                ref_schema: None,
                ref_table: "users".to_string(),
                ref_column: "id".to_string(),
                on_update: None,
                on_delete: None,
            }],
            vec![],
        );
        let graph = build_deploy_graph(&[users, orders], &[], &[], &[], &[], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].name, "users");
        assert_eq!(order[1].name, "orders");
    }

    #[test]
    fn rule_drop_comes_before_table_drop() {
        let rule = rule_diff("rule_users", "users", "removed");
        let table = table_diff("users", "removed", None, None, None, None);
        let detail = table_detail("users", vec![], vec![], vec![]);
        let graph = build_deploy_graph(&[table], &[], &[], &[rule], &[], &[detail]);
        let order = graph.reverse_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Rule);
        assert_eq!(order[0].name, "rule_users");
        assert_eq!(order[1].kind, DeployObjectKind::Table);
        assert_eq!(order[1].name, "users");
    }

    #[test]
    fn sequence_create_comes_before_table_with_qualified_nextval() {
        let seq = sequence_diff("service_card_record_id_seq", "added");
        let col = ColumnDiff {
            diff_type: "added".to_string(),
            name: "id".to_string(),
            source: Some(column("id", "integer", Some("nextval('wcz.service_card_record_id_seq'::regclass)"))),
            target: None,
            changes: vec![],
        };
        let table = table_diff("service_card_record", "added", None, Some(vec![col.clone()]), None, None);
        let detail = table_detail(
            "service_card_record",
            vec![column("id", "integer", Some("nextval('wcz.service_card_record_id_seq'::regclass)"))],
            vec![],
            vec![],
        );
        let graph = build_deploy_graph(&[table], &[], &[seq], &[], &[], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Sequence);
        assert_eq!(order[0].name, "service_card_record_id_seq");
        assert_eq!(order[1].kind, DeployObjectKind::Table);
        assert_eq!(order[1].name, "service_card_record");
    }

    #[test]
    fn sequence_create_comes_before_table_with_double_quoted_nextval() {
        let seq = sequence_diff("service_card_record_id_seq", "added");
        let col = ColumnDiff {
            diff_type: "added".to_string(),
            name: "id".to_string(),
            source: Some(column("id", "integer", Some(r#"nextval('"wcz"."service_card_record_id_seq"'::regclass)"#))),
            target: None,
            changes: vec![],
        };
        let table = table_diff("service_card_record", "added", None, Some(vec![col.clone()]), None, None);
        let detail = table_detail(
            "service_card_record",
            vec![column("id", "integer", Some(r#"nextval('"wcz"."service_card_record_id_seq"'::regclass)"#))],
            vec![],
            vec![],
        );
        let graph = build_deploy_graph(&[table], &[], &[seq], &[], &[], &[detail]);
        let order = graph.topological_order();
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].kind, DeployObjectKind::Sequence);
        assert_eq!(order[0].name, "service_card_record_id_seq");
        assert_eq!(order[1].kind, DeployObjectKind::Table);
        assert_eq!(order[1].name, "service_card_record");
    }
}
