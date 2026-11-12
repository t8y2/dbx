use crate::{ColumnSchema, ValueKind};
use crate::{RecoveryLog, SchemaManifest, TableSchema};
use mysql_common::{
    binlog::{row::BinlogRow, value::BinlogValue},
    value::Value,
};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    Null,
    Integer(i128),
    Binary(Vec<u8>),
    Text { bytes: Vec<u8>, charset: String },
    Decimal(String),
    Json(String),
    DateTime(String),
    Timestamp(String),
    Time(String),
}

#[derive(Debug)]
pub struct InverseAction {
    pub table: TableSchema,
    pub expected: Option<Vec<Cell>>,
    pub restore: Option<Vec<Cell>>,
}

#[derive(Debug)]
pub struct InverseTransaction {
    pub start_position: u64,
    pub actions: Vec<InverseAction>,
}

#[derive(Debug)]
pub struct RecoveryPlan {
    pub transactions: Vec<InverseTransaction>,
}

impl RecoveryPlan {
    pub fn to_sql(&self) -> Result<String, String> {
        crate::sql::render(self)
    }
}

pub(crate) fn valid_decimal(value: &str) -> bool {
    let value = value.strip_prefix('-').unwrap_or(value);
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

pub(crate) fn valid_charset(charset: &str) -> bool {
    matches!(charset, "utf8mb4" | "utf8" | "ascii" | "latin1")
}

fn validate_bytes(column: &ColumnSchema, bytes: &[u8], characters: Option<usize>) -> Result<(), String> {
    let capacity = match (column.wire_type, column.wire_metadata.as_slice()) {
        (15, [low, high]) => u16::from_le_bytes([*low, *high]) as u64,
        (252, [width @ 1..=4]) => (1u64 << (u32::from(*width) * 8)) - 1,
        _ => return Err("unsupported byte-value capacity".into()),
    };
    if bytes.len() as u64 > capacity {
        return Err("value exceeds historical byte capacity".into());
    }
    if column.wire_type == 15 {
        if let ValueKind::Text { charset } = &column.kind {
            let width = match charset.as_str() {
                "utf8mb4" => 4,
                "utf8" => 3,
                _ => 1,
            };
            if capacity % width != 0 || characters.ok_or("missing character count")? as u64 > capacity / width {
                return Err("value exceeds historical character capacity".into());
            }
        }
    }
    Ok(())
}

fn cells(row: &BinlogRow, table: &TableSchema) -> Result<Vec<Cell>, String> {
    table
        .columns
        .iter()
        .enumerate()
        .map(|(i, column)| {
            let value = row.as_ref(i).ok_or("missing row value")?;
            if matches!(value, BinlogValue::Value(Value::NULL)) {
                return if column.nullable { Ok(Cell::Null) } else { Err("NULL in non-null historical column".into()) };
            }
            match (&column.kind, value) {
                (ValueKind::Integer, BinlogValue::Value(value)) => {
                    let number = match value {
                        Value::Int(n) => *n as i128,
                        Value::UInt(n) => *n as i128,
                        _ => return Err("invalid integer cell".into()),
                    };
                    let bits = match column.wire_type {
                        1 => 8,
                        2 => 16,
                        9 => 24,
                        3 => 32,
                        8 => 64,
                        _ => return Err("unsupported integer width".into()),
                    };
                    let (min, max) = if column.unsigned {
                        (0, (1i128 << bits) - 1)
                    } else {
                        (-(1i128 << (bits - 1)), (1i128 << (bits - 1)) - 1)
                    };
                    if !(min..=max).contains(&number) {
                        return Err("integer outside historical column range".into());
                    }
                    Ok(Cell::Integer(number))
                }
                (ValueKind::Binary, BinlogValue::Value(Value::Bytes(bytes))) => {
                    validate_bytes(column, bytes, None)?;
                    Ok(Cell::Binary(bytes.clone()))
                }
                (ValueKind::Text { charset }, BinlogValue::Value(Value::Bytes(bytes))) => {
                    if !valid_charset(charset) {
                        return Err("unsupported text character set".into());
                    }
                    if charset == "ascii" && !bytes.is_ascii() {
                        return Err("non-ASCII bytes in ASCII column".into());
                    }
                    let mut characters = bytes.len();
                    if charset.starts_with("utf8") {
                        let text = std::str::from_utf8(bytes).map_err(|_| "invalid historical UTF-8 text")?;
                        characters = text.chars().count();
                        if charset == "utf8" && text.chars().any(|c| c as u32 > 0xffff) {
                            return Err("four-byte character in utf8mb3 column".into());
                        }
                    }
                    validate_bytes(column, bytes, Some(characters))?;
                    Ok(Cell::Text { bytes: bytes.clone(), charset: charset.clone() })
                }
                (ValueKind::Decimal { precision, scale }, BinlogValue::Value(Value::Bytes(bytes))) => {
                    let value = std::str::from_utf8(bytes).map_err(|_| "invalid DECIMAL bytes")?;
                    let absolute = value.strip_prefix('-').unwrap_or(value);
                    let (whole, fraction) = absolute.split_once('.').unwrap_or((absolute, ""));
                    if !valid_decimal(value)
                        || fraction.len() != *scale as usize
                        || whole.trim_start_matches('0').len() > (precision - scale) as usize
                        || column.unsigned && value.starts_with('-')
                    {
                        return Err("invalid historical DECIMAL value".into());
                    }
                    Ok(Cell::Decimal(value.to_owned()))
                }
                (ValueKind::Json, BinlogValue::Jsonb(value)) => Ok(Cell::Json(crate::json::convert(value)?)),
                (
                    ValueKind::DateTime { .. } | ValueKind::Timestamp { .. } | ValueKind::Time { .. },
                    BinlogValue::Value(value),
                ) => crate::temporal::convert(&column.kind, value),
                _ => Err("unsupported row value (no lossy conversion permitted)".into()),
            }
        })
        .collect()
}

pub fn plan_recovery(log: &RecoveryLog, schema: &SchemaManifest, starts: &[u64]) -> Result<RecoveryPlan, String> {
    if schema.version != 1
        || schema.binlog_sha256 != log.sha256
        || !schema.historical
        || schema.provenance.trim().is_empty()
    {
        return Err("a file-bound historical schema with provenance is required".into());
    }
    if !log.server_version.starts_with("8.0.") || log.server_version.contains("MariaDB") {
        return Err("recovery generation currently requires MySQL 8.0".into());
    }
    if schema.valid_from < 4 || schema.valid_to > log.end_position || schema.valid_from >= schema.valid_to {
        return Err("invalid historical schema position range".into());
    }
    let selected: HashSet<u64> = starts.iter().copied().collect();
    if starts.is_empty()
        || starts.len() != selected.len()
        || starts.iter().any(|p| !log.transactions.iter().any(|tx| tx.start_position == *p))
    {
        return Err("empty, duplicate or unknown transaction selection".into());
    }
    let mut tables = HashSet::new();
    if schema.tables.iter().any(|t| !tables.insert((&t.database, &t.table))) {
        return Err("duplicate historical table".into());
    }
    let mut affected_tables = HashSet::new();
    for tx in &log.transactions {
        if selected.contains(&tx.start_position) {
            for row in &tx.rows {
                affected_tables.insert((row.database.clone(), row.table.clone()));
            }
        } else if tx.rows.iter().any(|row| affected_tables.contains(&(row.database.clone(), row.table.clone()))) {
            return Err(
                "later unselected transaction touches a selected table; include it or review dependencies".into()
            );
        }
    }
    // Unsupported statements can alter schema or data outside ordinary ROW events.
    if log.barriers.iter().any(|(p, _)| *p >= schema.valid_from && *p < log.end_position) {
        return Err("unsupported event within historical schema scope".into());
    }
    let mut transactions = Vec::new();
    for tx in log.transactions.iter().rev().filter(|tx| selected.contains(&tx.start_position)) {
        if tx.start_position < schema.valid_from || tx.end_position > schema.valid_to || tx.rows.is_empty() {
            return Err("transaction outside historical schema range or contains no DML".into());
        }
        let mut actions = Vec::new();
        for row in tx.rows.iter().rev() {
            let table = schema
                .tables
                .iter()
                .find(|t| t.database.as_bytes() == row.database && t.table.as_bytes() == row.table)
                .ok_or("missing historical table schema")?;
            table.validate(row)?;
            let expected = row.after.as_ref().map(|image| cells(image, table)).transpose()?;
            let restore = row.before.as_ref().map(|image| cells(image, table)).transpose()?;
            if expected.is_none() && restore.is_none() {
                return Err("row has no image".into());
            }
            actions.push(InverseAction { table: table.clone(), expected, restore });
        }
        transactions.push(InverseTransaction { start_position: tx.start_position, actions });
    }
    Ok(RecoveryPlan { transactions })
}
