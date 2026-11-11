//! Validation and mutation of the persisted sidebar connection-group tree.
//!
//! The desktop stores groups as a flat metadata array (`groups`) plus an
//! ordered tree (`order`) inside `sidebar_layout`. MCP group management needs
//! stable ids, nested paths and writes that preserve every field this module
//! does not understand, so the helpers operate on [`serde_json::Value`]
//! directly instead of round-tripping through a narrow struct.
//!
//! Reads follow the desktop and MCP policy semantics:
//! - `children` wins over the legacy `connectionIds` key;
//! - duplicate group metadata ids are last-wins;
//! - a group referenced by the order without metadata is corrupt;
//! - the same group id may only appear once in the tree.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{json, Value};

pub const INVALID_SIDEBAR_LAYOUT: &str = "INVALID_SIDEBAR_LAYOUT";
pub const INVALID_GROUP_REQUEST: &str = "INVALID_GROUP_REQUEST";
pub const GROUP_NOT_FOUND: &str = "GROUP_NOT_FOUND";
pub const AMBIGUOUS_GROUP_NAME: &str = "AMBIGUOUS_GROUP_NAME";

/// A request-level failure with a stable code clients can branch on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarGroupError {
    pub code: &'static str,
    pub message: String,
}

impl SidebarGroupError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(INVALID_SIDEBAR_LAYOUT, message)
    }

    fn request(message: impl Into<String>) -> Self {
        Self::new(INVALID_GROUP_REQUEST, message)
    }
}

impl fmt::Display for SidebarGroupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SidebarGroupError {}

/// Preferred stable group id, with a display-path fallback for humans and
/// importers that only know the hierarchy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupSelector {
    Id(String),
    Path(Vec<String>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupPath {
    pub ids: Vec<String>,
    pub names: Vec<String>,
}

impl GroupPath {
    pub fn display(&self) -> String {
        self.names.join(" / ")
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarGroup {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub parent_id: Option<String>,
    pub depth: usize,
    pub path: GroupPath,
    /// Connections placed directly in this group.
    pub direct_connection_ids: Vec<String>,
    /// Connections in this group and every nested group, in tree order.
    pub descendant_connection_ids: Vec<String>,
}

impl SidebarGroup {
    pub fn display_path(&self) -> String {
        self.path.display()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidebarSummary {
    /// Groups in depth-first display order.
    pub groups: Vec<SidebarGroup>,
    /// First placement of every connection found in the stored tree. Root
    /// connections map to an empty path.
    pub connection_paths: HashMap<String, GroupPath>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateGroupOutcome {
    pub layout: Value,
    pub group_id: String,
    pub created: bool,
    pub created_group_ids: Vec<String>,
    pub path: GroupPath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveConnectionsOutcome {
    pub layout: Value,
    pub group: SidebarGroup,
    pub moved_connection_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct GroupMeta {
    name: String,
    collapsed: bool,
}

/// Normalize `layout` into an object that has array `groups` and `order`
/// fields while preserving every unknown field for the next writer.
fn base_layout(layout: Option<&Value>) -> Result<Value, SidebarGroupError> {
    let mut value = match layout {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
    };
    let object = value.as_object_mut().ok_or_else(|| SidebarGroupError::invalid("layout must be a JSON object"))?;
    match object.get("groups") {
        None => {
            object.insert("groups".to_string(), json!([]));
        }
        Some(Value::Array(_)) => {}
        Some(_) => return Err(SidebarGroupError::invalid("groups must be an array")),
    }
    match object.get("order") {
        None => {
            object.insert("order".to_string(), json!([]));
        }
        Some(Value::Array(_)) => {}
        Some(_) => return Err(SidebarGroupError::invalid("order must be an array")),
    }
    Ok(value)
}

fn parse_metadata(layout: &Value) -> Result<HashMap<String, GroupMeta>, SidebarGroupError> {
    let groups = layout
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| SidebarGroupError::invalid("groups must be an array"))?;
    let mut metadata = HashMap::new();
    for group in groups {
        let object =
            group.as_object().ok_or_else(|| SidebarGroupError::invalid("group metadata entries must be objects"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| SidebarGroupError::invalid("group id must be a string"))?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| SidebarGroupError::invalid("group name must be a string"))?;
        if id.trim().is_empty() {
            return Err(SidebarGroupError::invalid("group id must not be empty"));
        }
        if name.trim().is_empty() {
            return Err(SidebarGroupError::invalid("group name must not be empty"));
        }
        let collapsed = match object.get("collapsed") {
            None | Some(Value::Null) => false,
            Some(value) => {
                value.as_bool().ok_or_else(|| SidebarGroupError::invalid("group collapsed must be a boolean"))?
            }
        };
        // The desktop and the MCP group-path resolver collect this metadata into
        // a map, so a duplicate id is last-wins rather than corrupt data.
        metadata.insert(id.to_string(), GroupMeta { name: name.to_string(), collapsed });
    }
    Ok(metadata)
}

fn parse_connection_ids(value: &Value, field: &str) -> Result<Vec<String>, SidebarGroupError> {
    let entries = value.as_array().ok_or_else(|| SidebarGroupError::invalid(format!("{field} must be an array")))?;
    entries
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| SidebarGroupError::invalid(format!("{field} must contain only strings")))
        })
        .collect()
}

fn describe_summary(layout: Option<&Value>) -> Result<SidebarSummary, SidebarGroupError> {
    let layout = base_layout(layout)?;
    let metadata = parse_metadata(&layout)?;
    let order = layout
        .get("order")
        .and_then(Value::as_array)
        .ok_or_else(|| SidebarGroupError::invalid("order must be an array"))?;

    let mut summary = SidebarSummary::default();
    let mut group_index = HashMap::new();
    let mut visiting = HashSet::new();
    walk_entries(order, &metadata, None, &GroupPath::default(), &mut summary, &mut group_index, &mut visiting)?;
    finalize_descendants(&mut summary);
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
fn walk_entries(
    entries: &[Value],
    metadata: &HashMap<String, GroupMeta>,
    parent_id: Option<&str>,
    parent_path: &GroupPath,
    summary: &mut SidebarSummary,
    group_index: &mut HashMap<String, usize>,
    visiting: &mut HashSet<String>,
) -> Result<(), SidebarGroupError> {
    for entry in entries {
        let object =
            entry.as_object().ok_or_else(|| SidebarGroupError::invalid("order entries must be JSON objects"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| SidebarGroupError::invalid("order entry id must be a string"))?;
        if id.trim().is_empty() {
            return Err(SidebarGroupError::invalid("order entry id must not be empty"));
        }
        match object.get("type").and_then(Value::as_str) {
            Some("connection") => {
                summary.connection_paths.entry(id.to_string()).or_insert_with(|| parent_path.clone());
            }
            Some("group") => {
                let meta = metadata
                    .get(id)
                    .ok_or_else(|| SidebarGroupError::invalid("order entry references a group without metadata"))?;
                if group_index.contains_key(id) || !visiting.insert(id.to_string()) {
                    return Err(SidebarGroupError::invalid("the same group id appears more than once in the tree"));
                }

                let mut path = parent_path.clone();
                path.ids.push(id.to_string());
                path.names.push(meta.name.clone());
                let index = summary.groups.len();
                summary.groups.push(SidebarGroup {
                    id: id.to_string(),
                    name: meta.name.clone(),
                    collapsed: meta.collapsed,
                    parent_id: parent_id.map(str::to_string),
                    depth: parent_path.ids.len(),
                    path: path.clone(),
                    direct_connection_ids: Vec::new(),
                    descendant_connection_ids: Vec::new(),
                });
                group_index.insert(id.to_string(), index);

                let children = match object.get("children") {
                    Some(value) if !value.is_null() => {
                        Some(value.as_array().ok_or_else(|| SidebarGroupError::invalid("children must be an array"))?)
                    }
                    _ => None,
                };

                let mut direct = Vec::new();
                let mut seen = HashSet::new();
                if let Some(children) = children {
                    for child in children {
                        let child_object = child
                            .as_object()
                            .ok_or_else(|| SidebarGroupError::invalid("order entries must be JSON objects"))?;
                        if child_object.get("type").and_then(Value::as_str) == Some("connection") {
                            let child_id = child_object
                                .get("id")
                                .and_then(Value::as_str)
                                .ok_or_else(|| SidebarGroupError::invalid("connection entry id must be a string"))?;
                            if seen.insert(child_id.to_string()) {
                                direct.push(child_id.to_string());
                            }
                            summary.connection_paths.entry(child_id.to_string()).or_insert_with(|| path.clone());
                        }
                    }
                    walk_entries(children, metadata, Some(id), &path, summary, group_index, visiting)?;
                } else if let Some(legacy) = object.get("connectionIds") {
                    if !legacy.is_null() {
                        for child_id in parse_connection_ids(legacy, "connectionIds")? {
                            if seen.insert(child_id.clone()) {
                                direct.push(child_id.clone());
                            }
                            summary.connection_paths.entry(child_id).or_insert_with(|| path.clone());
                        }
                    }
                }

                summary.groups[index].direct_connection_ids = direct;
                visiting.remove(id);
            }
            _ => return Err(SidebarGroupError::invalid("unknown order entry type")),
        }
    }
    Ok(())
}

fn finalize_descendants(summary: &mut SidebarSummary) {
    let mut children_by_parent: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    for (index, group) in summary.groups.iter().enumerate() {
        children_by_parent.entry(group.parent_id.clone()).or_default().push(index);
    }
    // Depth-first output puts every child after its parent, so reverse order
    // lets each parent merge already-completed child descendant lists.
    for index in (0..summary.groups.len()).rev() {
        let mut descendant_ids = summary.groups[index].direct_connection_ids.clone();
        let mut seen = descendant_ids.iter().cloned().collect::<HashSet<_>>();
        for child in children_by_parent.get(&Some(summary.groups[index].id.clone())).cloned().unwrap_or_default() {
            for connection_id in &summary.groups[child].descendant_connection_ids {
                if seen.insert(connection_id.clone()) {
                    descendant_ids.push(connection_id.clone());
                }
            }
        }
        summary.groups[index].descendant_connection_ids = descendant_ids;
    }
}

/// Public read of the stored tree. Corrupt layouts are reported instead of
/// silently dropping groups or members.
pub fn describe_layout(layout: Option<&Value>) -> Result<SidebarSummary, SidebarGroupError> {
    describe_summary(layout)
}

/// Groups that may be named to a caller that can only see
/// `visible_connection_ids`.
///
/// A group is visible when every ancestor is visible and either the group is
/// empty or at least one connection in its subtree is visible. Empty groups
/// are therefore listed, while a group whose only members are hidden is not
/// (its name would leak the shape of the sidebar the policy withholds).
pub fn visible_group_ids(summary: &SidebarSummary, visible_connection_ids: &HashSet<String>) -> HashSet<String> {
    let mut visible = HashSet::new();
    for group in &summary.groups {
        let parent_visible = group.parent_id.as_ref().is_none_or(|parent| visible.contains(parent));
        let empty = group.descendant_connection_ids.is_empty();
        let has_visible_descendant =
            group.descendant_connection_ids.iter().any(|id| visible_connection_ids.contains(id));
        if parent_visible && (empty || has_visible_descendant) {
            visible.insert(group.id.clone());
        }
    }
    visible
}

fn resolve_group_from_summary(
    summary: &SidebarSummary,
    selector: &GroupSelector,
) -> Result<SidebarGroup, SidebarGroupError> {
    match selector {
        GroupSelector::Id(id) => summary
            .groups
            .iter()
            .find(|group| &group.id == id)
            .cloned()
            .ok_or_else(|| SidebarGroupError::new(GROUP_NOT_FOUND, format!("group id \"{id}\" was not found"))),
        GroupSelector::Path(names) => {
            if names.is_empty() {
                return Err(SidebarGroupError::request("group path must not be empty"));
            }
            let mut parent_id: Option<String> = None;
            let mut matched: Option<usize> = None;
            for (depth, name) in names.iter().enumerate() {
                let name = name.trim();
                if name.is_empty() {
                    return Err(SidebarGroupError::request("group path contains an empty name"));
                }
                let matches = summary
                    .groups
                    .iter()
                    .enumerate()
                    .filter(|(_, group)| {
                        group.parent_id.as_deref() == parent_id.as_deref()
                            && group.name.trim().eq_ignore_ascii_case(name)
                    })
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>();
                match matches.as_slice() {
                    [] => {
                        let path = names[..=depth].join(" / ");
                        return Err(SidebarGroupError::new(
                            GROUP_NOT_FOUND,
                            format!("group path \"{path}\" was not found"),
                        ));
                    }
                    [only] => {
                        matched = Some(*only);
                        parent_id = Some(summary.groups[*only].id.clone());
                    }
                    _ => {
                        let path = names[..=depth].join(" / ");
                        return Err(SidebarGroupError::new(
                            AMBIGUOUS_GROUP_NAME,
                            format!("group path \"{path}\" is ambiguous; pass group_id instead"),
                        ));
                    }
                }
            }
            Ok(summary.groups[matched.expect("path has at least one segment")].clone())
        }
    }
}

/// Resolve a stable id or a display-name path to one group.
pub fn resolve_group(layout: Option<&Value>, selector: &GroupSelector) -> Result<SidebarGroup, SidebarGroupError> {
    let summary = describe_summary(layout)?;
    resolve_group_from_summary(&summary, selector)
}

fn find_group_entry_mut<'a>(entries: &'a mut [Value], group_id: &str) -> Option<&'a mut Value> {
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) == Some("group")
            && entry.get("id").and_then(Value::as_str) == Some(group_id)
        {
            return Some(entry);
        }
        if let Some(children) = entry.get_mut("children").and_then(Value::as_array_mut) {
            if let Some(found) = find_group_entry_mut(children, group_id) {
                return Some(found);
            }
        }
    }
    None
}

/// Return a mutable children array for `entry`, migrating a legacy
/// `connectionIds` list the first time the group is written.
fn group_children_mut(entry: &mut Value) -> Result<&mut Vec<Value>, SidebarGroupError> {
    let object =
        entry.as_object_mut().ok_or_else(|| SidebarGroupError::invalid("group entries must be JSON objects"))?;
    let has_children = matches!(object.get("children"), Some(value) if !value.is_null());
    if !has_children {
        let legacy = object.remove("connectionIds");
        let mut members = Vec::new();
        let mut seen = HashSet::new();
        if let Some(legacy) = legacy {
            if !legacy.is_null() {
                for connection_id in parse_connection_ids(&legacy, "connectionIds")? {
                    if seen.insert(connection_id.clone()) {
                        members.push(json!({ "type": "connection", "id": connection_id }));
                    }
                }
            }
        }
        object.insert("children".to_string(), Value::Array(members));
    } else {
        // `children` wins over `connectionIds`; keeping a stale legacy list
        // would make the next move look like it duplicated members.
        object.remove("connectionIds");
    }
    object
        .get_mut("children")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| SidebarGroupError::invalid("children must be an array"))
}

fn expand_group_metadata(layout: &mut Value, group_id: &str) {
    if let Some(groups) = layout.get_mut("groups").and_then(Value::as_array_mut) {
        for group in groups {
            if group.get("id").and_then(Value::as_str) == Some(group_id) {
                if let Some(object) = group.as_object_mut() {
                    object.insert("collapsed".to_string(), json!(false));
                }
            }
        }
    }
}

fn append_group_entry(
    layout: &mut Value,
    parent_id: Option<&str>,
    group_id: &str,
    name: &str,
) -> Result<(), SidebarGroupError> {
    let entry = json!({ "type": "group", "id": group_id, "children": [] });
    let order = layout
        .get_mut("order")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| SidebarGroupError::invalid("order must be an array"))?;
    match parent_id {
        None => order.push(entry),
        Some(parent_id) => {
            let parent = find_group_entry_mut(order, parent_id).ok_or_else(|| {
                SidebarGroupError::new(GROUP_NOT_FOUND, format!("group id \"{parent_id}\" was not found"))
            })?;
            group_children_mut(parent)?.push(entry);
        }
    }
    let groups = layout
        .get_mut("groups")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| SidebarGroupError::invalid("groups must be an array"))?;
    groups.push(json!({ "id": group_id, "name": name, "collapsed": false }));
    if let Some(parent_id) = parent_id {
        expand_group_metadata(layout, parent_id);
    }
    Ok(())
}

fn group_in_scope(group: &SidebarGroup, visible_group_ids: Option<&HashSet<String>>) -> bool {
    visible_group_ids.is_none_or(|visible| visible.contains(&group.id))
}

fn resolve_group_in_scope(
    layout: Option<&Value>,
    selector: &GroupSelector,
    visible_group_ids: Option<&HashSet<String>>,
) -> Result<SidebarGroup, SidebarGroupError> {
    let not_found = || SidebarGroupError::new(GROUP_NOT_FOUND, "the requested parent group was not found");
    let group =
        resolve_group(layout, selector).map_err(
            |error| {
                if error.code == GROUP_NOT_FOUND {
                    not_found()
                } else {
                    error
                }
            },
        )?;
    if group_in_scope(&group, visible_group_ids) {
        Ok(group)
    } else {
        Err(not_found())
    }
}

/// Create a group directly under an existing parent (or at the root) and
/// return the existing group when the same name is already there.
pub fn create_group_under(
    layout: Option<&Value>,
    parent_id: Option<&str>,
    name: &str,
    visible_group_ids: Option<&HashSet<String>>,
    next_id: &mut dyn FnMut() -> String,
) -> Result<CreateGroupOutcome, SidebarGroupError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(SidebarGroupError::request("group name must not be empty"));
    }
    let summary = describe_summary(layout)?;
    let parent = match parent_id {
        None => None,
        Some(parent_id) => {
            let not_found = || SidebarGroupError::new(GROUP_NOT_FOUND, "the requested parent group was not found");
            let parent = summary.groups.iter().find(|group| group.id == parent_id).cloned().ok_or_else(&not_found)?;
            if !group_in_scope(&parent, visible_group_ids) {
                return Err(not_found());
            }
            Some(parent)
        }
    };
    let matches = summary
        .groups
        .iter()
        .enumerate()
        .filter(|(_, group)| {
            group.parent_id.as_deref() == parent_id
                && group.name.trim().eq_ignore_ascii_case(name)
                && group_in_scope(group, visible_group_ids)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut root = base_layout(layout)?;
    match matches.as_slice() {
        [] => {
            let group_id = next_id();
            append_group_entry(&mut root, parent_id, &group_id, name)?;
            let mut path = parent.map(|group| group.path).unwrap_or_default();
            path.ids.push(group_id.clone());
            path.names.push(name.to_string());
            Ok(CreateGroupOutcome {
                layout: root,
                group_id: group_id.clone(),
                created: true,
                created_group_ids: vec![group_id],
                path,
            })
        }
        [only] => {
            let group = summary.groups[*only].clone();
            expand_group_metadata(&mut root, &group.id);
            Ok(CreateGroupOutcome {
                layout: root,
                group_id: group.id,
                created: false,
                created_group_ids: Vec::new(),
                path: group.path,
            })
        }
        _ => {
            let parent_path = parent.as_ref().map(SidebarGroup::display_path).unwrap_or_default();
            let prefix = if parent_path.is_empty() { String::new() } else { format!("{parent_path} / ") };
            Err(SidebarGroupError::new(
                AMBIGUOUS_GROUP_NAME,
                format!("group name \"{prefix}{name}\" is ambiguous; pass its group_id instead"),
            ))
        }
    }
}

/// Create every missing level of `names` and return the leaf group. Existing
/// levels are reused (case-insensitive name match) so repeated imports do not
/// duplicate the hierarchy.
pub fn ensure_group_path(
    layout: Option<&Value>,
    names: &[String],
    visible_group_ids: Option<&HashSet<String>>,
    next_id: &mut dyn FnMut() -> String,
) -> Result<CreateGroupOutcome, SidebarGroupError> {
    let names = names.iter().map(|name| name.trim().to_string()).collect::<Vec<_>>();
    if names.is_empty() {
        return Err(SidebarGroupError::request("group path must not be empty"));
    }
    if names.iter().any(String::is_empty) {
        return Err(SidebarGroupError::request("group path contains an empty name"));
    }

    let summary = describe_summary(layout)?;
    let mut parent_id: Option<String> = None;
    let mut path = GroupPath::default();
    let mut missing_from = names.len();
    for (depth, name) in names.iter().enumerate() {
        let matches = summary
            .groups
            .iter()
            .enumerate()
            .filter(|(_, group)| {
                group.parent_id.as_deref() == parent_id.as_deref()
                    && group.name.trim().eq_ignore_ascii_case(name)
                    && group_in_scope(group, visible_group_ids)
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => {
                missing_from = depth;
                break;
            }
            [only] => {
                let group = &summary.groups[*only];
                parent_id = Some(group.id.clone());
                path.ids.push(group.id.clone());
                path.names.push(group.name.clone());
            }
            _ => {
                return Err(SidebarGroupError::new(
                    AMBIGUOUS_GROUP_NAME,
                    format!("group path \"{}\" is ambiguous; pass group_id instead", names[..=depth].join(" / ")),
                ));
            }
        }
    }

    let mut root = base_layout(layout)?;
    if missing_from == names.len() {
        let leaf = path.ids.last().cloned().expect("at least one path segment exists");
        expand_group_metadata(&mut root, &leaf);
        return Ok(CreateGroupOutcome {
            layout: root,
            group_id: leaf,
            created: false,
            created_group_ids: Vec::new(),
            path,
        });
    }

    let mut created_group_ids = Vec::new();
    for name in names.iter().skip(missing_from) {
        let group_id = next_id();
        append_group_entry(&mut root, parent_id.as_deref(), &group_id, name)?;
        path.ids.push(group_id.clone());
        path.names.push(name.clone());
        created_group_ids.push(group_id.clone());
        parent_id = Some(group_id);
    }
    Ok(CreateGroupOutcome {
        layout: root,
        group_id: path.ids.last().cloned().expect("path has a leaf"),
        created: true,
        created_group_ids,
        path,
    })
}

/// Create one group, optionally creating missing levels of a parent path.
pub fn create_group(
    layout: Option<&Value>,
    parent: Option<&GroupSelector>,
    name: &str,
    create_missing_parents: bool,
    visible_group_ids: Option<&HashSet<String>>,
    next_id: &mut dyn FnMut() -> String,
) -> Result<CreateGroupOutcome, SidebarGroupError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(SidebarGroupError::request("group name must not be empty"));
    }
    match parent {
        None => create_group_under(layout, None, name, visible_group_ids, next_id),
        Some(selector @ GroupSelector::Id(_)) => {
            let parent = resolve_group_in_scope(layout, selector, visible_group_ids)?;
            create_group_under(layout, Some(&parent.id), name, visible_group_ids, next_id)
        }
        Some(selector @ GroupSelector::Path(parent_names)) => {
            if create_missing_parents {
                let mut names = parent_names.iter().map(|segment| segment.trim().to_string()).collect::<Vec<_>>();
                if names.is_empty() {
                    return create_group_under(layout, None, name, visible_group_ids, next_id);
                }
                if names.iter().any(String::is_empty) {
                    return Err(SidebarGroupError::request("group path contains an empty name"));
                }
                names.push(name.to_string());
                ensure_group_path(layout, &names, visible_group_ids, next_id)
            } else {
                let parent = resolve_group_in_scope(layout, selector, visible_group_ids)?;
                create_group_under(layout, Some(&parent.id), name, visible_group_ids, next_id)
            }
        }
    }
}

fn remove_connections(entries: &mut Vec<Value>, ids: &HashSet<String>) {
    entries.retain(|entry| {
        !(entry.get("type").and_then(Value::as_str) == Some("connection")
            && entry.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(id)))
    });
    for entry in entries.iter_mut() {
        if let Some(children) = entry.get_mut("children").and_then(Value::as_array_mut) {
            remove_connections(children, ids);
        }
        // A stale legacy list may still name the moved connection even when
        // modern children exist; clear it so a later migration cannot bring
        // the connection back.
        if let Some(legacy) = entry.get_mut("connectionIds").and_then(Value::as_array_mut) {
            legacy.retain(|id| id.as_str().is_some_and(|id| !ids.contains(id)));
        }
    }
}

fn dedup_non_empty(values: &[String]) -> Result<Vec<String>, SidebarGroupError> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            return Err(SidebarGroupError::request("connection ids must not be empty"));
        }
        if seen.insert(value.to_string()) {
            output.push(value.to_string());
        }
    }
    Ok(output)
}

/// Move connections into an existing group, preserving order and unknown
/// fields. The target is resolved by stable id first or by display path.
pub fn move_connections(
    layout: Option<&Value>,
    connection_ids: &[String],
    target: &GroupSelector,
) -> Result<MoveConnectionsOutcome, SidebarGroupError> {
    let connection_ids = dedup_non_empty(connection_ids)?;
    if connection_ids.is_empty() {
        return Err(SidebarGroupError::request("connection_ids must not be empty"));
    }
    let summary = describe_summary(layout)?;
    let group = resolve_group_from_summary(&summary, target)?;
    let mut root = base_layout(layout)?;
    let order = root
        .get_mut("order")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| SidebarGroupError::invalid("order must be an array"))?;
    let ids = connection_ids.iter().cloned().collect::<HashSet<_>>();
    remove_connections(order, &ids);
    let target_entry = find_group_entry_mut(order, &group.id)
        .ok_or_else(|| SidebarGroupError::new(GROUP_NOT_FOUND, format!("group id \"{}\" was not found", group.id)))?;
    let children = group_children_mut(target_entry)?;
    let mut existing = children
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("connection"))
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();
    for connection_id in &connection_ids {
        if existing.insert(connection_id.clone()) {
            children.push(json!({ "type": "connection", "id": connection_id }));
        }
    }
    expand_group_metadata(&mut root, &group.id);
    Ok(MoveConnectionsOutcome { layout: root, group, moved_connection_ids: connection_ids })
}

/// Place one connection into an existing group. Used by the storage-level
/// atomic "add connection in group" path.
pub fn append_connection(
    layout: Option<&Value>,
    connection_id: &str,
    target: &GroupSelector,
) -> Result<Value, SidebarGroupError> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err(SidebarGroupError::request("connection id must not be empty"));
    }
    Ok(move_connections(layout, &[connection_id.to_string()], target)?.layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn counter() -> impl FnMut() -> String {
        let mut next = 0;
        move || {
            next += 1;
            format!("g{next}")
        }
    }

    #[test]
    fn describes_nested_groups_with_paths_and_members() {
        let layout = json!({
            "groups": [
                { "id": "local", "name": "本地", "collapsed": false },
                { "id": "mysql", "name": "MySQL", "collapsed": true },
                { "id": "mysql80", "name": "MySQL 8.0", "collapsed": false }
            ],
            "order": [{
                "type": "group", "id": "local", "children": [{
                    "type": "group", "id": "mysql", "children": [
                        { "type": "connection", "id": "mysql-8" },
                        { "type": "group", "id": "mysql80", "children": [
                            { "type": "connection", "id": "mysql-8-0" }
                        ]}
                    ]
                }]
            }]
        });
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups.len(), 3);
        assert_eq!(summary.groups[1].path.names, vec!["本地", "MySQL"]);
        assert_eq!(summary.groups[1].depth, 1);
        assert_eq!(summary.groups[1].parent_id.as_deref(), Some("local"));
        assert_eq!(summary.groups[1].direct_connection_ids, ids(&["mysql-8"]));
        assert_eq!(summary.groups[1].descendant_connection_ids, ids(&["mysql-8", "mysql-8-0"]));
        assert_eq!(summary.connection_paths["mysql-8-0"].names, vec!["本地", "MySQL", "MySQL 8.0"]);
    }

    #[test]
    fn children_win_over_legacy_connection_ids() {
        let layout = json!({
            "groups": [{ "id": "g", "name": "G" }],
            "order": [{
                "type": "group", "id": "g",
                "children": [{ "type": "connection", "id": "modern" }],
                "connectionIds": ["legacy"]
            }]
        });
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups[0].direct_connection_ids, ids(&["modern"]));
        assert!(!summary.connection_paths.contains_key("legacy"));
    }

    #[test]
    fn legacy_members_are_read_when_children_are_absent() {
        let layout = json!({
            "groups": [{ "id": "g", "name": "G" }],
            "order": [{ "type": "group", "id": "g", "connectionIds": ["a", "a", "b"] }]
        });
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups[0].direct_connection_ids, ids(&["a", "b"]));
        assert_eq!(summary.connection_paths["a"].ids, vec!["g"]);
    }

    #[test]
    fn corrupt_layouts_are_rejected() {
        for layout in [
            json!([]),
            json!({ "groups": null }),
            json!({ "order": [{ "type": "group", "id": "missing" }] }),
            json!({ "order": [{ "type": "other", "id": "x" }] }),
            json!({ "groups": [{ "id": "a", "name": "A" }], "order": [{ "type": "group", "id": "a", "children": false }] }),
            json!({ "groups": [{ "id": "a", "name": "A" }], "order": [
                { "type": "group", "id": "a", "children": [{ "type": "group", "id": "a", "children": [] }] }
            ] }),
        ] {
            let error = describe_layout(Some(&layout)).unwrap_err();
            assert_eq!(error.code, INVALID_SIDEBAR_LAYOUT, "{layout}");
        }
    }

    #[test]
    fn duplicate_metadata_is_last_wins() {
        let layout = json!({
            "groups": [
                { "id": "g", "name": "First", "collapsed": true },
                { "id": "g", "name": "Second", "collapsed": false }
            ],
            "order": [{ "type": "group", "id": "g", "children": [] }]
        });
        let summary = describe_layout(Some(&layout)).unwrap();
        assert_eq!(summary.groups[0].name, "Second");
        assert!(!summary.groups[0].collapsed);
    }

    #[test]
    fn creates_a_nested_path_and_is_idempotent() {
        let mut next = counter();
        let created = ensure_group_path(
            None,
            &["本地".to_string(), "MySQL".to_string(), "MySQL 8.0".to_string()],
            None,
            &mut next,
        )
        .unwrap();
        assert!(created.created);
        assert_eq!(created.created_group_ids, ids(&["g1", "g2", "g3"]));
        assert_eq!(created.path.names, vec!["本地", "MySQL", "MySQL 8.0"]);
        let summary = describe_layout(Some(&created.layout)).unwrap();
        assert_eq!(summary.groups.len(), 3);
        assert_eq!(summary.groups[2].path.names, vec!["本地", "MySQL", "MySQL 8.0"]);

        let mut next = counter();
        let again = ensure_group_path(
            Some(&created.layout),
            &["本地".to_string(), "MySQL".to_string(), "MySQL 8.0".to_string()],
            None,
            &mut next,
        )
        .unwrap();
        assert!(!again.created);
        assert!(again.created_group_ids.is_empty());
        assert_eq!(again.group_id, "g3");
    }

    #[test]
    fn creates_missing_parents_for_a_single_named_group() {
        let mut next = counter();
        let created = create_group(
            None,
            Some(&GroupSelector::Path(vec!["本地".to_string(), "MySQL".to_string()])),
            "MySQL 8.0",
            true,
            None,
            &mut next,
        )
        .unwrap();
        assert_eq!(created.path.names, vec!["本地", "MySQL", "MySQL 8.0"]);
        assert_eq!(created.created_group_ids, ids(&["g1", "g2", "g3"]));
    }

    #[test]
    fn create_without_missing_parents_requires_the_parent() {
        let mut next = counter();
        let error =
            create_group(None, Some(&GroupSelector::Path(vec!["本地".to_string()])), "MySQL", false, None, &mut next)
                .unwrap_err();
        assert_eq!(error.code, GROUP_NOT_FOUND);
    }

    #[test]
    fn create_under_parent_id_reuses_an_existing_name() {
        let mut next = counter();
        let first = create_group_under(None, None, "Local", None, &mut next).unwrap();
        let mut next = counter();
        let second = create_group_under(Some(&first.layout), None, " local ", None, &mut next).unwrap();
        assert!(!second.created);
        assert_eq!(second.group_id, first.group_id);
        assert_eq!(describe_layout(Some(&second.layout)).unwrap().groups.len(), 1);
    }

    #[test]
    fn hidden_group_names_do_not_affect_creation() {
        let layout = json!({
            "groups": [{ "id": "secret", "name": "Secret" }],
            "order": [{
                "type": "group",
                "id": "secret",
                "children": [{ "type": "connection", "id": "hidden" }]
            }]
        });
        let visible = HashSet::from(["some-other-group".to_string()]);
        let mut next = counter();
        let created = ensure_group_path(Some(&layout), &["Secret".to_string()], Some(&visible), &mut next).unwrap();
        assert!(created.created);
        assert_ne!(created.group_id, "secret");
        let summary = describe_layout(Some(&created.layout)).unwrap();
        assert_eq!(summary.groups.len(), 2);

        let mut next = counter();
        let error = create_group_under(Some(&layout), Some("secret"), "Child", Some(&visible), &mut next).unwrap_err();
        assert_eq!(error.code, GROUP_NOT_FOUND);
    }

    #[test]
    fn move_by_id_and_by_path() {
        let layout = json!({
            "groups": [
                { "id": "local", "name": "本地" },
                { "id": "mysql", "name": "MySQL" }
            ],
            "order": [
                { "type": "group", "id": "local", "children": [{ "type": "group", "id": "mysql", "children": [] }] },
                { "type": "connection", "id": "c1" },
                { "type": "connection", "id": "c2" }
            ]
        });
        let moved = move_connections(Some(&layout), &ids(&["c1", "c2", "c1"]), &GroupSelector::Id("mysql".to_string()))
            .unwrap();
        assert_eq!(moved.moved_connection_ids, ids(&["c1", "c2"]));
        let summary = describe_layout(Some(&moved.layout)).unwrap();
        let mysql = summary.groups.iter().find(|group| group.id == "mysql").unwrap();
        assert_eq!(mysql.direct_connection_ids, ids(&["c1", "c2"]));
        assert!(summary.connection_paths["c1"].names == vec!["本地", "MySQL"]);

        let moved = move_connections(
            Some(&moved.layout),
            &ids(&["c1"]),
            &GroupSelector::Path(vec!["本地".to_string(), "MySQL".to_string()]),
        )
        .unwrap();
        assert_eq!(moved.group.id, "mysql");
        let summary = describe_layout(Some(&moved.layout)).unwrap();
        assert_eq!(
            summary.groups.iter().find(|group| group.id == "mysql").unwrap().direct_connection_ids,
            ids(&["c2", "c1"])
        );
    }

    #[test]
    fn move_migrates_legacy_members_and_expands_target() {
        let layout = json!({
            "groups": [{ "id": "g", "name": "G", "collapsed": true, "color": "red" }],
            "order": [{ "type": "group", "id": "g", "connectionIds": ["keep", "moved"] }]
        });
        let moved = move_connections(Some(&layout), &ids(&["moved"]), &GroupSelector::Id("g".to_string())).unwrap();
        assert_eq!(moved.layout["groups"][0]["collapsed"], json!(false));
        assert_eq!(moved.layout["groups"][0]["color"], json!("red"));
        assert!(moved.layout["order"][0].get("connectionIds").is_none());
        let summary = describe_layout(Some(&moved.layout)).unwrap();
        assert_eq!(summary.groups[0].direct_connection_ids, ids(&["keep", "moved"]));
    }

    #[test]
    fn legacy_members_are_dropped_when_children_exist() {
        let layout = json!({
            "groups": [{ "id": "a", "name": "A" }],
            "order": [{
                "type": "group", "id": "a",
                "children": [{ "type": "connection", "id": "modern" }],
                "connectionIds": ["modern", "legacy", "moved"]
            }]
        });
        let moved = move_connections(Some(&layout), &ids(&["moved"]), &GroupSelector::Id("a".to_string())).unwrap();
        assert!(moved.layout["order"][0].get("connectionIds").is_none());
        let summary = describe_layout(Some(&moved.layout)).unwrap();
        assert_eq!(summary.groups[0].direct_connection_ids, ids(&["modern", "moved"]));
    }

    #[test]
    fn move_rejects_unknown_targets() {
        let layout = json!({ "groups": [], "order": [] });
        let error =
            move_connections(Some(&layout), &ids(&["c"]), &GroupSelector::Id("missing".to_string())).unwrap_err();
        assert_eq!(error.code, GROUP_NOT_FOUND);
        let error = move_connections(Some(&layout), &[], &GroupSelector::Id("missing".to_string())).unwrap_err();
        assert_eq!(error.code, INVALID_GROUP_REQUEST);
    }

    #[test]
    fn path_resolution_rejects_ambiguity() {
        let layout = json!({
            "groups": [
                { "id": "a", "name": "Dup" },
                { "id": "b", "name": " dup " }
            ],
            "order": [{ "type": "group", "id": "a", "children": [] }, { "type": "group", "id": "b", "children": [] }]
        });
        let error = resolve_group(Some(&layout), &GroupSelector::Path(vec!["Dup".to_string()])).unwrap_err();
        assert_eq!(error.code, AMBIGUOUS_GROUP_NAME);
        let group = resolve_group(Some(&layout), &GroupSelector::Id("b".to_string())).unwrap();
        assert_eq!(group.name, " dup ");
    }

    #[test]
    fn visibility_hides_groups_with_only_hidden_members() {
        let layout = json!({
            "groups": [
                { "id": "hidden", "name": "Secret" },
                { "id": "visible", "name": "Local" },
                { "id": "empty", "name": "Empty" }
            ],
            "order": [
                { "type": "group", "id": "hidden", "children": [{ "type": "connection", "id": "dark" }] },
                { "type": "group", "id": "visible", "children": [{ "type": "connection", "id": "light" }] },
                { "type": "group", "id": "empty", "children": [] }
            ]
        });
        let summary = describe_layout(Some(&layout)).unwrap();
        let visible = visible_group_ids(&summary, &HashSet::from(["light".to_string()]));
        assert!(!visible.contains("hidden"));
        assert!(visible.contains("visible"));
        assert!(visible.contains("empty"));
    }

    #[test]
    fn empty_layout_is_valid_and_all_connections_are_ungrouped() {
        let summary =
            describe_layout(Some(&json!({ "groups": [], "order": [{ "type": "connection", "id": "c" }] }))).unwrap();
        assert!(summary.groups.is_empty());
        assert!(summary.connection_paths["c"].is_empty());
        assert!(describe_layout(None).unwrap().groups.is_empty());
    }

    #[test]
    fn append_connection_does_not_duplicate_members() {
        let layout = json!({
            "groups": [{ "id": "g", "name": "G" }],
            "order": [{ "type": "group", "id": "g", "children": [{ "type": "connection", "id": "c" }] }]
        });
        let next = append_connection(Some(&layout), "c", &GroupSelector::Id("g".to_string())).unwrap();
        let summary = describe_layout(Some(&next)).unwrap();
        assert_eq!(summary.groups[0].direct_connection_ids, ids(&["c"]));
    }
}
