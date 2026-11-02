use super::{scalar_envelope, NativeJobArgumentValue, NativeJobRow, ScalarType};
use dbx_sql_core::value_literals::quote_string_literal;
use serde_json::{json, Value};

const INVALID: &str = "native_job_argument_date_invalid";

fn valid_civil(value: &str) -> bool {
    let (negative, date) = value.strip_prefix('-').map_or((false, value), |date| (true, date));
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let year = date[..4].parse::<u16>().unwrap();
    let month = date[5..7].parse::<u8>().unwrap();
    let day = date[8..].parse::<u8>().unwrap();
    year != 0 && (!negative || year <= 4712) && (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn input(value: &Value) -> Result<Option<&str>, &'static str> {
    let Some(payload) = value.get("value").and_then(Value::as_object) else { return Ok(None) };
    let Some(civil) = payload.get("civilDate") else { return Ok(None) };
    let kind = value.get("scalarType").and_then(Value::as_str).and_then(ScalarType::from_token).ok_or(INVALID)?;
    if !matches!(kind, ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampTz | ScalarType::TimestampLtz)
        || payload.contains_key("day")
    {
        return Err(INVALID);
    }
    let civil = civil.as_str().filter(|civil| valid_civil(civil)).ok_or(INVALID)?;
    let mut probe = value.clone();
    let payload = probe["value"].as_object_mut().unwrap();
    payload.remove("civilDate");
    payload.insert("day".into(), json!("1"));
    scalar_envelope(&probe)?;
    Ok(Some(civil))
}

pub fn civil_date_query(value: &Value) -> Result<Option<String>, &'static str> {
    let Some(civil) = input(value)? else { return Ok(None) };
    let text = if civil.starts_with('-') { civil.to_string() } else { format!(" {civil}") };
    let text = quote_string_literal(&text);
    Ok(Some(format!("SELECT TO_CHAR(X.D, 'J') AS DBX_DAY, TRIM(TO_CHAR(X.D, 'SYYYY-MM-DD', 'NLS_CALENDAR=GREGORIAN')) AS DBX_CIVIL, TRIM(TO_CHAR(TO_DATE(TO_CHAR(X.D, 'J'), 'J'), 'SYYYY-MM-DD', 'NLS_CALENDAR=GREGORIAN')) AS DBX_REBUILT FROM (SELECT TO_DATE({text}, 'SYYYY-MM-DD', 'NLS_CALENDAR=GREGORIAN') AS D FROM DUAL) X")))
}

pub fn normalize_civil_date(value: &Value, row: &NativeJobRow) -> Result<Value, &'static str> {
    let civil = input(value)?.ok_or(INVALID)?;
    if row.get("DBX_CIVIL").and_then(Value::as_str) != Some(civil)
        || row.get("DBX_REBUILT").and_then(Value::as_str) != Some(civil)
    {
        return Err(INVALID);
    }
    let day = row.get("DBX_DAY").and_then(Value::as_str).ok_or(INVALID)?;
    let mut normalized = value.clone();
    let payload = normalized["value"].as_object_mut().unwrap();
    payload.remove("civilDate");
    payload.insert("day".into(), json!(day));
    let NativeJobArgumentValue::Value { value } = scalar_envelope(&normalized)?.editable_value() else {
        unreachable!()
    };
    Ok(value)
}

pub fn editable_argument(row: &NativeJobRow, default_value: bool) -> NativeJobArgumentValue {
    let mut result = super::decode_argument(row, default_value).editable_value();
    if let NativeJobArgumentValue::Value { value } = &mut result {
        let kind = value.get("scalarType").and_then(Value::as_str).and_then(ScalarType::from_token);
        if matches!(
            kind,
            Some(ScalarType::Date | ScalarType::Timestamp | ScalarType::TimestampTz | ScalarType::TimestampLtz)
        ) {
            if let Some(civil) =
                row.get("DBX_ANYDATA_CIVIL_DATE").and_then(Value::as_str).filter(|civil| valid_civil(civil))
            {
                if let Some(payload) = value["value"].as_object_mut() {
                    payload.remove("day");
                    payload.insert("civilDate".into(), json!(civil));
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_use_fixed_native_calendar_roundtrips_without_client_epoch_arithmetic() {
        for civil in ["-4712-01-01", "-0001-12-31", "0001-01-01", "1582-10-05", "9999-12-31"] {
            let value = json!({"$dbx":"oracle-anydata-v1","scalarType":"timestamp","value":{"civilDate":civil,"seconds":"86399.123456789"}});
            let sql = civil_date_query(&value).unwrap().unwrap();
            assert!(sql.contains("'NLS_CALENDAR=GREGORIAN'"));
            assert!(!sql.contains("ALTER SESSION"));
            assert!(!sql.contains("TO_TIMESTAMP"));
            let row =
                serde_json::from_value(json!({"DBX_DAY":"1234567","DBX_CIVIL":civil,"DBX_REBUILT":civil})).unwrap();
            assert_eq!(
                normalize_civil_date(&value, &row).unwrap()["value"],
                json!({"day":"1234567","seconds":"86399.123456789"})
            );
            let wrong =
                serde_json::from_value(json!({"DBX_DAY":"1234567","DBX_CIVIL":civil,"DBX_REBUILT":"2000-01-01"}))
                    .unwrap();
            assert!(normalize_civil_date(&value, &wrong).is_err());
        }
        for civil in [
            "0000-01-01",
            "-0000-01-01",
            "-4713-01-01",
            "10000-01-01",
            "2026-13-01",
            "2026-01-00",
            "2026-01-01');END;--",
        ] {
            assert!(civil_date_query(
                &json!({"$dbx":"oracle-anydata-v1","scalarType":"date","value":{"civilDate":civil,"seconds":"0"}})
            )
            .is_err());
        }
        assert!(civil_date_query(&json!({"$dbx":"oracle-anydata-v1","scalarType":"date","value":{"civilDate":"2026-01-01","day":"1","seconds":"0"}})).is_err());
        assert!(civil_date_query(&json!("{\"value\":{\"civilDate\":\"2026-01-01\"}}")).unwrap().is_none());
        assert!(civil_date_query(
            &json!({"$dbx":"oracle-anydata-v1","scalarType":"date","value":{"day":"1","seconds":"0"}})
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn auxiliary_civil_dates_only_affect_edit_display_not_storage_fingerprints() {
        let mut row: NativeJobRow = serde_json::from_value(json!({"DBX_ANYDATA_PRESENT":1,"DBX_ANYDATA_TYPE":"SYS.TIMESTAMP","DBX_ANYDATA_IS_NULL":0,"DBX_ANYDATA_DAY":"1234567","DBX_ANYDATA_SECONDS":"1.123456789"})).unwrap();
        let baseline = super::super::canonical_argument_row(&row, false);
        row.insert("DBX_ANYDATA_CIVIL_DATE".into(), json!("-0001-12-31"));
        assert_eq!(baseline, super::super::canonical_argument_row(&row, false));
        let NativeJobArgumentValue::Value { value } = editable_argument(&row, false) else { panic!("value required") };
        assert_eq!(value["value"], json!({"civilDate":"-0001-12-31","seconds":"1.123456789"}));
        row.insert("DBX_ANYDATA_IS_NULL".into(), json!(1));
        assert!(
            matches!(editable_argument(&row, false), NativeJobArgumentValue::Value { value } if value["value"].is_null())
        );
    }
}
