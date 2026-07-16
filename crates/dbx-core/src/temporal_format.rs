use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::Value;
use std::fmt::Write as _;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemporalKind {
    Date,
    Time,
    DateTime,
    DateTimeWithTimeZone,
}

enum ParsedTemporal {
    Zoned(DateTime<FixedOffset>),
    DateTime(NaiveDateTime),
    Date(NaiveDate),
    Time(NaiveTime),
}

fn temporal_kind(data_type: Option<&str>) -> Option<TemporalKind> {
    let normalized = data_type?.trim().to_ascii_lowercase().replace(char::is_whitespace, " ");
    let base = normalized.split(['(', ':', ' ']).next().unwrap_or("");
    if matches!(base, "datetimeoffset" | "datetimeoffsetn" | "timestamptz")
        || (base == "timestamp"
            && (normalized.contains("with time zone") || normalized.contains("with local time zone")))
    {
        return Some(TemporalKind::DateTimeWithTimeZone);
    }
    match base {
        "date" | "date32" | "daten" => Some(TemporalKind::Date),
        "time" | "time64" | "timen" | "timetz" => Some(TemporalKind::Time),
        "datetime" | "datetime2" | "datetime4" | "datetime64" | "datetimen" | "smalldatetime" | "timestamp"
        | "timestampdty" => Some(TemporalKind::DateTime),
        _ if base.starts_with("timestamp_") => Some(TemporalKind::DateTime),
        _ => None,
    }
}

fn dayjs_to_chrono_pattern(pattern: &str) -> Option<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.len() > 100 || pattern.contains('%') {
        return None;
    }
    let tokens = [
        ("YYYY", "%Y"),
        ("SSS", "%3f"),
        ("ZZ", "%z"),
        ("MM", "%m"),
        ("DD", "%d"),
        ("HH", "%H"),
        ("mm", "%M"),
        ("ss", "%S"),
        ("M", "%-m"),
        ("D", "%-d"),
        ("H", "%-H"),
        ("m", "%-M"),
        ("s", "%-S"),
        ("Z", "%:z"),
    ];
    let mut output = String::with_capacity(pattern.len() * 2);
    let mut index = 0;
    while index < pattern.len() {
        let remaining = &pattern[index..];
        if remaining.starts_with('[') {
            let close = remaining.find(']')?;
            output.push_str(&remaining[1..close]);
            index += close + 1;
            continue;
        }
        if let Some((token, replacement)) = tokens.iter().find(|(token, _)| remaining.starts_with(token)) {
            output.push_str(replacement);
            index += token.len();
            continue;
        }
        let ch = remaining.chars().next()?;
        // Reject unknown Day.js tokens instead of silently exporting different text than the frontend displays.
        if ch.is_ascii_alphabetic() {
            return None;
        }
        output.push(ch);
        index += ch.len_utf8();
    }
    Some(output)
}

fn parse_with_pattern(value: &str, pattern: &str) -> Option<ParsedTemporal> {
    let pattern = dayjs_to_chrono_pattern(pattern)?;
    DateTime::parse_from_str(value, &pattern)
        .map(ParsedTemporal::Zoned)
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(value, &pattern).map(ParsedTemporal::DateTime).ok())
        .or_else(|| NaiveDate::parse_from_str(value, &pattern).map(ParsedTemporal::Date).ok())
        .or_else(|| NaiveTime::parse_from_str(value, &pattern).map(ParsedTemporal::Time).ok())
}

fn parse_known_temporal(value: &str) -> Option<ParsedTemporal> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(ParsedTemporal::Zoned(parsed));
    }
    for pattern in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y/%m/%d %H:%M:%S%.f", "%Y/%m/%dT%H:%M:%S%.f"] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(value, pattern) {
            return Some(ParsedTemporal::DateTime(parsed));
        }
    }
    for pattern in ["%Y-%m-%d", "%Y/%m/%d"] {
        if let Ok(parsed) = NaiveDate::parse_from_str(value, pattern) {
            return Some(ParsedTemporal::Date(parsed));
        }
    }
    for pattern in ["%H:%M:%S%.f", "%H:%M:%S"] {
        if let Ok(parsed) = NaiveTime::parse_from_str(value, pattern) {
            return Some(ParsedTemporal::Time(parsed));
        }
    }
    None
}

fn parse_temporal(value: &str, preferred_pattern: Option<&str>) -> Option<ParsedTemporal> {
    preferred_pattern
        .filter(|pattern| !pattern.trim().is_empty())
        .and_then(|pattern| parse_with_pattern(value, pattern))
        .or_else(|| parse_known_temporal(value))
}

fn format_parsed(parsed: ParsedTemporal, pattern: &str) -> Option<String> {
    let pattern = dayjs_to_chrono_pattern(pattern)?;
    let mut output = String::new();
    // Chrono reports missing date/time fields through fmt::Error; propagate it so exports preserve the raw value.
    match parsed {
        ParsedTemporal::Zoned(value) => write!(&mut output, "{}", value.format(&pattern)),
        ParsedTemporal::DateTime(value) => write!(&mut output, "{}", value.format(&pattern)),
        ParsedTemporal::Date(value) => write!(&mut output, "{}", value.format(&pattern)),
        ParsedTemporal::Time(value) => write!(&mut output, "{}", value.format(&pattern)),
    }
    .ok()?;
    Some(output)
}

pub fn format_temporal_export_value(value: &Value, data_type: Option<&str>, pattern: Option<&str>) -> Value {
    let Some(pattern) = pattern.filter(|pattern| !pattern.trim().is_empty()) else {
        return value.clone();
    };
    if temporal_kind(data_type).is_none() {
        return value.clone();
    }
    let Some(raw) = value.as_str() else {
        return value.clone();
    };
    parse_known_temporal(raw)
        .and_then(|parsed| format_parsed(parsed, pattern))
        .map(Value::String)
        .unwrap_or_else(|| value.clone())
}

pub fn format_temporal_export_row(row: &[Value], column_types: &[Option<String>], pattern: Option<&str>) -> Vec<Value> {
    row.iter()
        .enumerate()
        .map(|(index, value)| {
            format_temporal_export_value(
                value,
                column_types.get(index).and_then(|data_type| data_type.as_deref()),
                pattern,
            )
        })
        .collect()
}

pub fn format_temporal_export_rows(
    rows: &[Vec<Value>],
    column_types: &[Option<String>],
    pattern: Option<&str>,
) -> Vec<Vec<Value>> {
    rows.iter().map(|row| format_temporal_export_row(row, column_types, pattern)).collect()
}

pub fn format_temporal_export_row_with_string_types(
    row: &[Value],
    column_types: &[String],
    pattern: Option<&str>,
) -> Vec<Value> {
    row.iter()
        .enumerate()
        .map(|(index, value)| format_temporal_export_value(value, column_types.get(index).map(String::as_str), pattern))
        .collect()
}

pub fn format_temporal_export_rows_with_string_types(
    rows: &[Vec<Value>],
    column_types: &[String],
    pattern: Option<&str>,
) -> Vec<Vec<Value>> {
    rows.iter().map(|row| format_temporal_export_row_with_string_types(row, column_types, pattern)).collect()
}

pub fn normalize_temporal_import_value(value: &Value, data_type: Option<&str>, pattern: Option<&str>) -> Value {
    let Some(kind) = temporal_kind(data_type) else {
        return value.clone();
    };
    let Some(raw) = value.as_str() else {
        return value.clone();
    };
    let Some(parsed) = parse_temporal(raw.trim(), pattern) else {
        return value.clone();
    };

    let normalized = match (kind, parsed) {
        (TemporalKind::Date, ParsedTemporal::Zoned(value)) => value.date_naive().format("%Y-%m-%d").to_string(),
        (TemporalKind::Date, ParsedTemporal::DateTime(value)) => value.date().format("%Y-%m-%d").to_string(),
        (TemporalKind::Date, ParsedTemporal::Date(value)) => value.format("%Y-%m-%d").to_string(),
        (TemporalKind::Date, ParsedTemporal::Time(_)) => return value.clone(),
        (TemporalKind::Time, ParsedTemporal::Zoned(value)) => value.time().format("%H:%M:%S%.f").to_string(),
        (TemporalKind::Time, ParsedTemporal::DateTime(value)) => value.time().format("%H:%M:%S%.f").to_string(),
        (TemporalKind::Time, ParsedTemporal::Time(value)) => value.format("%H:%M:%S%.f").to_string(),
        (TemporalKind::Time, ParsedTemporal::Date(_)) => return value.clone(),
        (TemporalKind::DateTime, ParsedTemporal::Zoned(value)) => {
            value.naive_local().format("%Y-%m-%d %H:%M:%S%.f").to_string()
        }
        (TemporalKind::DateTime, ParsedTemporal::DateTime(value)) => value.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        (TemporalKind::DateTime, ParsedTemporal::Date(date)) => {
            let Some(value) = date.and_hms_opt(0, 0, 0) else {
                return value.clone();
            };
            value.format("%Y-%m-%d %H:%M:%S").to_string()
        }
        (TemporalKind::DateTime, ParsedTemporal::Time(_)) => return value.clone(),
        (TemporalKind::DateTimeWithTimeZone, ParsedTemporal::Zoned(value)) => {
            value.format("%Y-%m-%dT%H:%M:%S%.f%:z").to_string()
        }
        (TemporalKind::DateTimeWithTimeZone, ParsedTemporal::DateTime(value)) => {
            value.format("%Y-%m-%d %H:%M:%S%.f").to_string()
        }
        (TemporalKind::DateTimeWithTimeZone, ParsedTemporal::Date(date)) => {
            let Some(value) = date.and_hms_opt(0, 0, 0) else {
                return value.clone();
            };
            value.format("%Y-%m-%d %H:%M:%S").to_string()
        }
        (TemporalKind::DateTimeWithTimeZone, ParsedTemporal::Time(_)) => return value.clone(),
    };
    Value::String(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_unpadded_slash_dates_for_import() {
        assert_eq!(
            normalize_temporal_import_value(&json!("2024/2/25 13:02:15"), Some("DATE"), None),
            json!("2024-02-25")
        );
        assert_eq!(
            normalize_temporal_import_value(
                &json!("25.02.2024 13:02:15"),
                Some("TIMESTAMP(6)"),
                Some("DD.MM.YYYY HH:mm:ss")
            ),
            json!("2024-02-25 13:02:15")
        );
    }

    #[test]
    fn formats_only_typed_temporal_export_values() {
        let row = vec![json!(1), json!("2024-02-25 13:02:15"), json!("2024-02-25 13:02:15")];
        assert_eq!(
            format_temporal_export_row(
                &row,
                &[Some("NUMBER".into()), Some("TIMESTAMP".into()), Some("VARCHAR2".into())],
                Some("YYYY/M/D HH:mm:ss")
            ),
            vec![json!(1), json!("2024/2/25 13:02:15"), json!("2024-02-25 13:02:15")]
        );
    }

    #[test]
    fn preserves_raw_export_values_when_pattern_requires_missing_fields() {
        assert_eq!(
            format_temporal_export_value(&json!("2024-02-25"), Some("DATE"), Some("YYYY-MM-DD HH:mm:ss")),
            json!("2024-02-25")
        );
        assert_eq!(
            format_temporal_export_value(&json!("13:02:15"), Some("TIME"), Some("YYYY-MM-DD HH:mm:ss")),
            json!("13:02:15")
        );
    }

    #[test]
    fn rejects_unsupported_dayjs_tokens_but_allows_literal_text() {
        assert_eq!(dayjs_to_chrono_pattern("MM/DD/YYYY hh:mm A"), None);
        assert_eq!(dayjs_to_chrono_pattern("YYYY-MM-DD [at] HH:mm:ss"), Some("%Y-%m-%d at %H:%M:%S".into()));
    }

    #[test]
    fn recognizes_common_driver_temporal_type_aliases() {
        for data_type in ["DateTime64(3)", "date32", "timestamp_ns", "TimeStampDTY", "datetimeoffsetn", "timen"] {
            assert!(temporal_kind(Some(data_type)).is_some(), "{data_type}");
        }
    }

    #[test]
    fn export_formatting_preserves_offset_datetime_fields() {
        assert_eq!(
            format_temporal_export_value(&json!("2024-02-25T13:02:15Z"), Some("DATE"), Some("YYYY/M/D HH:mm:ss")),
            json!("2024/2/25 13:02:15")
        );
    }

    #[test]
    fn import_normalization_preserves_timezone_offsets() {
        assert_eq!(
            normalize_temporal_import_value(
                &json!("2024-02-25T13:02:15+08:00"),
                Some("timestamp with time zone"),
                None
            ),
            json!("2024-02-25T13:02:15+08:00")
        );
    }
}
