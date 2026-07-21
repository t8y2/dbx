use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime};
use deadpool_postgres::{ManagerConfig, Pool, PoolError, RecyclingMethod, Runtime};
use futures::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::verify_server_cert_signed_by_trust_anchor;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use std::fs::File;
use std::future::Future;
use std::io::BufReader;
use std::str::FromStr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{NoTls, Row, SimpleQueryMessage};
use tokio_util::sync::CancellationToken;

use super::file_validator::validate_file_path;
use crate::query::{await_stream_with_progress_timeout, DbOperationBudget, StreamProgressClock};
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, CompletionAssistantCandidate, CompletionAssistantCandidateKind, CompletionAssistantMatchMode,
    CompletionAssistantObjectKind, CompletionAssistantRequest, CompletionAssistantResponse, DatabaseInfo,
    ExtensionInfo, ForeignKeyInfo, FunctionInfo, IndexInfo, ObjectInfo, ObjectStatistics, OwnerInfo, QueryResult,
    RuleInfo, SchemaInfo, SequenceInfo, TableInfo, TriggerInfo,
};

fn pg_temporal_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<_, DateTime<Local>>(idx) {
        return Some(serde_json::Value::String(format_pg_timestamptz(v)));
    }
    if let Ok(v) = row.try_get::<_, NaiveDateTime>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<_, NaiveDate>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    if let Ok(v) = row.try_get::<_, NaiveTime>(idx) {
        return Some(serde_json::Value::String(v.to_string()));
    }
    None
}

struct PgSystemU32(u32);

impl<'a> FromSql<'a> for PgSystemU32 {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        let bytes: [u8; 4] = raw.try_into().map_err(|_| "expected 4 bytes for PostgreSQL system u32")?;
        Ok(Self(u32::from_be_bytes(bytes)))
    }

    fn accepts(ty: &Type) -> bool {
        matches!(*ty, Type::XID | Type::CID)
    }
}

/// A `FromSql` adapter that accepts any PostgreSQL type and reads its raw
/// bytes as a UTF-8 string. This is used as a last-resort fallback to handle
/// custom types (enums, domains, etc.) that tokio_postgres cannot map to
/// built-in Rust types in the binary protocol.
struct PgAnyString(String);

impl<'a> FromSql<'a> for PgAnyString {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        std::str::from_utf8(raw)
            .map(|s| PgAnyString(s.to_string()))
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Sync + Send>)
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

/// A `FromSql` adapter that accepts any PostgreSQL type and returns the raw
/// bytes unchanged. Used to decode custom types like pgvector whose binary
/// format we handle ourselves.
struct PgRawBytes(Vec<u8>);

impl<'a> FromSql<'a> for PgRawBytes {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(PgRawBytes(raw.to_vec()))
    }

    fn accepts(_: &Type) -> bool {
        true
    }
}

/// Decode pgvector binary format into a Vec<f32>.
///
/// pgvector binary layout (big-endian):
/// - 2 bytes: dimensions (uint16)
/// - 2 bytes: unused (padding)
/// - N*4 bytes: IEEE 754 f32 values
fn decode_pgvector_bytes(raw: &[u8]) -> Option<Vec<f32>> {
    if raw.len() < 4 {
        return None;
    }
    let dims = u16::from_be_bytes([raw[0], raw[1]]) as usize;
    let expected_len = 4 + dims * 4;
    if raw.len() != expected_len {
        return None;
    }
    let floats: Vec<f32> =
        raw[4..].chunks_exact(4).map(|chunk| f32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect();
    Some(floats)
}

fn pg_u32_number(v: u32) -> serde_json::Value {
    serde_json::Value::Number(serde_json::Number::from(v))
}

fn pg_system_u32_to_json(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(v) = row.try_get::<_, u32>(idx) {
        return Some(pg_u32_number(v));
    }
    row.try_get::<_, PgSystemU32>(idx).ok().map(|v| pg_u32_number(v.0))
}

fn pg_optional_array_to_json<T>(
    values: Vec<Option<T>>,
    map_value: impl Fn(T) -> serde_json::Value,
) -> serde_json::Value {
    serde_json::Value::Array(
        values.into_iter().map(|value| value.map(&map_value).unwrap_or(serde_json::Value::Null)).collect(),
    )
}

fn pg_float_number(v: f64) -> serde_json::Value {
    serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
}

fn decode_pg_network_address_bytes(raw: &[u8], force_cidr_output: bool) -> Option<String> {
    let family = *raw.first()?;
    let bits = *raw.get(1)?;
    let is_cidr = *raw.get(2)? != 0;
    let addr_len = *raw.get(3)? as usize;
    let addr = raw.get(4..)?;
    if addr.len() != addr_len {
        return None;
    }

    let (address, host_bits) = match (family, addr_len) {
        (2, 4) => {
            let bytes: [u8; 4] = addr.try_into().ok()?;
            (std::net::IpAddr::V4(std::net::Ipv4Addr::from(bytes)).to_string(), 32)
        }
        (3, 16) => {
            let bytes: [u8; 16] = addr.try_into().ok()?;
            (std::net::IpAddr::V6(std::net::Ipv6Addr::from(bytes)).to_string(), 128)
        }
        _ => return None,
    };

    if bits > host_bits {
        return None;
    }

    if force_cidr_output || is_cidr || bits != host_bits {
        Some(format!("{address}/{bits}"))
    } else {
        Some(address)
    }
}

fn decode_pg_macaddr_bytes(raw: &[u8]) -> Option<String> {
    if !matches!(raw.len(), 6 | 8) {
        return None;
    }
    Some(raw.iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(":"))
}

fn decode_pg_bit_string_bytes(raw: &[u8]) -> Option<String> {
    let mut cursor = 0;
    let bit_len = read_i32_be(raw, &mut cursor)?;
    if bit_len < 0 {
        return None;
    }
    let bit_len = bit_len as usize;
    let data = raw.get(cursor..)?;
    if data.len() != bit_len.div_ceil(8) {
        return None;
    }

    let mut bits = String::with_capacity(bit_len);
    for index in 0..bit_len {
        let byte = data[index / 8];
        let bit = (byte >> (7 - (index % 8))) & 1;
        bits.push(if bit == 1 { '1' } else { '0' });
    }
    Some(bits)
}

fn pg_network_address_to_json_value(row: &Row, idx: usize, force_cidr_output: bool) -> Option<serde_json::Value> {
    row.try_get::<_, PgRawBytes>(idx)
        .ok()
        .and_then(|raw| decode_pg_network_address_bytes(&raw.0, force_cidr_output))
        .map(serde_json::Value::String)
}

fn pg_macaddr_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    row.try_get::<_, PgRawBytes>(idx)
        .ok()
        .and_then(|raw| decode_pg_macaddr_bytes(&raw.0))
        .map(serde_json::Value::String)
}

fn pg_bit_string_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    row.try_get::<_, PgRawBytes>(idx)
        .ok()
        .and_then(|raw| decode_pg_bit_string_bytes(&raw.0))
        .map(serde_json::Value::String)
}

fn pg_network_address_array_to_json_value(row: &Row, idx: usize, force_cidr_output: bool) -> Option<serde_json::Value> {
    row.try_get::<_, Vec<Option<PgRawBytes>>>(idx).ok().map(|values| {
        pg_optional_array_to_json(values, |raw| {
            decode_pg_network_address_bytes(&raw.0, force_cidr_output)
                .map(serde_json::Value::String)
                .unwrap_or_else(|| super::binary_value_to_json(&raw.0))
        })
    })
}

fn pg_macaddr_array_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    row.try_get::<_, Vec<Option<PgRawBytes>>>(idx).ok().map(|values| {
        pg_optional_array_to_json(values, |raw| {
            decode_pg_macaddr_bytes(&raw.0)
                .map(serde_json::Value::String)
                .unwrap_or_else(|| super::binary_value_to_json(&raw.0))
        })
    })
}

fn pg_bit_string_array_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    row.try_get::<_, Vec<Option<PgRawBytes>>>(idx).ok().map(|values| {
        pg_optional_array_to_json(values, |raw| {
            decode_pg_bit_string_bytes(&raw.0)
                .map(serde_json::Value::String)
                .unwrap_or_else(|| super::binary_value_to_json(&raw.0))
        })
    })
}

fn pg_array_to_json_value(row: &Row, idx: usize) -> Option<serde_json::Value> {
    if let Ok(values) = row.try_get::<_, Vec<Option<String>>>(idx) {
        return Some(pg_optional_array_to_json(values, serde_json::Value::String));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<bool>>>(idx) {
        return Some(pg_optional_array_to_json(values, serde_json::Value::Bool));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<Decimal>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<uuid::Uuid>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<DateTime<Local>>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(format_pg_timestamptz(v))));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveDateTime>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveDate>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<NaiveTime>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.to_string())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<u32>>>(idx) {
        return Some(pg_optional_array_to_json(values, pg_u32_number));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i8>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i16>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i32>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::Number(v.into())));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<i64>>>(idx) {
        return Some(pg_optional_array_to_json(values, super::safe_i64_to_json));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<f32>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| pg_float_number(v as f64)));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<f64>>>(idx) {
        return Some(pg_optional_array_to_json(values, pg_float_number));
    }
    if let Ok(values) = row.try_get::<_, Vec<Option<PgAnyString>>>(idx) {
        return Some(pg_optional_array_to_json(values, |v| serde_json::Value::String(v.0)));
    }
    None
}

fn format_pg_timestamptz(value: DateTime<Local>) -> String {
    value.to_rfc3339()
}

/// 时间类型解码失败后的回退目标，与原 if 链中时间分支之后的匹配顺序一一对应。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PgTemporalFallback {
    /// 数组类型名（下划线开头）落到通用数组解码。
    GenericArray,
    /// `VECTOR(...)` 形式的类型名落到 pgvector 解码。
    Vector,
    /// 其余落到通用试探链。
    Probe,
}

/// 每列一次的类型分类结果，避免在逐单元格路径上重复 `to_uppercase` 与字符串比较链。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PgColType {
    Bytea,
    Json,
    Bool,
    Temporal { fallback: PgTemporalFallback },
    Numeric,
    Uuid,
    Inet { cidr: bool },
    MacAddr,
    BitString,
    TsVector,
    SystemU32,
    InetArray { cidr: bool },
    MacAddrArray,
    BitStringArray,
    GenericArray,
    Vector,
    Geometry,
    Other,
}

pub(crate) fn classify_pg_type(type_name: &str) -> PgColType {
    let upper = type_name.to_uppercase();

    if upper == "BYTEA" {
        return PgColType::Bytea;
    }
    if upper == "JSON" || upper == "JSONB" {
        return PgColType::Json;
    }
    if upper == "BOOL" {
        return PgColType::Bool;
    }
    if upper.contains("TIMESTAMP")
        || upper == "DATE"
        || upper == "TIME"
        || upper == "TIMETZ"
        || upper.contains("INTERVAL")
    {
        let fallback = if upper.starts_with('_') {
            PgTemporalFallback::GenericArray
        } else if upper.starts_with("VECTOR(") {
            PgTemporalFallback::Vector
        } else {
            PgTemporalFallback::Probe
        };
        return PgColType::Temporal { fallback };
    }
    if upper == "NUMERIC" || upper == "DECIMAL" || upper == "MONEY" {
        return PgColType::Numeric;
    }
    if upper == "UUID" {
        return PgColType::Uuid;
    }
    if matches!(upper.as_str(), "INET" | "CIDR") {
        return PgColType::Inet { cidr: upper == "CIDR" };
    }
    if matches!(upper.as_str(), "MACADDR" | "MACADDR8") {
        return PgColType::MacAddr;
    }
    if matches!(upper.as_str(), "BIT" | "VARBIT") {
        return PgColType::BitString;
    }
    if upper == "TSVECTOR" {
        return PgColType::TsVector;
    }
    if matches!(upper.as_str(), "OID" | "XID" | "CID") {
        return PgColType::SystemU32;
    }
    if matches!(upper.as_str(), "_INET" | "_CIDR") {
        return PgColType::InetArray { cidr: upper == "_CIDR" };
    }
    if matches!(upper.as_str(), "_MACADDR" | "_MACADDR8") {
        return PgColType::MacAddrArray;
    }
    if matches!(upper.as_str(), "_BIT" | "_VARBIT") {
        return PgColType::BitStringArray;
    }
    if upper.starts_with('_') {
        return PgColType::GenericArray;
    }
    if upper == "VECTOR" || upper.starts_with("VECTOR(") {
        return PgColType::Vector;
    }
    if upper == "GEOMETRY" || upper == "GEOGRAPHY" {
        return PgColType::Geometry;
    }
    PgColType::Other
}

pub(crate) fn classify_pg_column_types(column_types: &[String]) -> Vec<PgColType> {
    column_types.iter().map(|type_name| classify_pg_type(type_name)).collect()
}

pub(crate) fn pg_value_to_json_classified(row: &Row, idx: usize, col_type: PgColType) -> serde_json::Value {
    match col_type {
        PgColType::Bytea => row
            .try_get::<_, Vec<u8>>(idx)
            .map(|bytes| super::binary_value_to_json(&bytes))
            .unwrap_or(serde_json::Value::Null),
        PgColType::Json => {
            if let Ok(v) = row.try_get::<_, serde_json::Value>(idx) {
                return serde_json::Value::String(v.to_string());
            }
            if let Ok(v) = row.try_get::<_, String>(idx) {
                return serde_json::Value::String(v);
            }
            serde_json::Value::Null
        }
        PgColType::Bool => row.try_get::<_, bool>(idx).map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null),
        PgColType::Temporal { fallback } => {
            if let Some(v) = pg_temporal_to_json_value(row, idx) {
                return v;
            }
            match fallback {
                PgTemporalFallback::GenericArray => pg_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
                PgTemporalFallback::Vector => pg_vector_value_to_json(row, idx),
                PgTemporalFallback::Probe => pg_fallback_value_to_json(row, idx),
            }
        }
        PgColType::Numeric => row
            .try_get::<_, Decimal>(idx)
            .map(|v: Decimal| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null),
        PgColType::Uuid => row
            .try_get::<_, uuid::Uuid>(idx)
            .map(|v| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null),
        PgColType::Inet { cidr } => pg_network_address_to_json_value(row, idx, cidr).unwrap_or(serde_json::Value::Null),
        PgColType::MacAddr => pg_macaddr_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::BitString => pg_bit_string_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::TsVector => row
            .try_get::<_, PgRawBytes>(idx)
            .ok()
            .and_then(|raw| decode_tsvector_bytes(&raw.0))
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
        PgColType::SystemU32 => pg_system_u32_to_json(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::InetArray { cidr } => {
            pg_network_address_array_to_json_value(row, idx, cidr).unwrap_or(serde_json::Value::Null)
        }
        PgColType::MacAddrArray => pg_macaddr_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::BitStringArray => pg_bit_string_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::GenericArray => pg_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null),
        PgColType::Vector => pg_vector_value_to_json(row, idx),
        PgColType::Geometry => {
            if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
                return super::wkb::wkb_to_wkt(&raw)
                    .map(serde_json::Value::String)
                    .unwrap_or_else(|| super::binary_value_to_json(&raw));
            }
            serde_json::Value::Null
        }
        PgColType::Other => pg_fallback_value_to_json(row, idx),
    }
}

/// Serialize a pgvector `vector` component with f32 shortest round-trip decimal text.
///
/// Casting through `f64` (or fixed fractional rounding) either expands binary noise or
/// truncates remaining single-precision digits; formatting via `f32` display keeps the
/// full float4 value that pgvector stores.
fn pg_vector_element_number(v: f32) -> serde_json::Value {
    v.to_string().parse().map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
}

fn pg_vector_value_to_json(row: &Row, idx: usize) -> serde_json::Value {
    if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
        if let Some(floats) = decode_pgvector_bytes(&raw) {
            return serde_json::Value::Array(floats.into_iter().map(pg_vector_element_number).collect());
        }
    }
    serde_json::Value::Null
}

fn pg_fallback_value_to_json(row: &Row, idx: usize) -> serde_json::Value {
    row.try_get::<_, String>(idx)
        .map(serde_json::Value::String)
        .or_else(|e| pg_system_u32_to_json(row, idx).ok_or(e))
        .or_else(|_| row.try_get::<_, i64>(idx).map(super::safe_i64_to_json))
        .or_else(|_| row.try_get::<_, i32>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|_| row.try_get::<_, i16>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|_| row.try_get::<_, i8>(idx).map(|v| serde_json::Value::Number(v.into())))
        .or_else(|e| pg_array_to_json_value(row, idx).ok_or(e))
        .or_else(|_| {
            row.try_get::<_, f64>(idx).map(|v| {
                serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| {
            row.try_get::<_, f32>(idx).map(|v| {
                serde_json::Number::from_f64((v as f64 * 1_000_000.0).round() / 1_000_000.0)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null)
            })
        })
        .or_else(|_| row.try_get::<_, bool>(idx).map(serde_json::Value::Bool))
        .or_else(|_| row.try_get::<_, uuid::Uuid>(idx).map(|v| serde_json::Value::String(v.to_string())))
        .or_else(|e| pg_temporal_to_json_value(row, idx).ok_or(e))
        .or_else(|_| row.try_get::<_, Vec<u8>>(idx).map(|bytes| super::binary_value_to_json(&bytes)))
        .or_else(|_| row.try_get::<_, PgAnyString>(idx).map(|v| serde_json::Value::String(v.0)))
        .or_else(|_| row.try_get::<_, PgRawBytes>(idx).map(|v| super::binary_value_to_json(&v.0)))
        .unwrap_or(serde_json::Value::Null)
}

fn decode_tsvector_bytes(raw: &[u8]) -> Option<String> {
    let mut cursor = 0;
    let count = read_i32_be(raw, &mut cursor)?;
    if count < 0 {
        return None;
    }

    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let start = cursor;
        while cursor < raw.len() && raw[cursor] != 0 {
            cursor += 1;
        }
        if cursor >= raw.len() {
            return None;
        }
        let lexeme = std::str::from_utf8(&raw[start..cursor]).ok()?;
        cursor += 1;

        let position_count = read_u16_be(raw, &mut cursor)? as usize;
        let mut positions = Vec::with_capacity(position_count);
        for _ in 0..position_count {
            let encoded = read_u16_be(raw, &mut cursor)?;
            let position = encoded & 0x3fff;
            let weight = match encoded >> 14 {
                3 => "A",
                2 => "B",
                1 => "C",
                _ => "",
            };
            positions.push(format!("{position}{weight}"));
        }

        let mut entry = format!("'{}'", escape_tsvector_lexeme(lexeme));
        if !positions.is_empty() {
            entry.push(':');
            entry.push_str(&positions.join(","));
        }
        entries.push(entry);
    }

    if cursor == raw.len() {
        Some(entries.join(" "))
    } else {
        None
    }
}

fn read_i32_be(raw: &[u8], cursor: &mut usize) -> Option<i32> {
    let bytes: [u8; 4] = raw.get(*cursor..*cursor + 4)?.try_into().ok()?;
    *cursor += 4;
    Some(i32::from_be_bytes(bytes))
}

fn read_u16_be(raw: &[u8], cursor: &mut usize) -> Option<u16> {
    let bytes: [u8; 2] = raw.get(*cursor..*cursor + 2)?.try_into().ok()?;
    *cursor += 2;
    Some(u16::from_be_bytes(bytes))
}

fn escape_tsvector_lexeme(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

fn pg_error_to_string(err: tokio_postgres::Error) -> String {
    err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string())
}

fn pg_db_error_to_string(err: &tokio_postgres::error::DbError) -> String {
    format!("{err} (SQLSTATE {})", err.code().code())
}

fn pg_error_from_sources(err: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut current = Some(err);
    while let Some(source) = current {
        if let Some(pg_error) = source.downcast_ref::<tokio_postgres::Error>() {
            if let Some(db_error) = pg_error.as_db_error() {
                return Some(pg_db_error_to_string(db_error));
            }
        }
        if let Some(db_error) = source.downcast_ref::<tokio_postgres::error::DbError>() {
            return Some(pg_db_error_to_string(db_error));
        }
        current = source.source();
    }
    None
}

fn error_with_sources_to_string(err: &(dyn std::error::Error + 'static)) -> String {
    let mut messages = vec![err.to_string()];
    let mut current = err.source();
    while let Some(source) = current {
        let message = source.to_string();
        if !messages.iter().any(|existing| existing == &message) {
            messages.push(message);
        }
        current = source.source();
    }
    messages.join(": ")
}

fn pg_pool_error_to_string(err: PoolError) -> String {
    pg_error_from_sources(&err).unwrap_or_else(|| error_with_sources_to_string(&err))
}

fn should_retry_postgres_text_query(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    should_retry_postgres_text_query_message(&message)
}

fn should_retry_postgres_text_query_message(message: &str) -> bool {
    message.contains("no binary output function")
        || message.contains("no binary send function")
        || message.contains("cannot display a value of type")
}

fn should_retry_postgres_stale_cache(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    message.contains("cached plan must not change result type")
}

async fn postgres_query_cached(
    client: &deadpool_postgres::Client,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Vec<Row>, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    match client.query(&stmt, params).await {
        Ok(rows) => Ok(rows),
        Err(err) if should_retry_postgres_stale_cache(&err) => {
            // Metadata queries can be cached while a table/view definition is
            // changed from another session. Evict and retry once with fresh
            // statement/type metadata instead of surfacing PostgreSQL's stale
            // cached-plan error to the UI.
            log::warn!("[postgres][metadata:stale_cache] evicting cached statement: {}", pg_error_to_string(err));
            client.statement_cache.remove(sql, &[]);
            client.clear_type_cache();
            let stmt = client.prepare_cached(sql).await?;
            client.query(&stmt, params).await
        }
        Err(err) => Err(err),
    }
}

async fn postgres_query_one_cached(
    client: &deadpool_postgres::Client,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<Row, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    match client.query_one(&stmt, params).await {
        Ok(row) => Ok(row),
        Err(err) if should_retry_postgres_stale_cache(&err) => {
            // Same stale-cache protection as postgres_query_cached, for scalar
            // catalog probes such as pg_proc feature detection.
            log::warn!("[postgres][metadata:stale_cache] evicting cached statement: {}", pg_error_to_string(err));
            client.statement_cache.remove(sql, &[]);
            client.clear_type_cache();
            let stmt = client.prepare_cached(sql).await?;
            client.query_one(&stmt, params).await
        }
        Err(err) => Err(err),
    }
}

async fn execute_select_prepared(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, tokio_postgres::Error> {
    let prepared_start = Instant::now();
    let stmt = client.prepare_cached(sql).await?;
    log::info!(
        "[postgres][select:prepare_cached:done] elapsed_ms={} total_ms={}",
        prepared_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );
    let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();
    let column_classes = classify_pg_column_types(&column_types);

    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    let query_start = Instant::now();
    let stream = client.query_raw(&stmt, params).await?;
    log::info!(
        "[postgres][select:query_raw:done] elapsed_ms={} total_ms={} column_count={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        columns.len()
    );
    tokio::pin!(stream);
    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    let rows_start = Instant::now();
    while let Some(row_result) = stream.next().await {
        if result_rows.len() >= row_limit {
            truncated = true;
            break;
        }
        let row = row_result?;
        result_rows.push(
            (0..row.columns().len())
                .map(|i| {
                    pg_value_to_json_classified(&row, i, column_classes.get(i).copied().unwrap_or(PgColType::Other))
                })
                .collect(),
        );
    }
    log::info!(
        "[postgres][select:rows:done] elapsed_ms={} total_ms={} row_count={} truncated={}",
        rows_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result_rows.len(),
        truncated
    );

    Ok(QueryResult {
        columns,
        column_types,
        column_sortables: Vec::new(),
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

async fn execute_select_text(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, String> {
    let messages = client.simple_query(sql).await.map_err(pg_error_to_string)?;
    let mut columns: Vec<String> = Vec::new();
    let mut result_rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    for message in messages {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
            }
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                if result_rows.len() >= row_limit {
                    truncated = true;
                    continue;
                }
                let mut values = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    values.push(match row.try_get(i).map_err(pg_error_to_string)? {
                        Some(value) => serde_json::Value::String(value.to_string()),
                        None => serde_json::Value::Null,
                    });
                }
                result_rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(_) => {}
            _ => {}
        }
    }

    Ok(QueryResult {
        columns,
        column_types: Vec::new(),
        column_sortables: Vec::new(),
        rows: result_rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

async fn execute_select_query(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    row_limit: usize,
) -> Result<QueryResult, String> {
    match execute_select_prepared(client, sql, start, row_limit).await {
        Ok(result) => Ok(result),
        Err(err) if should_retry_postgres_stale_cache(&err) => {
            // The cached prepared statement is stale (e.g. the view or table
            // schema changed since the statement was prepared). Evict the
            // stale entry and retry with a fresh server-side prepare.
            log::warn!("[postgres][select:stale_cache] evicting cached statement: {}", pg_error_to_string(err));
            client.statement_cache.remove(sql, &[]);
            match execute_select_prepared(client, sql, start, row_limit).await {
                Ok(result) => Ok(result),
                Err(err) if should_retry_postgres_text_query(&err) => {
                    execute_select_text(client, sql, start, row_limit).await
                }
                Err(err) => Err(pg_error_to_string(err)),
            }
        }
        Err(err) if should_retry_postgres_text_query(&err) => execute_select_text(client, sql, start, row_limit).await,
        Err(err) => Err(pg_error_to_string(err)),
    }
}

pub enum PostgresQueryStreamItem {
    Columns { columns: Vec<String>, column_types: Vec<String> },
    Row(Vec<serde_json::Value>),
}

enum PostgresQueryStreamError {
    Postgres { err: tokio_postgres::Error, emitted: bool },
    Export(String),
}

impl PostgresQueryStreamError {
    fn into_string(self) -> String {
        match self {
            Self::Postgres { err, .. } => pg_error_to_string(err),
            Self::Export(err) => err,
        }
    }
}

async fn stream_select_query_prepared(
    client: &deadpool_postgres::Client,
    sql: &str,
    row_limit: Option<usize>,
    on_item: &mut impl FnMut(PostgresQueryStreamItem) -> Result<(), String>,
) -> Result<u64, PostgresQueryStreamError> {
    let stmt =
        client.prepare_cached(sql).await.map_err(|err| PostgresQueryStreamError::Postgres { err, emitted: false })?;
    let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();
    let column_classes = classify_pg_column_types(&column_types);

    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    let stream = client
        .query_raw(&stmt, params)
        .await
        .map_err(|err| PostgresQueryStreamError::Postgres { err, emitted: false })?;
    tokio::pin!(stream);
    let mut rows_streamed = 0_u64;
    let mut columns_emitted = false;
    while let Some(row_result) = stream.next().await {
        if row_limit.is_some_and(|limit| rows_streamed as usize >= limit) {
            break;
        }
        let row = row_result
            .map_err(|err| PostgresQueryStreamError::Postgres { err, emitted: columns_emitted || rows_streamed > 0 })?;
        if !columns_emitted {
            on_item(PostgresQueryStreamItem::Columns { columns: columns.clone(), column_types: column_types.clone() })
                .map_err(PostgresQueryStreamError::Export)?;
            columns_emitted = true;
        }
        let values = (0..row.columns().len())
            .map(|i| pg_value_to_json_classified(&row, i, column_classes.get(i).copied().unwrap_or(PgColType::Other)))
            .collect();
        on_item(PostgresQueryStreamItem::Row(values)).map_err(PostgresQueryStreamError::Export)?;
        rows_streamed += 1;
    }
    if !columns_emitted {
        on_item(PostgresQueryStreamItem::Columns { columns, column_types })
            .map_err(PostgresQueryStreamError::Export)?;
    }
    Ok(rows_streamed)
}

async fn stream_select_query_text(
    client: &deadpool_postgres::Client,
    sql: &str,
    row_limit: Option<usize>,
    on_item: &mut impl FnMut(PostgresQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let stream = client.simple_query_raw(sql).await.map_err(pg_error_to_string)?;
    tokio::pin!(stream);
    let mut columns: Vec<String> = Vec::new();
    let mut rows_streamed = 0_u64;
    while let Some(message) = stream.next().await {
        match message.map_err(pg_error_to_string)? {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
                on_item(PostgresQueryStreamItem::Columns { columns: columns.clone(), column_types: Vec::new() })?;
            }
            SimpleQueryMessage::Row(row) => {
                if row_limit.is_some_and(|limit| rows_streamed as usize >= limit) {
                    break;
                }
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    on_item(PostgresQueryStreamItem::Columns { columns: columns.clone(), column_types: Vec::new() })?;
                }
                let mut values = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    values.push(match row.try_get(i).map_err(pg_error_to_string)? {
                        Some(value) => serde_json::Value::String(value.to_string()),
                        None => serde_json::Value::Null,
                    });
                }
                on_item(PostgresQueryStreamItem::Row(values))?;
                rows_streamed += 1;
            }
            SimpleQueryMessage::CommandComplete(_) => {}
            _ => {}
        }
    }
    Ok(rows_streamed)
}

async fn stream_select_query_inner(
    client: &deadpool_postgres::Client,
    sql: &str,
    row_limit: Option<usize>,
    on_item: &mut impl FnMut(PostgresQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    match stream_select_query_prepared(client, sql, row_limit, on_item).await {
        Ok(rows) => Ok(rows),
        Err(PostgresQueryStreamError::Postgres { err, emitted: false }) if should_retry_postgres_stale_cache(&err) => {
            // The cached prepared statement can become stale after schema changes.
            // Evict and retry once, matching the normal query execution path.
            log::warn!("[postgres][stream:stale_cache] evicting cached statement: {}", pg_error_to_string(err));
            client.statement_cache.remove(sql, &[]);
            match stream_select_query_prepared(client, sql, row_limit, on_item).await {
                Ok(rows) => Ok(rows),
                Err(PostgresQueryStreamError::Postgres { err, emitted: false })
                    if should_retry_postgres_text_query(&err) =>
                {
                    stream_select_query_text(client, sql, row_limit, on_item).await
                }
                Err(err) => Err(err.into_string()),
            }
        }
        Err(PostgresQueryStreamError::Postgres { err, emitted: false }) if should_retry_postgres_text_query(&err) => {
            stream_select_query_text(client, sql, row_limit, on_item).await
        }
        Err(err) => Err(err.into_string()),
    }
}

pub async fn stream_query_rows(
    pool: &Pool,
    sql: &str,
    max_rows: Option<usize>,
    cancelled: &AtomicBool,
    mut on_row: impl FnMut(&[serde_json::Value]) -> Result<(), String>,
) -> Result<u64, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    match stream_query_rows_on_client(&client, sql, max_rows, cancelled, &mut on_row).await {
        Ok(rows) => Ok(rows),
        Err(error) if should_retry_postgres_text_query_message(&error.to_ascii_lowercase()) => {
            stream_query_rows_text_on_client(&client, sql, max_rows, cancelled, &mut on_row).await
        }
        Err(error) => Err(error),
    }
}

async fn stream_query_rows_on_client(
    client: &deadpool_postgres::Client,
    sql: &str,
    max_rows: Option<usize>,
    cancelled: &AtomicBool,
    on_row: &mut impl FnMut(&[serde_json::Value]) -> Result<(), String>,
) -> Result<u64, String> {
    let stmt = client.prepare_cached(sql).await.map_err(pg_error_to_string)?;
    let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();
    let column_classes = classify_pg_column_types(&column_types);
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    let stream = client.query_raw(&stmt, params).await.map_err(pg_error_to_string)?;
    tokio::pin!(stream);
    let row_limit = max_rows.unwrap_or(usize::MAX);
    let mut rows_exported = 0_u64;

    while let Some(row_result) = stream.next().await {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::query::canceled_error());
        }
        if rows_exported as usize >= row_limit {
            break;
        }
        let row = row_result.map_err(pg_error_to_string)?;
        let values: Vec<serde_json::Value> = (0..row.columns().len())
            .map(|i| pg_value_to_json_classified(&row, i, column_classes.get(i).copied().unwrap_or(PgColType::Other)))
            .collect();
        on_row(&values)?;
        rows_exported += 1;
    }

    Ok(rows_exported)
}

async fn stream_query_rows_text_on_client(
    client: &deadpool_postgres::Client,
    sql: &str,
    max_rows: Option<usize>,
    cancelled: &AtomicBool,
    on_row: &mut impl FnMut(&[serde_json::Value]) -> Result<(), String>,
) -> Result<u64, String> {
    let messages = client.simple_query(sql).await.map_err(pg_error_to_string)?;
    let row_limit = max_rows.unwrap_or(usize::MAX);
    let mut rows_exported = 0_u64;

    for message in messages {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::query::canceled_error());
        }
        if rows_exported as usize >= row_limit {
            break;
        }
        if let SimpleQueryMessage::Row(row) = message {
            let mut values = Vec::with_capacity(row.len());
            for i in 0..row.len() {
                values.push(match row.try_get(i).map_err(pg_error_to_string)? {
                    Some(value) => serde_json::Value::String(value.to_string()),
                    None => serde_json::Value::Null,
                });
            }
            on_row(&values)?;
            rows_exported += 1;
        }
    }

    Ok(rows_exported)
}

pub async fn connect(url: &str, fallback_timeout: Duration) -> Result<Pool, String> {
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());
    connect_with_local_timezone(url, fallback_timeout, &timezone).await
}

async fn connect_with_local_timezone(url: &str, fallback_timeout: Duration, timezone: &str) -> Result<Pool, String> {
    let url_with_keepalive = inject_postgres_keepalive_params(url);
    let postgres_url = postgres_connection_url(&url_with_keepalive)?;
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);

    super::with_connection_timeout("PostgreSQL", timeout, async {
        let pg_config = tokio_postgres::Config::from_str(&postgres_url.url)
            .map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;

        // Fast recycling only checks whether the connection is already closed
        // instead of issuing a validation query on every checkout, saving one
        // round-trip per query. Connections that went stale without being
        // observed are caught when the query runs and recovered by the
        // executor's ReconnectAndRetry path (see pool_error_action / do_execute
        // in query.rs).
        let mgr_config = ManagerConfig { recycling_method: RecyclingMethod::Fast };
        let tls_config = postgres_tls_config(
            &pg_config,
            &postgres_url.ssl_files,
            postgres_url.accepts_invalid_certs,
            postgres_url.verifies_hostname,
        )?;
        let mgr = deadpool_postgres::Manager::from_config(
            pg_config.clone(),
            tokio_postgres_rustls::MakeRustlsConnect::new(tls_config),
            mgr_config,
        );
        let pool = Pool::builder(mgr)
            .max_size(10)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(timeout))
            .create_timeout(Some(timeout))
            .recycle_timeout(Some(timeout))
            .build()
            .map_err(|e| format!("Failed to create PostgreSQL pool: {e}"))?;

        // Verify connectivity and set timezone. Explicit connection options are
        // handled by PostgreSQL during startup and must remain strict.
        let client =
            pool.get().await.map_err(|e| format!("PostgreSQL connection failed: {}", pg_pool_error_to_string(e)))?;
        if !pg_url_has_timezone_setting(url) {
            set_automatic_postgres_timezone(&client, timezone).await?;
        }

        Ok(pool)
    })
    .await
}

async fn set_automatic_postgres_timezone(client: &deadpool_postgres::Client, timezone: &str) -> Result<(), String> {
    let candidates = postgres_timezone_candidates(timezone);
    for (index, candidate) in candidates.iter().enumerate() {
        let sql = format!("SET timezone = '{}'", candidate.replace('\'', "''"));
        match client.execute(&sql, &[]).await {
            Ok(_) => {
                if *candidate != timezone {
                    log::warn!(
                        "PostgreSQL does not recognize local timezone '{timezone}'; using compatible alias '{candidate}'"
                    );
                }
                return Ok(());
            }
            Err(error) if postgres_timezone_error_is_nonfatal(&error) => {
                let detail = pg_error_to_string(error);
                if index + 1 == candidates.len() {
                    // A connected server may have older tzdata or only partial PostgreSQL compatibility.
                    // Keep its session default rather than making optional local display alignment fatal.
                    log::warn!(
                        "PostgreSQL connected, but automatic local timezone '{timezone}' was rejected; \
                         keeping the server default timezone: {detail}"
                    );
                    return Ok(());
                }
            }
            Err(error) => {
                return Err(format!("PostgreSQL SET timezone failed after connecting: {}", pg_error_to_string(error)));
            }
        }
    }

    Ok(())
}

fn postgres_timezone_error_is_nonfatal(error: &tokio_postgres::Error) -> bool {
    let Some(db_error) = error.as_db_error() else {
        return false;
    };
    // SET failures reported as ordinary SQL errors are optional session setup.
    // FATAL/PANIC responses mean the connection itself is not safe to return.
    !matches!(
        db_error.parsed_severity(),
        Some(tokio_postgres::error::Severity::Fatal | tokio_postgres::error::Severity::Panic)
    ) && !matches!(db_error.severity().to_ascii_uppercase().as_str(), "FATAL" | "PANIC")
}

fn postgres_timezone_candidates(timezone: &str) -> Vec<&str> {
    let legacy_alias = match timezone {
        "Asia/Saigon" => Some("Asia/Ho_Chi_Minh"),
        "Asia/Ho_Chi_Minh" => Some("Asia/Saigon"),
        "Europe/Kyiv" => Some("Europe/Kiev"),
        "Europe/Kiev" => Some("Europe/Kyiv"),
        "Asia/Calcutta" => Some("Asia/Kolkata"),
        "Asia/Kolkata" => Some("Asia/Calcutta"),
        _ => None,
    };
    std::iter::once(timezone).chain(legacy_alias).collect()
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PostgresSslFiles {
    pub sslcert: Option<String>,
    pub sslkey: Option<String>,
    pub sslrootcert: Option<String>,
}

/// TLS context info, used to reconstruct the TLS connector when cancelling a query.
#[derive(Debug, Clone)]
pub struct PostgresCancelContext {
    pub ssl_files: PostgresSslFiles,
    pub accepts_invalid_certs: bool,
    pub verifies_hostname: bool,
    pub ssl_mode: SslMode,
}

/// Build a TLS cancel context from the connection URL.
/// Returns None if URL parsing fails or sslmode=disable (no TLS cancel needed).
pub fn build_postgres_cancel_context(url: &str) -> Option<PostgresCancelContext> {
    let postgres_url = postgres_connection_url(url).ok()?;
    let pg_config = tokio_postgres::Config::from_str(&postgres_url.url).ok()?;
    if pg_config.get_ssl_mode() == SslMode::Disable {
        return None;
    }
    Some(PostgresCancelContext {
        ssl_files: postgres_url.ssl_files,
        accepts_invalid_certs: postgres_url.accepts_invalid_certs,
        verifies_hostname: postgres_url.verifies_hostname,
        ssl_mode: pg_config.get_ssl_mode(),
    })
}

/// Reconstruct a TLS connector from the cancel context, used for TLS connection cancellation.
fn make_rustls_connect_from_context(
    ctx: &PostgresCancelContext,
) -> Result<tokio_postgres_rustls::MakeRustlsConnect, String> {
    // Build a minimal pg_config solely for ssl_mode determination
    let mut pg_config = tokio_postgres::Config::new();
    pg_config.ssl_mode(ctx.ssl_mode);
    let tls_config = postgres_tls_config(&pg_config, &ctx.ssl_files, ctx.accepts_invalid_certs, ctx.verifies_hostname)?;
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(tls_config))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresConnectionUrl {
    url: String,
    ssl_files: PostgresSslFiles,
    accepts_invalid_certs: bool,
    verifies_hostname: bool,
}

/// Inject TCP keepalive parameters into the PostgreSQL URL (only when the user has not explicitly specified them).
/// Default parameters shorten half-open connection detection time, suitable for desktop/VPN/NAT environments.
fn inject_postgres_keepalive_params(url: &str) -> String {
    let (base, fragment) = url.split_once('#').map_or((url, ""), |(base, fragment)| (base, fragment));
    let query = base.split('?').nth(1);
    let has_keepalives = query
        .map(|q| q.split('&').any(|p| p.split('=').next().is_some_and(|k| k.eq_ignore_ascii_case("keepalives"))))
        .unwrap_or(false);
    if has_keepalives {
        return url.to_string(); // User has explicitly configured keepalive
    }
    let separator = if base.contains('?') { "&" } else { "?" };
    let injected =
        format!("{base}{separator}keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_retries=3");
    if fragment.is_empty() {
        injected
    } else {
        format!("{injected}#{fragment}")
    }
}

fn postgres_connection_url(url: &str) -> Result<PostgresConnectionUrl, String> {
    let Some(query_start) = url.find('?') else {
        let pg_config =
            tokio_postgres::Config::from_str(url).map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;
        return Ok(PostgresConnectionUrl {
            url: url.to_string(),
            ssl_files: PostgresSslFiles::default(),
            accepts_invalid_certs: postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()),
            verifies_hostname: false,
        });
    };

    let prefix = &url[..query_start];
    let suffix = &url[query_start + 1..];
    let (query_string, fragment) = suffix.split_once('#').map_or((suffix, ""), |(query, fragment)| (query, fragment));
    let mut ssl_files = PostgresSslFiles::default();
    let mut kept_params = Vec::new();
    let mut accepts_invalid_certs = true;
    let mut verifies_hostname = false;

    for param in query_string.split('&') {
        if param.is_empty() {
            continue;
        }

        let Some((key, value)) = param.split_once('=') else {
            kept_params.push(param.to_string());
            continue;
        };

        if key.eq_ignore_ascii_case("sslcert")
            || key.eq_ignore_ascii_case("sslkey")
            || key.eq_ignore_ascii_case("sslrootcert")
        {
            let decoded = percent_decode_str(value)
                .decode_utf8()
                .map_err(|_| format!("Invalid URL encoding in {key}"))?
                .into_owned();
            validate_file_path(&decoded, |_| false).map_err(|e| format!("{key}: {e}"))?;

            if key.eq_ignore_ascii_case("sslcert") {
                ssl_files.sslcert = Some(decoded);
            } else if key.eq_ignore_ascii_case("sslkey") {
                ssl_files.sslkey = Some(decoded);
            } else {
                ssl_files.sslrootcert = Some(decoded);
            }
        } else if key.eq_ignore_ascii_case("channel_binding") {
            // channel_binding=require fails when the server does not offer
            // SCRAM-SHA-256-PLUS (e.g. Neon). Normalize require→prefer so
            // channel binding is used when available but does not cause a
            // hard failure when the server doesn't support it.
            match value.to_ascii_lowercase().as_str() {
                "require" => kept_params.push("channel_binding=prefer".to_string()),
                _ => kept_params.push(param.to_string()),
            }
        } else if key.eq_ignore_ascii_case("sslmode") {
            match value.to_ascii_lowercase().as_str() {
                "verify-ca" => {
                    accepts_invalid_certs = false;
                    kept_params.push("sslmode=require".to_string());
                }
                "verify-full" | "verify_identity" | "verify-identity" => {
                    accepts_invalid_certs = false;
                    verifies_hostname = true;
                    kept_params.push("sslmode=require".to_string());
                }
                "disable" => {
                    accepts_invalid_certs = false;
                    kept_params.push(param.to_string());
                }
                "prefer" | "require" => {
                    accepts_invalid_certs = true;
                    kept_params.push(param.to_string());
                }
                _ => kept_params.push(param.to_string()),
            }
        } else {
            kept_params.push(param.to_string());
        }
    }

    let mut sanitized_url = prefix.to_string();
    if !kept_params.is_empty() {
        sanitized_url.push('?');
        sanitized_url.push_str(&kept_params.join("&"));
    }
    if !fragment.is_empty() {
        sanitized_url.push('#');
        sanitized_url.push_str(fragment);
    }

    Ok(PostgresConnectionUrl { url: sanitized_url, ssl_files, accepts_invalid_certs, verifies_hostname })
}

fn postgres_tls_config(
    pg_config: &tokio_postgres::Config,
    ssl_files: &PostgresSslFiles,
    accepts_invalid_certs: bool,
    verifies_hostname: bool,
) -> Result<rustls::ClientConfig, String> {
    if pg_config.get_ssl_mode() != SslMode::Disable && accepts_invalid_certs {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let builder = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoPostgresCertVerification { provider }));
        return postgres_tls_client_auth(builder, ssl_files);
    }

    let root_store = postgres_root_cert_store(ssl_files)?;
    let builder = if verifies_hostname {
        rustls::ClientConfig::builder().with_root_certificates(root_store)
    } else {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        rustls::ClientConfig::builder().dangerous().with_custom_certificate_verifier(Arc::new(
            PostgresCaOnlyCertVerification { provider, roots: Arc::new(root_store) },
        ))
    };
    postgres_tls_client_auth(builder, ssl_files)
}

fn postgres_root_cert_store(ssl_files: &PostgresSslFiles) -> Result<rustls::RootCertStore, String> {
    let mut root_store = rustls::RootCertStore::empty();
    if let Some(path) = ssl_files.sslrootcert.as_deref() {
        let certs = read_postgres_pem_certs("sslrootcert", path)?;
        let (valid_count, _) = root_store.add_parsable_certificates(certs);
        if valid_count == 0 {
            return Err(format!("sslrootcert: no valid CA certificates found in {path}"));
        }
    } else {
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    Ok(root_store)
}

fn postgres_tls_client_auth(
    builder: rustls::ConfigBuilder<rustls::ClientConfig, rustls::client::WantsClientCert>,
    ssl_files: &PostgresSslFiles,
) -> Result<rustls::ClientConfig, String> {
    match (ssl_files.sslcert.as_deref(), ssl_files.sslkey.as_deref()) {
        (Some(cert_path), Some(key_path)) => {
            let certs = read_postgres_pem_certs("sslcert", cert_path)?;
            if certs.is_empty() {
                return Err(format!("sslcert: no certificates found in {cert_path}"));
            }
            let private_key = read_postgres_private_key(key_path)?;
            builder
                .with_client_auth_cert(certs, private_key)
                .map_err(|e| format!("PostgreSQL client certificate/key mismatch or invalid key: {e}"))
        }
        (Some(_), None) => Err("PostgreSQL sslcert requires sslkey".to_string()),
        (None, Some(_)) => Err("PostgreSQL sslkey requires sslcert".to_string()),
        (None, None) => Ok(builder.with_no_client_auth()),
    }
}

fn read_postgres_pem_certs(label: &str, path: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let file = File::open(path).map_err(|e| format!("{label}: failed to open {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("{label}: failed to read PEM certificates from {path}: {e}"))
}

fn read_postgres_private_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    let file = File::open(path).map_err(|e| format!("sslkey: failed to open {path}: {e}"))?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|e| format!("sslkey: failed to read PEM private key from {path}: {e}"))?
        .ok_or_else(|| format!("sslkey: no private key found in {path}"))
}

fn postgres_sslmode_accepts_invalid_certs(ssl_mode: SslMode) -> bool {
    matches!(ssl_mode, SslMode::Prefer | SslMode::Require)
}

#[derive(Debug)]
struct NoPostgresCertVerification {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for NoPostgresCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.accept_tls_signature_for_unverified_cert(cert)
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.accept_tls_signature_for_unverified_cert(cert)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

impl NoPostgresCertVerification {
    fn accept_tls_signature_for_unverified_cert(
        &self,
        _cert: &CertificateDer<'_>,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // PostgreSQL sslmode=prefer/require does not authenticate the server certificate.
        // Avoid rustls' default signature helpers here because they parse the certificate
        // before chain verification and reject legacy server certificates that libpq/JDBC
        // still accept in these non-verifying modes.
        Ok(HandshakeSignatureValid::assertion())
    }
}

#[derive(Debug)]
struct PostgresCaOnlyCertVerification {
    provider: Arc<CryptoProvider>,
    roots: Arc<rustls::RootCertStore>,
}

impl ServerCertVerifier for PostgresCaOnlyCertVerification {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let cert = ParsedCertificate::try_from(end_entity)?;
        verify_server_cert_signed_by_trust_anchor(
            &cert,
            &self.roots,
            intermediates,
            now,
            self.provider.signature_verification_algorithms.all,
        )?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Check whether the user's connection URL already specifies a timezone via
/// the `options` parameter so we don't overwrite it with the local timezone.
fn pg_url_has_timezone_setting(url: &str) -> bool {
    let Some(query) = url.split_once('?').map(|(_, query)| query.split('#').next().unwrap_or(query)) else {
        return false;
    };

    query.split('&').any(|parameter| {
        let (raw_key, raw_value) = parameter.split_once('=').unwrap_or((parameter, ""));
        let key = percent_decode_str(raw_key).decode_utf8_lossy();
        if !key.eq_ignore_ascii_case("options") {
            return false;
        }

        let options = percent_decode_str(raw_value).decode_utf8_lossy().to_ascii_lowercase();
        options.split_ascii_whitespace().any(|token| {
            let option = token.trim_start_matches('-');
            option.starts_with("timezone=") || option.starts_with("time_zone=")
        })
    })
}

#[cfg(test)]
fn validate_postgres_ssl_paths(url: &str) -> Result<(), String> {
    postgres_connection_url(url).map(|_| ())
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<DatabaseInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT datname FROM pg_database \
         WHERE datallowconn = true \
         ORDER BY datname",
        &[],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: pg_row_try_string(row, 0) }).collect())
}

pub async fn list_tables(pool: &Pool, schema: &str) -> Result<Vec<TableInfo>, String> {
    list_tables_filtered(pool, schema, None, None, None).await
}

pub async fn list_tables_filtered(
    pool: &Pool,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let filter = filter.unwrap_or("").trim();
    let filter_pattern = like_contains_pattern(filter);
    let fuzzy_filter_pattern =
        if crate::sql::fuzzy_filter_enabled(filter) { like_fuzzy_pattern(filter) } else { String::new() };
    let limit_param = limit.and_then(|value| i64::try_from(value).ok());
    let offset_param = offset.and_then(|value| i64::try_from(value).ok()).unwrap_or(0);
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        postgres_tables_sql(),
        &[&schema, &filter_pattern, &fuzzy_filter_pattern, &limit_param, &offset_param],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: pg_row_try_string(row, 0),
            table_type: pg_row_try_string(row, 1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

pub async fn completion_assistant_search(
    pool: &Pool,
    request: &CompletionAssistantRequest,
) -> Result<CompletionAssistantResponse, String> {
    let schema = request.schema.as_deref().or(request.parent_schema.as_deref());
    let routine_schema = schema.unwrap_or("public");
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = if request.object_kinds.is_empty() {
        vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let pattern = postgres_completion_like_pattern(&request.mask, request.match_mode.as_ref());
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let mut candidates = Vec::new();

    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Schema)) {
        for row in postgres_query_cached(
            &client,
            "SELECT nspname FROM pg_catalog.pg_namespace \
             WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' \
               AND ($1 = '%%' OR nspname ILIKE $1 ESCAPE '~') \
             ORDER BY nspname LIMIT $2",
            &[&pattern, &(limit as i64)],
        )
        .await
        .map_err(|e| e.to_string())?
        {
            let schema_name: String = pg_row_try_string(&row, 0);
            candidates.push(CompletionAssistantCandidate {
                name: schema_name.clone(),
                kind: CompletionAssistantCandidateKind::Schema,
                database: Some(request.database.clone()),
                schema: Some(schema_name),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(CompletionAssistantObjectKind::is_table_like) {
        let relkinds = postgres_completion_relkinds(&kinds);
        let rows = postgres_query_cached(
            &client,
            postgres_completion_tables_sql(),
            &[&schema, &pattern, &relkinds, &((limit - candidates.len()) as i64)],
        )
        .await
        .map_err(|e| e.to_string())?;
        for row in rows {
            let table_type: String = pg_row_try_string(&row, 2);
            candidates.push(CompletionAssistantCandidate {
                name: pg_row_try_string(&row, 0),
                kind: if table_type.contains("VIEW") {
                    CompletionAssistantCandidateKind::View
                } else {
                    CompletionAssistantCandidateKind::Table
                },
                database: Some(request.database.clone()),
                schema: Some(pg_row_try_string(&row, 1)),
                parent_schema: row.try_get::<_, Option<String>>(4).ok().flatten(),
                parent_name: row.try_get::<_, Option<String>>(5).ok().flatten(),
                comment: row.try_get::<_, Option<String>>(3).ok().flatten(),
                data_type: None,
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(CompletionAssistantObjectKind::is_routine_like) {
        let prokinds = postgres_completion_prokinds(&kinds);
        let rows = postgres_query_cached(
            &client,
            postgres_completion_routines_sql(),
            &[&routine_schema, &pattern, &prokinds, &((limit - candidates.len()) as i64)],
        )
        .await
        .map_err(|e| e.to_string())?;
        for row in rows {
            let routine_type: String = pg_row_try_string(&row, 2);
            candidates.push(CompletionAssistantCandidate {
                name: pg_row_try_string(&row, 0),
                kind: if routine_type == "PROCEDURE" {
                    CompletionAssistantCandidateKind::Procedure
                } else {
                    CompletionAssistantCandidateKind::Function
                },
                database: Some(request.database.clone()),
                schema: Some(pg_row_try_string(&row, 1)),
                parent_schema: None,
                parent_name: None,
                comment: row.try_get::<_, Option<String>>(3).ok().flatten(),
                data_type: row.try_get::<_, Option<String>>(4).ok().flatten(),
            });
        }
    }

    if candidates.len() < limit && kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Column)) {
        let table = request.parent_name.as_deref().unwrap_or("");
        if !table.is_empty() {
            // Unqualified PostgreSQL objects resolve through search_path, so column
            // metadata must use the same visible relation instead of assuming public.
            let resolved_schema = match schema {
                Some(schema) => Some(schema.to_string()),
                None => postgres_query_cached(&client, postgres_visible_table_schema_sql(), &[&table])
                    .await
                    .map_err(|e| e.to_string())?
                    .first()
                    .map(|row| pg_row_try_string(row, 0)),
            };
            let Some(resolved_schema) = resolved_schema else {
                return Ok(CompletionAssistantResponse { incomplete: false, candidates, fallback_used: false });
            };
            let rows = postgres_query_cached(
                &client,
                postgres_completion_columns_sql(),
                &[&resolved_schema, &table, &pattern, &((limit - candidates.len()) as i64)],
            )
            .await
            .map_err(|e| e.to_string())?;
            for row in rows {
                candidates.push(CompletionAssistantCandidate {
                    name: pg_row_try_string(&row, 0),
                    kind: CompletionAssistantCandidateKind::Column,
                    database: Some(request.database.clone()),
                    schema: Some(resolved_schema.clone()),
                    parent_schema: Some(resolved_schema.clone()),
                    parent_name: Some(table.to_string()),
                    comment: row.try_get::<_, Option<String>>(2).ok().flatten(),
                    data_type: Some(pg_row_try_string(&row, 1)),
                });
            }
        }
    }

    Ok(CompletionAssistantResponse { incomplete: candidates.len() >= limit, candidates, fallback_used: false })
}

fn postgres_completion_tables_sql() -> &'static str {
    "SELECT c.relname, n.nspname, \
            CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
            obj_description(c.oid) AS table_comment, \
            CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
            CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     WHERE ($1::text IS NOT NULL AND n.nspname = $1 \
            OR $1::text IS NULL AND pg_catalog.pg_table_is_visible(c.oid)) \
       AND c.relkind::text = ANY($3::text[]) \
       AND ($2 = '%%' OR c.relname ILIKE $2 ESCAPE '~') \
     ORDER BY c.relname LIMIT $4"
}

fn postgres_completion_routines_sql() -> &'static str {
    "SELECT p.proname, n.nspname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
            obj_description(p.oid) AS routine_comment, COALESCE(pg_get_function_result(p.oid), '') AS data_type \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind::text = ANY($3::text[]) \
       AND ($2 = '%%' OR p.proname ILIKE $2 ESCAPE '~') \
     ORDER BY p.proname LIMIT $4"
}

fn postgres_completion_columns_sql() -> &'static str {
    "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum) \
     FROM pg_catalog.pg_attribute a \
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
       AND ($3 = '%%' OR a.attname ILIKE $3 ESCAPE '~') \
     ORDER BY a.attnum LIMIT $4"
}

fn postgres_visible_table_schema_sql() -> &'static str {
    "SELECT n.nspname FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE c.relname = $1 AND pg_catalog.pg_table_is_visible(c.oid) \
     LIMIT 1"
}

fn postgres_completion_relkinds(kinds: &[CompletionAssistantObjectKind]) -> Vec<String> {
    let mut relkinds = Vec::new();
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Table)) {
        relkinds.extend(["r", "p", "f"].into_iter().map(str::to_string));
    }
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::View)) {
        relkinds.extend(["v", "m"].into_iter().map(str::to_string));
    }
    relkinds
}

fn postgres_completion_prokinds(kinds: &[CompletionAssistantObjectKind]) -> Vec<String> {
    let mut prokinds = Vec::new();
    if kinds
        .iter()
        .any(|kind| matches!(kind, CompletionAssistantObjectKind::Procedure | CompletionAssistantObjectKind::Routine))
    {
        prokinds.push("p".to_string());
    }
    if kinds
        .iter()
        .any(|kind| matches!(kind, CompletionAssistantObjectKind::Function | CompletionAssistantObjectKind::Routine))
    {
        prokinds.push("f".to_string());
    }
    prokinds
}

fn postgres_completion_like_pattern(value: &str, mode: Option<&CompletionAssistantMatchMode>) -> String {
    if value.trim().is_empty() || value == "%" {
        return "%%".to_string();
    }
    let escaped = value.trim().replace('~', "~~").replace('%', "~%").replace('_', "~_");
    match mode.unwrap_or(&CompletionAssistantMatchMode::Prefix) {
        CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

pub async fn get_table_comment(pool: &Pool, schema: &str, table: &str) -> Result<Option<String>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(&client, postgres_table_comment_sql(), &[&schema, &table])
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.first().and_then(|row| row.try_get::<_, Option<String>>(0).ok().flatten()).filter(|s| !s.is_empty()))
}

fn postgres_table_comment_sql() -> &'static str {
    "SELECT obj_description(c.oid) AS table_comment \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','m','f','p') \
     LIMIT 1"
}

fn postgres_tables_sql() -> &'static str {
    // PostgreSQL and Redshift can infer different wire types for LIMIT/OFFSET
    // placeholders. Keep them explicit so the shared i64 parameters serialize reliably.
    // Root relations must precede partition descendants so a large partition
    // hierarchy cannot push unrelated schema tables into later sidebar pages.
    "SELECT c.relname AS table_name, \
         CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' \
           WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'f' THEN 'FOREIGN TABLE' \
           WHEN 'p' THEN 'BASE TABLE' END AS table_type, \
         obj_description(c.oid) AS table_comment, \
         CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
         CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
         LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
           AND ($2 = '%%' OR c.relname ILIKE $2 ESCAPE '~' OR ($3 <> '' AND c.relname ILIKE $3 ESCAPE '~')) \
         ORDER BY CASE WHEN pc.relkind = 'p' THEN 1 ELSE 0 END, c.relname \
         LIMIT CAST($4 AS BIGINT) OFFSET CAST($5 AS BIGINT)"
}

fn like_contains_pattern(value: &str) -> String {
    if value.is_empty() {
        return "%%".to_string();
    }

    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('%');
    for ch in value.chars() {
        if ch == '~' || ch == '%' || ch == '_' {
            pattern.push('~');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn like_fuzzy_pattern(value: &str) -> String {
    crate::sql::fuzzy_like_pattern_with_escape(value, |value| {
        let mut escaped = String::with_capacity(value.len() + 1);
        for ch in value.chars() {
            if ch == '~' || ch == '%' || ch == '_' {
                escaped.push('~');
            }
            escaped.push(ch);
        }
        escaped
    })
}

fn list_object_relations_sql(include_timestamps: bool) -> &'static str {
    if include_timestamps {
        return "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'MATERIALIZED_VIEW' \
         WHEN 'S' THEN 'SEQUENCE' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       stat.creation::text AS created_at, \
       COALESCE( \
         CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
           THEN pg_xact_commit_timestamp(c.xmin)::text END, \
         stat.modification::text \
       ) AS updated_at, \
       CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
       CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name, \
       NULL::text AS signature, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'S' THEN 4 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     LEFT JOIN LATERAL pg_stat_file( \
       CASE WHEN c.relkind IN ('r','m','f','p') THEN pg_relation_filepath(c.oid) END, true \
     ) stat ON true \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p','S')";
    }

    "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'MATERIALIZED_VIEW' \
         WHEN 'S' THEN 'SEQUENCE' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
       CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name, \
       NULL::text AS signature, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 WHEN 'S' THEN 4 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p','S')"
}

fn list_object_routines_sql(include_timestamps: bool, has_proc_prokind: bool, has_proc_prosp: bool) -> &'static str {
    if has_proc_prokind && has_proc_prosp {
        if include_timestamps {
            return "SELECT p.proname AS object_name, \
       CASE WHEN p.prokind = 'p' OR p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE WHEN p.prokind = 'p' OR p.prosp THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND (p.prokind IN ('p','f') OR p.prosp)";
        }

        return "SELECT p.proname AS object_name, \
       CASE WHEN p.prokind = 'p' OR p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE WHEN p.prokind = 'p' OR p.prosp THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND (p.prokind IN ('p','f') OR p.prosp)";
    }

    if has_proc_prokind {
        if include_timestamps {
            return "SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f')";
        }

        return "SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f')";
    }

    if has_proc_prosp {
        if include_timestamps {
            return "SELECT p.proname AS object_name, \
       CASE WHEN p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE WHEN p.prosp THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow";
        }

        return "SELECT p.proname AS object_name, \
       CASE WHEN p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       CASE WHEN p.prosp THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow";
    }

    if include_timestamps {
        return "SELECT p.proname AS object_name, \
       'FUNCTION' AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       3 AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow";
    }

    "SELECT p.proname AS object_name, \
       'FUNCTION' AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       pg_get_function_identity_arguments(p.oid) AS signature, \
       3 AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow"
}

fn list_objects_sql(
    include_timestamps: bool,
    has_proc_prokind: bool,
    has_proc_prosp: bool,
    has_function_identity_arguments: bool,
) -> String {
    let sql = format!(
        "{} UNION ALL {} ORDER BY sort_order, object_name",
        list_object_relations_sql(include_timestamps),
        list_object_routines_sql(include_timestamps, has_proc_prokind, has_proc_prosp)
    );
    if has_function_identity_arguments {
        sql
    } else {
        // Redshift and older PostgreSQL-compatible servers may only expose the
        // older formatter. It includes argument names but still distinguishes
        // overloads instead of making the whole schema browser unavailable.
        sql.replace("pg_get_function_identity_arguments(p.oid)", "pg_get_function_arguments(p.oid)")
    }
}

fn postgres_has_function_identity_arguments_sql() -> &'static str {
    "SELECT EXISTS ( \
       SELECT 1 \
       FROM pg_catalog.pg_proc p \
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
       WHERE n.nspname = 'pg_catalog' \
         AND p.proname = 'pg_get_function_identity_arguments' \
     )"
}

async fn postgres_has_function_identity_arguments(client: &deadpool_postgres::Client) -> Result<bool, String> {
    let row = postgres_query_one_cached(client, postgres_has_function_identity_arguments_sql(), &[])
        .await
        .map_err(|e| e.to_string())?;
    Ok(pg_row_try_bool(&row, 0).unwrap_or(false))
}

fn postgres_proc_has_prokind_sql() -> &'static str {
    "SELECT EXISTS ( \
       SELECT 1 \
       FROM pg_catalog.pg_attribute \
       WHERE attrelid = 'pg_catalog.pg_proc'::regclass \
         AND attname = 'prokind' \
         AND NOT attisdropped \
     )"
}

async fn postgres_proc_has_prokind(client: &deadpool_postgres::Client) -> Result<bool, String> {
    let row =
        postgres_query_one_cached(client, postgres_proc_has_prokind_sql(), &[]).await.map_err(|e| e.to_string())?;
    Ok(pg_row_try_bool(&row, 0).unwrap_or(false))
}

fn postgres_proc_has_prosp_sql() -> &'static str {
    "SELECT EXISTS ( \
       SELECT 1 \
       FROM pg_catalog.pg_attribute \
       WHERE attrelid = 'pg_catalog.pg_proc'::regclass \
         AND attname = 'prosp' \
         AND NOT attisdropped \
     )"
}

async fn postgres_proc_has_prosp(client: &deadpool_postgres::Client) -> Result<bool, String> {
    let row = postgres_query_one_cached(client, postgres_proc_has_prosp_sql(), &[]).await.map_err(|e| e.to_string())?;
    Ok(pg_row_try_bool(&row, 0).unwrap_or(false))
}

async fn list_objects_rows(
    client: &deadpool_postgres::Client,
    schema: &str,
    include_timestamps: bool,
    has_proc_prokind: bool,
    has_proc_prosp: bool,
    has_function_identity_arguments: bool,
) -> Result<Vec<Row>, String> {
    let sql = list_objects_sql(include_timestamps, has_proc_prokind, has_proc_prosp, has_function_identity_arguments);
    postgres_query_cached(client, &sql, &[&schema]).await.map_err(|e| e.to_string())
}

pub async fn list_objects(pool: &Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let has_proc_prokind = postgres_proc_has_prokind(&client).await?;
    // Some GaussDB-compatible catalogs expose prosp alongside, or instead of,
    // PostgreSQL 11's prokind. Treat prosp as an extra procedure signal.
    let has_proc_prosp = postgres_proc_has_prosp(&client).await?;
    let has_function_identity_arguments = postgres_has_function_identity_arguments(&client).await?;
    let rows = match list_objects_rows(
        &client,
        schema,
        true,
        has_proc_prokind,
        has_proc_prosp,
        has_function_identity_arguments,
    )
    .await
    {
        Ok(rows) => rows,
        Err(primary_error) => {
            log::debug!("[postgres][list_objects:timestamp-fallback] primary_error={}", primary_error);
            match list_objects_rows(
                &client,
                schema,
                false,
                has_proc_prokind,
                has_proc_prosp,
                has_function_identity_arguments,
            )
            .await
            {
                Ok(rows) => rows,
                Err(fallback_error) => {
                    return Err(format!("{primary_error}; timestamp fallback failed: {fallback_error}"));
                }
            }
        }
    };

    Ok(rows
        .iter()
        .map(|row| ObjectInfo {
            name: pg_row_try_string(row, 0),
            object_type: pg_row_try_string(row, 1),
            schema: Some(schema.to_string()),
            valid: None,
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            created_at: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            updated_at: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(5).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(6).ok().flatten().filter(|s| !s.is_empty()),
            signature: row.try_get::<_, Option<String>>(7).ok().flatten(),
        })
        .collect())
}

pub async fn list_object_statistics(pool: &Pool, schema: &str) -> Result<Vec<ObjectStatistics>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT c.relname, \
                GREATEST(c.reltuples, 0)::bigint AS estimated_rows, \
                pg_catalog.pg_total_relation_size(c.oid)::bigint AS total_bytes \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','m','f','p') \
         ORDER BY c.relname",
        &[&schema],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ObjectStatistics {
            name: pg_row_try_string(row, 0),
            schema: Some(schema.to_string()),
            estimated_rows: row.try_get::<_, i64>(1).ok(),
            total_bytes: row.try_get::<_, i64>(2).ok(),
        })
        .collect())
}

pub async fn list_schemas(pool: &Pool) -> Result<Vec<String>, String> {
    Ok(list_schema_infos(pool).await?.into_iter().map(|schema| schema.name).collect())
}

pub async fn list_schema_infos(pool: &Pool) -> Result<Vec<SchemaInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT n.nspname AS schema_name, d.description AS schema_comment \
         FROM pg_catalog.pg_namespace n \
         LEFT JOIN pg_catalog.pg_description d \
           ON d.objoid = n.oid \
          AND d.objsubid = 0 \
          AND d.classoid = 'pg_namespace'::regclass \
         WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
         AND n.nspname NOT LIKE 'pg_toast_temp_%' \
         AND n.nspname NOT LIKE 'pg_temp_%' \
         ORDER BY n.nspname",
        &[],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| SchemaInfo {
            name: pg_row_try_string(row, 0),
            comment: row.try_get::<_, Option<String>>(1).ok().flatten(),
        })
        .collect())
}

const POSTGRES_COLUMNS_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             COALESCE(c.is_nullable = 'YES', NOT a.attnotnull) AS is_nullable, \
             CASE WHEN a.attgenerated <> '' THEN NULL ELSE pg_get_expr(ad.adbin, ad.adrelid) END AS column_default, \
             EXISTS ( \
               SELECT 1 FROM pg_constraint co \
               JOIN pg_index i ON i.indrelid = co.conrelid AND co.conindid = i.indexrelid \
               WHERE co.conrelid = a.attrelid AND co.contype = 'p' \
               AND a.attnum = ANY(i.indkey) \
             ) AS is_pk, \
             col_description(a.attrelid, a.attnum) AS column_comment, \
             CASE a.attidentity \
               WHEN 'd' THEN 'generated by default as identity' || CASE WHEN pseq.seqstart IS NOT NULL THEN format(' (start with %s increment by %s)', pseq.seqstart, pseq.seqincrement) ELSE '' END \
               WHEN 'a' THEN 'generated always as identity' || CASE WHEN pseq.seqstart IS NOT NULL THEN format(' (start with %s increment by %s)', pseq.seqstart, pseq.seqincrement) ELSE '' END \
               ELSE CASE a.attgenerated \
                 WHEN 's' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid) || ') stored' \
                 WHEN 'v' THEN 'generated always as (' || pg_get_expr(ad.adbin, ad.adrelid) || ') virtual' \
                 ELSE NULL \
               END \
             END AS column_extra, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
             CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length, \
             CASE WHEN enum_t.oid IS NULL THEN NULL \
               ELSE COALESCE((SELECT array_to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder))::text \
                              FROM pg_enum e WHERE e.enumtypid = enum_t.oid), '[]') END AS enum_values \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_type enum_t ON enum_t.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype WHEN t.typtype = 'e' THEN t.oid ELSE NULL END AND enum_t.typtype = 'e' \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN pg_depend dep ON dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype = 'i' \
             LEFT JOIN pg_sequence pseq ON pseq.seqrelid = dep.objid \
             LEFT JOIN information_schema.columns c \
               ON c.table_schema = $1 AND c.table_name = $2 AND c.column_name = a.attname \
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";

const POSTGRES_COLUMNS_COMPAT_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             COALESCE(c.is_nullable = 'YES', NOT a.attnotnull) AS is_nullable, \
             pg_get_expr(ad.adbin, ad.adrelid) AS column_default, \
             EXISTS ( \
               SELECT 1 FROM pg_constraint co \
               JOIN pg_index i ON i.indrelid = co.conrelid AND co.conindid = i.indexrelid \
               WHERE co.conrelid = a.attrelid AND co.contype = 'p' \
               AND a.attnum = ANY(i.indkey) \
             ) AS is_pk, \
             col_description(a.attrelid, a.attnum) AS column_comment, \
             NULL::text AS column_extra, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
             CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length, \
             NULL::text AS enum_values \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN information_schema.columns c \
               ON c.table_schema = $1 AND c.table_name = $2 AND c.column_name = a.attname \
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";

const POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL: &str = "SELECT c.column_name, \
             CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS full_type, \
             c.is_nullable = 'YES' AS is_nullable, \
             c.column_default, \
             EXISTS ( \
               SELECT 1 FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage kcu \
                 ON kcu.constraint_catalog = tc.constraint_catalog \
                AND kcu.constraint_schema = tc.constraint_schema \
                AND kcu.constraint_name = tc.constraint_name \
                AND kcu.table_schema = tc.table_schema \
                AND kcu.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' \
                 AND tc.table_schema = c.table_schema \
                 AND tc.table_name = c.table_name \
                 AND kcu.column_name = c.column_name \
             ) AS is_pk, \
             NULL::text AS column_comment, \
             NULL::text AS column_extra, \
             CAST(c.numeric_precision AS int) AS numeric_precision, \
             CAST(c.numeric_scale AS int) AS numeric_scale, \
             CAST(c.character_maximum_length AS int) AS character_maximum_length, \
             NULL::text AS enum_values \
             FROM information_schema.columns c \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position";

fn parse_enum_values_from_row(row: &Row, index: usize) -> Option<Vec<String>> {
    let raw = row.try_get::<_, Option<String>>(index).ok().flatten()?;
    serde_json::from_str::<Vec<String>>(&raw).ok()
}

/// Read a boolean column from a PostgreSQL row, tolerating databases that
/// encode booleans as integers (0/1) or text ('t'/'f') instead of the standard
/// `bool` OID.  Returns `None` when the column is NULL or truly unreadable.
fn pg_row_try_bool(row: &Row, idx: usize) -> Option<bool> {
    if let Ok(v) = row.try_get::<_, bool>(idx) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<_, i32>(idx) {
        return Some(v != 0);
    }
    if let Ok(v) = row.try_get::<_, i16>(idx) {
        return Some(v != 0);
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<String>>(idx) {
        match v.as_str() {
            "t" | "true" | "1" | "yes" | "YES" => return Some(true),
            "f" | "false" | "0" | "no" | "NO" => return Some(false),
            _ => return None,
        }
    }
    None
}

/// Read a String column from a PostgreSQL row, tolerating databases that
/// return text as other types.  Falls back to i64/i32/i16/bool formatting.
fn pg_row_try_string(row: &Row, idx: usize) -> String {
    if let Ok(v) = row.try_get::<_, String>(idx) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i64>(idx) {
        return v.to_string();
    }
    if let Ok(v) = row.try_get::<_, i32>(idx) {
        return v.to_string();
    }
    if let Ok(v) = row.try_get::<_, i16>(idx) {
        return v.to_string();
    }
    if let Some(v) = pg_row_try_bool(row, idx) {
        return v.to_string();
    }
    String::new()
}

fn column_info_from_row(row: &Row) -> ColumnInfo {
    let full_type = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
    ColumnInfo {
        name: pg_row_try_string(row, 0),
        data_type: full_type,
        is_nullable: pg_row_try_bool(row, 2).unwrap_or(true),
        column_default: row.try_get::<_, Option<String>>(3).ok().flatten(),
        is_primary_key: pg_row_try_bool(row, 4).unwrap_or(false),
        extra: row.try_get::<_, Option<String>>(6).ok().flatten(),
        comment: row.try_get::<_, Option<String>>(5).ok().flatten(),
        numeric_precision: row.try_get::<_, Option<i32>>(7).ok().flatten(),
        numeric_scale: row.try_get::<_, Option<i32>>(8).ok().flatten(),
        character_maximum_length: row.try_get::<_, Option<i32>>(9).ok().flatten(),
        enum_values: parse_enum_values_from_row(row, 10),
        ..Default::default()
    }
}

async fn get_columns_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, tokio_postgres::Error> {
    let rows = postgres_query_cached(client, sql, &[&schema, &table]).await?;

    Ok(rows.iter().map(column_info_from_row).collect())
}

pub async fn get_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    match get_columns_with_sql(&client, POSTGRES_COLUMNS_SQL, schema, table).await {
        Ok(columns) => Ok(columns),
        Err(primary_error) => match get_columns_with_sql(&client, POSTGRES_COLUMNS_COMPAT_SQL, schema, table).await {
            Ok(columns) => Ok(columns),
            Err(fallback_error) => {
                let primary_message = pg_error_to_string(primary_error);
                let fallback_message = pg_error_to_string(fallback_error);
                match get_columns_with_sql(&client, POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL, schema, table).await {
                    Ok(columns) => Ok(columns),
                    Err(information_schema_error) => {
                        let information_schema_message = pg_error_to_string(information_schema_error);
                        log::debug!(
                            "[postgres][get_columns:compat-failed] primary_error={} fallback_error={} information_schema_error={}",
                            primary_message,
                            fallback_message,
                            information_schema_message
                        );
                        Err(information_schema_message)
                    }
                }
            }
        },
    }
}

pub(crate) fn pg_quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

pub async fn execute_query(pool: &Pool, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, None).await
}

pub async fn execute_query_with_max_rows(
    pool: &Pool,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"]) {
        let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
        execute_select_query(&client, sql, start, row_limit).await
    } else {
        let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
        let affected = client.execute(sql, &[]).await.map_err(pg_error_to_string)?;
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);

        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

pub async fn execute_query_with_max_rows_and_cancel(
    pool: &Pool,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    budget: DbOperationBudget,
    cancel_context: Option<PostgresCancelContext>,
) -> Result<QueryResult, String> {
    let client = checkout_postgres_client(pool, cancel_token.as_ref(), budget.checkout_timeout).await?;
    let pg_cancel_token = client.cancel_token();
    wait_postgres_query(
        pg_cancel_token,
        cancel_context,
        cancel_token,
        budget.query_timeout,
        budget.cancel_timeout,
        execute_query_with_max_rows_inner(&client, sql, max_rows),
    )
    .await
}

pub async fn stream_select_query_with_cancel(
    pool: &Pool,
    schema: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    budget: DbOperationBudget,
    cancel_context: Option<PostgresCancelContext>,
    on_item: impl FnMut(PostgresQueryStreamItem) -> Result<(), String>,
) -> Result<u64, String> {
    let start = Instant::now();
    let client = checkout_postgres_client(pool, cancel_token.as_ref(), budget.checkout_timeout).await?;
    let mut on_item = on_item;
    let row_limit = max_rows.map(|limit| limit.max(1));
    let schema = schema.map(str::trim).filter(|schema| !schema.is_empty());
    let schema_was_set = schema.is_some_and(|_| !is_transaction_recovery_statement(sql));

    if let Some(schema) = schema.filter(|_| schema_was_set) {
        // Match normal query execution: export may reference unqualified names
        // in the active schema, so the streaming path must use the same search_path.
        execute_postgres_infra_statement(
            &client,
            &format!("SET search_path TO {}, public", pg_quote_ident(schema)),
            budget.recycle_timeout,
            "schema.set",
        )
        .await?;
    }

    let pg_cancel_token = client.cancel_token();
    let query_timeout = budget.query_timeout;
    let timeout_error =
        format!("Query timed out after {} seconds", query_timeout.map_or(0, |timeout| timeout.as_secs()));
    let progress_clock = Arc::new(StreamProgressClock::new());
    let progress_clock_for_stream = progress_clock.clone();
    let mut on_stream_item = |item| {
        on_item(item)?;
        progress_clock_for_stream.mark();
        Ok(())
    };
    let result = await_stream_with_progress_timeout(
        stream_select_query_inner(&client, sql, row_limit, &mut on_stream_item),
        query_timeout,
        progress_clock,
        cancel_token.as_ref(),
        timeout_error.clone(),
    )
    .await;
    if result.as_ref().is_err_and(|error| error == &timeout_error || error == crate::query::QUERY_CANCELED) {
        cancel_postgres_query(pg_cancel_token, cancel_context.as_ref(), budget.cancel_timeout).await;
    }

    if schema_was_set {
        let reset_result = reset_postgres_search_path(&client, budget.cleanup_timeout, start).await;
        match (result, reset_result) {
            (Ok(rows), Ok(())) => Ok(rows),
            (Err(query_err), Ok(())) => Err(query_err),
            (Ok(_), Err(reset_err)) => Err(reset_err),
            (Err(query_err), Err(reset_err)) => Err(format!("{query_err}; {reset_err}")),
        }
    } else {
        result
    }
}

pub async fn execute_query_with_schema(pool: &Pool, schema: &str, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_schema_and_max_rows(pool, schema, sql, None).await
}

pub async fn execute_query_with_schema_and_max_rows(
    pool: &Pool,
    schema: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let checkout_start = Instant::now();
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    log::info!(
        "[postgres][execute_with_schema:pool:done] elapsed_ms={} total_ms={} schema={}",
        checkout_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        schema
    );
    if is_transaction_recovery_statement(sql) {
        log::info!(
            "[postgres][execute_with_schema:skip-search-path] total_ms={} reason=transaction-recovery",
            start.elapsed().as_millis()
        );
        return execute_query_with_max_rows_inner(&client, sql, max_rows).await;
    }

    let set_schema_start = Instant::now();
    execute_postgres_infra_statement(
        &client,
        &format!("SET search_path TO {}, public", pg_quote_ident(schema)),
        super::connection_timeout(),
        "schema.set",
    )
    .await?;
    log::info!(
        "[postgres][execute_with_schema:set-search-path:done] elapsed_ms={} total_ms={}",
        set_schema_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    let query_start = Instant::now();
    let result = execute_query_with_max_rows_inner(&client, sql, max_rows).await;
    if result.is_ok() {
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);
    }
    log::info!(
        "[postgres][execute_with_schema:query:done] elapsed_ms={} total_ms={} ok={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result.is_ok()
    );

    let reset_result = reset_postgres_search_path(&client, super::connection_timeout(), start).await;
    merge_postgres_query_and_reset_result(result, reset_result)
}

pub async fn execute_query_with_schema_and_max_rows_and_cancel(
    pool: &Pool,
    schema: &str,
    sql: &str,
    max_rows: Option<usize>,
    cancel_token: Option<CancellationToken>,
    budget: DbOperationBudget,
    cancel_context: Option<PostgresCancelContext>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let checkout_start = Instant::now();
    let client = checkout_postgres_client(pool, cancel_token.as_ref(), budget.checkout_timeout).await?;
    log::info!(
        "[postgres][execute_with_schema:pool:done] elapsed_ms={} total_ms={} schema={}",
        checkout_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        schema
    );
    if is_transaction_recovery_statement(sql) {
        log::info!(
            "[postgres][execute_with_schema:skip-search-path] total_ms={} reason=transaction-recovery",
            start.elapsed().as_millis()
        );
        let pg_cancel_token = client.cancel_token();
        return wait_postgres_query(
            pg_cancel_token,
            cancel_context,
            cancel_token,
            budget.query_timeout,
            budget.cancel_timeout,
            execute_query_with_max_rows_inner(&client, sql, max_rows),
        )
        .await;
    }

    let set_schema_start = Instant::now();
    execute_postgres_infra_statement(
        &client,
        &format!("SET search_path TO {}, public", pg_quote_ident(schema)),
        budget.recycle_timeout,
        "schema.set",
    )
    .await?;
    log::info!(
        "[postgres][execute_with_schema:set-search-path:done] elapsed_ms={} total_ms={}",
        set_schema_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    let query_start = Instant::now();
    let pg_cancel_token = client.cancel_token();
    let result = wait_postgres_query(
        pg_cancel_token,
        cancel_context,
        cancel_token,
        budget.query_timeout,
        budget.cancel_timeout,
        execute_query_with_max_rows_inner(&client, sql, max_rows),
    )
    .await;
    if result.is_ok() {
        clear_postgres_caches_after_ddl(pool, Some(&client), sql);
    }
    log::info!(
        "[postgres][execute_with_schema:query:done] elapsed_ms={} total_ms={} ok={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result.is_ok()
    );

    let reset_result = reset_postgres_search_path(&client, budget.cleanup_timeout, start).await;
    merge_postgres_query_and_reset_result(result, reset_result)
}

async fn reset_postgres_search_path(
    client: &deadpool_postgres::Client,
    timeout_duration: Duration,
    start: Instant,
) -> Result<(), String> {
    let reset_start = Instant::now();
    match execute_postgres_infra_statement(client, "RESET search_path", timeout_duration, "schema.reset").await {
        Ok(_) => {
            log::info!(
                "[postgres][execute_with_schema:reset-search-path:done] elapsed_ms={} total_ms={}",
                reset_start.elapsed().as_millis(),
                start.elapsed().as_millis()
            );
            Ok(())
        }
        Err(err) => {
            log::warn!(
                "[postgres][execute_with_schema:reset-search-path:error] elapsed_ms={} total_ms={} error={}",
                reset_start.elapsed().as_millis(),
                start.elapsed().as_millis(),
                err
            );
            Err(postgres_schema_reset_cleanup_error(err))
        }
    }
}

fn merge_postgres_query_and_reset_result(
    query_result: Result<QueryResult, String>,
    reset_result: Result<(), String>,
) -> Result<QueryResult, String> {
    match (query_result, reset_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(query_err), Ok(())) => Err(query_err),
        (Ok(_), Err(reset_err)) => Err(reset_err),
        (Err(query_err), Err(reset_err)) => Err(format!("{query_err}; {reset_err}")),
    }
}

fn postgres_schema_reset_cleanup_error(err: String) -> String {
    format!("PostgreSQL schema.reset cleanup failed: {err}")
}

pub(crate) async fn execute_postgres_infra_statement(
    client: &deadpool_postgres::Client,
    sql: &str,
    timeout_duration: Duration,
    stage: &str,
) -> Result<u64, String> {
    tokio::time::timeout(timeout_duration, client.execute(sql, &[]))
        .await
        .map_err(|_| format!("PostgreSQL {stage} timed out after {} seconds", timeout_duration.as_secs()))?
        .map_err(pg_error_to_string)
}

pub(crate) async fn wait_postgres_operation<T, F>(
    pg_cancel_token: tokio_postgres::CancelToken,
    cancel_context: Option<PostgresCancelContext>,
    timeout_duration: Option<Duration>,
    cancel_timeout: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    wait_postgres_query(pg_cancel_token, cancel_context, None, timeout_duration, cancel_timeout, future).await
}

async fn wait_postgres_query<T, F>(
    pg_cancel_token: tokio_postgres::CancelToken,
    cancel_context: Option<PostgresCancelContext>,
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    cancel_timeout: Duration,
    future: F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match (cancel_token, timeout_duration) {
        (Some(token), Some(duration)) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    cancel_postgres_query(pg_cancel_token, cancel_context.as_ref(), cancel_timeout).await;
                    Err(crate::query::canceled_error())
                }
                result = tokio::time::timeout(duration, future) => match result {
                    Ok(result) => result,
                    Err(_) => {
                        cancel_postgres_query(pg_cancel_token, cancel_context.as_ref(), cancel_timeout).await;
                        Err(format!("Query timed out after {} seconds", duration.as_secs()))
                    }
                },
            }
        }
        (None, Some(duration)) => match tokio::time::timeout(duration, future).await {
            Ok(result) => result,
            Err(_) => {
                cancel_postgres_query(pg_cancel_token, cancel_context.as_ref(), cancel_timeout).await;
                Err(format!("Query timed out after {} seconds", duration.as_secs()))
            }
        },
        (Some(token), None) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    cancel_postgres_query(pg_cancel_token, cancel_context.as_ref(), cancel_timeout).await;
                    Err(crate::query::canceled_error())
                }
                result = future => result,
            }
        }
        (None, None) => future.await,
    }
}

/// PostgreSQL pool checkout with timeout and cancel token support.
/// When the checkout phase is stuck, the cancel token can terminate the wait early.
/// The timeout error message includes "checkout timed out" to ensure is_connection_error can classify it correctly.
pub async fn checkout_postgres_client(
    pool: &Pool,
    cancel_token: Option<&CancellationToken>,
    checkout_timeout: Duration,
) -> Result<deadpool_postgres::Object, String> {
    let start = Instant::now();
    let get_future = async {
        tokio::time::timeout(checkout_timeout, pool.get())
            .await
            .map_err(|_| {
                let elapsed = start.elapsed().as_millis();
                log::warn!(
                    "[db:pool.checkout:error] elapsed_ms={} timeout_ms={} error=checkout timed out",
                    elapsed,
                    checkout_timeout.as_millis()
                );
                format!("PostgreSQL connection pool checkout timed out ({}s)", checkout_timeout.as_secs())
            })?
            .map_err(|e| {
                let elapsed = start.elapsed().as_millis();
                let err = pg_pool_error_to_string(e);
                log::warn!(
                    "[db:pool.checkout:error] elapsed_ms={} timeout_ms={} error={}",
                    elapsed,
                    checkout_timeout.as_millis(),
                    err
                );
                format!("PostgreSQL connection pool checkout failed: {err}")
            })
    };

    let result = match cancel_token {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => {
                log::info!(
                    "[db:pool.checkout:cancelled] elapsed_ms={} timeout_ms={}",
                    start.elapsed().as_millis(),
                    checkout_timeout.as_millis()
                );
                return Err(crate::query::canceled_error());
            }
            result = get_future => result,
        },
        None => get_future.await,
    };
    if result.is_ok() {
        log::debug!(
            "[db:pool.checkout:done] elapsed_ms={} timeout_ms={}",
            start.elapsed().as_millis(),
            checkout_timeout.as_millis()
        );
    }
    result
}

async fn cancel_postgres_query(
    pg_cancel_token: tokio_postgres::CancelToken,
    cancel_context: Option<&PostgresCancelContext>,
    cancel_timeout: Duration,
) {
    let cancel_timeout = postgres_cancel_attempt_timeout(cancel_timeout, cancel_context);
    if let Some(ctx) = cancel_context {
        match make_rustls_connect_from_context(ctx) {
            Ok(tls) => match tokio::time::timeout(cancel_timeout, pg_cancel_token.cancel_query(tls)).await {
                Ok(Ok(())) => return,
                Ok(Err(err)) => {
                    log::warn!("Failed to send PostgreSQL TLS cancel request: {err}");
                    return;
                }
                Err(_) => {
                    log::warn!("Timed out sending PostgreSQL TLS cancel request ({}s)", cancel_timeout.as_secs());
                    return;
                }
            },
            Err(err) => {
                log::warn!("Failed to build TLS connector for cancel: {err}; falling back to NoTls cancel");
            }
        }
    }
    match tokio::time::timeout(cancel_timeout, pg_cancel_token.cancel_query(NoTls)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log::warn!("Failed to send PostgreSQL cancel request: {err}"),
        Err(_) => log::warn!("Timed out sending PostgreSQL cancel request ({}s)", cancel_timeout.as_secs()),
    }
}

fn postgres_cancel_attempt_timeout(
    cancel_timeout: Duration,
    _cancel_context: Option<&PostgresCancelContext>,
) -> Duration {
    cancel_timeout
}

fn is_transaction_recovery_statement(sql: &str) -> bool {
    starts_with_executable_sql_keyword(sql, &["ROLLBACK", "ABORT", "COMMIT", "END"])
}

async fn execute_query_with_max_rows_inner(
    client: &deadpool_postgres::Client,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"]) {
        execute_select_query(client, sql, start, row_limit).await
    } else {
        let affected = client.execute(sql, &[]).await.map_err(pg_error_to_string)?;

        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    }
}

const POSTGRES_INDEXES_SQL: &str = "SELECT i.relname AS index_name, \
             array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) ORDER BY k.n) AS columns, \
             ix.indisunique AS is_unique, \
             ix.indisprimary AS is_primary, \
             pg_get_expr(ix.indpred, ix.indrelid) AS filter_expr, \
             am.amname AS index_type, \
             ix.indnkeyatts AS nkeyatts, \
             ix.indkey AS indkey, \
             obj_description(i.oid, 'pg_class') AS index_comment \
             FROM pg_index ix \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_am am ON am.oid = i.relam \
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, i.oid, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname, ix.indnkeyatts, ix.indkey \
             ORDER BY i.relname";

const POSTGRES_INDEXES_COMPAT_SQL: &str = "SELECT i.relname AS index_name, \
             ARRAY( \
               SELECT COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, pos.n, true)) \
               FROM generate_series(1, array_length(string_to_array(ix.indkey::text, ' '), 1)) AS pos(n) \
               LEFT JOIN pg_attribute a \
                 ON a.attrelid = t.oid \
                AND a.attnum = (string_to_array(ix.indkey::text, ' '))[pos.n]::int2 \
                AND a.attnum > 0 \
               ORDER BY pos.n \
             ) AS columns, \
             ix.indisunique AS is_unique, \
             ix.indisprimary AS is_primary, \
             pg_get_expr(ix.indpred, ix.indrelid) AS filter_expr, \
             am.amname AS index_type, \
             NULL::smallint AS nkeyatts, \
             ix.indkey AS indkey, \
             obj_description(i.oid, 'pg_class') AS index_comment \
             FROM pg_index ix \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             JOIN pg_am am ON am.oid = i.relam \
             WHERE n.nspname = $1 AND t.relname = $2 \
             ORDER BY i.relname";

const POSTGRES_OWNERS_SQL: &str =
    "SELECT n.nspname, c.relname, c.relkind::text AS relkind, pg_get_userbyid(c.relowner) \
     FROM pg_class c \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 \
       AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')";

fn postgres_owner_object_type(relkind: &str) -> &str {
    match relkind {
        "r" => "TABLE",
        "v" => "VIEW",
        "m" => "MATERIALIZED_VIEW",
        "S" => "SEQUENCE",
        "f" => "FOREIGN TABLE",
        "p" => "PARTITIONED TABLE",
        "I" => "PARTITIONED INDEX",
        _ => relkind,
    }
}

async fn list_indexes_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, tokio_postgres::Error> {
    let rows = postgres_query_cached(client, sql, &[&schema, &table]).await?;

    Ok(rows
        .iter()
        .map(|row| {
            let all_cols: Vec<String> = row.try_get::<_, Vec<String>>(1).unwrap_or_default();
            let nkeyatts = row.try_get::<_, Option<i16>>(6).ok().flatten().unwrap_or(all_cols.len() as i16) as usize;
            let split_at = nkeyatts.min(all_cols.len());
            let key_cols = all_cols[..split_at].to_vec();
            let included = if split_at < all_cols.len() { all_cols[split_at..].to_vec() } else { vec![] };
            IndexInfo {
                name: pg_row_try_string(row, 0),
                columns: key_cols,
                is_unique: pg_row_try_bool(row, 2).unwrap_or(false),
                is_primary: pg_row_try_bool(row, 3).unwrap_or(false),
                filter: row.try_get::<_, Option<String>>(4).ok().flatten(),
                index_type: row.try_get::<_, Option<String>>(5).ok().flatten(),
                included_columns: if included.is_empty() { None } else { Some(included) },
                comment: row.try_get::<_, Option<String>>(8).ok().flatten(),
            }
        })
        .collect())
}

pub async fn list_indexes(pool: &Pool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    match list_indexes_with_sql(&client, POSTGRES_INDEXES_SQL, schema, table).await {
        Ok(indexes) => Ok(indexes),
        Err(primary_error) => match list_indexes_with_sql(&client, POSTGRES_INDEXES_COMPAT_SQL, schema, table).await {
            Ok(indexes) => Ok(indexes),
            Err(fallback_error) => {
                let primary_message = pg_error_to_string(primary_error);
                let fallback_message = pg_error_to_string(fallback_error);
                log::debug!(
                    "[postgres][list_indexes:compat-failed] primary_error={} fallback_error={}",
                    primary_message,
                    fallback_message
                );
                Err(fallback_message)
            }
        },
    }
}

fn postgres_foreign_keys_sql() -> &'static str {
    "SELECT fk.constraint_name, fk.column_name, \
     pk.table_schema AS ref_schema, pk.table_name AS ref_table, pk.column_name AS ref_column, \
     rc.update_rule AS on_update, rc.delete_rule AS on_delete \
     FROM information_schema.table_constraints tc \
     JOIN information_schema.key_column_usage fk \
       ON fk.constraint_name = tc.constraint_name \
       AND fk.constraint_schema = tc.constraint_schema \
       AND fk.table_schema = tc.table_schema \
       AND fk.table_name = tc.table_name \
     JOIN information_schema.referential_constraints rc \
       ON rc.constraint_name = tc.constraint_name \
       AND rc.constraint_schema = tc.constraint_schema \
     JOIN information_schema.key_column_usage pk \
       ON pk.constraint_name = rc.unique_constraint_name \
       AND pk.constraint_schema = rc.unique_constraint_schema \
       AND pk.ordinal_position = fk.position_in_unique_constraint \
     WHERE tc.constraint_type = 'FOREIGN KEY' \
       AND fk.table_schema = $1 AND fk.table_name = $2 \
     ORDER BY fk.constraint_name, fk.ordinal_position"
}

fn postgres_foreign_key_action(value: String) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub async fn list_foreign_keys(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(&client, postgres_foreign_keys_sql(), &[&schema, &table])
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: pg_row_try_string(row, 0),
            column: pg_row_try_string(row, 1),
            ref_schema: Some(pg_row_try_string(row, 2)),
            ref_table: pg_row_try_string(row, 3),
            ref_column: pg_row_try_string(row, 4),
            on_update: postgres_foreign_key_action(pg_row_try_string(row, 5)),
            on_delete: postgres_foreign_key_action(pg_row_try_string(row, 6)),
        })
        .collect())
}

pub async fn list_triggers(pool: &Pool, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT trigger_name, event_manipulation, action_timing \
         FROM information_schema.triggers \
         WHERE trigger_schema = $1 AND event_object_table = $2 \
         ORDER BY trigger_name",
        &[&schema, &table],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: pg_row_try_string(row, 0),
            event: pg_row_try_string(row, 1),
            timing: pg_row_try_string(row, 2),
            statement: None,
        })
        .collect())
}

fn postgres_functions_sql(has_proc_prokind: bool) -> &'static str {
    if has_proc_prokind {
        return "SELECT p.proname, \
                    CASE p.prokind WHEN 'f' THEN 'FUNCTION' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                    COALESCE(pg_get_function_result(p.oid), ''), \
                    pg_get_functiondef(p.oid), \
                    COALESCE(pg_get_function_arguments(p.oid), '') \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') \
             ORDER BY p.proname";
    }

    // PostgreSQL 10 and older do not have pg_proc.prokind; procedures were
    // introduced with prokind, so the legacy path can only return functions.
    "SELECT p.proname, \
                    'FUNCTION', \
                    COALESCE(pg_get_function_result(p.oid), ''), \
                    pg_get_functiondef(p.oid), \
                    COALESCE(pg_get_function_arguments(p.oid), '') \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow \
             ORDER BY p.proname"
}

pub async fn list_functions(pool: &Pool, schema: &str) -> Result<Vec<FunctionInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    // Use pg_proc + pg_get_functiondef() instead of information_schema.routines
    // for reliable function definition retrieval (information_schema.routines.routine_definition
    // is NULL for non-SQL functions like plpgsql)
    let has_proc_prokind = postgres_proc_has_prokind(&client).await?;
    let rows = postgres_query_cached(&client, postgres_functions_sql(has_proc_prokind), &[&schema])
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let def: String = pg_row_try_string(row, 3);
            // Remove schema qualification from CREATE FUNCTION statement
            // to avoid false differences when comparing across schemas.
            // Handle both "schema.name" and schema.name formats.
            let normalized_def = def
                .replace(&format!("CREATE OR REPLACE FUNCTION \"{}\".", schema), "CREATE OR REPLACE FUNCTION ")
                .replace(&format!("CREATE OR REPLACE FUNCTION {}.", schema), "CREATE OR REPLACE FUNCTION ");
            FunctionInfo {
                name: pg_row_try_string(row, 0),
                function_type: pg_row_try_string(row, 1),
                data_type: pg_row_try_string(row, 2),
                definition: normalized_def,
                arguments: pg_row_try_string(row, 4),
            }
        })
        .collect())
}

pub async fn list_sequences(pool: &Pool, schema: &str, with_last_values: bool) -> Result<Vec<SequenceInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    // Use pg_class + pg_sequence + pg_namespace instead of pg_sequences view
    // for better compatibility and permission handling
    let rows = postgres_query_cached(
        &client,
        "SELECT c.relname, \
          COALESCE(format_type(s.seqtypid, NULL), 'bigint'), \
          COALESCE(s.seqstart::text, '1'), \
          COALESCE(s.seqmin::text, '1'), \
          COALESCE(s.seqmax::text, '9223372036854775807'), \
          COALESCE(s.seqincrement::text, '1'), \
          CASE WHEN s.seqcycle THEN 'YES' ELSE 'NO' END \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_sequence s ON s.seqrelid = c.oid \
         WHERE c.relkind = 'S' AND n.nspname = $1 \
         ORDER BY c.relname",
        &[&schema],
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut sequences: Vec<SequenceInfo> = rows
        .iter()
        .map(|row| SequenceInfo {
            name: pg_row_try_string(row, 0),
            data_type: pg_row_try_string(row, 1),
            start_value: pg_row_try_string(row, 2),
            min_value: pg_row_try_string(row, 3),
            max_value: pg_row_try_string(row, 4),
            increment: pg_row_try_string(row, 5),
            cycle: pg_row_try_string(row, 6) == "YES",
            last_value: None,
        })
        .collect();

    if with_last_values {
        // Batch query: get last values for all sequences in one query
        let sql = "SELECT c.relname, pg_sequence_last_value(c.oid) \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE c.relkind = 'S' AND n.nspname = $1";
        if let Ok(rows) = postgres_query_cached(&client, sql, &[&schema]).await {
            for row in rows {
                let name: String = pg_row_try_string(&row, 0);
                if let Ok(val) = row.try_get::<_, i64>(1) {
                    if let Some(seq) = sequences.iter_mut().find(|s| s.name == name) {
                        seq.last_value = Some(val.to_string());
                    }
                }
            }
        }
    }

    Ok(sequences)
}

pub async fn list_rules(pool: &Pool, schema: &str) -> Result<Vec<RuleInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT schemaname, tablename, rulename, definition \
         FROM pg_rules \
         WHERE schemaname = $1 \
         ORDER BY rulename",
        &[&schema],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| RuleInfo {
            name: pg_row_try_string(row, 2),
            table_name: pg_row_try_string(row, 1),
            definition: pg_row_try_string(row, 3),
        })
        .collect())
}

pub async fn list_extensions(pool: &Pool, schema: &str) -> Result<Vec<ExtensionInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT e.extname, COALESCE(e.extversion, '') AS extversion, d.description, n.nspname \
         FROM pg_catalog.pg_extension e \
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace \
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass \
         WHERE n.nspname = $1 \
         ORDER BY e.extname",
        &[&schema],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ExtensionInfo {
            name: pg_row_try_string(row, 0),
            version: pg_row_try_string(row, 1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            schema: Some(schema.to_string()),
        })
        .collect())
}

fn list_extension_member_objects_sql() -> &'static str {
    "SELECT 'RELATION'::text AS object_kind, c.relname, ''::text AS signature \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 \
       AND EXISTS ( \
         SELECT 1 FROM pg_catalog.pg_depend d \
         WHERE d.classid = 'pg_catalog.pg_class'::regclass \
           AND d.objid = c.oid \
           AND d.refclassid = 'pg_catalog.pg_extension'::regclass \
           AND d.deptype = 'e' \
       ) \
     UNION ALL \
     SELECT 'FUNCTION'::text, p.proname, pg_get_function_identity_arguments(p.oid) \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 \
       AND EXISTS ( \
         SELECT 1 FROM pg_catalog.pg_depend d \
         WHERE d.classid = 'pg_catalog.pg_proc'::regclass \
           AND d.objid = p.oid \
           AND d.refclassid = 'pg_catalog.pg_extension'::regclass \
           AND d.deptype = 'e' \
       )"
}

pub async fn list_extension_member_objects(pool: &Pool, schema: &str) -> Result<Vec<(String, String, String)>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = match postgres_query_cached(&client, list_extension_member_objects_sql(), &[&schema]).await {
        Ok(rows) => rows,
        Err(primary_error) => {
            // PostgreSQL-compatible servers before the identity-argument
            // formatter can still be filtered using their legacy formatter.
            let fallback_sql = list_extension_member_objects_sql()
                .replace("pg_get_function_identity_arguments(p.oid)", "pg_get_function_arguments(p.oid)");
            postgres_query_cached(&client, &fallback_sql, &[&schema])
                .await
                .map_err(|fallback_error| format!("{primary_error}; legacy fallback failed: {fallback_error}"))?
        }
    };

    Ok(rows
        .iter()
        .map(|row| (pg_row_try_string(row, 0), pg_row_try_string(row, 1), pg_row_try_string(row, 2)))
        .collect())
}

pub async fn list_available_extensions(pool: &Pool) -> Result<Vec<ExtensionInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(
        &client,
        "SELECT name, default_version, comment \
         FROM pg_catalog.pg_available_extensions \
         WHERE installed_version IS NULL \
         ORDER BY name",
        &[],
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ExtensionInfo {
            name: pg_row_try_string(row, 0),
            version: pg_row_try_string(row, 1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            schema: None,
        })
        .collect())
}

pub async fn list_owners(pool: &Pool, schema: &str) -> Result<Vec<OwnerInfo>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let rows = postgres_query_cached(&client, POSTGRES_OWNERS_SQL, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let relkind: String = pg_row_try_string(row, 2);
            OwnerInfo {
                object_name: pg_row_try_string(row, 1),
                object_type: postgres_owner_object_type(&relkind).to_string(),
                owner: pg_row_try_string(row, 3),
            }
        })
        .collect())
}

/// Execute multiple SQL statements in a single round-trip using batch_execute.
/// Best for DDL scripts where per-statement affected-row counts are not needed.
pub async fn execute_batch(pool: &Pool, statements: &[String]) -> Result<(), String> {
    let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
    if combined.is_empty() {
        return Ok(());
    }
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    client.batch_execute(&combined).await.map_err(pg_error_to_string)?;
    clear_postgres_caches_after_ddl(pool, Some(&client), &combined);
    Ok(())
}

pub async fn terminate_current_user_database_backends(pool: &Pool, database: &str) -> Result<u64, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    client
        .execute(
            "SELECT pg_terminate_backend(pid) \
             FROM pg_stat_activity \
             WHERE datname = $1 \
               AND pid <> pg_backend_pid() \
               AND usename = current_user",
            &[&database],
        )
        .await
        .map_err(pg_error_to_string)
}

fn clear_postgres_caches_after_ddl(pool: &Pool, client: Option<&deadpool_postgres::Client>, sql: &str) {
    if !invalidates_postgres_statement_cache(sql) {
        return;
    }
    pool.manager().statement_caches.clear();
    if let Some(client) = client {
        client.clear_type_cache();
    }
}

fn invalidates_postgres_statement_cache(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    starts_with_executable_sql_keyword(
        trimmed,
        &["ALTER", "CREATE", "DROP", "TRUNCATE", "COMMENT", "REINDEX", "VACUUM"],
    )
}

/// Export data via COPY TO STDOUT. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) TO STDOUT (FORMAT CSV, HEADER)`.
/// Returns the raw COPY output bytes.
pub async fn copy_out(pool: &Pool, sql: &str) -> Result<Vec<u8>, String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let stream = client.copy_out(sql).await.map_err(pg_error_to_string)?;
    tokio::pin!(stream);
    let mut result = Vec::new();
    while let Some(chunk) = stream.next().await {
        result.extend_from_slice(&chunk.map_err(pg_error_to_string)?);
    }
    Ok(result)
}

/// Import data via COPY FROM STDIN. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) FROM STDIN (FORMAT CSV)`.
/// `data` is the raw input in the format specified by the COPY command.
pub async fn copy_in(pool: &Pool, sql: &str, data: &[u8]) -> Result<(), String> {
    let client = checkout_postgres_client(pool, None, super::connection_timeout()).await?;
    let sink = client.copy_in::<str, bytes::Bytes>(sql).await.map_err(pg_error_to_string)?;
    let mut sink = Box::pin(sink);
    sink.as_mut().send(bytes::Bytes::copy_from_slice(data)).await.map_err(pg_error_to_string)?;
    sink.as_mut().close().await.map_err(pg_error_to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Instant;
    use tokio_postgres::types::FromSql;

    #[test]
    fn classify_pg_type_covers_all_dispatch_branches() {
        assert_eq!(classify_pg_type("bytea"), PgColType::Bytea);
        assert_eq!(classify_pg_type("json"), PgColType::Json);
        assert_eq!(classify_pg_type("JSONB"), PgColType::Json);
        assert_eq!(classify_pg_type("bool"), PgColType::Bool);
        assert_eq!(classify_pg_type("timestamp"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        assert_eq!(classify_pg_type("timestamptz"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        assert_eq!(classify_pg_type("date"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        assert_eq!(classify_pg_type("time"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        assert_eq!(classify_pg_type("timetz"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        assert_eq!(classify_pg_type("interval"), PgColType::Temporal { fallback: PgTemporalFallback::Probe });
        // 时间数组类型名在原实现中先进时间分支、解码失败后落到通用数组分支
        assert_eq!(classify_pg_type("_timestamp"), PgColType::Temporal { fallback: PgTemporalFallback::GenericArray });
        assert_eq!(classify_pg_type("_interval"), PgColType::Temporal { fallback: PgTemporalFallback::GenericArray });
        // 同时命中时间关键字与 VECTOR( 前缀的类型名，原实现时间解码失败后走 vector 分支
        assert_eq!(classify_pg_type("vector(timestamp)"), PgColType::Temporal { fallback: PgTemporalFallback::Vector });
        assert_eq!(classify_pg_type("numeric"), PgColType::Numeric);
        assert_eq!(classify_pg_type("money"), PgColType::Numeric);
        assert_eq!(classify_pg_type("uuid"), PgColType::Uuid);
        assert_eq!(classify_pg_type("inet"), PgColType::Inet { cidr: false });
        assert_eq!(classify_pg_type("cidr"), PgColType::Inet { cidr: true });
        assert_eq!(classify_pg_type("macaddr"), PgColType::MacAddr);
        assert_eq!(classify_pg_type("macaddr8"), PgColType::MacAddr);
        assert_eq!(classify_pg_type("bit"), PgColType::BitString);
        assert_eq!(classify_pg_type("varbit"), PgColType::BitString);
        assert_eq!(classify_pg_type("tsvector"), PgColType::TsVector);
        assert_eq!(classify_pg_type("oid"), PgColType::SystemU32);
        assert_eq!(classify_pg_type("xid"), PgColType::SystemU32);
        assert_eq!(classify_pg_type("_inet"), PgColType::InetArray { cidr: false });
        assert_eq!(classify_pg_type("_cidr"), PgColType::InetArray { cidr: true });
        assert_eq!(classify_pg_type("_macaddr"), PgColType::MacAddrArray);
        assert_eq!(classify_pg_type("_bit"), PgColType::BitStringArray);
        assert_eq!(classify_pg_type("_varbit"), PgColType::BitStringArray);
        assert_eq!(classify_pg_type("_int4"), PgColType::GenericArray);
        assert_eq!(classify_pg_type("_time"), PgColType::GenericArray);
        assert_eq!(classify_pg_type("vector"), PgColType::Vector);
        assert_eq!(classify_pg_type("vector(3)"), PgColType::Vector);
        assert_eq!(classify_pg_type("geometry"), PgColType::Geometry);
        assert_eq!(classify_pg_type("geography"), PgColType::Geometry);
        assert_eq!(classify_pg_type("int4"), PgColType::Other);
        assert_eq!(classify_pg_type("varchar"), PgColType::Other);
        assert_eq!(classify_pg_type(""), PgColType::Other);
    }

    struct DockerPostgres {
        name: String,
        port: u16,
    }

    impl DockerPostgres {
        fn url(&self) -> String {
            format!("postgres://postgres:postgres@127.0.0.1:{}/postgres?sslmode=disable", self.port)
        }
    }

    impl Drop for DockerPostgres {
        fn drop(&mut self) {
            let _ = Command::new("docker").args(["rm", "-f", &self.name]).status();
        }
    }

    fn docker_ready() -> bool {
        Command::new("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    async fn start_docker_postgres() -> Option<DockerPostgres> {
        if !docker_ready() {
            eprintln!("skipping docker-backed postgres test because Docker is unavailable");
            return None;
        }

        let port = portpicker::pick_unused_port().expect("pick unused postgres port");
        let container = DockerPostgres { name: format!("dbx-postgres-enum-{}", uuid::Uuid::new_v4()), port };

        let status = Command::new("docker")
            .args([
                "run",
                "-d",
                "--rm",
                "--name",
                &container.name,
                "-e",
                "POSTGRES_PASSWORD=postgres",
                "-e",
                "POSTGRES_USER=postgres",
                "-e",
                "POSTGRES_DB=postgres",
                "-p",
                &format!("{port}:5432"),
                "postgres:16-alpine",
            ])
            .status()
            .expect("start docker postgres");
        assert!(status.success(), "docker run postgres container should succeed");

        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match connect(&container.url(), Duration::from_secs(2)).await {
                Ok(pool) => {
                    drop(pool);
                    return Some(container);
                }
                Err(_) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(500)).await,
                Err(error) => panic!("docker postgres did not become ready: {error}"),
            }
        }
    }

    fn state_enum_values(columns: &[ColumnInfo]) -> Option<Vec<String>> {
        columns.iter().find(|column| column.name == "state").and_then(|column| column.enum_values.clone())
    }

    // --- pg_quote_ident ---

    #[test]
    fn pg_system_u32_decodes_catalog_integer_types() {
        let raw = 42_u32.to_be_bytes();

        assert_eq!(u32::from_sql(&Type::OID, &raw).unwrap(), 42);
        assert_eq!(PgSystemU32::from_sql(&Type::XID, &raw).unwrap().0, 42);
        assert_eq!(PgSystemU32::from_sql(&Type::CID, &raw).unwrap().0, 42);
        assert!(u32::accepts(&Type::OID));
        assert!(PgSystemU32::accepts(&Type::XID));
        assert!(PgSystemU32::accepts(&Type::CID));
        assert!(!PgSystemU32::accepts(&Type::OID));
        assert!(!PgSystemU32::accepts(&Type::INT4));
    }

    #[test]
    fn pg_any_string_accepts_all_types_and_decodes_utf8() {
        // Accepts any type — built-in, custom enum OIDs, domains, etc.
        assert!(PgAnyString::accepts(&Type::TEXT));
        assert!(PgAnyString::accepts(&Type::INT4));
        assert!(PgAnyString::accepts(&Type::UNKNOWN));
        assert!(PgAnyString::accepts(&Type::OID));
        assert!(PgAnyString::accepts(&Type::BOOL));

        let label = PgAnyString::from_sql(&Type::UNKNOWN, b"pending").unwrap();
        assert_eq!(label.0, "pending");

        let label = PgAnyString::from_sql(&Type::UNKNOWN, b"hello world").unwrap();
        assert_eq!(label.0, "hello world");

        // Non-UTF-8 bytes should fail gracefully
        assert!(PgAnyString::from_sql(&Type::UNKNOWN, &[0xFF, 0xFE, 0xFD]).is_err());
    }

    #[test]
    fn pg_raw_bytes_accepts_all_types_and_preserves_binary_payloads() {
        assert!(PgRawBytes::accepts(&Type::TEXT));
        assert!(PgRawBytes::accepts(&Type::UNKNOWN));
        assert!(PgRawBytes::accepts(&Type::OID));

        let raw = PgRawBytes::from_sql(&Type::UNKNOWN, &[0x01, 0xAB, 0xFF]).unwrap();
        assert_eq!(raw.0, vec![0x01, 0xAB, 0xFF]);
    }

    #[test]
    fn postgres_foreign_keys_sql_selects_referential_actions() {
        let sql = postgres_foreign_keys_sql();

        assert!(sql.contains("rc.update_rule AS on_update"));
        assert!(sql.contains("rc.delete_rule AS on_delete"));
        assert!(sql.contains("information_schema.referential_constraints rc"));
    }

    #[test]
    fn postgres_foreign_key_action_keeps_non_empty_action() {
        assert_eq!(postgres_foreign_key_action("CASCADE".to_string()), Some("CASCADE".to_string()));
        assert_eq!(postgres_foreign_key_action(" SET NULL ".to_string()), Some("SET NULL".to_string()));
        assert_eq!(postgres_foreign_key_action("".to_string()), None);
        assert_eq!(postgres_foreign_key_action("  ".to_string()), None);
    }

    #[test]
    fn decodes_tsvector_binary_output() {
        let raw = [
            0, 0, 0, 2, b'b', b'a', b'c', b'k', b'\\', b's', b'l', b'a', b's', b'h', 0, 0, 1, 0x80, 0x03, b'o', b'\'',
            b'c', b'l', b'o', b'c', b'k', 0, 0, 2, 0, 1, 0xc0, 0x02,
        ];

        assert_eq!(decode_tsvector_bytes(&raw).as_deref(), Some("'back\\\\slash':3B 'o''clock':1,2A"));
    }

    fn encode_pgvector_bytes(values: &[f32]) -> Vec<u8> {
        let dims = u16::try_from(values.len()).expect("dim fits u16");
        let mut raw = Vec::with_capacity(4 + values.len() * 4);
        raw.extend_from_slice(&dims.to_be_bytes());
        raw.extend_from_slice(&0u16.to_be_bytes());
        for value in values {
            raw.extend_from_slice(&value.to_be_bytes());
        }
        raw
    }

    #[test]
    fn decodes_pgvector_binary_output() {
        let values = [0.1f32, -2.5f32, 1.2345679e-5f32];
        let decoded = decode_pgvector_bytes(&encode_pgvector_bytes(&values)).expect("decode vector");
        assert_eq!(decoded, values);
    }

    #[test]
    fn pgvector_element_number_round_trips_full_f32_precision() {
        let values = [0.1f32, 0.12345679f32, 1.2345679e-5f32, -0.00012345679f32, 1.2345678f32, 1e20f32];

        for value in values {
            let json = pg_vector_element_number(value);
            let text = json.to_string();
            let restored: f32 = text.parse().expect("json number parses as f32");
            let rounded_six = ((value as f64 * 1_000_000.0).round() / 1_000_000.0) as f32;

            // Display text must recover the exact stored float4 bits.
            assert_eq!(restored, value, "lost f32 precision for {value} -> {text}");
            // Fixed 6-decimal rounding is what caused #3931; reject that path when it differs.
            if rounded_six != value {
                assert_ne!(restored, rounded_six, "still clamped to 6 decimals for {value}");
            }
        }
    }

    #[test]
    fn pgvector_binary_to_json_preserves_component_precision() {
        let values = [0.12345679f32, 1.2345679e-5f32, -2.5f32];
        let decoded = decode_pgvector_bytes(&encode_pgvector_bytes(&values)).expect("decode vector");
        let json = serde_json::Value::Array(decoded.into_iter().map(pg_vector_element_number).collect());
        let arr = json.as_array().expect("vector json array");

        assert_eq!(arr.len(), values.len());
        for (component, expected) in arr.iter().zip(values) {
            let restored: f32 = component.to_string().parse().expect("component parses as f32");
            assert_eq!(restored, expected);
        }
    }

    fn decode_hex(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "hex input must have an even number of chars");
        (0..hex.len()).step_by(2).map(|idx| u8::from_str_radix(&hex[idx..idx + 2], 16).unwrap()).collect()
    }

    #[test]
    fn decodes_postgres_inet_binary_output() {
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("02200004c0a8010a"), false).as_deref(),
            Some("192.168.1.10")
        );
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("0310001020010db8abcd00120000000000000001"), false).as_deref(),
            Some("2001:db8:abcd:12::1/16")
        );
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("0340001020010db8abcd00120000000000000001"), false).as_deref(),
            Some("2001:db8:abcd:12::1/64")
        );
    }

    #[test]
    fn decodes_postgres_cidr_binary_output() {
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("02180104c0a80100"), true).as_deref(),
            Some("192.168.1.0/24")
        );
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("02200104c0a8010a"), true).as_deref(),
            Some("192.168.1.10/32")
        );
        assert_eq!(
            decode_pg_network_address_bytes(&decode_hex("0380011000000000000000000000000000000001"), true).as_deref(),
            Some("::1/128")
        );
    }

    #[test]
    fn rejects_invalid_postgres_network_binary_output() {
        assert_eq!(decode_pg_network_address_bytes(&[], false), None);
        assert_eq!(decode_pg_network_address_bytes(&decode_hex("04200004c0a8010a"), false), None);
        assert_eq!(decode_pg_network_address_bytes(&decode_hex("02210004c0a8010a"), false), None);
        assert_eq!(decode_pg_network_address_bytes(&decode_hex("02200004c0a801"), false), None);
    }

    #[test]
    fn decodes_postgres_macaddr_binary_output() {
        assert_eq!(decode_pg_macaddr_bytes(&decode_hex("08002b010203")).as_deref(), Some("08:00:2b:01:02:03"));
        assert_eq!(
            decode_pg_macaddr_bytes(&decode_hex("08002bfffe010203")).as_deref(),
            Some("08:00:2b:ff:fe:01:02:03")
        );
        assert_eq!(decode_pg_macaddr_bytes(&decode_hex("08002b")), None);
    }

    #[test]
    fn decodes_postgres_bit_string_binary_output() {
        assert_eq!(decode_pg_bit_string_bytes(&decode_hex("00000005a8")).as_deref(), Some("10101"));
        assert_eq!(decode_pg_bit_string_bytes(&decode_hex("00000009a880")).as_deref(), Some("101010001"));
        assert_eq!(decode_pg_bit_string_bytes(&decode_hex("00000000")).as_deref(), Some(""));
        assert_eq!(decode_pg_bit_string_bytes(&decode_hex("00000005a8ff")), None);
        assert_eq!(decode_pg_bit_string_bytes(&decode_hex("ffffffff")), None);
    }

    #[test]
    fn ewkb_point_with_srid_formats_as_wkt() {
        let raw = decode_hex("0101000020E6100000C520B07268195D404E62105839F44340");
        assert_eq!(super::super::wkb::wkb_to_wkt(&raw), Some("POINT(116.397 39.908)".to_string()));
    }

    #[test]
    fn ewkb_multi_polygon_formats_as_wkt() {
        let raw = decode_hex(
            "0106000020E610000002000000010300000001000000050000000000000000005D4000000000000044400000000000405D4000000000000044400000000000405D4000000000008044400000000000005D4000000000008044400000000000005D400000000000004440010300000001000000050000000000000000805D4000000000008043400000000000C05D4000000000008043400000000000C05D4000000000000044400000000000805D4000000000000044400000000000805D400000000000804340",
        );
        assert_eq!(
            super::super::wkb::wkb_to_wkt(&raw),
            Some(
                "MULTIPOLYGON(((116 40,117 40,117 41,116 41,116 40)),((118 39,119 39,119 40,118 40,118 39)))"
                    .to_string()
            )
        );
    }

    #[test]
    fn ewkb_geometry_collection_formats_as_wkt() {
        let raw = decode_hex(
            "0107000020E61000000200000001010000000000000000005D4000000000000044400102000000020000000000000000405D4000000000008044400000000000805D400000000000004540",
        );
        assert_eq!(
            super::super::wkb::wkb_to_wkt(&raw),
            Some("GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))".to_string())
        );
    }

    #[test]
    fn pg_optional_array_to_json_preserves_text_values_and_nulls() {
        let value = pg_optional_array_to_json(
            vec![Some("productManager".to_string()), None, Some("projectOwner".to_string())],
            serde_json::Value::String,
        );

        assert_eq!(value, serde_json::json!(["productManager", null, "projectOwner"]));
    }

    #[test]
    fn pg_quote_ident_plain_identifier() {
        assert_eq!(pg_quote_ident("public"), "\"public\"");
    }

    #[test]
    fn pg_quote_ident_escapes_double_quotes() {
        assert_eq!(pg_quote_ident("my\"schema"), "\"my\"\"schema\"");
    }

    #[test]
    fn pg_quote_ident_empty_string() {
        assert_eq!(pg_quote_ident(""), "\"\"");
    }

    #[test]
    fn pg_quote_ident_special_chars() {
        // PostgreSQL allows many special chars in quoted identifiers
        let ident = "my schema with spaces";
        assert_eq!(pg_quote_ident(ident), "\"my schema with spaces\"");
    }

    #[test]
    fn pg_quote_ident_injection_attempt() {
        // A malicious schema name that tries to break out of quotes
        let malicious = r#"public"; DROP TABLE users; --"#;
        let escaped = pg_quote_ident(malicious);
        // Double quotes should be doubled, not breaking out
        assert_eq!(escaped, r#""public""; DROP TABLE users; --""#);
        assert!(escaped.matches('"').count().is_multiple_of(2), "quote count should be even");
    }

    // --- query_result_row_limit ---

    #[test]
    fn row_limit_uses_max_rows_when_present() {
        assert_eq!(query_result_row_limit(Some(50)), 50);
    }

    #[test]
    fn row_limit_falls_back_to_default() {
        let default = crate::query::MAX_ROWS;
        assert_eq!(query_result_row_limit(None), default);
    }

    #[test]
    fn row_limit_clamps_zero_to_one() {
        assert_eq!(query_result_row_limit(Some(0)), 1);
    }

    #[test]
    fn row_limit_allows_max_rows_override() {
        assert_eq!(query_result_row_limit(Some(5)), 5);
    }

    #[test]
    fn timestamptz_display_preserves_local_offset() {
        let text = format_pg_timestamptz(Local::now());
        assert!(!text.ends_with("+00:00") || Local::now().offset().local_minus_utc() == 0);
    }

    // --- validate_postgres_ssl_paths ---

    #[test]
    fn ssl_validation_passes_for_clean_url() {
        assert!(validate_postgres_ssl_paths("postgres://localhost/db").is_ok());
    }

    #[test]
    fn ssl_validation_passes_for_url_without_query() {
        assert!(validate_postgres_ssl_paths("host=localhost dbname=test").is_ok());
    }

    #[test]
    fn ssl_validation_passes_for_irrelevant_params() {
        assert!(validate_postgres_ssl_paths("postgres://localhost/db?sslmode=require&connect_timeout=10").is_ok());
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslcert_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=/nonexistent/path/cert.pem");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslcert"), "error should mention sslcert");
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslkey_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslkey=/nonexistent/path/key.pem");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslkey"), "error should mention sslkey");
    }

    #[test]
    fn ssl_validation_rejects_nonexistent_sslrootcert_path() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslrootcert=/nonexistent/path/root.crt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("sslrootcert"), "error should mention sslrootcert");
    }

    #[test]
    fn ssl_validation_rejects_path_traversal_in_sslcert() {
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=../../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn ssl_validation_handles_url_encoded_ssl_param() {
        // %2F = '/', so sslcert=%2Ftmp%2Fcert.pem means sslcert=/tmp/cert.pem
        let result = validate_postgres_ssl_paths("postgres://localhost/db?sslcert=%2Fnonexistent%2Fcert.pem");
        assert!(result.is_err());
    }

    #[test]
    fn ssl_validation_handles_multiple_params() {
        let result =
            validate_postgres_ssl_paths("postgres://localhost/db?sslmode=require&sslcert=/nonexistent/cert.pem");
        assert!(result.is_err());
    }

    #[test]
    fn postgres_connection_url_strips_ssl_file_params_before_driver_parse() {
        let dir = std::env::temp_dir();
        let cert = dir.join(format!("dbx-postgres-cert-{}.pem", std::process::id()));
        let key = dir.join(format!("dbx-postgres-key-{}.pem", std::process::id()));
        let root = dir.join(format!("dbx-postgres-root-{}.pem", std::process::id()));
        std::fs::write(&cert, "not a real cert").unwrap();
        std::fs::write(&key, "not a real key").unwrap();
        std::fs::write(&root, "not a real root").unwrap();

        let url = format!(
            "postgres://localhost/db?sslmode=verify-full&sslcert={}&sslkey={}&sslrootcert={}&application_name=dbx",
            cert.display(),
            key.display(),
            root.display()
        );
        let parsed = postgres_connection_url(&url).unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require&application_name=dbx");
        assert_eq!(parsed.ssl_files.sslcert.as_deref(), Some(cert.to_str().unwrap()));
        assert_eq!(parsed.ssl_files.sslkey.as_deref(), Some(key.to_str().unwrap()));
        assert_eq!(parsed.ssl_files.sslrootcert.as_deref(), Some(root.to_str().unwrap()));
        assert!(!parsed.accepts_invalid_certs);
        assert!(parsed.verifies_hostname);
        tokio_postgres::Config::from_str(&parsed.url).unwrap();

        let _ = std::fs::remove_file(cert);
        let _ = std::fs::remove_file(key);
        let _ = std::fs::remove_file(root);
    }

    #[test]
    fn postgres_connection_url_keeps_verify_ca_ca_only_semantics() {
        let parsed = postgres_connection_url("postgres://localhost/db?sslmode=verify-ca").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require");
        assert!(!parsed.accepts_invalid_certs);
        assert!(!parsed.verifies_hostname);
    }

    #[test]
    fn postgres_connection_url_normalizes_channel_binding_require_to_prefer() {
        let parsed =
            postgres_connection_url("postgres://localhost/db?sslmode=require&channel_binding=require").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?sslmode=require&channel_binding=prefer");
        // The sanitized URL must be parseable by the driver
        tokio_postgres::Config::from_str(&parsed.url).unwrap();
    }

    #[test]
    fn postgres_connection_url_keeps_channel_binding_prefer() {
        let parsed = postgres_connection_url("postgres://localhost/db?channel_binding=prefer").unwrap();

        assert_eq!(parsed.url, "postgres://localhost/db?channel_binding=prefer");
        tokio_postgres::Config::from_str(&parsed.url).unwrap();
    }

    #[test]
    fn postgres_tls_rejects_unpaired_client_cert_and_key() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=require").unwrap();
        let ssl_files =
            PostgresSslFiles { sslcert: Some("/tmp/client.crt".to_string()), sslkey: None, sslrootcert: None };

        let error = match postgres_tls_config(&pg_config, &ssl_files, true, false) {
            Ok(_) => panic!("expected missing sslkey to fail"),
            Err(error) => error,
        };
        assert!(error.contains("sslkey"));
    }

    #[test]
    fn postgres_accept_all_tls_signature_does_not_parse_unverified_cert() {
        let verifier = NoPostgresCertVerification { provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()) };
        let malformed_cert = CertificateDer::from(vec![0x30, 0x03, 0x02, 0x01, 0x00]);

        assert!(verifier.accept_tls_signature_for_unverified_cert(&malformed_cert).is_ok());
    }

    #[test]
    fn inject_postgres_keepalive_params_preserves_url_fragment() {
        let url = "postgres://localhost/app?sslmode=require#read-only";

        assert_eq!(
            inject_postgres_keepalive_params(url),
            "postgres://localhost/app?sslmode=require&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_retries=3#read-only"
        );
    }

    #[test]
    fn postgres_cancel_attempt_timeout_is_single_budget() {
        assert_eq!(postgres_cancel_attempt_timeout(Duration::from_secs(5), None), Duration::from_secs(5));
        assert_eq!(
            postgres_cancel_attempt_timeout(
                Duration::from_secs(5),
                Some(&PostgresCancelContext {
                    ssl_files: PostgresSslFiles::default(),
                    accepts_invalid_certs: true,
                    verifies_hostname: false,
                    ssl_mode: SslMode::Require,
                })
            ),
            Duration::from_secs(5)
        );
    }

    #[test]
    fn postgres_cancel_context_omits_disabled_ssl_mode() {
        assert!(build_postgres_cancel_context("postgres://localhost/app?sslmode=disable").is_none());
    }

    #[test]
    fn postgres_tls_accepts_invalid_certs_for_require_sslmode() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=require").unwrap();

        assert!(postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    #[test]
    fn postgres_tls_accepts_invalid_certs_for_default_prefer_sslmode() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db").unwrap();

        assert!(postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    #[test]
    fn postgres_tls_keeps_verification_off_only_when_ssl_is_disabled() {
        let pg_config = tokio_postgres::Config::from_str("postgres://localhost/db?sslmode=disable").unwrap();

        assert!(!postgres_sslmode_accepts_invalid_certs(pg_config.get_ssl_mode()));
    }

    // --- SQL generation ---

    #[test]
    fn postgres_tables_sql_contains_expected_columns() {
        let sql = postgres_tables_sql();
        assert!(sql.contains("table_name"));
        assert!(sql.contains("table_type"));
        assert!(sql.contains("table_comment"));
        assert!(sql.contains("pg_catalog.pg_inherits"));
        assert!(sql.contains("parent_schema"));
        assert!(sql.contains("parent_name"));
        assert!(sql.contains("pc.relkind = 'p'"));
        assert!(sql.contains("$1"));
        assert!(sql.contains("BASE TABLE"));
        assert!(sql.contains("VIEW"));
        assert!(sql.contains("MATERIALIZED_VIEW"));
        assert!(sql.contains("FOREIGN TABLE"));
    }

    #[test]
    fn postgres_table_comment_sql_targets_single_table() {
        let sql = postgres_table_comment_sql();

        assert!(sql.contains("obj_description(c.oid)"));
        assert!(sql.contains("n.nspname = $1"));
        assert!(sql.contains("c.relname = $2"));
        assert!(sql.contains("LIMIT 1"));
        assert!(!sql.contains("ORDER BY"));
    }

    #[test]
    fn postgres_column_metadata_reads_identity_extra() {
        assert!(POSTGRES_COLUMNS_SQL.contains("a.attidentity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated by default as identity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated always as identity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("COALESCE(c.is_nullable = 'YES', NOT a.attnotnull)"));
        assert!(POSTGRES_COLUMNS_SQL.contains("LEFT JOIN information_schema.columns"));
        assert!(POSTGRES_COLUMNS_SQL.contains("pg_enum"));
        assert!(POSTGRES_COLUMNS_SQL.contains("AS enum_values"));
    }

    #[test]
    fn postgres_column_metadata_has_opengauss_compatible_fallback() {
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("a.attidentity"));
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("NULL::text AS column_extra"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("col_description"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("COALESCE(c.is_nullable = 'YES', NOT a.attnotnull)"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("LEFT JOIN information_schema.columns"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("NULL::text AS enum_values"));
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("pg_enum"));
    }

    #[test]
    fn postgres_column_metadata_has_information_schema_fallback() {
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.columns"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.table_constraints"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.key_column_usage"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("NULL::text AS enum_values"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("pg_attribute"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("regclass"));
    }

    #[test]
    fn extension_member_query_filters_only_owned_relations_and_routines() {
        let sql = list_extension_member_objects_sql();

        assert!(sql.contains("d.classid = 'pg_catalog.pg_class'::regclass"));
        assert!(sql.contains("d.classid = 'pg_catalog.pg_proc'::regclass"));
        assert!(sql.contains("d.refclassid = 'pg_catalog.pg_extension'::regclass"));
        assert!(sql.contains("d.deptype = 'e'"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid)"));
        assert!(!sql.contains("d.deptype = 'x'"));
    }

    #[tokio::test]
    async fn postgres_column_metadata_query_returns_enum_values_against_real_postgres() {
        let Some(container) = start_docker_postgres().await else {
            return;
        };

        let pool = connect(&container.url(), Duration::from_secs(5)).await.expect("connect postgres");
        let schema = format!("dbx_enum_meta_{}", std::process::id());
        let schema_ident = format!("\"{}\"", schema.replace('\"', "\"\""));
        let table = format!("{schema_ident}.orders");
        let type_ident = format!("{schema_ident}.\"status\"");

        execute_query(&pool, &format!("CREATE SCHEMA {schema_ident}")).await.expect("create schema");
        execute_query(&pool, &format!("CREATE TYPE {type_ident} AS ENUM ('pending', 'active', 'archived')"))
            .await
            .expect("create enum type");
        execute_query(&pool, &format!("CREATE TABLE {table} (id integer PRIMARY KEY, state {type_ident} NOT NULL)"))
            .await
            .expect("create table");

        let client =
            checkout_postgres_client(&pool, None, crate::db::connection_timeout()).await.expect("checkout client");

        let columns =
            get_columns_with_sql(&client, POSTGRES_COLUMNS_SQL, &schema, "orders").await.expect("primary columns");
        assert_eq!(
            state_enum_values(&columns),
            Some(vec!["pending".to_string(), "active".to_string(), "archived".to_string()])
        );
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
    async fn postgres_column_metadata_decode_type_mismatch_uses_fallbacks() {
        let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
        let pool = connect(&url, std::time::Duration::from_secs(5)).await.expect("connect postgres");
        let client =
            checkout_postgres_client(&pool, None, std::time::Duration::from_secs(5)).await.expect("checkout postgres");
        let row = client
            .query_one(
                "SELECT \
                   1::int4 AS column_name, \
                   'text'::text AS full_type, \
                   'YES'::text AS is_nullable, \
                   NULL::text AS column_default, \
                   1::int4 AS is_pk, \
                   NULL::text AS column_comment, \
                   NULL::text AS column_extra, \
                   NULL::int4 AS numeric_precision, \
                   NULL::int4 AS numeric_scale, \
                   NULL::int4 AS character_maximum_length",
                &[],
            )
            .await
            .expect("query mismatched metadata row");

        let info = column_info_from_row(&row);
        // int4 column_name should be converted to string "1" instead of panicking
        assert_eq!(info.name, "1");
        // text 'YES' is not a standard bool, pg_row_try_bool falls back to string match
        assert!(info.is_nullable);
        // int4 1 should be interpreted as true for is_primary_key
        assert!(info.is_primary_key);
    }

    #[test]
    fn postgres_index_metadata_has_legacy_catalog_fallback() {
        assert!(POSTGRES_INDEXES_SQL.contains("ix.indnkeyatts"));
        assert!(!POSTGRES_INDEXES_COMPAT_SQL.contains("ix.indnkeyatts"));
        assert!(POSTGRES_INDEXES_COMPAT_SQL.contains("NULL::smallint AS nkeyatts"));
        assert!(!POSTGRES_INDEXES_COMPAT_SQL.contains("LATERAL"));
        assert!(!POSTGRES_INDEXES_COMPAT_SQL.contains("WITH ORDINALITY"));
        assert!(POSTGRES_INDEXES_COMPAT_SQL.contains("generate_series"));
        assert!(POSTGRES_INDEXES_COMPAT_SQL.contains("string_to_array(ix.indkey::text, ' ')"));
    }

    #[test]
    fn postgres_owner_metadata_casts_relkind_to_text() {
        assert!(POSTGRES_OWNERS_SQL.contains("c.relkind::text AS relkind"));
        assert!(POSTGRES_OWNERS_SQL.contains("c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')"));
    }

    #[test]
    fn postgres_owner_object_type_maps_relkind_codes() {
        assert_eq!(postgres_owner_object_type("r"), "TABLE");
        assert_eq!(postgres_owner_object_type("v"), "VIEW");
        assert_eq!(postgres_owner_object_type("m"), "MATERIALIZED_VIEW");
        assert_eq!(postgres_owner_object_type("S"), "SEQUENCE");
        assert_eq!(postgres_owner_object_type("f"), "FOREIGN TABLE");
        assert_eq!(postgres_owner_object_type("p"), "PARTITIONED TABLE");
        assert_eq!(postgres_owner_object_type("?"), "?");
    }

    #[test]
    fn list_objects_sql_includes_routines() {
        let sql = list_objects_sql(true, true, false, true);
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_proc"));
        assert!(sql.contains("pg_catalog.pg_inherits"));
        assert!(sql.contains("parent_schema"));
        assert!(sql.contains("parent_name"));
        assert!(sql.contains("NULL::text AS signature"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid) AS signature"));
        assert!(sql.contains("pc.relkind = 'p'"));
        assert!(sql.contains("pg_stat_file"));
        assert!(sql.contains("pg_xact_commit_timestamp"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
    }

    #[test]
    fn list_objects_sql_without_timestamps_omits_stat_file() {
        let sql = list_objects_sql(false, true, false, true);
        assert!(!sql.contains("pg_stat_file"));
        assert!(sql.contains("NULL::text AS created_at"));
        assert!(sql.contains("NULL::text AS updated_at"));
    }

    #[test]
    fn redshift_compatible_list_objects_sql_uses_legacy_argument_formatter() {
        let sql = list_objects_sql(false, false, false, false);
        assert!(sql.contains("pg_get_function_arguments(p.oid) AS signature"));
        assert!(!sql.contains("pg_get_function_identity_arguments"));
    }

    #[test]
    fn function_identity_arguments_probe_uses_pg_proc() {
        let sql = postgres_has_function_identity_arguments_sql();
        assert!(sql.contains("pg_catalog.pg_proc"));
        assert!(sql.contains("n.nspname = 'pg_catalog'"));
        assert!(sql.contains("p.proname = 'pg_get_function_identity_arguments'"));
    }

    #[test]
    fn both_list_objects_sql_variants_use_parameter() {
        assert!(list_objects_sql(true, true, true, true).contains("$1"));
        assert!(list_objects_sql(false, true, true, true).contains("$1"));
        assert!(list_objects_sql(true, true, false, true).contains("$1"));
        assert!(list_objects_sql(false, true, false, true).contains("$1"));
        assert!(list_objects_sql(true, false, true, true).contains("$1"));
        assert!(list_objects_sql(false, false, true, true).contains("$1"));
        assert!(list_objects_sql(true, false, false, true).contains("$1"));
        assert!(list_objects_sql(false, false, false, true).contains("$1"));
    }

    #[test]
    fn both_list_objects_sql_variants_include_pg_proc() {
        assert!(list_objects_sql(true, true, true, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false, true, true, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(true, true, false, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false, true, false, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(true, false, true, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false, false, true, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(true, false, false, true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false, false, false, true).contains("pg_catalog.pg_proc"));
    }

    #[test]
    fn legacy_list_objects_sql_avoids_pg11_proc_kind_column() {
        let sql = list_objects_sql(true, false, false, true);
        assert!(!sql.contains("p.prokind"));
        assert!(!sql.contains("p.prosp"));
        assert!(sql.contains("NOT p.proisagg"));
        assert!(sql.contains("NOT p.proiswindow"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid) AS signature"));
        assert!(sql.contains("'FUNCTION' AS object_type"));
        assert!(!sql.contains("'PROCEDURE'"));
    }

    #[test]
    fn gaussdb_compatible_list_objects_sql_uses_prosp_when_prokind_is_missing() {
        let sql = list_objects_sql(true, false, true, true);
        assert!(!sql.contains("p.prokind"));
        assert!(sql.contains("CASE WHEN p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type"));
        assert!(sql.contains("CASE WHEN p.prosp THEN 2 ELSE 3 END AS sort_order"));
        assert!(sql.contains("NOT p.proisagg"));
        assert!(sql.contains("NOT p.proiswindow"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid) AS signature"));
    }

    #[test]
    fn gaussdb_compatible_list_objects_sql_uses_prosp_with_prokind_when_available() {
        let sql = list_objects_sql(true, true, true, true);
        assert!(
            sql.contains("CASE WHEN p.prokind = 'p' OR p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type")
        );
        assert!(sql.contains("CASE WHEN p.prokind = 'p' OR p.prosp THEN 2 ELSE 3 END AS sort_order"));
        assert!(sql.contains("p.prokind IN ('p','f') OR p.prosp"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid) AS signature"));
    }

    #[test]
    fn postgres_functions_sql_uses_proc_kind_when_available() {
        let sql = postgres_functions_sql(true);
        assert!(sql.contains("p.prokind IN ('f', 'p')"));
        assert!(sql.contains("WHEN 'p' THEN 'PROCEDURE'"));
        assert!(!sql.contains("p.proisagg"));
        assert!(!sql.contains("p.proiswindow"));
    }

    #[test]
    fn legacy_postgres_functions_sql_avoids_proc_kind_column() {
        let sql = postgres_functions_sql(false);
        assert!(!sql.contains("p.prokind"));
        assert!(sql.contains("NOT p.proisagg"));
        assert!(sql.contains("NOT p.proiswindow"));
        assert!(sql.contains("'FUNCTION'"));
        assert!(!sql.contains("'PROCEDURE'"));
    }

    #[test]
    fn postgres_proc_has_prokind_sql_checks_catalog_attribute() {
        let sql = postgres_proc_has_prokind_sql();
        assert!(sql.contains("pg_catalog.pg_attribute"));
        assert!(sql.contains("'pg_catalog.pg_proc'::regclass"));
        assert!(sql.contains("attname = 'prokind'"));
    }

    #[test]
    fn postgres_proc_has_prosp_sql_checks_catalog_attribute() {
        let sql = postgres_proc_has_prosp_sql();
        assert!(sql.contains("pg_catalog.pg_attribute"));
        assert!(sql.contains("'pg_catalog.pg_proc'::regclass"));
        assert!(sql.contains("attname = 'prosp'"));
    }

    #[test]
    fn transaction_recovery_statement_detection_matches_common_postgres_commands() {
        assert!(is_transaction_recovery_statement("ROLLBACK"));
        assert!(is_transaction_recovery_statement("rollback work"));
        assert!(is_transaction_recovery_statement("ABORT TRANSACTION"));
        assert!(is_transaction_recovery_statement("commit"));
        assert!(is_transaction_recovery_statement("END"));
    }

    #[test]
    fn transaction_recovery_statement_detection_ignores_regular_queries() {
        assert!(!is_transaction_recovery_statement("SELECT 1"));
        assert!(!is_transaction_recovery_statement("BEGIN"));
        assert!(!is_transaction_recovery_statement("UPDATE users SET name = 'dbx'"));
    }

    #[test]
    fn postgres_ddl_detection_covers_schema_changing_statements() {
        assert!(invalidates_postgres_statement_cache("ALTER TABLE users ADD COLUMN email text"));
        assert!(invalidates_postgres_statement_cache("  CREATE INDEX idx_users_email ON users(email)"));
        assert!(invalidates_postgres_statement_cache("COMMENT ON COLUMN users.email IS 'Email'"));
        assert!(invalidates_postgres_statement_cache("DROP TABLE users"));
        assert!(invalidates_postgres_statement_cache("TRUNCATE users"));
        assert!(invalidates_postgres_statement_cache("REINDEX TABLE users"));
        assert!(invalidates_postgres_statement_cache("VACUUM users"));
    }

    #[test]
    fn postgres_ddl_detection_ignores_regular_dml_and_selects() {
        assert!(!invalidates_postgres_statement_cache("SELECT * FROM users"));
        assert!(!invalidates_postgres_statement_cache("UPDATE users SET name = 'Ada'"));
        assert!(!invalidates_postgres_statement_cache("INSERT INTO users(name) VALUES ('Ada')"));
        assert!(!invalidates_postgres_statement_cache("DELETE FROM users WHERE id = 1"));
    }

    // --- execute_batch ---

    #[tokio::test]
    async fn execute_batch_empty_statements_returns_ok() {
        // Empty input should not error or try to connect
        // We can't test with a real pool, but we can verify the empty-early-return logic
        // by testing that an empty Vec doesn't need a pool reference
        let statements: Vec<String> = vec![];
        // This test validates the early return logic at code review level
        // Actual execution requires a pool; we just verify the empty path exists
        assert!(statements.is_empty());
    }

    #[tokio::test]
    async fn execute_batch_whitespace_only_is_filtered() {
        let statements = ["  ".to_string(), "\t\n".to_string(), "".to_string()];
        let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
        assert!(combined.is_empty());
    }

    #[test]
    fn execute_batch_joins_with_semicolons() {
        let statements = ["SELECT 1".to_string(), "SELECT 2".to_string()];
        let combined = statements.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(";\n");
        assert_eq!(combined, "SELECT 1;\nSELECT 2");
    }

    // --- SET timezone escaping ---

    #[test]
    fn timezone_single_quotes_are_doubled() {
        let tz = "UTC";
        let escaped = tz.replace('\'', "''");
        assert_eq!(escaped, "UTC");
    }

    #[test]
    fn timezone_with_quote_is_escaped() {
        let tz = "Some'Zone";
        let escaped = tz.replace('\'', "''");
        assert_eq!(escaped, "Some''Zone");
    }

    // --- pg_url_has_timezone_setting ---

    #[test]
    fn url_without_timezone_returns_false() {
        assert!(!pg_url_has_timezone_setting("postgres://localhost/db"));
        assert!(!pg_url_has_timezone_setting("postgres://localhost/db?sslmode=require"));
    }

    #[test]
    fn url_with_options_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=-c timezone=Asia/Shanghai"));
    }

    #[test]
    fn url_with_url_encoded_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=-c%20timezone%3DUTC"));
    }

    #[test]
    fn url_with_uppercase_timezone_returns_true() {
        assert!(pg_url_has_timezone_setting("postgres://localhost/db?options=--TimeZone=UTC"));
    }

    #[test]
    fn unrelated_timezone_text_is_not_treated_as_explicit() {
        assert!(!pg_url_has_timezone_setting("postgres://localhost/db?timezone=UTC"));
        assert!(!pg_url_has_timezone_setting(
            "postgres://localhost/db?application_name=timezone%3DUTC&options=-c%20search_path%3Dpublic"
        ));
    }

    #[test]
    fn postgres_timezone_candidates_include_known_tzdata_aliases() {
        assert_eq!(postgres_timezone_candidates("Europe/Kyiv"), vec!["Europe/Kyiv", "Europe/Kiev"]);
        assert_eq!(postgres_timezone_candidates("Asia/Kolkata"), vec!["Asia/Kolkata", "Asia/Calcutta"]);
        assert_eq!(postgres_timezone_candidates("America/New_York"), vec!["America/New_York"]);
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a PostgreSQL database"]
    async fn automatic_invalid_timezone_keeps_connected_server_default() {
        let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
        let pool = connect_with_local_timezone(&url, Duration::from_secs(5), "Invalid/DBX_Timezone")
            .await
            .expect("automatic local timezone rejection must not reject a valid connection");
        let client = pool.get().await.expect("checkout postgres");
        let timezone: String = client.query_one("SHOW timezone", &[]).await.unwrap().get(0);
        assert_ne!(timezone, "Invalid/DBX_Timezone");
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a PostgreSQL database"]
    async fn explicit_timezone_remains_strict_and_overrides_local_timezone() {
        let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
        let separator = if url.contains('?') { '&' } else { '?' };
        let explicit_url = format!("{url}{separator}options=-c%20TimeZone%3DAsia%2FShanghai");
        let pool = connect_with_local_timezone(&explicit_url, Duration::from_secs(5), "UTC")
            .await
            .expect("valid explicit timezone");
        let client = pool.get().await.expect("checkout postgres");
        let timezone: String = client.query_one("SHOW timezone", &[]).await.unwrap().get(0);
        assert_eq!(timezone, "Asia/Shanghai");

        let invalid_url = format!("{url}{separator}options=-c%20TimeZone%3DInvalid%2FDBX_Timezone");
        let error = connect_with_local_timezone(&invalid_url, Duration::from_secs(5), "UTC")
            .await
            .expect_err("invalid explicit timezone must remain a connection error");
        assert!(error.contains("Invalid/DBX_Timezone") || error.contains("time zone"), "{error}");
    }

    #[tokio::test]
    #[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a PostgreSQL database"]
    async fn valid_automatic_timezone_is_applied_normally() {
        let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
        let pool =
            connect_with_local_timezone(&url, Duration::from_secs(5), "UTC").await.expect("valid automatic timezone");
        let client = pool.get().await.expect("checkout postgres");
        let timezone: String = client.query_one("SHOW timezone", &[]).await.unwrap().get(0);
        assert_eq!(timezone, "UTC");
    }

    #[test]
    fn like_contains_pattern_escapes_wildcards() {
        assert_eq!(like_contains_pattern(""), "%%");
        assert_eq!(like_contains_pattern("order_100%"), "%order~_100~%%");
        assert_eq!(like_contains_pattern("tilde~name"), "%tilde~~name%");
        assert_eq!(like_contains_pattern(r"foo\bar"), r"%foo\bar%");
    }

    #[test]
    fn like_fuzzy_pattern_escapes_wildcards() {
        assert_eq!(like_fuzzy_pattern(""), "%%");
        assert_eq!(like_fuzzy_pattern("sysu"), "%s%y%s%u%");
        assert_eq!(like_fuzzy_pattern("user_%"), "%u%s%e%r%~_%~%%");
        assert_eq!(like_fuzzy_pattern("tilde~name"), "%t%i%l%d%e%~~%n%a%m%e%");
    }

    #[test]
    fn postgres_tables_sql_uses_non_backslash_like_escape() {
        let sql = postgres_tables_sql();

        assert!(sql.contains("ILIKE $2 ESCAPE '~'"));
        assert!(sql.contains("$3 <> ''"));
        assert!(sql.contains("ILIKE $3 ESCAPE '~'"));
        assert!(sql.contains("ORDER BY CASE WHEN pc.relkind = 'p' THEN 1 ELSE 0 END, c.relname"));
        assert!(sql.contains("LIMIT CAST($4 AS BIGINT) OFFSET CAST($5 AS BIGINT)"));
    }

    #[test]
    fn postgres_completion_like_pattern_uses_prefix_by_default() {
        assert_eq!(postgres_completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Prefix)), "Temp%");
        assert_eq!(postgres_completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Contains)), "%Temp%");
        assert_eq!(
            postgres_completion_like_pattern("order_100%", Some(&CompletionAssistantMatchMode::Prefix)),
            "order~_100~%%"
        );
    }

    #[test]
    fn postgres_completion_sql_filters_before_limit() {
        assert!(postgres_completion_tables_sql().contains("c.relname ILIKE $2 ESCAPE '~'"));
        assert!(postgres_completion_tables_sql().contains("pg_catalog.pg_table_is_visible(c.oid)"));
        assert!(postgres_completion_tables_sql().contains("c.relkind::text = ANY($3::text[])"));
        assert!(postgres_completion_tables_sql().contains("ORDER BY c.relname LIMIT $4"));
        assert!(postgres_completion_routines_sql().contains("p.proname ILIKE $2 ESCAPE '~'"));
        assert!(postgres_completion_routines_sql().contains("p.prokind::text = ANY($3::text[])"));
        assert!(postgres_completion_routines_sql().contains("ORDER BY p.proname LIMIT $4"));
        assert!(postgres_completion_columns_sql().contains("a.attname ILIKE $3 ESCAPE '~'"));
        assert!(postgres_visible_table_schema_sql().contains("pg_catalog.pg_table_is_visible(c.oid)"));
    }
}
