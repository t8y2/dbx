#![allow(clippy::items_after_test_module)]

use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, Offset, Utc};
use chrono_tz::Tz;
use duckdb::core::LogicalTypeId;
use duckdb::types::{TimeUnit, Value, ValueRef};

use crate::wire as db;

const MAX_ROWS: usize = 10000;

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duckdb_execute_preserves_double_precision() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT 12.34567::DOUBLE AS sample, 0.5::DOUBLE AS half, 99.99::DOUBLE AS price, 1.0::DOUBLE AS one",
        )
        .expect("execute double query");

        assert_eq!(result.columns, vec!["sample", "half", "price", "one"]);
        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!(12.34567));
        assert_eq!(row[1], serde_json::json!(0.5));
        assert_eq!(row[2], serde_json::json!(99.99));
        assert_eq!(row[3], serde_json::json!(1.0));
    }

    #[test]
    fn duckdb_execute_create_insert_select_double() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE tmp1 (tmp_double DOUBLE)").expect("create table");
        con.execute_batch("INSERT INTO tmp1 VALUES (45.678), (12.345), (99.999)").expect("insert");

        let result = duckdb_execute(&con, "SELECT tmp_double FROM tmp1 ORDER BY tmp_double").expect("select doubles");

        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[0][0], serde_json::json!(12.345));
        assert_eq!(result.rows[1][0], serde_json::json!(45.678));
        assert_eq!(result.rows[2][0], serde_json::json!(99.999));
    }

    #[test]
    fn duckdb_execute_returns_dml_returning_rows() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE users (id INTEGER, name VARCHAR)").expect("create table");

        let inserted =
            duckdb_execute(&con, "INSERT INTO users VALUES (1, 'Ada') RETURNING id, name").expect("insert returning");
        let updated = duckdb_execute(&con, "UPDATE users SET name = 'Ada Lovelace' RETURNING id, name")
            .expect("update returning");
        let deleted = duckdb_execute(&con, "DELETE FROM users RETURNING id, name").expect("delete returning");

        assert_eq!(inserted.rows, vec![vec![serde_json::json!(1), serde_json::json!("Ada")]]);
        assert_eq!(updated.rows, vec![vec![serde_json::json!(1), serde_json::json!("Ada Lovelace")]]);
        assert_eq!(deleted.rows, vec![vec![serde_json::json!(1), serde_json::json!("Ada Lovelace")]]);
    }

    #[test]
    fn duckdb_execute_returns_rows_for_from_first_query() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE users (id INTEGER, name VARCHAR)").expect("create table");
        con.execute_batch("INSERT INTO users VALUES (2, 'Grace'), (1, 'Ada')").expect("insert");

        let result = duckdb_execute(&con, "FROM users ORDER BY id").expect("execute from-first query");

        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0], vec![serde_json::json!(1), serde_json::json!("Ada")]);
        assert_eq!(result.rows[1], vec![serde_json::json!(2), serde_json::json!("Grace")]);
    }

    #[test]
    fn duckdb_execute_returns_rows_for_summarize_query() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("CREATE TABLE metrics (value INTEGER)").expect("create table");
        con.execute_batch("INSERT INTO metrics VALUES (1), (2), (NULL)").expect("insert");

        let result = duckdb_execute(&con, "SUMMARIZE metrics").expect("execute summarize query");

        assert!(!result.columns.is_empty());
        assert!(!result.rows.is_empty());
    }

    #[test]
    fn duckdb_execute_handles_various_types() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT 42 AS int_val, true AS bool_val, 'hello' AS text_val, 3.14::FLOAT AS float_val, 123456789012345::BIGINT AS big_val",
        )
        .expect("execute mixed types query");

        let row = &result.rows[0];
        assert_eq!(row[0], serde_json::json!(42));
        assert_eq!(row[1], serde_json::json!(true));
        assert_eq!(row[2], serde_json::Value::String("hello".to_string()));
        assert!(row[3].is_number());
        assert_eq!(row[4], serde_json::json!(123456789012345_i64));
    }

    #[test]
    fn duckdb_execute_returns_list_values_as_json_arrays() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(&con, "SELECT ['a','b','c','d'];").expect("execute list query");

        assert_eq!(result.rows, vec![vec![serde_json::json!(["a", "b", "c", "d"])]]);
    }

    #[test]
    fn duckdb_execute_preserves_nulls_inside_list_values() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(&con, "SELECT [1, NULL, 3] AS items;").expect("execute nullable list query");

        assert_eq!(result.columns, vec!["items"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!([1, null, 3])]]);
    }

    #[test]
    fn duckdb_execute_returns_nested_complex_values_as_json() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT {'name': 'Ada', 'scores': [10, 20]} AS profile, MAP(['x', 'y'], [1, 2]) AS lookup, [1, 2, 3]::INTEGER[3] AS fixed_items",
        )
        .expect("execute complex values query");

        assert_eq!(result.columns, vec!["profile", "lookup", "fixed_items"]);
        assert_eq!(
            result.rows,
            vec![vec![
                serde_json::json!({ "name": "Ada", "scores": [10, 20] }),
                serde_json::json!([
                    { "key": "x", "value": 1 },
                    { "key": "y", "value": 2 },
                ]),
                serde_json::json!([1, 2, 3]),
            ]]
        );
    }

    #[test]
    fn duckdb_execute_resolves_current_date_arithmetic() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");

        let result = duckdb_execute(&con, "SELECT CURRENT_DATE - 4 AS d").expect("execute CURRENT_DATE - literal");
        let expected = (Utc::now().date_naive() - ChronoDuration::days(4)).to_string();
        assert_eq!(result.rows[0][0], serde_json::Value::String(expected));

        con.execute_batch("CREATE VIEW recent AS SELECT CURRENT_DATE - 4 AS start_date, CURRENT_DATE - 1 AS end_date")
            .expect("create view using CURRENT_DATE arithmetic");
        let view_result =
            duckdb_execute(&con, "SELECT * FROM recent").expect("query view built on CURRENT_DATE arithmetic");
        assert_eq!(view_result.rows.len(), 1);
    }

    #[test]
    fn duckdb_execute_formats_temporal_values_by_column_type() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        let result = duckdb_execute(
            &con,
            "SELECT DATE '2026-05-14' AS d, TIME '16:58:15' AS t, TIMESTAMP '2026-05-14 16:58:15.0' AS ts, NULL::TIMESTAMP AS nts",
        )
        .expect("execute temporal query");

        assert_eq!(result.columns, vec!["d", "t", "ts", "nts"]);
        assert_eq!(
            result.rows,
            vec![vec![
                serde_json::Value::String("2026-05-14".to_string()),
                serde_json::Value::String("16:58:15".to_string()),
                serde_json::Value::String("2026-05-14 16:58:15".to_string()),
                serde_json::Value::Null,
            ]]
        );
    }

    #[test]
    fn duckdb_execute_preserves_timezone_marker_only_for_timestamptz() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("SET TimeZone = 'Asia/Shanghai'").expect("set session timezone");
        con.execute_batch("CREATE VIEW events AS SELECT TIMESTAMPTZ '2025-02-10 20:37:56+00' AS occurred_at")
            .expect("create view");

        let result = duckdb_execute(
            &con,
            "SELECT occurred_at, occurred_at::VARCHAR AS session_value, \
             TIMESTAMP '2025-02-10 20:37:56' AS naive_value, \
             NULL::TIMESTAMPTZ AS missing_value, \
             TIMESTAMPTZ '2025-02-10 20:37:56.123456+00' AS precise_value FROM events",
        )
        .expect("query view with temporal values");

        assert_eq!(result.rows[0][0], serde_json::json!("2025-02-11 04:37:56+08"));
        assert_eq!(result.rows[0][1], serde_json::json!("2025-02-11 04:37:56+08"));
        assert_eq!(result.rows[0][2], serde_json::json!("2025-02-10 20:37:56"));
        assert_eq!(result.rows[0][3], serde_json::Value::Null);
        assert_eq!(result.rows[0][4], serde_json::json!("2025-02-11 04:37:56.123456+08"));
    }

    #[test]
    fn duckdb_execute_uses_dst_offset_for_each_instant() {
        let con = duckdb::Connection::open_in_memory().expect("connect in-memory DuckDB");
        con.execute_batch("SET TimeZone = 'America/New_York'").expect("set session timezone");
        let result = duckdb_execute(
            &con,
            "SELECT TIMESTAMPTZ '2025-01-15 12:00:00+00' AS winter, TIMESTAMPTZ '2025-07-15 12:00:00+00' AS summer",
        )
        .expect("execute timestamptz query");

        assert_eq!(result.rows[0][0], serde_json::json!("2025-01-15 07:00:00-05"));
        assert_eq!(result.rows[0][1], serde_json::json!("2025-07-15 08:00:00-04"));
    }

    #[test]
    fn duckdb_session_timezone_accepts_fixed_offsets() {
        assert!(DuckDbSessionTimezone::parse("+08").is_some());
        assert!(DuckDbSessionTimezone::parse("-05:30").is_some());
        assert!(DuckDbSessionTimezone::parse("+24").is_none());
        assert_eq!(format_utc_offset(0), "+00");
        assert_eq!(format_utc_offset(8 * 3600), "+08");
        assert_eq!(format_utc_offset(-(5 * 3600 + 30 * 60)), "-05:30");
    }
}

#[cfg(test)]
pub fn duckdb_execute(con: &duckdb::Connection, sql: &str) -> Result<db::QueryResult, String> {
    duckdb_execute_with_max_rows(con, sql, None)
}

fn duckdb_value_to_json(
    row: &duckdb::Row<'_>,
    idx: usize,
    timestamptz: bool,
    session_timezone: Option<DuckDbSessionTimezone>,
) -> serde_json::Value {
    let Ok(value_ref) = row.get_ref(idx) else {
        return serde_json::Value::Null;
    };
    match value_ref {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Boolean(b) => serde_json::Value::Bool(b),
        ValueRef::TinyInt(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::SmallInt(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::Int(i) => serde_json::Value::Number((i as i64).into()),
        ValueRef::BigInt(i) => serde_json::Value::Number(i.into()),
        ValueRef::HugeInt(i) => serde_json::Value::String(i.to_string()),
        ValueRef::UTinyInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::USmallInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::UInt(i) => serde_json::Value::Number((i as u64).into()),
        ValueRef::UBigInt(i) => serde_json::Value::Number(i.into()),
        ValueRef::Float(f) => {
            serde_json::Number::from_f64(f as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Double(f) => {
            serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Decimal(d) => serde_json::Value::String(d.to_string()),
        ValueRef::Date32(days) => {
            duckdb_date32_to_string(days).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Time64(unit, value) => {
            duckdb_time64_to_string(unit, value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Timestamp(unit, value) => {
            let formatted = if timestamptz {
                duckdb_timestamptz_to_string(unit, value, session_timezone)
            } else {
                duckdb_timestamp_to_string(unit, value)
            };
            formatted.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(|s| serde_json::Value::String(s.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
            serde_json::Value::String(format!("\\x{hex}"))
        }
        ValueRef::Interval { months, days, nanos } => {
            serde_json::Value::String(duckdb_interval_to_string(months, days, nanos))
        }
        ValueRef::List(..)
        | ValueRef::Array(..)
        | ValueRef::Struct(..)
        | ValueRef::Map(..)
        | ValueRef::Enum(..)
        | ValueRef::Union(..) => duckdb_owned_value_to_json(&value_ref.to_owned()),
        _ => duckdb_owned_value_to_json(&value_ref.to_owned()),
    }
}

fn duckdb_owned_value_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(b) => serde_json::Value::Bool(*b),
        Value::TinyInt(i) => serde_json::Value::Number((*i as i64).into()),
        Value::SmallInt(i) => serde_json::Value::Number((*i as i64).into()),
        Value::Int(i) => serde_json::Value::Number((*i as i64).into()),
        Value::BigInt(i) => serde_json::Value::Number((*i).into()),
        Value::HugeInt(i) => serde_json::Value::String(i.to_string()),
        Value::UTinyInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::USmallInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::UInt(i) => serde_json::Value::Number((*i as u64).into()),
        Value::UBigInt(i) => serde_json::Value::Number((*i).into()),
        Value::Float(f) => {
            serde_json::Number::from_f64(*f as f64).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Value::Double(f) => {
            serde_json::Number::from_f64(*f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        Value::Decimal(d) => serde_json::Value::String(d.to_string()),
        Value::Timestamp(unit, value) => {
            duckdb_timestamp_to_string(*unit, *value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Text(text) | Value::Enum(text) => serde_json::Value::String(text.clone()),
        Value::Blob(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
            serde_json::Value::String(format!("\\x{hex}"))
        }
        Value::Date32(days) => {
            duckdb_date32_to_string(*days).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Time64(unit, value) => {
            duckdb_time64_to_string(*unit, *value).map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
        }
        Value::Interval { months, days, nanos } => {
            serde_json::Value::String(duckdb_interval_to_string(*months, *days, *nanos))
        }
        Value::List(values) | Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(duckdb_owned_value_to_json).collect())
        }
        Value::Struct(entries) => serde_json::Value::Object(
            entries.iter().map(|(key, value)| (key.clone(), duckdb_owned_value_to_json(value))).collect(),
        ),
        Value::Map(entries) => serde_json::Value::Array(
            entries
                .iter()
                .map(|(key, value)| {
                    serde_json::json!({
                        "key": duckdb_owned_value_to_json(key),
                        "value": duckdb_owned_value_to_json(value),
                    })
                })
                .collect(),
        ),
        Value::Union(value) => duckdb_owned_value_to_json(value),
        _ => serde_json::Value::Null,
    }
}

fn duckdb_interval_to_string(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = Vec::new();
    if months != 0 {
        let years = months / 12;
        let rem = months % 12;
        if years != 0 {
            parts.push(format!("{} year{}", years, if years.abs() != 1 { "s" } else { "" }));
        }
        if rem != 0 {
            parts.push(format!("{} mon{}", rem, if rem.abs() != 1 { "s" } else { "" }));
        }
    }
    if days != 0 {
        parts.push(format!("{} day{}", days, if days.abs() != 1 { "s" } else { "" }));
    }
    if nanos != 0 {
        let total_secs = nanos / 1_000_000_000;
        let hours = total_secs / 3600;
        let mins = (total_secs % 3600) / 60;
        let secs = total_secs % 60;
        let sub_nanos = (nanos % 1_000_000_000).unsigned_abs();
        if sub_nanos > 0 {
            parts.push(format!(
                "{:02}:{:02}:{:02}.{}",
                hours,
                mins,
                secs,
                format_temporal_without_empty_fraction(format!("0.{:09}", sub_nanos)).trim_start_matches("0.")
            ));
        } else {
            parts.push(format!("{:02}:{:02}:{:02}", hours, mins, secs));
        }
    }
    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}

fn duckdb_date32_to_string(days: i32) -> Option<String> {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    epoch.checked_add_signed(ChronoDuration::days(i64::from(days))).map(|date| date.to_string())
}

fn duckdb_time64_to_string(unit: TimeUnit, value: i64) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    if !(0..86_400).contains(&seconds) {
        return None;
    }
    let time = NaiveTime::from_num_seconds_from_midnight_opt(seconds as u32, nanos_remainder)?;
    Some(format_temporal_without_empty_fraction(time.to_string()))
}

#[derive(Clone, Copy)]
enum DuckDbSessionTimezone {
    Zone(Tz),
    Fixed(FixedOffset),
}

impl DuckDbSessionTimezone {
    fn parse(name: &str) -> Option<Self> {
        let name = name.trim();
        if let Ok(zone) = name.parse::<Tz>() {
            return Some(Self::Zone(zone));
        }
        parse_fixed_utc_offset(name).map(Self::Fixed)
    }

    fn to_local(self, instant: DateTime<Utc>) -> (NaiveDateTime, i32) {
        match self {
            Self::Zone(zone) => {
                let local = instant.with_timezone(&zone);
                (local.naive_local(), local.offset().fix().local_minus_utc())
            }
            Self::Fixed(offset) => {
                let local = instant.with_timezone(&offset);
                (local.naive_local(), local.offset().fix().local_minus_utc())
            }
        }
    }
}

fn parse_fixed_utc_offset(value: &str) -> Option<FixedOffset> {
    let (sign, rest) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => return None,
    };
    let (hours, minutes) = match rest.split_once(':') {
        Some((hours, minutes)) => (hours.parse::<i32>().ok()?, minutes.parse::<i32>().ok()?),
        None if rest.len() == 4 => (rest[..2].parse::<i32>().ok()?, rest[2..].parse::<i32>().ok()?),
        None if rest.len() <= 2 => (rest.parse::<i32>().ok()?, 0),
        None => return None,
    };
    if !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))
}

fn duckdb_session_timezone(con: &duckdb::Connection) -> Option<DuckDbSessionTimezone> {
    let name: String = con.query_row("SELECT current_setting('TimeZone')", [], |row| row.get(0)).ok()?;
    DuckDbSessionTimezone::parse(&name)
}

fn duckdb_timestamptz_to_string(
    unit: TimeUnit,
    value: i64,
    session_timezone: Option<DuckDbSessionTimezone>,
) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    let instant: DateTime<Utc> = DateTime::from_timestamp(seconds, nanos_remainder)?;
    Some(match session_timezone {
        Some(session_timezone) => {
            let (local, offset_seconds) = session_timezone.to_local(instant);
            format!("{}{}", format_naive_datetime(local), format_utc_offset(offset_seconds))
        }
        None => format!("{}+00", format_naive_datetime(instant.naive_utc())),
    })
}

fn format_utc_offset(offset_seconds: i32) -> String {
    let sign = if offset_seconds < 0 { '-' } else { '+' };
    let total_minutes = offset_seconds.unsigned_abs() / 60;
    let (hours, minutes) = (total_minutes / 60, total_minutes % 60);
    if minutes == 0 {
        format!("{sign}{hours:02}")
    } else {
        format!("{sign}{hours:02}:{minutes:02}")
    }
}

fn duckdb_timestamp_to_string(unit: TimeUnit, value: i64) -> Option<String> {
    let nanos = duckdb_time_unit_to_nanos(unit, value)?;
    let seconds = nanos.div_euclid(1_000_000_000);
    let nanos_remainder = nanos.rem_euclid(1_000_000_000) as u32;
    let dt: DateTime<Utc> = DateTime::from_timestamp(seconds, nanos_remainder)?;
    Some(format_naive_datetime(dt.naive_utc()))
}

fn duckdb_time_unit_to_nanos(unit: TimeUnit, value: i64) -> Option<i64> {
    match unit {
        TimeUnit::Second => value.checked_mul(1_000_000_000),
        TimeUnit::Millisecond => value.checked_mul(1_000_000),
        TimeUnit::Microsecond => value.checked_mul(1_000),
        TimeUnit::Nanosecond => Some(value),
    }
}

fn format_naive_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        format_temporal_without_empty_fraction(value.to_string())
    }
}

fn format_temporal_without_empty_fraction(value: String) -> String {
    if !value.contains('.') {
        return value;
    }
    let trimmed = value.trim_end_matches('0').trim_end_matches('.');
    trimmed.to_string()
}

pub fn duckdb_execute_with_max_rows(
    con: &duckdb::Connection,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    let start = std::time::Instant::now();
    let row_limit = query_result_row_limit(max_rows);
    let sql = crate::sql::rewrite_duckdb_current_date_literal_arithmetic(sql);
    let sql = sql.as_ref();

    if crate::sql::starts_with_duckdb_result_sql_keyword(sql) {
        // DuckDB cannot answer another query while a result set is being streamed.
        let session_timezone = duckdb_session_timezone(con);
        let mut stmt = con.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let stmt_ref = rows.as_ref().ok_or("DuckDB statement unavailable")?;
        let col_count = stmt_ref.column_count();
        let columns: Vec<String> = (0..col_count)
            .map(|i| stmt_ref.column_name(i).map(|s| s.to_string()).unwrap_or_else(|_| "?".to_string()))
            .collect();
        let timestamptz_columns: Vec<bool> =
            (0..col_count).map(|i| stmt_ref.column_logical_type(i).id() == LogicalTypeId::TimestampTZ).collect();

        let mut result_rows = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let vals: Vec<serde_json::Value> = (0..col_count)
                .map(|i| duckdb_value_to_json(row, i, timestamptz_columns[i], session_timezone))
                .collect();
            result_rows.push(vals);
            if result_rows.len() > row_limit {
                break;
            }
        }

        let truncated = result_rows.len() > row_limit;
        if truncated {
            result_rows.truncate(row_limit);
        }
        Ok(db::QueryResult {
            columns,
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: result_rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        })
    } else {
        let affected = con.execute(sql, []).map_err(|e| e.to_string())?;
        Ok(db::QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: affected as u64,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
        })
    }
}
pub(crate) fn duckdb_execute_for_database(
    con: &duckdb::Connection,
    attached_names: &[String],
    database: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    if let Some(database) = database.map(str::trim).filter(|database| !database.is_empty()) {
        let catalog = if database == "main" {
            crate::schema::duckdb_primary_catalog(con, attached_names)?
        } else {
            database.to_string()
        };
        con.execute_batch(&format!("USE {}", duckdb_quote_ident(&catalog))).map_err(|e| e.to_string())?;
    }
    duckdb_execute_with_max_rows(con, sql, max_rows)
}

fn duckdb_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
