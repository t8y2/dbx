//! Explicit Oracle/OB package selection, planning and verified execution.
//! Package definitions never use the legacy global schema replacement or table rebuild path.
use super::*;
use std::io::Write;

#[cfg(all(test, unix))]
#[path = "oracle_transfer_agent_tests.rs"]
mod agent_tests;

pub(super) fn creation_privileges_sql(database_type: DatabaseType) -> &'static str {
    if database_type == DatabaseType::OceanbaseOracle {
        // OB 4.2.5 has no SESSION_PRIVS. Only grants directly assigned to the
        // executing session user are confirmed; role grants do not prove permission.
        "SELECT PRIVILEGE FROM SYS.USER_SYS_PRIVS WHERE USERNAME = SYS_CONTEXT('USERENV', 'SESSION_USER')"
    } else {
        "SELECT PRIVILEGE FROM SESSION_PRIVS"
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferObjectConflictPolicy {
    #[default]
    Skip,
    Replace,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSchemaObjectDependency {
    pub owner: String,
    pub name: String,
    pub object_type: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSchemaObjectItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_required: Option<bool>,
    pub object_type: TransferObjectKind,
    pub name: String,
    pub source_schema: String,
    pub target_schema: String,
    pub action: String,
    pub ddl: String,
    pub dependencies: Vec<TransferSchemaObjectDependency>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSchemaObjectPlan {
    pub items: Vec<TransferSchemaObjectItem>,
    pub can_execute: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSchemaObjectResult {
    pub object_type: TransferObjectKind,
    pub name: String,
    pub schema: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
}

#[derive(Serialize)]
struct PackageBackup {
    connection_id: String,
    schema: String,
    name: String,
    definitions: Vec<(String, String)>,
}

fn is_package(kind: TransferObjectKind) -> bool {
    matches!(kind, TransferObjectKind::Package | TransferObjectKind::PackageBody)
}

pub(super) fn selected(request: &TransferRequest) -> Vec<(TransferObjectKind, String)> {
    let mut objects = Vec::new();
    for selection in request.object_selection_mode().selections() {
        if is_package(selection.object_type) {
            for name in &selection.names {
                let key = (selection.object_type, name.clone());
                if !objects.contains(&key) {
                    objects.push(key);
                }
            }
        }
    }
    objects.sort_by_key(|(kind, name)| (matches!(kind, TransferObjectKind::PackageBody), name.clone()));
    objects
}

fn dictionary_kind(kind: TransferObjectKind) -> &'static str {
    if kind == TransferObjectKind::Type { return "TYPE"; }
    if kind == TransferObjectKind::TypeBody { return "TYPE BODY"; }
    if kind == TransferObjectKind::PackageBody {
        "PACKAGE BODY"
    } else {
        "PACKAGE"
    }
}

fn source_kind(kind: TransferObjectKind) -> db::ObjectSourceKind {
    if kind == TransferObjectKind::PackageBody {
        db::ObjectSourceKind::PackageBody
    } else {
        db::ObjectSourceKind::Package
    }
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Parse only the declaration head. The remainder is returned byte-for-byte, including
/// literals, comments, explicit schema references and quoted identifiers in the body.
pub(super) fn declaration(source: &str, kind: TransferObjectKind) -> Result<(String, String, String), String> {
    let identifier = r#"(?:"(?:[^"]|"")*"|[\p{L}][\p{L}\p{N}_$#]*)"#;
    let keyword = if matches!(kind, TransferObjectKind::Type | TransferObjectKind::TypeBody) { "TYPE" } else { "PACKAGE" };
    let re = Regex::new(&format!(
        r#"(?is)\A\s*(?:(?:/\*.*?\*/|--[^\r\n]*(?:\r?\n|$))\s*)*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?)?{keyword}\s+(?P<body>BODY\s+)?(?P<name>{identifier}(?:\s*\.\s*{identifier})?)(?P<tail>.+)\z"#
    )).map_err(|e| e.to_string())?;
    let captures = re.captures(source).ok_or("Cannot parse the complete package declaration")?;
    if captures.name("body").is_some() != matches!(kind, TransferObjectKind::PackageBody | TransferObjectKind::TypeBody) {
        return Err("Package specification/body source kind does not match the selection".into());
    }
    let name = captures.name("name").unwrap();
    Ok((
        source[..name.start()].to_string(),
        name.as_str().to_string(),
        captures.name("tail").unwrap().as_str().to_string(),
    ))
}

fn unquote(name: &str) -> String {
    let name = name.trim();
    if name.starts_with('"') && name.ends_with('"') {
        name[1..name.len() - 1].replace("\"\"", "\"")
    } else {
        name.to_ascii_uppercase()
    }
}

fn declared_name(name: &str) -> String {
    // Split dots outside quoted identifiers; a quoted object name may itself contain dots.
    let mut quoted = false;
    let mut start = 0;
    for (index, ch) in name.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == '.' && !quoted {
            start = index + 1;
        }
    }
    unquote(&name[start..])
}

pub(super) fn map_header(source: &str, kind: TransferObjectKind, name: &str, target_schema: &str) -> Result<String, String> {
    let (prefix, declared, tail) = declaration(source, kind)?;
    if declared_name(&declared) != name {
        return Err("Source declaration name does not match the selected object".into());
    }
    let keyword = if matches!(kind, TransferObjectKind::Type | TransferObjectKind::TypeBody) { "TYPE" } else { "PACKAGE" };
    let header = Regex::new(&format!(
        r"(?is)(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?P<edition>(?:NON)?EDITIONABLE\s+)?)?{keyword}\s+(?:BODY\s+)?$",
    ))
    .unwrap();
    let parsed = header.captures(&prefix).ok_or("Cannot parse package header")?;
    let prefix = format!(
        "{}CREATE OR REPLACE {}{} ",
        &prefix[..parsed.get(0).unwrap().start()],
        parsed.name("edition").map_or("", |m| m.as_str()),
        dictionary_kind(kind)
    );
    let ddl = format!("{prefix}{}.{}{tail}", ident(target_schema), ident(name));
    Ok(strip_client_slash(&ddl).to_string())
}

fn strip_client_slash(sql: &str) -> &str {
    let sql = sql.trim_end();
    if let Some((body, tail)) = sql.rsplit_once('\n') {
        if tail.trim() == "/" {
            return body.trim_end();
        }
    }
    sql
}

fn body_fingerprint(source: &str, kind: TransferObjectKind) -> Result<String, String> {
    let (_, _, tail) = declaration(strip_client_slash(source), kind)?;
    Ok(tail.replace("\r\n", "\n").trim().to_string())
}

pub(super) fn verify_readback(readback: &str, item: &TransferSchemaObjectItem) -> Result<(), String> {
    let (_, name, _) = declaration(readback, item.object_type)?;
    if declared_name(&name) != item.name
        || body_fingerprint(readback, item.object_type)? != body_fingerprint(&item.ddl, item.object_type)?
    {
        return Err("Target source readback differs from the planned package definition".into());
    }
    Ok(())
}

async fn source(
    state: &AppState,
    connection: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: TransferObjectKind,
) -> Result<String, String> {
    let value =
        crate::schema::get_object_source_core(state, connection, database, schema, name, source_kind(kind), None, None)
            .await?;
    if value.source.trim().is_empty() {
        return Err("The source reader returned an empty definition".into());
    }
    declaration(&value.source, kind)?;
    Ok(value.source)
}

async fn object_status(
    state: &AppState,
    pool: &str,
    schema: &str,
    name: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    let sql = format!(
        "SELECT STATUS FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE = {}",
        quote_string_literal(schema),
        quote_string_literal(name),
        quote_string_literal(kind)
    );
    let result = read_metadata(state, pool, &sql).await?;
    Ok(result.rows.first().and_then(|r| r.first()).and_then(|v| v.as_str()).map(str::to_string))
}

fn text(row: &[serde_json::Value], index: usize) -> String {
    row.get(index).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

async fn read_metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool(state, pool, sql).await?;
    if result.truncated || result.has_more {
        return Err("Package metadata was truncated; a complete preflight/readback is required".into());
    }
    Ok(result)
}

async fn dependencies(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
    kind: TransferObjectKind,
    name: &str,
    selected: &[(TransferObjectKind, String)],
    original: &str,
    ddl: &mut String,
) -> Result<Vec<TransferSchemaObjectDependency>, String> {
    let source_schema = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_schema = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let sql = format!("SELECT REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE, REFERENCED_LINK_NAME FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE", quote_string_literal(&source_schema), quote_string_literal(name), quote_string_literal(dictionary_kind(kind)));
    let rows = read_metadata(state, source_pool, &sql).await?.rows;
    let mut result = Vec::new();
    for row in rows {
        let owner = text(&row, 0);
        let dependency = text(&row, 1);
        let object_type = text(&row, 2);
        let link = text(&row, 3);
        if !link.is_empty() {
            let available = oracle_database_links::dependency_available(state, request, target_pool, &target_schema, &link, true).await?;
            result.push(TransferSchemaObjectDependency { owner: target_schema.clone(), name: link, object_type: "DATABASE LINK (remote object unverified)".into(), available });
            continue;
        }
        // The definition header moves into the selected target schema. Other schemas stay intact.
        let words = sql_words(&declaration(original, kind)?.2);
        let explicit = words.windows(3).any(|part| identifier_word(&part[0]) == owner && part[1] == "." && identifier_word(&part[2]) == dependency);
        let selected_type = owner == source_schema && object_type == "TYPE" && request.object_selection_mode().selections().iter().any(|selection| selection.object_type == TransferObjectKind::Type && selection.names.contains(&dependency));
        if selected_type { *ddl = oracle_types::map_reference(ddl, &source_schema, &dependency, &target_schema)?; }
        let target_owner = if owner == source_schema && (!explicit || selected_type) { target_schema.clone() } else { owner };
        let planned = target_owner == target_schema
            && ((object_type == "PACKAGE" && selected.contains(&(TransferObjectKind::Package, dependency.clone())))
                || (object_type == "TYPE" && request.object_selection_mode().selections().iter().any(|selection| selection.object_type == TransferObjectKind::Type && selection.names.contains(&dependency)))
                || (object_type == "TABLE" && request.create_table && request.tables.contains(&dependency)));
        let status = if link.is_empty() {
            object_status(state, target_pool, &target_owner, &dependency, &object_type).await?
        } else {
            None
        };
        let available = link.is_empty()
            && dependency_available(planned, status.as_deref(), request.object_conflict_policy);
        result.push(TransferSchemaObjectDependency {
            owner: target_owner,
            name: dependency,
            object_type: if link.is_empty() { object_type } else { format!("{object_type}@{link}") },
            available,
        });
    }
    if kind == TransferObjectKind::PackageBody
        && !result.iter().any(|d| d.owner == target_schema && d.name == name && d.object_type == "PACKAGE")
    {
        let status = object_status(state, target_pool, &target_schema, name, "PACKAGE").await?;
        let available = dependency_available(
            selected.contains(&(TransferObjectKind::Package, name.to_string())),
            status.as_deref(),
            request.object_conflict_policy,
        );
        result.push(TransferSchemaObjectDependency {
            owner: target_schema,
            name: name.to_string(),
            object_type: "PACKAGE".into(),
            available,
        });
    }
    Ok(result)
}

pub(super) fn dependency_available(planned: bool, status: Option<&str>, policy: TransferObjectConflictPolicy) -> bool {
    status == Some("VALID") || (planned && (status.is_none() || policy == TransferObjectConflictPolicy::Replace))
}

async fn target_backup(
    state: &AppState,
    request: &TransferRequest,
    target_pool: &str,
    name: &str,
) -> Result<PackageBackup, String> {
    let schema = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let mut definitions = Vec::new();
    for kind in [TransferObjectKind::Package, TransferObjectKind::PackageBody] {
        if object_status(state, target_pool, &schema, name, dictionary_kind(kind)).await?.is_some() {
            let ddl =
                source(state, &request.target_connection_id, &request.target_database, &schema, name, kind).await?;
            // Refuse replacement unless the saved definition can be replayed for this identity.
            map_header(&ddl, kind, name, &schema)?;
            definitions.push((dictionary_kind(kind).to_string(), ddl));
        }
    }
    Ok(PackageBackup {
        connection_id: request.target_connection_id.clone(),
        schema,
        name: name.to_string(),
        definitions,
    })
}

async fn build_plan(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
) -> Result<TransferSchemaObjectPlan, String> {
    let selections = selected(request);
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    let supported = matches!(source_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        && matches!(target_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle);
    let source_schema = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_schema = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let mut items = Vec::new();
    for (kind, name) in &selections {
        let mut item = TransferSchemaObjectItem {
            execution_phase: None, credential_required: None,
            object_type: *kind,
            name: name.clone(),
            source_schema: source_schema.clone(),
            target_schema: target_schema.clone(),
            action: "create".into(),
            ddl: String::new(),
            dependencies: Vec::new(),
            warnings: vec!["Object grants and external dependencies are not migrated.".into()],
            errors: Vec::new(),
        };
        let planned: Result<(), String> = async {
            if !supported { return Err("Package transfer supports Oracle and OceanBase Oracle endpoints only".into()); }
            if request.source_connection_id == request.target_connection_id && source_schema == target_schema { return Err("Source and target package schemas must differ".into()); }
            let original = source(state, &request.source_connection_id, &request.source_database, &source_schema, name, *kind).await?;
            if object_status(state, source_pool, &source_schema, name, dictionary_kind(*kind)).await?.as_deref() != Some("VALID") { return Err("The source package is not VALID".into()); }
            item.ddl = map_header(&original, *kind, name, &target_schema)?;
            // Unselected explicit references retain their owners. Selected TYPE references
            // are rebound below only after the dictionary confirms their dependency identity.
            if source_type != target_type {
                item.warnings.push(format!("Cross-engine transfer: {source_type:?} to {target_type:?}; compilation and source/signature readback are required."));
            }
            let version = read_metadata(state, target_pool, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1").await?;
            let banner = version.rows.first().map(|r| text(r, 0)).unwrap_or_default();
            validate_version_clauses(&original, target_type, &banner)?;
            item.warnings.push(format!("Target version: {banner}"));
            item.dependencies = dependencies(state, request, source_pool, target_pool, *kind, name, &selections, &original, &mut item.ddl).await?;
            if source_schema != target_schema && explicit_owner_reference(&item.ddl, &source_schema) {
                item.warnings.push("Unselected explicit source-schema references are preserved; their referenced objects must remain available on the target connection.".into());
            }
            for dependency in &item.dependencies {
                if dependency.owner == item.target_schema
                    && dependency.name == item.name
                    && dependency.object_type == dictionary_kind(item.object_type)
                {
                    continue;
                }
                if !dependency.available { item.errors.push(format!("Missing or invalid dependency: {}.{} ({})", dependency.owner, dependency.name, dependency.object_type)); }
            }
            let conflict = read_metadata(state, target_pool, &format!("SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {}", quote_string_literal(&target_schema), quote_string_literal(name))).await?;
            if conflict.rows.iter().any(|r| !matches!(text(r, 0).as_str(), "PACKAGE" | "PACKAGE BODY")) {
                return Err("The target name is occupied by another object type".into());
            }
            if object_status(state, target_pool, &target_schema, name, dictionary_kind(*kind)).await?.is_some() {
                item.action = if request.object_conflict_policy == TransferObjectConflictPolicy::Skip { "skip" } else { "replace" }.into();
                if item.action == "replace" {
                    target_backup(state, request, target_pool, name).await?;
                    item.warnings.push("Replacement retains a complete local specification/body backup; dependent objects can be invalidated.".into());
                    if *kind == TransferObjectKind::Package && !selections.contains(&(TransferObjectKind::PackageBody, name.clone())) {
                        item.warnings.push("The existing body is not selected and will not be migrated; a specification change can invalidate it.".into());
                    }
                }
            }
            Ok(())
        }.await;
        if let Err(error) = planned {
            item.errors.push(error);
        }
        if !item.errors.is_empty() {
            item.action = "blocked".into();
        }
        items.push(item);
    }
    order_plan(&mut items);
    Ok(TransferSchemaObjectPlan { can_execute: items.iter().all(|item| item.action != "blocked"), items })
}

/// Lexical words only, omitting comments and string literals. Quoted identifiers retain
/// their spelling. Used for conservative compatibility/reference checks, never rewriting.
pub(super) fn sql_words(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut words = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        let q = if matches!(chars[i], 'n' | 'N') && matches!(chars.get(i + 1), Some('q' | 'Q')) { i + 1 } else { i };
        if matches!(chars.get(q), Some('q' | 'Q')) && chars.get(q + 1) == Some(&'\'') && chars.get(q + 2).is_some() {
            let closer = match chars[q + 2] {
                '[' => ']',
                '{' => '}',
                '(' => ')',
                '<' => '>',
                c => c,
            };
            i = q + 3;
            while i + 1 < chars.len() && !(chars[i] == closer && chars[i + 1] == '\'') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        if chars[i] == '\'' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\'' {
                    i += 1;
                    if chars.get(i) == Some(&'\'') {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if chars[i] == '"' {
            i += 1;
            let mut word = String::new();
            while i < chars.len() {
                if chars[i] == '"' {
                    i += 1;
                    if chars.get(i) == Some(&'"') {
                        word.push('"');
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            words.push(format!("\"{}\"", word.replace('"', "\"\"")));
            continue;
        }
        if chars[i].is_alphabetic() || chars[i] == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || "_$#".contains(chars[i])) {
                i += 1;
            }
            words.push(chars[start..i].iter().collect::<String>().to_ascii_uppercase());
            continue;
        }
        if chars[i] == '.' {
            words.push(".".into());
        }
        i += 1;
    }
    words
}

fn explicit_owner_reference(source: &str, schema: &str) -> bool {
    // Discard the declaration name: only references in the body need review.
    let tail = declaration(source, TransferObjectKind::Package)
        .or_else(|_| declaration(source, TransferObjectKind::PackageBody))
        .map(|(_, _, tail)| tail)
        .unwrap_or_default();
    let words = sql_words(&tail);
    words.windows(2).any(|pair| identifier_word(&pair[0]) == schema && pair[1] == ".")
}

pub(super) fn identifier_word(word: &str) -> String {
    if word.starts_with('"') { unquote(word) } else { word.to_string() }
}

fn validate_version_clauses(source: &str, database_type: DatabaseType, banner: &str) -> Result<(), String> {
    let version = Regex::new(r"\b(\d+)\.(\d+)").unwrap();
    let captures = version.captures(banner).ok_or("Target database version could not be read; version-specific package syntax has not been checked")?;
    let major: u32 = captures[1].parse().map_err(|_| "Invalid target version")?;
    let minor: u32 = captures[2].parse().map_err(|_| "Invalid target version")?;
    let words = sql_words(source);
    let has = |keyword: &str| words.iter().any(|word| word == keyword);
    let edition = has("EDITIONABLE") || has("NONEDITIONABLE");
    let incompatible = if database_type == DatabaseType::OceanbaseOracle {
        edition || has("ACCESSIBLE") || has("SHARING")
    } else {
        (edition && (major, minor) < (11, 2)) || (has("ACCESSIBLE") && major < 12) || (has("SHARING") && (major, minor) < (12, 2))
    };
    if incompatible { return Err("Package edition/accessibility/sharing syntax requires a reviewed target-version conversion".into()); }
    Ok(())
}

fn order_plan(items: &mut Vec<TransferSchemaObjectItem>) {
    let mut pending = std::mem::take(items);
    while !pending.is_empty() {
        let next = pending.iter().position(|item| {
            !item.dependencies.iter().any(|dependency| {
                pending.iter().any(|other| {
                    other.name == dependency.name
                        && other.target_schema == dependency.owner
                        && dictionary_kind(other.object_type) == dependency.object_type
                        && !(other.name == item.name && other.object_type == item.object_type)
                })
            })
        });
        if let Some(index) = next {
            items.push(pending.remove(index));
        } else {
            for mut item in pending {
                item.action = "blocked".into();
                item.errors.push("Selected package dependency cycle requires an explicit migration plan".into());
                items.push(item);
            }
            break;
        }
    }
}

pub(super) async fn preview(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
) -> Result<Option<TransferSchemaObjectPlan>, String> {
    if selected(request).is_empty() || request.content == TransferContent::DataOnly {
        return Ok(None);
    }
    build_plan(state, request, source_pool, target_pool).await.map(Some)
}

pub(super) async fn ensure_ready(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
) -> Result<(), String> {
    if let Some(plan) = preview(state, request, source_pool, target_pool).await? {
        if !plan.can_execute {
            return Err(plan
                .items
                .iter()
                .filter(|item| item.action == "blocked")
                .map(|item| format!("{} {}: {}", dictionary_kind(item.object_type), item.name, item.errors.join("; ")))
                .collect::<Vec<_>>()
                .join("\n"));
        }
    }
    Ok(())
}

fn persist_backup(state: &AppState, backup: &PackageBackup) -> Result<String, String> {
    let directory = state.storage.data_dir().join("transfer-object-backups");
    std::fs::create_dir_all(&directory).map_err(|e| format!("Cannot create package backup directory: {e}"))?;
    let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| format!("Cannot create package backup: {e}"))?;
    let bytes = serde_json::to_vec(backup).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("Cannot persist package backup: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

async fn signature(
    state: &AppState,
    pool: &str,
    schema: &str,
    name: &str,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let sql = format!("SELECT OBJECT_NAME, OVERLOAD, ARGUMENT_NAME, POSITION, SEQUENCE, DATA_TYPE, IN_OUT, TYPE_NAME, TYPE_SUBNAME FROM ALL_ARGUMENTS WHERE OWNER = {} AND PACKAGE_NAME = {} ORDER BY OBJECT_NAME, OVERLOAD, SEQUENCE", quote_string_literal(schema), quote_string_literal(name));
    Ok(read_metadata(state, pool, &sql).await?.rows)
}

async fn verify(
    state: &AppState,
    request: &TransferRequest,
    target_pool: &str,
    item: &TransferSchemaObjectItem,
) -> Result<(), String> {
    let status =
        object_status(state, target_pool, &item.target_schema, &item.name, dictionary_kind(item.object_type)).await?;
    if status.as_deref() != Some("VALID") {
        let errors = read_metadata(state, target_pool, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY SEQUENCE", quote_string_literal(&item.target_schema), quote_string_literal(&item.name), quote_string_literal(dictionary_kind(item.object_type)))).await?;
        // Preserve diagnostic locations/codes without leaking source literals quoted by the compiler.
        let code = Regex::new(r"(?:ORA|PLS)-\d+").unwrap();
        let diagnostics = errors
            .rows
            .iter()
            .map(|row| {
                format!(
                    "line {}, column {}: {}",
                    row.first().map_or_else(|| "?".into(), |v| v.to_string()),
                    row.get(1).map_or_else(|| "?".into(), |v| v.to_string()),
                    code.find(&text(row, 2)).map_or("compiler diagnostic", |m| m.as_str()).to_string()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!(
            "Compilation status {}; ALL_ERRORS: {}",
            status.as_deref().unwrap_or("missing"),
            diagnostics
        ));
    }
    let readback = source(
        state,
        &request.target_connection_id,
        &request.target_database,
        &item.target_schema,
        &item.name,
        item.object_type,
    )
    .await?;
    verify_readback(&readback, item)
}

pub(super) async fn execute<F: FnMut(TransferProgress)>(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
    progress: &mut F,
) -> Result<TransferObjectOutcome, String> {
    let Some(plan) = preview(state, request, source_pool, target_pool).await? else {
        return Ok(TransferObjectOutcome::default());
    };
    let mut outcome = TransferObjectOutcome::default();
    let mut failed = HashSet::new();
    let plan_blocked = !plan.can_execute;
    for item in plan.items {
        let mut result = TransferSchemaObjectResult {
            object_type: item.object_type,
            name: item.name.clone(),
            schema: item.target_schema.clone(),
            status: "failed".into(),
            compile_status: None,
            source_verified: None,
            error: None,
            recovery: None,
        };
        let execution: Result<(), String> = async {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled before package execution".into());
            }
            if item.action == "blocked" {
                return Err(item.errors.join("; "));
            }
            if plan_blocked {
                return Err("Package preflight changed or is incomplete; no package DDL was executed".into());
            }
            if item
                .dependencies
                .iter()
                .any(|d| failed.contains(&(d.owner.clone(), d.name.clone(), d.object_type.clone())))
            {
                return Err("A selected package dependency failed; this object was not executed".into());
            }
            if item.action == "skip" {
                result.status = "skipped".into();
                return Ok(());
            }
            // Planned dependencies may have been skipped or changed since preflight.
            // Read them again after their execution and before mutating this object.
            for dependency in &item.dependencies {
                if object_status(state, target_pool, &dependency.owner, &dependency.name, &dependency.object_type)
                    .await?
                    .as_deref()
                    != Some("VALID")
                {
                    return Err(format!(
                        "Dependency is no longer VALID: {}.{} ({})",
                        dependency.owner, dependency.name, dependency.object_type
                    ));
                }
            }
            let expected_signature = if item.object_type == TransferObjectKind::Package {
                Some(signature(state, source_pool, &item.source_schema, &item.name).await?)
            } else {
                None
            };
            // Recheck and back up immediately before any replacement, not just during preview.
            let backup = target_backup(state, request, target_pool, &item.name).await?;
            let exists = backup.definitions.iter().any(|(kind, _)| kind == dictionary_kind(item.object_type));
            if exists && request.object_conflict_policy != TransferObjectConflictPolicy::Replace {
                return Err("Target package appeared after planning; replacement was not authorized".into());
            }
            let backup_path = if !backup.definitions.is_empty() { Some(persist_backup(state, &backup)?) } else { None };
            let written: Result<(), String> = async {
                // Deliberately one DDL call. Do not split a PL/SQL package into statements.
                execute_on_pool(state, target_pool, &item.ddl)
                    .await
                    .map_err(|_| "Package DDL failed; inspect the target compiler diagnostics".to_string())?;
                verify(state, request, target_pool, &item).await?;
                if let Some(expected) = expected_signature {
                    if signature(state, target_pool, &item.target_schema, &item.name).await? != expected {
                        return Err("Target package signature differs from the source signature".into());
                    }
                }
                Ok(())
            }
            .await;
            if let Some(path) = &backup_path {
                result.recovery = Some(format!("Complete target definition backup retained at {path}"));
            }
            if let Err(error) = written {
                // Keep the failed write/readback status with the retained backup.
                result.compile_status = object_status(
                    state, target_pool, &item.target_schema, &item.name, dictionary_kind(item.object_type),
                ).await.ok().flatten();
                if error.contains("readback differs") || error.contains("signature differs") {
                    result.source_verified = Some(false);
                }
                if !exists {
                    result.recovery = Some(format!(
                        "New target definition retained for inspection; no DROP was executed. {}",
                        backup_path.map_or(String::new(), |path| format!("Existing definitions backed up at {path}"))
                    ));
                } else if let Some(path) = backup_path {
                    // A successful DDL response and matching dictionary readback cannot
                    // exclude another session writing between that read and a recovery DDL.
                    // Timeouts/cancellation also leave the write outcome uncertain. There
                    // is no atomic compare-and-restore primitive here, so never replay old
                    // definitions over the current target (including an unselected body).
                    result.recovery = Some(format!(
                        "Automatic restoration was not attempted because concurrent changes or an unknown write outcome cannot be excluded. Complete specification/body backup retained at {path}. Manual recovery: wait for in-flight or cancelled DDL to finish; read current target source and status and compare with the backup; explicitly select which definitions to restore on the recorded target connection/schema (specification before body, never implicitly restore an unselected body); then verify VALID status, ALL_ERRORS and complete source/signature readback."
                    ));
                } else {
                    result.recovery =
                        Some("New target definition retained for inspection; no DROP was executed".into());
                }
                return Err(error);
            }
            result.status = "transferred".into();
            result.compile_status = Some("VALID".into());
            result.source_verified = Some(true);
            Ok(())
        }
        .await;
        let label = format!("{:?}:{}", item.object_type, item.name);
        if let Err(error) = execution {
            result.error = Some(error);
            if result.compile_status.is_none() {
                result.compile_status =
                object_status(state, target_pool, &item.target_schema, &item.name, dictionary_kind(item.object_type))
                    .await
                    .ok()
                    .flatten();
            }
            failed.insert((
                item.target_schema.clone(),
                item.name.clone(),
                dictionary_kind(item.object_type).to_string(),
            ));
            outcome.failed.push(label);
        } else if result.status == "skipped" {
            outcome.skipped.push(label);
        } else {
            outcome.transferred.push(label);
        }
        outcome.object_results.push(result.clone());
        progress(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("{}: {}.{}", dictionary_kind(item.object_type), item.target_schema, item.name),
            table_index: request.tables.len(),
            total_tables: request.tables.len(),
            rows_transferred: (outcome.transferred.len() + outcome.skipped.len()) as u64,
            total_rows: None,
            status: if result.error.is_some() { TransferStatus::Error } else { TransferStatus::Running },
            error: result.error.clone(),
            terminal: false,
            object_result: Some(result),
        });
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_only_the_package_header() {
        let source = "CREATE OR REPLACE PACKAGE BODY \"S\".\"P\" AS\nPROCEDURE x IS BEGIN dbms_output.put_line(q'[\"S\".x]'); END; END;\n/";
        let mapped = map_header(source, TransferObjectKind::PackageBody, "P", "Target").unwrap();
        assert!(mapped.starts_with("CREATE OR REPLACE PACKAGE BODY \"Target\".\"P\" AS"));
        assert!(mapped.contains("q'[\"S\".x]'"));
        assert!(!mapped.ends_with('/'));
        assert_eq!(
            body_fingerprint(source, TransferObjectKind::PackageBody).unwrap(),
            body_fingerprint(&mapped, TransferObjectKind::PackageBody).unwrap()
        );
    }
    #[test]
    fn rejects_the_wrong_source_identity() {
        assert!(map_header("PACKAGE P AS END;", TransferObjectKind::PackageBody, "P", "T").is_err());
        assert!(map_header("PACKAGE OTHER AS END;", TransferObjectKind::Package, "P", "T").is_err());
        assert!(map_header("", TransferObjectKind::Package, "P", "T").is_err());
    }
    #[test]
    fn references_ignore_literals_and_comments() {
        assert!(!explicit_owner_reference("PACKAGE P AS -- S.T\nx varchar2(20) := nq'[S.T]'; END;", "S"));
        assert!(explicit_owner_reference("PACKAGE P AS x S.T; END;", "S"));
        assert!(explicit_owner_reference("PACKAGE P AS x \"Mixed\".T; END;", "Mixed"));
    }

    #[test]
    fn declaration_comments_and_quoted_dots_stay_intact() {
        let source = "/* CREATE is documentation */ PACKAGE \"S\".\"a.b\"/* header */ AS x varchar2(20) := 'S.a'; END;";
        let ddl = map_header(source, TransferObjectKind::Package, "a.b", "T").unwrap();
        assert!(ddl.starts_with("/* CREATE is documentation */ CREATE OR REPLACE PACKAGE \"T\".\"a.b\"/* header */"));
        assert!(ddl.contains("'S.a'"));
    }

    fn plan_item(kind: TransferObjectKind, name: &str, dependencies: &[&str]) -> TransferSchemaObjectItem {
        TransferSchemaObjectItem {
            execution_phase: None, credential_required: None,
            object_type: kind,
            name: name.into(),
            source_schema: "S".into(),
            target_schema: "T".into(),
            action: "create".into(),
            ddl: String::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
            dependencies: dependencies
                .iter()
                .map(|name| TransferSchemaObjectDependency {
                    owner: "T".into(),
                    name: (*name).into(),
                    object_type: "PACKAGE".into(),
                    available: true,
                })
                .collect(),
        }
    }

    #[test]
    fn selected_dependency_specification_precedes_body_and_dependant() {
        let mut items = vec![
            plan_item(TransferObjectKind::PackageBody, "B", &["B"]),
            plan_item(TransferObjectKind::Package, "B", &["A"]),
            plan_item(TransferObjectKind::Package, "A", &[]),
        ];
        order_plan(&mut items);
        assert_eq!(
            items.iter().map(|item| (item.object_type, item.name.as_str())).collect::<Vec<_>>(),
            vec![
                (TransferObjectKind::Package, "A"),
                (TransferObjectKind::Package, "B"),
                (TransferObjectKind::PackageBody, "B")
            ]
        );
    }

    #[test]
    fn dependency_cycles_are_blocked_without_adding_objects() {
        let mut items = vec![
            plan_item(TransferObjectKind::Package, "A", &["B"]),
            plan_item(TransferObjectKind::Package, "B", &["A"]),
        ];
        order_plan(&mut items);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.action == "blocked" && !item.errors.is_empty()));
    }

    #[test]
    fn request_defaults_to_skip_and_selection_does_not_add_a_specification() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({"transferId":"x","sourceConnectionId":"s","sourceDatabase":"S","sourceSchema":"S","targetConnectionId":"t","targetDatabase":"T","targetSchema":"T","tables":[],"createTable":true,"batchSize":100,"objects":[{"objectType":"PACKAGE_BODY","names":["P","P"]}]})).unwrap();
        assert_eq!(request.object_conflict_policy, TransferObjectConflictPolicy::Skip);
        assert_eq!(selected(&request), vec![(TransferObjectKind::PackageBody, "P".into())]);
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["objectConflictPolicy"], "skip");
    }

    #[test]
    fn readback_accepts_dictionary_header_but_rejects_changed_body_or_identity() {
        let mut item = plan_item(TransferObjectKind::Package, "P", &[]);
        item.ddl = "CREATE OR REPLACE PACKAGE \"T\".\"P\" AS\r\nPROCEDURE run;\r\nEND;".into();
        assert!(verify_readback("PACKAGE P AS\nPROCEDURE run;\nEND;\n/", &item).is_ok());
        assert!(verify_readback("PACKAGE P AS\nPROCEDURE changed;\nEND;", &item).is_err());
        assert!(verify_readback("PACKAGE OTHER AS\nPROCEDURE run;\nEND;", &item).is_err());
        assert!(verify_readback("PACKAGE BODY P AS\nPROCEDURE run;\nEND;", &item).is_err());
    }

    #[test]
    fn version_gates_ignore_comments_literals_and_quoted_names() {
        let plain = "PACKAGE P AS x varchar2(20) := q'[ACCESSIBLE SHARING EDITIONABLE]'; -- ACCESSIBLE\n\"SHARING\" number; END;";
        assert!(validate_version_clauses(plain, DatabaseType::OceanbaseOracle, "OceanBase 4.3.5").is_ok());
        for clause in ["EDITIONABLE PACKAGE", "PACKAGE P ACCESSIBLE BY", "PACKAGE P SHARING"] {
            assert!(validate_version_clauses(clause, DatabaseType::OceanbaseOracle, "OceanBase 4.3.5").is_err());
        }
        assert!(validate_version_clauses("PACKAGE P ACCESSIBLE BY", DatabaseType::Oracle, "Oracle 11.2.0").is_err());
        assert!(validate_version_clauses("PACKAGE P ACCESSIBLE BY", DatabaseType::Oracle, "Oracle 19.0.0").is_ok());
        assert!(validate_version_clauses("PACKAGE P AS END;", DatabaseType::Oracle, "unknown").is_err());
    }

    #[test]
    fn skipped_invalid_specification_cannot_satisfy_a_body_dependency() {
        use TransferObjectConflictPolicy::{Replace, Skip};
        assert!(!dependency_available(true, Some("INVALID"), Skip));
        assert!(dependency_available(true, Some("INVALID"), Replace));
        assert!(dependency_available(true, None, Skip));
        assert!(dependency_available(false, Some("VALID"), Skip));
        assert!(!dependency_available(false, None, Replace));
        assert!(!dependency_available(false, Some("INVALID"), Replace));
    }

    #[test]
    fn package_capabilities_exclude_dameng_and_cross_family_targets() {
        for source in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            for target in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
                let kinds = cross_family_transferable_object_kinds(&source, &target);
                assert!(kinds.contains(&TransferObjectKind::Package));
                assert!(kinds.contains(&TransferObjectKind::PackageBody));
            }
            assert!(!cross_family_transferable_object_kinds(&source, &DatabaseType::Dameng)
                .contains(&TransferObjectKind::Package));
            assert!(!cross_family_transferable_object_kinds(&source, &DatabaseType::Mysql)
                .contains(&TransferObjectKind::PackageBody));
        }
        assert!(!transfer_object_kinds(&DatabaseType::Dameng).contains(&TransferObjectKind::Package));
    }

    #[test]
    fn package_progress_serializes_verification_and_recovery_for_both_transports() {
        let progress = TransferProgress {
            transfer_id: "package-transfer".into(),
            table: "PACKAGE BODY: T.P".into(),
            table_index: 0,
            total_tables: 0,
            rows_transferred: 0,
            total_rows: None,
            status: TransferStatus::Error,
            error: Some("Compilation status INVALID".into()),
            terminal: false,
            object_result: Some(TransferSchemaObjectResult {
                object_type: TransferObjectKind::PackageBody,
                name: "P".into(),
                schema: "T".into(),
                status: "failed".into(),
                compile_status: Some("INVALID".into()),
                source_verified: Some(false),
                error: Some("Compilation status INVALID".into()),
                recovery: Some("Complete target definitions backed up; manual recovery required".into()),
            }),
        };
        let value = serde_json::to_value(progress).unwrap();
        assert_eq!(value["objectResult"]["objectType"], "PACKAGE_BODY");
        assert_eq!(value["objectResult"]["compileStatus"], "INVALID");
        assert_eq!(value["objectResult"]["sourceVerified"], false);
        assert_eq!(value["objectResult"]["status"], "failed");
        assert_eq!(value["terminal"], false);
        assert!(value["objectResult"]["recovery"].as_str().unwrap().contains("manual recovery"));
    }
}
