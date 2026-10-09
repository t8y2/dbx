//! Explicit user TYPE/BODY transfer using E09a full source and typed metadata.
use super::oracle_packages::{self, TransferSchemaObjectDependency, TransferSchemaObjectItem};
use super::*;
use crate::schema::oracle_types::{OracleMetadataReadState, OracleTypeDetails};
use std::io::Write;

fn is_type(kind: TransferObjectKind) -> bool { matches!(kind, TransferObjectKind::Type | TransferObjectKind::TypeBody) }
fn dictionary_kind(kind: TransferObjectKind) -> &'static str { if kind == TransferObjectKind::TypeBody { "TYPE BODY" } else { "TYPE" } }
fn api_kind(kind: TransferObjectKind) -> &'static str { if kind == TransferObjectKind::TypeBody { "TYPE_BODY" } else { "TYPE" } }
fn dependency_kind_for(kind: &str) -> Option<TransferObjectKind> {
    match kind.replace(' ', "_").as_str() { "TYPE" => Some(TransferObjectKind::Type), "TYPE_BODY" => Some(TransferObjectKind::TypeBody), _ => None }
}

// Positions are retained so dependency-qualified identifiers can be mapped without
// changing strings, q/nq literals, comments or unrelated schema references.
use dbx_sql_core::oracle_program_compatibility::{map_reference_as, map_unqualified_table};
#[cfg(test)]
use dbx_sql_core::oracle_program_compatibility::supported_version;
pub(super) fn map_reference(sql: &str, owner: &str, name: &str, target: &str) -> Result<String, String> {
    dbx_sql_core::oracle_program_compatibility::map_reference(sql, owner, name, target)
}
pub(super) async fn map_table_type_references(state: &AppState, request: &TransferRequest, pool: &str, table: &str, ddl: String) -> Result<String, String> {
    if !has_selection(request) { return Ok(ddl); }
    let owner = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let rows = metadata(state, pool, &format!("SELECT DATA_TYPE_OWNER, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE OWNER={} AND TABLE_NAME={} AND DATA_TYPE_OWNER IS NOT NULL", quote_string_literal(&owner), quote_string_literal(table))).await?.rows;
    let mut mapped = ddl;
    for row in rows {
        let type_owner = text(&row, 0)?; let name = text(&row, 1)?;
        if type_owner == owner && selected(request).contains(&(TransferObjectKind::Type, name.clone())) {
            mapped = map_reference(&mapped, &owner, &name, &target)?;
        }
    }
    Ok(mapped)
}

fn compatible_source(sql: &str, kind: TransferObjectKind, details: &OracleTypeDetails) -> Result<(), String> {
    let dependencies = details.dependencies.rows.iter().map(|d| dbx_types::types::RoutineDependency {
        owner: d.referenced_schema.clone().unwrap_or_default(), name: d.referenced_name.clone(), object_type: d.referenced_type.replace('_', " "),
    }).collect::<Vec<_>>();
    dbx_sql_core::oracle_program_compatibility::compatible_type_source(sql, dictionary_kind(kind), &dependencies)
}
fn source_kind(kind: TransferObjectKind) -> db::ObjectSourceKind { if kind == TransferObjectKind::TypeBody { db::ObjectSourceKind::TypeBody } else { db::ObjectSourceKind::Type } }
fn selected(request: &TransferRequest) -> Vec<(TransferObjectKind, String)> {
    let mut result = Vec::new();
    for selection in request.object_selection_mode().selections() {
        if is_type(selection.object_type) { for name in &selection.names { let key = (selection.object_type, name.clone()); if !result.contains(&key) { result.push(key); } } }
    }
    result
}
pub(super) fn has_selection(request: &TransferRequest) -> bool {
    request.content != TransferContent::DataOnly && !selected(request).is_empty()
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase { BeforeTables, AfterObjects }
fn after_objects(item: &TransferSchemaObjectItem, request: &TransferRequest) -> bool {
    item.object_type == TransferObjectKind::TypeBody && item.dependencies.iter().any(|d| {
        !d.object_type.starts_with("INCOMING ") && d.owner == item.target_schema
            && ((d.object_type == "TABLE" && request.tables.iter().any(|table| request.target_table_name(table) == d.name))
                || request.object_selection_mode().selections().iter().any(|s| {
                    !is_type(s.object_type) && format!("{:?}", s.object_type).to_ascii_uppercase() == d.object_type.replace(['_', ' '], "") && s.names.contains(&d.name)
                }))
    })
}
fn late_bodies(plan: &[Planned], request: &TransferRequest) -> HashSet<String> {
    let mut late: HashSet<_> = plan.iter().filter(|p| after_objects(&p.item, request)).map(|p| p.item.name.clone()).collect();
    loop {
        let before = late.len();
        for entry in plan.iter().filter(|p| p.item.object_type == TransferObjectKind::TypeBody) {
            if entry.item.dependencies.iter().any(|d| d.owner == entry.item.target_schema && d.object_type.replace(' ', "_") == "TYPE_BODY" && late.contains(&d.name)) {
                late.insert(entry.item.name.clone());
            }
        }
        if before == late.len() { return late; }
    }
}
fn text(row: &[serde_json::Value], index: usize) -> Result<String, String> {
    row.get(index).and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| "Type dictionary returned incomplete metadata".into())
}
async fn metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool_with_max_rows(state, pool, sql, Some(i32::MAX as usize)).await?;
    if result.truncated || result.has_more { return Err("Type metadata is incomplete; transfer blocked".into()); }
    Ok(result)
}
async fn source(state: &AppState, connection: &str, database: &str, owner: &str, name: &str, kind: TransferObjectKind) -> Result<String, String> {
    let source = crate::schema::get_object_source_core(state, connection, database, owner, name, source_kind(kind), None, None).await?;
    let (_, _, tail) = oracle_packages::declaration(&source.source, kind)?;
    if oracle_packages::sql_words(&tail).iter().all(|word| word == ";" || word == "/") { return Err("Incomplete type declaration cannot be migrated".into()); }
    Ok(source.source)
}
async fn details(state: &AppState, connection: &str, database: &str, owner: &str, name: &str, kind: TransferObjectKind) -> Result<OracleTypeDetails, String> {
    let value = crate::schema::oracle_types::get_oracle_type_details_core(state, connection, database, owner, name, api_kind(kind)).await?;
    require_details(&value)?;
    Ok(value)
}
fn readable(state: &OracleMetadataReadState) -> bool { matches!(state, OracleMetadataReadState::Available | OracleMetadataReadState::Empty) }
fn require_details(value: &OracleTypeDetails) -> Result<(), String> {
    if value.status.as_deref() != Some("VALID") { return Err("Source TYPE/BODY is not VALID".into()); }
    require_metadata(value)
}
fn require_metadata(value: &OracleTypeDetails) -> Result<(), String> {
    if !readable(&value.pairing_state) || !readable(&value.dependencies.state) {
        return Err("Type status, pairing or dependencies are invalid, unknown, denied or unsupported".into());
    }
    if let Some(pair) = &value.paired_object {
        if pair.schema != value.identity.schema || pair.name != value.identity.name || pair.object_type == value.identity.object_type { return Err("Type pairing identity does not match owner/name/specification/body".into()); }
    } else if value.identity.object_type == "TYPE_BODY" { return Err("TYPE BODY has no visible paired TYPE".into()); }
    Ok(())
}
async fn user_type(state: &AppState, pool: &str, connection: &str, database: &str, owner: &str, name: &str) -> Result<String, String> {
    // E09a owns the user/maintained-schema inventory filter. In OB 4.2.5
    // ORACLE_MAINTAINED is NULL, so '= N' is not a valid cross-engine filter.
    let kinds = vec!["TYPE".to_string()];
    let inventory = crate::schema::list_objects_core(state, connection, database, owner, None, None, None, Some(&kinds), None).await?;
    if inventory.iter().filter(|o| o.name == name && o.object_type == "TYPE" && o.schema.as_deref() == Some(owner)).count() != 1 {
        return Err("Selected object is not a visible E09a user TYPE with exact owner/name identity".into());
    }
    let rows = metadata(state, pool, &format!("SELECT T.TYPECODE FROM ALL_TYPES T JOIN ALL_OBJECTS O ON O.OWNER=T.OWNER AND O.OBJECT_NAME=T.TYPE_NAME AND O.OBJECT_TYPE='TYPE' WHERE T.OWNER={} AND T.TYPE_NAME={} AND T.PREDEFINED='NO' AND O.GENERATED='N'", quote_string_literal(owner), quote_string_literal(name))).await?.rows;
    if rows.len() != 1 { return Err("Selected object is not a visible, non-generated user type".into()); }
    let code = text(&rows[0], 0)?;
    if !matches!(code.as_str(), "OBJECT" | "COLLECTION") { return Err(format!("Unsupported user type category: {code}")); }
    Ok(code)
}
async fn object_status(state: &AppState, pool: &str, owner: &str, name: &str, kind: &str) -> Result<Option<String>, String> {
    let rows = metadata(state, pool, &format!("SELECT STATUS FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={}", quote_string_literal(owner), quote_string_literal(name), quote_string_literal(&kind.replace('_', " ")))).await?.rows;
    if rows.len() > 1 { return Err("Ambiguous type dependency identity".into()); }
    rows.first().map(|row| text(row, 0)).transpose()
}
fn conversion_profile(source_type: &DatabaseType, source_banner: &str, target_type: &DatabaseType, target_banner: &str) -> Result<bool, String> {
    dbx_sql_core::oracle_program_compatibility::conversion_profile(source_type, source_banner, target_type, target_banner)
}
async fn check_engines(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<bool, String> {
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    if !matches!(source_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) || !matches!(target_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) { return Err("TYPE migration requires Oracle or OceanBase Oracle endpoints".into()); }
    let sql = |kind: &DatabaseType| if *kind == DatabaseType::Oracle { "SELECT BANNER FROM V$VERSION WHERE BANNER LIKE 'Oracle Database%'" } else { "SELECT OB_VERSION() FROM DUAL" };
    let source_version = metadata(state, source, sql(&source_type)).await?.rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Source version is unknown")?;
    let target_version = metadata(state, target, sql(&target_type)).await?.rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Target version is unknown")?;
    conversion_profile(&source_type, &source_version, &target_type, &target_version)
}

/// A fully visible target inventory is required before replacing a type. ALL_* alone
/// cannot prove that another schema has no stored data or program dependency.
async fn incoming(state: &AppState, pool: &str, owner: &str, name: &str, complete: bool) -> Result<Vec<TransferSchemaObjectDependency>, String> {
    let prefix = if complete { "DBA" } else { "ALL" };
    let mut sql = format!("SELECT OWNER, NAME, TYPE FROM {prefix}_DEPENDENCIES WHERE REFERENCED_OWNER={} AND REFERENCED_NAME={} AND REFERENCED_TYPE='TYPE' UNION SELECT OWNER, TABLE_NAME, 'TABLE COLUMN ' || COLUMN_NAME FROM {prefix}_TAB_COLUMNS WHERE DATA_TYPE_OWNER={} AND DATA_TYPE={}", quote_string_literal(owner), quote_string_literal(name), quote_string_literal(owner), quote_string_literal(name));
    if transfer_pool_context(state, pool).await.2 == Some(DatabaseType::Oracle) {
        sql.push_str(&format!(" UNION SELECT OWNER, TABLE_NAME, 'OBJECT TABLE' FROM {prefix}_OBJECT_TABLES WHERE TABLE_TYPE_OWNER={} AND TABLE_TYPE={}", quote_string_literal(owner), quote_string_literal(name)));
    }
    metadata(state, pool, &sql).await?.rows.iter().map(|row| Ok(TransferSchemaObjectDependency { owner: text(row, 0)?, name: text(row, 1)?, object_type: format!("INCOMING {}", text(row, 2)?), available: true })).collect()
}
fn replacement_allowed(incoming: &[TransferSchemaObjectDependency], owner: &str, name: &str, kind: TransferObjectKind, selection: &[(TransferObjectKind, String)]) -> Result<(), String> {
    // Replacing a body cannot change stored type attributes. Replacing a specification
    // with table/type/program dependents must not rely on FORCE or a cascading drop.
    if kind == TransferObjectKind::TypeBody { return Ok(()); }
    if incoming.iter().any(|d| !(d.owner == owner && d.name == name && d.object_type == "INCOMING TYPE BODY" && selection.contains(&(TransferObjectKind::TypeBody, name.into())))) {
        return Err("Existing target table/type/program dependencies prevent safe type replacement; no FORCE/CASCADE is used".into());
    }
    Ok(())
}
fn selected_incoming_tables(request: &TransferRequest, incoming: &[TransferSchemaObjectDependency], source_owner: &str) -> bool {
    request.create_table && incoming.iter().any(|dependency| {
        dependency.owner == source_owner && request.tables.contains(&dependency.name)
            && (dependency.object_type == "INCOMING TABLE" || dependency.object_type == "INCOMING OBJECT TABLE" || dependency.object_type.starts_with("INCOMING TABLE COLUMN "))
    })
}
async fn ensure_selected_table_types(state: &AppState, request: &TransferRequest, source_pool: &str, target_pool: &str) -> Result<(), String> {
    if !request.create_table { return Ok(()); }
    let source_owner = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_owner = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    for table in &request.tables {
        let mut sql = format!("SELECT DATA_TYPE_OWNER, DATA_TYPE FROM ALL_TAB_COLUMNS WHERE OWNER={} AND TABLE_NAME={} AND DATA_TYPE_OWNER IS NOT NULL", quote_string_literal(&source_owner), quote_string_literal(table));
        if source_type == DatabaseType::Oracle { sql.push_str(&format!(" UNION SELECT TABLE_TYPE_OWNER, TABLE_TYPE FROM ALL_OBJECT_TABLES WHERE OWNER={} AND TABLE_NAME={}", quote_string_literal(&source_owner), quote_string_literal(table))); }
        for row in metadata(state, source_pool, &sql).await?.rows {
            let owner = text(&row, 0)?; let name = text(&row, 1)?;
            if matches!(owner.as_str(), "SYS" | "SYSTEM") { continue; }
            if target_type == DatabaseType::OceanbaseOracle { return Err(format!("Table {table} stores user TYPE {owner}.{name}: OceanBase 4.2.5 does not support user-defined table columns/object tables")); }
            let mapped_owner = if owner == source_owner { target_owner.clone() } else { owner };
            let planned = mapped_owner == target_owner && selected(request).contains(&(TransferObjectKind::Type, name.clone()));
            let status = object_status(state, target_pool, &mapped_owner, &name, "TYPE").await?;
            if !oracle_packages::dependency_available(planned, status.as_deref(), request.object_conflict_policy) {
                return Err(format!("Table {table} requires unselected or invalid target TYPE {mapped_owner}.{name}; select its supported definition explicitly or provide a VALID target dependency"));
            }
        }
    }
    Ok(())
}
#[derive(Clone)]
struct Planned { item: TransferSchemaObjectItem, original: Option<String>, original_body: Option<String> }

fn order_plan(items: &mut Vec<Planned>) {
    let mut pending = std::mem::take(items);
    while !pending.is_empty() {
        let next = pending.iter().position(|entry| !entry.item.dependencies.iter().any(|dependency| pending.iter().any(|other| {
            dependency.owner == other.item.target_schema && dependency.name == other.item.name && dependency.object_type == api_kind(other.item.object_type)
        })));
        if let Some(index) = next { items.push(pending.remove(index)); } else {
            for mut entry in pending { entry.item.action = "blocked".into(); entry.item.errors.push("Selected type dependency cycle requires an explicit migration plan".into()); items.push(entry); }
            break;
        }
    }
}
async fn build_plan(state: &AppState, request: &TransferRequest, source_pool: &str, target_pool: &str, phase: Option<Phase>) -> Result<Vec<Planned>, String> {
    let selection = selected(request);
    let source_owner = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_owner = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let mut engine_check = check_engines(state, request, source_pool, target_pool).await;
    if engine_check.is_ok() && phase != Some(Phase::AfterObjects) {
        if let Err(error) = ensure_selected_table_types(state, request, source_pool, target_pool).await { engine_check = Err(error); }
    }
    let mut plan = Vec::new();
    for (kind, name) in &selection {
        // Specifications already ran before tables. Replanning them after tables would
        // mistake newly-created table dependencies for pre-existing replacement impact.
        if phase == Some(Phase::AfterObjects) && *kind == TransferObjectKind::Type { continue; }
        let mut entry = Planned { item: TransferSchemaObjectItem { execution_phase: None, credential_required: None, object_type: *kind, name: name.clone(), source_schema: source_owner.clone(), target_schema: target_owner.clone(), action: "create".into(), ddl: String::new(), dependencies: Vec::new(), warnings: vec!["Source incoming dependencies are limited to the current account's visibility. Explicit owner references in the body are preserved. Grants are not copied.".into()], errors: Vec::new() }, original: None, original_body: None };
        let preparation: Result<(), String> = async {
            let conversion = engine_check.clone()?;
            if request.source_connection_id == request.target_connection_id && source_owner == target_owner { return Err("Source and target type identities must differ".into()); }
            user_type(state, source_pool, &request.source_connection_id, &request.source_database, &source_owner, name).await?;
            let source_details = details(state, &request.source_connection_id, &request.source_database, &source_owner, name, *kind).await?;
            if *kind == TransferObjectKind::TypeBody && source_details.paired_object.is_none() { return Err("Selected TYPE BODY has no visible paired TYPE specification".into()); }
            let original = source(state, &request.source_connection_id, &request.source_database, &source_owner, name, *kind).await?;
            let mut converted = original.clone();
            if conversion {
                if get_db_type(state, &request.source_connection_id).await? == DatabaseType::Oracle {
                    let rows = metadata(state, source_pool, &format!("SELECT OBJECT_TYPE, EDITION_NAME FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE IN ('TYPE','TYPE BODY')", quote_string_literal(&source_owner), quote_string_literal(name))).await?.rows;
                    let expected = if source_details.paired_object.is_some() { 2 } else { 1 };
                    if rows.len() != expected || rows.iter().any(|row| !row.get(1).is_some_and(serde_json::Value::is_null)) { return Err("Edition-specific or unreadable TYPE/specification/body identity cannot be converted".into()); }
                }
                if get_db_type(state, &request.target_connection_id).await? == DatabaseType::Oracle {
                    let rows = metadata(state, target_pool, &format!("SELECT EDITIONS_ENABLED FROM ALL_USERS WHERE USERNAME={}", quote_string_literal(&target_owner))).await?.rows;
                    if rows.len() != 1 || text(&rows[0], 0)? != "N" { return Err("TYPE conversion to an edition-enabled or unknown Oracle target schema is not confirmed".into()); }
                }
                let (prefix, _, _) = oracle_packages::declaration(&original, *kind)?;
                let edition = Regex::new(r"(?is)(CREATE\s+(?:OR\s+REPLACE\s+)?)(?:NON)?EDITIONABLE(\s+TYPE(?:\s+BODY)?\s*)$").unwrap();
                if edition.is_match(&prefix) {
                    if get_db_type(state, &request.source_connection_id).await? != DatabaseType::Oracle { return Err("OceanBase editionability syntax is not a confirmed conversion input".into()); }
                    converted.replace_range(..prefix.len(), &edition.replace(&prefix, "$1$2"));
                    entry.item.warnings.push("Removed declaration editionability for the current noneditioned source instance (EDITION_NAME is NULL). Future edition capability is not preserved; edition-specific objects are blocked.".into());
                }
                compatible_source(&converted, *kind, &source_details)?;
            }
            entry.item.ddl = oracle_packages::map_header(&converted, *kind, name, &target_owner)?;
            let words = oracle_packages::sql_words(&oracle_packages::declaration(&original, *kind)?.2);
            for dependency in source_details.dependencies.rows {
                if dependency.referenced_link.as_deref().is_some_and(|link| !link.is_empty()) { return Err("Remote type dependencies cannot be verified for migration".into()); }
                let owner = dependency.referenced_schema.ok_or("Type dependency owner is unknown")?;
                let explicit = words.windows(3).any(|part| oracle_packages::identifier_word(&part[0]) == owner && part[1] == "." && oracle_packages::identifier_word(&part[2]) == dependency.referenced_name);
                let mapped_name = if owner == source_owner && dependency.referenced_type == "TABLE" && request.tables.contains(&dependency.referenced_name) {
                    request.target_table_name(&dependency.referenced_name)
                } else { dependency.referenced_name.clone() };
                let local_selected = owner == source_owner && (dependency_kind_for(&dependency.referenced_type).is_some_and(|dependency_kind| selection.contains(&(dependency_kind, dependency.referenced_name.clone()))
                    || (*kind == TransferObjectKind::TypeBody && dependency_kind == TransferObjectKind::Type && dependency.referenced_name == *name))
                    || request.tables.contains(&dependency.referenced_name)
                    || request.object_selection_mode().selections().iter().any(|s| format!("{:?}", s.object_type).to_ascii_uppercase() == dependency.referenced_type.replace(['_', ' '], "") && s.names.contains(&dependency.referenced_name)));
                if explicit && local_selected {
                    entry.item.ddl = map_reference_as(&entry.item.ddl, &source_owner, &dependency.referenced_name, &target_owner, &mapped_name)?;
                }
                if local_selected && dependency.referenced_type == "TABLE" {
                    entry.item.ddl = map_unqualified_table(&entry.item.ddl, &dependency.referenced_name, &target_owner, &mapped_name)?;
                }
                let mapped_owner = if owner == source_owner && (!explicit || local_selected) { target_owner.clone() } else { owner };
                let dependency_kind = match dependency.referenced_type.as_str() { "TYPE" => Some(TransferObjectKind::Type), "TYPE_BODY" => Some(TransferObjectKind::TypeBody), _ => None };
                let planned = mapped_owner == target_owner && (dependency_kind.is_some_and(|kind| selection.contains(&(kind, dependency.referenced_name.clone())))
                    || (*kind == TransferObjectKind::TypeBody && ((dependency.referenced_type == "TABLE" && request.tables.contains(&dependency.referenced_name))
                        || request.object_selection_mode().selections().iter().any(|s| !is_type(s.object_type) && format!("{:?}", s.object_type).to_ascii_uppercase() == dependency.referenced_type.replace(['_', ' '], "") && s.names.contains(&dependency.referenced_name)))));
                // Dictionary self references do not form a migration edge.
                if mapped_owner == target_owner && dependency.referenced_name == *name && dependency_kind == Some(*kind) { continue; }
                let available = planned || object_status(state, target_pool, &mapped_owner, &mapped_name, &dependency.referenced_type).await?.as_deref() == Some("VALID");
                entry.item.dependencies.push(TransferSchemaObjectDependency { owner: mapped_owner, name: mapped_name, object_type: dependency.referenced_type.replace(' ', "_"), available });
            }
            if *kind == TransferObjectKind::TypeBody && !entry.item.dependencies.iter().any(|d| d.owner == target_owner && d.name == *name && d.object_type == "TYPE") {
                let available = selection.contains(&(TransferObjectKind::Type, name.clone())) || object_status(state, target_pool, &target_owner, name, "TYPE").await?.as_deref() == Some("VALID");
                entry.item.dependencies.push(TransferSchemaObjectDependency { owner: target_owner.clone(), name: name.clone(), object_type: "TYPE".into(), available });
            }
            if source_details.paired_object.is_some() && *kind == TransferObjectKind::Type && !selection.contains(&(TransferObjectKind::TypeBody, name.clone())) { entry.item.warnings.push("Source TYPE BODY exists but was not selected; it is not implicitly migrated.".into()); }
            entry.item.dependencies.extend(incoming(state, source_pool, &source_owner, name, false).await?);
            if entry.item.dependencies.iter().any(|d| !d.available) { return Err("Missing or invalid target type dependency".into()); }
            let namespace = metadata(state, target_pool, &format!("SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TYPE','TYPE BODY','SYNONYM')", quote_string_literal(&target_owner), quote_string_literal(name))).await?;
            if namespace.rows.iter().any(|r| text(r, 0).is_ok_and(|kind| kind != "TYPE" && kind != "TYPE BODY")) { return Err("Target type name conflicts with another schema object".into()); }
            let existing = object_status(state, target_pool, &target_owner, name, dictionary_kind(*kind)).await?;
            if selected_incoming_tables(request, &entry.item.dependencies, &source_owner)
                && get_db_type(state, &request.target_connection_id).await? == DatabaseType::OceanbaseOracle {
                return Err("OceanBase 4.2.5 user-defined types cannot be stored as table columns or object tables; selected referencing table structure is unsupported".into());
            }
            if existing.is_some() {
                user_type(state, target_pool, &request.target_connection_id, &request.target_database, &target_owner, name).await?;
                if request.object_conflict_policy == TransferObjectConflictPolicy::Skip { entry.item.action = "skip".into(); return Ok(()); }
                entry.item.action = "replace".into();
                let target_details = crate::schema::oracle_types::get_oracle_type_details_core(state, &request.target_connection_id, &request.target_database, &target_owner, name, api_kind(*kind)).await?;
                require_metadata(&target_details)?;
                if !readable(&target_details.grants.state) { return Err("Target grants are unknown; safe replacement cannot be prepared".into()); }
                let dependents = incoming(state, target_pool, &target_owner, name, true).await?;
                replacement_allowed(&dependents, &target_owner, name, *kind, &selection)?;
                entry.item.dependencies.extend(dependents);
                entry.original = Some(source(state, &request.target_connection_id, &request.target_database, &target_owner, name, *kind).await?);
                if *kind == TransferObjectKind::Type && target_details.paired_object.is_some() { entry.original_body = Some(source(state, &request.target_connection_id, &request.target_database, &target_owner, name, TransferObjectKind::TypeBody).await?); }
            }
            let privileges = metadata(state, target_pool, "SELECT PRIVILEGE FROM SESSION_PRIVS").await?.rows;
            let login_rows = metadata(state, target_pool, "SELECT USER FROM DUAL").await?.rows;
            let login = login_rows.first().map(|r| text(r, 0)).transpose()?.ok_or("Target login is unknown")?;
            let required = if login == target_owner { "CREATE TYPE" } else { "CREATE ANY TYPE" };
            if !privileges.iter().any(|r| text(r, 0).ok().as_deref() == Some(required)) { return Err(format!("Missing target privilege: {required}")); }
            Ok(())
        }.await;
        if let Err(error) = preparation { entry.item.action = "blocked".into(); entry.item.errors.push(error); }
        plan.push(entry);
    }
    // Selection cannot make an invalid skipped specification into a usable dependency.
    let skipped: HashSet<_> = plan.iter().filter(|p| p.item.action == "skip").map(|p| (p.item.target_schema.clone(), p.item.name.clone(), api_kind(p.item.object_type).to_string())).collect();
    for entry in &mut plan {
        for dependency in &mut entry.item.dependencies {
            if skipped.contains(&(dependency.owner.clone(), dependency.name.clone(), dependency.object_type.clone())) {
                dependency.available = object_status(state, target_pool, &dependency.owner, &dependency.name, &dependency.object_type).await?.as_deref() == Some("VALID");
                if !dependency.available { entry.item.action = "blocked".into(); entry.item.errors.push("Selected skipped type dependency is invalid".into()); }
            }
        }
    }
    order_plan(&mut plan);
    let late = late_bodies(&plan, request);
    for entry in &mut plan {
        let deferred = late.contains(&entry.item.name) && entry.item.object_type == TransferObjectKind::TypeBody;
        entry.item.execution_phase = Some(if deferred { "afterObjects" } else { "beforeTables" }.into());
        entry.item.warnings.push(if deferred {
            "Execution phase: after the selected tables and programs this TYPE BODY depends on."
        } else { "Execution phase: before selected table DDL/data and dependent programs." }.into());
    }
    Ok(plan)
}
pub(super) fn order_preview_phases(plan: &mut TransferSchemaObjectPlan, request: &TransferRequest) {
    let types: Vec<_> = plan.items.iter().filter(|i| is_type(i.object_type)).map(|i| Planned { item: i.clone(), original: None, original_body: None }).collect();
    let late = late_bodies(&types, request);
    let (mut before, after): (Vec<_>, Vec<_>) = std::mem::take(&mut plan.items).into_iter().partition(|i| i.object_type != TransferObjectKind::TypeBody || !late.contains(&i.name));
    before.extend(after); plan.items = before;
}
pub(super) async fn preview(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<Option<TransferSchemaObjectPlan>, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(None); }
    let items: Vec<_> = build_plan(state, request, source, target, None).await?.into_iter().map(|p| p.item).collect();
    Ok(Some(TransferSchemaObjectPlan { can_execute: items.iter().all(|p| p.action != "blocked"), items }))
}
pub(super) async fn ensure_ready(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<(), String> {
    if let Some(plan) = preview(state, request, source, target).await? { if !plan.can_execute { return Err(plan.items.iter().flat_map(|p| p.errors.clone()).collect::<Vec<_>>().join("; ")); } }
    Ok(())
}
#[derive(Serialize)]
struct Backup<'a> { schema: &'a str, name: &'a str, object_type: TransferObjectKind, source: &'a str, paired_body: &'a Option<String> }
fn backup(state: &AppState, entry: &Planned) -> Result<String, String> {
    let directory = state.storage.data_dir().join("transfer-object-backups"); std::fs::create_dir_all(&directory).map_err(|_| "Cannot create type backup directory")?;
    let path = directory.join(format!("type-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let payload = Backup { schema: &entry.item.target_schema, name: &entry.item.name, object_type: entry.item.object_type, source: entry.original.as_deref().ok_or("Missing original type source")?, paired_body: &entry.original_body };
    let mut file = options.open(&path).map_err(|_| "Cannot create type backup")?;
    file.write_all(&serde_json::to_vec(&payload).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|_| "Cannot persist complete type backup")?;
    Ok(path.to_string_lossy().into_owned())
}
async fn verify(state: &AppState, request: &TransferRequest, pool: &str, item: &TransferSchemaObjectItem) -> Result<(), String> {
    let readback = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, item.object_type).await?;
    oracle_packages::verify_readback(&readback, item)?;
    if object_status(state, pool, &item.target_schema, &item.name, dictionary_kind(item.object_type)).await?.as_deref() != Some("VALID") {
        let errors = metadata(state, pool, &format!("SELECT LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE={} ORDER BY SEQUENCE", quote_string_literal(&item.target_schema), quote_string_literal(&item.name), quote_string_literal(dictionary_kind(item.object_type)))).await?;
        return Err(format!("Target type is invalid after creation: {:?}", errors.rows));
    }
    Ok(())
}
pub(super) async fn execute<F: FnMut(TransferProgress)>(state: &AppState, request: &TransferRequest, source_pool: &str, target_pool: &str, phase: Phase, progress: &mut F) -> Result<TransferObjectOutcome, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(TransferObjectOutcome::default()); }
    let plan = build_plan(state, request, source_pool, target_pool, Some(phase)).await?;
    let blocked = plan.iter().any(|p| p.item.action == "blocked");
    let late = late_bodies(&plan, request);
    let mut failed = HashSet::new(); let mut outcome = TransferObjectOutcome::default();
    for entry in plan {
        let item = &entry.item;
        let deferred = item.object_type == TransferObjectKind::TypeBody && late.contains(&item.name);
        if deferred != (phase == Phase::AfterObjects) { continue; }
        let mut result = TransferSchemaObjectResult { object_type: item.object_type, name: item.name.clone(), schema: item.target_schema.clone(), status: "failed".into(), compile_status: None, source_verified: None, error: None, recovery: None };
        let operation: Result<(), String> = async {
            if blocked { return Err(if item.errors.is_empty() { "Type plan is incomplete; no type DDL executed".into() } else { item.errors.join("; ") }); }
            if is_cancelled(&request.transfer_id).await { return Err("Cancelled before type execution".into()); }
            if item.dependencies.iter().any(|d| failed.contains(&(d.owner.clone(), d.name.clone(), d.object_type.clone()))) { return Err("A selected type dependency failed; this object was not executed".into()); }
            if item.action == "skip" { result.status = "skipped".into(); return Ok(()); }
            // Recheck destructive replacement impact immediately before writing.
            let status = object_status(state, target_pool, &item.target_schema, &item.name, dictionary_kind(item.object_type)).await?;
            if entry.original.is_some() != status.is_some() { return Err("Target type changed after planning; preview again".into()); }
            if let Some(original) = &entry.original {
                let current = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, item.object_type).await?;
                let original_item = TransferSchemaObjectItem { ddl: original.clone(), ..item.clone() };
                oracle_packages::verify_readback(&current, &original_item)?;
                if let Some(body) = &entry.original_body {
                    let current_body = source(state, &request.target_connection_id, &request.target_database, &item.target_schema, &item.name, TransferObjectKind::TypeBody).await?;
                    let body_item = TransferSchemaObjectItem { object_type: TransferObjectKind::TypeBody, ddl: body.clone(), ..item.clone() };
                    oracle_packages::verify_readback(&current_body, &body_item)?;
                }
                let dependents = incoming(state, target_pool, &item.target_schema, &item.name, true).await?;
                replacement_allowed(&dependents, &item.target_schema, &item.name, item.object_type, &selected(request))?;
                let path = backup(state, &entry)?;
                result.recovery = Some(format!("Complete original type source and visible paired body retained at {path}. Restore explicitly after checking current dependencies; no automatic rollback or forced drop."));
            }
            for dependency in item.dependencies.iter().filter(|d| !d.object_type.starts_with("INCOMING ")) {
                if object_status(state, target_pool, &dependency.owner, &dependency.name, &dependency.object_type).await?.as_deref() != Some("VALID") { return Err("Target dependency is not valid at execution time".into()); }
            }
            // Existing transfer writes are non-replayable. There is no DROP/FORCE/CASCADE path.
            execute_on_pool(state, target_pool, &item.ddl).await?;
            verify(state, request, target_pool, item).await?;
            result.status = if item.action == "replace" { "replaced" } else { "created" }.into(); result.compile_status = Some("VALID".into()); result.source_verified = Some(true);
            Ok(())
        }.await;
        if let Err(error) = operation { result.error = Some(error); failed.insert((item.target_schema.clone(), item.name.clone(), api_kind(item.object_type).to_string())); }
        let key = format!("{:?}:{}", item.object_type, item.name);
        match result.status.as_str() { "created" | "replaced" => outcome.transferred.push(key), "skipped" => outcome.skipped.push(key), _ => outcome.failed.push(key) }
        progress(TransferProgress { transfer_id: request.transfer_id.clone(), table: format!("schema object: {}", item.name), table_index: request.tables.len(), total_tables: request.tables.len(), rows_transferred: outcome.transferred.len() as u64, total_rows: None, status: if result.error.is_some() { TransferStatus::Error } else { TransferStatus::Running }, error: result.error.clone(), terminal: false, object_result: Some(result.clone()) });
        outcome.object_results.push(result);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::oracle_types::{OracleMetadataSection, OracleTypeIdentity};
    fn item(kind: TransferObjectKind, name: &str) -> Planned {
        Planned { item: TransferSchemaObjectItem { execution_phase: None, credential_required: None, object_type: kind, name: name.into(), source_schema: "SRC".into(), target_schema: "DST".into(), action: "create".into(), ddl: String::new(), dependencies: Vec::new(), warnings: Vec::new(), errors: Vec::new() }, original: None, original_body: None }
    }
    fn dependency(kind: &str, name: &str) -> TransferSchemaObjectDependency {
        TransferSchemaObjectDependency { owner: "DST".into(), name: name.into(), object_type: kind.into(), available: true }
    }
    #[test]
    fn maps_only_declaration_and_preserves_quoted_names_and_owner_references() {
        let original = r#"CREATE OR REPLACE TYPE "SRC"."a.b" AS OBJECT (value "SRC"."Other.Type", text VARCHAR2(30));"#;
        let ddl = oracle_packages::map_header(original, TransferObjectKind::Type, "a.b", "Target Owner").unwrap();
        assert_eq!(ddl, r#"CREATE OR REPLACE TYPE "Target Owner"."a.b" AS OBJECT (value "SRC"."Other.Type", text VARCHAR2(30));"#);
        let plan = TransferSchemaObjectItem { ddl: ddl.clone(), ..item(TransferObjectKind::Type, "a.b").item };
        assert!(oracle_packages::verify_readback(&ddl, &plan).is_ok());
        assert!(oracle_packages::verify_readback(&ddl.replace("VARCHAR2(30)", "VARCHAR2(10)"), &plan).is_err());
        assert!(oracle_packages::map_header(original, TransferObjectKind::TypeBody, "a.b", "DST").is_err());
    }
    #[test]
    fn orders_nested_types_and_their_exact_bodies() {
        let mut nested = item(TransferObjectKind::Type, "Nested"); nested.item.dependencies.push(dependency("TYPE", "Base"));
        let mut body = item(TransferObjectKind::TypeBody, "Nested"); body.item.dependencies.push(dependency("TYPE", "Nested"));
        let mut items = vec![body, nested, item(TransferObjectKind::Type, "Base")];
        order_plan(&mut items);
        assert_eq!(items.iter().map(|p| (p.item.object_type, p.item.name.as_str())).collect::<Vec<_>>(), vec![(TransferObjectKind::Type, "Base"), (TransferObjectKind::Type, "Nested"), (TransferObjectKind::TypeBody, "Nested")]);
    }
    #[test]
    fn cycles_are_blocked_and_incoming_labels_are_not_sort_edges() {
        let mut first = item(TransferObjectKind::Type, "A"); first.item.dependencies.push(dependency("TYPE", "B"));
        let mut second = item(TransferObjectKind::Type, "B"); second.item.dependencies.push(dependency("TYPE", "A"));
        let mut items = vec![first, second]; order_plan(&mut items);
        assert!(items.iter().all(|p| p.item.action == "blocked"));
        let mut item = item(TransferObjectKind::Type, "A"); item.item.dependencies.push(dependency("INCOMING TYPE BODY", "A"));
        let mut items = vec![item]; order_plan(&mut items); assert_eq!(items[0].item.action, "create");
    }
    #[test]
    fn existing_data_and_program_dependencies_block_specification_replacement() {
        for kind in ["INCOMING TABLE COLUMN PAYLOAD", "INCOMING PACKAGE", "INCOMING TYPE"] {
            assert!(replacement_allowed(&[dependency(kind, "Consumer")], "DST", "T", TransferObjectKind::Type, &[]).is_err());
        }
        let body = dependency("INCOMING TYPE BODY", "T");
        assert!(replacement_allowed(&[body.clone()], "DST", "T", TransferObjectKind::Type, &[]).is_err());
        assert!(replacement_allowed(&[body], "DST", "T", TransferObjectKind::Type, &[(TransferObjectKind::TypeBody, "T".into())]).is_ok());
    }
    #[test]
    fn incoming_table_selection_is_classified_without_a_separate_type_run() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({"transferId":"t","sourceConnectionId":"s","sourceDatabase":"SRC","sourceSchema":"SRC","targetConnectionId":"t","targetDatabase":"DST","targetSchema":"DST","tables":["PAYLOAD"],"createTable":true,"batchSize":10})).unwrap();
        let incoming = vec![TransferSchemaObjectDependency { owner: "SRC".into(), name: "PAYLOAD".into(), object_type: "INCOMING TABLE COLUMN VALUE".into(), available: true }];
        assert!(selected_incoming_tables(&request, &incoming, "SRC"));
        assert!(!selected_incoming_tables(&request, &incoming, "OTHER"));
        let mut data_only = request.clone(); data_only.create_table = false;
        assert!(!selected_incoming_tables(&data_only, &incoming, "SRC"));
    }
    fn type_details(kind: &str) -> OracleTypeDetails {
        OracleTypeDetails { identity: OracleTypeIdentity { schema: "SRC".into(), name: "T".into(), object_type: kind.into() }, status: Some("VALID".into()), paired_object: None, pairing_state: OracleMetadataReadState::Empty, dependencies: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None }, grants: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None } }
    }
    #[test]
    fn both_engine_directions_use_the_confirmed_conversion_profile() {
        for oracle in ["Oracle Database 19c Enterprise Edition", "Oracle Database 21c Enterprise Edition"] {
            assert_eq!(conversion_profile(&DatabaseType::Oracle, oracle, &DatabaseType::OceanbaseOracle, "4.2.5.6").unwrap(), true);
            assert_eq!(conversion_profile(&DatabaseType::OceanbaseOracle, "4.2.5.6", &DatabaseType::Oracle, oracle).unwrap(), true);
        }
        assert!(conversion_profile(&DatabaseType::Oracle, "Oracle Database 23ai", &DatabaseType::OceanbaseOracle, "4.2.5").unwrap_err().contains("fixed-version"));
        assert!(conversion_profile(&DatabaseType::Oracle, "Oracle Database 19c", &DatabaseType::OceanbaseOracle, "4.3.0").is_err());
    }
    #[test]
    fn converts_common_object_collection_and_method_forms_with_exact_rejections() {
        let details = type_details("TYPE");
        for sql in [
            "CREATE TYPE T AS OBJECT (age NUMBER(10,2), label VARCHAR2(30 CHAR), MEMBER FUNCTION get_age RETURN NUMBER, STATIC PROCEDURE p(n IN NUMBER));",
            "CREATE TYPE T AS TABLE OF NUMBER;",
            "CREATE TYPE T AS VARRAY(10) OF VARCHAR2(30);",
        ] { assert!(compatible_source(sql, TransferObjectKind::Type, &details).is_ok(), "{sql}"); }
        for sql in ["CREATE TYPE T UNDER B (x NUMBER);", "CREATE TYPE T AS OBJECT (x NUMBER) NOT FINAL;", "CREATE TYPE T OID '123' AS OBJECT (x NUMBER);", "CREATE TYPE T AS OBJECT (x BFILE);", "CREATE TYPE T AS OBJECT (x TIMESTAMP);"] {
            assert!(compatible_source(sql, TransferObjectKind::Type, &details).is_err(), "{sql}");
        }
        let body = "CREATE TYPE BODY T AS MEMBER FUNCTION age RETURN NUMBER IS n NUMBER; BEGIN SELECT NVL(age,0) INTO n FROM EMP WHERE id=SELF.id; IF n < 0 THEN n := ABS(n); END IF; RETURN n; EXCEPTION WHEN NO_DATA_FOUND THEN RETURN 0; END; END;";
        assert!(compatible_source(body, TransferObjectKind::TypeBody, &details).is_ok());
        assert!(compatible_source(&body.replace("ABS(n)", "unknown_call(n)"), TransferObjectKind::TypeBody, &details).unwrap_err().contains("UNKNOWN_CALL"));
        assert!(compatible_source("CREATE TYPE BODY T AS STATIC FUNCTION f RETURN NUMBER IS BEGIN RETURN SELF.age; END; END;", TransferObjectKind::TypeBody, &details).is_err());
    }
    #[test]
    fn maps_only_confirmed_qualified_identifiers_outside_literals_and_comments() {
        let sql = r#"SRC."a.b" -- SRC."a.b"
/* SRC."a.b" */ 'SRC."a.b"' q'[SRC."a.b"]' nq'{SRC."a.b"}' OTHER."a.b" + "SRC"."a.b""#;
        let mapped = map_reference(sql, "SRC", "a.b", "Target Owner").unwrap();
        assert!(mapped.starts_with("\"Target Owner\".\"a.b\" -- SRC.\"a.b\""));
        assert!(mapped.contains("/* SRC.\"a.b\" */ 'SRC.\"a.b\"' q'[SRC.\"a.b\"]' nq'{SRC.\"a.b\"}' OTHER.\"a.b\""));
        assert!(mapped.ends_with("\"Target Owner\".\"a.b\""));
        assert_eq!(map_reference_as("SELECT value FROM SRC.PAYLOAD", "SRC", "PAYLOAD", "DST", "payload").unwrap(), "SELECT value FROM \"DST\".\"payload\"");
        assert_eq!(map_unqualified_table("SELECT value INTO n FROM PAYLOAD WHERE note='FROM PAYLOAD'", "PAYLOAD", "DST", "payload").unwrap(), "SELECT value INTO n FROM \"DST\".\"payload\" WHERE note='FROM PAYLOAD'");
        assert!(map_reference("CREATE TYPE BODY T AS MEMBER FUNCTION f(SRC T) RETURN NUMBER IS BEGIN RETURN SRC.T; END; END;", "SRC", "T", "DST").unwrap_err().contains("shadows"));
    }
    #[test]
    fn type_specs_and_independent_bodies_precede_tables_but_dependent_bodies_follow_programs() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({"transferId":"t","sourceConnectionId":"s","sourceDatabase":"SRC","targetConnectionId":"t","targetDatabase":"DST","tables":["PAYLOAD"],"createTable":true,"batchSize":10,"objects":[{"objectType":"PACKAGE","names":["P"]}]})).unwrap();
        let spec = item(TransferObjectKind::Type, "T");
        let independent = item(TransferObjectKind::TypeBody, "B");
        let mut dependent = item(TransferObjectKind::TypeBody, "T");
        dependent.item.dependencies.extend([dependency("TABLE", "PAYLOAD"), dependency("PACKAGE", "P"), dependency("TYPE", "T")]);
        let mut follower = item(TransferObjectKind::TypeBody, "C"); follower.item.dependencies.push(dependency("TYPE_BODY", "T"));
        let planned = vec![spec, independent, dependent, follower];
        let late = late_bodies(&planned, &request);
        assert_eq!(late, HashSet::from(["T".to_string(), "C".to_string()]));
        let mut preview = TransferSchemaObjectPlan { can_execute: true, items: planned.into_iter().map(|p| p.item).collect() };
        preview.items.push(item(TransferObjectKind::Package, "P").item);
        order_preview_phases(&mut preview, &request);
        assert_eq!(preview.items.iter().map(|i| (i.object_type, i.name.as_str())).collect::<Vec<_>>(), vec![(TransferObjectKind::Type, "T"), (TransferObjectKind::TypeBody, "B"), (TransferObjectKind::Package, "P"), (TransferObjectKind::TypeBody, "T"), (TransferObjectKind::TypeBody, "C")]);
    }
    #[test]
    fn unknown_or_denied_metadata_cannot_mean_no_dependencies() {
        let mut details = OracleTypeDetails { identity: OracleTypeIdentity { schema: "SRC".into(), name: "T".into(), object_type: "TYPE".into() }, status: Some("VALID".into()), paired_object: None, pairing_state: OracleMetadataReadState::Empty, dependencies: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None }, grants: OracleMetadataSection { state: OracleMetadataReadState::Empty, rows: Vec::new(), message: None } };
        assert!(require_details(&details).is_ok());
        for state in [OracleMetadataReadState::Unknown, OracleMetadataReadState::Denied, OracleMetadataReadState::Unsupported, OracleMetadataReadState::Error] { details.dependencies.state = state; assert!(require_details(&details).is_err()); }
        details.dependencies.state = OracleMetadataReadState::Empty; details.identity.object_type = "TYPE_BODY".into(); assert!(require_details(&details).is_err());
        details.paired_object = Some(OracleTypeIdentity { schema: "OTHER".into(), name: "T".into(), object_type: "TYPE".into() }); assert!(require_details(&details).is_err());
        details.paired_object.as_mut().unwrap().schema = "SRC".into(); assert!(require_details(&details).is_ok());
        details.status = None; assert!(require_details(&details).is_err());
    }
    #[test]
    fn version_support_does_not_assume_unknown_releases() {
        assert_eq!(supported_version(&DatabaseType::Oracle, "Oracle Database 19c Enterprise Edition").unwrap(), "19c");
        assert!(supported_version(&DatabaseType::Oracle, "Oracle Database 11g").is_err());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "4.2.5.6").is_ok());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "OceanBase 4.3.0").is_err());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "5.7.25-OceanBase-v4.2.5.0").is_err());
        assert!(supported_version(&DatabaseType::OceanbaseOracle, "3.4.2.5.0").is_err());
    }
    #[test]
    fn invalidated_target_body_metadata_can_be_backed_up_but_invalid_source_is_rejected() {
        let mut target = type_details("TYPE"); target.status = Some("INVALID".into());
        assert!(require_metadata(&target).is_ok());
        assert!(require_details(&target).is_err());
        target.dependencies.state = OracleMetadataReadState::Denied;
        assert!(require_metadata(&target).is_err());
        assert!(!oracle_packages::dependency_available(true, Some("INVALID"), TransferObjectConflictPolicy::Skip));
        assert!(oracle_packages::dependency_available(true, None, TransferObjectConflictPolicy::Skip));
        assert!(oracle_packages::dependency_available(true, Some("INVALID"), TransferObjectConflictPolicy::Replace));
    }
}
