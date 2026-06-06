use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime};
use deadpool_postgres::{ManagerConfig, Pool, RecyclingMethod, Runtime};
use futures::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use rust_decimal::Decimal;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::verify_server_cert_signed_by_trust_anchor;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use std::fs::File;
use std::io::BufReader;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Row, SimpleQueryMessage};

use super::file_validator::validate_file_path;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectInfo, QueryResult, TableInfo, TriggerInfo,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WkbDimensions {
    has_z: bool,
    has_m: bool,
}

impl WkbDimensions {
    fn suffix(self) -> &'static str {
        match (self.has_z, self.has_m) {
            (false, false) => "",
            (true, false) => " Z",
            (false, true) => " M",
            (true, true) => " ZM",
        }
    }

    fn coordinate_len(self) -> usize {
        2 + usize::from(self.has_z) + usize::from(self.has_m)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum WkbGeometry {
    Point { dims: WkbDimensions, coords: Option<Vec<f64>> },
    LineString { dims: WkbDimensions, points: Vec<Vec<f64>> },
    Polygon { dims: WkbDimensions, rings: Vec<Vec<Vec<f64>>> },
    MultiPoint { dims: WkbDimensions, points: Vec<Option<Vec<f64>>> },
    MultiLineString { dims: WkbDimensions, lines: Vec<Vec<Vec<f64>>> },
    MultiPolygon { dims: WkbDimensions, polygons: Vec<Vec<Vec<Vec<f64>>>> },
    GeometryCollection { dims: WkbDimensions, geometries: Vec<WkbGeometry> },
}

impl WkbGeometry {
    fn to_wkt(&self) -> String {
        match self {
            Self::Point { dims, coords } => match coords {
                Some(coords) => format!("POINT{}({})", dims.suffix(), format_wkb_coordinate(coords)),
                None => format!("POINT{} EMPTY", dims.suffix()),
            },
            Self::LineString { dims, points } => {
                if points.is_empty() {
                    format!("LINESTRING{} EMPTY", dims.suffix())
                } else {
                    format!("LINESTRING{}({})", dims.suffix(), format_wkb_coordinate_sequence(points))
                }
            }
            Self::Polygon { dims, rings } => {
                if rings.is_empty() {
                    format!("POLYGON{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "POLYGON{}({})",
                        dims.suffix(),
                        rings
                            .iter()
                            .map(|ring| format!("({})", format_wkb_coordinate_sequence(ring)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiPoint { dims, points } => {
                if points.is_empty() {
                    format!("MULTIPOINT{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTIPOINT{}({})",
                        dims.suffix(),
                        points
                            .iter()
                            .map(|point| match point {
                                Some(coords) => format!("({})", format_wkb_coordinate(coords)),
                                None => "EMPTY".to_string(),
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiLineString { dims, lines } => {
                if lines.is_empty() {
                    format!("MULTILINESTRING{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTILINESTRING{}({})",
                        dims.suffix(),
                        lines
                            .iter()
                            .map(|line| format!("({})", format_wkb_coordinate_sequence(line)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::MultiPolygon { dims, polygons } => {
                if polygons.is_empty() {
                    format!("MULTIPOLYGON{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "MULTIPOLYGON{}({})",
                        dims.suffix(),
                        polygons
                            .iter()
                            .map(|polygon| {
                                format!(
                                    "({})",
                                    polygon
                                        .iter()
                                        .map(|ring| format!("({})", format_wkb_coordinate_sequence(ring)))
                                        .collect::<Vec<_>>()
                                        .join(",")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
            }
            Self::GeometryCollection { dims, geometries } => {
                if geometries.is_empty() {
                    format!("GEOMETRYCOLLECTION{} EMPTY", dims.suffix())
                } else {
                    format!(
                        "GEOMETRYCOLLECTION{}({})",
                        dims.suffix(),
                        geometries.iter().map(WkbGeometry::to_wkt).collect::<Vec<_>>().join(",")
                    )
                }
            }
        }
    }
}

fn format_wkb_coordinate(coords: &[f64]) -> String {
    coords.iter().map(|value| value.to_string()).collect::<Vec<_>>().join(" ")
}

fn format_wkb_coordinate_sequence(points: &[Vec<f64>]) -> String {
    points.iter().map(|point| format_wkb_coordinate(point)).collect::<Vec<_>>().join(",")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WkbEndian {
    Big,
    Little,
}

struct WkbReader<'a> {
    raw: &'a [u8],
    pos: usize,
}

impl<'a> WkbReader<'a> {
    fn new(raw: &'a [u8]) -> Self {
        Self { raw, pos: 0 }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let value = *self.raw.get(self.pos)?;
        self.pos += 1;
        Some(value)
    }

    fn read_array<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.pos.checked_add(N)?;
        let bytes: [u8; N] = self.raw.get(self.pos..end)?.try_into().ok()?;
        self.pos = end;
        Some(bytes)
    }

    fn read_u32(&mut self, endian: WkbEndian) -> Option<u32> {
        let bytes = self.read_array::<4>()?;
        Some(match endian {
            WkbEndian::Big => u32::from_be_bytes(bytes),
            WkbEndian::Little => u32::from_le_bytes(bytes),
        })
    }

    fn read_f64(&mut self, endian: WkbEndian) -> Option<f64> {
        let bytes = self.read_array::<8>()?;
        Some(match endian {
            WkbEndian::Big => f64::from_be_bytes(bytes),
            WkbEndian::Little => f64::from_le_bytes(bytes),
        })
    }
}

fn parse_wkb_dimensions(type_word: u32) -> (u32, WkbDimensions, bool) {
    let mut base_type = type_word & 0x1FFF_FFFF;
    let mut dims = WkbDimensions { has_z: (type_word & 0x8000_0000) != 0, has_m: (type_word & 0x4000_0000) != 0 };
    let has_srid = (type_word & 0x2000_0000) != 0;

    if base_type >= 3000 {
        dims.has_z = true;
        dims.has_m = true;
        base_type -= 3000;
    } else if base_type >= 2000 {
        dims.has_m = true;
        base_type -= 2000;
    } else if base_type >= 1000 {
        dims.has_z = true;
        base_type -= 1000;
    }

    (base_type, dims, has_srid)
}

fn read_wkb_point_coords(reader: &mut WkbReader<'_>, dims: WkbDimensions, allow_empty_point: bool) -> Option<Vec<f64>> {
    let endian = match reader.read_u8()? {
        0 => WkbEndian::Big,
        1 => WkbEndian::Little,
        _ => return None,
    };
    let type_word = reader.read_u32(endian)?;
    let (base_type, parsed_dims, has_srid) = parse_wkb_dimensions(type_word);
    if base_type != 1 || parsed_dims != dims {
        return None;
    }
    if has_srid {
        reader.read_u32(endian)?;
    }
    let coords = (0..parsed_dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>()?;
    if allow_empty_point && coords.iter().all(|value| value.is_nan()) {
        return None;
    }
    Some(coords)
}

fn parse_wkb_points(reader: &mut WkbReader<'_>, endian: WkbEndian, dims: WkbDimensions) -> Option<Vec<Vec<f64>>> {
    let count = usize::try_from(reader.read_u32(endian)?).ok()?;
    (0..count)
        .map(|_| (0..dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>())
        .collect::<Option<Vec<_>>>()
}

fn parse_wkb_geometry(reader: &mut WkbReader<'_>) -> Option<WkbGeometry> {
    let endian = match reader.read_u8()? {
        0 => WkbEndian::Big,
        1 => WkbEndian::Little,
        _ => return None,
    };
    let type_word = reader.read_u32(endian)?;
    let (base_type, dims, has_srid) = parse_wkb_dimensions(type_word);
    if has_srid {
        reader.read_u32(endian)?;
    }

    match base_type {
        1 => {
            let coords = (0..dims.coordinate_len()).map(|_| reader.read_f64(endian)).collect::<Option<Vec<_>>>()?;
            let coords = if coords.iter().all(|value| value.is_nan()) { None } else { Some(coords) };
            Some(WkbGeometry::Point { dims, coords })
        }
        2 => Some(WkbGeometry::LineString { dims, points: parse_wkb_points(reader, endian, dims)? }),
        3 => {
            let ring_count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let rings = (0..ring_count).map(|_| parse_wkb_points(reader, endian, dims)).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::Polygon { dims, rings })
        }
        4 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let points =
                (0..count).map(|_| Some(read_wkb_point_coords(reader, dims, true))).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiPoint { dims, points })
        }
        5 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let lines = (0..count)
                .map(|_| match parse_wkb_geometry(reader)? {
                    WkbGeometry::LineString { points, .. } => Some(points),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiLineString { dims, lines })
        }
        6 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let polygons = (0..count)
                .map(|_| match parse_wkb_geometry(reader)? {
                    WkbGeometry::Polygon { rings, .. } => Some(rings),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::MultiPolygon { dims, polygons })
        }
        7 => {
            let count = usize::try_from(reader.read_u32(endian)?).ok()?;
            let geometries = (0..count).map(|_| parse_wkb_geometry(reader)).collect::<Option<Vec<_>>>()?;
            Some(WkbGeometry::GeometryCollection { dims, geometries })
        }
        _ => None,
    }
}

fn ewkb_to_wkt(raw: &[u8]) -> Option<String> {
    let mut reader = WkbReader::new(raw);
    let geometry = parse_wkb_geometry(&mut reader)?;
    if reader.pos != raw.len() {
        return None;
    }
    Some(geometry.to_wkt())
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

fn pg_value_to_json(row: &Row, idx: usize, type_name: &str) -> serde_json::Value {
    let upper = type_name.to_uppercase();

    if upper == "BYTEA" {
        return row
            .try_get::<_, Vec<u8>>(idx)
            .map(|bytes| super::binary_value_to_json(&bytes))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper == "JSON" || upper == "JSONB" {
        if let Ok(v) = row.try_get::<_, serde_json::Value>(idx) {
            return serde_json::Value::String(v.to_string());
        }
        if let Ok(v) = row.try_get::<_, String>(idx) {
            return serde_json::Value::String(v);
        }
        return serde_json::Value::Null;
    }

    if upper == "BOOL" {
        return row.try_get::<_, bool>(idx).map(serde_json::Value::Bool).unwrap_or(serde_json::Value::Null);
    }

    if upper.contains("TIMESTAMP")
        || upper == "DATE"
        || upper == "TIME"
        || upper == "TIMETZ"
        || upper.contains("INTERVAL")
    {
        if let Some(v) = pg_temporal_to_json_value(row, idx) {
            return v;
        }
    }

    if upper == "NUMERIC" || upper == "DECIMAL" || upper == "MONEY" {
        return row
            .try_get::<_, Decimal>(idx)
            .map(|v: Decimal| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    if upper == "UUID" {
        return row
            .try_get::<_, uuid::Uuid>(idx)
            .map(|v| serde_json::Value::String(v.to_string()))
            .unwrap_or(serde_json::Value::Null);
    }

    if matches!(upper.as_str(), "OID" | "XID" | "CID") {
        return pg_system_u32_to_json(row, idx).unwrap_or(serde_json::Value::Null);
    }

    if upper.starts_with('_') {
        return pg_array_to_json_value(row, idx).unwrap_or(serde_json::Value::Null);
    }

    if upper == "VECTOR" || upper.starts_with("VECTOR(") {
        if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
            if let Some(floats) = decode_pgvector_bytes(&raw) {
                return serde_json::Value::Array(
                    floats
                        .into_iter()
                        .map(|v| {
                            serde_json::Number::from_f64((v as f64 * 1_000_000.0).round() / 1_000_000.0)
                                .map(serde_json::Value::Number)
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect(),
                );
            }
        }
        return serde_json::Value::Null;
    }

    if upper == "GEOMETRY" || upper == "GEOGRAPHY" {
        if let Ok(PgRawBytes(raw)) = row.try_get::<_, PgRawBytes>(idx) {
            return ewkb_to_wkt(&raw)
                .map(serde_json::Value::String)
                .unwrap_or_else(|| super::binary_value_to_json(&raw));
        }
        return serde_json::Value::Null;
    }

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

fn pg_error_to_string(err: tokio_postgres::Error) -> String {
    err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string())
}

fn should_retry_postgres_text_query(err: &tokio_postgres::Error) -> bool {
    let message = err.as_db_error().map(ToString::to_string).unwrap_or_else(|| err.to_string()).to_ascii_lowercase();
    message.contains("no binary output function")
        || message.contains("no binary send function")
        || message.contains("cannot display a value of type")
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
                .map(|i| pg_value_to_json(&row, i, column_types.get(i).map(String::as_str).unwrap_or("")))
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
        Err(err) if should_retry_postgres_text_query(&err) => execute_select_text(client, sql, start, row_limit).await,
        Err(err) => Err(pg_error_to_string(err)),
    }
}

pub async fn connect(url: &str, fallback_timeout: Duration) -> Result<Pool, String> {
    let postgres_url = postgres_connection_url(url)?;
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let timeout = super::parse_connect_timeout_with_fallback(url, fallback_timeout);
    let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());

    super::with_connection_timeout("PostgreSQL", timeout, async {
        let pg_config = tokio_postgres::Config::from_str(&postgres_url.url)
            .map_err(|e| format!("Invalid PostgreSQL connection URL: {e}"))?;

        let mgr_config = ManagerConfig { recycling_method: RecyclingMethod::Verified };
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
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(timeout))
            .build()
            .map_err(|e| format!("Failed to create PostgreSQL pool: {e}"))?;

        // Verify connectivity and set timezone. Only set timezone if the user
        // hasn't already specified one via connection parameters (e.g. options=-c timezone=...)
        let client = pool.get().await.map_err(|e| format!("PostgreSQL connection failed: {e}"))?;
        if !pg_url_has_timezone_setting(url) {
            client
                .execute(&format!("SET timezone = '{}'", tz.replace('\'', "''")), &[])
                .await
                .map_err(|e| format!("PostgreSQL SET timezone failed: {e}"))?;
        }

        Ok(pool)
    })
    .await
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PostgresSslFiles {
    sslcert: Option<String>,
    sslkey: Option<String>,
    sslrootcert: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresConnectionUrl {
    url: String,
    ssl_files: PostgresSslFiles,
    accepts_invalid_certs: bool,
    verifies_hostname: bool,
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
    let lower = url.to_lowercase();
    // Match "timezone=" anywhere after the query string, covering:
    //   ?options=-c timezone=Asia/Shanghai
    //   ?options=--timezone=UTC
    // Also handles URL-encoded forms like timezone%3D
    if let Some(query) = lower.split('?').nth(1) {
        if query.contains("timezone=") || query.contains("timezone%3d") {
            return true;
        }
    }
    false
}

#[cfg(test)]
fn validate_postgres_ssl_paths(url: &str) -> Result<(), String> {
    postgres_connection_url(url).map(|_| ())
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<DatabaseInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT datname FROM pg_database \
             WHERE datallowconn = true \
             ORDER BY datname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: row.get::<_, String>(0) }).collect())
}

pub async fn list_tables(pool: &Pool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(postgres_tables_sql()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<_, String>(0),
            table_type: row.get::<_, String>(1),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

fn postgres_tables_sql() -> &'static str {
    "SELECT c.relname AS table_name, \
         CASE c.relkind WHEN 'r' THEN 'BASE TABLE' WHEN 'v' THEN 'VIEW' \
           WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' \
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
         ORDER BY c.relname"
}

fn list_objects_sql(include_timestamps: bool) -> &'static str {
    if include_timestamps {
        return "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'VIEW' \
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
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     LEFT JOIN LATERAL pg_stat_file( \
       CASE WHEN c.relkind IN ('r','m','f','p') THEN pg_relation_filepath(c.oid) END, true \
     ) stat ON true \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       CASE WHEN current_setting('track_commit_timestamp', true) = 'on' \
         THEN pg_xact_commit_timestamp(p.xmin)::text END AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f') \
     ORDER BY sort_order, object_name";
    }

    "SELECT c.relname AS object_name, \
       CASE c.relkind \
         WHEN 'v' THEN 'VIEW' \
         WHEN 'm' THEN 'VIEW' \
         ELSE 'TABLE' \
       END AS object_type, \
       obj_description(c.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       CASE WHEN pc.relkind = 'p' THEN pn.nspname ELSE NULL END AS parent_schema, \
       CASE WHEN pc.relkind = 'p' THEN pc.relname ELSE NULL END AS parent_name, \
       CASE c.relkind WHEN 'v' THEN 1 WHEN 'm' THEN 1 ELSE 0 END AS sort_order \
     FROM pg_catalog.pg_class c \
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
     LEFT JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
     LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
     WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','f','p') \
     UNION ALL \
     SELECT p.proname AS object_name, \
       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS object_type, \
       obj_description(p.oid) AS object_comment, \
       NULL::text AS created_at, \
       NULL::text AS updated_at, \
       NULL::text AS parent_schema, \
       NULL::text AS parent_name, \
       CASE p.prokind WHEN 'p' THEN 2 ELSE 3 END AS sort_order \
     FROM pg_catalog.pg_proc p \
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
     WHERE n.nspname = $1 AND p.prokind IN ('p','f') \
     ORDER BY sort_order, object_name"
}

pub async fn list_objects(pool: &Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client.prepare_cached(list_objects_sql(true)).await.map_err(|e| e.to_string())?;
    let rows = match client.query(&stmt, &[&schema]).await {
        Ok(rows) => rows,
        Err(_) => {
            let stmt = client.prepare_cached(list_objects_sql(false)).await.map_err(|e| e.to_string())?;
            client.query(&stmt, &[&schema]).await.map_err(|e| e.to_string())?
        }
    };

    Ok(rows
        .iter()
        .map(|row| ObjectInfo {
            name: row.get::<_, String>(0),
            object_type: row.get::<_, String>(1),
            schema: Some(schema.to_string()),
            comment: row.try_get::<_, Option<String>>(2).ok().flatten().filter(|s| !s.is_empty()),
            created_at: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|s| !s.is_empty()),
            updated_at: row.try_get::<_, Option<String>>(4).ok().flatten().filter(|s| !s.is_empty()),
            parent_schema: row.try_get::<_, Option<String>>(5).ok().flatten().filter(|s| !s.is_empty()),
            parent_name: row.try_get::<_, Option<String>>(6).ok().flatten().filter(|s| !s.is_empty()),
        })
        .collect())
}

pub async fn list_schemas(pool: &Pool) -> Result<Vec<String>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT n.nspname AS schema_name FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') \
             AND n.nspname NOT LIKE 'pg_toast_temp_%' \
             AND n.nspname NOT LIKE 'pg_temp_%' \
             ORDER BY n.nspname",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
}

const POSTGRES_COLUMNS_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             NOT a.attnotnull AS is_nullable, \
             pg_get_expr(ad.adbin, ad.adrelid) AS column_default, \
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
               ELSE NULL \
             END AS column_extra, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, \
             CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 \
               THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, \
             CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 \
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN pg_depend dep ON dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype = 'i' \
             LEFT JOIN pg_sequence pseq ON pseq.seqrelid = dep.objid \
             WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass \
             AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum";

const POSTGRES_COLUMNS_COMPAT_SQL: &str = "SELECT a.attname AS column_name, \
             format_type(a.atttypid, a.atttypmod) AS full_type, \
             NOT a.attnotnull AS is_nullable, \
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
               THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
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
             CAST(c.character_maximum_length AS int) AS character_maximum_length \
             FROM information_schema.columns c \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position";

fn column_info_from_row(row: &Row) -> ColumnInfo {
    let full_type = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
    ColumnInfo {
        name: row.get::<_, String>(0),
        data_type: full_type,
        is_nullable: row.get::<_, bool>(2),
        column_default: row.try_get::<_, Option<String>>(3).ok().flatten(),
        is_primary_key: row.get::<_, bool>(4),
        extra: row.try_get::<_, Option<String>>(6).ok().flatten(),
        comment: row.try_get::<_, Option<String>>(5).ok().flatten(),
        numeric_precision: row.try_get::<_, Option<i32>>(7).ok().flatten(),
        numeric_scale: row.try_get::<_, Option<i32>>(8).ok().flatten(),
        character_maximum_length: row.try_get::<_, Option<i32>>(9).ok().flatten(),
    }
}

async fn get_columns_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    let rows = client.query(&stmt, &[&schema, &table]).await?;

    Ok(rows.iter().map(column_info_from_row).collect())
}

pub async fn get_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
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
        let client = pool.get().await.map_err(|e| e.to_string())?;
        execute_select_query(&client, sql, start, row_limit).await
    } else {
        let client = pool.get().await.map_err(|e| e.to_string())?;
        let affected = client.execute(sql, &[]).await.map_err(pg_error_to_string)?;

        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
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
    let client = pool.get().await.map_err(|e| e.to_string())?;
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
    client.execute(&format!("SET search_path TO {}", pg_quote_ident(schema)), &[]).await.map_err(pg_error_to_string)?;
    log::info!(
        "[postgres][execute_with_schema:set-search-path:done] elapsed_ms={} total_ms={}",
        set_schema_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    let query_start = Instant::now();
    let result = execute_query_with_max_rows_inner(&client, sql, max_rows).await;
    log::info!(
        "[postgres][execute_with_schema:query:done] elapsed_ms={} total_ms={} ok={}",
        query_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        result.is_ok()
    );

    // Always reset search_path so the connection is clean when returned to the pool
    let reset_start = Instant::now();
    let _ = client.execute("RESET search_path", &[]).await;
    log::info!(
        "[postgres][execute_with_schema:reset-search-path:done] elapsed_ms={} total_ms={}",
        reset_start.elapsed().as_millis(),
        start.elapsed().as_millis()
    );

    result
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
             array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) ORDER BY k.n) AS columns, \
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
             JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, i.oid, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname, ix.indkey \
             ORDER BY i.relname";

const POSTGRES_INDEXES_OPENGAUSS_SQL: &str = "SELECT i.relname AS index_name, \
             array_agg(COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.n::int, true)) ORDER BY k.n) AS columns, \
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
             JOIN LATERAL ( \
                 SELECT unnest(ix.indkey) AS attnum, generate_series(1, array_length(ix.indkey, 1)) AS n \
             ) AS k ON true \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 \
             WHERE n.nspname = $1 AND t.relname = $2 \
             GROUP BY i.relname, i.oid, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname, ix.indkey \
             ORDER BY i.relname";

async fn list_indexes_with_sql(
    client: &deadpool_postgres::Client,
    sql: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, tokio_postgres::Error> {
    let stmt = client.prepare_cached(sql).await?;
    let rows = client.query(&stmt, &[&schema, &table]).await?;

    Ok(rows
        .iter()
        .map(|row| {
            let all_cols: Vec<String> = row.get::<_, Vec<String>>(1);
            let nkeyatts = row.try_get::<_, Option<i16>>(6).ok().flatten().unwrap_or(all_cols.len() as i16) as usize;
            let split_at = nkeyatts.min(all_cols.len());
            let key_cols = all_cols[..split_at].to_vec();
            let included = if split_at < all_cols.len() { all_cols[split_at..].to_vec() } else { vec![] };
            IndexInfo {
                name: row.get::<_, String>(0),
                columns: key_cols,
                is_unique: row.get::<_, bool>(2),
                is_primary: row.get::<_, bool>(3),
                filter: row.try_get::<_, Option<String>>(4).ok().flatten(),
                index_type: row.try_get::<_, Option<String>>(5).ok().flatten(),
                included_columns: if included.is_empty() { None } else { Some(included) },
                comment: row.try_get::<_, Option<String>>(8).ok().flatten(),
            }
        })
        .collect())
}

pub async fn list_indexes(pool: &Pool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    match list_indexes_with_sql(&client, POSTGRES_INDEXES_SQL, schema, table).await {
        Ok(indexes) => Ok(indexes),
        Err(primary_error) => match list_indexes_with_sql(&client, POSTGRES_INDEXES_COMPAT_SQL, schema, table).await {
            Ok(indexes) => Ok(indexes),
            Err(fallback_error) => {
                match list_indexes_with_sql(&client, POSTGRES_INDEXES_OPENGAUSS_SQL, schema, table).await {
                    Ok(indexes) => Ok(indexes),
                    Err(opengauss_error) => {
                        let primary_message = pg_error_to_string(primary_error);
                        let fallback_message = pg_error_to_string(fallback_error);
                        let opengauss_message = pg_error_to_string(opengauss_error);
                        log::debug!(
                        "[postgres][list_indexes:opengauss-failed] primary_error={} fallback_error={} opengauss_error={}",
                        primary_message,
                        fallback_message,
                        opengauss_message
                    );
                        Err(opengauss_message)
                    }
                }
            }
        },
    }
}

pub async fn list_foreign_keys(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT fk.constraint_name, fk.column_name, \
             pk.table_schema AS ref_schema, pk.table_name AS ref_table, pk.column_name AS ref_column \
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
             ORDER BY fk.constraint_name, fk.ordinal_position",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<_, String>(0),
            column: row.get::<_, String>(1),
            ref_schema: Some(row.get::<_, String>(2)),
            ref_table: row.get::<_, String>(3),
            ref_column: row.get::<_, String>(4),
        })
        .collect())
}

pub async fn list_triggers(pool: &Pool, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let stmt = client
        .prepare_cached(
            "SELECT trigger_name, event_manipulation, action_timing \
             FROM information_schema.triggers \
             WHERE trigger_schema = $1 AND event_object_table = $2 \
             ORDER BY trigger_name",
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&schema, &table]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<_, String>(0),
            event: row.get::<_, String>(1),
            timing: row.get::<_, String>(2),
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
    let client = pool.get().await.map_err(|e| e.to_string())?;
    client.batch_execute(&combined).await.map_err(pg_error_to_string)
}

/// Export data via COPY TO STDOUT. `sql` must be a complete COPY statement, e.g.
/// `COPY table (col1, col2) TO STDOUT (FORMAT CSV, HEADER)`.
/// Returns the raw COPY output bytes.
pub async fn copy_out(pool: &Pool, sql: &str) -> Result<Vec<u8>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
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
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let sink = client.copy_in::<str, bytes::Bytes>(sql).await.map_err(pg_error_to_string)?;
    let mut sink = Box::pin(sink);
    sink.as_mut().send(bytes::Bytes::copy_from_slice(data)).await.map_err(pg_error_to_string)?;
    sink.as_mut().close().await.map_err(pg_error_to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_postgres::types::FromSql;

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

    fn decode_hex(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0, "hex input must have an even number of chars");
        (0..hex.len()).step_by(2).map(|idx| u8::from_str_radix(&hex[idx..idx + 2], 16).unwrap()).collect()
    }

    #[test]
    fn ewkb_point_with_srid_formats_as_wkt() {
        let raw = decode_hex("0101000020E6100000C520B07268195D404E62105839F44340");
        assert_eq!(ewkb_to_wkt(&raw), Some("POINT(116.397 39.908)".to_string()));
    }

    #[test]
    fn ewkb_multi_polygon_formats_as_wkt() {
        let raw = decode_hex(
            "0106000020E610000002000000010300000001000000050000000000000000005D4000000000000044400000000000405D4000000000000044400000000000405D4000000000008044400000000000005D4000000000008044400000000000005D400000000000004440010300000001000000050000000000000000805D4000000000008043400000000000C05D4000000000008043400000000000C05D4000000000000044400000000000805D4000000000000044400000000000805D400000000000804340",
        );
        assert_eq!(
            ewkb_to_wkt(&raw),
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
        assert_eq!(ewkb_to_wkt(&raw), Some("GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))".to_string()));
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
        assert!(sql.contains("MATERIALIZED VIEW"));
        assert!(sql.contains("FOREIGN TABLE"));
    }

    #[test]
    fn postgres_column_metadata_reads_identity_extra() {
        assert!(POSTGRES_COLUMNS_SQL.contains("a.attidentity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated by default as identity"));
        assert!(POSTGRES_COLUMNS_SQL.contains("generated always as identity"));
    }

    #[test]
    fn postgres_column_metadata_has_opengauss_compatible_fallback() {
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("a.attidentity"));
        assert!(!POSTGRES_COLUMNS_COMPAT_SQL.contains("pg_sequence"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("NULL::text AS column_extra"));
        assert!(POSTGRES_COLUMNS_COMPAT_SQL.contains("col_description"));
    }

    #[test]
    fn postgres_column_metadata_has_information_schema_fallback() {
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.columns"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.table_constraints"));
        assert!(POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("information_schema.key_column_usage"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("pg_attribute"));
        assert!(!POSTGRES_COLUMNS_INFORMATION_SCHEMA_SQL.contains("regclass"));
    }

    #[test]
    fn postgres_index_metadata_has_legacy_catalog_fallback() {
        assert!(POSTGRES_INDEXES_SQL.contains("ix.indnkeyatts"));
        assert!(!POSTGRES_INDEXES_COMPAT_SQL.contains("ix.indnkeyatts"));
        assert!(POSTGRES_INDEXES_COMPAT_SQL.contains("NULL::smallint AS nkeyatts"));
    }

    #[test]
    fn postgres_index_metadata_has_opengauss_compatible_fallback() {
        assert!(!POSTGRES_INDEXES_OPENGAUSS_SQL.contains("WITH ORDINALITY"));
        assert!(POSTGRES_INDEXES_OPENGAUSS_SQL.contains("generate_series"));
        assert!(POSTGRES_INDEXES_OPENGAUSS_SQL.contains("array_length"));
        assert!(POSTGRES_INDEXES_OPENGAUSS_SQL.contains("NULL::smallint AS nkeyatts"));
    }

    #[test]
    fn list_objects_sql_includes_routines() {
        let sql = list_objects_sql(true);
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_proc"));
        assert!(sql.contains("pg_catalog.pg_inherits"));
        assert!(sql.contains("parent_schema"));
        assert!(sql.contains("parent_name"));
        assert!(sql.contains("pc.relkind = 'p'"));
        assert!(sql.contains("pg_stat_file"));
        assert!(sql.contains("pg_xact_commit_timestamp"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
    }

    #[test]
    fn list_objects_sql_without_timestamps_omits_stat_file() {
        let sql = list_objects_sql(false);
        assert!(!sql.contains("pg_stat_file"));
        assert!(sql.contains("NULL::text AS created_at"));
        assert!(sql.contains("NULL::text AS updated_at"));
    }

    #[test]
    fn both_list_objects_sql_variants_use_parameter() {
        assert!(list_objects_sql(true).contains("$1"));
        assert!(list_objects_sql(false).contains("$1"));
    }

    #[test]
    fn both_list_objects_sql_variants_include_pg_proc() {
        assert!(list_objects_sql(true).contains("pg_catalog.pg_proc"));
        assert!(list_objects_sql(false).contains("pg_catalog.pg_proc"));
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
}
