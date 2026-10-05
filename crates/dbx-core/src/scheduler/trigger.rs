//! Task triggers: manual / once / interval / cron / startup.
//!
//! Every trigger funnels into `next_after(last_fire) -> Option<DateTime<Utc>>`.
//! Storage and engine only ever deal with UTC; the IANA time zone lives on the
//! trigger so display layers can render local wall-clock times.

use chrono::{DateTime, Datelike, Duration, LocalResult, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use super::TaskError;

const CRON_MAX_SCAN_DAYS: i64 = 1461; // 4 years: covers February 29 cycles.
const DST_GAP_SCAN_MINUTES: u32 = 180;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskTrigger {
    Manual,
    Once { at: String, time_zone: String },
    Interval { seconds: u64 },
    Cron { expression: String, time_zone: String },
    Startup,
}

impl TaskTrigger {
    /// Short machine kind used for audit metadata and task identity.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Once { .. } => "once",
            Self::Interval { .. } => "interval",
            Self::Cron { .. } => "cron",
            Self::Startup => "startup",
        }
    }

    pub fn validate(&self) -> Result<(), TaskError> {
        match self {
            Self::Manual | Self::Startup => Ok(()),
            Self::Once { at, time_zone } => {
                parse_zone(time_zone)?;
                parse_once_at(at, time_zone)?;
                Ok(())
            }
            Self::Interval { seconds } => {
                if *seconds == 0 || *seconds > 86_400 * 366 {
                    return Err(TaskError::invalid_config("Interval trigger seconds are out of range"));
                }
                Ok(())
            }
            Self::Cron { expression, time_zone } => {
                parse_zone(time_zone)?;
                parse_cron(expression)?;
                Ok(())
            }
        }
    }

    /// Next UTC fire instant strictly after `after`, or `None` when the
    /// trigger never fires again on its own (manual, startup, elapsed once).
    pub fn next_after(&self, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, TaskError> {
        match self {
            Self::Manual | Self::Startup => Ok(None),
            Self::Once { at, time_zone } => {
                let at = parse_once_at(at, time_zone)?;
                Ok((at > after).then_some(at))
            }
            Self::Interval { seconds } => Ok(Some(after + Duration::seconds(*seconds as i64))),
            Self::Cron { expression, time_zone } => cron_next_after(expression, time_zone, after).map(Some),
        }
    }
}

fn parse_zone(name: &str) -> Result<Tz, TaskError> {
    name.parse::<Tz>().map_err(|_| TaskError::invalid_config(format!("Invalid IANA time zone: {name}")))
}

fn parse_once_at(at: &str, zone: &str) -> Result<DateTime<Utc>, TaskError> {
    let tz = parse_zone(zone)?;
    if let Ok(value) = DateTime::parse_from_rfc3339(at) {
        return Ok(value.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(at, format) {
            return match tz.from_local_datetime(&naive) {
                LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
                // A repeated fall-back time runs at its first occurrence.
                LocalResult::Ambiguous(first, _) => Ok(first.with_timezone(&Utc)),
                LocalResult::None => {
                    Err(TaskError::invalid_config(format!("Once trigger time {at} does not exist in {zone}")))
                }
            };
        }
    }
    Err(TaskError::invalid_config(format!("Invalid once trigger time: {at}")))
}

/// Resolves a local wall-clock time in `tz`, never repeating an ambiguous
/// (fall-back) instant and running a nonexistent (spring-forward) instant at
/// the first valid minute after the gap.
fn resolve_local(tz: Tz, date: chrono::NaiveDate, time: chrono::NaiveTime) -> Option<DateTime<Utc>> {
    for offset in 0..DST_GAP_SCAN_MINUTES {
        let local = date.and_time(time) + Duration::minutes(offset as i64);
        if let Some(value) = match tz.from_local_datetime(&local) {
            LocalResult::Single(value) => Some(value),
            LocalResult::Ambiguous(first, _) => Some(first),
            LocalResult::None => None,
        } {
            return Some(value.with_timezone(&Utc));
        }
    }
    None
}

fn cron_next_after(expression: &str, zone: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>, TaskError> {
    let tz = parse_zone(zone)?;
    let fields = parse_cron(expression)?;
    let start = after.with_timezone(&tz);
    let start_date = start.date_naive();
    for day_offset in 0..CRON_MAX_SCAN_DAYS {
        let date = start_date + Duration::days(day_offset);
        if !fields.months.contains(&date.month()) {
            continue;
        }
        if !fields.matches_day(date) {
            continue;
        }
        let same_start_day = date == start_date;
        for &hour in &fields.hours {
            if same_start_day && hour < start.hour() {
                continue;
            }
            for &minute in &fields.minutes {
                if same_start_day && hour == start.hour() && minute <= start.minute() {
                    continue;
                }
                let time = chrono::NaiveTime::from_hms_opt(hour, minute, 0)
                    .ok_or_else(|| TaskError::invalid_config("Invalid cron time"))?;
                if let Some(candidate) = resolve_local(tz, date, time) {
                    if candidate > after {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err(TaskError::internal(format!("Cron {expression} has no fire time within {CRON_MAX_SCAN_DAYS} days")))
}

#[derive(Debug, Clone)]
struct CronFields {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Option<Vec<u32>>,
    months: Vec<u32>,
    days_of_week: Option<Vec<u32>>,
}

impl CronFields {
    /// Vixie-cron day matching: when both day-of-month and day-of-week are
    /// restricted, a day matches if *either* field matches.
    fn matches_day(&self, date: chrono::NaiveDate) -> bool {
        let dom = self.days_of_month.as_ref().map(|values| values.contains(&date.day()));
        let dow = self.days_of_week.as_ref().map(|values| values.contains(&date.weekday().num_days_from_sunday()));
        match (dom, dow) {
            (Some(dom), Some(dow)) => dom || dow,
            (Some(dom), None) => dom,
            (None, Some(dow)) => dow,
            (None, None) => true,
        }
    }
}

const MONTH_NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn parse_cron(expression: &str) -> Result<CronFields, TaskError> {
    let parts: Vec<&str> = expression.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(TaskError::invalid_config(format!(
            "Cron expression must have 5 fields (minute hour day month weekday): {expression}"
        )));
    }
    let minutes = parse_cron_field(parts[0], 0, 59, None)?;
    let hours = parse_cron_field(parts[1], 0, 23, None)?;
    let days_of_month = parse_cron_field(parts[2], 1, 31, None)?;
    let months = parse_cron_field(parts[3], 1, 12, Some(&MONTH_NAMES))?;
    let days_of_week = parse_cron_field(parts[4], 0, 7, Some(&WEEKDAY_NAMES))?;
    // 7 is an alias for Sunday in the weekday field.
    let mut days_of_week: Vec<u32> = days_of_week.iter().map(|value| value % 7).collect();
    days_of_week.sort_unstable();
    days_of_week.dedup();
    // A field that covers every value is "unrestricted" for day matching.
    let days_of_month = (days_of_month.len() < 31).then_some(days_of_month);
    let days_of_week = (days_of_week.len() < 7).then_some(days_of_week);
    Ok(CronFields { minutes, hours, days_of_month, months, days_of_week })
}

fn parse_cron_field(field: &str, min: u32, max: u32, names: Option<&[&str]>) -> Result<Vec<u32>, TaskError> {
    let mut values = Vec::new();
    for term in field.split(',') {
        let (range_part, step) = match term.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().map_err(|_| invalid_cron(field))?),
            None => (term, 1),
        };
        if step == 0 {
            return Err(invalid_cron(field));
        }
        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((from, to)) = range_part.split_once('-') {
            (parse_cron_value(from, min, max, names)?, parse_cron_value(to, min, max, names)?)
        } else {
            let value = parse_cron_value(range_part, min, max, names)?;
            if step > 1 {
                (value, max)
            } else {
                (value, value)
            }
        };
        if start > end || end > max {
            return Err(invalid_cron(field));
        }
        let mut value = start;
        while value <= end {
            values.push(value);
            value += step;
        }
    }
    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(invalid_cron(field));
    }
    Ok(values)
}

fn parse_cron_value(value: &str, min: u32, max: u32, names: Option<&[&str]>) -> Result<u32, TaskError> {
    let numeric = if let Ok(number) = value.parse::<u32>() {
        number
    } else if let Some(names) = names {
        let lowered = value.to_ascii_lowercase();
        names
            .iter()
            .position(|name| *name == lowered)
            .map(|index| index as u32 + if max == 12 { 1 } else { 0 })
            .ok_or_else(|| invalid_cron(value))?
    } else {
        return Err(invalid_cron(value));
    };
    if numeric < min || numeric > max {
        return Err(invalid_cron(value));
    }
    Ok(numeric)
}

fn invalid_cron(value: &str) -> TaskError {
    TaskError::invalid_config(format!("Invalid cron field: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(value: &str) -> DateTime<Utc> {
        value.parse().unwrap()
    }

    #[test]
    fn interval_adds_elapsed_time() {
        let trigger = TaskTrigger::Interval { seconds: 90 };
        assert_eq!(trigger.next_after(utc("2026-10-05T00:00:00Z")).unwrap(), Some(utc("2026-10-05T00:01:30Z")));
    }

    #[test]
    fn once_only_fires_while_in_the_future() {
        let trigger = TaskTrigger::Once { at: "2026-10-06T08:30:00".into(), time_zone: "Asia/Shanghai".into() };
        assert_eq!(trigger.next_after(utc("2026-10-05T00:00:00Z")).unwrap(), Some(utc("2026-10-06T00:30:00Z")));
        assert_eq!(trigger.next_after(utc("2026-10-06T00:30:00Z")).unwrap(), None);
    }

    #[test]
    fn manual_and_startup_never_fire_on_a_schedule() {
        assert_eq!(TaskTrigger::Manual.next_after(Utc::now()).unwrap(), None);
        assert_eq!(TaskTrigger::Startup.next_after(Utc::now()).unwrap(), None);
    }
}
