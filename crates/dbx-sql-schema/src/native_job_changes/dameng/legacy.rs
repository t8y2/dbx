use super::*;

pub fn native_job_dameng_civil_time(input: &str) -> Result<String, &'static str> {
    let invalid = "native_job_attribute_value_invalid";
    let bytes = input.as_bytes();
    if bytes.len() < 19
        || !bytes.is_ascii()
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b' ' | b'T')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err(invalid);
    }
    let number = |start: usize, end: usize| -> Result<u32, &'static str> {
        let part = &input[start..end];
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid);
        }
        part.parse().map_err(|_| invalid)
    };
    if number(0, 4)? == 0
        || !(1..=12).contains(&number(5, 7)?)
        || !(1..=31).contains(&number(8, 10)?)
        || number(11, 13)? > 23
        || number(14, 16)? > 59
        || number(17, 19)? > 59
    {
        return Err(invalid);
    }
    let fraction = if bytes.len() == 19 {
        ""
    } else {
        if bytes[19] != b'.' {
            return Err(invalid);
        }
        let fraction = &input[20..];
        if fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || (fraction.len() > 6 && !fraction[6..].bytes().all(|byte| byte == b'0'))
        {
            return Err(invalid);
        }
        &fraction[..fraction.len().min(6)]
    };
    Ok(format!("{} {}.{:0<6}", &input[..10], &input[11..19], fraction))
}

pub fn native_job_dameng_legacy_time(row: &NativeJobRow) -> Result<String, &'static str> {
    let invalid = "native_job_metadata_incomplete";
    let date = row.get("NEXT_DATE").and_then(Value::as_str).ok_or(invalid)?;
    let seconds = row.get("NEXT_SEC").ok_or(invalid)?;
    let seconds = if seconds.is_null() || seconds.as_str() == Some("") {
        None
    } else {
        let text = seconds.as_str().ok_or(invalid)?;
        if text.len() != 8 || native_job_dameng_civil_time(&format!("2000-01-01 {text}")).is_err() {
            return Err(invalid);
        }
        Some(text)
    };
    let civil = if date.len() == 10 {
        let seconds = seconds.ok_or(invalid)?;
        native_job_dameng_civil_time(&format!("{date} {seconds}"))
    } else {
        native_job_dameng_civil_time(date)
    }
    .map_err(|_| invalid)?;
    if let Some(seconds) = seconds {
        if &civil[11..19] != seconds {
            return Err(invalid);
        }
    }
    Ok(civil)
}

pub fn native_job_dameng_date_query(civil: &str) -> NativeJobCatalogQuery {
    NativeJobCatalogQuery {
        source: "DUAL", coverage: NativeJobCatalogCoverage::Accessible, limit: 1,
        sql: format!("SELECT TO_CHAR(CAST(TIMESTAMP {} AS DATETIME(6)), 'SYYYY-MM-DD HH24:MI:SS.FF6') AS DBX_NEXT_DATE FROM DUAL", text(civil)),
    }
}
