use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

pub const DEFAULT_DIRECTORY: &str = "dbx-backup__{schedule}__{timestamp}__{runId}";
pub const DEFAULT_FILE: &str = "dbx-backup__{schedule}__{timestamp}__{database}__{runId}";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub connection_id: String,
    #[serde(default)]
    pub databases: Vec<String>,
    #[serde(default = "all")]
    pub table_filter_mode: String,
    #[serde(default)]
    pub table_patterns: Vec<String>,
    pub destination_directory: String,
    pub include_structure: bool,
    pub include_data: bool,
    pub include_objects: bool,
    #[serde(default)]
    pub drop_table_if_exists: bool,
    #[serde(default = "none")]
    pub output_compression: String,
    #[serde(default)]
    pub file_name_pattern: Option<String>,
}

fn all() -> String {
    "all".into()
}
fn none() -> String {
    "none".into()
}
fn utc() -> String {
    "UTC".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSchedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(flatten)]
    pub config: BackupConfig,
    pub frequency: String,
    pub interval_hours: u32,
    pub time_of_day: String,
    pub weekday: u32,
    pub retention_count: usize,
    #[serde(default)]
    pub run_directory_pattern: Option<String>,
    #[serde(default = "utc")]
    pub time_zone: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub next_run_at: String,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_run_status: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub database: String,
    pub schema: String,
    pub display_name: String,
    pub file_path: String,
    #[serde(default = "owned_by_legacy_run")]
    pub owned: bool,
}

fn owned_by_legacy_run() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRun {
    pub id: String,
    #[serde(default)]
    pub schedule_id: Option<String>,
    pub schedule_name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub connection_id: String,
    pub connection_name: String,
    #[serde(default)]
    pub destination_directory: String,
    pub trigger: String,
    pub source: String,
    pub status: String,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub files: Vec<BackupFile>,
    #[serde(default)]
    pub progress_percent: f64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub schedule_id: Option<String>,
    pub config: Option<BackupConfig>,
    pub display_name: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Job {
    pub run: BackupRun,
    pub config: BackupConfig,
    pub directory_pattern: Option<String>,
    pub time_zone: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Migration {
    #[serde(default)]
    pub schedules: Vec<BackupSchedule>,
    #[serde(default)]
    pub runs: Vec<BackupRun>,
}

impl BackupConfig {
    pub fn validate(&self) -> Result<(), String> {
        bounded_text(&self.connection_id, 256, "Connection")?;
        bounded_text(&self.destination_directory, 4096, "Backup directory")?;
        if !std::path::Path::new(&self.destination_directory).is_absolute() {
            return Err("Backup directory must be absolute".into());
        }
        if !self.include_structure && !self.include_data && !self.include_objects {
            return Err("Select backup contents".into());
        }
        if !matches!(self.output_compression.as_str(), "none" | "gzip") {
            return Err("Unsupported backup compression".into());
        }
        if !matches!(self.table_filter_mode.as_str(), "all" | "include" | "exclude") {
            return Err("Unsupported backup table filter".into());
        }
        if self.databases.len() > 10_000 || self.table_patterns.len() > 1000 {
            return Err("Too many backup targets or patterns".into());
        }
        for value in self.databases.iter().chain(self.table_patterns.iter()) {
            bounded_text(value, 1024, "Backup target")?;
        }
        if self.table_filter_mode != "all" && self.table_patterns.is_empty() {
            return Err("Select backup table patterns".into());
        }
        validate_template(self.file_name_pattern.as_deref().unwrap_or(DEFAULT_FILE), false)
    }
}

impl BackupSchedule {
    pub fn validate(&self) -> Result<(), String> {
        self.config.validate()?;
        bounded_text(&self.id, 256, "Schedule ID")?;
        bounded_text(&self.name, 256, "Schedule name")?;
        if !matches!(self.frequency.as_str(), "hourly" | "daily" | "weekly")
            || !(1..=168).contains(&self.interval_hours)
            || self.weekday > 6
            || !(1..=100).contains(&self.retention_count)
        {
            return Err("Invalid backup schedule".into());
        }
        NaiveTime::parse_from_str(&self.time_of_day, "%H:%M").map_err(|_| "Invalid backup time")?;
        self.time_zone.parse::<Tz>().map_err(|_| "Invalid backup time zone")?;
        validate_template(self.run_directory_pattern.as_deref().unwrap_or(DEFAULT_DIRECTORY), true)
    }

    pub fn next_after(&self, after: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
        if self.frequency == "hourly" {
            return Ok(after + Duration::hours(self.interval_hours.clamp(1, 168) as i64));
        }
        let tz: Tz = self.time_zone.parse().map_err(|_| "Invalid backup time zone")?;
        let time = NaiveTime::parse_from_str(&self.time_of_day, "%H:%M").map_err(|_| "Invalid backup time")?;
        let today = after.with_timezone(&tz).date_naive();
        for offset in 0..15 {
            let date = today + Duration::days(offset);
            if self.frequency == "weekly" && date.weekday().num_days_from_sunday() != self.weekday {
                continue;
            }
            // A repeated wall-clock time runs only at its first occurrence.
            // A nonexistent spring-forward time runs at the first valid minute after the gap.
            for minute in 0..180 {
                let local = date.and_time(time) + Duration::minutes(minute);
                let candidate = match tz.from_local_datetime(&local) {
                    LocalResult::Single(value) => Some(value),
                    LocalResult::Ambiguous(first, _) => Some(first),
                    LocalResult::None => None,
                };
                if let Some(value) = candidate {
                    if value.with_timezone(&Utc) > after {
                        return Ok(value.with_timezone(&Utc));
                    }
                    break;
                }
            }
        }
        Err("Unable to calculate next backup time".into())
    }
}

pub(crate) fn bounded_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err(format!("Invalid {label}"))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_template(value: &str, directory: bool) -> Result<(), String> {
    bounded_text(value, 1024, "backup name template")?;
    if directory {
        let drive_prefix = value.as_bytes().get(1) == Some(&b':') && value.as_bytes()[0].is_ascii_alphabetic();
        if value.starts_with(['/', '\\'])
            || value.ends_with(['/', '\\'])
            || drive_prefix
            || value.split(['/', '\\']).any(|part| part == "." || part == "..")
        {
            return Err("Invalid backup directory template".into());
        }
        return Ok(());
    }
    if value.trim() != value
        || value.starts_with(['/', '\\'])
        || value.ends_with(['/', '\\', '.', ' '])
        || value.contains([':', '*', '?', '"', '<', '>', '|'])
        || (!directory && value.contains(['/', '\\']))
        || value.split(['/', '\\']).any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid backup name template".into());
    }
    Ok(())
}

pub(crate) fn segment(value: &str) -> String {
    let cleaned: String =
        value.chars().map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let name = if cleaned.is_empty() { "database" } else { cleaned };
    let first = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if matches!(first.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (first.len() == 4
            && (first.starts_with("COM") || first.starts_with("LPT"))
            && matches!(first.as_bytes()[3], b'1'..=b'9'))
    {
        format!("{name}_")
    } else {
        name.into()
    }
}

pub(crate) fn render_template(
    template: &str,
    run: &BackupRun,
    database: &str,
    time_zone: &str,
    directory: bool,
) -> Result<String, String> {
    validate_template(template, directory)?;
    let tz: Tz = time_zone.parse().map_err(|_| "Invalid backup time zone")?;
    let started =
        DateTime::parse_from_rfc3339(&run.started_at).map_err(|_| "Invalid backup start time")?.with_timezone(&tz);
    let timestamp = started.format(if directory { "%Y%m%d%H%M%S" } else { "%Y%m%d-%H%M%S" }).to_string();
    let rendered = template
        .replace("{schedule}", &segment(&run.schedule_name))
        .replace("{date}", &started.format("%Y%m%d").to_string())
        .replace("{timestamp}", &timestamp)
        .replace("{runId}", &run.id.chars().take(8).collect::<String>());
    if directory {
        Ok(rendered.split(['/', '\\']).filter(|part| !part.is_empty()).map(segment).collect::<Vec<_>>().join("/"))
    } else if template.contains("{database}") {
        Ok(segment(&rendered.replace("{database}", &segment(database))))
    } else {
        Ok(format!("{}__{}", segment(&rendered), segment(database)))
    }
}

pub(crate) fn matches_pattern(pattern: &str, table: &str, database: &str, schema: &str, sensitive: bool) -> bool {
    let expression = format!("^{}$", regex::escape(pattern).replace("\\*", ".*").replace("\\?", "."));
    regex::RegexBuilder::new(&expression).case_insensitive(!sensitive).build().is_ok_and(|re| {
        re.is_match(table)
            || (!schema.is_empty() && re.is_match(&format!("{schema}.{table}")))
            || (!database.is_empty() && !schema.is_empty() && re.is_match(&format!("{database}.{schema}.{table}")))
    })
}
