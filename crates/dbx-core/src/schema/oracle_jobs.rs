//! Scheduler administration deliberately bypasses query history and SQL logging.
//! Never retry a mutation: Scheduler DDL and argument changes are not atomic.
use super::{agent_metadata_timeout, connection_config, lock_metadata_mutex_with_timeout};
use crate::connection::{AppState, PoolKind, METADATA_POOL_ACQUIRE_TIMEOUT};
use crate::db::{agent_driver::AgentDriverClient, QueryResult};
use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobIdentity {
    pub owner: String,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobDefinition {
    pub job_type: String,
    pub job_action: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub start_date: String,
    pub repeat_interval: String,
    #[serde(default)]
    pub end_date: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobChange {
    pub action: String,
    pub identity: JobIdentity,
    pub definition: Option<JobDefinition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleJobsRequest {
    pub operation: String,
    pub identity: Option<JobIdentity>,
    pub change: Option<JobChange>,
    pub revision: Option<String>,
}

struct Step {
    label: String,
    sql: String,
    preview: String,
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn scheduler_name(id: &JobIdentity) -> Result<String, String> {
    for part in [&id.owner, &id.name] {
        // These procedures also accept comma-separated object lists. Only one
        // precise object is supported by this editor, never a class/list.
        if part.is_empty() || part.contains(['\0', ',', '\n', '\r']) || part.len() > 128 {
            return Err("Invalid single job identity".into());
        }
    }
    Ok(literal(&format!("\"{}\".\"{}\"", id.owner.replace('"', "\"\""), id.name.replace('"', "\"\""))))
}

fn safe_error(error: &str) -> String {
    // Driver exceptions can echo the complete PL/SQL block and argument values.
    // Keep only a recognized numeric code, never a raw message or SQL excerpt.
    for prefix in ["ORA-", "OB-"] {
        if let Some(index) = error.find(prefix) {
            let digits: String =
                error[index + prefix.len()..].chars().take_while(char::is_ascii_digit).take(8).collect();
            if !digits.is_empty() {
                return format!("Job request failed ({prefix}{digits}); inspect database privileges and job state");
            }
        }
    }
    "Job request failed; definition and argument values are omitted from diagnostics".into()
}

fn availability(error: &str) -> &'static str {
    if error.contains("ORA-01031") {
        "denied"
    } else if error.contains("ORA-00904") {
        "unsupported"
    } else {
        "unknown"
    }
}

fn rows(result: QueryResult) -> Result<Vec<Value>, String> {
    if result.truncated || result.has_more || result.rows.len() > 10000 {
        return Err("Complete job metadata is unavailable; the result was truncated".into());
    }
    Ok(result
        .rows
        .into_iter()
        .map(|row| {
            Value::Object(
                result.columns.iter().zip(row).map(|(key, value)| (key.to_ascii_uppercase(), value)).collect(),
            )
        })
        .collect())
}

fn text(row: &Value, key: &str) -> String {
    match &row[key] {
        Value::String(value) => value.clone(),
        Value::Null => String::new(),
        value => value.to_string(),
    }
}

fn enabled(value: &Value) -> Option<bool> {
    match value.as_str().map(str::to_ascii_uppercase).as_deref() {
        Some("TRUE" | "1") => Some(true),
        Some("FALSE" | "0") => Some(false),
        _ => value.as_bool().or_else(|| {
            value.as_i64().and_then(|n| match n {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            })
        }),
    }
}

fn known_version(version: &str, oceanbase: bool) -> bool {
    let boundary = if oceanbase { "4.2.5" } else { "19." };
    version.split(|c: char| !c.is_ascii_digit() && c != '.').any(|part| {
        if oceanbase {
            part == boundary || part.starts_with("4.2.5.")
        } else {
            part.starts_with(boundary)
        }
    })
}

struct Session<'a> {
    client: &'a mut AgentDriverClient,
    database: &'a str,
    timeout: Option<Duration>,
    oceanbase: bool,
}

impl Session<'_> {
    async fn query(&mut self, sql: &str) -> Result<Vec<Value>, String> {
        let result = self
            .client
            .execute_query_with_timeout::<QueryResult>(
                json!({
                    "database": self.database, "sql": sql, "maxRows": 10001,
                    "timeoutSecs": self.timeout.map(|t| t.as_secs()).unwrap_or(0),
                }),
                self.timeout,
            )
            .await
            .map_err(|e| safe_error(&e))?;
        rows(result)
    }

    async fn require_current_owner(&mut self, owner: &str, original_error: String) -> Result<(), String> {
        let user = self.query("SELECT USER AS CURRENT_OWNER FROM DUAL").await?;
        if user.first().is_some_and(|row| text(row, "CURRENT_OWNER") == owner) {
            Ok(())
        } else {
            Err(original_error)
        }
    }

    fn jobs_view(&self) -> &'static str {
        if self.oceanbase {
            "DBA_SCHEDULER_JOBS"
        } else {
            "ALL_SCHEDULER_JOBS"
        }
    }

    async fn list(&mut self) -> Value {
        let columns = "OWNER, JOB_NAME, JOB_TYPE, ENABLED, STATE, REPEAT_INTERVAL, START_DATE, NEXT_RUN_DATE, LAST_START_DATE, RUN_COUNT, FAILURE_COUNT";
        let scheduler = match self.query(&format!("SELECT {columns} FROM {} ORDER BY OWNER, JOB_NAME", self.jobs_view())).await {
            Ok(rows) => json!({"availability":"available", "scope":"visible", "rows":rows}),
            Err(error) => match self.query("SELECT USER AS OWNER, JOB_NAME, JOB_TYPE, ENABLED, STATE, REPEAT_INTERVAL, START_DATE, NEXT_RUN_DATE, LAST_START_DATE, RUN_COUNT, FAILURE_COUNT FROM USER_SCHEDULER_JOBS ORDER BY JOB_NAME").await {
                Ok(rows) => json!({"availability":"available", "scope":"current-user-only", "warning":error, "rows":rows}),
                Err(error) => json!({"availability":availability(&error), "error":error, "rows":[]}),
            },
        };
        // Legacy jobs are visible separately, never relabelled as Scheduler jobs.
        let legacy = match self.query("SELECT LOG_USER AS OWNER, TO_CHAR(JOB) AS JOB_NAME, BROKEN, NEXT_DATE, LAST_DATE, FAILURES, INTERVAL FROM DBA_JOBS ORDER BY LOG_USER, JOB").await {
            Ok(rows) => json!({"availability":"available", "scope":"visible", "rows":rows}),
            Err(error) => match self.query("SELECT LOG_USER AS OWNER, TO_CHAR(JOB) AS JOB_NAME, BROKEN, NEXT_DATE, LAST_DATE, FAILURES, INTERVAL FROM USER_JOBS ORDER BY JOB").await {
                Ok(rows) => json!({"availability":"available", "scope":"current-user-only", "warning":error, "rows":rows}),
                Err(error) => json!({"availability":availability(&error), "error":error, "rows":[]}),
            },
        };
        json!({"scheduler":scheduler, "legacy":legacy})
    }

    async fn read(&mut self, id: &JobIdentity) -> Result<Value, String> {
        scheduler_name(id)?;
        let predicate = format!("OWNER = {} AND JOB_NAME = {}", literal(&id.owner), literal(&id.name));
        let columns = "OWNER, JOB_NAME, JOB_TYPE, JOB_ACTION, NUMBER_OF_ARGUMENTS, PROGRAM_OWNER, PROGRAM_NAME, SCHEDULE_OWNER, SCHEDULE_NAME, ENABLED, AUTO_DROP, STATE, TO_CHAR(START_DATE, 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS START_DATE, REPEAT_INTERVAL, TO_CHAR(END_DATE, 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS END_DATE, NEXT_RUN_DATE, LAST_START_DATE, RUN_COUNT, FAILURE_COUNT, DESTINATION, CREDENTIAL_NAME";
        let jobs = match self.query(&format!("SELECT {columns} FROM {} WHERE {predicate}", self.jobs_view())).await {
            Ok(rows) => rows,
            Err(error) => {
                self.require_current_owner(&id.owner, error).await?;
                self.query(&format!(
                    "SELECT {} FROM USER_SCHEDULER_JOBS WHERE USER = {} AND JOB_NAME = {}",
                    columns.replacen("OWNER,", "USER AS OWNER,", 1),
                    literal(&id.owner),
                    literal(&id.name)
                ))
                .await?
            }
        };
        if jobs.len() > 1 {
            return Err("Job identity is ambiguous".into());
        }
        let Some(job) = jobs.first() else {
            return Ok(json!({"job":null, "arguments":[], "argumentsAvailability":"available"}));
        };
        let args = if text(job, "NUMBER_OF_ARGUMENTS") == "0" {
            Ok(Vec::new())
        } else {
            self.query(&format!("SELECT ARGUMENT_POSITION, VALUE FROM ALL_SCHEDULER_JOB_ARGS WHERE {predicate} ORDER BY ARGUMENT_POSITION")).await
        };
        let history_sql = if self.oceanbase {
            format!("SELECT * FROM (SELECT LOG_DATE, STATUS, CODE AS ERROR_CODE, ACTUAL_START_DATE FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE {predicate} ORDER BY LOG_DATE DESC) WHERE ROWNUM <= 50")
        } else {
            format!("SELECT * FROM (SELECT LOG_DATE, STATUS, ERROR# AS ERROR_CODE, ACTUAL_START_DATE FROM ALL_SCHEDULER_JOB_RUN_DETAILS WHERE {predicate} ORDER BY LOG_DATE DESC) WHERE ROWNUM <= 50")
        };
        let history = match self.query(&history_sql).await {
            Ok(rows) => json!({"availability":"available", "rows":rows}),
            Err(error) => json!({"availability":availability(&error), "error":error, "rows":[]}),
        };
        Ok(match args {
            Ok(args) => json!({"job":job, "arguments":args, "argumentsAvailability":"available", "history":history}),
            Err(error) => {
                json!({"job":job, "arguments":[], "argumentsAvailability":availability(&error), "argumentsError":error, "history":history})
            }
        })
    }
}

fn revision(change: &JobChange, before: &Value) -> String {
    // Runtime counters/history must not invalidate a preview while a job runs.
    let mut definition = before["job"].clone();
    if let Some(object) = definition.as_object_mut() {
        for key in ["STATE", "NEXT_RUN_DATE", "LAST_START_DATE", "RUN_COUNT", "FAILURE_COUNT"] {
            object.remove(key);
        }
    }
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([change, definition, before["arguments"], before["argumentsAvailability"]]))
                .unwrap_or_default()
        )
    )
}

fn date_expression(value: &str, oceanbase: bool) -> Result<String, String> {
    if value.is_empty() {
        return Ok("NULL".into());
    }
    if chrono::DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S %:z").is_err() {
        return Err("Date must be YYYY-MM-DD HH:MM:SS +HH:MM".into());
    }
    let timestamp = format!("TO_TIMESTAMP_TZ({}, 'YYYY-MM-DD HH24:MI:SS TZH:TZM')", literal(value));
    // OB's overload takes TIMESTAMP_UNCONSTRAINED, so preserve the instant in
    // the database session zone rather than silently discarding the offset.
    Ok(if oceanbase { format!("CAST({timestamp} AT LOCAL AS TIMESTAMP)") } else { timestamp })
}

fn complete_arguments(before: &Value) -> bool {
    if before["argumentsAvailability"] != "available" {
        return false;
    }
    let Ok(count) = text(&before["job"], "NUMBER_OF_ARGUMENTS").parse::<usize>() else {
        return false;
    };
    let Some(args) = before["arguments"].as_array() else {
        return false;
    };
    count <= 255
        && args.len() == count
        && (1..=count).all(|position| {
            args.iter()
                .filter(|arg| text(arg, "ARGUMENT_POSITION") == position.to_string() && arg["VALUE"].is_string())
                .count()
                == 1
        })
}

fn build_plan(change: &JobChange, before: &Value, oceanbase: bool) -> Result<Vec<Step>, String> {
    let name = scheduler_name(&change.identity)?;
    let exists = !before["job"].is_null();
    if change.action == "create" && exists {
        return Err("Job already exists".into());
    }
    if change.action != "create" && !exists {
        return Err("Job no longer exists or is not visible".into());
    }
    let mut steps = Vec::new();
    let mut add = |label: &str, sql: String, preview: String| steps.push(Step { label: label.into(), sql, preview });
    match change.action.as_str() {
        "enable" | "disable" | "drop" => {
            if change.action == "enable" {
                let job = &before["job"];
                if !complete_arguments(before) {
                    return Err("Read the complete job arguments before enabling".into());
                }
                if !matches!(text(job, "JOB_TYPE").as_str(), "STORED_PROCEDURE" | "PLSQL_BLOCK")
                    || (oceanbase && text(job, "JOB_TYPE") != "STORED_PROCEDURE")
                    || ["PROGRAM_NAME", "SCHEDULE_NAME", "DESTINATION", "CREDENTIAL_NAME"]
                        .iter()
                        .any(|key| !text(job, key).is_empty())
                {
                    return Err(
                        "Enabling this job type or external definition is not supported by the local job editor".into(),
                    );
                }
            }
            let call = match change.action.as_str() {
                "enable" => format!("DBMS_SCHEDULER.ENABLE({name});"),
                "disable" => format!("DBMS_SCHEDULER.DISABLE({name}, force => FALSE);"),
                _ => format!("DBMS_SCHEDULER.DROP_JOB({name}, force => FALSE);"),
            };
            add(&change.action, format!("BEGIN {call} END;"), format!("BEGIN {call} END;"));
        }
        "create" | "update" => {
            let def = change.definition.as_ref().ok_or("Missing job definition")?;
            if !(def.job_type == "STORED_PROCEDURE" || (!oceanbase && def.job_type == "PLSQL_BLOCK")) {
                return Err("Unsupported local job type for this engine".into());
            }
            if def.job_action.trim().is_empty() || def.job_action.len() > 4000 || def.arguments.len() > 255 {
                return Err("Invalid job action or argument count".into());
            }
            if def.job_type == "PLSQL_BLOCK" && !def.arguments.is_empty() {
                return Err("PLSQL_BLOCK does not support arguments".into());
            }
            if oceanbase && def.repeat_interval.is_empty() {
                return Err("OceanBase requires a nonempty repeat interval".into());
            }
            let start = date_expression(&def.start_date, oceanbase)?;
            let end = date_expression(&def.end_date, oceanbase)?;
            let count_name = if oceanbase { "number_of_argument" } else { "number_of_arguments" };
            if change.action == "create" {
                let create = |action: String| {
                    format!("BEGIN DBMS_SCHEDULER.CREATE_JOB(job_name => {name}, job_type => {}, job_action => {action}, {count_name} => {}, start_date => {start}, repeat_interval => {}, end_date => {end}, enabled => FALSE, auto_drop => FALSE); END;", literal(&def.job_type), def.arguments.len(), literal(&def.repeat_interval))
                };
                add("create-disabled", create(literal(&def.job_action)), create("'<action omitted>'".into()));
            } else {
                let job = &before["job"];
                if ["PROGRAM_NAME", "SCHEDULE_NAME", "DESTINATION", "CREDENTIAL_NAME"]
                    .iter()
                    .any(|key| !text(job, key).is_empty())
                {
                    return Err(
                        "Named programs, named schedules and remote jobs cannot be rewritten by this local job editor"
                            .into(),
                    );
                }
                if text(job, "JOB_TYPE") != def.job_type {
                    return Err("Changing job type requires a separate new job".into());
                }
                if enabled(&job["ENABLED"]) != Some(false) {
                    return Err("Disable the job explicitly before editing its definition".into());
                }
                if !complete_arguments(before) {
                    return Err("Cannot edit when argument metadata is unavailable or incomplete".into());
                }
                if text(job, "NUMBER_OF_ARGUMENTS") != def.arguments.len().to_string() {
                    return Err("Argument count cannot be changed by this editor".into());
                }
                for (attribute, value, old) in [
                    ("job_action", def.job_action.as_str(), "JOB_ACTION"),
                    ("repeat_interval", def.repeat_interval.as_str(), "REPEAT_INTERVAL"),
                ] {
                    if text(job, old) != value {
                        if value.is_empty() && oceanbase {
                            return Err("OceanBase cannot clear this attribute".into());
                        }
                        let call = |value: String| {
                            format!("BEGIN DBMS_SCHEDULER.SET_ATTRIBUTE({name}, {}, {value}); END;", literal(attribute))
                        };
                        add(
                            attribute,
                            call(literal(value)),
                            call(if attribute == "job_action" { "'<action omitted>'".into() } else { literal(value) }),
                        );
                    }
                }
                for (attribute, value, expression, old) in
                    [("start_date", &def.start_date, start, "START_DATE"), ("end_date", &def.end_date, end, "END_DATE")]
                {
                    if text(job, old) != *value {
                        if value.is_empty() && oceanbase {
                            return Err("OceanBase SET_ATTRIBUTE cannot clear dates; preserve the date or set an explicit value".into());
                        }
                        let sql = if oceanbase {
                            format!("DECLARE v_format VARCHAR2(256); BEGIN SELECT VALUE INTO v_format FROM NLS_SESSION_PARAMETERS WHERE PARAMETER = 'NLS_TIMESTAMP_FORMAT'; DBMS_SCHEDULER.SET_ATTRIBUTE({name}, {}, TO_CHAR({expression}, v_format)); END;", literal(attribute))
                        } else if value.is_empty() {
                            format!("BEGIN DBMS_SCHEDULER.SET_ATTRIBUTE_NULL({name}, {}); END;", literal(attribute))
                        } else {
                            format!(
                                "BEGIN DBMS_SCHEDULER.SET_ATTRIBUTE({name}, {}, {expression}); END;",
                                literal(attribute)
                            )
                        };
                        add(attribute, sql.clone(), sql);
                    }
                }
            }
            for (index, value) in def.arguments.iter().enumerate() {
                let position = index + 1;
                if change.action == "update"
                    && before["arguments"].as_array().is_some_and(|args| {
                        args.iter().any(|arg| {
                            text(arg, "ARGUMENT_POSITION") == position.to_string() && text(arg, "VALUE") == *value
                        })
                    })
                {
                    continue;
                }
                let call = |value: String| {
                    format!("BEGIN DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE({name}, {position}, {value}); END;")
                };
                add(&format!("argument-{position}"), call(literal(value)), call("'<argument omitted>'".into()));
            }
        }
        _ => return Err("Unknown job action".into()),
    }
    if steps.is_empty() {
        return Err("No job changes to apply".into());
    }
    Ok(steps)
}

fn verified(change: &JobChange, after: &Value) -> bool {
    let job = &after["job"];
    match change.action.as_str() {
        "drop" => job.is_null(),
        "enable" => enabled(&job["ENABLED"]) == Some(true),
        "disable" => enabled(&job["ENABLED"]) == Some(false),
        "create" | "update" => change.definition.as_ref().is_some_and(|def| {
            !job.is_null()
                && enabled(&job["ENABLED"]) == Some(false)
                && text(job, "JOB_TYPE") == def.job_type
                && text(job, "JOB_ACTION") == def.job_action
                && text(job, "REPEAT_INTERVAL") == def.repeat_interval
                && (change.action != "create" || enabled(&job["AUTO_DROP"]) == Some(false))
                && same_date(&text(job, "START_DATE"), &def.start_date)
                && same_date(&text(job, "END_DATE"), &def.end_date)
                && complete_arguments(after)
                && after["arguments"].as_array().is_some_and(|args| {
                    args.len() == def.arguments.len()
                        && def.arguments.iter().enumerate().all(|(index, value)| {
                            args.iter().any(|arg| {
                                text(arg, "ARGUMENT_POSITION") == (index + 1).to_string()
                                    && text(arg, "VALUE") == *value
                            })
                        })
                })
        }),
        _ => false,
    }
}

fn same_date(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return a == b;
    }
    match (
        chrono::DateTime::parse_from_str(a, "%Y-%m-%d %H:%M:%S %:z"),
        chrono::DateTime::parse_from_str(b, "%Y-%m-%d %H:%M:%S %:z"),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub async fn oracle_jobs_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: OracleJobsRequest,
) -> Result<Value, String> {
    let config = connection_config(state, connection_id).await.ok_or("Connection not found")?;
    let oceanbase = match config.db_type {
        DatabaseType::OceanbaseOracle => true,
        DatabaseType::Oracle => false,
        _ => return Err("Job administration requires Oracle or OceanBase Oracle".into()),
    };
    if request.operation == "apply" && crate::query::connection_readonly_name(state, connection_id).await.is_some() {
        return Err("Connection is read-only".into());
    }
    let key = state
        .get_or_create_metadata_pool_for_session(connection_id, Some(database), None)
        .await
        .map_err(|e| safe_error(&e))?;
    let pool = state.pool_handle(&key).await;
    let Some(PoolKind::Agent(client)) = pool else {
        return Err("Job administration requires the Oracle-compatible Agent driver".into());
    };
    let mut client = lock_metadata_mutex_with_timeout(&client, METADATA_POOL_ACQUIRE_TIMEOUT).await?;
    let timeout = agent_metadata_timeout(Some(&config));
    let version = client
        .connection_info(timeout)
        .await
        .ok()
        .and_then(|info| info.database_info)
        .and_then(|info| info.product_version)
        .unwrap_or_default();
    let capability = json!({"engine":if oceanbase {"oceanbase-oracle"} else {"oracle"}, "version":version, "canManage":known_version(&version, oceanbase), "jobTypes":if oceanbase {vec!["STORED_PROCEDURE"]} else {vec!["STORED_PROCEDURE", "PLSQL_BLOCK"]}});
    let mut session = Session { client: &mut client, database, timeout, oceanbase };
    match request.operation.as_str() {
        "list" => {
            let mut result = session.list().await;
            result["capability"] = capability;
            Ok(result)
        }
        "read" => session.read(request.identity.as_ref().ok_or("Missing job identity")?).await,
        "readLegacy" => {
            let id = request.identity.as_ref().ok_or("Missing job identity")?;
            if id.name.is_empty() || !id.name.chars().all(|c| c.is_ascii_digit()) {
                return Err("Invalid legacy job ID".into());
            }
            let sql = format!("SELECT LOG_USER AS OWNER, TO_CHAR(JOB) AS JOB_NAME, WHAT, INTERVAL, BROKEN, NEXT_DATE, LAST_DATE, FAILURES FROM DBA_JOBS WHERE JOB = {} AND LOG_USER = {}", id.name, literal(&id.owner));
            let result = match session.query(&sql).await {
                Ok(rows) => rows,
                Err(error) => {
                    session.require_current_owner(&id.owner, error).await?;
                    session.query(&sql.replace("FROM DBA_JOBS", "FROM USER_JOBS")).await?
                }
            };
            Ok(json!({"legacy":result.first(), "readOnly":true}))
        }
        "preview" | "apply" => {
            if capability["canManage"] != true {
                return Err("This server version has not been verified for job management".into());
            }
            let change = request.change.as_ref().ok_or("Missing job change")?;
            let before = session.read(&change.identity).await?;
            let current_revision = revision(change, &before);
            let plan = build_plan(change, &before, oceanbase)?;
            if request.operation == "preview" {
                return Ok(
                    json!({"revision":current_revision, "steps":plan.iter().map(|s| json!({"label":s.label,"sql":s.preview})).collect::<Vec<_>>(), "before":before}),
                );
            }
            if request.revision.as_deref() != Some(&current_revision) {
                return Err("Job definition or plan changed; preview again before applying".into());
            }
            let mut executed = Vec::new();
            let mut attempted = Vec::new();
            let mut failure = None;
            for step in plan {
                attempted.push(step.label.clone());
                match session.query(&step.sql).await {
                    Ok(_) => executed.push(step.label),
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            let readback = session.read(&change.identity).await;
            let outcome = match &readback {
                Err(_) => "unverified",
                Ok(_) if failure.is_some() => {
                    if executed.is_empty() {
                        "failed"
                    } else {
                        "partial"
                    }
                }
                Ok(after) if verified(change, after) => "verified",
                Ok(after) if after["job"].is_null() => "disappeared",
                _ => "unverified",
            };
            Ok(
                json!({"outcome":outcome, "attemptedSteps":attempted, "executedSteps":executed, "error":failure, "readback":readback.as_ref().ok(), "readbackError":readback.as_ref().err(), "recoveryHint":"Refresh before any further action. Sent steps may have taken effect even when their response failed; Scheduler steps are not rolled back"}),
            )
        }
        _ => Err("Unknown job operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create(job_type: &str) -> JobChange {
        JobChange {
            action: "create".into(),
            identity: JobIdentity { owner: "Mixed Owner".into(), name: "night'load".into() },
            definition: Some(JobDefinition {
                job_type: job_type.into(),
                job_action: "APP.RUN_JOB".into(),
                arguments: vec![],
                start_date: "2026-10-10 00:00:00 +08:00".into(),
                repeat_interval: "FREQ=DAILY".into(),
                end_date: String::new(),
            }),
        }
    }
    #[test]
    fn create_is_disabled_and_uses_engine_specific_argument_name() {
        let change = create("STORED_PROCEDURE");
        let ob = build_plan(&change, &json!({"job":null}), true).unwrap();
        assert!(ob[0].sql.contains("number_of_argument => 0"));
        assert!(ob[0].sql.contains("enabled => FALSE, auto_drop => FALSE"));
        assert!(!ob.iter().any(|s| s.sql.contains(".ENABLE(")));
        let oracle = build_plan(&change, &json!({"job":null}), false).unwrap();
        assert!(oracle[0].sql.contains("number_of_arguments => 0"));
        assert!(oracle[0].sql.contains("\"Mixed Owner\".\"night''load\""));
    }
    #[test]
    fn type_and_argument_limits_follow_target_engine() {
        assert!(build_plan(&create("PLSQL_BLOCK"), &json!({"job":null}), true).is_err());
        assert!(build_plan(&create("PLSQL_BLOCK"), &json!({"job":null}), false).is_ok());
        let mut change = create("PLSQL_BLOCK");
        change.definition.as_mut().unwrap().arguments.push("secret".into());
        assert!(build_plan(&change, &json!({"job":null}), false).is_err());
    }
    #[test]
    fn preview_and_errors_do_not_leak_action_or_arguments() {
        let mut change = create("STORED_PROCEDURE");
        change.definition.as_mut().unwrap().job_action = "secret_action".into();
        change.definition.as_mut().unwrap().arguments = vec!["sensitive'value".into()];
        let plan = build_plan(&change, &json!({"job":null}), false).unwrap();
        assert!(plan.iter().all(|s| !s.preview.contains("secret_action") && !s.preview.contains("sensitive")));
        assert!(!safe_error("ORA-27486 secret_action sensitive'value").contains("secret_action"));
    }
    #[test]
    fn enable_and_drop_never_force_or_run_jobs() {
        let mut change = create("STORED_PROCEDURE");
        change.action = "drop".into();
        let plan = build_plan(&change, &json!({"job":{"ENABLED":"TRUE"}}), false).unwrap();
        assert!(plan[0].sql.contains("force => FALSE"));
        assert!(!plan[0].sql.contains("STOP_JOB"));
        assert!(!verified(&change, &json!({"job":{"JOB_NAME":"still exists"}})));
        assert!(verified(&change, &json!({"job":null})));
    }
    #[test]
    fn preview_revision_tracks_definition_but_not_running_counters() {
        let change = create("STORED_PROCEDURE");
        let before = json!({"job":{"JOB_ACTION":"a","RUN_COUNT":1},"arguments":[]});
        let mut after = before.clone();
        after["job"]["RUN_COUNT"] = json!(2);
        assert_eq!(revision(&change, &before), revision(&change, &after));
        after["job"]["JOB_ACTION"] = json!("b");
        assert_ne!(revision(&change, &before), revision(&change, &after));
    }
    #[test]
    fn unknown_versions_and_status_are_not_guessed() {
        assert!(known_version("OceanBase 4.2.5.7", true));
        assert!(!known_version("4.2.50", true));
        assert!(!known_version("unknown", false));
        assert_eq!(enabled(&Value::Null), None);
    }
    #[test]
    fn truncated_job_metadata_cannot_be_a_complete_snapshot() {
        let result: QueryResult = serde_json::from_value(
            json!({"columns":[],"rows":[],"affected_rows":0,"execution_time_ms":0,"truncated":true}),
        )
        .unwrap();
        assert!(rows(result).is_err());
    }
    #[test]
    fn unknown_or_duplicate_argument_values_are_not_complete() {
        let before = json!({"job":{"NUMBER_OF_ARGUMENTS":1},"argumentsAvailability":"available","arguments":[{"ARGUMENT_POSITION":1,"VALUE":null}]});
        assert!(!complete_arguments(&before));
        let valid = json!({"job":{"NUMBER_OF_ARGUMENTS":1},"argumentsAvailability":"available","arguments":[{"ARGUMENT_POSITION":1,"VALUE":"secret"}]});
        assert!(complete_arguments(&valid));
        assert!(!complete_arguments(&json!({"job":{},"argumentsAvailability":"available","arguments":[]})));
    }
    #[test]
    fn enable_rejects_unreadable_or_external_definitions() {
        let mut change = create("STORED_PROCEDURE");
        change.action = "enable".into();
        assert!(build_plan(
            &change,
            &json!({"job":{"JOB_TYPE":"STORED_PROCEDURE"},"argumentsAvailability":"denied"}),
            false
        )
        .is_err());
        let before = json!({"job":{"JOB_TYPE":"STORED_PROCEDURE","NUMBER_OF_ARGUMENTS":0,"DESTINATION":"remote"},"argumentsAvailability":"available","arguments":[]});
        assert!(build_plan(&change, &before, false).is_err());
    }
    #[test]
    fn a_created_auto_drop_job_is_not_verified_as_the_requested_retained_job() {
        let change = create("STORED_PROCEDURE");
        let after = json!({"job":{"JOB_TYPE":"STORED_PROCEDURE","JOB_ACTION":"APP.RUN_JOB","NUMBER_OF_ARGUMENTS":0,"REPEAT_INTERVAL":"FREQ=DAILY","START_DATE":"2026-10-10 00:00:00 +08:00","END_DATE":null,"ENABLED":"FALSE","AUTO_DROP":"TRUE"},"argumentsAvailability":"available","arguments":[]});
        assert!(!verified(&change, &after));
    }
}
