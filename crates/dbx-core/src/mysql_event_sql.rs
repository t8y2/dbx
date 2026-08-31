use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MysqlEventSchedule {
    At { execute_at: String },
    Every { interval_value: String, interval_unit: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MysqlEventDefinition {
    pub name: String,
    pub schema: Option<String>,
    pub schedule: MysqlEventSchedule,
    pub starts: Option<String>,
    pub ends: Option<String>,
    pub on_completion_preserve: Option<bool>,
    pub enabled: Option<bool>,
    pub comment: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MysqlEventInfo {
    pub name: String,
    pub schema: String,
    pub definer: Option<String>,
    pub time_zone: Option<String>,
    pub event_type: Option<String>,
    pub execute_at: Option<String>,
    pub interval_value: Option<String>,
    pub interval_field: Option<String>,
    pub starts: Option<String>,
    pub ends: Option<String>,
    pub status: Option<String>,
    pub on_completion: Option<String>,
    pub comment: Option<String>,
    pub event_body: Option<String>,
    pub event_definition: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_executed: Option<String>,
    pub source: Option<String>,
}

fn ident(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("event name must not be empty".into());
    }
    Ok(format!("`{}`", value.replace('`', "``")))
}
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}
fn unit(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "SECOND" => Ok("SECOND"),
        "MINUTE" => Ok("MINUTE"),
        "HOUR" => Ok("HOUR"),
        "DAY" => Ok("DAY"),
        "WEEK" => Ok("WEEK"),
        "MONTH" => Ok("MONTH"),
        "QUARTER" => Ok("QUARTER"),
        "YEAR" => Ok("YEAR"),
        _ => Err(format!("invalid event interval unit: {value}")),
    }
}
pub fn create_event_sql(definition: &MysqlEventDefinition) -> Result<String, String> {
    build_event_sql("CREATE EVENT", definition)
}
pub fn alter_event_sql(definition: &MysqlEventDefinition) -> Result<String, String> {
    build_event_sql("ALTER EVENT", definition)
}
fn build_event_sql(prefix: &str, definition: &MysqlEventDefinition) -> Result<String, String> {
    let name = ident(&definition.name)?;
    if definition.body.trim().is_empty() {
        return Err("event body must not be empty".into());
    }
    let schedule = match &definition.schedule {
        MysqlEventSchedule::At { execute_at } if execute_at.trim().is_empty() => {
            return Err("event AT schedule must include execute_at".into())
        }
        MysqlEventSchedule::At { execute_at } => format!("AT {}", literal(execute_at)),
        MysqlEventSchedule::Every { interval_value, interval_unit } => {
            let interval_value = interval_value.trim();
            if !interval_value.bytes().all(|byte| byte.is_ascii_digit())
                || interval_value.bytes().all(|byte| byte == b'0')
            {
                return Err("event EVERY schedule requires a positive integer interval_value".into());
            }
            format!("EVERY {} {}", interval_value, unit(interval_unit)?)
        }
    };
    let mut sql = format!("{prefix} {name} ON SCHEDULE {schedule}");
    if let Some(value) = definition.starts.as_deref().filter(|v| !v.trim().is_empty()) {
        sql.push_str(&format!(" STARTS {}", literal(value)));
    }
    if let Some(value) = definition.ends.as_deref().filter(|v| !v.trim().is_empty()) {
        sql.push_str(&format!(" ENDS {}", literal(value)));
    }
    if let Some(value) = definition.on_completion_preserve {
        sql.push_str(if value { " ON COMPLETION PRESERVE" } else { " ON COMPLETION NOT PRESERVE" });
    }
    if let Some(value) = definition.enabled {
        sql.push_str(if value { " ENABLE" } else { " DISABLE" });
    }
    if let Some(value) = definition.comment.as_deref() {
        sql.push_str(&format!(" COMMENT {}", literal(value)));
    }
    sql.push_str(" DO ");
    sql.push_str(definition.body.trim());
    Ok(sql)
}
pub fn drop_event_sql(schema: Option<&str>, name: &str, if_exists: bool) -> Result<String, String> {
    let qualified = match schema.filter(|s| !s.trim().is_empty()) {
        Some(schema) => format!("{}.{}", ident(schema)?, ident(name)?),
        None => ident(name)?,
    };
    Ok(format!("DROP EVENT {}{}", if if_exists { "IF EXISTS " } else { "" }, qualified))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definition() -> MysqlEventDefinition {
        MysqlEventDefinition {
            name: "daily`sync".into(),
            schema: Some("shop".into()),
            schedule: MysqlEventSchedule::Every { interval_value: "1".into(), interval_unit: "day".into() },
            starts: Some("2026-01-01 00:00:00".into()),
            ends: None,
            on_completion_preserve: Some(true),
            enabled: Some(false),
            comment: Some("owner's job".into()),
            body: "CALL `refresh`();".into(),
        }
    }
    #[test]
    fn builds_every_event_with_escaped_values() {
        assert_eq!(create_event_sql(&definition()).unwrap(), "CREATE EVENT `daily``sync` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 00:00:00' ON COMPLETION PRESERVE DISABLE COMMENT 'owner\\'s job' DO CALL `refresh`();");
    }
    #[test]
    fn validates_schedule_and_body() {
        let mut def = definition();
        def.body = " ".into();
        assert!(create_event_sql(&def).is_err());
        def.body = "SELECT 1".into();
        def.schedule = MysqlEventSchedule::Every { interval_value: "1".into(), interval_unit: "fortnight".into() };
        assert!(create_event_sql(&def).is_err());
    }
    #[test]
    fn rejects_non_positive_or_non_numeric_interval_values() {
        let mut def = definition();
        for interval_value in ["", "0", " 000 ", "1 DAY", "1; DROP EVENT other"] {
            def.schedule =
                MysqlEventSchedule::Every { interval_value: interval_value.into(), interval_unit: "DAY".into() };
            assert!(create_event_sql(&def).is_err(), "unexpectedly accepted {interval_value:?}");
        }
    }
    #[test]
    fn builds_at_and_drop_sql() {
        let mut def = definition();
        def.schedule = MysqlEventSchedule::At { execute_at: "2026-02-01 10:00:00".into() };
        assert!(create_event_sql(&def).unwrap().contains("ON SCHEDULE AT '2026-02-01 10:00:00'"));
        assert_eq!(
            drop_event_sql(Some("shop"), "daily`sync", true).unwrap(),
            "DROP EVENT IF EXISTS `shop`.`daily``sync`"
        );
    }
}
