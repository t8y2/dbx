use serde_json::Value;
use std::sync::LazyLock;

pub(super) fn field_matches(name: &str, actual: Option<&Value>, expected: &Value) -> bool {
    let Some(actual) = actual else { return false };
    if actual == expected {
        return true;
    }
    if let Value::Bool(expected) = expected {
        return super::super::details::boolean(Some(actual)) == Some(*expected);
    }
    if actual.is_null() && expected.as_str() == Some("") {
        return true;
    }
    match name {
        "NUMBER_OF_ARGUMENTS"
        | "JOB_PRIORITY"
        | "MAX_RUNS"
        | "MAX_FAILURES"
        | "RAISE_EVENTS"
        | "INSTANCE_ID"
        | "JOB_WEIGHT"
        | "EMAIL_TYPE"
        | "NETSEND_TYPE"
        | "EMAIL_OPERID"
        | "NETSEND_OPERID"
        | "EP_SEQNO"
        | "TYPE"
        | "JOBID"
        | "SUCC_ACTION"
        | "FAIL_ACTION"
        | "RETRY_ATTEMPTS"
        | "RETRY_INTERVAL"
        | "FREQ_INTERVAL"
        | "FREQ_SUB_INTERVAL"
        | "FREQ_MINUTE_INTERVAL"
        | "INSTANCE" => {
            let expected = expected.as_u64().map(i128::from);
            expected.is_some() && integral(actual) == expected
        }
        "START_DATE" | "END_DATE" => {
            expected.as_str().is_some_and(|expected| super::scheduler::same_timestamp(Some(actual), expected))
        }
        "NEXT_DATE" => expected.as_str().is_some_and(|expected| super::legacy::same_date(Some(actual), expected)),
        "SCHEDULE_LIMIT" | "MAX_RUN_DURATION" => {
            let expected = expected.as_str().and_then(interval_nanos);
            expected.is_some() && actual.as_str().and_then(interval_nanos) == expected
        }
        _ => false,
    }
}

// NUMBER columns may be returned as decimal strings. Never round through a floating-point value.
pub(super) fn integral(value: &Value) -> Option<i128> {
    let text = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => return None,
    };
    let text = text.trim();
    let whole = if let Some((whole, fraction)) = text.split_once('.') {
        if fraction.is_empty() || !fraction.bytes().all(|byte| byte == b'0') {
            return None;
        }
        whole
    } else {
        text
    };
    whole.parse().ok()
}

fn interval_nanos(value: &str) -> Option<i128> {
    static SQL: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^([+-]?)(\d+) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$").unwrap());
    static ISO: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^([+-]?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$").unwrap()
    });
    let value = value.trim();
    let captures = SQL.captures(value).or_else(|| ISO.captures(value))?;
    if (2..=5).all(|index| captures.get(index).is_none()) {
        return None;
    }
    let component =
        |index| -> Option<i128> { captures.get(index).map_or(Some(0), |value| value.as_str().parse().ok()) };
    let fraction = captures.get(6).map_or(Some(0), |value| {
        value.as_str().parse::<i128>().ok()?.checked_mul(10_i128.pow(9 - value.len() as u32))
    })?;
    let seconds = component(2)?
        .checked_mul(24)?
        .checked_add(component(3)?)?
        .checked_mul(60)?
        .checked_add(component(4)?)?
        .checked_mul(60)?
        .checked_add(component(5)?)?;
    let nanos = seconds.checked_mul(1_000_000_000)?.checked_add(fraction)?;
    if &captures[1] == "-" {
        nanos.checked_neg()
    } else {
        Some(nanos)
    }
}
