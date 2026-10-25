//! Exact reads for the two legacy Oracle-family SQL transports. Modern Agents
//! and JDBC keep their native metadata methods; only the legacy paths share
//! this bounded dictionary adapter.

use super::*;
use dbx_types::oracle_trigger::{
    OracleTriggerDefinition, OracleTriggerError, OracleTriggerMetadata, OracleTriggerParent, OracleTriggerReadState,
};
use serde_json::{json, Value};
use std::pin::Pin;

#[cfg(test)]
#[path = "oracle_triggers_tests.rs"]
mod tests;

type ReadFuture = Pin<Box<dyn Future<Output = Result<db::QueryResult, String>> + Send>>;
type ReadQuery = Box<dyn FnMut(String) -> ReadFuture + Send>;

/// Full transport text alone does not prove a complete, same-target definition.
/// Keep the original export/partial source, but clamp the optional exact proof.
pub(super) fn validate_source_definition(source: &mut db::ObjectSource, owner: &str, name: &str) {
    use crate::object_source_sql::{
        prepare_oracle_trigger_sql, OracleTriggerSqlBinding, OracleTriggerSqlInput, OracleTriggerSqlPurpose,
    };
    if source.object_type != db::ObjectSourceKind::Trigger {
        return;
    }
    let Some(trigger) = source.trigger.as_mut() else {
        return;
    };
    let Some(metadata) = trigger.oracle_metadata.as_mut() else {
        return;
    };
    let identity_matches = metadata.contract_version == 1
        && metadata.owner == owner
        && metadata.name == name
        && trigger.name == name
        && source.name == name
        && source.schema.as_deref() == Some(owner);
    if !identity_matches {
        metadata
            .reads
            .insert("identity".into(), state("incomplete", "The source does not match the requested exact trigger"));
    }
    if !metadata.definition.as_ref().is_some_and(|definition| definition.complete) {
        return;
    }
    let result = (|| {
        if !identity_matches {
            return Err("Reload the exact trigger identity".to_string());
        }
        if !metadata.reads.get("definition").is_some_and(|read| read.state == "available") {
            return Err("The complete source read was not verified".to_string());
        }
        let database_type = match metadata.engine.as_str() {
            "oracle" => DatabaseType::Oracle,
            "oceanbase-oracle" => DatabaseType::OceanbaseOracle,
            "dm" => DatabaseType::Dameng,
            _ => return Err("The trigger engine profile was not verified".to_string()),
        };
        let binding = match metadata.scope.as_str() {
            "TABLE" | "VIEW" => {
                metadata.parent.as_ref().filter(|parent| parent.object_type == metadata.scope).map(|parent| {
                    OracleTriggerSqlBinding {
                        scope: metadata.scope.clone(),
                        owner: Some(parent.owner.clone()),
                        name: Some(parent.name.clone()),
                        pluggable: false,
                    }
                })
            }
            "SCHEMA" => metadata.scope_owner.as_ref().map(|owner| OracleTriggerSqlBinding {
                scope: "SCHEMA".into(),
                owner: Some(owner.clone()),
                name: None,
                pluggable: false,
            }),
            _ => None, // The plan verifies actual database/container context.
        };
        let definition = metadata.definition.as_ref().unwrap();
        prepare_oracle_trigger_sql(OracleTriggerSqlInput {
            database_type,
            owner: owner.to_string(),
            name: name.to_string(),
            source: source.source.clone(),
            purpose: OracleTriggerSqlPurpose::Inspect,
            binding,
            enabled: None,
            allow_export_appendix: definition.origin == "DBMS_METADATA" && definition.format == "ddl",
        })
        .and_then(|prepared| {
            let matches = match metadata.scope.as_str() {
                "TABLE" | "VIEW" => {
                    prepared.header.scope == "RELATION" && (!prepared.header.view_only || metadata.scope == "VIEW")
                }
                "SCHEMA" | "DATABASE" | "TIMER" => prepared.header.scope == metadata.scope,
                _ => true,
            };
            if matches {
                Ok(())
            } else {
                Err("The source ON scope does not match the trigger dictionary; reload".to_string())
            }
        })
    })();
    if let Err(error) = result {
        metadata.definition.as_mut().unwrap().complete = false;
        metadata.reads.insert("definition".into(), state("incomplete", &error));
    }
}

pub(super) async fn agent_reader(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout: Option<Duration>,
) -> LegacyReader {
    let version = client
        .lock()
        .await
        .connection_info(timeout)
        .await
        .ok()
        .and_then(|info| info.database_info)
        .and_then(|info| info.product_version);
    let database = database.to_string();
    let schema = schema.to_string();
    LegacyReader::new(
        "oracle",
        version,
        Box::new(move |sql| {
            let client = client.clone();
            let params = agent_execute_query_params(
                &sql,
                Some(&database),
                Some(&schema),
                QueryExecutionOptions { max_rows: Some(i32::MAX as usize), ..Default::default() },
            );
            Box::pin(async move { client.lock().await.execute_query_with_timeout(params, timeout).await })
        }),
    )
}

pub(super) async fn pool_reader(pool: db::mysql::MySqlPool) -> LegacyReader {
    let version =
        db::mysql::database_connection_info(&pool, "OceanBase").await.ok().and_then(|info| info.product_version);
    LegacyReader::new(
        "oceanbase-oracle",
        version,
        Box::new(move |sql| {
            let pool = pool.clone();
            Box::pin(async move {
                db::mysql::execute_query_with_max_rows(
                    &pool,
                    &sql,
                    true,
                    Some(i32::MAX as usize),
                    db::mysql::MySqlQueryDialect::for_connection(DatabaseType::OceanbaseOracle, None),
                )
                .await
            })
        }),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn list_objects(
    state: &AppState,
    pool_key: &str,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<&[String]>,
    table_name_filter: Option<&TableNameFilter>,
    options: &MetadataReadOptions,
) -> Result<Option<ObjectListOutcome>, String> {
    let local_filter = table_name_filter.is_some_and(|filter| !filter.is_empty());
    let (page_limit, page_offset) = if local_filter { (None, None) } else { (limit, offset) };
    match state.pool_handle(pool_key).await {
        Some(PoolKind::ExternalDriver { config, session, .. }) => {
            let mut params = json!({"connection": config.as_ref(), "database": database, "schema": schema});
            options.apply_to(&mut params);
            if let Some(filter) = filter {
                params["filter"] = json!(filter);
            }
            if let Some(types) = object_types {
                params["object_types"] = json!(types);
            }
            if let Some(limit) = page_limit {
                params["limit"] = json!(limit);
            }
            if let Some(offset) = page_offset {
                params["offset"] = json!(offset);
            }
            let objects =
                session.invoke_with_timeout("listObjects", params, agent_metadata_timeout(Some(&config))).await?;
            Ok(Some(ObjectListOutcome { objects, paging_applied: !local_filter }))
        }
        Some(PoolKind::Agent(client))
            if config.is_some_and(|config| {
                matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng)
            }) =>
        {
            let timeout = agent_metadata_timeout(config);
            let objects = if config
                .is_some_and(|config| config.db_type == DatabaseType::Oracle && !is_default_oracle_agent_config(config))
            {
                agent_reader(client, database, schema, timeout)
                    .await
                    .list_objects(schema, filter, page_limit, page_offset, object_types)
                    .await?
            } else {
                client
                    .lock()
                    .await
                    .list_objects_with_options(
                        database,
                        schema,
                        filter,
                        page_limit,
                        page_offset,
                        object_types,
                        options,
                        timeout,
                    )
                    .await?
            };
            let paging_applied = !local_filter;
            Ok(Some(ObjectListOutcome { objects, paging_applied }))
        }
        Some(PoolKind::Mysql(pool, MysqlMode::OceanBaseOracle)) => {
            let objects =
                pool_reader(pool).await.list_objects(schema, filter, page_limit, page_offset, object_types).await?;
            Ok(Some(ObjectListOutcome { objects, paging_applied: !local_filter }))
        }
        _ => Ok(None),
    }
}

pub(super) struct LegacyReader {
    engine: String,
    version: Option<String>,
    query: ReadQuery,
}

impl LegacyReader {
    fn new(engine: &str, version: Option<String>, query: ReadQuery) -> Self {
        Self { engine: engine.to_string(), version, query }
    }

    async fn read(&mut self, sql: String) -> Result<db::QueryResult, String> {
        let result = (self.query)(sql).await?;
        if result.truncated || result.has_more {
            return Err("Trigger dictionary read is incomplete; reload".to_string());
        }
        Ok(result)
    }

    async fn list_objects(
        &mut self,
        owner: &str,
        filter: Option<&str>,
        limit: Option<usize>,
        offset: Option<usize>,
        requested_types: Option<&[String]>,
    ) -> Result<Vec<db::ObjectInfo>, String> {
        require_identity(owner)?;
        if limit == Some(0) {
            return Ok(Vec::new());
        }
        const TYPES: &[&str] = &[
            "TABLE",
            "VIEW",
            "MATERIALIZED_VIEW",
            "PROCEDURE",
            "FUNCTION",
            "PACKAGE",
            "PACKAGE_BODY",
            "SEQUENCE",
            "SYNONYM",
            "INDEX",
            "TRIGGER",
            "TYPE",
            "TYPE_BODY",
        ];
        let types: Vec<String> = match requested_types.filter(|types| !types.is_empty()) {
            Some(types) => types
                .iter()
                .map(|value| value.to_ascii_uppercase().replace(' ', "_"))
                .filter(|value| TYPES.contains(&value.as_str()))
                .collect(),
            None => TYPES.iter().map(|value| value.to_string()).collect(),
        };
        if types.is_empty() {
            return Ok(Vec::new());
        }
        let types = types.iter().map(|value| sql_string(&value.replace('_', " "))).collect::<Vec<_>>().join(",");
        let predicate = filter.filter(|value| !value.trim().is_empty()).map(|filter| {
            let mut pattern = "%".to_string();
            for ch in filter.trim().to_uppercase().chars() {
                if matches!(ch, '~' | '%' | '_') { pattern.push('~'); }
                pattern.push(ch);
                pattern.push('%');
            }
            let pattern = sql_string(&pattern);
            format!(" AND (UPPER(o.OBJECT_NAME) LIKE {pattern} ESCAPE '~' OR UPPER(c.COMMENTS) LIKE {pattern} ESCAPE '~')")
        }).unwrap_or_default();
        let mut sql = format!("SELECT o.OBJECT_NAME, REPLACE(o.OBJECT_TYPE,' ','_') AS OBJECT_TYPE, o.OWNER, c.COMMENTS, i.TABLE_OWNER AS PARENT_SCHEMA, i.TABLE_NAME AS PARENT_NAME FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER=o.OWNER AND c.TABLE_NAME=o.OBJECT_NAME AND o.OBJECT_TYPE IN ('TABLE','VIEW') LEFT JOIN ALL_INDEXES i ON o.OBJECT_TYPE='INDEX' AND i.OWNER=o.OWNER AND i.INDEX_NAME=o.OBJECT_NAME WHERE o.OWNER={} AND o.OBJECT_TYPE IN ({types}) AND (o.OBJECT_TYPE<>'INDEX' OR i.GENERATED='N' OR i.GENERATED IS NULL){predicate} ORDER BY CASE o.OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'MATERIALIZED VIEW' THEN 2 WHEN 'PROCEDURE' THEN 3 WHEN 'FUNCTION' THEN 4 WHEN 'SEQUENCE' THEN 5 WHEN 'SYNONYM' THEN 6 WHEN 'PACKAGE' THEN 7 ELSE 8 END,o.OBJECT_NAME,o.OWNER,o.OBJECT_ID", sql_string(owner));
        if limit.is_some() || offset.is_some_and(|offset| offset > 0) {
            let offset = offset.unwrap_or(0);
            let bound = match limit {
                Some(limit) => {
                    format!(" WHERE ROWNUM <= {}", offset.checked_add(limit).ok_or("Metadata page overflow")?)
                }
                None => String::new(),
            };
            sql = format!("SELECT OBJECT_NAME,OBJECT_TYPE,OWNER,COMMENTS,PARENT_SCHEMA,PARENT_NAME FROM (SELECT dbx_page.*,ROWNUM DBX_RN FROM ({sql}) dbx_page{bound}) WHERE DBX_RN > {offset}");
        }
        let result = self.read(sql).await?;
        let mut objects = result
            .rows
            .iter()
            .map(|row| {
                Ok(db::ObjectInfo {
                    name: required(&result, row, "OBJECT_NAME")?,
                    object_type: required(&result, row, "OBJECT_TYPE")?,
                    schema: Some(required(&result, row, "OWNER")?),
                    comment: cell(&result, row, "COMMENTS"),
                    valid: None,
                    signature: None,
                    custom_type_kind: None,
                    has_members: None,
                    created_at: None,
                    updated_at: None,
                    parent_schema: cell(&result, row, "PARENT_SCHEMA"),
                    parent_name: cell(&result, row, "PARENT_NAME"),
                    trigger: None,
                    xugu_type_members_expandable: None,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let names = objects
            .iter()
            .filter(|object| object.object_type == "TRIGGER")
            .map(|object| object.name.clone())
            .collect::<Vec<_>>();
        for names in names.chunks(500) {
            let predicate = format!(
                "t.OWNER={} AND t.TRIGGER_NAME IN ({})",
                sql_string(owner),
                names.iter().map(|name| sql_string(name)).collect::<Vec<_>>().join(",")
            );
            let summaries = self.summaries(&predicate, false).await;
            for object in
                objects.iter_mut().filter(|object| object.object_type == "TRIGGER" && names.contains(&object.name))
            {
                let trigger = match &summaries {
                    Ok(summaries) => summaries
                        .iter()
                        .find(|trigger| {
                            trigger.name == object.name
                                && trigger.oracle_metadata.as_ref().is_some_and(|meta| meta.owner == owner)
                        })
                        .cloned()
                        .unwrap_or_else(|| {
                            self.unknown(
                                owner,
                                &object.name,
                                state("incomplete", "Trigger changed or is no longer visible; reload"),
                            )
                        }),
                    Err(error) => self.unknown(owner, &object.name, failure(error)),
                };
                object.valid = trigger.valid;
                if let Some(parent) = trigger.oracle_metadata.as_ref().and_then(|meta| meta.parent.as_ref()) {
                    object.parent_schema = Some(parent.owner.clone());
                    object.parent_name = Some(parent.name.clone());
                }
                object.trigger = Some(trigger);
            }
        }
        Ok(objects)
    }

    pub(super) async fn list_triggers(&mut self, owner: &str, parent: &str) -> Result<Vec<db::TriggerInfo>, String> {
        require_identity(owner)?;
        require_identity(parent)?;
        self.summaries(&format!("t.TABLE_OWNER={} AND t.TABLE_NAME={}", sql_string(owner), sql_string(parent)), true)
            .await
    }

    async fn summaries(&mut self, predicate: &str, body: bool) -> Result<Vec<db::TriggerInfo>, String> {
        let body_column = if body { ",t.TRIGGER_BODY AS BODY" } else { "" };
        let result = self.read(format!("SELECT t.OWNER,t.TRIGGER_NAME,t.TRIGGERING_EVENT,t.TRIGGER_TYPE,t.STATUS AS ENABLED_STATUS,t.TABLE_OWNER,t.TABLE_NAME,t.BASE_OBJECT_TYPE,t.WHEN_CLAUSE,TO_CHAR(o.OBJECT_ID) AS OBJECT_ID,TO_CHAR(o.LAST_DDL_TIME,'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME,o.STATUS AS VALIDITY{body_column} FROM ALL_TRIGGERS t LEFT JOIN ALL_OBJECTS o ON o.OWNER=t.OWNER AND o.OBJECT_NAME=t.TRIGGER_NAME AND o.OBJECT_TYPE='TRIGGER' WHERE {predicate} ORDER BY t.TRIGGER_NAME,t.OWNER,o.OBJECT_ID")).await?;
        let mut identities = HashSet::new();
        result
            .rows
            .iter()
            .map(|row| {
                let owner = required(&result, row, "OWNER")?;
                let name = required(&result, row, "TRIGGER_NAME")?;
                if !identities.insert((owner.clone(), name.clone())) {
                    return Err("Trigger identity is not unique".to_string());
                }
                let enabled = match cell(&result, row, "ENABLED_STATUS").as_deref() {
                    Some("ENABLED") => Some(true),
                    Some("DISABLED") => Some(false),
                    _ => None,
                };
                let valid = match cell(&result, row, "VALIDITY").as_deref() {
                    Some("VALID") => Some(true),
                    Some("INVALID") => Some(false),
                    _ => None,
                };
                let mut metadata = self.metadata(&owner, &name);
                metadata.scope_type = cell(&result, row, "BASE_OBJECT_TYPE");
                metadata.scope = match metadata.scope_type.as_deref() {
                    Some(scope @ ("TABLE" | "VIEW" | "SCHEMA" | "DATABASE")) => scope.to_string(),
                    None => "UNKNOWN".to_string(),
                    _ => "OTHER".to_string(),
                };
                let parent_owner = cell(&result, row, "TABLE_OWNER");
                let parent_name = cell(&result, row, "TABLE_NAME");
                if matches!(metadata.scope.as_str(), "TABLE" | "VIEW") {
                    if let (Some(owner), Some(name)) = (parent_owner.clone(), parent_name) {
                        metadata.parent = Some(OracleTriggerParent {
                            owner,
                            name,
                            object_type: metadata.scope.clone(),
                            object_id: None,
                        });
                    }
                } else if metadata.scope == "SCHEMA" {
                    metadata.scope_owner = parent_owner;
                }
                metadata.object_id = cell(&result, row, "OBJECT_ID");
                metadata.last_ddl_time = cell(&result, row, "LAST_DDL_TIME");
                metadata.reads.insert("identity".into(), availability(metadata.object_id.is_some(), "Object ID"));
                metadata.reads.insert(
                    "scope".into(),
                    availability(
                        metadata.scope != "UNKNOWN" && (metadata.scope != "SCHEMA" || metadata.scope_owner.is_some()),
                        "Trigger scope",
                    ),
                );
                metadata.reads.insert(
                    "parent".into(),
                    availability(
                        match metadata.scope.as_str() {
                            "TABLE" | "VIEW" => metadata.parent.is_some(),
                            "UNKNOWN" | "OTHER" => false,
                            _ => true,
                        },
                        "Owning object",
                    ),
                );
                metadata.reads.insert("enabled".into(), availability(enabled.is_some(), "Enabled state"));
                metadata.reads.insert("validity".into(), availability(valid.is_some(), "Object validity"));
                Ok(db::TriggerInfo {
                    name,
                    event: cell(&result, row, "TRIGGERING_EVENT").unwrap_or_default(),
                    timing: cell(&result, row, "TRIGGER_TYPE").unwrap_or_default(),
                    level: None,
                    language: None,
                    comment: None,
                    created_at: None,
                    condition: cell(&result, row, "WHEN_CLAUSE"),
                    statement: cell(&result, row, "BODY"),
                    enabled,
                    valid,
                    oracle_metadata: Some(metadata),
                })
            })
            .collect()
    }

    pub(super) async fn source(&mut self, owner: &str, name: &str) -> Result<db::ObjectSource, String> {
        require_identity(owner)?;
        require_identity(name)?;
        let predicate = format!("t.OWNER={} AND t.TRIGGER_NAME={}", sql_string(owner), sql_string(name));
        let before = self.summaries(&predicate, true).await?;
        let mut source = db::ObjectSource {
            name: name.to_string(),
            object_type: db::ObjectSourceKind::Trigger,
            schema: Some(owner.to_string()),
            source: String::new(),
            editable: None,
            routine_parameters: None,
            trigger: None,
        };
        let Some(first) = before.first() else {
            source.editable = Some(false);
            let mut trigger = self.unknown(owner, name, availability(false, "Visible trigger"));
            trigger
                .oracle_metadata
                .as_mut()
                .unwrap()
                .reads
                .insert("identity".into(), state("empty", "No visible trigger with this exact owner/name"));
            source.trigger = Some(trigger);
            return Ok(source);
        };
        if first.name != name || first.oracle_metadata.as_ref().is_none_or(|meta| meta.owner != owner) {
            return Err("Trigger identity does not match the exact request".to_string());
        }
        let mut origin = "catalog-body";
        let mut format = "body";
        let mut definition_state = availability(false, "Complete trigger definition");
        let queries = [
            (
                format!(
                    "SELECT LINE,TEXT FROM ALL_SOURCE WHERE OWNER={} AND NAME={} AND TYPE='TRIGGER' ORDER BY LINE",
                    sql_string(owner),
                    sql_string(name)
                ),
                "ALL_SOURCE",
                "declaration",
            ),
            (
                format!(
                    "SELECT DBMS_METADATA.GET_DDL('TRIGGER',{}, {}) FROM DUAL",
                    sql_string(name),
                    sql_string(owner)
                ),
                "DBMS_METADATA",
                "ddl",
            ),
        ];
        for (sql, next_origin, next_format) in queries {
            match self.read(sql).await.and_then(|result| {
                let mut text = String::new();
                for (index, row) in result.rows.iter().enumerate() {
                    if next_origin == "ALL_SOURCE" && cell(&result, row, "LINE") != Some((index + 1).to_string()) {
                        return Err("Trigger source lines are incomplete".to_string());
                    }
                    let value = if next_origin == "ALL_SOURCE" {
                        cell(&result, row, "TEXT")
                    } else {
                        row.first().and_then(Value::as_str).map(str::to_string)
                    };
                    text.push_str(&value.ok_or("Trigger source text is unreadable")?);
                }
                Ok(text)
            }) {
                Ok(text) if !text.trim().is_empty() => {
                    source.source = text;
                    origin = next_origin;
                    format = next_format;
                    definition_state = available();
                    break;
                }
                Ok(_) => {}
                Err(error) => definition_state = failure(&error),
            }
        }
        if source.source.is_empty() {
            source.source = first.statement.clone().unwrap_or_default();
        }
        let (errors, error_state) = match self.errors(owner, name).await {
            Ok(errors) => (Some(errors), available()),
            Err(error) => (None, failure(&error)),
        };
        let after = self.summaries(&predicate, true).await?;
        let stable = json!(before) == json!(after);
        let mut trigger = after.into_iter().next().unwrap_or_else(|| first.clone());
        let metadata = trigger.oracle_metadata.as_mut().ok_or("Missing trigger metadata")?;
        metadata.definition = Some(OracleTriggerDefinition {
            origin: origin.to_string(),
            format: format.to_string(),
            complete: stable && definition_state.state == "available" && format != "body",
        });
        metadata.errors = errors;
        metadata.reads.insert("definition".into(), definition_state);
        metadata.reads.insert("errors".into(), error_state);
        if !stable {
            let changed = state("incomplete", "Trigger changed while loading; reload");
            metadata.reads.insert("identity".into(), changed.clone());
            metadata.reads.insert("definition".into(), changed);
        }
        source.trigger = Some(trigger);
        Ok(source)
    }

    async fn errors(&mut self, owner: &str, name: &str) -> Result<Vec<OracleTriggerError>, String> {
        let result = self.read(format!("SELECT SEQUENCE,LINE,POSITION,TEXT,ATTRIBUTE FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE='TRIGGER' ORDER BY SEQUENCE", sql_string(owner), sql_string(name))).await?;
        result
            .rows
            .iter()
            .map(|row| {
                let number = |column: &str| {
                    required(&result, row, column)?
                        .parse::<i64>()
                        .map_err(|_| "Trigger error location is unreadable".to_string())
                };
                Ok(OracleTriggerError {
                    sequence: number("SEQUENCE")?,
                    line: number("LINE")?,
                    position: number("POSITION")?,
                    text: required(&result, row, "TEXT")?,
                    severity: cell(&result, row, "ATTRIBUTE"),
                })
            })
            .collect()
    }

    fn metadata(&self, owner: &str, name: &str) -> OracleTriggerMetadata {
        OracleTriggerMetadata {
            contract_version: 1,
            identity_mode: MetadataIdentityMode::Exact,
            engine: self.engine.clone(),
            engine_version: self.version.clone(),
            owner: owner.to_string(),
            name: name.to_string(),
            scope: "UNKNOWN".to_string(),
            scope_type: None,
            scope_owner: None,
            parent: None,
            object_id: None,
            last_ddl_time: None,
            definition: None,
            errors: None,
            reads: BTreeMap::new(),
        }
    }

    fn unknown(&self, owner: &str, name: &str, failure: OracleTriggerReadState) -> db::TriggerInfo {
        let mut metadata = self.metadata(owner, name);
        for field in ["identity", "scope", "parent", "enabled", "validity"] {
            metadata.reads.insert(field.to_string(), failure.clone());
        }
        db::TriggerInfo {
            name: name.to_string(),
            event: String::new(),
            timing: String::new(),
            level: None,
            language: None,
            comment: None,
            created_at: None,
            condition: None,
            statement: None,
            enabled: None,
            valid: None,
            oracle_metadata: Some(metadata),
        }
    }
}

fn require_identity(value: &str) -> Result<(), String> {
    if value.is_empty() {
        Err("Exact trigger metadata requires an owner and name".to_string())
    } else {
        Ok(())
    }
}

fn cell(result: &db::QueryResult, row: &[Value], column: &str) -> Option<String> {
    let index = result.columns.iter().position(|candidate| candidate.eq_ignore_ascii_case(column))?;
    match row.get(index)? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        value if value.is_number() => Some(value.to_string()),
        _ => None,
    }
}

fn required(result: &db::QueryResult, row: &[Value], column: &str) -> Result<String, String> {
    cell(result, row, column).ok_or_else(|| format!("Trigger metadata column {column} is unreadable"))
}

fn state(value: &str, message: &str) -> OracleTriggerReadState {
    OracleTriggerReadState { state: value.to_string(), message: (!message.is_empty()).then(|| message.to_string()) }
}

fn available() -> OracleTriggerReadState {
    state("available", "")
}

fn availability(available: bool, field: &str) -> OracleTriggerReadState {
    if available {
        self::available()
    } else {
        state("unavailable", &format!("{field} is not exposed by this dictionary"))
    }
}

fn failure(error: &str) -> OracleTriggerReadState {
    let code = if error.contains("ORA-01031") {
        "denied"
    } else if error.contains("ORA-00942") || error.contains("ORA-00904") {
        "unavailable"
    } else if error.contains("incomplete") {
        "incomplete"
    } else {
        "error"
    };
    state(code, "Trigger metadata read failed; reload or check dictionary access")
}
