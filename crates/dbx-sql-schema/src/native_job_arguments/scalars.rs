use super::{ArgumentExpectation, ScalarType};
use dbx_sql_core::value_literals::quote_string_literal;
use serde_json::{json, Value};

const INVALID: &str = "native_job_argument_value_invalid";
const NANOS: i128 = 1_000_000_000;
const DAY_NANOS: i128 = 86_400 * NANOS;

fn integer(value: &str) -> Result<i128, &'static str> {
    let unsigned = value.strip_prefix(['-', '+']).unwrap_or(value);
    if unsigned.is_empty() || !unsigned.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(INVALID);
    }
    value.parse().map_err(|_| INVALID)
}

fn decimal_nanos(value: &str) -> Result<i128, &'static str> {
    let negative = value.starts_with('-');
    let unsigned = value.strip_prefix(['-', '+']).unwrap_or(value);
    let mut pieces = unsigned.split('.');
    let whole = pieces.next().ok_or(INVALID)?;
    let fraction = pieces.next().unwrap_or("");
    if pieces.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > 9
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(INVALID);
    }
    let whole = integer(whole)?;
    let fraction = if fraction.is_empty() { 0 } else { integer(fraction)? * 10_i128.pow(9 - fraction.len() as u32) };
    let nanos = whole.checked_mul(NANOS).and_then(|whole| whole.checked_add(fraction)).ok_or(INVALID)?;
    Ok(if negative { -nanos } else { nanos })
}

fn seconds(nanos: i128) -> String {
    let sign = if nanos < 0 { "-" } else { "" };
    let nanos = nanos.abs();
    if nanos % NANOS == 0 {
        return format!("{sign}{}", nanos / NANOS);
    }
    format!("{sign}{}.{:09}", nanos / NANOS, nanos % NANOS).trim_end_matches('0').into()
}

fn normalized_hex(value: &str, bytes: Option<usize>) -> Result<String, &'static str> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || value.len() > 65_534
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || bytes.is_some_and(|bytes| value.len() != bytes * 2)
    {
        return Err(INVALID);
    }
    Ok(value.to_ascii_uppercase())
}

fn raw_expression(hex: &str) -> String {
    let mut chunks = hex
        .as_bytes()
        .chunks(4_000)
        .map(|chunk| format!("HEXTORAW('{}')", std::str::from_utf8(chunk).expect("validated ASCII hex")));
    let first = chunks.next().expect("nonempty RAW");
    chunks.fold(first, |value, chunk| format!("SYS.UTL_RAW.CONCAT({value}, {chunk})"))
}

fn date_value(kind: ScalarType, value: &Value) -> Result<Value, &'static str> {
    let object = value.as_object().ok_or(INVALID)?;
    if object.len() != if kind == ScalarType::TimestampTz { 5 } else { 2 } {
        return Err(INVALID);
    }
    let day = integer(object.get("day").and_then(Value::as_str).ok_or(INVALID)?)?;
    let nanos = decimal_nanos(object.get("seconds").and_then(Value::as_str).ok_or(INVALID)?)?;
    if !(1..=5_373_484).contains(&day)
        || !(0..DAY_NANOS).contains(&nanos)
        || (kind == ScalarType::Date && nanos % NANOS != 0)
    {
        return Err(INVALID);
    }
    let mut result = json!({"day":day.to_string(), "seconds":seconds(nanos)});
    if kind == ScalarType::TimestampTz {
        let offset = object.get("offset").and_then(Value::as_str).ok_or(INVALID)?;
        let bytes = offset.as_bytes();
        if bytes.len() != 6
            || !matches!(bytes[0], b'+' | b'-')
            || bytes[3] != b':'
            || ![bytes[1], bytes[2], bytes[4], bytes[5]].iter().all(u8::is_ascii_digit)
        {
            return Err(INVALID);
        }
        let hours = i32::from(bytes[1] - b'0') * 10 + i32::from(bytes[2] - b'0');
        let minutes = i32::from(bytes[4] - b'0') * 10 + i32::from(bytes[5] - b'0');
        if minutes > 59 || hours * 60 + minutes > if bytes[0] == b'-' { 720 } else { 840 } {
            return Err(INVALID);
        }
        let region = object.get("region").and_then(Value::as_str).ok_or(INVALID)?;
        if region.is_empty()
            || region.len() > 128
            || !region.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_/-+.:".contains(&byte))
        {
            return Err(INVALID);
        }
        let abbreviation = object.get("abbreviation").ok_or(INVALID)?;
        if !abbreviation.is_null()
            && !abbreviation.as_str().is_some_and(|text| {
                !text.is_empty()
                    && text.len() <= 64
                    && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_+-".contains(&byte))
            })
        {
            return Err(INVALID);
        }
        result["region"] = json!(region);
        result["offset"] = json!(offset);
        result["abbreviation"] = abbreviation.clone();
    }
    Ok(result)
}

pub(super) fn normalize(kind: ScalarType, value: &Value) -> Result<Value, &'static str> {
    Ok(match kind {
        ScalarType::Number => json!(super::normalize_number(value.as_str().ok_or(INVALID)?)?),
        ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampTz | ScalarType::TimestampLtz => {
            date_value(kind, value)?
        }
        ScalarType::IntervalYm | ScalarType::IntervalDs => {
            let total = integer(value.as_str().ok_or(INVALID)?)?;
            let max = if kind == ScalarType::IntervalYm { 11_999_999_999 } else { 1_000_000_000 * DAY_NANOS - 1 };
            if !(-max..=max).contains(&total) {
                return Err(INVALID);
            }
            json!(total.to_string())
        }
        ScalarType::Raw => json!(normalized_hex(value.as_str().ok_or(INVALID)?, None)?),
        ScalarType::BinaryFloat | ScalarType::BinaryDouble => {
            let text = normalized_hex(
                value.as_str().ok_or(INVALID)?,
                Some(if kind == ScalarType::BinaryFloat { 4 } else { 8 }),
            )?;
            let bits = u64::from_str_radix(&text, 16).map_err(|_| INVALID)?;
            let (sign, exponent, fraction) = if kind == ScalarType::BinaryFloat {
                (0x8000_0000, 0x7F80_0000, 0x007F_FFFF)
            } else {
                (0x8000_0000_0000_0000, 0x7FF0_0000_0000_0000, 0x000F_FFFF_FFFF_FFFF)
            };
            if bits == sign || (bits & exponent == exponent && bits & fraction != 0) {
                return Err(INVALID);
            }
            json!(text)
        }
        ScalarType::Urowid => {
            let text = value.as_str().ok_or(INVALID)?;
            if text.is_empty() || text.len() > 4_000 || !text.bytes().all(|byte| byte.is_ascii_graphic()) {
                return Err(INVALID);
            }
            json!(text)
        }
        ScalarType::Varchar2 | ScalarType::Char | ScalarType::Nvarchar2 | ScalarType::Nchar => {
            let text = value.as_str().filter(|text| !text.is_empty()).ok_or(INVALID)?;
            json!(text)
        }
    })
}

pub(super) fn expression(expected: &ArgumentExpectation) -> Result<String, &'static str> {
    let kind = expected.scalar_type;
    let Some(value) = &expected.value else {
        return Ok(kind.null_expression());
    };
    let input = match kind {
        ScalarType::Number => value.as_str().ok_or(INVALID)?.into(),
        ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampTz | ScalarType::TimestampLtz => {
            let day = value["day"].as_str().ok_or(INVALID)?;
            let seconds = value["seconds"].as_str().ok_or(INVALID)?;
            let timestamp =
                format!("(CAST(TO_DATE('{day}', 'J') AS TIMESTAMP(9)) + NUMTODSINTERVAL({seconds}, 'SECOND'))");
            match kind {
                ScalarType::Date => format!("CAST({timestamp} AS DATE)"),
                ScalarType::Timestamp => timestamp,
                ScalarType::TimestampLtz => {
                    format!("CAST(FROM_TZ({timestamp}, '+00:00') AS TIMESTAMP(9) WITH LOCAL TIME ZONE)")
                }
                _ => format!(
                    "(FROM_TZ({timestamp}, {}) AT TIME ZONE {})",
                    quote_string_literal(value["offset"].as_str().ok_or(INVALID)?),
                    quote_string_literal(value["region"].as_str().ok_or(INVALID)?)
                ),
            }
        }
        ScalarType::IntervalYm => format!("NUMTOYMINTERVAL({}, 'MONTH')", value.as_str().ok_or(INVALID)?),
        ScalarType::IntervalDs => {
            format!("NUMTODSINTERVAL({}, 'SECOND')", seconds(integer(value.as_str().ok_or(INVALID)?)?))
        }
        ScalarType::Raw => raw_expression(value.as_str().ok_or(INVALID)?),
        ScalarType::BinaryFloat | ScalarType::BinaryDouble => format!(
            "SYS.UTL_RAW.{}({}, SYS.UTL_RAW.BIG_ENDIAN)",
            if kind == ScalarType::BinaryFloat { "CAST_TO_BINARY_FLOAT" } else { "CAST_TO_BINARY_DOUBLE" },
            raw_expression(value.as_str().ok_or(INVALID)?)
        ),
        ScalarType::Urowid => format!("CAST({} AS UROWID)", quote_string_literal(value.as_str().ok_or(INVALID)?)),
        _ => return Err("native_job_argument_character_constructor_required"),
    };
    Ok(format!("SYS.ANYDATA.{}({input})", kind.convert()))
}

pub(super) fn validation(expected: &ArgumentExpectation) -> Result<String, &'static str> {
    let kind = expected.scalar_type;
    let actual = format!("l_anydata.{}()", kind.access());
    let Some(value) = expected.value.as_ref() else {
        return Ok(format!("IF {actual} IS NOT NULL THEN RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_conversion_loss'); END IF; "));
    };
    let exact_text = |actual: &str, expected: &str| {
        format!("SYS.UTL_RAW.CAST_TO_RAW({actual}) = SYS.UTL_RAW.CAST_TO_RAW({})", quote_string_literal(expected))
    };
    let equal = match kind {
        ScalarType::Number => format!("{actual} = {}", value.as_str().ok_or(INVALID)?),
        ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampTz | ScalarType::TimestampLtz => {
            let timestamp = if kind == ScalarType::TimestampLtz { format!("CAST(({actual} AT TIME ZONE '+00:00') AS TIMESTAMP(9))") }
                else { format!("CAST({actual} AS TIMESTAMP(9))") };
            let mut check = format!("{} AND (EXTRACT(HOUR FROM {timestamp}) * 3600 + EXTRACT(MINUTE FROM {timestamp}) * 60 + EXTRACT(SECOND FROM {timestamp})) = {}", exact_text(&format!("TO_CHAR({timestamp}, 'J')"), value["day"].as_str().ok_or(INVALID)?), value["seconds"].as_str().ok_or(INVALID)?);
            if kind == ScalarType::TimestampTz {
                for (field, format) in [("region", "TZR"), ("offset", "TZH:TZM")] {
                    check.push_str(&format!(" AND {}", exact_text(&format!("TO_CHAR({actual}, '{format}')"), value[field].as_str().ok_or(INVALID)?)));
                }
                check.push_str(&match value.get("abbreviation").ok_or(INVALID)? {
                    Value::Null => format!(" AND TO_CHAR({actual}, 'TZD') IS NULL"),
                    Value::String(abbreviation) => format!(" AND {}", exact_text(&format!("TO_CHAR({actual}, 'TZD')"), abbreviation)),
                    _ => return Err(INVALID),
                });
            }
            check
        }
        ScalarType::IntervalYm => format!("(EXTRACT(YEAR FROM {actual}) * 12 + EXTRACT(MONTH FROM {actual})) = {}", value.as_str().ok_or(INVALID)?),
        ScalarType::IntervalDs => format!("(EXTRACT(DAY FROM {actual}) * 86400 + EXTRACT(HOUR FROM {actual}) * 3600 + EXTRACT(MINUTE FROM {actual}) * 60 + EXTRACT(SECOND FROM {actual})) * 1000000000 = {}", value.as_str().ok_or(INVALID)?),
        ScalarType::Raw | ScalarType::BinaryFloat | ScalarType::BinaryDouble => {
            let actual = match kind {
                ScalarType::BinaryFloat => format!("SYS.UTL_RAW.CAST_FROM_BINARY_FLOAT({actual}, SYS.UTL_RAW.BIG_ENDIAN)"),
                ScalarType::BinaryDouble => format!("SYS.UTL_RAW.CAST_FROM_BINARY_DOUBLE({actual}, SYS.UTL_RAW.BIG_ENDIAN)"),
                _ => actual.clone(),
            };
            let hex = value.as_str().ok_or(INVALID)?;
            format!("SYS.UTL_RAW.LENGTH({actual}) = {} AND SYS.UTL_RAW.COMPARE({actual}, {}) = 0", hex.len() / 2, raw_expression(hex))
        }
        ScalarType::Urowid => exact_text(&format!("ROWIDTOCHAR({actual})"), value.as_str().ok_or(INVALID)?),
        _ => return Ok(String::new()),
    };
    Ok(format!("IF {actual} IS NOT NULL AND ({equal}) THEN NULL; ELSE RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_conversion_loss'); END IF; "))
}

pub(super) fn projected_value(kind: ScalarType, row: &super::NativeJobRow) -> Result<Value, &'static str> {
    let text = |key: &str| row.get(key).and_then(Value::as_str).ok_or(INVALID);
    let value = match kind {
        ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampLtz | ScalarType::TimestampTz => {
            let mut date = json!({"day":text("DBX_ANYDATA_DAY")?, "seconds":text("DBX_ANYDATA_SECONDS")?});
            if kind == ScalarType::TimestampTz {
                date["region"] = json!(text("DBX_ANYDATA_TZ_REGION")?);
                date["offset"] = json!(text("DBX_ANYDATA_TZ_OFFSET")?);
                date["abbreviation"] = row.get("DBX_ANYDATA_TZ_ABBR").cloned().ok_or(INVALID)?;
            }
            date
        }
        ScalarType::Raw | ScalarType::BinaryFloat | ScalarType::BinaryDouble => {
            let hex = text("DBX_ANYDATA_HEX")?;
            if kind == ScalarType::Raw && integer(text("DBX_ANYDATA_LENGTH")?)? * 2 != hex.len() as i128 {
                return Err(INVALID);
            }
            json!(hex)
        }
        ScalarType::Varchar2 | ScalarType::Char | ScalarType::Nvarchar2 | ScalarType::Nchar => {
            if !row.contains_key("DBX_ANYDATA_CODEC") && !row.contains_key("DBX_ANYDATA_HEX") {
                return normalize(kind, &json!(text("DBX_ANYDATA_TEXT")?));
            }
            let hex = text("DBX_ANYDATA_HEX")?;
            if hex.is_empty()
                || hex.len() > 131_068
                || hex.len() % 4 != 0
                || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(INVALID);
            }
            let units = hex
                .as_bytes()
                .chunks(4)
                .map(|bytes| {
                    u16::from_str_radix(std::str::from_utf8(bytes).map_err(|_| INVALID)?, 16).map_err(|_| INVALID)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let string = String::from_utf16(&units).map_err(|_| INVALID)?;
            if integer(text("DBX_ANYDATA_LENGTH")?)? != string.chars().count() as i128 {
                return Err(INVALID);
            }
            json!(string)
        }
        _ => json!(text("DBX_ANYDATA_TEXT")?),
    };
    normalize(kind, &value)
}

fn clob_chunks(value: &str, unicode: bool) -> String {
    let size = if unicode { 256 } else { 1_000 };
    let maximum = 32_767;
    (0..maximum).step_by(size).map(|offset| {
        let start = offset + 1;
        if unicode {
            format!("CASE WHEN LENGTH4({value}) >= {start} THEN TO_CLOB(RAWTOHEX(SYS.UTL_I18N.STRING_TO_RAW(SUBSTR4({value}, {start}, {size}), 'AL16UTF16'))) END")
        } else {
            format!("CASE WHEN SYS.UTL_RAW.LENGTH({value}) >= {start} THEN TO_CLOB(RAWTOHEX(SYS.UTL_RAW.SUBSTR({value}, {start}, {size}))) END")
        }
    }).collect::<Vec<_>>().join(" || ")
}

pub(super) fn projection(column: &str) -> String {
    let utc_ltz = format!("CAST(({column}.AccessTimestampLTZ() AT TIME ZONE '+00:00') AS TIMESTAMP(9))");
    let mut day = Vec::new();
    let mut seconds = Vec::new();
    let mut civil = Vec::new();
    for kind in [ScalarType::Date, ScalarType::Timestamp, ScalarType::TimestampTz, ScalarType::TimestampLtz] {
        let value =
            if kind == ScalarType::TimestampLtz { utc_ltz.clone() } else { format!("{column}.{}()", kind.access()) };
        day.push(format!("WHEN '{}' THEN TO_CHAR({value}, 'J')", kind.token()));
        civil.push(format!(
            "WHEN '{}' THEN TRIM(TO_CHAR({value}, 'SYYYY-MM-DD', 'NLS_CALENDAR=GREGORIAN'))",
            kind.token()
        ));
        seconds.push(format!(
            "WHEN '{}' THEN TO_CHAR({value}, '{}', 'NLS_NUMERIC_CHARACTERS=''.,''')",
            kind.token(),
            if kind == ScalarType::Date { "SSSSS" } else { "SSSSS.FF9" }
        ));
    }
    let mut hex = Vec::new();
    let mut lengths = Vec::new();
    for kind in [ScalarType::Varchar2, ScalarType::Char, ScalarType::Nvarchar2, ScalarType::Nchar] {
        let value = format!("{column}.{}()", kind.access());
        hex.push(format!("WHEN '{}' THEN ({})", kind.token(), clob_chunks(&value, true)));
        lengths.push(format!("WHEN '{}' THEN TO_CHAR(LENGTH4({value}), 'TM9')", kind.token()));
    }
    hex.push(format!("WHEN 'raw' THEN ({})", clob_chunks(&format!("{column}.AccessRaw()"), false)));
    lengths.push(format!("WHEN 'raw' THEN TO_CHAR(SYS.UTL_RAW.LENGTH({column}.AccessRaw()), 'TM9')"));
    for (token, access, method) in [
        ("binary-float", "AccessBFloat", "CAST_FROM_BINARY_FLOAT"),
        ("binary-double", "AccessBDouble", "CAST_FROM_BINARY_DOUBLE"),
    ] {
        hex.push(format!(
            "WHEN '{token}' THEN TO_CLOB(RAWTOHEX(SYS.UTL_RAW.{method}({column}.{access}(), SYS.UTL_RAW.BIG_ENDIAN)))"
        ));
    }
    format!("CASE DBX_AT.CODEC {} END AS DBX_ANYDATA_DAY, CASE DBX_AT.CODEC {} END AS DBX_ANYDATA_SECONDS, CASE DBX_AT.CODEC WHEN 'timestamp-tz' THEN TO_CHAR({column}.AccessTimestampTZ(), 'TZR') END AS DBX_ANYDATA_TZ_REGION, CASE DBX_AT.CODEC WHEN 'timestamp-tz' THEN TO_CHAR({column}.AccessTimestampTZ(), 'TZH:TZM') END AS DBX_ANYDATA_TZ_OFFSET, CASE DBX_AT.CODEC WHEN 'timestamp-tz' THEN TO_CHAR({column}.AccessTimestampTZ(), 'TZD') END AS DBX_ANYDATA_TZ_ABBR, CASE DBX_AT.CODEC {} END AS DBX_ANYDATA_HEX, CASE DBX_AT.CODEC {} END AS DBX_ANYDATA_LENGTH, CASE DBX_AT.CODEC {} END AS DBX_ANYDATA_CIVIL_DATE", day.join(" "), seconds.join(" "), hex.join(" "), lengths.join(" "), civil.join(" "))
}
