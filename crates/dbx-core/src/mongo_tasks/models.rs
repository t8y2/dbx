use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MongoTaskStep {
    pub name: String,
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// find = JSON filter object; aggregate = JSON pipeline array.
    pub kind: String,
    pub query: Value,
    pub max_rows: usize,
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MongoTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Fixed elapsed-time interval, independent of local clock/timezone/DST.
    pub interval_minutes: u32,
    pub steps: Vec<MongoTaskStep>,
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub next_run_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoStepResult {
    pub name: String,
    pub returned_rows: usize,
    /// A bounded preview, never the complete source collection or an export.
    pub sample: Vec<Value>,
    pub sample_truncated: bool,
    pub row_limit_reached: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoTaskRun {
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub trigger: String,
    pub status: String,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub results: Vec<MongoStepResult>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoTaskSnapshot {
    pub tasks: Vec<MongoTask>,
    pub runs: Vec<MongoTaskRun>,
    pub heartbeat: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    pub task: MongoTask,
    pub run: MongoTaskRun,
}

/// Deliberately fail closed: no server-side JS, persistent output, change streams,
/// unknown future stages, commands, or arbitrary shell text in unattended jobs.
fn safe_expression(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 64 { return Err("Task query nesting exceeds 64 levels".into()); }
    match value {
        Value::Object(object) => for (key, value) in object {
            if matches!(key.as_str(), "$out" | "$merge" | "$where" | "$function" | "$accumulator" | "$changeStream" | "$changeStreamSplitLargeEvent") {
                return Err(format!("{key} is not permitted in read-only Mongo tasks; use the manual preview/confirmation workflow"));
            }
            safe_expression(value, depth + 1)?;
        },
        Value::Array(values) => for value in values { safe_expression(value, depth + 1)?; },
        _ => {}
    }
    Ok(())
}

fn validate_pipeline(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 16 { return Err("Task pipeline nesting exceeds 16 levels".into()); }
    let pipeline = value.as_array().ok_or("Aggregation must be a JSON array")?;
    if pipeline.len() > 100 { return Err("At most 100 stages per pipeline".into()); }
    for stage in pipeline {
        let object = stage.as_object().filter(|o| o.len() == 1).ok_or("Each aggregation stage must have exactly one operator")?;
        let (operator, body) = object.iter().next().ok_or("Empty stage")?;
        if !matches!(operator.as_str(), "$match" | "$project" | "$set" | "$addFields" | "$unset" | "$group" | "$sort" | "$limit" | "$skip" | "$unwind" | "$count" | "$replaceRoot" | "$replaceWith" | "$sample" | "$sortByCount" | "$bucket" | "$bucketAuto" | "$facet" | "$lookup" | "$unionWith" | "$setWindowFields" | "$densify" | "$fill") {
            return Err(format!("Aggregation stage {operator} is not supported by read-only tasks"));
        }
        if operator == "$facet" {
            for nested in body.as_object().ok_or("$facet requires an object")?.values() { validate_pipeline(nested, depth + 1)?; }
        } else if matches!(operator.as_str(), "$lookup" | "$unionWith") {
            if let Some(nested) = body.get("pipeline") { validate_pipeline(nested, depth + 1)?; }
        }
    }
    Ok(())
}

impl MongoTaskStep {
    pub(crate) fn validate(&self) -> Result<(), String> {
        for (label, value) in [("Step name", &self.name), ("Connection", &self.connection_id), ("Database", &self.database), ("Collection", &self.collection)] {
            if value.trim().is_empty() || value.len() > 256 || value.contains('\0') { return Err(format!("{label} must contain 1–256 characters without NUL")); }
        }
        if !(1..=1000).contains(&self.max_rows) { return Err("Step row limit must be 1–1000".into()); }
        if !(1..=300).contains(&self.timeout_seconds) { return Err("Step timeout must be 1–300 seconds".into()); }
        if serde_json::to_vec(&self.query).map_err(|e| e.to_string())?.len() > 65536 { return Err("Step query exceeds 64 KiB".into()); }
        safe_expression(&self.query, 0)?;
        match self.kind.as_str() {
            "find" if self.query.is_object() => Ok(()),
            "aggregate" => validate_pipeline(&self.query, 0),
            _ => Err("Only find (JSON object) and aggregate (JSON array) are supported; write steps are never scheduled".into()),
        }
    }

    pub(crate) fn pipeline(&self) -> Result<String, String> {
        self.validate()?;
        let mut stages = if self.kind == "find" { vec![serde_json::json!({"$match": self.query})] } else { self.query.as_array().ok_or("Pipeline must be an array")?.clone() };
        stages.push(serde_json::json!({"$limit": self.max_rows}));
        serde_json::to_string(&stages).map_err(|e| e.to_string())
    }
}

impl MongoTask {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 80 || !self.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("Invalid task ID".into()); }
        if self.name.trim().is_empty() || self.name.len() > 200 { return Err("Task name must contain 1–200 characters".into()); }
        if !(1..=525600).contains(&self.interval_minutes) { return Err("Interval must be 1–525600 minutes".into()); }
        if self.steps.is_empty() || self.steps.len() > 20 { return Err("A task requires 1–20 steps".into()); }
        if serde_json::to_vec(&self.steps).map_err(|e| e.to_string())?.len() > 262144 { return Err("Task steps exceed 256 KiB".into()); }
        for step in &self.steps { step.validate()?; }
        Ok(())
    }
}
