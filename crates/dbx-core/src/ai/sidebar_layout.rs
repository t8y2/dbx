//! Pure validation and mutation of persisted sidebar trees.
use std::collections::HashSet;

use serde_json::{json, Value};

pub struct SidebarGroupSpec {
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug)]
pub struct SidebarGroupInfo {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub connection_ids: Vec<String>,
}

#[derive(Debug)]
pub struct SidebarSummary {
    pub groups: Vec<SidebarGroupInfo>,
    pub ungrouped: Vec<String>,
}

fn invalid(message: &str) -> String {
    format!("INVALID_SIDEBAR_LAYOUT: {message}")
}

fn request_error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

fn dedup(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(id.clone())).collect()
}

fn initial(layout: Option<&Value>) -> Result<Value, String> {
    let mut value = layout.filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!({}));
    let object = value.as_object_mut().ok_or_else(|| invalid("expected an object"))?;
    object.entry("groups").or_insert_with(|| json!([]));
    object.entry("order").or_insert_with(|| json!([]));
    Ok(value)
}

pub fn describe_layout(layout: Option<&Value>) -> Result<SidebarSummary, String> {
    let layout = initial(layout)?;
    let metadata = layout["groups"].as_array().ok_or_else(|| invalid("groups must be an array"))?;
    let mut groups: Vec<SidebarGroupInfo> = Vec::new();
    for group in metadata {
        let id = group["id"].as_str().ok_or_else(|| invalid("group id must be a string"))?;
        let name = group["name"].as_str().ok_or_else(|| invalid("group name must be a string"))?;
        let collapsed = match group.get("collapsed") {
            None => false,
            Some(value) => value.as_bool().ok_or_else(|| invalid("collapsed must be a boolean"))?,
        };
        let info = SidebarGroupInfo { id: id.into(), name: name.into(), collapsed, connection_ids: Vec::new() };
        // The policy resolver collects group metadata into a HashMap, so a stray
        // duplicate id is last-wins there. Matching that keeps a malformed import
        // from failing only in the tools that list groups.
        match groups.iter_mut().find(|group| group.id == id) {
            Some(existing) => *existing = info,
            None => groups.push(info),
        }
    }
    let mut seen = HashSet::new();
    let ungrouped = inspect_entries(&layout["order"], &mut groups, &mut seen, true)?;
    Ok(SidebarSummary { groups, ungrouped })
}

fn inspect_entries(
    entries: &Value,
    groups: &mut [SidebarGroupInfo],
    seen: &mut HashSet<String>,
    root: bool,
) -> Result<Vec<String>, String> {
    let entries = entries.as_array().ok_or_else(|| invalid("order/children must be arrays"))?;
    let mut connections = Vec::new();
    for entry in entries {
        let id = entry["id"].as_str().ok_or_else(|| invalid("entry id must be a string"))?;
        match entry["type"].as_str() {
            Some("connection") => connections.push(id.to_string()),
            Some("group") => {
                let index = groups
                    .iter()
                    .position(|group| group.id == id)
                    // The id is not echoed: it may belong to a group the MCP policy hides.
                    .ok_or_else(|| invalid("order entry references a group without metadata"))?;
                if !seen.insert(id.to_string()) {
                    return Err(invalid("duplicate group order id"));
                }
                // The desktop app and the MCP policy both read `children` first and only fall back
                // to the legacy `connectionIds` when no children exist, so the read path does the
                // same; keeping both in sync is what makes a later move predictable.
                let legacy = entry
                    .get("connectionIds")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_array()
                            .ok_or_else(|| invalid("connectionIds must be an array"))?
                            .iter()
                            .map(|id| {
                                id.as_str()
                                    .map(str::to_string)
                                    .ok_or_else(|| invalid("connectionIds must contain strings"))
                            })
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                // `children: null` is what the desktop treats as "no children yet" (it
                // falls back with `??`), so it must not fail validation here.
                let members = match entry.get("children") {
                    Some(children) if !children.is_null() => inspect_entries(children, groups, seen, false)?,
                    _ => dedup(legacy),
                };
                groups[index].connection_ids = members.clone();
                if !root {
                    connections.extend(members);
                }
            }
            _ => return Err(invalid("unknown entry type")),
        }
    }
    Ok(connections)
}

/// Move connections and return the updated layout.
/// An explicit unknown group ID is rejected, even when a name is provided.
pub fn move_connections_in_layout(
    layout: Option<&Value>,
    spec: &SidebarGroupSpec,
    connection_ids: &[String],
) -> Result<Value, String> {
    let ids = dedup(connection_ids.to_vec());
    if ids.is_empty() {
        return Err(request_error("INVALID_GROUP_REQUEST", "connection_ids must not be empty"));
    }
    let summary = describe_layout(layout)?;
    let name = spec.name.as_deref().map(str::trim).filter(|name| !name.is_empty());
    let by_id = spec.id.as_ref().and_then(|id| summary.groups.iter().find(|group| &group.id == id));
    if let (Some(id), None) = (spec.id.as_ref(), by_id) {
        return Err(request_error("UNKNOWN_GROUP_ID", &format!("unknown group id '{id}'")));
    }
    let name_matches = name
        .map(|name| {
            summary.groups.iter().filter(|group| group.name.trim().eq_ignore_ascii_case(name)).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let target = match by_id {
        Some(group) => {
            if !name_matches.is_empty() && !name_matches.iter().any(|matched| matched.id == group.id) {
                return Err(request_error("INVALID_GROUP_REQUEST", "group id and name resolve to different groups"));
            }
            Some(group)
        }
        None => match name_matches.len() {
            0 => None,
            1 => Some(name_matches[0]),
            matches => {
                let name = name.unwrap_or_default();
                return Err(request_error(
                    "AMBIGUOUS_GROUP_NAME",
                    &format!("group name '{name}' matches {matches} groups; pass group id"),
                ));
            }
        },
    };
    let mut layout = initial(layout)?;
    let id = if let Some(group) = target {
        // The desktop app expands a collapsed group when connections land in it.
        // Duplicate metadata is last-wins, so every entry for the id is expanded;
        // otherwise the effective (last) one would stay collapsed after a move.
        if let Some(groups) = layout["groups"].as_array_mut() {
            for entry in groups.iter_mut().filter(|entry| entry["id"].as_str() == Some(group.id.as_str())) {
                entry["collapsed"] = json!(false);
            }
        }
        group.id.clone()
    } else {
        let name =
            name.ok_or_else(|| request_error("INVALID_GROUP_REQUEST", "group name is required to create a group"))?;
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(groups) = layout["groups"].as_array_mut() {
            groups.push(json!({"id":id,"name":name,"collapsed":false}));
        }
        id
    };
    let order = layout["order"].as_array_mut().ok_or_else(|| invalid("order must be an array"))?;
    remove_connections(order, &ids);
    if !append_to_group(order, &id, &ids) {
        order.push(json!({"type":"group","id":id,"children":ids.iter().map(|id| json!({"type":"connection","id":id})).collect::<Vec<_>>()}));
    }
    Ok(layout)
}

fn remove_connections(entries: &mut Vec<Value>, ids: &[String]) {
    entries.retain(|entry| {
        !(entry["type"] == "connection" && entry["id"].as_str().is_some_and(|id| ids.iter().any(|moved| moved == id)))
    });
    for entry in entries {
        if let Some(children) = entry.get_mut("children").and_then(Value::as_array_mut) {
            remove_connections(children, ids);
        }
        if let Some(legacy) = entry.get_mut("connectionIds").and_then(Value::as_array_mut) {
            legacy.retain(|id| !ids.iter().any(|moved| id.as_str() == Some(moved.as_str())));
        }
    }
}

fn collect_connection_ids(entries: &[Value], ids: &mut HashSet<String>) {
    for entry in entries {
        if entry["type"] == "connection" {
            if let Some(id) = entry["id"].as_str() {
                ids.insert(id.to_string());
            }
        }
        if let Some(children) = entry.get("children").and_then(Value::as_array) {
            collect_connection_ids(children, ids);
        } else if let Some(legacy) = entry.get("connectionIds").and_then(Value::as_array) {
            ids.extend(legacy.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }
}

fn append_to_group(entries: &mut [Value], target: &str, ids: &[String]) -> bool {
    for entry in entries {
        if entry["type"] == "group" && entry["id"].as_str() == Some(target) {
            let legacy = entry.as_object_mut().and_then(|entry| entry.remove("connectionIds"));
            // `children: null` means "no children yet" to the desktop, so the legacy
            // members must still be migrated and the moved ids appended.
            if entry.get("children").map_or(true, Value::is_null) {
                // No modern children yet: the legacy list is the only record of the members.
                let members = dedup(
                    legacy
                        .and_then(|value| value.as_array().cloned())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                );
                entry["children"] =
                    json!(members.iter().map(|id| json!({"type":"connection","id":id})).collect::<Vec<_>>());
            }
            // A stale `connectionIds` next to modern children is dropped: the desktop app ignores it.
            if let Some(children) = entry["children"].as_array_mut() {
                let mut existing = HashSet::new();
                collect_connection_ids(children, &mut existing);
                for id in ids {
                    if existing.insert(id.clone()) {
                        children.push(json!({"type":"connection","id":id}));
                    }
                }
            }
            return true;
        }
        if let Some(children) = entry.get_mut("children").and_then(Value::as_array_mut) {
            if append_to_group(children, target, ids) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn move_to(layout: Option<&Value>, name: &str, ids: &[&str]) -> Value {
        move_connections_in_layout(
            layout,
            &SidebarGroupSpec { id: None, name: Some(name.into()) },
            &ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
        )
        .unwrap()
    }

    #[test]
    fn creates_group_and_deduplicates_idempotently() {
        let layout = move_to(None, " Project ", &["c1", "c1"]);
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups[0].name, "Project");
        assert_eq!(summary.groups[0].connection_ids, ["c1"]);
        assert!(!summary.groups[0].collapsed);
        assert!(uuid::Uuid::parse_str(&summary.groups[0].id).is_ok());
        assert_eq!(move_to(Some(&layout), "project", &["c1"]), layout);
        assert!(move_connections_in_layout(None, &SidebarGroupSpec { id: None, name: Some("x".into()) }, &[]).is_err());
    }

    #[test]
    fn moves_from_all_positions_and_migrates_legacy() {
        let layout = json!({"extra":42,"groups":[
        {"id":"a","name":"A","collapsed":true,"color":"red"}, {"id":"b","name":"B"}],
        "order":[{"type":"connection","id":"c1"},
            {"type":"group","id":"a","connectionIds":["c1","stay"],"extra":true},
            {"type":"group","id":"b","children":[{"type":"connection","id":"c1"}]}]});
        let moved = move_to(Some(&layout), "a", &["c1"]);
        assert_eq!(moved["extra"], 42);
        assert_eq!(moved["groups"][1], layout["groups"][1]);
        assert_eq!(moved["groups"][0]["collapsed"], json!(false), "a collapsed target must be expanded");
        assert_eq!(moved["groups"][0]["color"], "red");
        assert_eq!(
            moved["order"][0],
            json!({"type":"group","id":"a","extra":true,
        "children":[{"type":"connection","id":"stay"},{"type":"connection","id":"c1"}]})
        );
        assert_eq!(moved["order"][1]["children"], json!([]));
        let moved = move_to(Some(&layout), "b", &["c1"]);
        assert_eq!(moved["order"][0]["connectionIds"], json!(["stay"]));
        assert_eq!(describe_layout(Some(&moved)).unwrap().groups[1].connection_ids, ["c1"]);
    }

    #[test]
    fn resolves_by_id_and_preserves_untouched_order() {
        let layout = json!({"groups":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"order":[
        {"type":"group","id":"a","children":[{"type":"connection","id":"c"},{"type":"connection","id":"stay","custom":1}]},
        {"type":"connection","id":"root"}, {"type":"group","id":"b","children":[]}]});
        let moved = move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: Some("b".into()), name: Some(" b ".into()) },
            &["c".into()],
        )
        .unwrap();
        assert_eq!(moved["order"][0]["children"], json!([{"type":"connection","id":"stay","custom":1}]));
        assert_eq!(moved["order"][1], layout["order"][1]);
        assert_eq!(describe_layout(Some(&moved)).unwrap().groups[1].connection_ids, ["c"]);
    }

    #[test]
    fn treats_null_children_and_legacy_members_as_absent() {
        let layout = json!({
            "groups":[{"id":"g","name":"G"}],
            "order":[{"type":"group","id":"g","children":null,"connectionIds":["a"]}]
        });
        let summary = describe_layout(Some(&layout)).expect("null children must fall back to connectionIds");
        assert_eq!(summary.groups[0].connection_ids, vec!["a".to_string()]);

        let null_legacy = json!({
            "groups":[{"id":"g","name":"G"}],
            "order":[{"type":"group","id":"g","connectionIds":null}]
        });
        let summary = describe_layout(Some(&null_legacy)).expect("null connectionIds must be treated as absent");
        assert!(summary.groups[0].connection_ids.is_empty());
    }

    #[test]
    fn migrates_legacy_members_when_children_are_null() {
        let layout = json!({
            "groups":[{"id":"g","name":"G"}],
            "order":[{"type":"group","id":"g","children":null,"connectionIds":["a"]}]
        });
        let moved = move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: None, name: Some("G".into()) },
            &["b".into()],
        )
        .expect("move into a group with null children");
        let summary = describe_layout(Some(&moved)).expect("layout stays valid");
        assert_eq!(summary.groups[0].connection_ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn rejects_invalid_metadata_and_entries() {
        for layout in [
            json!([]),
            json!({"groups":null}),
            json!({"order":[{"type":"group","id":"missing"}]}),
            json!({"order":[{"type":"other","id":"x"}]}),
            json!({"groups":[{"id":"a","name":"A"}],"order":[{"type":"group","id":"a","children":false}]}),
        ] {
            assert!(describe_layout(Some(&layout)).unwrap_err().starts_with("INVALID_SIDEBAR_LAYOUT: "));
        }
        let layout = json!({"groups":[{"id":"a","name":"A"},{"id":"b","name":"B"}]});
        assert!(move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: Some("a".into()), name: Some("B".into()) },
            &["c".into()]
        )
        .is_err());
    }

    #[test]
    fn describes_and_moves_nested_connections_in_tree_order() {
        let layout = json!({"groups":[{"id":"a","name":"A"},{"id":"b","name":"B"}],"order":[
        {"type":"connection","id":"root"},{"type":"group","id":"a","children":[
            {"type":"connection","id":"first"},{"type":"group","id":"b","children":[{"type":"connection","id":"nested"}]}]}]});
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.ungrouped, ["root"]);
        assert_eq!(summary.groups[0].connection_ids, ["first", "nested"]);
        assert_eq!(summary.groups[1].connection_ids, ["nested"]);
        let moved = move_to(Some(&layout), "b", &["root", "first"]);
        assert_eq!(describe_layout(Some(&moved)).unwrap().groups[1].connection_ids, ["nested", "root", "first"]);
    }

    #[test]
    fn rejects_unknown_id_even_with_a_name() {
        let layout = json!({"groups":[{"id":"a","name":"A"}],"order":[]});
        for name in [None, Some(" a "), Some("New")] {
            let error = move_connections_in_layout(
                Some(&layout),
                &SidebarGroupSpec { id: Some("unknown".into()), name: name.map(str::to_string) },
                &["c".into()],
            )
            .unwrap_err();
            assert_eq!(error, "UNKNOWN_GROUP_ID: unknown group id 'unknown'");
        }
    }

    #[test]
    fn null_and_empty_layouts_start_from_default() {
        for layout in [Value::Null, json!({})] {
            let summary = describe_layout(Some(&layout)).unwrap();
            assert!(summary.groups.is_empty());
            assert!(summary.ungrouped.is_empty());
            let moved = move_to(Some(&layout), "Project", &["c"]);
            assert_eq!(describe_layout(Some(&moved)).unwrap().groups[0].connection_ids, ["c"]);
        }
    }

    #[test]
    fn rejects_ambiguous_group_names() {
        let layout = json!({"groups":[{"id":"a","name":"Dup"},{"id":"b","name":" dup "}],"order":[]});
        let error = move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: None, name: Some("Dup".into()) },
            &["c".into()],
        )
        .unwrap_err();
        assert_eq!(error, "AMBIGUOUS_GROUP_NAME: group name 'Dup' matches 2 groups; pass group id");
        let moved = move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: Some("b".into()), name: Some("dup".into()) },
            &["c".into()],
        )
        .unwrap();
        assert_eq!(describe_layout(Some(&moved)).unwrap().groups[1].connection_ids, ["c"]);
    }

    #[test]
    fn drops_stale_legacy_members_when_children_exist() {
        let layout = json!({"groups":[{"id":"a","name":"A"}],"order":[
        {"type":"group","id":"a","children":[{"type":"connection","id":"modern"}],
         "connectionIds":["modern","legacy","moved"]}]});
        // The desktop app ignores `connectionIds` once `children` exist, and so does this reader.
        assert_eq!(describe_layout(Some(&layout)).unwrap().groups[0].connection_ids, ["modern"]);
        let moved = move_to(Some(&layout), "A", &["moved"]);
        assert!(moved["order"][0].get("connectionIds").is_none());
        assert_eq!(describe_layout(Some(&moved)).unwrap().groups[0].connection_ids, ["modern", "moved"]);
        assert_eq!(move_to(Some(&moved), "A", &["moved"]), moved);
    }

    #[test]
    fn migrates_legacy_members_when_children_are_absent() {
        let layout = json!({"groups":[{"id":"a","name":"A","collapsed":true}],"order":[
        {"type":"group","id":"a","connectionIds":["keep","moved"]}]});
        let moved = move_to(Some(&layout), "A", &["moved"]);
        assert!(moved["order"][0].get("connectionIds").is_none());
        assert_eq!(
            moved["order"][0]["children"],
            json!([{"type":"connection","id":"keep"},{"type":"connection","id":"moved"}])
        );
    }

    #[test]
    fn duplicate_group_metadata_is_last_wins() {
        let layout = json!({"groups":[
        {"id":"a","name":"First","collapsed":true},
        {"id":"a","name":"Second","collapsed":false}],"order":[
        {"type":"group","id":"a","children":[{"type":"connection","id":"c1"}]}]});
        // connection_group_paths collects metadata into a HashMap (last wins), so the
        // read path must not turn the same layout into INVALID_SIDEBAR_LAYOUT.
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups.len(), 1);
        assert_eq!(summary.groups[0].name, "Second");
        assert!(!summary.groups[0].collapsed);
        assert_eq!(summary.groups[0].connection_ids, ["c1"]);
    }

    #[test]
    fn expands_every_duplicate_metadata_entry_of_the_target_group() {
        let layout = json!({"groups":[
        {"id":"a","name":"First","collapsed":true},
        {"id":"a","name":"Second","collapsed":true}],"order":[
        {"type":"group","id":"a","children":[{"type":"connection","id":"c1"}]}]});
        let moved = move_connections_in_layout(
            Some(&layout),
            &SidebarGroupSpec { id: Some("a".into()), name: None },
            &["c2".to_string()],
        )
        .unwrap();
        let groups = moved["groups"].as_array().unwrap();
        assert!(groups.iter().all(|group| group["collapsed"] == json!(false)));
        let summary = describe_layout(Some(&moved)).unwrap();
        assert!(!summary.groups[0].collapsed);
        assert_eq!(summary.groups[0].connection_ids, ["c1", "c2"]);
    }
}
