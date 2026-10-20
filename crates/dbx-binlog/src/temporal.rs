use mysql_common::value::Value;

use crate::{Cell, ValueKind};

fn fraction(microseconds: u32, precision: u8) -> Result<String, String> {
    if precision > 6 || microseconds >= 1_000_000 || !microseconds.is_multiple_of(10u32.pow(6 - precision as u32)) {
        return Err("temporal fractional precision mismatch".into());
    }
    if precision == 0 {
        Ok(String::new())
    } else {
        Ok(format!(".{:0width$}", microseconds / 10u32.pow(6 - precision as u32), width = precision as usize))
    }
}

pub(crate) fn convert(kind: &ValueKind, value: &Value) -> Result<Cell, String> {
    match (kind, value) {
        (ValueKind::DateTime { precision }, Value::Date(year, month, day, hour, minute, second, micros)) => {
            let leap = *year % 4 == 0 && (*year % 100 != 0 || *year % 400 == 0);
            let days = match month {
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                4 | 6 | 9 | 11 => 30,
                2 => {
                    if leap {
                        29
                    } else {
                        28
                    }
                }
                _ => 0,
            };
            if *year < 1000 || *year > 9999 || *day == 0 || *day > days || *hour > 23 || *minute > 59 || *second > 59 {
                return Err("zero or invalid historical DATETIME is not supported".into());
            }
            Ok(Cell::DateTime(format!(
                "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}{}",
                fraction(*micros, *precision)?
            )))
        }
        (ValueKind::Time { precision }, Value::Time(negative, days, hours, minutes, seconds, micros)) => {
            let hours = u64::from(*days) * 24 + u64::from(*hours);
            if hours > 838
                || *minutes > 59
                || *seconds > 59
                || hours == 838 && *minutes == 59 && *seconds == 59 && *micros != 0
            {
                return Err("invalid historical TIME".into());
            }
            Ok(Cell::Time(format!(
                "{}{hours:02}:{minutes:02}:{seconds:02}{}",
                if *negative { "-" } else { "" },
                fraction(*micros, *precision)?
            )))
        }
        (ValueKind::Timestamp { precision }, Value::Bytes(bytes)) => {
            let value = std::str::from_utf8(bytes).map_err(|_| "invalid TIMESTAMP bytes")?;
            let (whole, fract) = value.split_once('.').unwrap_or((value, ""));
            if whole.is_empty()
                || !whole.bytes().all(|b| b.is_ascii_digit())
                || !fract.bytes().all(|b| b.is_ascii_digit())
                || fract.len() > 6
            {
                return Err("invalid historical TIMESTAMP".into());
            }
            let epoch: u32 = whole.parse().map_err(|_| "TIMESTAMP epoch out of range")?;
            if epoch == 0 || epoch > 2_147_483_647 {
                return Err("zero or out-of-range TIMESTAMP is unsupported".into());
            }
            let micros = if fract.is_empty() {
                0
            } else {
                fract.parse::<u32>().map_err(|_| "invalid TIMESTAMP fraction")? * 10u32.pow(6 - fract.len() as u32)
            };
            Ok(Cell::Timestamp(format!("{epoch}{}", fraction(micros, *precision)?)))
        }
        _ => Err("invalid temporal row value".into()),
    }
}

pub(crate) fn valid_literal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit() || b"-: .".contains(&b))
}
