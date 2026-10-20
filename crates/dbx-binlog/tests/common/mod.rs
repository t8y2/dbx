#![allow(dead_code)]

use dbx_binlog as dbx_mysql_binlog_probe;
use dbx_binlog::inspect;
use std::io::{self, Cursor, Read};

pub fn event(kind: u8, payload: &[u8], start: usize) -> Vec<u8> {
    let size = 19 + payload.len() + 4;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&1_700_000_000u32.to_le_bytes());
    bytes.push(kind);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(size as u32).to_le_bytes());
    bytes.extend_from_slice(&((start + size) as u32).to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(&crc32fast::hash(&bytes).to_le_bytes());
    bytes
}

pub fn log() -> Vec<u8> {
    let mut payload = 4u16.to_le_bytes().to_vec();
    let mut version = [0u8; 50];
    version[..6].copy_from_slice(b"8.0.27");
    payload.extend_from_slice(&version);
    payload.extend_from_slice(&0u32.to_le_bytes());
    payload.push(19);
    let mut lengths = [0u8; 41];
    lengths[1] = 13; // QUERY_EVENT
    lengths[18] = 8; // TABLE_MAP_EVENT
    lengths[29..32].fill(10); // V2 WRITE/UPDATE/DELETE_ROWS
    payload.extend_from_slice(&lengths);
    payload.push(1); // CRC32
    let mut bytes = b"\xfebin".to_vec();
    bytes.extend(event(15, &payload, bytes.len()));
    bytes
}

pub fn run(bytes: &[u8]) -> io::Result<dbx_mysql_binlog_probe::Inspection> {
    inspect(Cursor::new(bytes), |_| {})
}

pub struct Chunked<'a>(pub &'a [u8]);
impl Read for Chunked<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let len = out.len().min(3);
        self.0.read(&mut out[..len])
    }
}

pub fn append(bytes: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    bytes.extend(event(kind, payload, bytes.len()));
}

pub fn with_table() -> Vec<u8> {
    let mut bytes = log();
    let mut table = vec![1, 0, 0, 0, 0, 0, 0, 0]; // table id + flags
    table.extend_from_slice(b"\x04test\0\x05items\0");
    // BIGINT, BLOB (1-byte length), INT; all nullable.
    table.extend_from_slice(&[3, 8, 252, 3, 1, 1, 7]);
    table.extend_from_slice(&[1, 1, 0x80]); // signedness: BIGINT unsigned, INT signed
    append(&mut bytes, 19, &table);
    bytes
}

pub fn row_prefix(bitmap: u8) -> Vec<u8> {
    vec![1, 0, 0, 0, 0, 0, 1, 0, 2, 0, 3, bitmap]
}

pub fn image(id: u64, blob: &[u8], number: Option<i32>) -> Vec<u8> {
    let mut row = vec![if number.is_none() { 4 } else { 0 }];
    row.extend_from_slice(&id.to_le_bytes());
    row.push(blob.len() as u8);
    row.extend_from_slice(blob);
    if let Some(number) = number {
        row.extend_from_slice(&number.to_le_bytes());
    }
    row
}

pub fn query(bytes: &mut Vec<u8>, sql: &[u8]) {
    let mut payload = vec![0; 14]; // query post-header + empty schema's terminator
    payload.extend_from_slice(sql);
    append(bytes, 2, &payload);
}

pub fn write_row(bytes: &mut Vec<u8>, id: u64) {
    let mut write = row_prefix(7);
    write.extend(image(id, b"test", Some(1)));
    append(bytes, 30, &write);
}

pub fn named_log() -> Vec<u8> {
    named_log_with_names(b"\x02id\x07payload\x07counter")
}

pub fn named_log_with_names(names: &[u8]) -> Vec<u8> {
    let mut bytes = log();
    let mut table = vec![1, 0, 0, 0, 0, 0, 0, 0];
    table.extend_from_slice(b"\x04test\0\x05items\0");
    table.extend_from_slice(&[3, 8, 252, 3, 1, 1, 6, 1, 1, 0x80]);
    table.extend_from_slice(&[4, names.len() as u8]);
    table.extend_from_slice(names);
    table.extend_from_slice(&[8, 1, 0]); // primary key: column 0
    append(&mut bytes, 19, &table);
    bytes
}

pub fn snapshot(log: &dbx_mysql_binlog_probe::RecoveryLog) -> dbx_mysql_binlog_probe::SchemaManifest {
    serde_json::from_value(serde_json::json!({
        "version": 1, "binlog_sha256": log.sha256(), "valid_from": 4,
        "valid_to": log.transactions().last().unwrap().end_position,
        "provenance": "isolated fixture schema captured before transaction", "historical": true,
        "tables": [{"database":"test", "table":"items", "engine":"InnoDB",
            "no_triggers_or_foreign_keys":true, "primary_key":[0], "columns":[
                {"name":"id","wire_type":8,"wire_metadata":[],"unsigned":true,"nullable":false,"generated":false,"kind":{"type":"integer"}},
                {"name":"payload","wire_type":252,"wire_metadata":[1],"unsigned":false,"nullable":true,"generated":false,"kind":{"type":"binary"}},
                {"name":"counter","wire_type":3,"wire_metadata":[],"unsigned":false,"nullable":true,"generated":false,"kind":{"type":"integer"}}
            ]}]
    })).unwrap()
}
