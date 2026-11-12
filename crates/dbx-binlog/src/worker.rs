//! Bounded protocol for the isolated parser process; never executes SQL.
use crate::{plan_recovery, read_log, SchemaManifest, TransactionFilter};
use mysql_common::{
    binlog::{row::BinlogRow, value::BinlogValue},
    value::Value,
};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use std::{
    fs::File,
    io::{BufReader, Read},
};

pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    List {
        path: String,
        #[serde(default)]
        filter: TransactionFilter,
        #[serde(default)]
        offset: usize,
    },
    Details {
        path: String,
        sha256: String,
        start_position: String,
        #[serde(default)]
        offset: usize,
    },
    Generate {
        path: String,
        sha256: String,
        schema_path: String,
        start_positions: Vec<String>,
    },
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn display(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| format!("0x{}", hex(bytes)))
}

fn image(row: &Option<BinlogRow>, ordinals: &[usize], signedness_known: bool) -> Option<Vec<Json>> {
    row.as_ref().map(|row| {
        row.columns_ref()
            .iter()
            .enumerate()
            .map(|(i, column)| {
                let (kind, value) = match row.as_ref(i) {
                    Some(BinlogValue::Value(Value::NULL)) => ("null", Json::Null),
                    Some(BinlogValue::Value(value @ (Value::Int(_) | Value::UInt(_))))
                        if !signedness_known && matches!(column.column_type() as u8, 1 | 2 | 3 | 8 | 9) =>
                    {
                        let raw = match value {
                            Value::Int(n) => *n as u64,
                            Value::UInt(n) => *n,
                            _ => unreachable!(),
                        };
                        let bytes = match column.column_type() as u8 {
                            1 => 1,
                            2 => 2,
                            9 => 3,
                            3 => 4,
                            _ => 8,
                        };
                        let mask = if bytes == 8 { u64::MAX } else { (1u64 << (bytes * 8)) - 1 };
                        ("ambiguous_integer", json!(format!("0x{:0width$x}", raw & mask, width = bytes * 2)))
                    }
                    Some(BinlogValue::Value(Value::Int(n))) => ("integer", json!(n.to_string())),
                    Some(BinlogValue::Value(Value::UInt(n))) => ("integer", json!(n.to_string())),
                    Some(BinlogValue::Value(Value::Bytes(bytes))) => ("bytes_hex", json!(hex(bytes))),
                    Some(BinlogValue::Jsonb(value)) => match crate::json::convert(value) {
                        Ok(value) => ("json", json!(value)),
                        Err(_) => ("unsupported_json", Json::Null),
                    },
                    Some(value) => ("typed_preview", json!(format!("{value:?}"))),
                    None => ("missing", Json::Null),
                };
                json!({"ordinal":ordinals[i],"column":display(column.name_ref()),"kind":kind,"value":value})
            })
            .collect()
    })
}

fn local_file(path: &str) -> Result<File, String> {
    // Check before opening so a FIFO/device cannot block a worker indefinitely.
    if !std::fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err("input must be a regular local file".into());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("input must be a regular local file".into());
    }
    Ok(file)
}

pub fn handle_worker_request(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("binlog worker request exceeds 64 KiB".into());
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let path = match &request {
        Request::List { path, .. } | Request::Details { path, .. } | Request::Generate { path, .. } => path,
    };
    let log = read_log(BufReader::new(local_file(path)?)).map_err(|e| e.to_string())?;
    match &request {
        Request::Details { sha256, .. } | Request::Generate { sha256, .. } if sha256 != log.sha256() => {
            return Err("binlog file changed since preview; import again".into())
        }
        _ => {}
    }
    let response = match request {
        Request::List { filter, offset, .. } => {
            let transactions = log.matching_transactions(&filter)?;
            let entries:Vec<_> = transactions.iter().skip(offset).take(100).map(|tx| {
                let tables:std::collections::BTreeSet<_> = tx.rows.iter().map(|r|(display(&r.database),display(&r.table))).collect();
                json!({"start_position":tx.start_position.to_string(),"end_position":tx.end_position.to_string(),"timestamp":tx.timestamp,"gtid":tx.gtid,"rows":tx.rows.len(),"tables":tables})
            }).collect();
            json!({"sha256":log.sha256(),"total":transactions.len(),"offset":offset,"transactions":entries})
        }
        Request::Details { start_position, offset, .. } => {
            let start: u64 = start_position.parse().map_err(|_| "invalid transaction start position")?;
            let tx = log
                .transactions()
                .iter()
                .find(|t| t.start_position == start)
                .ok_or("unknown transaction start position")?;
            let entries:Vec<_> = tx.rows.iter().skip(offset).take(100).map(|r|json!({
                "position":r.position.to_string(),"database":display(&r.database),"table":display(&r.table),
                "full_image":r.full_image,"has_column_names":r.has_column_names,"has_signedness":r.has_signedness,
                "before":image(&r.before,&r.before_columns,r.has_signedness),"after":image(&r.after,&r.after_columns,r.has_signedness)
            })).collect();
            json!({"sha256":log.sha256(),"start_position":start_position,"total":tx.rows.len(),"offset":offset,"rows":entries})
        }
        Request::Generate { schema_path, start_positions, .. } => {
            let mut bytes = Vec::new();
            local_file(&schema_path)?.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("historical schema manifest exceeds 4 MiB".into());
            }
            let schema: SchemaManifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let starts = start_positions
                .iter()
                .map(|s| s.parse::<u64>().map_err(|_| "invalid start position"))
                .collect::<Result<Vec<_>, _>>()?;
            json!({"sha256":log.sha256(),"sql":plan_recovery(&log,&schema,&starts)?.to_sql()?})
        }
    };
    let output = serde_json::to_string(&response).map_err(|e| e.to_string())?;
    if output.len() > MAX_RESPONSE_BYTES {
        return Err("worker response exceeds 8 MiB; narrow the selection".into());
    }
    Ok(output)
}
