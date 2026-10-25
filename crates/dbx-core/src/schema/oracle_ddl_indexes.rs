use super::*;
use crate::schema_diff::{
    MissingRollbackObject, OracleSchemaSyncDdlOptions, OracleSchemaSyncDdlSources, OracleSchemaSyncEndpoint,
    OracleSchemaSyncTableDdl, TableDiff,
};
use dbx_sql::object_source_sql::{
    oracle_index_ddl_sources, parse_oracle_table_ddl, separate_oracle_supporting_indexes_with_retained,
    OracleSupportingIndexDdl, OracleSupportingIndexIdentity,
};

async fn oracle_endpoint_type(state: &AppState, endpoint: &OracleSchemaSyncEndpoint) -> Result<DatabaseType, String> {
    if endpoint.connection_id.is_empty() || endpoint.database.is_empty() || endpoint.schema.is_empty() {
        return Err("Independent indexes require a fixed connection, database and schema".into());
    }
    let config = connection_config(state, &endpoint.connection_id).await.ok_or("connection not found")?;
    if config.db_type == DatabaseType::OceanbaseOracle
        || crate::models::connection::jdbc_dialect_hint(&config)
            == Some(crate::models::connection::JdbcDialectHint::OceanbaseOracle)
    {
        Ok(DatabaseType::OceanbaseOracle)
    } else if config.db_type == DatabaseType::Oracle || is_oracle_external_driver_config(&config) {
        Ok(DatabaseType::Oracle)
    } else {
        Err("Independent native indexes require an Oracle or OceanBase Oracle connection".into())
    }
}

fn generation_issue(captured: &mut OracleSchemaSyncTableDdl, kind: &str, name: &str, reason: String) {
    captured.issues.push(MissingRollbackObject {
        kind: kind.into(),
        name: name.into(),
        table: Some(captured.table.clone()),
        reason,
    });
}

async fn capture_comparison_table(
    state: &AppState,
    endpoint: Option<&OracleSchemaSyncEndpoint>,
    diff: &TableDiff,
    rollback: bool,
    separate_supporting_indexes: bool,
) -> OracleSchemaSyncTableDdl {
    let diff_name = diff.name.as_str();
    let table = if rollback { diff.target_name.as_deref().unwrap_or(diff_name) } else { diff_name };
    let source = if rollback { diff.target_ddl.as_deref() } else { diff.ddl.as_deref() };
    let mut result = OracleSchemaSyncTableDdl {
        diff_name: diff_name.into(),
        owner: endpoint.map_or("", |endpoint| endpoint.schema.as_str()).into(),
        table: table.into(),
        table_ddl: source.map(str::to_owned),
        indexes: Vec::new(),
        supporting_indexes: Vec::new(),
        retained_supporting_indexes: Vec::new(),
        protected_drop_indexes: Vec::new(),
        issues: Vec::new(),
    };
    let captured = async {
        let endpoint = endpoint.ok_or("Native table DDL requires its fixed comparison endpoint")?;
        oracle_endpoint_type(state, endpoint).await?;
        let source = if let Some(source) = source {
            source.to_owned()
        } else {
            let source =
                get_table_ddl_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table, None)
                    .await?;
            validate_comparison_snapshot(state, endpoint, table, diff, rollback).await?;
            source
        };
        let identity = parse_oracle_table_ddl(&source)?;
        if identity.table != table || identity.owner.as_deref().is_some_and(|owner| owner != endpoint.schema) {
            return Err("Native DDL does not match the fixed comparison endpoint; compare again".into());
        }
        capture_table_ddl_indexes(
            state,
            &endpoint.connection_id,
            &endpoint.database,
            &endpoint.schema,
            table,
            &source,
            true,
            separate_supporting_indexes,
        )
        .await
    }
    .await;
    match captured {
        Ok(captured) => {
            result.owner = captured.owner;
            result.table_ddl = Some(captured.source);
            result.supporting_indexes = captured.supporting_indexes;
            result.retained_supporting_indexes = captured.retained_supporting_indexes;
        }
        Err(reason) => generation_issue(&mut result, "table", diff_name, reason),
    }
    result
}

async fn validate_comparison_snapshot(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    table: &str,
    diff: &TableDiff,
    rollback: bool,
) -> Result<(), String> {
    let missing = || "Complete table comparison snapshot is unavailable; compare again".to_string();
    let columns = diff
        .columns
        .as_deref()
        .ok_or_else(missing)?
        .iter()
        .map(|column| (if rollback { column.target.clone() } else { column.source.clone() }).ok_or_else(missing))
        .collect::<Result<Vec<_>, _>>()?;
    let indexes = diff
        .indexes
        .as_deref()
        .ok_or_else(missing)?
        .iter()
        .map(|index| (if rollback { index.target.clone() } else { index.source.clone() }).ok_or_else(missing))
        .collect::<Result<Vec<_>, _>>()?;
    let foreign_keys = diff
        .foreign_keys
        .as_deref()
        .ok_or_else(missing)?
        .iter()
        .map(|key| {
            (if rollback { key.target.as_ref() } else { key.source.as_ref() })
                .map(|key| key.info.clone())
                .ok_or_else(missing)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let current_columns =
        get_columns_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table).await?;
    let current_indexes =
        list_indexes_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table).await?;
    let current_foreign_keys =
        list_foreign_keys_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table).await?;
    let mut triggers = diff
        .triggers
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|trigger| (if rollback { trigger.target.clone() } else { trigger.source.clone() }).ok_or_else(missing))
        .collect::<Result<Vec<_>, _>>()?;
    let mut current_triggers =
        list_triggers_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table).await?;
    triggers.sort_by(|left, right| left.name.cmp(&right.name));
    current_triggers.sort_by(|left, right| left.name.cmp(&right.name));
    if crate::schema_diff::diff_columns(&columns, &current_columns).iter().any(|diff| diff.diff_type != "unchanged")
        || crate::schema_diff::diff_indexes(&indexes, &current_indexes).iter().any(|diff| diff.diff_type != "unchanged")
        || crate::schema_diff::diff_foreign_keys(&foreign_keys, &current_foreign_keys)
            .iter()
            .any(|diff| diff.diff_type != "unchanged")
        || serde_json::to_value(&triggers).map_err(|error| error.to_string())?
            != serde_json::to_value(&current_triggers).map_err(|error| error.to_string())?
    {
        return Err("Table columns, indexes or constraints changed since comparison; compare again".into());
    }
    Ok(())
}

fn is_non_secondary_index(secondary: Option<&serde_json::Value>, index_type: &str, oceanbase: bool) -> bool {
    secondary.and_then(serde_json::Value::as_str) == Some("N")
        || (oceanbase && index_type == "NORMAL" && secondary == Some(&serde_json::Value::Null))
}

async fn selected_index_identity(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    table: &str,
    owner: &str,
    name: &str,
) -> Result<(), String> {
    let sql = format!(
        "SELECT OWNER, INDEX_NAME, TABLE_OWNER, TABLE_NAME, INDEX_TYPE, SECONDARY FROM ALL_INDEXES WHERE TABLE_OWNER = {} AND TABLE_NAME = {} AND OWNER = {} AND INDEX_NAME = {}",
        sql_string(&endpoint.schema), sql_string(table), sql_string(owner), sql_string(name)
    );
    let result = index_metadata_query(state, &endpoint.connection_id, &endpoint.database, &sql).await?;
    if result.rows.len() != 1 {
        return Err(format!("{owner}.{name}: selected index is missing or ambiguous; compare again"));
    }
    let text = |position: usize| result.rows[0].get(position).and_then(serde_json::Value::as_str);
    if text(0) != Some(owner)
        || text(1) != Some(name)
        || text(2) != Some(endpoint.schema.as_str())
        || text(3) != Some(table)
    {
        return Err(format!("{owner}.{name}: selected index identity changed; compare again"));
    }
    let oceanbase = oracle_endpoint_type(state, endpoint).await? == DatabaseType::OceanbaseOracle;
    if !is_non_secondary_index(result.rows[0].get(5), text(4).unwrap_or_default(), oceanbase)
        || matches!(text(4), None | Some("LOB" | "IOT - TOP"))
    {
        return Err(format!("{owner}.{name}: index is not an independently managed user index"));
    }
    Ok(())
}

async fn selected_index_definition(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    table: &str,
    index: &db::IndexInfo,
    source: Option<&str>,
) -> Result<dbx_sql::object_source_sql::OracleIndexDdlSource, String> {
    oracle_endpoint_type(state, endpoint).await?;
    let owner = index.owner.as_deref().unwrap_or(&endpoint.schema);
    selected_index_identity(state, endpoint, table, owner, &index.name).await?;
    let current =
        list_indexes_core(state, &endpoint.connection_id, &endpoint.database, &endpoint.schema, table).await?;
    let mut selected = current
        .iter()
        .filter(|current| current.name == index.name && current.owner.as_deref().unwrap_or(&endpoint.schema) == owner);
    let current =
        selected.next().ok_or_else(|| format!("{owner}.{}: selected index is missing; compare again", index.name))?;
    let mut expected = index.clone();
    expected.owner = Some(owner.to_string());
    let mut actual = current.clone();
    actual.owner = Some(owner.to_string());
    if selected.next().is_some()
        || serde_json::to_value(&expected).map_err(|error| error.to_string())?
            != serde_json::to_value(&actual).map_err(|error| error.to_string())?
    {
        return Err(format!("{owner}.{}: index definition changed since comparison; compare again", index.name));
    }
    let existing = oracle_index_ddl_sources(source.unwrap_or_default(), &endpoint.schema)?;
    let ddl = if let Some(existing) =
        existing.iter().find(|existing| existing.owner == owner && existing.name == index.name)
    {
        existing.ddl.clone()
    } else {
        index_definition(state, &endpoint.connection_id, &endpoint.database, owner, &index.name).await?
    };
    let mut parsed = oracle_index_ddl_sources(&ddl, &endpoint.schema)?;
    if parsed.len() != 1
        || parsed[0].owner != owner
        || parsed[0].name != index.name
        || parsed[0].table_owner != endpoint.schema
        || parsed[0].table != table
    {
        return Err(format!("{owner}.{}: complete index source has a different identity; compare again", index.name));
    }
    Ok(parsed.remove(0))
}

async fn protected_target_indexes(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    table: &str,
    snapshot: Option<&str>,
) -> Result<std::collections::BTreeSet<(String, String)>, String> {
    oracle_endpoint_type(state, endpoint).await?;
    let original = snapshot.map(parse_oracle_table_ddl).transpose()?;
    if original.as_ref().is_some_and(|original| {
        original.table != table || original.owner.as_deref().is_some_and(|owner| owner != endpoint.schema)
    }) {
        return Err("Target constraint snapshot has a different table identity; compare again".into());
    }
    let sql = format!(
        "SELECT OWNER, CONSTRAINT_NAME, STATUS, INDEX_OWNER, INDEX_NAME, TABLE_NAME, CONSTRAINT_TYPE FROM ALL_CONSTRAINTS WHERE OWNER = {} AND TABLE_NAME = {} AND CONSTRAINT_TYPE IN ('P', 'U')",
        sql_string(&endpoint.schema), sql_string(table)
    );
    let rows = index_metadata_query(state, &endpoint.connection_id, &endpoint.database, &sql).await?;
    let mut indexes = std::collections::BTreeSet::new();
    let mut constraints = std::collections::BTreeSet::new();
    for row in &rows.rows {
        let text = |position: usize| row.get(position).and_then(serde_json::Value::as_str);
        if text(0) != Some(endpoint.schema.as_str())
            || text(5) != Some(table)
            || !matches!(text(2), Some("ENABLED" | "DISABLED"))
            || !matches!(text(6), Some("P" | "U"))
            || text(1).is_none_or(str::is_empty)
            || !constraints.insert(text(1).unwrap().to_string())
        {
            return Err("Complete target supporting-constraint identities are unavailable; compare again".into());
        }
        if let Some(original) = original.as_ref() {
            let constraint = original
                .supporting_constraints
                .iter()
                .find(|constraint| constraint.name.as_deref() == text(1))
                .ok_or("Target constraint dictionary disagrees with the comparison snapshot; compare again")?;
            if text(6) != Some(constraint.constraint_type.as_str())
                || constraint.disabled != (text(2) == Some("DISABLED"))
            {
                return Err("Target constraint state changed since comparison; compare again".into());
            }
        }
        match (text(3), text(4)) {
            (Some(owner), Some(name)) if !owner.is_empty() && !name.is_empty() => {
                indexes.insert((owner.into(), name.into()));
            }
            _ if text(2) == Some("DISABLED") => {}
            _ => return Err("Target supporting-index binding is unavailable".into()),
        }
    }
    if original.as_ref().is_some_and(|original| original.supporting_constraints.len() != constraints.len()) {
        return Err("Target snapshot has supporting constraints missing from dictionary metadata; compare again".into());
    }
    Ok(indexes)
}

async fn target_index_available(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    name: &str,
    drop_tables: &[&str],
    drop_indexes: &std::collections::BTreeSet<(String, String)>,
) -> Result<(), String> {
    oracle_endpoint_type(state, endpoint).await?;
    let sql = format!(
        "SELECT OWNER, INDEX_NAME, TABLE_OWNER, TABLE_NAME FROM ALL_INDEXES WHERE OWNER = {} AND INDEX_NAME = {}",
        sql_string(&endpoint.schema),
        sql_string(name)
    );
    let result = index_metadata_query(state, &endpoint.connection_id, &endpoint.database, &sql).await?;
    if result.rows.is_empty() {
        return Ok(());
    }
    if result.rows.len() != 1 {
        return Err(format!("{name}: target index identity is ambiguous"));
    }
    let text = |position: usize| result.rows[0].get(position).and_then(serde_json::Value::as_str);
    if text(0) != Some(endpoint.schema.as_str()) || text(1) != Some(name) || text(2) != Some(endpoint.schema.as_str()) {
        return Err(format!("{name}: target index owner or table identity is unavailable"));
    }
    if text(3).is_some_and(|table| drop_tables.contains(&table) || drop_indexes.contains(&(table.into(), name.into())))
    {
        Ok(())
    } else {
        Err(format!("{name}: a retained target index already uses this identity"))
    }
}

async fn target_trigger_available(
    state: &AppState,
    endpoint: &OracleSchemaSyncEndpoint,
    name: &str,
    drop_tables: &[&str],
) -> Result<(), String> {
    oracle_endpoint_type(state, endpoint).await?;
    let sql = format!(
        "SELECT OWNER, TRIGGER_NAME, TABLE_OWNER, TABLE_NAME FROM ALL_TRIGGERS WHERE OWNER = {} AND TRIGGER_NAME = {}",
        sql_string(&endpoint.schema),
        sql_string(name)
    );
    let result = index_metadata_query(state, &endpoint.connection_id, &endpoint.database, &sql).await?;
    if result.rows.is_empty() {
        return Ok(());
    }
    if result.rows.len() != 1 {
        return Err(format!("{name}: target trigger identity is ambiguous"));
    }
    let text = |position: usize| result.rows[0].get(position).and_then(serde_json::Value::as_str);
    if text(0) != Some(endpoint.schema.as_str()) || text(1) != Some(name) || text(2) != Some(endpoint.schema.as_str()) {
        return Err(format!("{name}: target trigger owner or table identity is unavailable"));
    }
    if text(3).is_some_and(|table| drop_tables.contains(&table)) {
        Ok(())
    } else {
        Err(format!("{name}: a retained target trigger already uses this identity"))
    }
}

pub async fn prepare_schema_sync_oracle_ddl_core(
    state: &AppState,
    diffs: &[TableDiff],
    enable_rollback: bool,
    options: &OracleSchemaSyncDdlOptions,
) -> OracleSchemaSyncDdlSources {
    let mut sources =
        OracleSchemaSyncDdlSources { table_mappings: options.table_mappings.clone(), ..Default::default() };
    if !options.separate_indexes {
        return sources;
    }
    let drop_tables = diffs
        .iter()
        .filter(|diff| diff.diff_type == "removed" && diff.object_type.as_deref() != Some("view"))
        .map(|diff| diff.target_name.as_deref().unwrap_or(&diff.name))
        .collect::<Vec<_>>();
    let drop_indexes = diffs
        .iter()
        .filter(|diff| diff.diff_type == "modified")
        .flat_map(|diff| {
            diff.indexes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|index| matches!(index.diff_type.as_str(), "removed" | "modified"))
                .map(move |index| (diff.target_name.clone().unwrap_or_else(|| diff.name.clone()), index.name.clone()))
        })
        .collect::<std::collections::BTreeSet<_>>();
    for diff in diffs {
        if diff.object_type.as_deref() == Some("view") {
            continue;
        }
        let target_table = diff.target_name.as_deref().unwrap_or(&diff.name);
        if diff.diff_type == "added" {
            let target_type = if let Some(target) = options.target.as_ref() {
                oracle_endpoint_type(state, target).await
            } else {
                Err("Independent indexes require the fixed target endpoint".into())
            };
            let separate_supporting_indexes = target_type.as_ref().is_ok_and(|kind| *kind == DatabaseType::Oracle);
            let mut captured =
                capture_comparison_table(state, options.source.as_ref(), diff, false, separate_supporting_indexes)
                    .await;
            if let Err(reason) = target_type {
                generation_issue(&mut captured, "table", &diff.name, reason);
            }
            if let Some(target) = options.target.as_ref() {
                let trigger_sources = captured
                    .table_ddl
                    .as_deref()
                    .map(|ddl| {
                        dbx_sql::object_source_sql::extract_oracle_table_triggers(ddl, &captured.owner, &captured.table)
                    })
                    .transpose();
                match trigger_sources {
                    Ok(triggers) => {
                        let names =
                            triggers
                                .into_iter()
                                .flat_map(|(_, triggers)| triggers.into_iter().map(|trigger| trigger.name))
                                .chain(
                                    diff.triggers.as_deref().unwrap_or_default().iter().filter_map(|trigger| {
                                        trigger.source.as_ref().map(|trigger| trigger.name.clone())
                                    }),
                                )
                                .collect::<std::collections::BTreeSet<_>>();
                        for name in names {
                            if let Err(reason) = target_trigger_available(state, target, &name, &drop_tables).await {
                                generation_issue(&mut captured, "trigger", &name, reason);
                            }
                        }
                    }
                    Err(reason) => generation_issue(&mut captured, "trigger", &diff.name, reason),
                }
                let definitions = captured
                    .table_ddl
                    .as_deref()
                    .map(|ddl| {
                        dbx_sql::object_source_sql::oracle_table_created_index_identities(
                            ddl,
                            &captured.owner,
                            &captured.retained_supporting_indexes,
                        )
                    })
                    .transpose();
                match definitions {
                    Ok(definitions) => {
                        let names = definitions
                            .unwrap_or_default()
                            .into_iter()
                            .map(|(_, name)| name)
                            .chain(captured.supporting_indexes.iter().map(|index| index.name.clone()))
                            .collect::<std::collections::BTreeSet<_>>();
                        for name in names {
                            if let Err(reason) =
                                target_index_available(state, target, &name, &drop_tables, &drop_indexes).await
                            {
                                generation_issue(&mut captured, "index", &name, reason);
                            }
                        }
                    }
                    Err(reason) => generation_issue(&mut captured, "table", &diff.name, reason),
                }
            }
            sources.forward.push(captured);
        } else if diff.diff_type == "removed" && enable_rollback {
            let separate_supporting_indexes = if let Some(target) = options.target.as_ref() {
                oracle_endpoint_type(state, target).await.is_ok_and(|kind| kind == DatabaseType::Oracle)
            } else {
                false
            };
            sources.rollback.push(
                capture_comparison_table(state, options.target.as_ref(), diff, true, separate_supporting_indexes).await,
            );
        } else if diff.diff_type == "modified" {
            let indexes = diff.indexes.as_deref().unwrap_or_default();
            if !indexes.iter().any(|index| matches!(index.diff_type.as_str(), "added" | "removed" | "modified")) {
                continue;
            }
            let empty = |endpoint: Option<&OracleSchemaSyncEndpoint>, table: &str| OracleSchemaSyncTableDdl {
                diff_name: diff.name.clone(),
                owner: endpoint.map_or("", |endpoint| endpoint.schema.as_str()).into(),
                table: table.into(),
                table_ddl: None,
                indexes: Vec::new(),
                supporting_indexes: Vec::new(),
                retained_supporting_indexes: Vec::new(),
                protected_drop_indexes: Vec::new(),
                issues: Vec::new(),
            };
            let mut forward = empty(options.source.as_ref(), &diff.name);
            let mut rollback = empty(options.target.as_ref(), target_table);
            let forward_drops = indexes.iter().any(|index| matches!(index.diff_type.as_str(), "removed" | "modified"));
            let rollback_drops =
                enable_rollback && indexes.iter().any(|index| matches!(index.diff_type.as_str(), "added" | "modified"));
            let protection = if forward_drops || rollback_drops {
                if let Some(target) = options.target.as_ref() {
                    protected_target_indexes(state, target, target_table, diff.target_ddl.as_deref()).await
                } else {
                    Err("Index dependency checks require the fixed target endpoint".into())
                }
            } else {
                Ok(Default::default())
            };
            match protection {
                Ok(protected) => {
                    for index in indexes {
                        let owner = index
                            .target
                            .as_ref()
                            .and_then(|index| index.owner.as_deref())
                            .or_else(|| options.target.as_ref().map(|target| target.schema.as_str()))
                            .unwrap_or("");
                        if protected.contains(&(owner.into(), index.name.clone())) {
                            if matches!(index.diff_type.as_str(), "removed" | "modified") {
                                forward.protected_drop_indexes.push(index.name.clone());
                            }
                            if matches!(index.diff_type.as_str(), "added" | "modified") {
                                rollback.protected_drop_indexes.push(index.name.clone());
                            }
                        }
                    }
                }
                Err(reason) => {
                    if forward_drops {
                        generation_issue(&mut forward, "table", target_table, reason.clone());
                    }
                    if rollback_drops {
                        generation_issue(&mut rollback, "table", target_table, reason);
                    }
                }
            }
            for index in indexes {
                if matches!(index.diff_type.as_str(), "added" | "modified") {
                    let definition = async {
                        let source =
                            options.source.as_ref().ok_or("Index creation requires the fixed source endpoint")?;
                        let info = index.source.as_ref().ok_or("Selected source index metadata is unavailable")?;
                        let definition =
                            selected_index_definition(state, source, &diff.name, info, diff.ddl.as_deref()).await?;
                        let target =
                            options.target.as_ref().ok_or("Index creation requires the fixed target endpoint")?;
                        target_index_available(state, target, &definition.name, &drop_tables, &drop_indexes).await?;
                        Ok::<_, String>(definition)
                    }
                    .await;
                    match definition {
                        Ok(definition) => forward.indexes.push(definition),
                        Err(reason) => generation_issue(&mut forward, "index", &index.name, reason),
                    }
                }
                if matches!(index.diff_type.as_str(), "removed" | "modified") {
                    let identity = async {
                        let target =
                            options.target.as_ref().ok_or("Index removal requires the fixed target endpoint")?;
                        oracle_endpoint_type(state, target).await?;
                        let owner =
                            index.target.as_ref().and_then(|index| index.owner.as_deref()).unwrap_or(&target.schema);
                        selected_index_identity(state, target, target_table, owner, &index.name).await
                    }
                    .await;
                    if let Err(reason) = identity {
                        generation_issue(&mut forward, "index", &index.name, reason);
                    }
                    if enable_rollback {
                        let definition = async {
                            let target =
                                options.target.as_ref().ok_or("Index rollback requires the fixed target endpoint")?;
                            let info = index.target.as_ref().ok_or("Selected target index metadata is unavailable")?;
                            selected_index_definition(state, target, target_table, info, diff.target_ddl.as_deref())
                                .await
                        }
                        .await;
                        match definition {
                            Ok(definition) => rollback.indexes.push(definition),
                            Err(reason) => generation_issue(&mut rollback, "index", &index.name, reason),
                        }
                    }
                }
            }
            sources.forward.push(forward);
            if enable_rollback {
                sources.rollback.push(rollback);
            }
        }
    }
    sources
}

pub(super) async fn index_metadata_query(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
) -> Result<db::QueryResult, String> {
    let config = connection_config(state, connection_id).await.ok_or("connection not found")?;
    let timeout = agent_metadata_timeout(Some(&config));
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let response: oracle_type_management::QueryResponse = match clone_metadata_pool(state, &pool_key)
        .await
        .ok_or("Pool not found")?
    {
        PoolKind::Agent(client) => {
            client
                .lock()
                .await
                .execute_query_with_timeout(
                    agent_execute_query_params(
                        sql,
                        Some(database),
                        None,
                        QueryExecutionOptions { max_rows: Some(10000), ..Default::default() },
                    ),
                    timeout,
                )
                .await
        }
        PoolKind::ExternalDriver { config, session, .. } => session
            .invoke_with_timeout(
                "executeQuery",
                serde_json::json!({ "connection": config.as_ref(), "database": database, "sql": sql, "maxRows": 10000, "deferLobs": false }),
                timeout,
            )
            .await,
        _ => Err("Independent Oracle indexes require an Agent or JDBC metadata transport".into()),
    }?;
    let result = response.into_result()?;
    if result.truncated || result.has_more || !result.deferred_large_value_cells.is_empty() {
        return Err("Complete Oracle index metadata is unavailable: the query result was truncated or deferred".into());
    }
    Ok(result)
}

async fn index_definition(
    state: &AppState,
    connection_id: &str,
    database: &str,
    owner: &str,
    name: &str,
) -> Result<String, String> {
    let sql = format!("SELECT DBMS_METADATA.GET_DDL('INDEX', {}, {}) FROM DUAL", sql_string(name), sql_string(owner));
    let result = index_metadata_query(state, connection_id, database, &sql).await?;
    if result.rows.len() != 1 {
        return Err(format!("{owner}.{name}: complete index DDL is unavailable"));
    }
    result.rows[0]
        .first()
        .and_then(serde_json::Value::as_str)
        .filter(|ddl| !ddl.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("{owner}.{name}: complete index DDL is unavailable"))
}

pub async fn separate_table_ddl_indexes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    source: &str,
) -> Result<String, String> {
    let config = connection_config(state, connection_id).await.ok_or("connection not found")?;
    let separate_supporting_indexes = config.db_type != DatabaseType::OceanbaseOracle
        && crate::models::connection::jdbc_dialect_hint(&config)
            != Some(crate::models::connection::JdbcDialectHint::OceanbaseOracle);
    let captured = capture_table_ddl_indexes(
        state,
        connection_id,
        database,
        schema,
        table,
        source,
        false,
        separate_supporting_indexes,
    )
    .await?;
    separate_oracle_supporting_indexes_with_retained(
        &captured.source,
        &captured.owner,
        table,
        &captured.supporting_indexes,
        &captured.retained_supporting_indexes,
    )
}

struct CapturedOracleTableDdl {
    owner: String,
    source: String,
    supporting_indexes: Vec<OracleSupportingIndexDdl>,
    retained_supporting_indexes: Vec<OracleSupportingIndexIdentity>,
}

async fn capture_table_ddl_indexes(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    source: &str,
    explicit_schema: bool,
    separate_supporting_indexes: bool,
) -> Result<CapturedOracleTableDdl, String> {
    let config = connection_config(state, connection_id).await.ok_or("connection not found")?;
    let oracle = config.db_type == DatabaseType::Oracle || is_oracle_external_driver_config(&config);
    let ob = config.db_type == DatabaseType::OceanbaseOracle
        || crate::models::connection::jdbc_dialect_hint(&config)
            == Some(crate::models::connection::JdbcDialectHint::OceanbaseOracle);
    if !oracle && !ob {
        return Err("Independent table indexes require Oracle or OceanBase Oracle".into());
    }
    let source_metadata = parse_oracle_table_ddl(source)?;
    if source_metadata.table != table {
        return Err("Table DDL does not match the selected table name".into());
    }
    let owner = match source_metadata.owner.as_deref() {
        Some(owner) if owner == schema || schema.is_empty() || schema == database => owner,
        Some(_) => return Err("Table DDL does not match the selected table owner".into()),
        None if !schema.is_empty() && (explicit_schema || schema != database) => schema,
        None => return Err("Unqualified table DDL requires an explicit Oracle schema, not a service name".into()),
    };
    let sql = format!(
        "SELECT OWNER, CONSTRAINT_NAME, STATUS, INDEX_OWNER, INDEX_NAME, TABLE_NAME, CONSTRAINT_TYPE FROM ALL_CONSTRAINTS WHERE OWNER = {} AND TABLE_NAME = {} AND CONSTRAINT_TYPE IN ('P', 'U')",
        sql_string(owner), sql_string(table)
    );
    let constraints = index_metadata_query(state, connection_id, database, &sql).await?;
    let mut indexes = Vec::new();
    let mut retained_indexes = Vec::new();
    let standalone = oracle_index_ddl_sources(source, owner)?;
    if standalone.iter().any(|index| index.table_owner != owner || index.table != table) {
        return Err("Standalone index source belongs to a different table".into());
    }
    let mut retained_iot_indexes = std::collections::BTreeSet::new();
    let mut definitions: std::collections::BTreeMap<(String, String), String> = std::collections::BTreeMap::new();
    let mut matched_constraints = std::collections::BTreeSet::new();
    for row in &constraints.rows {
        let text =
            |position: usize| row.get(position).and_then(serde_json::Value::as_str).filter(|value| !value.is_empty());
        let row_owner = text(0).ok_or("Supporting-constraint owner is unavailable")?;
        let constraint_name = text(1).ok_or("Supporting-constraint name is unavailable")?;
        let status = text(2).ok_or_else(|| format!("{constraint_name}: constraint status is unavailable"))?;
        if row_owner != owner {
            return Err(format!("{constraint_name}: constraint metadata belongs to a different table owner"));
        }
        if text(5) != Some(table) {
            return Err(format!("{constraint_name}: constraint metadata belongs to a different table"));
        }
        let original = source_metadata
            .supporting_constraints
            .iter()
            .find(|constraint| constraint.name.as_deref() == Some(constraint_name))
            .ok_or_else(|| {
                format!(
                    "{constraint_name}: complete matching constraint source is unavailable; compare or refresh again"
                )
            })?;
        if text(6) != Some(original.constraint_type.as_str())
            || !matches!(status, "ENABLED" | "DISABLED")
            || original.disabled != (status == "DISABLED")
        {
            return Err(format!(
                "{constraint_name}: constraint source and dictionary disagree; compare or refresh again"
            ));
        }
        if !matched_constraints.insert(constraint_name.to_string()) {
            return Err(format!("{constraint_name}: duplicate supporting-constraint metadata"));
        }
        if source_metadata.index_organized && original.constraint_type == "P" {
            let index_owner = text(3).ok_or("IOT primary index owner is unavailable")?;
            let index_name = text(4).ok_or("IOT primary index name is unavailable")?;
            retained_iot_indexes.insert((index_owner.to_string(), index_name.to_string()));
            continue;
        }
        let (index_owner, index_name) = match (text(3), text(4)) {
            (Some(owner), Some(name)) => (owner, name),
            _ if status == "DISABLED" => continue,
            _ => return Err(format!("{constraint_name}: supporting-index identity is unavailable")),
        };
        if !separate_supporting_indexes {
            retained_indexes.push(OracleSupportingIndexIdentity {
                constraint_name: constraint_name.into(),
                owner: index_owner.into(),
                name: index_name.into(),
            });
            continue;
        }
        let key = (index_owner.to_string(), index_name.to_string());
        let ddl = if let Some(ddl) = definitions.get(&key) {
            ddl.clone()
        } else {
            let ddl = index_definition(state, connection_id, database, index_owner, index_name).await?;
            definitions.insert(key, ddl.clone());
            ddl
        };
        indexes.push(OracleSupportingIndexDdl {
            constraint_name: constraint_name.to_string(),
            owner: index_owner.to_string(),
            name: index_name.to_string(),
            ddl,
        });
    }
    if matched_constraints.len() != source_metadata.supporting_constraints.len() {
        return Err("Table DDL has primary or unique constraints without matching dictionary metadata; compare or refresh again".into());
    }
    let inventory_sql = format!(
        "SELECT OWNER, INDEX_NAME, TABLE_OWNER, TABLE_NAME, INDEX_TYPE, SECONDARY, UNIQUENESS FROM ALL_INDEXES WHERE TABLE_OWNER = {} AND TABLE_NAME = {}",
        sql_string(owner), sql_string(table)
    );
    let inventory = index_metadata_query(state, connection_id, database, &inventory_sql).await?;
    let mut seen = std::collections::BTreeSet::new();
    let mut complete_source = source.to_string();
    for row in &inventory.rows {
        let text =
            |position: usize| row.get(position).and_then(serde_json::Value::as_str).filter(|value| !value.is_empty());
        let index_owner = text(0).ok_or("Index inventory owner is unavailable")?;
        let index_name = text(1).ok_or("Index inventory name is unavailable")?;
        if text(2) != Some(owner) || text(3) != Some(table) {
            return Err(format!("{index_owner}.{index_name}: index inventory belongs to a different table"));
        }
        let index_type = text(4).ok_or("Index inventory type is unavailable")?;
        let key = (index_owner.to_string(), index_name.to_string());
        if !seen.insert(key.clone()) {
            return Err(format!("{index_owner}.{index_name}: duplicate index inventory"));
        }
        if index_type == "LOB" {
            if indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
                || retained_indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
                || standalone.iter().any(|index| index.owner == index_owner && index.name == index_name)
            {
                return Err(format!("{index_owner}.{index_name}: internal LOB index conflicts with user index source"));
            }
            continue;
        }
        if index_type == "IOT - TOP" {
            if standalone.iter().any(|index| index.owner == index_owner && index.name == index_name) {
                return Err(format!("{index_owner}.{index_name}: IOT primary index cannot be created independently"));
            }
            if !source_metadata.index_organized || !retained_iot_indexes.remove(&key) {
                return Err(format!("{index_owner}.{index_name}: IOT primary index does not match its constraint"));
            }
            continue;
        }
        if retained_iot_indexes.contains(&key) {
            return Err("IOT primary index has an inconsistent dictionary type".into());
        }
        match text(5) {
            Some("Y") => {
                if indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
                    || retained_indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
                    || standalone.iter().any(|index| index.owner == index_owner && index.name == index_name)
                {
                    return Err(format!("{index_owner}.{index_name}: automatically created domain-index object conflicts with standalone source"));
                }
                continue;
            }
            _ if is_non_secondary_index(row.get(5), index_type, ob) => {}
            _ => return Err(format!("{index_owner}.{index_name}: complete index classification is unavailable")),
        }
        if retained_indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
            && text(6) != Some("UNIQUE")
        {
            return Err(format!(
                "{index_owner}.{index_name}: inline restoration of the original index uniqueness is not verified"
            ));
        }
        if indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
            || retained_indexes.iter().any(|index| index.owner == index_owner && index.name == index_name)
            || standalone.iter().any(|index| index.owner == index_owner && index.name == index_name)
        {
            continue;
        }
        let ddl = index_definition(state, connection_id, database, index_owner, index_name).await?;
        let extracted = oracle_index_ddl_sources(&ddl, index_owner)?;
        if extracted.len() != 1
            || extracted[0].owner != index_owner
            || extracted[0].name != index_name
            || extracted[0].table_owner != owner
            || extracted[0].table != table
        {
            return Err(format!("{index_owner}.{index_name}: complete index definition does not match the inventory"));
        }
        if !complete_source.trim_end().ends_with(';') {
            complete_source.push_str("\n;");
        }
        complete_source.push('\n');
        complete_source.push_str(ddl.trim_end().trim_end_matches(';'));
        complete_source.push(';');
    }
    if !retained_iot_indexes.is_empty()
        || indexes.iter().any(|index| !seen.contains(&(index.owner.clone(), index.name.clone())))
        || retained_indexes.iter().any(|index| !seen.contains(&(index.owner.clone(), index.name.clone())))
        || standalone.iter().any(|index| !seen.contains(&(index.owner.clone(), index.name.clone())))
    {
        return Err("Table index source and dictionary inventory disagree; compare or refresh again".into());
    }
    Ok(CapturedOracleTableDdl {
        owner: owner.to_string(),
        source: complete_source,
        supporting_indexes: indexes,
        retained_supporting_indexes: retained_indexes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
    use serde_json::{json, Value};

    const OWNER: &str = " O'w ";
    const SOURCE: &str =
        "CREATE TABLE \" O'w \".\"T\" (\"ID\" NUMBER, CONSTRAINT \" C'k \" PRIMARY KEY (\"ID\") USING INDEX ENABLE);";
    const POST_SOURCE: &str = "CREATE TABLE \" O'w \".\"T\" (\"ID\" NUMBER)\nCREATE INDEX \" O'w \".\" I'x \" ON \" O'w \".\"T\" (\"ID\" DESC) INVISIBLE\nALTER TABLE \" O'w \".\"T\" ADD CONSTRAINT \" C'k \" PRIMARY KEY (\"ID\") USING INDEX \" O'w \".\" I'x \" ENABLE;";

    async fn fixture(mode: &str) -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("agent.py");
        std::fs::write(&script, r#"import json, pathlib, sys
mode, log = sys.argv[1], pathlib.Path(sys.argv[2])
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with log.open('a', encoding='utf-8') as output:
        output.write(json.dumps(request) + '\n')
    method, params = request['method'], request.get('params', {})
    body = {'result': {}}
    if method == 'handshake':
        body = {'result': {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['metadata']}}
    elif method in ('get_columns', 'list_indexes', 'list_foreign_keys', 'list_triggers'):
        rows = []
        if method == 'list_triggers' and mode.startswith('trigger-enrich'):
            rows = [{'name':'TR', 'event':'INSERT', 'timing':'BEFORE EACH ROW'}]
            if mode in ('trigger-enrich-conflict', 'trigger-enrich-wrong-table'): rows[0]['enabled'] = True
            if mode == 'trigger-enrich-complete':
                rows[0].update({'enabled':False, 'statement':'CREATE TRIGGER " O\'w ".TR BEFORE INSERT ON " O\'w ".T FOR EACH ROW BEGIN :NEW.ID := 42; END;'})
        if method == 'list_indexes' and mode in ('index-snapshot', 'index-snapshot-changed'):
            rows = [{'name':" I'x ", 'columns':['CHANGED' if mode == 'index-snapshot-changed' else 'ID'], 'is_unique':False, 'is_primary':False}]
        if method == 'get_columns' and mode == 'snapshot-changed':
            rows = [{'name':'CHANGED', 'data_type':'NUMBER', 'is_nullable':True, 'is_primary_key':False}]
        body = {'result': rows}
    elif method == 'execute_query':
        sql = params.get('sql', '')
        if mode in ('snapshot', 'snapshot-changed'):
            result = {'columns': [], 'rows': [], 'affected_rows': 0, 'execution_time_ms': 0}
        elif 'ALL_TRIGGERS' in sql:
            rows = [] if mode == 'trigger-empty' else [[" O'w ", " T'r ", " O'w ", 'T' if mode == 'trigger-dropped' else 'RETAINED']]
            if mode.startswith('trigger-enrich'): rows = [[" O'w ", 'TR', " O'w ", 'T', 'DISABLED']]
            if mode == 'trigger-enrich-wrong-table': rows[0][4] = 'ENABLED'
            result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}
        elif 'ALL_CONSTRAINTS' in sql:
            rows = [[" O'w ", " C'k ", 'ENABLED', " O'w ", " I'x ", 'T', 'P']]
            if mode == 'disabled': rows = [[" O'w ", " C'k ", 'DISABLED', None, None, 'T', 'P']]
            if mode in ('empty', 'ordinary', 'secondary'): rows = []
            if mode == 'missing-index': rows[0][4] = None
            if mode == 'wrong-owner': rows[0][0] = 'OTHER'
            if mode == 'wrong-table': rows[0][5] = 'OTHER'
            if mode == 'wrong-state': rows[0][2] = 'DISABLED'
            result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}
            if mode == 'dictionary-deferred': result['largeValueCells'] = [{'row': 0, 'column': 0}]
        elif 'ALL_INDEXES' in sql:
            rows = [[" O'w ", " I'x ", " O'w ", 'T', 'IOT - TOP' if mode == 'iot' else 'NORMAL', 'Y' if mode == 'secondary' else 'N', 'NONUNIQUE' if mode in ('retained-nonunique', 'native-post') else 'UNIQUE']]
            if mode == 'secondary-null': rows[0][5] = None
            if mode == 'ob-ordinary':
                rows[0][5] = None
                rows.append([" O'w ", 'ORD', " O'w ", 'T', 'NORMAL', None, 'NONUNIQUE'])
            if mode in ('empty', 'disabled'): rows = []
            if mode == 'inventory-wrong-table': rows[0][3] = 'OTHER'
            result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}
            if mode == 'inventory-deferred': result['largeValueCells'] = [{'row': 0, 'column': 0}]
        else:
            ddl = 'CREATE /*' + ('完整定义 ' * 4000) + '*/ INDEX " O\'w "." I\'x " ON " O\'w "."T" ("ID" DESC) INVISIBLE;'
            if mode == 'ob-ordinary' and "'ORD'" in sql: ddl = 'CREATE INDEX " O\'w "."ORD" ON " O\'w "."T" ("ID");'
            result = {'columns': [], 'rows': [[ddl]], 'affected_rows': 0, 'execution_time_ms': 0}
            if mode == 'ddl-deferred': result['largeValueCells'] = [{'row': 0, 'column': 0}]
            if mode == 'ddl-deferred-snake': result['large_value_cells'] = [{'row_index': 0, 'column_index': 0, 'original_bytes': 67108864, 'value_ref': 'fixture-lob'}]
            if mode == 'ddl-more': result['hasMore'] = True
            if mode == 'ddl-truncated': result['truncated'] = True
            if mode == 'ddl-error': result['executionError'] = True
            if mode == 'ddl-empty': result['rows'] = [['']]
        body = {'result': result}
    elif method == 'get_object_source' and mode.startswith('trigger-enrich'):
        body = {'result': {'name':'TR', 'schema':" O'w ", 'object_type':'TRIGGER', 'source':'CREATE TRIGGER " O\'w ".TR BEFORE INSERT ON " O\'w ".T FOR EACH ROW BEGIN :NEW.ID := 42; END;'}}
        if mode == 'trigger-enrich-wrong-table': body['result']['source'] = body['result']['source'].replace('.T FOR', '.OTHER_TABLE FOR')
        if mode == 'trigger-enrich-incomplete': body['result']['source'] = body['result']['source'].replace(' END;', '')
    if mode == 'trigger-enrich-permission' and method == 'execute_query':
        body = {'error':{'code':-32000, 'message':'fixture permission denied'}}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], **body}), flush=True)
"#).unwrap();
        let python = if cfg!(windows) { "python" } else { "python3" };
        let mut client = AgentDriverClient::spawn(AgentLaunchSpec::new(python).with_args([
            script.to_string_lossy().to_string(),
            mode.into(),
            directory.path().join("calls").to_string_lossy().to_string(),
        ]))
        .await
        .unwrap();
        client.try_optional_handshake("index-test").await;
        let mut state =
            AppState::new(crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap());
        state.agent_manager = crate::agent_manager::AgentManager::new_with_base_dir(directory.path().join("drivers"));
        for driver in ["oracle", "oceanbase-oracle"] {
            let launch_path = state.agent_manager.driver_launch_config_path(driver);
            std::fs::create_dir_all(launch_path.parent().unwrap()).unwrap();
            std::fs::write(
                launch_path,
                json!({
                    "command": python,
                    "args": [script.to_string_lossy(), mode, directory.path().join("calls").to_string_lossy().as_ref()]
                })
                .to_string(),
            )
            .unwrap();
        }
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id":"conn", "name":"Index metadata fixture", "db_type":"oracle", "host":"127.0.0.1", "port":1521,
            "database":"demo", "username":"fixture", "password":"", "keepalive_interval_secs":0, "idle_timeout_secs":0
        }))
        .unwrap();
        state.configs.write().await.insert("conn".into(), config);
        state.update_connection_pools(|pools| pools.insert("conn:role:metadata".into(), PoolKind::agent(client))).await;
        (directory, state)
    }

    #[test]
    fn oceanbase_normal_indexes_accept_only_explicit_null_secondary_metadata() {
        for oceanbase in [false, true] {
            assert!(is_non_secondary_index(Some(&json!("N")), "NORMAL", oceanbase));
            for secondary in [None, Some(json!("")), Some(json!(false)), Some(json!("Y"))] {
                assert!(!is_non_secondary_index(secondary.as_ref(), "NORMAL", oceanbase));
            }
            assert_eq!(is_non_secondary_index(Some(&Value::Null), "NORMAL", oceanbase), oceanbase);
            for index_type in ["", "LOB", "IOT - TOP", "DOMAIN", "FUNCTION-BASED NORMAL"] {
                assert!(!is_non_secondary_index(Some(&Value::Null), index_type, oceanbase));
            }
        }
    }

    #[tokio::test]
    async fn native_post_table_primary_key_reaches_view_and_removed_rollback_entry_points() {
        let (_directory, state) = fixture("native-post").await;
        let output = separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", POST_SOURCE).await.unwrap();
        assert_eq!(output.matches("CREATE INDEX").count(), 1);
        assert_eq!(output.matches("PRIMARY KEY").count(), 1);
        assert!(!output.contains("CREATE UNIQUE INDEX"));
        let endpoint =
            OracleSchemaSyncEndpoint { connection_id: "conn".into(), database: "demo".into(), schema: OWNER.into() };
        let diffs: Vec<TableDiff> =
            serde_json::from_value(json!([{"type":"removed", "name":"T", "targetDdl":POST_SOURCE}])).unwrap();
        let options =
            OracleSchemaSyncDdlOptions { separate_indexes: true, target: Some(endpoint), ..Default::default() };
        let captured = prepare_schema_sync_oracle_ddl_core(&state, &diffs, true, &options).await;
        assert_eq!(captured.rollback.len(), 1);
        assert!(captured.rollback[0].issues.is_empty(), "{:?}", captured.rollback[0].issues);
        assert_eq!(captured.rollback[0].supporting_indexes.len(), 1);
        let conflict = POST_SOURCE.replace("USING INDEX \" O'w \".\" I'x \"", "USING INDEX \" O'w \".OTHER");
        assert!(separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", &conflict)
            .await
            .unwrap_err()
            .contains("binding disagree"));
    }

    #[tokio::test]
    async fn oracle_family_trigger_enrichment_retains_lists_and_rejects_known_state_conflicts() {
        for mode in [
            "trigger-enrich-disabled",
            "trigger-enrich-complete",
            "trigger-enrich-conflict",
            "trigger-enrich-permission",
            "trigger-enrich-wrong-table",
            "trigger-enrich-incomplete",
        ] {
            let (directory, state) = fixture(mode).await;
            state.configs.write().await.get_mut("conn").unwrap().db_type =
                if mode == "trigger-enrich-complete" { DatabaseType::Oracle } else { DatabaseType::OceanbaseOracle };
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                list_triggers_core(&state, "conn", "demo", OWNER, "T"),
            )
            .await
            .expect("metadata mutex must be released before enrichment");
            if mode == "trigger-enrich-conflict" {
                assert!(result.unwrap_err().contains("firing state changed"));
                continue;
            }
            if mode == "trigger-enrich-wrong-table" {
                assert!(result.unwrap_err().contains("declaration identity changed"));
                continue;
            }
            let triggers = result.unwrap();
            assert_eq!(triggers.len(), 1);
            if mode == "trigger-enrich-permission" || mode == "trigger-enrich-incomplete" {
                assert!(triggers[0].enabled.is_none());
                assert!(triggers[0].statement.is_none());
            } else {
                assert_eq!(triggers[0].enabled, Some(false));
                assert!(triggers[0].statement.as_ref().unwrap().contains(":NEW.ID := 42"));
            }
            if mode == "trigger-enrich-complete" {
                let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
                assert!(!calls.contains("ALL_TRIGGERS"));
                assert!(!calls.contains("get_object_source"));
            }
        }
    }

    #[tokio::test]
    async fn selected_index_null_secondary_uses_the_read_endpoint_product() {
        for oceanbase in [false, true] {
            let (_directory, state) = fixture("secondary-null").await;
            if oceanbase {
                state.configs.write().await.get_mut("conn").unwrap().db_type = DatabaseType::OceanbaseOracle;
            }
            let endpoint = OracleSchemaSyncEndpoint {
                connection_id: "conn".into(),
                database: "demo".into(),
                schema: OWNER.into(),
            };
            assert_eq!(selected_index_identity(&state, &endpoint, "T", OWNER, " I'x ").await.is_ok(), oceanbase);
        }
    }

    #[tokio::test]
    async fn oceanbase_view_export_keeps_inline_support_and_supplements_only_the_ordinary_index() {
        let (directory, state) = fixture("ob-ordinary").await;
        state.configs.write().await.get_mut("conn").unwrap().db_type = DatabaseType::OceanbaseOracle;
        let result = separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", SOURCE).await.unwrap();
        assert!(result.contains("PRIMARY KEY (\"ID\") USING INDEX ENABLE"));
        assert_eq!(result.matches("CREATE INDEX").count(), 1);
        assert!(result.contains("\"ORD\""));
        let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert_eq!(calls.matches("GET_DDL").count(), 1);
        assert!(calls.contains("'ORD'"));
    }

    #[tokio::test]
    async fn oceanbase_target_retains_inline_support_without_reading_supporting_ddl_for_either_source_product() {
        for source_ob in [false, true] {
            let (directory, state) = fixture("valid").await;
            let mut configs = state.configs.write().await;
            if source_ob {
                configs.get_mut("conn").unwrap().db_type = DatabaseType::OceanbaseOracle;
            }
            let mut target = configs["conn"].clone();
            target.id = "target".into();
            target.db_type = DatabaseType::OceanbaseOracle;
            configs.insert("target".into(), target);
            drop(configs);
            let diffs =
                serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"added","name":"T","ddl":SOURCE}])).unwrap();
            let options = OracleSchemaSyncDdlOptions {
                separate_indexes: true,
                source: Some(OracleSchemaSyncEndpoint {
                    connection_id: "conn".into(),
                    database: "demo".into(),
                    schema: OWNER.into(),
                }),
                target: Some(OracleSchemaSyncEndpoint {
                    connection_id: "target".into(),
                    database: "demo".into(),
                    schema: "DEST".into(),
                }),
                table_mappings: Vec::new(),
            };
            let captured = prepare_schema_sync_oracle_ddl_core(&state, &diffs, false, &options).await;
            assert!(captured.forward[0].issues.is_empty(), "{:?}", captured.forward[0].issues);
            assert!(captured.forward[0].supporting_indexes.is_empty());
            assert_eq!(captured.forward[0].retained_supporting_indexes.len(), 1);
            let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(!calls.contains("GET_DDL"));
        }
    }

    #[tokio::test]
    async fn retained_inline_support_does_not_silently_change_nonunique_physical_indexes() {
        let (_directory, state) = fixture("retained-nonunique").await;
        let error =
            capture_table_ddl_indexes(&state, "conn", "demo", OWNER, "T", SOURCE, true, false).await.err().unwrap();
        assert!(error.contains("original index uniqueness"), "{error}");
    }

    #[tokio::test]
    async fn selected_index_rejects_changed_comparison_metadata_before_reading_definition() {
        for (mode, changed) in [("index-snapshot", false), ("index-snapshot-changed", true)] {
            let (directory, state) = fixture(mode).await;
            let endpoint = OracleSchemaSyncEndpoint {
                connection_id: "conn".into(),
                database: "demo".into(),
                schema: OWNER.into(),
            };
            let snapshot: db::IndexInfo =
                serde_json::from_value(json!({"name":" I'x ","columns":["ID"],"is_unique":false,"is_primary":false}))
                    .unwrap();
            let result = selected_index_definition(&state, &endpoint, "T", &snapshot, None).await;
            if changed {
                assert!(result.unwrap_err().contains("changed since comparison"));
                let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
                assert!(!calls.contains("GET_DDL"));
            } else {
                assert_eq!(result.unwrap().name, " I'x ");
            }
        }
    }

    #[tokio::test]
    async fn trigger_identity_preflight_preserves_retained_objects_and_allows_planned_table_drops() {
        for (mode, allowed) in [("trigger-empty", true), ("trigger-dropped", true), ("trigger-collision", false)] {
            let (directory, state) = fixture(mode).await;
            let endpoint = OracleSchemaSyncEndpoint {
                connection_id: "conn".into(),
                database: "demo".into(),
                schema: OWNER.into(),
            };
            let result = target_trigger_available(&state, &endpoint, " T'r ", &["T"]).await;
            assert_eq!(result.is_ok(), allowed, "{result:?}");
            let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(calls.contains("TRIGGER_NAME = ' T''r '"));
            assert!(!calls.contains("GET_DDL"));
        }
    }

    #[tokio::test]
    async fn comparison_removed_only_checks_target_protection_without_source_or_ddl_reads() {
        for (mode, protected) in [("valid", true), ("ordinary", false)] {
            let (directory, state) = fixture(mode).await;
            let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{
                "type":"modified", "name":"T", "indexes":[{"type":"removed", "name":" I'x "}]
            }]))
            .unwrap();
            let options = OracleSchemaSyncDdlOptions {
                separate_indexes: true,
                source: None,
                target: Some(OracleSchemaSyncEndpoint {
                    connection_id: "conn".into(),
                    database: "demo".into(),
                    schema: OWNER.into(),
                }),
                table_mappings: Vec::new(),
            };
            let captured = prepare_schema_sync_oracle_ddl_core(&state, &diffs, false, &options).await;
            assert!(captured.rollback.is_empty());
            assert_eq!(captured.forward.len(), 1);
            assert!(captured.forward[0].issues.is_empty(), "{:?}", captured.forward[0].issues);
            assert_eq!(captured.forward[0].protected_drop_indexes.contains(&" I'x ".into()), protected);
            assert!(captured.forward[0].indexes.is_empty());
            let requests = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            let queries = requests
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .filter(|request| request["method"] == "execute_query")
                .collect::<Vec<_>>();
            assert_eq!(queries.len(), 2);
            assert!(queries[0]["params"]["sql"].as_str().unwrap().contains("ALL_CONSTRAINTS"));
            assert!(queries[1]["params"]["sql"].as_str().unwrap().contains("INDEX_NAME = ' I''x '"));
            assert!(!requests.contains("GET_DDL"));
        }
    }

    #[tokio::test]
    async fn comparison_disabled_option_needs_no_endpoint_or_metadata_queries() {
        let (directory, state) = fixture("valid").await;
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"added", "name":"T"}])).unwrap();
        let captured =
            prepare_schema_sync_oracle_ddl_core(&state, &diffs, true, &OracleSchemaSyncDdlOptions::default()).await;
        assert!(captured.forward.is_empty());
        assert!(captured.rollback.is_empty());
        let requests = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert!(!requests.contains("execute_query"));
    }

    #[tokio::test]
    async fn comparison_explicit_schema_can_equal_service_without_using_the_legacy_fallback() {
        let (_directory, state) = fixture("ordinary").await;
        let endpoint =
            OracleSchemaSyncEndpoint { connection_id: "conn".into(), database: OWNER.into(), schema: OWNER.into() };
        let ddl = "CREATE TABLE T(ID NUMBER);";
        let diff = serde_json::from_value(json!({"type":"added", "name":"T", "ddl":ddl})).unwrap();
        let captured = capture_comparison_table(&state, Some(&endpoint), &diff, false, true).await;
        assert!(captured.issues.is_empty(), "{:?}", captured.issues);
        assert_eq!(captured.owner, OWNER);
        assert!(captured.table_ddl.unwrap().contains("CREATE TABLE T"));
        assert!(separate_table_ddl_indexes_core(&state, "conn", OWNER, OWNER, "T", ddl)
            .await
            .unwrap_err()
            .contains("explicit Oracle schema"));
    }

    #[tokio::test]
    async fn native_ddl_fallback_validates_comparison_facts_and_requires_a_complete_snapshot() {
        for (mode, changed) in [("snapshot", false), ("snapshot-changed", true)] {
            let (directory, state) = fixture(mode).await;
            let endpoint = OracleSchemaSyncEndpoint {
                connection_id: "conn".into(),
                database: "demo".into(),
                schema: OWNER.into(),
            };
            let missing = serde_json::from_value(json!({"type":"added", "name":"T"})).unwrap();
            assert!(validate_comparison_snapshot(&state, &endpoint, "T", &missing, false)
                .await
                .unwrap_err()
                .contains("snapshot is unavailable"));
            let complete = serde_json::from_value(
                json!({"type":"added", "name":"T", "columns":[], "indexes":[], "foreignKeys":[]}),
            )
            .unwrap();
            let result = validate_comparison_snapshot(&state, &endpoint, "T", &complete, false).await;
            if changed {
                assert!(result.unwrap_err().contains("changed since comparison"));
            } else {
                result.unwrap();
            }
            let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(calls.contains("get_columns"));
            assert!(calls.contains("list_indexes"));
            assert!(calls.contains("list_foreign_keys"));
        }
    }

    #[tokio::test]
    async fn index_drop_rejects_empty_dictionary_when_target_snapshot_has_supporting_constraints() {
        let (directory, state) = fixture("ordinary").await;
        let endpoint =
            OracleSchemaSyncEndpoint { connection_id: "conn".into(), database: "demo".into(), schema: OWNER.into() };
        let error = protected_target_indexes(&state, &endpoint, "T", Some(SOURCE)).await.unwrap_err();
        assert!(error.contains("supporting constraints missing from dictionary"), "{error}");
        let requests = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert!(!requests.contains("GET_DDL"));
    }

    #[tokio::test]
    async fn independent_indexes_core_preserves_full_definitions_and_exact_dictionary_identity() {
        let (directory, state) = fixture("valid").await;
        let result = separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", SOURCE).await.unwrap();
        assert!(result.contains(&"完整定义 ".repeat(4000)));
        assert!(result.contains("(\"ID\" DESC) INVISIBLE"));
        assert!(result.contains("USING INDEX \" O'w \".\" I'x \""));
        let requests: Vec<Value> = std::fs::read_to_string(directory.path().join("calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == "execute_query")
            .collect();
        assert_eq!(requests.len(), 3);
        assert!(requests[0]["params"]["sql"].as_str().unwrap().contains("OWNER = ' O''w ' AND TABLE_NAME = 'T'"));
        assert!(requests[1]["params"]["sql"].as_str().unwrap().contains("GET_DDL('INDEX', ' I''x ', ' O''w ')"));
        assert_eq!(requests[1]["params"]["deferLobs"], false);
        state.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn independent_indexes_core_rejects_incomplete_or_mismatched_metadata() {
        for mode in [
            "dictionary-deferred",
            "ddl-deferred",
            "ddl-deferred-snake",
            "ddl-more",
            "ddl-truncated",
            "ddl-error",
            "ddl-empty",
            "wrong-owner",
            "missing-index",
            "empty",
            "wrong-table",
            "wrong-state",
            "inventory-wrong-table",
            "inventory-deferred",
        ] {
            let (_directory, state) = fixture(mode).await;
            let error = separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", SOURCE).await.unwrap_err();
            let expected = match mode {
                "dictionary-deferred"
                | "ddl-deferred"
                | "ddl-deferred-snake"
                | "ddl-more"
                | "ddl-truncated"
                | "inventory-deferred" => "truncated or deferred",
                "ddl-error" => "execution error",
                "ddl-empty" => "complete index DDL",
                "wrong-owner" => "different table owner",
                "missing-index" => "supporting-index identity",
                "empty" => "without matching dictionary metadata",
                "wrong-table" => "different table",
                "wrong-state" => "source and dictionary disagree",
                "inventory-wrong-table" => "inventory belongs to a different table",
                _ => unreachable!(),
            };
            assert!(error.contains(expected), "{mode}: {error}");
            state.shutdown(Duration::from_secs(1)).await;
        }
    }

    #[tokio::test]
    async fn independent_indexes_core_validates_empty_disabled_and_iot_relations_without_fetching_an_index() {
        for (mode, source) in [
            ("empty", "CREATE TABLE \" O'w \".\"T\" (\"ID\" NUMBER);".to_string()),
            ("secondary", "CREATE TABLE \" O'w \".\"T\" (\"ID\" NUMBER);".to_string()),
            ("disabled", SOURCE.replace(" ENABLE", " DISABLE")),
            ("iot", SOURCE.trim_end_matches(';').to_string() + " ORGANIZATION INDEX;"),
        ] {
            let (directory, state) = fixture(mode).await;
            let result = separate_table_ddl_indexes_core(&state, "conn", "demo", "demo", "T", &source).await.unwrap();
            assert_eq!(result, source);
            let requests = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert!(!requests.contains("GET_DDL"), "{mode}: {requests}");
            state.shutdown(Duration::from_secs(1)).await;
        }
    }

    #[tokio::test]
    async fn independent_indexes_core_restores_missing_ordinary_definitions_without_duplicating_existing_source() {
        for existing in [false, true] {
            let (directory, state) = fixture("ordinary").await;
            let mut source = "CREATE TABLE \" O'w \".\"T\" (\"ID\" NUMBER);".to_string();
            if existing {
                source.push_str("\nCREATE INDEX \" O'w \".\" I'x \" ON \" O'w \".\"T\" (\"ID\" DESC) INVISIBLE;");
            }
            let result = separate_table_ddl_indexes_core(&state, "conn", "demo", OWNER, "T", &source).await.unwrap();
            assert_eq!(result.matches(" INDEX ").count(), 1);
            assert!(result.contains("DESC) INVISIBLE"));
            assert!(!result.contains("ALTER TABLE"));
            let requests = std::fs::read_to_string(directory.path().join("calls")).unwrap();
            assert_eq!(requests.contains("GET_DDL"), !existing);
            state.shutdown(Duration::from_secs(1)).await;
        }
    }
}
