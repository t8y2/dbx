#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SqlServerTemporalKind {
    Date,
    Time { scale: u8 },
    SmallDateTime,
    DateTime,
    DateTime2 { scale: u8 },
    DateTimeOffset { scale: u8 },
}

pub fn format_sqlserver_datetime_display(value: &chrono::NaiveDateTime) -> String {
    let rounded = value.checked_add_signed(chrono::Duration::microseconds(500)).unwrap_or(*value);
    let base = rounded.format("%Y-%m-%d %H:%M:%S").to_string();
    let millis = rounded.and_utc().timestamp_subsec_millis();
    if millis == 0 {
        base
    } else {
        format!("{base}.{millis:03}")
    }
}

pub fn normalize_sqlserver_temporal_literal(value: &str, column_type: Option<&str>) -> Option<String> {
    let kind = sqlserver_temporal_kind(column_type?)?;
    let parts = parse_sqlserver_temporal(value)?;
    match kind {
        SqlServerTemporalKind::Date => Some(parts.date),
        SqlServerTemporalKind::Time { scale } => Some(format_sqlserver_time_text(&parts.time, scale)),
        SqlServerTemporalKind::SmallDateTime => {
            Some(format!("{} {}", parts.date, format_sqlserver_time_text(&parts.time, 0)))
        }
        SqlServerTemporalKind::DateTime => Some(format_sqlserver_datetime_parts(&parts.date, &parts.time)),
        SqlServerTemporalKind::DateTime2 { scale } => {
            Some(format!("{} {}", parts.date, format_sqlserver_time_text(&parts.time, scale)))
        }
        SqlServerTemporalKind::DateTimeOffset { scale } => {
            let offset = parts.offset?;
            Some(format!("{} {}{}", parts.date, format_sqlserver_time_text(&parts.time, scale), offset))
        }
    }
}

fn sqlserver_temporal_kind(column_type: &str) -> Option<SqlServerTemporalKind> {
    let lower = column_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ' ', '\t', '\n']).next().unwrap_or("");
    match base {
        "date" | "daten" => Some(SqlServerTemporalKind::Date),
        "smalldatetime" => Some(SqlServerTemporalKind::SmallDateTime),
        "datetime" | "datetimen" => Some(SqlServerTemporalKind::DateTime),
        "datetime4" => Some(SqlServerTemporalKind::SmallDateTime),
        "datetime2" => Some(SqlServerTemporalKind::DateTime2 { scale: temporal_scale(&lower).unwrap_or(7) }),
        "time" | "timen" => Some(SqlServerTemporalKind::Time { scale: temporal_scale(&lower).unwrap_or(7) }),
        "datetimeoffset" | "datetimeoffsetn" => {
            Some(SqlServerTemporalKind::DateTimeOffset { scale: temporal_scale(&lower).unwrap_or(7) })
        }
        _ => None,
    }
}

fn temporal_scale(column_type: &str) -> Option<u8> {
    let start = column_type.find('(')?;
    let end = column_type[start + 1..].find(')')? + start + 1;
    let scale = column_type[start + 1..end].trim().parse::<u8>().ok()?;
    Some(scale.min(7))
}

struct SqlServerTemporalParts {
    date: String,
    time: String,
    offset: Option<String>,
}

fn parse_sqlserver_temporal(value: &str) -> Option<SqlServerTemporalParts> {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 10 && is_date_prefix(bytes) {
        let date = trimmed[..10].to_string();
        let mut rest = trimmed[10..].trim_start();
        if rest.starts_with('T') || rest.starts_with('t') {
            rest = rest[1..].trim_start();
        }
        if rest.is_empty() {
            return Some(SqlServerTemporalParts { date, time: "00:00:00".to_string(), offset: None });
        }
        let (time, offset) = split_time_and_offset(rest)?;
        return Some(SqlServerTemporalParts { date, time, offset });
    }

    let (time, offset) = split_time_and_offset(trimmed)?;
    Some(SqlServerTemporalParts { date: "1900-01-01".to_string(), time, offset })
}

fn is_date_prefix(bytes: &[u8]) -> bool {
    bytes.len() >= 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn split_time_and_offset(value: &str) -> Option<(String, Option<String>)> {
    if value.len() < 8 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.get(2) != Some(&b':') || bytes.get(5) != Some(&b':') {
        return None;
    }
    if !bytes[0..2].iter().all(u8::is_ascii_digit)
        || !bytes[3..5].iter().all(u8::is_ascii_digit)
        || !bytes[6..8].iter().all(u8::is_ascii_digit)
    {
        return None;
    }

    let mut end = 8;
    if bytes.get(end) == Some(&b'.') {
        end += 1;
        let fraction_start = end;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == fraction_start {
            return None;
        }
    }

    let time = value[..end].to_string();
    let suffix = value[end..].trim();
    if suffix.is_empty() {
        return Some((time, None));
    }
    if suffix.eq_ignore_ascii_case("z") {
        return Some((time, Some("+00:00".to_string())));
    }
    if is_timezone_offset(suffix) {
        return Some((time, Some(suffix.to_string())));
    }
    None
}

fn is_timezone_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6
        && matches!(bytes[0], b'+' | b'-')
        && bytes[3] == b':'
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_digit()
}

fn format_sqlserver_time_text(value: &str, scale: u8) -> String {
    let (base, fraction) = value.split_once('.').unwrap_or((value, ""));
    if scale == 0 {
        return base.to_string();
    }
    let mut digits = fraction.chars().take_while(|ch| ch.is_ascii_digit()).take(scale as usize).collect::<String>();
    while digits.len() < scale as usize {
        digits.push('0');
    }
    if digits.chars().all(|ch| ch == '0') {
        base.to_string()
    } else {
        format!("{base}.{digits}")
    }
}

fn format_sqlserver_datetime_parts(date: &str, time: &str) -> String {
    let value = format!("{date} {time}");
    chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%d %H:%M:%S%.f")
        .map(|value| format_sqlserver_datetime_display(&value))
        .unwrap_or_else(|_| format!("{date} {}", format_sqlserver_time_text(time, 3)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_sqlserver_datetime_display_with_millisecond_precision() {
        let value =
            chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap().and_hms_nano_opt(10, 11, 12, 896_666_666).unwrap();

        assert_eq!(format_sqlserver_datetime_display(&value), "2026-06-29 10:11:12.897");

        let boundary =
            chrono::NaiveDate::from_ymd_opt(2026, 6, 29).unwrap().and_hms_nano_opt(23, 59, 59, 999_600_000).unwrap();
        assert_eq!(format_sqlserver_datetime_display(&boundary), "2026-06-30 00:00:00");
    }

    #[test]
    fn normalizes_sqlserver_datetime_literals_by_column_type() {
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29 10:11:12.896666666", Some("datetime")),
            Some("2026-06-29 10:11:12.897".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29T10:11:12.8966666Z", Some("datetime2(7)")),
            Some("2026-06-29 10:11:12.8966666".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29T10:11:12.8966666Z", Some("datetime2(3)")),
            Some("2026-06-29 10:11:12.896".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29 10:11:12.8966666+08:00", Some("datetimeoffset(4)")),
            Some("2026-06-29 10:11:12.8966+08:00".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("10:11:12.8966666", Some("time(2)")),
            Some("10:11:12.89".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29 10:11:12.8966666", Some("date")),
            Some("2026-06-29".to_string())
        );
        assert_eq!(
            normalize_sqlserver_temporal_literal("2026-06-29 10:11:12.8966666", Some("smalldatetime")),
            Some("2026-06-29 10:11:12".to_string())
        );
    }
}
