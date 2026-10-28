//! Unified MCP access model (policy v2).
//!
//! Every resource — global default, sidebar group, connection, sub-scope (a
//! database today; namespaces, topics, … for product providers) — resolves to
//! one access level: `none < read < write < full`. Rules are keyed by target
//! and inherited from the closest configured node:
//! sub-scope > connection > closest group > ancestor group > global default.
//!
//! This module is the evaluation core shared by the MCP server, the desktop
//! bridge, the Web routes and the settings preview. It is pure: callers pass
//! the policy plus the resource path.
//!
//! The persisted v1 policy (`McpGlobalPolicy`) stays the source of truth until
//! the v2 storage lands; [`McpAccessPolicy::from_v1`] maps it losslessly and
//! the equivalence tests below pin that every v1 decision (visibility,
//! database scope, `(read_only, allow_dangerous_sql)`) is reproduced.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::mcp_policy::{policy_allows_connection, McpConnectionGroupPath};
use crate::storage::{McpDatabaseScope, McpGlobalPolicy};

pub const MCP_ACCESS_POLICY_VERSION: u8 = 2;

/// How plugin MCP tools are exposed to clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpPluginToolsMode {
    Auto,
    #[default]
    Flat,
    Lazy,
}

impl McpPluginToolsMode {
    /// Preserve the behavior of saved policies written without this field.
    /// New policies use `Default` (flat); explicit saved modes always win.
    pub fn legacy_default() -> Self {
        Self::Auto
    }
}

/// Unified access level. Ordered: `None < Read < Write < Full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpAccessLevel {
    None,
    Read,
    Write,
    Full,
}

impl McpAccessLevel {
    /// v1 `(read_only, allow_dangerous_sql)` → level. Read-only wins, as in v1.
    pub fn from_flags(read_only: bool, allow_dangerous_sql: bool) -> Self {
        match (read_only, allow_dangerous_sql) {
            (true, _) => Self::Read,
            (false, false) => Self::Write,
            (false, true) => Self::Full,
        }
    }

    pub fn from_flags_pair((read_only, allow_dangerous_sql): (bool, bool)) -> Self {
        Self::from_flags(read_only, allow_dangerous_sql)
    }

    /// Level → v1 flags. `None` maps to read-only; visibility carries the denial.
    pub fn to_flags(self) -> (bool, bool) {
        match self {
            Self::None | Self::Read => (true, false),
            Self::Write => (false, false),
            Self::Full => (false, true),
        }
    }
}

/// When a call needs the desktop user's confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpConfirmPolicy {
    /// Never ask (calls above the access level are rejected, not confirmed).
    #[default]
    Off,
    /// Legacy temporary elevation: Write can confirm supported Full operations;
    /// Full itself does not prompt. Never reinterpret saved `full` as HighRisk.
    Full,
    /// Confirm each authorized high-risk call, including Full access.
    #[serde(rename = "high_risk")]
    HighRisk,
}

/// Authorization is evaluated before confirmation. Callers must also enforce
/// visibility, tool grants, connection protections and production safeguards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCallDecision {
    Deny,
    Allow,
    Confirm,
}

impl McpConfirmPolicy {
    pub fn decide(self, actual: McpAccessLevel, required: McpAccessLevel, high_risk: bool) -> McpCallDecision {
        if actual < required {
            if self == Self::Full && high_risk && actual == McpAccessLevel::Write && required == McpAccessLevel::Full {
                return McpCallDecision::Confirm;
            }
            return McpCallDecision::Deny;
        }
        if self == Self::HighRisk && high_risk {
            McpCallDecision::Confirm
        } else {
            McpCallDecision::Allow
        }
    }
}

/// What one rule applies to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum McpRuleTarget {
    Group {
        id: String,
    },
    Connection {
        id: String,
    },
    /// A sub-scope below a connection; `scope` names its kind (`database`, …).
    #[serde(rename_all = "camelCase")]
    Scope {
        connection_id: String,
        scope: String,
        value: String,
    },
}

/// One node's settings. Every field is optional: absent means "inherit".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAccessRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<McpAccessLevel>,
    /// Upper bound applied after inheritance instead of an override. Only
    /// produced by migrating legacy (unversioned) v1 rules, whose semantics
    /// were "never wider than what the node would inherit".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceiling: Option<McpAccessLevel>,
    /// Explicit visibility. With `visibility = selected`, only nodes marked
    /// visible (directly or through an ancestor group) can be reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// Sub-scope admission for a connection: `all` (default), `selected`
    /// (only `Scope` rules with `visible: true`), or `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_scope: Option<McpSubScopeMode>,
    /// Kind owned by the immediate sub-scope editor. Keeps a later v1 draft
    /// save from replacing non-database admission with its stale database mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_scope_kind: Option<String>,
    /// Per-toolset ceilings that can only narrow the resolved level, e.g.
    /// `{ "salesforce.write": "read" }`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub toolset_ceilings: BTreeMap<String, McpAccessLevel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpSubScopeMode {
    #[default]
    All,
    Selected,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpVisibilityMode {
    /// Every connection is visible unless a rule hides it.
    #[default]
    All,
    /// Only connections marked visible (or inside a visible group).
    Selected,
}

/// Toolset ceiling key that replaces v1 `allow_salesforce_dml`.
pub const SALESFORCE_WRITE_TOOLSET: &str = "salesforce.write";

/// The v2 policy. Rules are kept in a target-keyed map, so one target never
/// carries two competing rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAccessPolicy {
    pub version: u8,
    pub default_access: McpAccessLevel,
    #[serde(default)]
    pub confirm: McpConfirmPolicy,
    #[serde(default)]
    pub visibility: McpVisibilityMode,
    #[serde(default, with = "rule_list")]
    pub rules: BTreeMap<McpRuleTarget, McpAccessRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tool_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_timeout_secs: Option<u64>,
    #[serde(default = "McpPluginToolsMode::legacy_default")]
    pub plugin_tools_mode: McpPluginToolsMode,
}

/// Rules serialize as a list of `{ target, ...rule }` so the JSON stays
/// readable (map keys cannot be objects).
mod rule_list {
    use super::{McpAccessRule, McpRuleTarget};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    #[derive(Serialize, Deserialize)]
    struct Entry {
        target: McpRuleTarget,
        #[serde(flatten)]
        rule: McpAccessRule,
    }

    pub fn serialize<S: Serializer>(
        rules: &BTreeMap<McpRuleTarget, McpAccessRule>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        rules
            .iter()
            .map(|(target, rule)| Entry { target: target.clone(), rule: rule.clone() })
            .collect::<Vec<_>>()
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<McpRuleTarget, McpAccessRule>, D::Error> {
        // Duplicate targets merge to the strictest combination, mirroring v1 normalization.
        let mut rules = BTreeMap::new();
        for Entry { target, rule } in Vec::<Entry>::deserialize(deserializer)? {
            rules
                .entry(target)
                .and_modify(|current: &mut McpAccessRule| current.merge_strictest(&rule))
                .or_insert(rule);
        }
        Ok(rules)
    }
}

impl McpAccessRule {
    fn merge_strictest(&mut self, other: &McpAccessRule) {
        self.access = match (self.access, other.access) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        };
        self.ceiling = match (self.ceiling, other.ceiling) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        };
        self.visible = match (self.visible, other.visible) {
            (Some(left), Some(right)) => Some(left && right),
            (left, right) => left.or(right),
        };
        self.sub_scope = match (self.sub_scope, other.sub_scope) {
            (Some(McpSubScopeMode::None), _) | (_, Some(McpSubScopeMode::None)) => Some(McpSubScopeMode::None),
            (Some(McpSubScopeMode::Selected), _) | (_, Some(McpSubScopeMode::Selected)) => {
                Some(McpSubScopeMode::Selected)
            }
            (left, right) => left.or(right),
        };
        if self.sub_scope_kind.is_none() {
            self.sub_scope_kind.clone_from(&other.sub_scope_kind);
        }
        for (toolset, ceiling) in &other.toolset_ceilings {
            self.toolset_ceilings
                .entry(toolset.clone())
                .and_modify(|current| *current = (*current).min(*ceiling))
                .or_insert(*ceiling);
        }
    }
}

impl Default for McpAccessPolicy {
    fn default() -> Self {
        Self {
            version: MCP_ACCESS_POLICY_VERSION,
            default_access: McpAccessLevel::Read,
            confirm: McpConfirmPolicy::Off,
            visibility: McpVisibilityMode::All,
            rules: BTreeMap::new(),
            allowed_tool_names: None,
            query_timeout_secs: None,
            plugin_tools_mode: McpPluginToolsMode::default(),
        }
    }
}

/// Where a resolved level came from (settings preview).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum McpAccessSource {
    Default,
    Group { id: String },
    Connection,
    Scope,
}

/// The resolved access of one connection or sub-scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResolvedAccess {
    pub visible: bool,
    pub level: McpAccessLevel,
    pub source: McpAccessSource,
}

impl McpAccessPolicy {
    fn rule(&self, target: &McpRuleTarget) -> Option<&McpAccessRule> {
        self.rules.get(target)
    }

    fn connection_rule(&self, connection_id: &str) -> Option<&McpAccessRule> {
        self.rule(&McpRuleTarget::Connection { id: connection_id.to_string() })
    }

    /// Whether a connection is reachable at all.
    pub fn connection_visible(&self, group_ids: &[String], connection_id: &str) -> bool {
        let connection = self.connection_rule(connection_id);
        if connection.and_then(|rule| rule.visible) == Some(false) {
            return false;
        }
        match self.visibility {
            McpVisibilityMode::All => true,
            McpVisibilityMode::Selected => {
                connection.and_then(|rule| rule.visible) == Some(true)
                    || group_ids.iter().any(|group_id| {
                        self.rule(&McpRuleTarget::Group { id: group_id.clone() }).and_then(|rule| rule.visible)
                            == Some(true)
                    })
            }
        }
    }

    /// Connection-level access before sub-scopes: closest configured group
    /// (root → leaf, the leaf wins), then the connection rule.
    fn connection_access(&self, group_ids: &[String], connection_id: &str) -> (McpAccessLevel, McpAccessSource) {
        let mut resolved = (self.default_access, McpAccessSource::Default);
        for group_id in group_ids {
            if let Some(level) = self.rule(&McpRuleTarget::Group { id: group_id.clone() }).and_then(|rule| rule.access)
            {
                resolved = (level, McpAccessSource::Group { id: group_id.clone() });
            }
        }
        if let Some(rule) = self.connection_rule(connection_id) {
            if let Some(level) = rule.access {
                resolved = (level, McpAccessSource::Connection);
            }
            if let Some(ceiling) = rule.ceiling.filter(|ceiling| *ceiling < resolved.0) {
                resolved = (ceiling, McpAccessSource::Connection);
            }
        }
        resolved
    }

    /// Whether `value` of sub-scope kind `scope` is admitted below a connection.
    pub fn sub_scope_visible(&self, connection_id: &str, scope: &str, value: &str) -> bool {
        let target = McpRuleTarget::Scope {
            connection_id: connection_id.to_string(),
            scope: scope.to_string(),
            value: value.to_string(),
        };
        let rule = self.rule(&target);
        if rule.and_then(|rule| rule.visible) == Some(false) {
            return false;
        }
        match self.connection_rule(connection_id).and_then(|rule| rule.sub_scope).unwrap_or_default() {
            McpSubScopeMode::All => true,
            McpSubScopeMode::Selected => rule.and_then(|rule| rule.visible) == Some(true),
            McpSubScopeMode::None => false,
        }
    }

    /// Returns the admission mode configured on a connection. Callers that
    /// require an explicit scope argument use this to fail closed when the
    /// connection only permits selected scopes or no scopes.
    pub fn sub_scope_mode(&self, connection_id: &str) -> McpSubScopeMode {
        self.connection_rule(connection_id).and_then(|rule| rule.sub_scope).unwrap_or_default()
    }

    /// Whether a request that enumerates every value of a sub-scope can be
    /// admitted without evaluating each value separately. This is only safe
    /// when the connection explicitly permits all sub-scopes and no rule
    /// hides or denies one of them. Callers still enforce the connection's
    /// minimum access level for the operation itself.
    pub fn sub_scope_allows_all(&self, connection_id: &str, scope: &str) -> bool {
        if self.sub_scope_mode(connection_id) != McpSubScopeMode::All {
            return false;
        }
        !self.rules.iter().any(|(target, rule)| {
            matches!(
                target,
                McpRuleTarget::Scope {
                    connection_id: target_connection,
                    scope: target_scope,
                    ..
                } if target_connection == connection_id && target_scope == scope
            ) && (rule.visible == Some(false)
                || rule.access == Some(McpAccessLevel::None)
                || rule.ceiling == Some(McpAccessLevel::None))
        })
    }

    /// Resolves one connection (with `sub_scope = None`) or one sub-scope value.
    pub fn resolve(
        &self,
        group_ids: &[String],
        connection_id: &str,
        sub_scope: Option<(&str, &str)>,
    ) -> McpResolvedAccess {
        let visible = self.connection_visible(group_ids, connection_id)
            && sub_scope.is_none_or(|(scope, value)| self.sub_scope_visible(connection_id, scope, value));
        let (mut level, mut source) = self.connection_access(group_ids, connection_id);
        if let Some((scope, value)) = sub_scope {
            let target = McpRuleTarget::Scope {
                connection_id: connection_id.to_string(),
                scope: scope.to_string(),
                value: value.to_string(),
            };
            if let Some(rule) = self.rule(&target) {
                if let Some(scoped) = rule.access {
                    level = scoped;
                    source = McpAccessSource::Scope;
                }
                if let Some(ceiling) = rule.ceiling.filter(|ceiling| *ceiling < level) {
                    level = ceiling;
                    source = McpAccessSource::Scope;
                }
            }
        }
        McpResolvedAccess { visible, level: if visible { level } else { McpAccessLevel::None }, source }
    }

    /// A toolset ceiling on the connection narrows the resolved level for
    /// calls of that toolset (e.g. Salesforce writes).
    pub fn toolset_ceiling(&self, connection_id: &str, toolset: &str) -> Option<McpAccessLevel> {
        self.connection_rule(connection_id)
            .and_then(|rule| rule.toolset_ceilings.get(toolset).copied())
            // Salesforce requires a separate, explicit opt-in. Visibility and
            // inherited write access must never manufacture that permission.
            .or_else(|| (toolset == SALESFORCE_WRITE_TOOLSET).then_some(McpAccessLevel::Read))
    }

    /// Whether a connection carries sub-scope rules, which makes cross-scope
    /// references (SQL naming another database) unverifiable per call.
    pub fn has_scope_rules(&self, connection_id: &str) -> bool {
        self.rules
            .keys()
            .any(|target| matches!(target, McpRuleTarget::Scope { connection_id: id, .. } if id == connection_id))
    }

    // -----------------------------------------------------------------------
    // v1 mapping
    // -----------------------------------------------------------------------

    /// Maps a persisted v1 policy losslessly. Versioned connection and
    /// database rules become overrides; legacy (unversioned) rules become
    /// ceilings, preserving their "never wider than inherited" semantics.
    pub fn from_v1(policy: &McpGlobalPolicy) -> Self {
        let policy = policy.normalized();
        let mut rules = BTreeMap::<McpRuleTarget, McpAccessRule>::new();
        let visibility =
            if policy.allowed_connection_ids.is_some() { McpVisibilityMode::Selected } else { McpVisibilityMode::All };
        for connection_id in policy.allowed_connection_ids.iter().flatten() {
            rules.entry(McpRuleTarget::Connection { id: connection_id.clone() }).or_default().visible = Some(true);
        }
        for group_id in &policy.allowed_group_ids {
            rules.entry(McpRuleTarget::Group { id: group_id.clone() }).or_default().visible = Some(true);
        }
        for group in &policy.group_policies {
            rules.entry(McpRuleTarget::Group { id: group.group_id.clone() }).or_default().access =
                Some(McpAccessLevel::from_flags(group.read_only, group.allow_dangerous_sql));
        }
        for connection in &policy.connection_policies {
            let versioned =
                connection.execution_mode_policy_version == Some(crate::mcp_policy::MCP_EXECUTION_POLICY_VERSION);
            let connection_level = McpAccessLevel::from_flags(connection.read_only, connection.allow_dangerous_sql);
            {
                let rule = rules.entry(McpRuleTarget::Connection { id: connection.connection_id.clone() }).or_default();
                rule.sub_scope = Some(match connection.database_scope {
                    McpDatabaseScope::All => McpSubScopeMode::All,
                    McpDatabaseScope::Selected => McpSubScopeMode::Selected,
                    McpDatabaseScope::None => McpSubScopeMode::None,
                });
                if connection.execution_mode_configured {
                    if versioned {
                        rule.access = Some(connection_level);
                    } else {
                        rule.ceiling = Some(connection_level);
                    }
                }
                rule.toolset_ceilings.insert(
                    SALESFORCE_WRITE_TOOLSET.to_string(),
                    if connection.allow_salesforce_dml && !connection.read_only {
                        McpAccessLevel::Full
                    } else {
                        McpAccessLevel::Read
                    },
                );
            }
            let scope_target = |database: &str| McpRuleTarget::Scope {
                connection_id: connection.connection_id.clone(),
                scope: "database".to_string(),
                value: database.to_string(),
            };
            for database in &connection.allowed_databases {
                rules.entry(scope_target(database)).or_default().visible = Some(true);
            }
            for database_policy in &connection.database_policies {
                let level = McpAccessLevel::from_flags(database_policy.read_only, database_policy.allow_dangerous_sql);
                let rule = rules.entry(scope_target(&database_policy.database_name)).or_default();
                if versioned {
                    rule.access = Some(level);
                } else {
                    rule.ceiling = Some(level);
                }
            }
        }
        Self {
            version: MCP_ACCESS_POLICY_VERSION,
            default_access: McpAccessLevel::from_flags(policy.read_only, policy.allow_dangerous_sql),
            confirm: policy.confirmation_policy(),
            visibility,
            rules,
            allowed_tool_names: policy.allowed_tool_names.clone(),
            query_timeout_secs: policy.query_timeout_secs,
            plugin_tools_mode: policy.plugin_tools_mode,
        }
    }
}

impl McpAccessPolicy {
    fn projected_toolset_ceiling(&self, connection_id: &str) -> Option<McpAccessLevel> {
        self.connection_rule(connection_id)?
            .toolset_ceilings
            .iter()
            .filter(|(toolset, _)| toolset.as_str() != SALESFORCE_WRITE_TOOLSET)
            .map(|(_, ceiling)| *ceiling)
            .min()
    }

    /// The strictest level a connection can resolve to across any group
    /// placement: the minimum of the default, every group level, and its
    /// own override. Used where v1 cannot express group-relative ceilings.
    fn strictest_connection_level(&self, connection_id: &str) -> McpAccessLevel {
        let mut strictest = self.default_access;
        for (target, rule) in &self.rules {
            if let (McpRuleTarget::Group { .. }, Some(level)) = (target, rule.access) {
                strictest = strictest.min(level);
            }
        }
        if let Some(rule) = self.connection_rule(connection_id) {
            if let Some(level) = rule.access {
                strictest = level;
            }
            if let Some(ceiling) = rule.ceiling {
                strictest = strictest.min(ceiling);
            }
        }
        strictest
    }

    /// Earlier v2 snapshots represented an explicit Salesforce opt-in by an
    /// absent ceiling. Recover it only from a saved v1 opt-in; an ambiguous
    /// standalone or visibility-only v2 rule remains denied. Existing ceilings win.
    pub(crate) fn restore_legacy_salesforce_opt_ins(&mut self, legacy: &McpGlobalPolicy) {
        for connection in &legacy.connection_policies {
            if connection.allow_salesforce_dml && !connection.read_only {
                if let Some(rule) =
                    self.rules.get_mut(&McpRuleTarget::Connection { id: connection.connection_id.clone() })
                {
                    // A legacy explicit connection policy always had a database
                    // admission mode. Visibility alone is not opt-in evidence.
                    if rule.sub_scope.is_some() {
                        rule.toolset_ceilings
                            .entry(SALESFORCE_WRITE_TOOLSET.to_string())
                            .or_insert(McpAccessLevel::Full);
                    }
                }
            }
        }
    }

    /// Projects the v2 policy onto v1 fields for hosts that only read v1
    /// (an older standalone `dbx-mcp`). The projection is never wider than
    /// v2: anything v1 cannot express collapses to the stricter reading —
    /// a `none` level hides the node, a ceiling becomes a versioned
    /// override computed against the default, sub-scope rules for kinds
    /// other than `database` are dropped only when they could not widen.
    pub fn to_v1(&self) -> McpGlobalPolicy {
        use crate::storage::{McpConnectionPolicy, McpDatabasePolicy, McpGroupPolicy};
        let flags = |level: McpAccessLevel| level.to_flags();
        let mut allowed_connection_ids = (self.visibility == McpVisibilityMode::Selected).then(Vec::new);
        let mut allowed_group_ids = Vec::new();
        let mut group_policies = Vec::new();
        let mut connection_policies = BTreeMap::<String, McpConnectionPolicy>::new();
        let mut hidden_connections = Vec::new();
        let blank = |id: &str| McpConnectionPolicy {
            connection_id: id.to_string(),
            read_only: false,
            allow_dangerous_sql: false,
            execution_mode_configured: false,
            execution_mode_policy_version: Some(crate::mcp_policy::MCP_EXECUTION_POLICY_VERSION),
            database_scope: McpDatabaseScope::All,
            allowed_databases: Vec::new(),
            database_policies: Vec::new(),
            allow_salesforce_dml: false,
        };
        for (target, rule) in &self.rules {
            match target {
                McpRuleTarget::Group { id } => {
                    if rule.visible == Some(true) && self.visibility == McpVisibilityMode::Selected {
                        allowed_group_ids.push(id.clone());
                    }
                    if let Some(level) = rule.access {
                        let (read_only, allow_dangerous_sql) = flags(level.max(McpAccessLevel::Read));
                        group_policies.push(McpGroupPolicy { group_id: id.clone(), read_only, allow_dangerous_sql });
                    }
                }
                McpRuleTarget::Connection { id } => {
                    if rule.visible == Some(false)
                        || rule.access == Some(McpAccessLevel::None)
                        || rule.ceiling == Some(McpAccessLevel::None)
                    {
                        hidden_connections.push(id.clone());
                    } else if rule.visible == Some(true) {
                        if let Some(ids) = allowed_connection_ids.as_mut() {
                            ids.push(id.clone());
                        }
                    }
                    let policy = connection_policies.entry(id.clone()).or_insert_with(|| blank(id));
                    // A ceiling is pinned as an override against the default:
                    // v1 overrides cannot be narrower than "inherit or tighter"
                    // unless set explicitly, so pinning is the strict reading.
                    let level = match (rule.access, rule.ceiling) {
                        (Some(access), Some(ceiling)) => Some(access.min(ceiling)),
                        (Some(access), None) => Some(access),
                        (None, Some(ceiling)) => Some(ceiling.min(self.strictest_connection_level(id))),
                        (None, None) => None,
                    };
                    // v1 has one connection-wide execution level. Projecting
                    // any toolset-specific ceiling to the strictest one keeps
                    // older hosts from widening a v2-restricted toolset.
                    let level = self.projected_toolset_ceiling(id).map_or(level, |ceiling| {
                        Some(level.unwrap_or_else(|| self.strictest_connection_level(id)).min(ceiling))
                    });
                    if level == Some(McpAccessLevel::None) && !hidden_connections.contains(id) {
                        hidden_connections.push(id.clone());
                    }
                    if let Some(level) = level {
                        (policy.read_only, policy.allow_dangerous_sql) = flags(level.max(McpAccessLevel::Read));
                        policy.execution_mode_configured = true;
                    }
                    policy.database_scope = match rule.sub_scope.unwrap_or_default() {
                        McpSubScopeMode::All => McpDatabaseScope::All,
                        McpSubScopeMode::Selected => McpDatabaseScope::Selected,
                        McpSubScopeMode::None => McpDatabaseScope::None,
                    };
                    policy.allow_salesforce_dml = rule
                        .toolset_ceilings
                        .get(SALESFORCE_WRITE_TOOLSET)
                        .is_some_and(|ceiling| *ceiling > McpAccessLevel::Read)
                        && !policy.read_only;
                }
                McpRuleTarget::Scope { connection_id, scope, value } => {
                    let policy =
                        connection_policies.entry(connection_id.clone()).or_insert_with(|| blank(connection_id));
                    if scope != "database" {
                        // v1 has no other sub-scope kind: deny the whole
                        // connection's sub-scopes rather than widen.
                        if rule.visible == Some(false) || rule.access.is_some() || rule.ceiling.is_some() {
                            policy.database_scope = McpDatabaseScope::None;
                        }
                        continue;
                    }
                    let hidden = rule.visible == Some(false)
                        || rule.access == Some(McpAccessLevel::None)
                        || rule.ceiling == Some(McpAccessLevel::None);
                    if rule.visible == Some(true) && !hidden {
                        policy.allowed_databases.push(value.clone());
                    }
                    // A ceiling caps whatever the database would inherit. The
                    // inherited level depends on the connection's groups,
                    // which v1 database rules cannot see, so cap it with the
                    // strictest level the connection could inherit.
                    let level = match (rule.access, rule.ceiling) {
                        (Some(access), Some(ceiling)) => Some(access.min(ceiling)),
                        (Some(access), None) => Some(access),
                        (None, Some(ceiling)) => Some(ceiling.min(self.strictest_connection_level(connection_id))),
                        (None, None) => None,
                    };
                    // v1 database overrides replace the connection level, so
                    // every override must also carry the toolset ceiling.
                    let level = level.map(|level| {
                        self.projected_toolset_ceiling(connection_id).map_or(level, |ceiling| level.min(ceiling))
                    });
                    if let Some(level) = level.filter(|_| !hidden) {
                        let (read_only, allow_dangerous_sql) = flags(level.max(McpAccessLevel::Read));
                        policy.database_policies.push(McpDatabasePolicy {
                            database_name: value.clone(),
                            read_only,
                            allow_dangerous_sql,
                        });
                    }
                }
            }
        }
        // v1 expresses per-database levels and hidden databases only under a
        // `selected` scope; promote `all` to `selected` with every visible
        // database listed would need the live database list, so hidden or
        // levelled databases under `all` fall back to denying the scope.
        for policy in connection_policies.values_mut() {
            let has_database_rules = self.rules.iter().any(|(target, _)| {
                matches!(target, McpRuleTarget::Scope { connection_id, scope, .. } if connection_id == &policy.connection_id && scope == "database")
            });
            if policy.database_scope == McpDatabaseScope::All && has_database_rules {
                policy.database_scope = McpDatabaseScope::Selected;
                let listed = policy.allowed_databases.clone();
                policy.database_policies.retain(|database| listed.contains(&database.database_name));
            }
        }
        for id in &hidden_connections {
            // v1 can only hide a connection through an allowlist, which would
            // need the full connection list here. Remove it from an existing
            // allowlist, and otherwise lock it down: no database is reachable
            // and every write is refused.
            if let Some(ids) = allowed_connection_ids.as_mut() {
                ids.retain(|candidate| candidate != id);
            }
            let policy = connection_policies.entry(id.clone()).or_insert_with(|| blank(id));
            policy.read_only = true;
            policy.allow_dangerous_sql = false;
            policy.allow_salesforce_dml = false;
            policy.execution_mode_configured = true;
            policy.database_scope = McpDatabaseScope::None;
            policy.allowed_databases.clear();
            policy.database_policies.clear();
        }
        // v1 has no way to express an exclusion for one connection. A
        // connection policy can still lock that connection down for
        // execution, but older hosts use only the global allowlist and group
        // visibility when enumerating and resolving connections. Switch to a
        // strict allowlist containing only explicitly visible connection
        // rules and drop group visibility, so the projection cannot re-expose
        // a hidden connection through an allowed group. This may hide
        // additional unlisted connections on a v1 host, which is the safe
        // direction for a lossy projection.
        let restricted_ancestors = self.default_access == McpAccessLevel::None
            || self.rules.iter().any(|(target, rule)| {
                matches!(target, McpRuleTarget::Group { .. })
                    && (rule.visible == Some(false)
                        || rule.access == Some(McpAccessLevel::None)
                        || rule.ceiling == Some(McpAccessLevel::None))
            });
        if !hidden_connections.is_empty() || restricted_ancestors {
            let explicitly_visible = self
                .rules
                .iter()
                .filter_map(|(target, rule)| match target {
                    McpRuleTarget::Connection { id }
                        if rule.visible == Some(true)
                            && !hidden_connections.contains(id)
                            && (!restricted_ancestors
                                || rule.access.is_some_and(|level| level > McpAccessLevel::None)) =>
                    {
                        Some(id.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            allowed_connection_ids = Some(explicitly_visible);
            allowed_group_ids.clear();
        }
        let (read_only, allow_dangerous_sql) = flags(self.default_access.max(McpAccessLevel::Read));
        McpGlobalPolicy {
            read_only: read_only || self.default_access == McpAccessLevel::None,
            allow_dangerous_sql,
            prompt_high_risk_sql: self.confirm == McpConfirmPolicy::Full,
            call_confirmation: (self.confirm == McpConfirmPolicy::HighRisk).then_some(self.confirm),
            allowed_connection_ids,
            allowed_group_ids,
            allowed_tool_names: self.allowed_tool_names.clone(),
            connection_policies: connection_policies.into_values().collect(),
            group_policies,
            query_timeout_secs: self.query_timeout_secs,
            plugin_tools_mode: self.plugin_tools_mode,
        }
        .normalized()
    }
}

/// The three answers every MCP host needs for one (connection, database)
/// pair, computed from the v2 policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpDatabaseDecision {
    /// The connection is reachable.
    pub connection_visible: bool,
    /// The database is admitted below the connection.
    pub database_visible: bool,
    /// v1-shaped execution flags (`read_only`, `allow_dangerous_sql`).
    pub flags: (bool, bool),
}

impl McpAccessPolicy {
    /// Decision for `database` on `connection_id`; an empty database name
    /// resolves the connection level (connection-default operations).
    pub fn decide(&self, group_ids: &[String], connection_id: &str, database: &str) -> McpDatabaseDecision {
        let connection_visible = self.connection_visible(group_ids, connection_id);
        let sub_scope = (!database.is_empty()).then_some(("database", database));
        let resolved = self.resolve(group_ids, connection_id, sub_scope);
        let database_visible = connection_visible
            && sub_scope.is_none_or(|(scope, value)| self.sub_scope_visible(connection_id, scope, value));
        // Flags follow the level even for hidden scopes so callers that check
        // visibility separately still get the strict reading.
        let level = if database_visible {
            resolved.level
        } else {
            self.resolve_level_ignoring_visibility(group_ids, connection_id, sub_scope)
        };
        McpDatabaseDecision { connection_visible, database_visible, flags: level.max(McpAccessLevel::Read).to_flags() }
    }

    fn resolve_level_ignoring_visibility(
        &self,
        group_ids: &[String],
        connection_id: &str,
        sub_scope: Option<(&str, &str)>,
    ) -> McpAccessLevel {
        let mut visible_everywhere = self.clone();
        visible_everywhere.visibility = McpVisibilityMode::All;
        for rule in visible_everywhere.rules.values_mut() {
            rule.visible = None;
            rule.sub_scope = None;
        }
        visible_everywhere.resolve(group_ids, connection_id, sub_scope).level
    }
}

impl McpAccessPolicy {
    /// Carries over the rules v1 cannot express — sub-scope rules of kinds
    /// other than `database` (plugin scopes) and the connection sub-scope
    /// modes they rely on — from `previous` into a policy rebuilt from v1.
    /// Lets the v1 settings form save without erasing plugin scope rules.
    pub fn with_v2_only_rules_from(mut self, previous: &McpAccessPolicy) -> Self {
        // Preserve the admission mode even when the user has not selected a
        // concrete value yet. Without this pass, a connection configured as
        // `selected` or `none` silently reverted to `all` on the next v1 save.
        for (target, rule) in &previous.rules {
            let McpRuleTarget::Connection { id } = target else { continue };
            let Some(mode) = rule.sub_scope else { continue };
            let non_database_scope = rule.sub_scope_kind.as_deref().is_some_and(|kind| kind != "database")
                || previous.rules.keys().any(|target| matches!(target, McpRuleTarget::Scope { connection_id, scope, .. } if connection_id == id && scope != "database"));
            if non_database_scope {
                let connection = self.rules.entry(target.clone()).or_default();
                connection.sub_scope = Some(mode);
                connection.sub_scope_kind.clone_from(&rule.sub_scope_kind);
            }
        }
        for (target, rule) in &previous.rules {
            let McpRuleTarget::Connection { .. } = target else { continue };
            if rule.toolset_ceilings.keys().all(|toolset| toolset == SALESFORCE_WRITE_TOOLSET) {
                continue;
            }
            let connection = self.rules.entry(target.clone()).or_default();
            for (toolset, ceiling) in &rule.toolset_ceilings {
                // Salesforce DML is explicitly editable by v1.
                if toolset == SALESFORCE_WRITE_TOOLSET {
                    continue;
                }
                connection
                    .toolset_ceilings
                    .entry(toolset.clone())
                    .and_modify(|current| *current = (*current).min(*ceiling))
                    .or_insert(*ceiling);
            }
        }
        for (target, rule) in &previous.rules {
            if let McpRuleTarget::Scope { scope, .. } = target {
                if scope != "database" {
                    self.rules.insert(target.clone(), rule.clone());
                }
            }
        }
        self
    }
}

/// Convenience: v1 visibility check expressed through the v2 resolver, used
/// by the equivalence tests and by callers that migrate incrementally.
pub fn v1_connection_visible(
    policy: &McpGlobalPolicy,
    group_path: Option<&McpConnectionGroupPath>,
    connection_id: &str,
) -> bool {
    policy_allows_connection(policy, group_path, connection_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_policy::{effective_database_execution_policy_with_groups, MCP_EXECUTION_POLICY_VERSION};
    #[allow(unused_imports)]
    use crate::storage::McpDatabaseScope;
    use crate::storage::{McpConnectionPolicy, McpDatabasePolicy, McpGroupPolicy};

    fn connection_rule(id: &str) -> McpConnectionPolicy {
        McpConnectionPolicy {
            connection_id: id.to_string(),
            read_only: false,
            allow_dangerous_sql: false,
            execution_mode_configured: false,
            execution_mode_policy_version: Some(MCP_EXECUTION_POLICY_VERSION),
            database_scope: McpDatabaseScope::All,
            allowed_databases: Vec::new(),
            database_policies: Vec::new(),
            allow_salesforce_dml: false,
        }
    }

    #[test]
    fn visibility_only_does_not_opt_in_to_salesforce_dml() {
        for allowed in [None, Some(vec!["sf".to_string()])] {
            let policy = McpGlobalPolicy { allowed_connection_ids: allowed, ..Default::default() };
            let access = McpAccessPolicy::from_v1(&policy);
            assert_eq!(access.toolset_ceiling("sf", SALESFORCE_WRITE_TOOLSET), Some(McpAccessLevel::Read));
            assert!(!crate::mcp_policy::connection_allows_salesforce_dml(&access.to_v1(), "sf"));
        }
        for allowed in [false, true] {
            let mut rule = connection_rule("sf");
            rule.allow_salesforce_dml = allowed;
            let policy = McpGlobalPolicy { connection_policies: vec![rule], ..Default::default() };
            assert_eq!(
                crate::mcp_policy::connection_allows_salesforce_dml(&McpAccessPolicy::from_v1(&policy).to_v1(), "sf"),
                allowed
            );
        }
    }

    #[test]
    fn legacy_salesforce_opt_in_requires_explicit_v1_evidence_and_respects_ceiling() {
        let mut access = McpAccessPolicy::default();
        access.rules.insert(
            McpRuleTarget::Connection { id: "sf".into() },
            McpAccessRule { visible: Some(true), ..Default::default() },
        );
        let mut rule = connection_rule("sf");
        let mut legacy = McpGlobalPolicy { connection_policies: vec![rule.clone()], ..Default::default() };
        access.restore_legacy_salesforce_opt_ins(&legacy);
        assert!(!crate::mcp_policy::connection_allows_salesforce_dml(&access.to_v1(), "sf"));
        rule.allow_salesforce_dml = true;
        legacy.connection_policies = vec![rule];
        access.restore_legacy_salesforce_opt_ins(&legacy);
        assert!(!crate::mcp_policy::connection_allows_salesforce_dml(&access.to_v1(), "sf"));
        access.rules.get_mut(&McpRuleTarget::Connection { id: "sf".into() }).unwrap().sub_scope =
            Some(McpSubScopeMode::All);
        access.restore_legacy_salesforce_opt_ins(&legacy);
        assert!(crate::mcp_policy::connection_allows_salesforce_dml(&access.to_v1(), "sf"));
        access
            .rules
            .get_mut(&McpRuleTarget::Connection { id: "sf".into() })
            .unwrap()
            .toolset_ceilings
            .insert(SALESFORCE_WRITE_TOOLSET.into(), McpAccessLevel::Read);
        access.restore_legacy_salesforce_opt_ins(&legacy);
        assert!(!crate::mcp_policy::connection_allows_salesforce_dml(&access.to_v1(), "sf"));
    }

    #[test]
    fn removing_database_rule_reopens_databases_but_retains_plugin_admission() {
        for mode in [McpDatabaseScope::Selected, McpDatabaseScope::None] {
            let mut rule = connection_rule("sql");
            rule.database_scope = mode;
            rule.allowed_databases = vec!["one".into()];
            let previous =
                McpAccessPolicy::from_v1(&McpGlobalPolicy { connection_policies: vec![rule], ..Default::default() });
            let next = McpAccessPolicy::from_v1(&McpGlobalPolicy::default()).with_v2_only_rules_from(&previous);
            assert!(next.sub_scope_visible("sql", "database", "two"));
            assert!(!next.rules.contains_key(&McpRuleTarget::Connection { id: "sql".into() }));
        }
        let mut previous = McpAccessPolicy::default();
        previous.rules.insert(
            McpRuleTarget::Connection { id: "plugin".into() },
            McpAccessRule {
                sub_scope: Some(McpSubScopeMode::None),
                sub_scope_kind: Some("custom".into()),
                ..Default::default()
            },
        );
        let next = McpAccessPolicy::default().with_v2_only_rules_from(&previous);
        assert!(!next.sub_scope_visible("plugin", "custom", "one"));
    }

    /// Deterministic pseudo-random generator so the equivalence sweep is reproducible.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn bool(&mut self) -> bool {
            self.next().is_multiple_of(2)
        }
        fn pick<T: Copy>(&mut self, items: &[T]) -> T {
            items[(self.next() as usize) % items.len()]
        }
    }

    const CONNECTIONS: [&str; 3] = ["c1", "c2", "c3"];
    const GROUPS: [&str; 2] = ["g-root", "g-leaf"];
    const DATABASES: [&str; 3] = ["db_a", "db_b", "db_c"];

    fn group_path(connection: &str) -> McpConnectionGroupPath {
        match connection {
            "c1" => McpConnectionGroupPath {
                ids: vec!["g-root".into(), "g-leaf".into()],
                names: vec!["Root".into(), "Leaf".into()],
            },
            "c2" => McpConnectionGroupPath { ids: vec!["g-root".into()], names: vec!["Root".into()] },
            _ => McpConnectionGroupPath::default(),
        }
    }

    fn random_policy(rng: &mut Lcg) -> McpGlobalPolicy {
        let flags = |rng: &mut Lcg| (rng.bool(), rng.bool());
        let (read_only, allow_dangerous_sql) = flags(rng);
        let allowed_connection_ids =
            rng.bool().then(|| CONNECTIONS.iter().filter(|_| rng.bool()).map(|id| id.to_string()).collect());
        let allowed_group_ids = GROUPS.iter().filter(|_| rng.bool()).map(|id| id.to_string()).collect();
        let mut group_policies = Vec::new();
        for id in GROUPS {
            if rng.bool() {
                let (read_only, allow_dangerous_sql) = flags(rng);
                group_policies.push(McpGroupPolicy { group_id: id.to_string(), read_only, allow_dangerous_sql });
            }
        }
        let mut connection_policies = Vec::new();
        for id in CONNECTIONS {
            if !rng.bool() {
                continue;
            }
            let mut rule = connection_rule(id);
            (rule.read_only, rule.allow_dangerous_sql) = flags(rng);
            rule.execution_mode_configured = rng.bool();
            rule.execution_mode_policy_version = rng.pick(&[Some(MCP_EXECUTION_POLICY_VERSION), None]);
            rule.database_scope =
                rng.pick(&[McpDatabaseScope::All, McpDatabaseScope::Selected, McpDatabaseScope::None]);
            rule.allowed_databases = DATABASES.iter().filter(|_| rng.bool()).map(|db| db.to_string()).collect();
            for db in DATABASES {
                if rng.bool() {
                    let (read_only, allow_dangerous_sql) = flags(rng);
                    rule.database_policies.push(McpDatabasePolicy {
                        database_name: db.to_string(),
                        read_only,
                        allow_dangerous_sql,
                    });
                }
            }
            rule.allow_salesforce_dml = rng.bool();
            connection_policies.push(rule);
        }
        McpGlobalPolicy {
            read_only,
            allow_dangerous_sql,
            prompt_high_risk_sql: rng.bool(),
            call_confirmation: None,
            allowed_connection_ids,
            allowed_group_ids,
            allowed_tool_names: None,
            connection_policies,
            group_policies,
            query_timeout_secs: None,
            plugin_tools_mode: McpPluginToolsMode::Auto,
        }
        .normalized()
    }

    /// v1 database admission, mirroring the MCP server's DatabaseScope.
    fn v1_database_visible(policy: &McpGlobalPolicy, connection: &str, database: &str) -> bool {
        match policy.connection_policies.iter().find(|rule| rule.connection_id == connection) {
            None => true,
            Some(rule) => match rule.database_scope {
                McpDatabaseScope::All => true,
                McpDatabaseScope::Selected => rule.allowed_databases.iter().any(|allowed| allowed == database),
                McpDatabaseScope::None => false,
            },
        }
    }

    #[test]
    fn call_safety_authorizes_before_confirming_and_preserves_legacy() {
        use McpAccessLevel::{Full, None, Read, Write};
        use McpCallDecision::{Allow, Confirm, Deny};
        for actual in [None, Read, Write, Full] {
            for required in [Read, Write, Full] {
                for high_risk in [false, true] {
                    assert_eq!(
                        McpConfirmPolicy::HighRisk.decide(actual, required, high_risk),
                        if actual < required {
                            Deny
                        } else if high_risk {
                            Confirm
                        } else {
                            Allow
                        }
                    );
                    assert_eq!(
                        McpConfirmPolicy::Off.decide(actual, required, high_risk),
                        if actual < required { Deny } else { Allow }
                    );
                }
            }
        }
        assert_eq!(McpConfirmPolicy::Full.decide(Write, Full, true), Confirm);
        assert_eq!(McpConfirmPolicy::Full.decide(Full, Full, true), Allow);
        assert_eq!(McpConfirmPolicy::Full.decide(Read, Full, true), Deny);
    }

    #[test]
    fn confirmation_migration_is_explicit_and_roundtrips() {
        for (field, old, expected) in [
            (serde_json::Value::Null, true, McpConfirmPolicy::Full),
            (serde_json::Value::Null, false, McpConfirmPolicy::Off),
            (serde_json::json!("off"), true, McpConfirmPolicy::Off),
            (serde_json::json!("high_risk"), true, McpConfirmPolicy::HighRisk),
        ] {
            let policy: McpGlobalPolicy = serde_json::from_value(serde_json::json!({
                "readOnly": false, "allowDangerousSql": true,
                "promptHighRiskSql": old, "callConfirmation": field,
            }))
            .unwrap();
            let normalized = policy.normalized();
            assert_eq!(normalized.confirmation_policy(), expected);
            let v2 = McpAccessPolicy::from_v1(&normalized);
            assert_eq!(v2.confirm, expected);
            assert_eq!(v2.to_v1().normalized(), normalized);
            assert_eq!(normalized.prompt_high_risk_sql, expected == McpConfirmPolicy::Full);
        }
        assert_eq!(serde_json::from_str::<McpConfirmPolicy>("\"full\"").unwrap(), McpConfirmPolicy::Full);
        assert_eq!(McpGlobalPolicy::default().confirmation_policy(), McpConfirmPolicy::Off);
    }

    #[test]
    fn v2_reproduces_every_v1_decision() {
        let mut rng = Lcg(0x5eed_d8c4);
        for case in 0..4_000 {
            let v1 = random_policy(&mut rng);
            let v2 = McpAccessPolicy::from_v1(&v1);
            for connection in CONNECTIONS {
                let path = group_path(connection);
                let visible_v1 = policy_allows_connection(&v1, Some(&path), connection);
                assert_eq!(
                    v2.connection_visible(&path.ids, connection),
                    visible_v1,
                    "case {case}: visibility of {connection}\nv1={v1:#?}\nv2={v2:#?}"
                );
                for database in DATABASES {
                    let resolved = v2.resolve(&path.ids, connection, Some(("database", database)));
                    let admitted_v1 = visible_v1 && v1_database_visible(&v1, connection, database);
                    assert_eq!(
                        resolved.visible, admitted_v1,
                        "case {case}: admission of {connection}/{database}\nv1={v1:#?}\nv2={v2:#?}"
                    );
                    if !admitted_v1 {
                        continue;
                    }
                    let flags_v1 =
                        effective_database_execution_policy_with_groups(&v1, &path.ids, connection, database);
                    assert_eq!(
                        resolved.level.to_flags(),
                        flags_v1,
                        "case {case}: level of {connection}/{database}\nv1={v1:#?}\nv2={v2:#?}"
                    );
                }
                let salesforce_v1 = crate::mcp_policy::connection_allows_salesforce_dml(&v1, connection);
                let salesforce_v2 = v2
                    .toolset_ceiling(connection, SALESFORCE_WRITE_TOOLSET)
                    .is_none_or(|ceiling| ceiling > McpAccessLevel::Read)
                    && v1.connection_policies.iter().any(|rule| rule.connection_id == connection);
                assert_eq!(salesforce_v2, salesforce_v1, "case {case}: salesforce DML of {connection}");
            }
            assert_eq!(v2.confirm == McpConfirmPolicy::Full, v1.prompt_high_risk_sql);
        }
    }

    #[test]
    fn v1_round_trip_through_v2_is_never_wider() {
        let mut rng = Lcg(0x0b5e_55ed);
        for case in 0..4_000 {
            let v1 = random_policy(&mut rng);
            let projected = McpAccessPolicy::from_v1(&v1).to_v1();
            for connection in CONNECTIONS {
                let path = group_path(connection);
                let visible = policy_allows_connection(&v1, Some(&path), connection);
                let projected_visible = policy_allows_connection(&projected, Some(&path), connection);
                assert!(
                    !projected_visible || visible,
                    "case {case}: projection widened visibility of {connection}\nv1={v1:#?}\nprojected={projected:#?}"
                );
                if !projected_visible {
                    continue;
                }
                for database in DATABASES {
                    if !v1_database_visible(&projected, connection, database) {
                        continue;
                    }
                    assert!(
                        v1_database_visible(&v1, connection, database),
                        "case {case}: projection widened {connection}/{database}"
                    );
                    let original = McpAccessLevel::from_flags_pair(effective_database_execution_policy_with_groups(
                        &v1, &path.ids, connection, database,
                    ));
                    let after = McpAccessLevel::from_flags_pair(effective_database_execution_policy_with_groups(
                        &projected, &path.ids, connection, database,
                    ));
                    assert!(after <= original, "case {case}: projection widened level of {connection}/{database}: {after:?} > {original:?}\nv1={v1:#?}\nprojected={projected:#?}");
                }
            }
        }
    }

    #[test]
    fn projection_hides_none_levels_and_unknown_scope_kinds() {
        let mut policy = McpAccessPolicy { default_access: McpAccessLevel::Write, ..Default::default() };
        policy.rules.insert(
            McpRuleTarget::Connection { id: "c".into() },
            McpAccessRule { access: Some(McpAccessLevel::None), ..Default::default() },
        );
        policy.rules.insert(
            McpRuleTarget::Scope { connection_id: "k".into(), scope: "namespace".into(), value: "prod".into() },
            McpAccessRule { access: Some(McpAccessLevel::Read), ..Default::default() },
        );
        let v1 = policy.to_v1();
        let c = v1.connection_policies.iter().find(|rule| rule.connection_id == "c").unwrap();
        assert!(c.read_only && c.database_scope == McpDatabaseScope::None, "a none level locks the connection down");
        assert!(!policy_allows_connection(&v1, None, "other"), "lossy v1 projection must fail closed");
        let k = v1.connection_policies.iter().find(|rule| rule.connection_id == "k").unwrap();
        assert_eq!(k.database_scope, McpDatabaseScope::None, "unknown sub-scope kinds deny rather than widen");
    }

    #[test]
    fn projection_of_hidden_connection_under_all_uses_strict_allowlist() {
        let mut policy = McpAccessPolicy { default_access: McpAccessLevel::Full, ..Default::default() };
        policy.rules.insert(
            McpRuleTarget::Connection { id: "hidden".into() },
            McpAccessRule { visible: Some(false), ..Default::default() },
        );
        policy.rules.insert(
            McpRuleTarget::Connection { id: "visible".into() },
            McpAccessRule { visible: Some(true), ..Default::default() },
        );

        let projected = policy.to_v1();
        assert_eq!(projected.allowed_connection_ids, Some(vec!["visible".to_string()]));
        assert!(policy_allows_connection(&projected, None, "visible"));
        assert!(!policy_allows_connection(&projected, None, "hidden"));
        assert!(!policy_allows_connection(&projected, None, "unlisted"));

        let mut selected = policy;
        selected.visibility = McpVisibilityMode::Selected;
        selected.rules.insert(
            McpRuleTarget::Group { id: "group".into() },
            McpAccessRule { visible: Some(true), ..Default::default() },
        );
        let projected = selected.to_v1();
        assert!(projected.allowed_group_ids.is_empty(), "group visibility must not bypass a hidden connection");
        assert!(!policy_allows_connection(
            &projected,
            Some(&McpConnectionGroupPath { ids: vec!["group".into()], names: vec![] }),
            "hidden"
        ));
    }

    #[test]
    fn projection_and_v1_save_preserve_unknown_toolset_ceilings_conservatively() {
        let mut policy = McpAccessPolicy { default_access: McpAccessLevel::Full, ..Default::default() };
        let mut connection = McpAccessRule { access: Some(McpAccessLevel::Full), ..Default::default() };
        connection.toolset_ceilings.insert("custom.write".into(), McpAccessLevel::Read);
        policy.rules.insert(McpRuleTarget::Connection { id: "c".into() }, connection.clone());

        let projected = policy.to_v1();
        let projected = projected.connection_policies.iter().find(|rule| rule.connection_id == "c").unwrap();
        assert!(projected.read_only, "v1 must conservatively cap the connection at read");
        assert!(!projected.allow_dangerous_sql);

        let saved = McpAccessPolicy::default().with_v2_only_rules_from(&policy);
        assert_eq!(
            saved.toolset_ceiling("c", "custom.write"),
            Some(McpAccessLevel::Read),
            "v1-backed saves must not erase v2-only ceilings"
        );
    }

    #[test]
    fn toolset_ceiling_projection_never_widens_inheritance_or_database_overrides() {
        for inherited in [McpAccessLevel::Read, McpAccessLevel::Write, McpAccessLevel::Full] {
            for ceiling in [McpAccessLevel::Read, McpAccessLevel::Write, McpAccessLevel::Full] {
                for database in [None, Some(McpAccessLevel::Read), Some(McpAccessLevel::Full)] {
                    let mut policy = McpAccessPolicy { default_access: McpAccessLevel::Full, ..Default::default() };
                    policy.rules.insert(
                        McpRuleTarget::Group { id: "parent".into() },
                        McpAccessRule { access: Some(inherited), ..Default::default() },
                    );
                    policy.rules.insert(
                        McpRuleTarget::Connection { id: "c".into() },
                        McpAccessRule {
                            sub_scope: Some(McpSubScopeMode::Selected),
                            toolset_ceilings: [("sql.query".into(), ceiling)].into(),
                            ..Default::default()
                        },
                    );
                    policy.rules.insert(
                        McpRuleTarget::Scope {
                            connection_id: "c".into(),
                            scope: "database".into(),
                            value: "db".into(),
                        },
                        McpAccessRule { access: database, visible: Some(true), ..Default::default() },
                    );
                    let groups = vec!["parent".into()];
                    let expected = policy.resolve(&groups, "c", Some(("database", "db"))).level.min(ceiling);
                    let projected = policy.to_v1();
                    let actual = McpAccessLevel::from_flags_pair(effective_database_execution_policy_with_groups(
                        &projected, &groups, "c", "db",
                    ));
                    assert!(actual <= expected, "{inherited:?}/{ceiling:?}/{database:?}: {actual:?} > {expected:?}");
                }
            }
        }
    }

    #[test]
    fn decide_matches_v1_for_every_generated_policy() {
        let mut rng = Lcg(0xdec1_de00);
        for case in 0..2_000 {
            let v1 = random_policy(&mut rng);
            let v2 = McpAccessPolicy::from_v1(&v1);
            for connection in CONNECTIONS {
                let path = group_path(connection);
                for database in DATABASES {
                    let decision = v2.decide(&path.ids, connection, database);
                    assert_eq!(
                        decision.connection_visible,
                        policy_allows_connection(&v1, Some(&path), connection),
                        "case {case}"
                    );
                    assert_eq!(
                        decision.database_visible,
                        decision.connection_visible && v1_database_visible(&v1, connection, database),
                        "case {case}"
                    );
                    assert_eq!(
                        decision.flags,
                        effective_database_execution_policy_with_groups(&v1, &path.ids, connection, database),
                        "case {case}: {connection}/{database}"
                    );
                }
            }
        }
    }

    #[test]
    /// Policies saved by the current UI (versioned rules only) survive a
    /// v1 → v2 → v1 round trip exactly.
    fn v1_round_trip_through_v2_is_exact() {
        let mut rng = Lcg(0x0e9a_c7ed);
        let mut mismatches = Vec::new();
        for case in 0..4_000 {
            let v1 = random_policy(&mut rng);
            // Legacy unversioned ceilings may come back stricter (covered by
            // `v1_round_trip_through_v2_is_never_wider`).
            if v1.connection_policies.iter().any(|rule| rule.execution_mode_policy_version.is_none()) {
                continue;
            }
            let projected = McpAccessPolicy::from_v1(&v1).to_v1();
            for connection in CONNECTIONS {
                let path = group_path(connection);
                let visible = policy_allows_connection(&v1, Some(&path), connection);
                if visible != policy_allows_connection(&projected, Some(&path), connection) {
                    mismatches.push(format!("case {case}: visibility {connection}"));
                    continue;
                }
                if !visible {
                    continue;
                }
                for database in DATABASES {
                    let admitted = v1_database_visible(&v1, connection, database);
                    if admitted != v1_database_visible(&projected, connection, database) {
                        mismatches.push(format!("case {case}: admission {connection}/{database}"));
                        continue;
                    }
                    if admitted
                        && effective_database_execution_policy_with_groups(&v1, &path.ids, connection, database)
                            != effective_database_execution_policy_with_groups(
                                &projected, &path.ids, connection, database,
                            )
                    {
                        mismatches.push(format!("case {case}: level {connection}/{database}"));
                    }
                }
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} mismatches, first: {:?}",
            mismatches.len(),
            &mismatches[..mismatches.len().min(8)]
        );
    }

    #[test]
    fn v1_projection_never_reexposes_explicitly_selected_denied_nodes() {
        for ceiling in [false, true] {
            let mut access = McpAccessPolicy::default();
            access.rules.insert(
                McpRuleTarget::Connection { id: "blocked".into() },
                McpAccessRule {
                    visible: Some(true),
                    access: (!ceiling).then_some(McpAccessLevel::None),
                    ceiling: ceiling.then_some(McpAccessLevel::None),
                    ..Default::default()
                },
            );
            let projected = access.to_v1();
            assert!(!v1_connection_visible(&projected, None, "blocked"));
        }
        let access = McpAccessPolicy { default_access: McpAccessLevel::None, ..Default::default() };
        assert!(!v1_connection_visible(&access.to_v1(), None, "unlisted"));
    }

    #[test]
    fn v1_saves_keep_plugin_scope_rules() {
        let mut previous = McpAccessPolicy::default();
        let plugin_scope =
            McpRuleTarget::Scope { connection_id: "k".into(), scope: "namespace".into(), value: "dev".into() };
        previous.rules.insert(plugin_scope.clone(), McpAccessRule { visible: Some(true), ..Default::default() });
        previous.rules.insert(
            McpRuleTarget::Connection { id: "k".into() },
            McpAccessRule { sub_scope: Some(McpSubScopeMode::Selected), ..Default::default() },
        );
        previous.rules.insert(
            McpRuleTarget::Scope { connection_id: "c".into(), scope: "database".into(), value: "old".into() },
            McpAccessRule { visible: Some(true), ..Default::default() },
        );
        let rebuilt = McpAccessPolicy::from_v1(&McpGlobalPolicy::default()).with_v2_only_rules_from(&previous);
        assert!(rebuilt.rules.contains_key(&plugin_scope));
        assert_eq!(
            rebuilt.rules[&McpRuleTarget::Connection { id: "k".into() }].sub_scope,
            Some(McpSubScopeMode::Selected)
        );
        assert!(
            !rebuilt
                .rules
                .keys()
                .any(|target| matches!(target, McpRuleTarget::Scope { scope, .. } if scope == "database")),
            "database rules come from v1 only"
        );
    }

    #[test]
    fn v1_saves_keep_plugin_scope_mode_without_values() {
        let mut previous = McpAccessPolicy::default();
        previous.rules.insert(
            McpRuleTarget::Connection { id: "k".into() },
            McpAccessRule {
                sub_scope: Some(McpSubScopeMode::None),
                sub_scope_kind: Some("namespace".into()),
                ..Default::default()
            },
        );
        let rebuilt = McpAccessPolicy::from_v1(&McpGlobalPolicy::default()).with_v2_only_rules_from(&previous);
        assert_eq!(rebuilt.rules[&McpRuleTarget::Connection { id: "k".into() }].sub_scope, Some(McpSubScopeMode::None));
    }

    #[test]
    fn level_flags_round_trip() {
        for level in [McpAccessLevel::Read, McpAccessLevel::Write, McpAccessLevel::Full] {
            let (read_only, dangerous) = level.to_flags();
            assert_eq!(McpAccessLevel::from_flags(read_only, dangerous), level);
        }
        assert_eq!(McpAccessLevel::from_flags(true, true), McpAccessLevel::Read, "read-only wins");
        assert!(McpAccessLevel::None < McpAccessLevel::Read && McpAccessLevel::Write < McpAccessLevel::Full);
    }

    #[test]
    fn inheritance_prefers_scope_then_connection_then_closest_group() {
        let mut policy = McpAccessPolicy { default_access: McpAccessLevel::Read, ..Default::default() };
        let groups = vec!["root".to_string(), "leaf".to_string()];
        policy.rules.insert(
            McpRuleTarget::Group { id: "root".into() },
            McpAccessRule { access: Some(McpAccessLevel::Full), ..Default::default() },
        );
        assert_eq!(policy.resolve(&groups, "c", None).level, McpAccessLevel::Full);
        policy.rules.insert(
            McpRuleTarget::Group { id: "leaf".into() },
            McpAccessRule { access: Some(McpAccessLevel::Write), ..Default::default() },
        );
        let resolved = policy.resolve(&groups, "c", None);
        assert_eq!(
            (resolved.level, resolved.source),
            (McpAccessLevel::Write, McpAccessSource::Group { id: "leaf".into() })
        );
        policy.rules.insert(
            McpRuleTarget::Connection { id: "c".into() },
            McpAccessRule { access: Some(McpAccessLevel::Read), ..Default::default() },
        );
        assert_eq!(policy.resolve(&groups, "c", None).source, McpAccessSource::Connection);
        policy.rules.insert(
            McpRuleTarget::Scope { connection_id: "c".into(), scope: "database".into(), value: "billing".into() },
            McpAccessRule { access: Some(McpAccessLevel::Full), ..Default::default() },
        );
        let scoped = policy.resolve(&groups, "c", Some(("database", "billing")));
        assert_eq!((scoped.level, scoped.source), (McpAccessLevel::Full, McpAccessSource::Scope));
        assert_eq!(policy.resolve(&groups, "c", Some(("database", "other"))).level, McpAccessLevel::Read);
    }

    #[test]
    fn hidden_resources_resolve_to_none() {
        let mut policy = McpAccessPolicy { visibility: McpVisibilityMode::Selected, ..Default::default() };
        assert_eq!(policy.resolve(&[], "c", None).level, McpAccessLevel::None);
        policy.rules.insert(
            McpRuleTarget::Connection { id: "c".into() },
            McpAccessRule { visible: Some(true), sub_scope: Some(McpSubScopeMode::Selected), ..Default::default() },
        );
        assert!(policy.resolve(&[], "c", None).visible);
        assert!(
            !policy.resolve(&[], "c", Some(("database", "x"))).visible,
            "selected sub-scope admits only listed values"
        );
    }

    #[test]
    fn all_sub_scope_requests_require_unrestricted_scope_rules() {
        let mut policy = McpAccessPolicy::default();
        assert!(policy.sub_scope_allows_all("c", "namespace"));

        policy.rules.insert(
            McpRuleTarget::Connection { id: "c".into() },
            McpAccessRule { sub_scope: Some(McpSubScopeMode::Selected), ..Default::default() },
        );
        assert!(!policy.sub_scope_allows_all("c", "namespace"));

        policy.rules.insert(
            McpRuleTarget::Connection { id: "c".into() },
            McpAccessRule { sub_scope: Some(McpSubScopeMode::All), ..Default::default() },
        );
        policy.rules.insert(
            McpRuleTarget::Scope { connection_id: "c".into(), scope: "namespace".into(), value: "hidden".into() },
            McpAccessRule { visible: Some(false), ..Default::default() },
        );
        assert!(!policy.sub_scope_allows_all("c", "namespace"));

        policy.rules.insert(
            McpRuleTarget::Scope { connection_id: "c".into(), scope: "namespace".into(), value: "hidden".into() },
            McpAccessRule { access: Some(McpAccessLevel::None), ..Default::default() },
        );
        assert!(!policy.sub_scope_allows_all("c", "namespace"));
        assert!(policy.sub_scope_allows_all("c", "database"));
    }

    #[test]
    fn policy_serializes_rules_as_a_list_and_merges_duplicates_strictly() {
        let json = serde_json::json!({
            "version": 2,
            "defaultAccess": "write",
            "rules": [
                { "target": { "kind": "connection", "id": "c" }, "access": "full", "visible": true },
                { "target": { "kind": "connection", "id": "c" }, "access": "read" },
                { "target": { "kind": "scope", "connectionId": "c", "scope": "database", "value": "db" }, "access": "none" }
            ]
        });
        let policy: McpAccessPolicy = serde_json::from_value(json).unwrap();
        let connection = &policy.rules[&McpRuleTarget::Connection { id: "c".into() }];
        assert_eq!(connection.access, Some(McpAccessLevel::Read), "duplicates merge to the strictest level");
        assert_eq!(connection.visible, Some(true));
        let round_trip: McpAccessPolicy = serde_json::from_value(serde_json::to_value(&policy).unwrap()).unwrap();
        assert_eq!(round_trip, policy);
        assert!(serde_json::to_value(&policy).unwrap()["rules"].is_array());
    }
}
