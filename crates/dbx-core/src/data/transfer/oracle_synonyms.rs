//! Transfer the synonym itself using dictionary fields, without resolving it into a table.
use super::oracle_packages::{TransferSchemaObjectDependency, TransferSchemaObjectItem};
use super::*;
use std::io::Write;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct Definition {
    owner: String,
    name: String,
    table_owner: String,
    table_name: String,
    db_link: String,
}

struct Planned {
    item: TransferSchemaObjectItem,
    definition: Option<Definition>,
    existing: Option<Definition>,
}

fn public(owner: &str) -> bool {
    matches!(owner, "PUBLIC" | "__public")
}

fn owner(owner: &str) -> String {
    if public(owner) {
        "PUBLIC".into()
    } else {
        owner.into()
    }
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn is_synonym(kind: TransferObjectKind) -> bool {
    matches!(kind, TransferObjectKind::Synonym | TransferObjectKind::PublicSynonym)
}

fn selected(request: &TransferRequest) -> Vec<(TransferObjectKind, String)> {
    let mut selected = Vec::new();
    for selection in request.object_selection_mode().selections() {
        if is_synonym(selection.object_type) {
            for name in &selection.names {
                let key = (selection.object_type, name.clone());
                if !selected.contains(&key) {
                    selected.push(key);
                }
            }
        }
    }
    selected
}

fn owner_filter(schema: &str) -> String {
    if public(schema) {
        "OWNER IN ('PUBLIC', '__public')".into()
    } else {
        format!("OWNER = {}", quote_string_literal(schema))
    }
}

async fn metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool(state, pool, sql).await?;
    if result.truncated {
        return Err("Synonym metadata is truncated; complete preflight/readback is required".into());
    }
    Ok(result)
}

fn text(row: &[serde_json::Value], index: usize) -> String {
    row.get(index).and_then(|v| v.as_str()).unwrap_or_default().into()
}

async fn read(state: &AppState, pool: &str, schema: &str, name: &str) -> Result<Option<Definition>, String> {
    let result = metadata(
        state,
        pool,
        &format!(
        "SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK FROM ALL_SYNONYMS WHERE {} AND SYNONYM_NAME = {}",
        owner_filter(schema), quote_string_literal(name)
    ),
    )
    .await?;
    if result.rows.len() > 1 {
        return Err("Ambiguous public synonym dictionary identity".into());
    }
    result
        .rows
        .first()
        .map(|row| {
            let definition = Definition {
                owner: owner(&text(row, 0)),
                name: text(row, 1),
                table_owner: text(row, 2),
                table_name: text(row, 3),
                db_link: text(row, 4),
            };
            if definition.name != name
                || definition.owner != owner(schema)
                || definition.table_owner.is_empty()
                || definition.table_name.is_empty()
            {
                return Err("Incomplete or mismatched synonym dictionary identity".into());
            }
            ddl(&definition)?;
            Ok(definition)
        })
        .transpose()
}

fn ddl(definition: &Definition) -> Result<String, String> {
    let link = if definition.db_link.is_empty() {
        String::new()
    } else {
        // Oracle link names include domain dots. Do not execute arbitrary SQL from metadata.
        if !Regex::new(r"\A[A-Za-z][A-Za-z0-9_$#]*(?:\.[A-Za-z0-9_$#]+)*\z").unwrap().is_match(&definition.db_link) {
            return Err("Database-link identifier requires a reviewed conversion".into());
        }
        format!("@{}", definition.db_link)
    };
    let (scope, name) = if public(&definition.owner) {
        ("PUBLIC ", ident(&definition.name))
    } else {
        ("", format!("{}.{}", ident(&definition.owner), ident(&definition.name)))
    };
    Ok(format!(
        "CREATE OR REPLACE {scope}SYNONYM {name} FOR {}.{}{link}",
        ident(&definition.table_owner),
        ident(&definition.table_name)
    ))
}

fn mapped(source: &Definition, request: &TransferRequest, kind: TransferObjectKind) -> Definition {
    let source_schema = resolve_oracle_schema(&request.source_schema, &request.source_database);
    let target_schema = resolve_oracle_schema(&request.target_schema, &request.target_database);
    let mut target = source.clone();
    target.owner = if kind == TransferObjectKind::PublicSynonym { "PUBLIC".into() } else { target_schema.clone() };
    if source.db_link.is_empty() && source.table_owner == source_schema {
        if request.tables.contains(&source.table_name) {
            target.table_owner = target_schema;
            target.table_name = request.target_table_name(&source.table_name);
        } else if request.object_selection_mode().selections().iter().any(|selection| {
            !matches!(
                selection.object_type,
                TransferObjectKind::Table
                    | TransferObjectKind::PublicSynonym
                    | TransferObjectKind::PackageBody
                    | TransferObjectKind::Trigger
                    | TransferObjectKind::Event
            ) && selection.names.contains(&source.table_name)
        }) {
            target.table_owner = target_schema;
        }
    }
    target
}

fn planned_object(request: &TransferRequest, schema: &str, name: &str) -> bool {
    if schema != resolve_oracle_schema(&request.target_schema, &request.target_database) {
        return false;
    }
    (request.create_table && request.tables.iter().any(|table| request.target_table_name(table) == name))
        || request.object_selection_mode().selections().iter().any(|selection| {
            !matches!(
                selection.object_type,
                TransferObjectKind::Table
                    | TransferObjectKind::PackageBody
                    | TransferObjectKind::Synonym
                    | TransferObjectKind::PublicSynonym
                    | TransferObjectKind::Trigger
                    | TransferObjectKind::Event
            ) && selection.names.iter().any(|selected| selected == name)
        })
}

async fn local_object(state: &AppState, pool: &str, schema: &str, name: &str) -> Result<bool, String> {
    let result = metadata(state, pool, &format!("SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TYPE')", owner_filter(schema), quote_string_literal(name))).await?;
    Ok(!result.rows.is_empty())
}

async fn privileges(state: &AppState, pool: &str, definition: &Definition) -> Result<(), String> {
    let result = metadata(state, pool, "SELECT PRIVILEGE FROM SESSION_PRIVS").await?;
    let granted: HashSet<String> = result.rows.iter().map(|row| text(row, 0)).collect();
    if public(&definition.owner) {
        if !granted.contains("CREATE PUBLIC SYNONYM") {
            return Err("Public synonym requires CREATE PUBLIC SYNONYM; private fallback is forbidden".into());
        }
    } else {
        let user = metadata(state, pool, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_USER') FROM DUAL").await?;
        let own_schema = user.rows.first().map(|row| text(row, 0)).as_deref() == Some(definition.owner.as_str());
        if !granted.contains("CREATE ANY SYNONYM") && !(own_schema && granted.contains("CREATE SYNONYM")) {
            return Err("Target owner requires CREATE SYNONYM or CREATE ANY SYNONYM privilege".into());
        }
    }
    Ok(())
}

async fn dependency_chain(
    state: &AppState,
    pool: &str,
    request: &TransferRequest,
    definition: &Definition,
    planned: &HashMap<(String, String), Definition>,
    allow_planned_objects: bool,
) -> Result<Vec<TransferSchemaObjectDependency>, String> {
    let mut current = definition.clone();
    let mut visited = HashSet::from([(current.owner.clone(), current.name.clone())]);
    let mut dependencies = Vec::new();
    loop {
        if !current.db_link.is_empty() {
            let target_context = resolve_oracle_schema(&request.target_schema, &request.target_database);
            let link_owner = if public(&current.owner) { target_context.as_str() } else { current.owner.as_str() };
            let available = oracle_database_links::dependency_available(state, request, pool, link_owner, &current.db_link, allow_planned_objects).await?;
            dependencies.push(TransferSchemaObjectDependency {
                owner: link_owner.into(),
                name: current.db_link,
                object_type: "DATABASE LINK".into(),
                available,
            });
            // Never dereference the link, read credentials, or claim the remote object exists.
            return Ok(dependencies);
        }
        let key = (owner(&current.table_owner), current.table_name.clone());
        if !visited.insert(key.clone()) {
            return Err("Synonym dependency cycle requires an explicit migration plan".into());
        }
        let next = if let Some(next) = planned.get(&key) {
            Some(next.clone())
        } else {
            read(state, pool, &key.0, &key.1).await?
        };
        if let Some(next) = next {
            dependencies.push(TransferSchemaObjectDependency {
                owner: key.0,
                name: key.1,
                object_type: "SYNONYM".into(),
                available: true,
            });
            current = next;
            continue;
        }
        let available = (allow_planned_objects && planned_object(request, &key.0, &key.1))
            || local_object(state, pool, &key.0, &key.1).await?;
        dependencies.push(TransferSchemaObjectDependency {
            owner: key.0,
            name: key.1,
            object_type: "REFERENCED OBJECT".into(),
            available,
        });
        return Ok(dependencies);
    }
}

fn order_plan(items: &mut Vec<Planned>) {
    let mut pending = std::mem::take(items);
    while !pending.is_empty() {
        let next = pending.iter().position(|item| {
            !item.item.dependencies.iter().any(|dependency| {
                dependency.object_type == "SYNONYM"
                    && pending
                        .iter()
                        .any(|other| other.item.target_schema == dependency.owner && other.item.name == dependency.name)
            })
        });
        if let Some(index) = next {
            items.push(pending.remove(index));
        } else {
            for mut item in pending {
                item.item.action = "blocked".into();
                item.item.errors.push("Selected synonym dependency cycle requires an explicit migration plan".into());
                items.push(item);
            }
            break;
        }
    }
}

async fn build_plan(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
    allow_planned_objects: bool,
) -> Result<Vec<Planned>, String> {
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    let supported = matches!(source_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        && matches!(target_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle);
    let mut items = Vec::new();
    for (kind, name) in selected(request) {
        let source_schema = if kind == TransferObjectKind::PublicSynonym {
            "PUBLIC".into()
        } else {
            resolve_oracle_schema(&request.source_schema, &request.source_database)
        };
        let target_schema = if kind == TransferObjectKind::PublicSynonym {
            "PUBLIC".into()
        } else {
            resolve_oracle_schema(&request.target_schema, &request.target_database)
        };
        let mut entry = Planned {
            item: TransferSchemaObjectItem {
                credential_required: None,
                object_type: kind,
                name: name.clone(),
                source_schema: source_schema.clone(),
                target_schema: target_schema.clone(),
                action: "create".into(),
                ddl: String::new(),
                dependencies: Vec::new(),
                warnings: vec!["Object grants and database-link credentials are not migrated.".into()],
                errors: Vec::new(),
            },
            definition: None,
            existing: None,
        };
        let preparation: Result<(), String> = async {
            if !supported {
                return Err("Synonym transfer supports Oracle and OceanBase Oracle endpoints only".into());
            }
            if kind == TransferObjectKind::Synonym && (public(&source_schema) || public(&target_schema)) {
                return Err("PUBLIC is reserved for explicit public synonym selection; a private synonym cannot use this owner".into());
            }
            if request.source_connection_id == request.target_connection_id && source_schema == target_schema {
                return Err("Source and target synonym identities must differ".into());
            }
            let source = read(state, source_pool, &source_schema, &name)
                .await?.ok_or("Selected synonym is not visible in ALL_SYNONYMS")?;
            let definition = mapped(&source, request, kind);
            entry.item.ddl = ddl(&definition)?;
            if !definition.db_link.is_empty() {
                entry.item.warnings.push("Only local database-link visibility is checked; remote connectivity, permissions and referenced object remain unverified.".into());
            }
            if planned_object(request, &target_schema, &name)
                || local_object(state, target_pool, &target_schema, &name).await?
            {
                return Err("Target synonym name conflicts with an object in the same namespace".into());
            }
            entry.existing = read(state, target_pool, &target_schema, &name).await?;
            if entry.existing.is_some() {
                entry.item.action = if request.object_conflict_policy == TransferObjectConflictPolicy::Skip {
                    "skip"
                } else { "replace" }.into();
            }
            if entry.item.action != "skip" {
                privileges(state, target_pool, &definition).await?;
            }
            let shadow_owner = if public(&target_schema) {
                resolve_oracle_schema(&request.target_schema, &request.target_database)
            } else { "PUBLIC".into() };
            if read(state, target_pool, &shadow_owner, &name).await?.is_some()
                || local_object(state, target_pool, &shadow_owner, &name).await?
            {
                entry.item.warnings.push("A same-name private/public object exists; private schema names take precedence over public synonyms.".into());
            }
            entry.definition = Some(definition);
            Ok(())
        }.await;
        if let Err(error) = preparation {
            entry.item.errors.push(error);
            entry.item.action = "blocked".into();
        }
        items.push(entry);
    }
    let planned: HashMap<_, _> = items
        .iter()
        .filter_map(|entry| {
            let definition = if entry.item.action == "skip" { &entry.existing } else { &entry.definition };
            definition.clone().map(|definition| ((definition.owner.clone(), definition.name.clone()), definition))
        })
        .collect();
    let private_target = resolve_oracle_schema(&request.target_schema, &request.target_database);
    for entry in &mut items {
        if entry.item.action == "blocked" {
            continue;
        }
        let shadow_owner = if public(&entry.item.target_schema) { private_target.clone() } else { "PUBLIC".into() };
        if planned.contains_key(&(shadow_owner, entry.item.name.clone())) {
            entry.item.warnings.push(
                "Both private and public synonyms with this name are selected; private schema names take precedence."
                    .into(),
            );
        }
        let definition = if entry.item.action == "skip" { entry.existing.as_ref() } else { entry.definition.as_ref() };
        if let Some(definition) = definition {
            match dependency_chain(state, target_pool, request, definition, &planned, allow_planned_objects).await {
                Ok(dependencies) => {
                    for dependency in &dependencies {
                        if !dependency.available {
                            entry.item.errors.push(format!(
                                "Missing dependency: {}.{} ({})",
                                dependency.owner, dependency.name, dependency.object_type
                            ));
                        }
                    }
                    entry.item.dependencies = dependencies;
                }
                Err(error) => entry.item.errors.push(error),
            }
        }
        if !entry.item.errors.is_empty() {
            entry.item.action = "blocked".into();
        }
    }
    order_plan(&mut items);
    Ok(items)
}

pub(super) async fn preview(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
) -> Result<Option<TransferSchemaObjectPlan>, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() {
        return Ok(None);
    }
    let items: Vec<_> =
        build_plan(state, request, source_pool, target_pool, true).await?.into_iter().map(|entry| entry.item).collect();
    Ok(Some(TransferSchemaObjectPlan { can_execute: items.iter().all(|item| item.action != "blocked"), items }))
}

pub(super) async fn ensure_ready(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
) -> Result<(), String> {
    if let Some(plan) = preview(state, request, source_pool, target_pool).await? {
        if !plan.can_execute {
            return Err(plan.items.iter().flat_map(|item| item.errors.clone()).collect::<Vec<_>>().join("; "));
        }
    }
    Ok(())
}

fn backup(state: &AppState, definition: &Definition) -> Result<String, String> {
    let directory = state.storage.data_dir().join("transfer-object-backups");
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot create synonym backup directory")?;
    let path = directory.join(format!("synonym-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| "Cannot create synonym backup")?;
    let bytes = serde_json::to_vec(definition).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Cannot persist synonym backup")?;
    Ok(path.to_string_lossy().into_owned())
}

async fn verify(state: &AppState, pool: &str, expected: &Definition) -> Result<(), String> {
    verify_definition(read(state, pool, &expected.owner, &expected.name).await?.as_ref(), expected)
}

fn verify_definition(actual: Option<&Definition>, expected: &Definition) -> Result<(), String> {
    if actual != Some(expected) {
        return Err("Synonym dictionary readback differs from the planned owner/name/target/link definition".into());
    }
    Ok(())
}

pub(super) async fn execute<F: FnMut(TransferProgress)>(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    target_pool: &str,
    progress: &mut F,
) -> Result<TransferObjectOutcome, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() {
        return Ok(TransferObjectOutcome::default());
    }
    // Base tables/routines/packages have already run. They must now actually exist.
    let plan = build_plan(state, request, source_pool, target_pool, false).await?;
    let blocked = plan.iter().any(|entry| entry.item.action == "blocked");
    let mut outcome = TransferObjectOutcome::default();
    let mut failed = HashSet::new();
    for entry in plan {
        let item = &entry.item;
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
        let operation: Result<(), String> = async {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled before synonym execution".into());
            }
            if blocked {
                return Err(if item.errors.is_empty() {
                    "Synonym preflight is incomplete; no synonym DDL executed".into()
                } else {
                    item.errors.join("; ")
                });
            }
            if item
                .dependencies
                .iter()
                .any(|dependency| failed.contains(&(dependency.owner.clone(), dependency.name.clone())))
            {
                return Err("A selected synonym dependency failed; this object was not executed".into());
            }
            if item.action == "skip" {
                result.status = "skipped".into();
                return Ok(());
            }
            let definition = entry.definition.as_ref().ok_or("Missing synonym definition")?;
            if local_object(state, target_pool, &definition.owner, &definition.name).await? {
                return Err("Target name is now occupied by another object".into());
            }
            let existing = read(state, target_pool, &definition.owner, &definition.name).await?;
            if existing.is_some() && request.object_conflict_policy != TransferObjectConflictPolicy::Replace {
                return Err("Target synonym appeared after planning; replacement is not authorized".into());
            }
            privileges(state, target_pool, definition).await?;
            let dependencies =
                dependency_chain(state, target_pool, request, definition, &HashMap::new(), false).await?;
            if dependencies.iter().any(|dependency| !dependency.available) {
                return Err("Synonym dependency is no longer available".into());
            }
            let backup_path = existing.as_ref().map(|definition| backup(state, definition)).transpose()?;
            if let Some(path) = &backup_path {
                result.recovery = Some(format!("Complete target synonym backup retained at {path}"));
            }
            let written = match execute_on_pool(state, target_pool, &item.ddl).await {
                Ok(_) => verify(state, target_pool, definition).await,
                Err(_) => Err("Synonym DDL failed; verify target privileges and dependencies".into()),
            };
            if let Err(error) = written {
                result.source_verified = Some(false);
                if let (Some(original), Some(path)) = (&existing, backup_path) {
                    let restored = execute_on_pool(state, target_pool, &ddl(original)?).await.is_ok()
                        && verify(state, target_pool, original).await.is_ok();
                    result.recovery = Some(format!(
                        "{}; backup retained at {path}",
                        if restored {
                            "Target synonym restored and verified"
                        } else {
                            "Automatic restoration incomplete; manual recovery required"
                        }
                    ));
                } else {
                    result.recovery = Some("New synonym retained for inspection; no DROP was executed".into());
                }
                return Err(error);
            }
            result.status = "transferred".into();
            result.source_verified = Some(true);
            Ok(())
        }
        .await;
        let label = format!("{:?}:{}", item.object_type, item.name);
        if let Err(error) = operation {
            result.error = Some(error);
            failed.insert((item.target_schema.clone(), item.name.clone()));
            outcome.failed.push(label);
        } else if result.status == "skipped" {
            outcome.skipped.push(label);
        } else {
            outcome.transferred.push(label);
        }
        outcome.object_results.push(result.clone());
        progress(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: format!("{:?}: {}.{}", item.object_type, item.target_schema, item.name),
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

    fn request() -> TransferRequest {
        serde_json::from_value(serde_json::json!({"transferId":"s","sourceConnectionId":"s","sourceDatabase":"S","sourceSchema":"S","targetConnectionId":"t","targetDatabase":"T","targetSchema":"T","tables":["TAB"],"createTable":true,"batchSize":10,"objects":[{"objectType":"SYNONYM","names":["NEXT"]},{"objectType":"PUBLIC_SYNONYM","names":["PUB"]}]})).unwrap()
    }

    fn definition(owner: &str, name: &str, target_owner: &str, target: &str, link: &str) -> Definition {
        Definition {
            owner: owner.into(),
            name: name.into(),
            table_owner: target_owner.into(),
            table_name: target.into(),
            db_link: link.into(),
        }
    }

    #[test]
    fn maps_only_explicit_local_references() {
        let request = request();
        for target in ["TAB", "NEXT"] {
            let mapped = mapped(&definition("S", "X", "S", target, ""), &request, TransferObjectKind::Synonym);
            assert_eq!(mapped.owner, "T");
            assert_eq!(mapped.table_owner, "T");
        }
        for (target_owner, target, link) in
            [("S", "OTHER", ""), ("EXTERNAL", "TAB", ""), ("S", "TAB", "REMOTE.EXAMPLE"), ("S", "PUB", "")]
        {
            let source = definition("S", "X", target_owner, target, link);
            let mapped = mapped(&source, &request, TransferObjectKind::Synonym);
            assert_eq!(mapped.table_owner, source.table_owner);
            assert_eq!(mapped.table_name, source.table_name);
            assert_eq!(mapped.db_link, source.db_link);
        }
    }

    #[test]
    fn public_scope_and_quoted_names_are_preserved() {
        let source = definition("__public", "a\"b", "S", "a.b", "");
        let target = mapped(&source, &request(), TransferObjectKind::PublicSynonym);
        assert_eq!(target.owner, "PUBLIC");
        assert_eq!(ddl(&target).unwrap(), "CREATE OR REPLACE PUBLIC SYNONYM \"a\"\"b\" FOR \"S\".\"a.b\"");
        assert_eq!(owner("__public"), "PUBLIC");
        assert_eq!(owner("Mixed"), "Mixed");
    }

    #[test]
    fn remote_link_is_not_resolved_and_unsafe_link_names_are_rejected() {
        assert!(ddl(&definition("T", "X", "REMOTE", "OBJ", "LINK.DOMAIN")).unwrap().ends_with("@LINK.DOMAIN"));
        assert!(ddl(&definition("T", "X", "REMOTE", "OBJ", "LINK; DROP TABLE X")).is_err());
    }

    #[test]
    fn request_selection_and_capabilities_keep_both_scopes_distinct() {
        assert_eq!(
            selected(&request()),
            vec![(TransferObjectKind::Synonym, "NEXT".into()), (TransferObjectKind::PublicSynonym, "PUB".into())]
        );
        for database in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            assert!(transfer_object_kinds(&database).contains(&TransferObjectKind::PublicSynonym));
            assert!(!cross_family_transferable_object_kinds(&database, &DatabaseType::Dameng)
                .contains(&TransferObjectKind::Synonym));
        }
        assert_ne!(definition("T", "X", "A", "B", ""), definition("T", "X", "A", "B", "LINK"));
    }

    #[test]
    fn readback_requires_every_dictionary_field_and_the_object_itself() {
        let expected = definition("T", "X", "A", "B", "LINK.DOMAIN");
        assert!(verify_definition(Some(&expected), &expected).is_ok());
        assert!(verify_definition(None, &expected).is_err());
        for changed in [
            definition("OTHER", "X", "A", "B", "LINK.DOMAIN"),
            definition("T", "OTHER", "A", "B", "LINK.DOMAIN"),
            definition("T", "X", "OTHER", "B", "LINK.DOMAIN"),
            definition("T", "X", "A", "OTHER", "LINK.DOMAIN"),
            definition("T", "X", "A", "B", "OTHER"),
        ] {
            assert!(verify_definition(Some(&changed), &expected).is_err());
        }
    }

    fn planned(name: &str, schema: &str, dependencies: &[(&str, &str)]) -> Planned {
        Planned {
            item: TransferSchemaObjectItem {
                credential_required: None,
                object_type: if public(schema) {
                    TransferObjectKind::PublicSynonym
                } else {
                    TransferObjectKind::Synonym
                },
                name: name.into(),
                source_schema: "S".into(),
                target_schema: schema.into(),
                action: "create".into(),
                ddl: String::new(),
                warnings: Vec::new(),
                errors: Vec::new(),
                dependencies: dependencies
                    .iter()
                    .map(|(owner, name)| TransferSchemaObjectDependency {
                        owner: (*owner).into(),
                        name: (*name).into(),
                        object_type: "SYNONYM".into(),
                        available: true,
                    })
                    .collect(),
            },
            definition: None,
            existing: None,
        }
    }

    #[test]
    fn dependency_order_keeps_scopes_distinct_and_never_adds_objects() {
        let mut items =
            vec![planned("A", "T", &[("PUBLIC", "A")]), planned("A", "PUBLIC", &[("T", "B")]), planned("B", "T", &[])];
        order_plan(&mut items);
        let identities: Vec<_> =
            items.iter().map(|entry| (entry.item.target_schema.as_str(), entry.item.name.as_str())).collect();
        assert_eq!(identities, vec![("T", "B"), ("PUBLIC", "A"), ("T", "A")]);
    }

    #[test]
    fn cyclic_or_self_referencing_selection_is_blocked() {
        for mut items in [
            vec![planned("A", "T", &[("T", "A")])],
            vec![planned("A", "T", &[("PUBLIC", "B")]), planned("B", "PUBLIC", &[("T", "A")])],
        ] {
            let count = items.len();
            order_plan(&mut items);
            assert_eq!(items.len(), count);
            assert!(items.iter().all(|entry| entry.item.action == "blocked" && !entry.item.errors.is_empty()));
        }
    }

    #[test]
    fn mapped_table_case_is_reflected_in_synonym_target() {
        let mut request = request();
        request.target_table_name_case = TransferTableNameCase::Lower;
        let target = mapped(&definition("S", "X", "S", "TAB", ""), &request, TransferObjectKind::Synonym);
        assert_eq!(target.table_name, "tab");
        assert!(planned_object(&request, "T", "tab"));
        assert!(!planned_object(&request, "T", "TAB"));
    }
}
