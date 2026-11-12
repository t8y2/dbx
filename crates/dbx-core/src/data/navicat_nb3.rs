//! Navicat `.nb3` backup archives.
//!
//! An `.nb3` file is a POSIX tar archive. `meta.json` lists every backed-up object;
//! each object has a gzipped `<uuid>.meta.json.gz` holding its DDL, and a table also
//! has gzipped `<uuid>.data.NNNNN.sql.gz` row chunks. A row chunk holds SQL value
//! tuples (`(1, 'a', NULL)`) separated by `\x1e\n`. Every member referenced by the
//! metadata carries the upper-case SHA-1 of its stored (compressed) bytes.
//!
//! DBX restores an archive by rendering it as a SQL script ([`Nb3SqlReader`]) and
//! writes one by splitting its own SQL export into Navicat objects ([`Nb3ExportWriter`]).

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::models::connection::DatabaseType;
use crate::sql::{SqlParsingOptions, SqlStatementSplitter};

const META_VERSION: &str = "30101";
const MANIFEST_NAME: &str = "meta.json";
const RECORD_SEPARATOR: &[u8] = b"\x1e\n";
const METADATA_MAX_BYTES: u64 = 256 * 1024 * 1024;
const DATA_CHUNK_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// Upper bound for a single row tuple while it is still being decompressed. The
/// row stream only retains the unfinished tuple between reads, so without this
/// cap a crafted gzip member that never closes a tuple grows memory without limit.
const ROW_TUPLE_MAX_BYTES: usize = 64 * 1024 * 1024;
const EXPORT_SPLIT_THRESHOLD_BYTES: usize = 64 * 1024;
const RESTORE_INSERT_MAX_ROWS: usize = 1000;
const RESTORE_INSERT_MAX_BYTES: usize = 1024 * 1024;

pub fn ensure_supported_database_type(db_type: DatabaseType) -> Result<(), String> {
    Nb3Dialect::from_database_type(db_type).map(|_| ())
}

pub fn is_nb3_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nb3"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Nb3Manifest {
    meta_version: String,
    database_type: String,
    #[serde(default)]
    service_provider: String,
    #[serde(default)]
    catalog: String,
    #[serde(default)]
    schema: String,
    #[serde(default)]
    start_time: String,
    #[serde(default)]
    end_time: String,
    #[serde(default)]
    encryption: String,
    #[serde(default)]
    comment: String,
    #[serde(default)]
    objects: Vec<Nb3ObjectEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Nb3ObjectEntry {
    #[serde(rename = "UUID")]
    uuid: String,
    #[serde(rename = "Type")]
    object_type: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rows: Option<String>,
    metadata: Nb3MemberRef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Nb3MemberRef {
    filename: String,
    #[serde(default)]
    checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Nb3ObjectMeta {
    meta_version: String,
    name: String,
    #[serde(rename = "Type")]
    object_type: String,
    #[serde(rename = "DDL", default)]
    ddl: String,
    #[serde(rename = "SubDDL", default)]
    sub_ddl: Vec<String>,
    #[serde(default)]
    auto_increment: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fields: Option<Vec<String>>,
    #[serde(rename = "TriggerDDL", default)]
    trigger_ddl: Vec<String>,
    #[serde(rename = "IndexDDL", default)]
    index_ddl: Vec<String>,
    #[serde(default)]
    data: Vec<Nb3MemberRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Nb3Dialect {
    Mysql,
    Postgres,
}

impl Nb3Dialect {
    fn from_archive(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_uppercase().as_str() {
            "MYSQL" | "MARIADB" => Ok(Self::Mysql),
            "PGSQL" | "POSTGRESQL" => Ok(Self::Postgres),
            other => Err(format!("Unsupported Navicat backup database type: {other}")),
        }
    }

    fn from_database_type(db_type: DatabaseType) -> Result<Self, String> {
        match db_type {
            DatabaseType::Mysql => Ok(Self::Mysql),
            DatabaseType::Postgres => Ok(Self::Postgres),
            _ => Err("Navicat .nb3 backups support MySQL and PostgreSQL connections only".to_string()),
        }
    }

    fn archive_name(self) -> &'static str {
        match self {
            Self::Mysql => "MYSQL",
            Self::Postgres => "PGSQL",
        }
    }

    fn database_type(self) -> DatabaseType {
        match self {
            Self::Mysql => DatabaseType::Mysql,
            Self::Postgres => DatabaseType::Postgres,
        }
    }

    fn quote(self, name: &str) -> String {
        match self {
            Self::Mysql => format!("`{}`", name.replace('`', "``")),
            Self::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }
}

/// Creation order of Navicat object types: dependencies first, views after tables.
fn creation_rank(object_type: &str) -> u8 {
    match object_type {
        "Extension" => 0,
        "Type" | "Domain" => 1,
        "Sequence" => 2,
        "Function" | "Procedure" => 3,
        "Table" => 4,
        "View" | "MaterializedView" => 5,
        _ => 6,
    }
}

fn is_routine_like(object_type: &str) -> bool {
    matches!(object_type, "Function" | "Procedure" | "Event" | "Trigger")
}

fn sha1_hex(bytes: &[u8]) -> String {
    Sha1::digest(bytes).iter().map(|byte| format!("{byte:02X}")).collect()
}

fn io_error(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

/// Navicat writes CRLF-formatted, two-space indented JSON.
fn navicat_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    Ok(text.replace('\n', "\r\n").into_bytes())
}

// ---------------------------------------------------------------------------
// Value tuples
// ---------------------------------------------------------------------------

/// Finds top-level `( ... )` value tuples, skipping quoted text. MySQL strings always
/// treat a backslash as an escape; PostgreSQL strings only do inside `E'...'`.
struct TupleScanner {
    dialect: Nb3Dialect,
    depth: usize,
    quote: Option<u8>,
    backslash_escapes: bool,
    escaped: bool,
    start: usize,
}

enum TupleScan {
    /// A complete tuple spans `start..end` of the scanned buffer.
    Tuple { start: usize, end: usize },
    /// The buffer ends inside a tuple, or between tuples.
    Incomplete,
}

impl TupleScanner {
    fn new(dialect: Nb3Dialect) -> Self {
        Self { dialect, depth: 0, quote: None, backslash_escapes: false, escaped: false, start: 0 }
    }

    fn is_between_tuples(&self) -> bool {
        self.depth == 0 && self.quote.is_none()
    }

    /// Scans `buffer[*pos..]` for the next complete tuple, advancing `pos`. State is
    /// kept between calls, so the buffer may grow while a tuple is open.
    fn next(&mut self, buffer: &[u8], pos: &mut usize) -> Result<TupleScan, String> {
        while *pos < buffer.len() {
            let index = *pos;
            let byte = buffer[index];
            *pos += 1;
            if let Some(quote) = self.quote {
                if self.escaped {
                    self.escaped = false;
                } else if self.backslash_escapes && byte == b'\\' {
                    self.escaped = true;
                } else if byte == quote {
                    self.quote = None;
                }
                continue;
            }
            if self.depth == 0 {
                match byte {
                    b'(' => {
                        self.depth = 1;
                        self.start = index;
                    }
                    b',' | 0x1e => {}
                    _ if byte.is_ascii_whitespace() => {}
                    _ => return Err(format!("Unexpected character {:?} between value tuples", byte as char)),
                }
                continue;
            }
            match byte {
                b'\'' | b'"' => {
                    self.quote = Some(byte);
                    self.backslash_escapes = match self.dialect {
                        Nb3Dialect::Mysql => true,
                        Nb3Dialect::Postgres => byte == b'\'' && is_escape_string_prefix(buffer, index),
                    };
                }
                b'(' => self.depth += 1,
                b')' => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        return Ok(TupleScan::Tuple { start: self.start, end: index + 1 });
                    }
                }
                _ => {}
            }
        }
        Ok(TupleScan::Incomplete)
    }
}

fn is_escape_string_prefix(buffer: &[u8], quote_index: usize) -> bool {
    if quote_index == 0 || !matches!(buffer[quote_index - 1], b'E' | b'e') {
        return false;
    }
    quote_index < 2 || !is_identifier_byte(buffer[quote_index - 2])
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 0x80
}

/// Splits the `VALUES` tail of an INSERT statement into its tuples. Returns `None`
/// when anything other than tuples follows (for example `ON DUPLICATE KEY UPDATE`).
fn split_value_tuples(dialect: Nb3Dialect, tail: &str) -> Option<Vec<&str>> {
    let bytes = tail.as_bytes();
    let mut scanner = TupleScanner::new(dialect);
    let mut pos = 0;
    let mut tuples = Vec::new();
    while let TupleScan::Tuple { start, end } = scanner.next(bytes, &mut pos).ok()? {
        tuples.push(&tail[start..end]);
    }
    (scanner.is_between_tuples() && !tuples.is_empty()).then_some(tuples)
}

// ---------------------------------------------------------------------------
// Restore: archive -> SQL script
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct ArchiveMember {
    offset: u64,
    size: u64,
}

struct LoadedObject {
    meta: Nb3ObjectMeta,
}

struct DataChunk {
    name: String,
    member: ArchiveMember,
    checksum: String,
}

enum RestoreStep {
    Sql(String),
    Rows { insert_prefix: String, chunks: Vec<DataChunk> },
}

fn read_archive_member(file: &mut File, name: &str, member: ArchiveMember, checksum: &str) -> Result<Vec<u8>, String> {
    if member.size > METADATA_MAX_BYTES {
        return Err(format!("Navicat backup member {name} is too large"));
    }
    file.seek(SeekFrom::Start(member.offset)).map_err(|error| error.to_string())?;
    let mut bytes = vec![0; member.size as usize];
    file.read_exact(&mut bytes).map_err(|error| format!("Failed to read {name} from Navicat backup: {error}"))?;
    if !checksum.is_empty() && !sha1_hex(&bytes).eq_ignore_ascii_case(checksum) {
        return Err(format!("Navicat backup member {name} is corrupted (checksum mismatch)"));
    }
    Ok(bytes)
}

fn gunzip(name: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    MultiGzDecoder::new(bytes)
        .take(METADATA_MAX_BYTES + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| format!("Failed to decompress {name} from Navicat backup: {error}"))?;
    if decoded.len() as u64 > METADATA_MAX_BYTES {
        return Err(format!("Navicat backup member {name} exceeds the {METADATA_MAX_BYTES}-byte metadata limit"));
    }
    Ok(decoded)
}

fn index_archive_members(path: &Path) -> Result<HashMap<String, ArchiveMember>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(BufReader::new(file));
    let mut members = HashMap::new();
    let entries = archive.entries_with_seek().map_err(|error| format!("Not a Navicat backup archive: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Not a Navicat backup archive: {error}"))?;
        let name = entry.path().map_err(|error| error.to_string())?.to_string_lossy().into_owned();
        members.insert(name, ArchiveMember { offset: entry.raw_file_position(), size: entry.size() });
    }
    Ok(members)
}

/// A parsed `.nb3` archive. Opening it reads the (small) metadata; row data stays in
/// the archive until [`Nb3SqlReader`] streams it.
pub struct Nb3Archive {
    path: PathBuf,
    manifest: Nb3Manifest,
    dialect: Nb3Dialect,
    objects: Vec<LoadedObject>,
    members: HashMap<String, ArchiveMember>,
}

impl Nb3Archive {
    pub fn open(path: &Path) -> Result<Self, String> {
        let members = index_archive_members(path)?;
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let manifest_member =
            *members.get(MANIFEST_NAME).ok_or("Not a Navicat backup archive: meta.json is missing")?;
        let manifest_bytes = read_archive_member(&mut file, MANIFEST_NAME, manifest_member, "")?;
        let manifest: Nb3Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("Invalid Navicat backup metadata: {error}"))?;
        if !manifest.encryption.is_empty() && !manifest.encryption.eq_ignore_ascii_case("None") {
            return Err("Encrypted Navicat backups are not supported; create the backup without encryption".into());
        }
        let dialect = Nb3Dialect::from_archive(&manifest.database_type)?;
        let mut objects = Vec::with_capacity(manifest.objects.len());
        for entry in &manifest.objects {
            let name = &entry.metadata.filename;
            let member = *members.get(name).ok_or_else(|| format!("Navicat backup is missing {name}"))?;
            let compressed = read_archive_member(&mut file, name, member, &entry.metadata.checksum)?;
            let meta: Nb3ObjectMeta = serde_json::from_slice(&gunzip(name, &compressed)?)
                .map_err(|error| format!("Invalid Navicat object metadata in {name}: {error}"))?;
            for chunk in &meta.data {
                if !members.contains_key(&chunk.filename) {
                    return Err(format!("Navicat backup is missing {}", chunk.filename));
                }
            }
            objects.push(LoadedObject { meta });
        }
        Ok(Self { path: path.to_path_buf(), manifest, dialect, objects, members })
    }

    pub fn database_type(&self) -> DatabaseType {
        self.dialect.database_type()
    }

    /// The source database and schema; a MySQL archive names its database as the schema.
    pub fn source_database_and_schema(&self) -> (String, String) {
        match self.dialect {
            Nb3Dialect::Mysql => (self.manifest.schema.clone(), self.manifest.schema.clone()),
            Nb3Dialect::Postgres => (self.manifest.catalog.clone(), self.manifest.schema.clone()),
        }
    }

    /// When the backup started, in seconds since the Unix epoch.
    pub fn started_at(&self) -> Option<i64> {
        self.manifest.start_time.trim().parse().ok()
    }

    fn ordered_objects(&self) -> Vec<&LoadedObject> {
        let mut objects = self.objects.iter().collect::<Vec<_>>();
        objects.sort_by_key(|object| creation_rank(&object.meta.object_type));
        objects
    }

    fn statement(&self, object_type: &str, ddl: &str) -> Option<String> {
        let trimmed = ddl.trim();
        if trimmed.is_empty() {
            return None;
        }
        if self.dialect == Nb3Dialect::Mysql && is_routine_like(object_type) {
            return Some(format!("{}\n\n", mysql_delimited_statement(trimmed)));
        }
        if trimmed.ends_with(';') {
            Some(format!("{trimmed}\n\n"))
        } else {
            Some(format!("{trimmed};\n\n"))
        }
    }

    fn drop_statement(&self, object: &LoadedObject) -> Option<String> {
        if object.meta.ddl.trim().is_empty() {
            // Data-only objects are loaded into the existing table, never replaced.
            return None;
        }
        let name = self.dialect.quote(&object.meta.name);
        let cascade = if self.dialect == Nb3Dialect::Postgres { " CASCADE" } else { "" };
        let kind = match (self.dialect, object.meta.object_type.as_str()) {
            (_, "Table") => "TABLE",
            (_, "View") => "VIEW",
            (Nb3Dialect::Postgres, "MaterializedView") => "MATERIALIZED VIEW",
            (Nb3Dialect::Postgres, "Sequence") => "SEQUENCE",
            (Nb3Dialect::Mysql, "Function") => "FUNCTION",
            (Nb3Dialect::Mysql, "Procedure") => "PROCEDURE",
            (Nb3Dialect::Mysql, "Event") => "EVENT",
            _ => return None,
        };
        let cascade = if matches!(kind, "FUNCTION" | "PROCEDURE" | "EVENT") { "" } else { cascade };
        Some(format!("DROP {kind} IF EXISTS {name}{cascade};\n"))
    }

    fn insert_prefix(&self, object: &LoadedObject) -> String {
        let table = self.dialect.quote(&object.meta.name);
        let columns = object
            .meta
            .fields
            .as_deref()
            .filter(|fields| !fields.is_empty())
            .map(|fields| {
                format!(" ({})", fields.iter().map(|field| self.dialect.quote(field)).collect::<Vec<_>>().join(", "))
            })
            .unwrap_or_default();
        let overriding = if self.dialect == Nb3Dialect::Postgres
            && object.meta.ddl.to_ascii_uppercase().contains("GENERATED ALWAYS AS IDENTITY")
        {
            " OVERRIDING SYSTEM VALUE"
        } else {
            ""
        };
        format!("INSERT INTO {table}{columns}{overriding} VALUES\n")
    }

    fn restore_steps(&self) -> Result<VecDeque<RestoreStep>, String> {
        let objects = self.ordered_objects();
        let mut steps = VecDeque::new();
        let mut header = format!(
            "-- Navicat backup restored by DBX\n-- Source: {} {}\n\n",
            self.manifest.database_type,
            [self.manifest.catalog.as_str(), self.manifest.schema.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(".")
        );
        match self.dialect {
            Nb3Dialect::Mysql => header.push_str("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n"),
            Nb3Dialect::Postgres => {
                header.push_str("SET check_function_bodies = false;\n");
                // Navicat DDL is unqualified and DBX DDL may be schema-qualified, so the
                // archived schema must exist and lead the search path for both to resolve.
                // `CREATE SCHEMA IF NOT EXISTS` checks the CREATE privilege before existence,
                // so only create the schema when it is really missing.
                let schema = self.manifest.schema.trim();
                if !schema.is_empty() {
                    let literal = schema.replace('\'', "''");
                    let quoted = self.dialect.quote(schema);
                    header.push_str(&format!(
                        "DO $nb3$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '{literal}') THEN CREATE SCHEMA {quoted}; END IF; END $nb3$;\n"
                    ));
                    if schema == "public" {
                        header.push_str("SET search_path TO \"public\";\n");
                    } else {
                        header.push_str(&format!("SET search_path TO {quoted}, public;\n"));
                    }
                }
                header.push('\n');
            }
        }
        for object in objects.iter().rev() {
            if let Some(drop) = self.drop_statement(object) {
                header.push_str(&drop);
            }
        }
        header.push('\n');
        steps.push_back(RestoreStep::Sql(header));

        let (before_views, after_tables): (Vec<&LoadedObject>, Vec<&LoadedObject>) =
            objects.iter().partition(|object| creation_rank(&object.meta.object_type) <= creation_rank("Table"));
        let mut structure = String::new();
        for object in &before_views {
            if let Some(statement) = self.statement(&object.meta.object_type, &object.meta.ddl) {
                structure.push_str(&statement);
            }
        }
        steps.push_back(RestoreStep::Sql(structure));

        for object in &before_views {
            if object.meta.data.is_empty() {
                continue;
            }
            let chunks = object
                .meta
                .data
                .iter()
                .map(|chunk| DataChunk {
                    name: chunk.filename.clone(),
                    member: self.members[&chunk.filename],
                    checksum: chunk.checksum.clone(),
                })
                .collect();
            steps.push_back(RestoreStep::Rows { insert_prefix: self.insert_prefix(object), chunks });
        }

        // Every primary key and unique index must exist before any foreign key, which
        // may reference a table archived later.
        let mut post_data = String::new();
        let index_ddl = before_views.iter().flat_map(|object| &object.meta.index_ddl);
        let sub_ddl = before_views.iter().flat_map(|object| &object.meta.sub_ddl);
        for ddl in index_ddl.chain(sub_ddl) {
            if let Some(statement) = self.statement("", ddl) {
                post_data.push_str(&statement);
            }
        }
        for object in &after_tables {
            if let Some(statement) = self.statement(&object.meta.object_type, &object.meta.ddl) {
                post_data.push_str(&statement);
            }
            for ddl in object.meta.index_ddl.iter().chain(&object.meta.sub_ddl) {
                if let Some(statement) = self.statement("", ddl) {
                    post_data.push_str(&statement);
                }
            }
        }
        for object in &objects {
            for ddl in &object.meta.trigger_ddl {
                if let Some(statement) = self.statement("Trigger", ddl) {
                    post_data.push_str(&statement);
                }
            }
        }
        if self.dialect == Nb3Dialect::Mysql {
            post_data.push_str("SET FOREIGN_KEY_CHECKS = 1;\n");
        }
        steps.push_back(RestoreStep::Sql(post_data));
        Ok(steps)
    }
}

fn mysql_delimited_statement(statement: &str) -> String {
    if statement.get(..9).is_some_and(|prefix| prefix.eq_ignore_ascii_case("DELIMITER")) {
        return statement.to_string();
    }
    let body = statement.trim_end_matches(';').trim_end();
    let delimiter = ["//", "$$", ";;", "__DBX_DELIMITER__"]
        .into_iter()
        .find(|delimiter| !body.contains(delimiter))
        .unwrap_or("__DBX_DELIMITER__");
    format!("DELIMITER {delimiter}\n{body}{delimiter}\nDELIMITER ;")
}

/// Hashes the compressed bytes of a data chunk while it is decompressed.
struct ChunkSource {
    inner: std::io::Take<BufReader<File>>,
    hasher: Sha1,
    consumed: Arc<AtomicU64>,
    bytes_read: Option<Arc<AtomicU64>>,
}

impl Read for ChunkSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        self.consumed.fetch_add(read as u64, Ordering::Relaxed);
        if let Some(bytes_read) = &self.bytes_read {
            bytes_read.fetch_add(read as u64, Ordering::Relaxed);
        }
        Ok(read)
    }
}

struct RowStream {
    insert_prefix: String,
    chunks: VecDeque<DataChunk>,
    current: Option<(String, String, MultiGzDecoder<ChunkSource>)>,
    buffer: Vec<u8>,
    pos: usize,
    scanner: TupleScanner,
    eof: bool,
}

/// Renders an `.nb3` archive as a restore script: drops the archived objects, creates
/// them, loads their rows, then adds indexes, constraints and triggers.
pub struct Nb3SqlReader {
    path: PathBuf,
    dialect: Nb3Dialect,
    steps: VecDeque<RestoreStep>,
    rows: Option<RowStream>,
    output: Vec<u8>,
    output_pos: usize,
    /// Shared import progress counter; it ends at the archive size once the
    /// script is fully read, although only row chunks are counted while reading.
    bytes_read: Option<Arc<AtomicU64>>,
    consumed: Arc<AtomicU64>,
    file_size: u64,
    max_pending_row_bytes: usize,
}

impl Nb3SqlReader {
    pub fn open(path: &Path, bytes_read: Option<Arc<AtomicU64>>) -> Result<Self, String> {
        let archive = Nb3Archive::open(path)?;
        let file_size = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
        Ok(Self {
            path: archive.path.clone(),
            dialect: archive.dialect,
            steps: archive.restore_steps()?,
            rows: None,
            output: Vec::new(),
            output_pos: 0,
            bytes_read,
            consumed: Arc::new(AtomicU64::new(0)),
            file_size,
            max_pending_row_bytes: ROW_TUPLE_MAX_BYTES,
        })
    }

    fn open_chunk(&self, chunk: &DataChunk) -> std::io::Result<MultiGzDecoder<ChunkSource>> {
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(chunk.member.offset))?;
        Ok(MultiGzDecoder::new(ChunkSource {
            inner: BufReader::new(file).take(chunk.member.size),
            hasher: Sha1::new(),
            consumed: self.consumed.clone(),
            bytes_read: self.bytes_read.clone(),
        }))
    }

    /// Fills `output` with the next piece of the script; returns `false` at the end.
    fn refill(&mut self) -> std::io::Result<bool> {
        loop {
            if self.rows.is_some() {
                if let Some(statement) = self.next_insert()? {
                    self.output = statement.into_bytes();
                    self.output_pos = 0;
                    return Ok(true);
                }
                self.rows = None;
            }
            match self.steps.pop_front() {
                Some(RestoreStep::Sql(sql)) => {
                    if sql.is_empty() {
                        continue;
                    }
                    self.output = sql.into_bytes();
                    self.output_pos = 0;
                    return Ok(true);
                }
                Some(RestoreStep::Rows { insert_prefix, chunks }) => {
                    self.rows = Some(RowStream {
                        insert_prefix,
                        chunks: chunks.into(),
                        current: None,
                        buffer: Vec::new(),
                        pos: 0,
                        scanner: TupleScanner::new(self.dialect),
                        eof: true,
                    });
                }
                None => {
                    if let Some(bytes_read) = &self.bytes_read {
                        let counted = self.consumed.swap(self.file_size, Ordering::Relaxed);
                        bytes_read.fetch_add(self.file_size.saturating_sub(counted), Ordering::Relaxed);
                    }
                    return Ok(false);
                }
            }
        }
    }

    /// Builds the next multi-row INSERT for the current table, or `None` when its
    /// chunks are exhausted.
    fn next_insert(&mut self) -> std::io::Result<Option<String>> {
        let mut statement = String::new();
        let mut rows = 0;
        while rows < RESTORE_INSERT_MAX_ROWS && statement.len() < RESTORE_INSERT_MAX_BYTES {
            let Some(tuple) = self.next_tuple()? else {
                break;
            };
            if rows == 0 {
                statement.push_str(&self.rows.as_ref().expect("row stream is active").insert_prefix);
            } else {
                statement.push_str(",\n");
            }
            statement.push_str(&tuple);
            rows += 1;
        }
        if rows == 0 {
            return Ok(None);
        }
        statement.push_str(";\n");
        Ok(Some(statement))
    }

    fn next_tuple(&mut self) -> std::io::Result<Option<String>> {
        let max_pending_row_bytes = self.max_pending_row_bytes;
        loop {
            let opened_chunk = {
                let stream = self.rows.as_mut().expect("row stream is active");
                if stream.current.is_some() {
                    None
                } else {
                    match stream.chunks.pop_front() {
                        Some(chunk) => Some(chunk),
                        None => return Ok(None),
                    }
                }
            };
            if let Some(chunk) = opened_chunk {
                let decoder = self.open_chunk(&chunk)?;
                let stream = self.rows.as_mut().expect("row stream is active");
                stream.current = Some((chunk.name, chunk.checksum, decoder));
                stream.buffer.clear();
                stream.pos = 0;
                stream.scanner = TupleScanner::new(self.dialect);
                stream.eof = false;
            }

            let stream = self.rows.as_mut().expect("row stream is active");
            let scan = stream.scanner.next(&stream.buffer, &mut stream.pos).map_err(io_error)?;
            if let TupleScan::Tuple { start, end } = scan {
                let tuple = String::from_utf8(stream.buffer[start..end].to_vec())
                    .map_err(|_| io_error("Navicat backup data is not valid UTF-8"))?;
                return Ok(Some(tuple));
            }
            if stream.eof {
                let (name, checksum, decoder) = stream.current.take().expect("chunk is open");
                if !stream.scanner.is_between_tuples() {
                    return Err(io_error(format!("Navicat backup data chunk {name} ends inside a row")));
                }
                let mut source = decoder.into_inner();
                std::io::copy(&mut source, &mut std::io::sink())?;
                let digest = source.hasher.finalize().iter().map(|byte| format!("{byte:02X}")).collect::<String>();
                if !checksum.is_empty() && !digest.eq_ignore_ascii_case(&checksum) {
                    return Err(io_error(format!("Navicat backup data chunk {name} is corrupted (checksum mismatch)")));
                }
                continue;
            }
            // Keep the unfinished tuple (if any) and read more decompressed data.
            let keep_from = if stream.scanner.is_between_tuples() { stream.pos } else { stream.scanner.start };
            stream.buffer.drain(..keep_from);
            stream.pos -= keep_from;
            if !stream.scanner.is_between_tuples() {
                stream.scanner.start = 0;
            }
            let (name, _, decoder) = stream.current.as_mut().expect("chunk is open");
            let mut chunk = vec![0; 256 * 1024];
            let read = decoder
                .read(&mut chunk)
                .map_err(|error| io_error(format!("Navicat backup data chunk {name} is corrupted: {error}")))?;
            if read == 0 {
                stream.eof = true;
            } else {
                stream.buffer.extend_from_slice(&chunk[..read]);
                if stream.buffer.len() > max_pending_row_bytes {
                    return Err(io_error(format!(
                        "Navicat backup data chunk {name} contains a row larger than {max_pending_row_bytes} bytes"
                    )));
                }
            }
        }
    }
}

impl Read for Nb3SqlReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.output_pos >= self.output.len() {
            if !self.refill()? {
                return Ok(0);
            }
        }
        let available = &self.output[self.output_pos..];
        let count = available.len().min(buffer.len());
        buffer[..count].copy_from_slice(&available[..count]);
        self.output_pos += count;
        Ok(count)
    }
}

// ---------------------------------------------------------------------------
// Backup: DBX SQL export -> archive
// ---------------------------------------------------------------------------

/// Minimal SQL head reader used to classify exported statements.
struct Cursor<'a> {
    text: &'a str,
    pos: usize,
    fold_unquoted: bool,
}

impl<'a> Cursor<'a> {
    fn new(text: &'a str, fold_unquoted: bool) -> Self {
        Self { text, pos: 0, fold_unquoted }
    }

    fn rest(&self) -> &'a str {
        &self.text[self.pos..]
    }

    fn skip_space(&mut self) {
        loop {
            let rest = self.rest();
            let trimmed = rest.trim_start();
            self.pos += rest.len() - trimmed.len();
            if trimmed.starts_with("--") || trimmed.starts_with('#') {
                self.pos += trimmed.find('\n').map_or(trimmed.len(), |index| index + 1);
            } else if trimmed.starts_with("/*") && !trimmed.starts_with("/*!") {
                self.pos += trimmed.find("*/").map_or(trimmed.len(), |index| index + 2);
            } else {
                break;
            }
        }
    }

    fn keyword(&mut self, keyword: &str) -> bool {
        self.skip_space();
        let rest = self.rest();
        let matches = rest.len() >= keyword.len()
            && rest.is_char_boundary(keyword.len())
            && rest[..keyword.len()].eq_ignore_ascii_case(keyword)
            && !rest.as_bytes().get(keyword.len()).copied().is_some_and(is_identifier_byte);
        if matches {
            self.pos += keyword.len();
        }
        matches
    }

    fn keywords(&mut self, keywords: &[&str]) -> bool {
        let saved = self.pos;
        if keywords.iter().all(|keyword| self.keyword(keyword)) {
            true
        } else {
            self.pos = saved;
            false
        }
    }

    fn any_keyword(&mut self, keywords: &[&str]) -> bool {
        keywords.iter().any(|keyword| self.keyword(keyword))
    }

    fn identifier_part(&mut self) -> Option<String> {
        self.skip_space();
        let rest = self.rest();
        let close = match rest.chars().next()? {
            '`' => '`',
            '"' => '"',
            '[' => ']',
            _ => {
                let len = rest.bytes().take_while(|byte| is_identifier_byte(*byte)).count();
                if len == 0 {
                    return None;
                }
                self.pos += len;
                let raw = &rest[..len];
                return Some(if self.fold_unquoted { raw.to_lowercase() } else { raw.to_string() });
            }
        };
        let mut value = String::new();
        let mut chars = rest.char_indices().skip(1).peekable();
        while let Some((index, ch)) = chars.next() {
            if ch == close {
                if close != ']' && chars.peek().is_some_and(|(_, next)| *next == close) {
                    value.push(ch);
                    chars.next();
                    continue;
                }
                self.pos += index + ch.len_utf8();
                return Some(value);
            }
            value.push(ch);
        }
        None
    }

    fn identifier_path(&mut self) -> Option<Vec<String>> {
        let mut parts = vec![self.identifier_part()?];
        loop {
            let saved = self.pos;
            self.skip_space();
            if !self.rest().starts_with('.') {
                self.pos = saved;
                return Some(parts);
            }
            self.pos += 1;
            match self.identifier_part() {
                Some(part) => parts.push(part),
                None => {
                    self.pos = saved;
                    return Some(parts);
                }
            }
        }
    }

    fn name(&mut self) -> Option<String> {
        self.identifier_path().and_then(|mut parts| parts.pop())
    }

    fn quoted_string(&mut self) -> bool {
        self.skip_space();
        let bytes = self.rest().as_bytes();
        if bytes.first() != Some(&b'\'') {
            return false;
        }
        let mut index = 1;
        while index < bytes.len() {
            match bytes[index] {
                b'\\' => index += 2,
                b'\'' if bytes.get(index + 1) == Some(&b'\'') => index += 2,
                b'\'' => {
                    self.pos += index + 1;
                    return true;
                }
                _ => index += 1,
            }
        }
        self.pos = self.text.len();
        true
    }

    /// Skips a `KEY = value` clause such as MySQL ``DEFINER=`root`@`%` ``.
    fn skip_assignment(&mut self, key: &str) -> bool {
        if !self.keyword(key) {
            return false;
        }
        self.skip_space();
        if self.rest().starts_with('=') {
            self.pos += 1;
        }
        loop {
            if self.identifier_part().is_none() && !self.quoted_string() {
                break;
            }
            if self.rest().starts_with("()") {
                self.pos += 2;
            }
            if self.rest().starts_with('@') {
                self.pos += 1;
                continue;
            }
            break;
        }
        true
    }

    /// Advances past the next top-level occurrence of `keyword`.
    fn seek_keyword(&mut self, keyword: &str) -> bool {
        loop {
            self.skip_space();
            if self.rest().is_empty() {
                return false;
            }
            if self.keyword(keyword) {
                return true;
            }
            if self.quoted_string() || self.identifier_part().is_some() {
                continue;
            }
            self.pos += self.rest().chars().next().map_or(1, char::len_utf8);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Classified {
    Skip,
    Object { object_type: &'static str, name: String },
    Rows { table: String, columns: Vec<String>, values_at: usize },
    Trigger { table: String },
    TableIndex { table: String },
    TableSub { table: String },
    ObjectSub { object_type: &'static str, name: String },
    Other,
}

const ALTERABLE_OBJECTS: &[(&[&str], &str)] = &[
    (&["SEQUENCE"], "Sequence"),
    (&["MATERIALIZED", "VIEW"], "MaterializedView"),
    (&["VIEW"], "View"),
    (&["FUNCTION"], "Function"),
    (&["PROCEDURE"], "Procedure"),
    (&["EVENT"], "Event"),
    (&["TYPE"], "Type"),
    (&["DOMAIN"], "Domain"),
    (&["EXTENSION"], "Extension"),
];

fn classify_statement(dialect: Nb3Dialect, body: &str) -> Classified {
    let mut cursor = Cursor::new(body, dialect == Nb3Dialect::Postgres);
    if cursor.keyword("INSERT") {
        return classify_insert(cursor);
    }
    if cursor.keyword("CREATE") {
        return classify_create(cursor);
    }
    if cursor.keyword("ALTER") {
        if cursor.keyword("TABLE") {
            cursor.keywords(&["IF", "EXISTS"]);
            cursor.keyword("ONLY");
            let Some(table) = cursor.name() else {
                return Classified::Other;
            };
            // Navicat keeps primary keys, unique constraints and indexes in IndexDDL and
            // everything else (foreign keys, ownership) in SubDDL.
            let index_like = cursor.keyword("ADD") && {
                if cursor.keyword("CONSTRAINT") {
                    let constraint_name_at = cursor.pos;
                    if cursor.keywords(&["PRIMARY", "KEY"]) || cursor.keyword("UNIQUE") {
                        cursor.pos = constraint_name_at;
                    } else {
                        cursor.identifier_part();
                    }
                }
                cursor.keywords(&["PRIMARY", "KEY"])
                    || cursor.any_keyword(&["UNIQUE", "INDEX", "KEY", "FULLTEXT", "SPATIAL"])
            };
            return if index_like { Classified::TableIndex { table } } else { Classified::TableSub { table } };
        }
        return classify_object_reference(cursor);
    }
    if cursor.keywords(&["COMMENT", "ON"]) {
        if cursor.keyword("COLUMN") {
            return match cursor.identifier_path() {
                Some(mut parts) if parts.len() >= 2 => {
                    parts.pop();
                    Classified::TableSub { table: parts.pop().unwrap_or_default() }
                }
                _ => Classified::Other,
            };
        }
        if cursor.keyword("TABLE") {
            return cursor.name().map_or(Classified::Other, |table| Classified::TableSub { table });
        }
        return classify_object_reference(cursor);
    }
    if cursor.keyword("SELECT") {
        return classify_setval(dialect, cursor.rest());
    }
    if cursor.any_keyword(&[
        "SET",
        "USE",
        "DROP",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "START",
        "LOCK",
        "UNLOCK",
        "DELIMITER",
    ]) {
        return Classified::Skip;
    }
    Classified::Other
}

fn classify_insert(mut cursor: Cursor<'_>) -> Classified {
    cursor.keyword("IGNORE");
    if !cursor.keyword("INTO") {
        return Classified::Other;
    }
    let Some(table) = cursor.name() else {
        return Classified::Other;
    };
    let mut columns = Vec::new();
    cursor.skip_space();
    if cursor.rest().starts_with('(') {
        cursor.pos += 1;
        loop {
            let Some(column) = cursor.identifier_part() else {
                return Classified::Other;
            };
            columns.push(column);
            cursor.skip_space();
            if cursor.rest().starts_with(',') {
                cursor.pos += 1;
            } else if cursor.rest().starts_with(')') {
                cursor.pos += 1;
                break;
            } else {
                return Classified::Other;
            }
        }
    }
    if cursor.keyword("OVERRIDING") {
        cursor.any_keyword(&["SYSTEM", "USER"]);
        cursor.keyword("VALUE");
    }
    if !(cursor.keyword("VALUES") || cursor.keyword("VALUE")) {
        return Classified::Other;
    }
    Classified::Rows { table, columns, values_at: cursor.pos }
}

fn classify_create(mut cursor: Cursor<'_>) -> Classified {
    cursor.keywords(&["OR", "REPLACE"]);
    loop {
        if cursor.skip_assignment("DEFINER") || cursor.skip_assignment("ALGORITHM") {
            continue;
        }
        if cursor.keywords(&["SQL", "SECURITY"]) {
            cursor.identifier_part();
            continue;
        }
        if cursor.any_keyword(&[
            "GLOBAL",
            "LOCAL",
            "TEMPORARY",
            "TEMP",
            "UNLOGGED",
            "UNIQUE",
            "RECURSIVE",
            "CONSTRAINT",
            "AGGREGATE",
            "TRUSTED",
            "PROCEDURAL",
        ]) {
            continue;
        }
        break;
    }
    if cursor.keyword("TRIGGER") {
        return if cursor.seek_keyword("ON") {
            cursor.name().map_or(Classified::Other, |table| Classified::Trigger { table })
        } else {
            Classified::Other
        };
    }
    if cursor.keyword("INDEX") {
        if !cursor.seek_keyword("ON") {
            return Classified::Other;
        }
        cursor.keyword("ONLY");
        return cursor.name().map_or(Classified::Other, |table| Classified::TableIndex { table });
    }
    if cursor.any_keyword(&["DATABASE", "SCHEMA"]) {
        return Classified::Skip;
    }
    let object_type = if cursor.keyword("TABLE") {
        "Table"
    } else if let Some((_, object_type)) = ALTERABLE_OBJECTS.iter().find(|(keywords, _)| cursor.keywords(keywords)) {
        object_type
    } else {
        return Classified::Other;
    };
    cursor.keywords(&["IF", "NOT", "EXISTS"]);
    cursor.name().map_or(Classified::Other, |name| Classified::Object { object_type, name })
}

fn classify_object_reference(mut cursor: Cursor<'_>) -> Classified {
    let Some((_, object_type)) = ALTERABLE_OBJECTS.iter().find(|(keywords, _)| cursor.keywords(keywords)) else {
        return Classified::Other;
    };
    cursor.keywords(&["IF", "EXISTS"]);
    cursor.name().map_or(Classified::Other, |name| Classified::ObjectSub { object_type, name })
}

fn classify_setval(dialect: Nb3Dialect, rest: &str) -> Classified {
    static SETVAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?is)^\s*(?:pg_catalog\s*\.\s*)?setval\s*\(\s*'((?:[^']|'')*)'")
            .expect("valid setval regex")
    });
    let Some(captures) = SETVAL.captures(rest) else {
        return Classified::Other;
    };
    let reference = captures[1].replace("''", "'");
    Cursor::new(&reference, dialect == Nb3Dialect::Postgres)
        .name()
        .map_or(Classified::Other, |name| Classified::ObjectSub { object_type: "Sequence", name })
}

struct ChunkWriter {
    name: String,
    path: PathBuf,
    encoder: GzEncoder<BufWriter<File>>,
    uncompressed: u64,
    records: u64,
}

struct StagedChunk {
    name: String,
    path: PathBuf,
    checksum: String,
}

struct PendingObject {
    uuid: String,
    object_type: &'static str,
    name: String,
    ddl: String,
    sub_ddl: Vec<String>,
    index_ddl: Vec<String>,
    trigger_ddl: Vec<String>,
    fields: Option<Vec<String>>,
    rows: u64,
    chunks: Vec<StagedChunk>,
    writer: Option<ChunkWriter>,
}

impl PendingObject {
    fn write_tuple(&mut self, staging: &Path, tuple: &str) -> Result<(), String> {
        if self.writer.as_ref().is_some_and(|writer| writer.uncompressed >= DATA_CHUNK_MAX_BYTES) {
            self.finish_chunk()?;
        }
        if self.writer.is_none() {
            let name = format!("{}.data.{:05}.sql.gz", self.uuid, self.chunks.len());
            let path = staging.join(&name);
            let file = File::create(&path).map_err(|error| format!("Failed to stage Navicat backup data: {error}"))?;
            self.writer = Some(ChunkWriter {
                name,
                path,
                encoder: GzEncoder::new(BufWriter::new(file), Compression::default()),
                uncompressed: 0,
                records: 0,
            });
        }
        let writer = self.writer.as_mut().expect("chunk writer is open");
        let write = |encoder: &mut GzEncoder<BufWriter<File>>, bytes: &[u8]| {
            encoder.write_all(bytes).map_err(|error| format!("Failed to stage Navicat backup data: {error}"))
        };
        if writer.records > 0 {
            write(&mut writer.encoder, RECORD_SEPARATOR)?;
            writer.uncompressed += RECORD_SEPARATOR.len() as u64;
        }
        write(&mut writer.encoder, tuple.as_bytes())?;
        writer.uncompressed += tuple.len() as u64;
        writer.records += 1;
        self.rows += 1;
        Ok(())
    }

    fn finish_chunk(&mut self) -> Result<(), String> {
        let Some(writer) = self.writer.take() else {
            return Ok(());
        };
        writer
            .encoder
            .finish()
            .and_then(|mut file| file.flush())
            .map_err(|error| format!("Failed to stage Navicat backup data: {error}"))?;
        let mut hasher = Sha1::new();
        let mut file = File::open(&writer.path).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut hasher).map_err(|error| error.to_string())?;
        let checksum = hasher.finalize().iter().map(|byte| format!("{byte:02X}")).collect();
        self.chunks.push(StagedChunk { name: writer.name, path: writer.path, checksum });
        Ok(())
    }
}

fn append_member<R: Read, W: Write>(
    builder: &mut tar::Builder<W>,
    name: &str,
    size: u64,
    data: R,
) -> Result<(), String> {
    let mut header = tar::Header::new_ustar();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(size);
    header.set_mode(0o644);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    builder.append_data(&mut header, name, data).map_err(|error| format!("Failed to write Navicat backup: {error}"))
}

/// Receives a DBX SQL export and writes it as a Navicat `.nb3` archive on
/// [`finish`](Self::finish). Row data is staged as compressed chunks next to the
/// destination while the export runs; DDL is kept in memory.
pub struct Nb3ExportWriter {
    output: Option<File>,
    dialect: Nb3Dialect,
    catalog: String,
    schema: String,
    started_at: i64,
    staging: tempfile::TempDir,
    splitter: SqlStatementSplitter,
    pending: Vec<u8>,
    objects: Vec<PendingObject>,
    index: HashMap<(&'static str, String), usize>,
    last_object: Option<usize>,
    orphans: Vec<String>,
}

impl Nb3ExportWriter {
    pub fn new(
        output: File,
        staging_parent: Option<&Path>,
        db_type: DatabaseType,
        database: &str,
        schema: &str,
    ) -> Result<Self, String> {
        let dialect = Nb3Dialect::from_database_type(db_type)?;
        let staging = match staging_parent {
            Some(parent) => tempfile::Builder::new().prefix(".dbx-nb3-").tempdir_in(parent),
            None => tempfile::Builder::new().prefix("dbx-nb3-").tempdir(),
        }
        .map_err(|error| format!("Failed to create Navicat backup staging directory: {error}"))?;
        let (catalog, schema) = match dialect {
            Nb3Dialect::Mysql => (String::new(), database.to_string()),
            Nb3Dialect::Postgres => (database.to_string(), schema.to_string()),
        };
        Ok(Self {
            output: Some(output),
            dialect,
            catalog,
            schema,
            started_at: chrono::Utc::now().timestamp(),
            staging,
            splitter: SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(db_type)),
            pending: Vec::new(),
            objects: Vec::new(),
            index: HashMap::new(),
            last_object: None,
            orphans: Vec::new(),
        })
    }

    fn object(&mut self, object_type: &'static str, name: &str) -> usize {
        if let Some(index) = self.index.get(&(object_type, name.to_string())) {
            return *index;
        }
        let index = self.objects.len();
        self.objects.push(PendingObject {
            uuid: uuid::Uuid::new_v4().to_string(),
            object_type,
            name: name.to_string(),
            ddl: String::new(),
            sub_ddl: Vec::new(),
            index_ddl: Vec::new(),
            trigger_ddl: Vec::new(),
            fields: None,
            rows: 0,
            chunks: Vec::new(),
            writer: None,
        });
        self.index.insert((object_type, name.to_string()), index);
        index
    }

    fn attach_to_last(&mut self, statement: &str) {
        match self.last_object {
            Some(index) => self.objects[index].sub_ddl.push(statement.to_string()),
            None => self.orphans.push(statement.to_string()),
        }
    }

    fn handle_statement(&mut self, sql: &str) -> Result<(), String> {
        let mut cursor = Cursor::new(sql, false);
        cursor.skip_space();
        let body = cursor.rest().trim_end().trim_end_matches(';').trim_end();
        if body.is_empty() {
            return Ok(());
        }
        match classify_statement(self.dialect, body) {
            Classified::Skip => {}
            Classified::Object { object_type, name } => {
                let index = self.object(object_type, &name);
                let object = &mut self.objects[index];
                if object.ddl.is_empty() {
                    object.ddl = body.to_string();
                } else {
                    object.sub_ddl.push(body.to_string());
                }
                self.last_object = Some(index);
            }
            Classified::Rows { table, columns, values_at } => {
                let index = self.object("Table", &table);
                let staging = self.staging.path().to_path_buf();
                let object = &mut self.objects[index];
                let Some(tuples) = split_value_tuples(self.dialect, &body[values_at..]) else {
                    object.sub_ddl.push(body.to_string());
                    return Ok(());
                };
                if object.fields.is_none() && !columns.is_empty() {
                    object.fields = Some(columns);
                }
                for tuple in tuples {
                    object.write_tuple(&staging, tuple)?;
                }
            }
            Classified::Trigger { table } => {
                let index = self.object("Table", &table);
                self.objects[index].trigger_ddl.push(body.to_string());
            }
            Classified::TableIndex { table } => {
                let index = self.object("Table", &table);
                self.objects[index].index_ddl.push(body.to_string());
            }
            Classified::TableSub { table } => {
                let index = self.object("Table", &table);
                self.objects[index].sub_ddl.push(body.to_string());
            }
            Classified::ObjectSub { object_type, name } => {
                if let Some(index) = self.index.get(&(object_type, name.clone())).copied() {
                    self.objects[index].sub_ddl.push(body.to_string());
                } else if object_type == "Sequence" {
                    // Sequences owned by a serial/identity column have no CREATE statement.
                    let index = self.object(object_type, &name);
                    self.objects[index].sub_ddl.push(body.to_string());
                } else {
                    self.attach_to_last(body);
                }
            }
            Classified::Other => self.attach_to_last(body),
        }
        Ok(())
    }

    fn split_pending(&mut self, final_chunk: bool) -> Result<(), String> {
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(text) => text.len(),
            Err(error) if error.error_len().is_none() && !final_chunk => error.valid_up_to(),
            Err(_) => return Err("Navicat backups require a UTF-8 SQL export".to_string()),
        };
        if valid == 0 {
            return Ok(());
        }
        let rest = self.pending.split_off(valid);
        let text = String::from_utf8(std::mem::replace(&mut self.pending, rest)).expect("validated UTF-8");
        for statement in self.splitter.push_chunk(&text) {
            self.handle_statement(&statement)?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.split_pending(true)?;
        for statement in std::mem::take(&mut self.splitter).finish_with_control() {
            self.handle_statement(&statement.sql)?;
        }
        if !self.orphans.is_empty() {
            if let Some(first) = self.objects.first_mut() {
                log::warn!("[navicat-nb3] attaching {} unclassified statements to {}", self.orphans.len(), first.name);
                first.sub_ddl.splice(0..0, std::mem::take(&mut self.orphans));
            }
        }
        for object in &mut self.objects {
            object.finish_chunk()?;
        }
        let mut order = (0..self.objects.len()).collect::<Vec<_>>();
        order.sort_by_key(|index| creation_rank(self.objects[*index].object_type));

        let output = self.output.take().expect("Navicat backup output is open");
        let mut builder = tar::Builder::new(BufWriter::new(output));
        let mut entries = Vec::with_capacity(order.len());
        for index in order {
            let object = &self.objects[index];
            for chunk in &object.chunks {
                let file = File::open(&chunk.path).map_err(|error| error.to_string())?;
                let size = file.metadata().map_err(|error| error.to_string())?.len();
                append_member(&mut builder, &chunk.name, size, file)?;
            }
            let is_table = object.object_type == "Table";
            let meta = Nb3ObjectMeta {
                meta_version: META_VERSION.to_string(),
                name: object.name.clone(),
                object_type: object.object_type.to_string(),
                ddl: object.ddl.clone(),
                sub_ddl: object.sub_ddl.clone(),
                auto_increment: String::new(),
                fields: is_table.then(|| object.fields.clone().unwrap_or_default()),
                trigger_ddl: object.trigger_ddl.clone(),
                index_ddl: object.index_ddl.clone(),
                data: object
                    .chunks
                    .iter()
                    .map(|chunk| Nb3MemberRef { filename: chunk.name.clone(), checksum: chunk.checksum.clone() })
                    .collect(),
            };
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&navicat_json(&meta)?).map_err(|error| error.to_string())?;
            let compressed = encoder.finish().map_err(|error| error.to_string())?;
            let filename = format!("{}.meta.json.gz", object.uuid);
            append_member(&mut builder, &filename, compressed.len() as u64, compressed.as_slice())?;
            entries.push(Nb3ObjectEntry {
                uuid: object.uuid.clone(),
                object_type: object.object_type.to_string(),
                name: object.name.clone(),
                rows: is_table.then(|| object.rows.to_string()),
                metadata: Nb3MemberRef { filename, checksum: sha1_hex(&compressed) },
            });
        }
        let manifest = Nb3Manifest {
            meta_version: META_VERSION.to_string(),
            database_type: self.dialect.archive_name().to_string(),
            service_provider: String::new(),
            catalog: self.catalog.clone(),
            schema: self.schema.clone(),
            start_time: self.started_at.to_string(),
            end_time: chrono::Utc::now().timestamp().to_string(),
            encryption: "None".to_string(),
            comment: String::new(),
            objects: entries,
        };
        let manifest = navicat_json(&manifest)?;
        append_member(&mut builder, MANIFEST_NAME, manifest.len() as u64, manifest.as_slice())?;
        builder
            .into_inner()
            .and_then(|mut writer| writer.flush())
            .map_err(|error| format!("Failed to write Navicat backup: {error}"))
    }
}

impl Write for Nb3ExportWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.pending.extend_from_slice(buffer);
        if self.pending.len() >= EXPORT_SPLIT_THRESHOLD_BYTES {
            self.split_pending(false).map_err(io_error)?;
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tuples(dialect: Nb3Dialect, text: &str) -> Vec<String> {
        let mut scanner = TupleScanner::new(dialect);
        let mut pos = 0;
        let mut found = Vec::new();
        while let TupleScan::Tuple { start, end } = scanner.next(text.as_bytes(), &mut pos).unwrap() {
            found.push(text[start..end].to_string());
        }
        assert!(scanner.is_between_tuples(), "scanner ended inside a tuple: {text}");
        found
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// Builds an archive the way Navicat lays it out: per-object metadata, data
    /// chunks, then `meta.json`.
    fn navicat_archive(path: &Path, database_type: &str, objects: &[(serde_json::Value, Vec<&str>)]) {
        let mut builder = tar::Builder::new(File::create(path).unwrap());
        let mut entries = Vec::new();
        for (index, (meta, chunks)) in objects.iter().enumerate() {
            let uuid = format!("00000000-0000-0000-0000-{index:012}");
            let mut meta = meta.clone();
            let mut data = Vec::new();
            for (chunk_index, chunk) in chunks.iter().enumerate() {
                let name = format!("{uuid}.data.{chunk_index:05}.sql.gz");
                let compressed = gzip(chunk.as_bytes());
                data.push(serde_json::json!({ "Filename": name, "Checksum": sha1_hex(&compressed) }));
                append_member(&mut builder, &name, compressed.len() as u64, compressed.as_slice()).unwrap();
            }
            meta["Data"] = serde_json::Value::Array(data);
            let compressed = gzip(&navicat_json(&meta).unwrap());
            let filename = format!("{uuid}.meta.json.gz");
            append_member(&mut builder, &filename, compressed.len() as u64, compressed.as_slice()).unwrap();
            entries.push(serde_json::json!({
                "UUID": uuid,
                "Type": meta["Type"],
                "Name": meta["Name"],
                "Metadata": { "Filename": filename, "Checksum": sha1_hex(&compressed) },
            }));
        }
        let manifest = navicat_json(&serde_json::json!({
            "MetaVersion": "30101",
            "DatabaseType": database_type,
            "ServiceProvider": "",
            "Catalog": "app",
            "Schema": "public",
            "StartTime": "1765165827",
            "EndTime": "1765165829",
            "Encryption": "None",
            "Comment": "",
            "Objects": entries,
        }))
        .unwrap();
        append_member(&mut builder, MANIFEST_NAME, manifest.len() as u64, manifest.as_slice()).unwrap();
        builder.into_inner().unwrap();
    }

    fn restore_script(path: &Path) -> Result<String, String> {
        let mut reader = Nb3SqlReader::open(path, None)?;
        let mut script = String::new();
        reader.read_to_string(&mut script).map_err(|error| error.to_string())?;
        Ok(script)
    }

    fn position(script: &str, needle: &str) -> usize {
        script.find(needle).unwrap_or_else(|| panic!("{needle:?} missing from restore script:\n{script}"))
    }

    fn split_statements(db_type: DatabaseType, script: &str) -> Vec<String> {
        let mut splitter = SqlStatementSplitter::with_options(SqlParsingOptions::for_database_type(db_type));
        let mut statements = splitter.push_chunk(script);
        statements.extend(splitter.finish_with_control().into_iter().map(|statement| statement.sql));
        statements
    }

    #[test]
    fn tuple_scanner_respects_dialect_quoting() {
        assert_eq!(
            tuples(Nb3Dialect::Mysql, "(1, 'a\\'), (', NULL)\x1e\n(2, \"x)\", 0x41)"),
            ["(1, 'a\\'), (', NULL)", "(2, \"x)\", 0x41)"]
        );
        assert_eq!(
            tuples(Nb3Dialect::Postgres, "(1, 'it''s (fine)', E'a\\'b)')\x1e\n(2, '{\"a\",\"b\"}', 'C:\\')"),
            ["(1, 'it''s (fine)', E'a\\'b)')", "(2, '{\"a\",\"b\"}', 'C:\\')"]
        );
        assert!(split_value_tuples(Nb3Dialect::Mysql, "(1) ON DUPLICATE KEY UPDATE id = 1").is_none());
    }

    #[test]
    fn classifies_exported_statements() {
        let mysql = |sql| classify_statement(Nb3Dialect::Mysql, sql);
        let postgres = |sql| classify_statement(Nb3Dialect::Postgres, sql);
        assert_eq!(
            mysql("CREATE TABLE IF NOT EXISTS `app`.`users` (`id` int)"),
            Classified::Object { object_type: "Table", name: "users".into() }
        );
        assert_eq!(
            mysql("CREATE ALGORITHM = UNDEFINED DEFINER = `root`@`%` SQL SECURITY DEFINER VIEW `v` AS SELECT 1"),
            Classified::Object { object_type: "View", name: "v".into() }
        );
        assert_eq!(
            mysql(
                "CREATE DEFINER=`root`@`localhost` TRIGGER `trg` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.id = 1"
            ),
            Classified::Trigger { table: "users".into() }
        );
        assert_eq!(
            postgres("CREATE UNIQUE INDEX \"users_email\" ON ONLY \"public\".\"users\" USING btree (email)"),
            Classified::TableIndex { table: "users".into() }
        );
        assert_eq!(
            postgres("ALTER TABLE \"public\".\"users\" ADD CONSTRAINT \"users_pkey\" PRIMARY KEY (\"id\")"),
            Classified::TableIndex { table: "users".into() }
        );
        assert_eq!(
            postgres("ALTER TABLE ONLY public.Orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id)"),
            Classified::TableSub { table: "orders".into() }
        );
        assert_eq!(
            postgres("SELECT pg_catalog.setval('\"public\".\"users_id_seq\"', 42, true)"),
            Classified::ObjectSub { object_type: "Sequence", name: "users_id_seq".into() }
        );
        assert_eq!(
            postgres("COMMENT ON COLUMN \"public\".\"users\".\"email\" IS 'x'"),
            Classified::TableSub { table: "users".into() }
        );
        assert_eq!(
            mysql("INSERT INTO `users` (`id`, `name`) VALUES (1, 'a')"),
            Classified::Rows {
                table: "users".into(),
                columns: vec!["id".into(), "name".into()],
                values_at: "INSERT INTO `users` (`id`, `name`) VALUES".len()
            }
        );
        assert_eq!(mysql("SET FOREIGN_KEY_CHECKS = 0"), Classified::Skip);
        assert_eq!(mysql("DROP TABLE IF EXISTS `users`"), Classified::Skip);
        assert_eq!(postgres("GRANT SELECT ON users TO app"), Classified::Other);
    }

    #[test]
    fn mysql_export_round_trips_through_nb3() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.nb3");
        let mut writer = Nb3ExportWriter::new(
            File::create(&path).unwrap(),
            Some(directory.path()),
            DatabaseType::Mysql,
            "app",
            "app",
        )
        .unwrap();
        let export = "-- Database export: app\n-- Generated by DBX\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n\
            DROP TABLE IF EXISTS `users`;\n\
            CREATE TABLE `users` (\n  `id` int NOT NULL,\n  `name` varchar(20),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n\n\
            INSERT INTO `users` (`id`, `name`) VALUES (1, 'semi;colon'), (2, 'it\\'s (ok)');\n\
            INSERT INTO `users` (`id`, `name`) VALUES (3, NULL);\n\n\
            CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `user_names` AS select `name` from `users`;\n\n\
            DELIMITER //\nCREATE DEFINER=`root`@`%` TRIGGER `trim_name` BEFORE INSERT ON `users` FOR EACH ROW\nBEGIN\n  SET NEW.name = TRIM(NEW.name);\nEND//\nDELIMITER ;\n\n\
            DELIMITER //\nCREATE DEFINER=`root`@`%` PROCEDURE `touch`()\nBEGIN\n  SELECT 1;\nEND//\nDELIMITER ;\n\n\
            SET FOREIGN_KEY_CHECKS = 1;\n";
        // Feed the export in small pieces, as the exporter writes it.
        for piece in export.as_bytes().chunks(7) {
            writer.write_all(piece).unwrap();
        }
        writer.finish().unwrap();
        assert!(directory.path().read_dir().unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".dbx-nb3-")));

        let archive = Nb3Archive::open(&path).unwrap();
        assert_eq!(archive.manifest.database_type, "MYSQL");
        assert_eq!(archive.manifest.schema, "app");
        let objects = archive
            .objects
            .iter()
            .map(|object| (object.meta.object_type.as_str(), object.meta.name.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(objects, [("Procedure", "touch"), ("Table", "users"), ("View", "user_names")]);
        let users = &archive.objects[1];
        assert_eq!(archive.manifest.objects[1].rows.as_deref(), Some("3"));
        assert_eq!(users.meta.fields.as_deref(), Some(&["id".to_string(), "name".to_string()][..]));
        assert_eq!(users.meta.trigger_ddl.len(), 1);
        assert!(users.meta.trigger_ddl[0].starts_with("CREATE DEFINER=`root`@`%` TRIGGER `trim_name`"));
        assert!(users.meta.trigger_ddl[0].ends_with("END"));

        let script = restore_script(&path).unwrap();
        let drop_view = position(&script, "DROP VIEW IF EXISTS `user_names`;");
        let drop_table = position(&script, "DROP TABLE IF EXISTS `users`;");
        let create_procedure = position(&script, "PROCEDURE `touch`()");
        let create_table = position(&script, "CREATE TABLE `users`");
        let insert = position(
            &script,
            "INSERT INTO `users` (`id`, `name`) VALUES\n(1, 'semi;colon'),\n(2, 'it\\'s (ok)'),\n(3, NULL);",
        );
        let view = position(&script, "VIEW `user_names` AS");
        let trigger = position(&script, "DELIMITER //\nCREATE DEFINER=`root`@`%` TRIGGER `trim_name`");
        assert!(drop_view < drop_table && drop_table < create_procedure && create_procedure < create_table);
        assert!(create_table < insert && insert < view && view < trigger);
        assert!(script.trim_end().ends_with("SET FOREIGN_KEY_CHECKS = 1;"));

        let statements = split_statements(DatabaseType::Mysql, &script);
        assert!(statements.iter().any(|statement| statement.contains("SET NEW.name = TRIM(NEW.name);\nEND")));
    }

    #[test]
    fn restores_navicat_postgres_archive_in_dependency_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("navicat.nb3");
        navicat_archive(
            &path,
            "PGSQL",
            &[
                (
                    serde_json::json!({
                        "MetaVersion": "30101", "Name": "Users_id_seq", "Type": "Sequence",
                        "DDL": "CREATE SEQUENCE \"Users_id_seq\" \r\nINCREMENT 1\r\nCACHE 1",
                        "SubDDL": [
                            "ALTER SEQUENCE \"Users_id_seq\"\r\nOWNED BY \"Users\".\"id\"",
                            "SELECT setval('\"Users_id_seq\"', 3, true)"
                        ],
                        "AutoIncrement": "", "TriggerDDL": [], "IndexDDL": []
                    }),
                    vec![],
                ),
                (
                    // Archived before the table its foreign key references, as Navicat orders by name.
                    serde_json::json!({
                        "MetaVersion": "30101", "Name": "Approval", "Type": "Table",
                        "DDL": "CREATE TABLE \"Approval\" (\r\n  \"approver_id\" int4 NOT NULL\r\n)",
                        "SubDDL": ["ALTER TABLE \"Approval\" ADD CONSTRAINT \"Approval_approver_id_fkey\" FOREIGN KEY (\"approver_id\") REFERENCES \"public\".\"Users\" (\"id\")"],
                        "AutoIncrement": "", "Fields": ["approver_id"], "TriggerDDL": [], "IndexDDL": []
                    }),
                    vec![],
                ),
                (
                    serde_json::json!({
                        "MetaVersion": "30101", "Name": "Users", "Type": "Table",
                        "DDL": "CREATE TABLE \"Users\" (\r\n  \"id\" int4 NOT NULL DEFAULT nextval('\"Users_id_seq\"'::regclass),\r\n  \"note\" text\r\n)\r\n;\r\nALTER TABLE \"Users\" OWNER TO \"postgres\"",
                        "SubDDL": ["ALTER TABLE \"Users\" ADD CONSTRAINT \"Users_parent_fkey\" FOREIGN KEY (\"id\") REFERENCES \"public\".\"Users\" (\"id\")"],
                        "AutoIncrement": "", "Fields": ["id", "note"], "TriggerDDL": [],
                        "IndexDDL": ["ALTER TABLE \"Users\" ADD CONSTRAINT \"Users_pkey\" PRIMARY KEY (\"id\")"]
                    }),
                    vec!["(1, 'a\x1e\nb')\x1e\n(2, 'it''s')", "(3, NULL)"],
                ),
            ],
        );

        let script = restore_script(&path).unwrap();
        let drop_table = position(&script, "DROP TABLE IF EXISTS \"Users\" CASCADE;");
        let drop_sequence = position(&script, "DROP SEQUENCE IF EXISTS \"Users_id_seq\" CASCADE;");
        let create_sequence = position(&script, "CREATE SEQUENCE \"Users_id_seq\"");
        let create_table = position(&script, "CREATE TABLE \"Users\"");
        let first_insert = position(
            &script,
            "INSERT INTO \"Users\" (\"id\", \"note\") VALUES\n(1, 'a\x1e\nb'),\n(2, 'it''s'),\n(3, NULL);",
        );
        let primary_key = position(&script, "ADD CONSTRAINT \"Users_pkey\" PRIMARY KEY");
        let foreign_key = position(&script, "ADD CONSTRAINT \"Users_parent_fkey\"");
        let setval = position(&script, "SELECT setval('\"Users_id_seq\"', 3, true);");
        assert!(drop_table < drop_sequence && drop_sequence < create_sequence && create_sequence < create_table);
        assert!(create_table < first_insert && first_insert < primary_key && primary_key < foreign_key);
        assert!(first_insert < setval);
        assert!(primary_key < position(&script, "ADD CONSTRAINT \"Approval_approver_id_fkey\""));
        // A dropped `public` schema is recreated, without requiring CREATE when it exists.
        let create_schema =
            position(&script, "WHERE nspname = 'public') THEN CREATE SCHEMA \"public\"; END IF; END $nb3$;");
        assert!(create_schema < drop_table);
        position(&script, "SET search_path TO \"public\";");
        let statements = split_statements(DatabaseType::Postgres, &script);
        assert!(statements
            .iter()
            .any(|statement| statement.starts_with("DO $nb3$") && statement.ends_with("END $nb3$")));
        assert_eq!(
            split_statements(DatabaseType::Postgres, &script).iter().filter(|s| s.contains("INSERT")).count(),
            1
        );
    }

    #[test]
    fn batches_large_tables_into_bounded_inserts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("big.nb3");
        let rows = (1..=2500).map(|id| format!("({id}, 'row {id}')")).collect::<Vec<_>>().join("\x1e\n");
        navicat_archive(
            &path,
            "MYSQL",
            &[(
                serde_json::json!({
                    "MetaVersion": "30101", "Name": "items", "Type": "Table",
                    "DDL": "CREATE TABLE `items` (`id` int, `label` text)", "SubDDL": [], "AutoIncrement": "",
                    "Fields": ["id", "label"], "TriggerDDL": [], "IndexDDL": []
                }),
                vec![rows.as_str()],
            )],
        );
        let script = restore_script(&path).unwrap();
        assert_eq!(script.matches("INSERT INTO `items`").count(), 3);
        assert!(script.contains("(2500, 'row 2500');"));
    }

    #[test]
    fn rejects_corrupted_and_encrypted_archives() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("corrupt.nb3");
        navicat_archive(
            &path,
            "MYSQL",
            &[(
                serde_json::json!({
                    "MetaVersion": "30101", "Name": "t", "Type": "Table", "DDL": "CREATE TABLE `t` (`id` int)",
                    "SubDDL": [], "AutoIncrement": "", "Fields": ["id"], "TriggerDDL": [], "IndexDDL": []
                }),
                vec!["(1)"],
            )],
        );
        // Flip one byte of the data chunk's gzip payload without touching the metadata.
        let members = index_archive_members(&path).unwrap();
        let (_, chunk) = members.iter().find(|(name, _)| name.contains(".data.")).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[(chunk.offset + chunk.size - 5) as usize] ^= 0xff;
        std::fs::write(&path, bytes).unwrap();
        assert!(restore_script(&path).unwrap_err().contains("corrupted"));

        let encrypted = directory.path().join("encrypted.nb3");
        let manifest = br#"{"MetaVersion":"30101","DatabaseType":"MYSQL","Encryption":"AES256","Objects":[]}"#;
        let mut builder = tar::Builder::new(File::create(&encrypted).unwrap());
        append_member(&mut builder, MANIFEST_NAME, manifest.len() as u64, manifest.as_slice()).unwrap();
        builder.into_inner().unwrap();
        assert!(Nb3SqlReader::open(&encrypted, None).err().unwrap().contains("Encrypted"));
    }

    #[test]
    fn rejects_rows_that_exceed_the_pending_tuple_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("huge-row.nb3");
        let wide_row = format!("('{}')", "x".repeat(8 * 1024));
        navicat_archive(
            &path,
            "MYSQL",
            &[(
                serde_json::json!({
                    "MetaVersion": "30101", "Name": "t", "Type": "Table", "DDL": "CREATE TABLE `t` (`v` text)",
                    "SubDDL": [], "AutoIncrement": "", "Fields": ["v"], "TriggerDDL": [], "IndexDDL": []
                }),
                vec![wide_row.as_str()],
            )],
        );
        // The real limit is far above any legitimate row; lower it so the test does not
        // have to build a multi-megabyte archive to exercise the guard.
        let mut reader = Nb3SqlReader::open(&path, None).unwrap();
        reader.max_pending_row_bytes = 1024;
        let mut script = String::new();
        let error = reader.read_to_string(&mut script).unwrap_err();
        assert!(error.to_string().contains("larger than 1024 bytes"), "{error}");

        // The same archive restores normally under the default limit.
        assert!(restore_script(&path).unwrap().contains("INSERT INTO"));
    }

    /// Renders real Navicat archives listed in `DBX_NB3_SAMPLES` (path-separated):
    /// `DBX_NB3_SAMPLES=a.nb3:b.nb3 cargo test -p dbx-core navicat_nb3 -- --ignored`.
    #[test]
    #[ignore = "needs Navicat sample archives"]
    fn renders_navicat_sample_archives() {
        let samples = std::env::var_os("DBX_NB3_SAMPLES").expect("DBX_NB3_SAMPLES is set");
        for path in std::env::split_paths(&samples) {
            let archive = Nb3Archive::open(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let expected_rows = archive
                .manifest
                .objects
                .iter()
                .filter_map(|entry| entry.rows.as_deref()?.parse::<usize>().ok())
                .sum::<usize>();
            let script = restore_script(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let statements = split_statements(archive.database_type(), &script);
            let inserted_rows = statements
                .iter()
                .filter(|statement| statement.trim_start().starts_with("INSERT INTO"))
                .map(|statement| {
                    let values = &statement[statement.find(" VALUES\n").expect("VALUES clause") + 8..];
                    split_value_tuples(archive.dialect, values).expect("value tuples").len()
                })
                .sum::<usize>();
            println!(
                "{}: {} objects, {} statements, {inserted_rows} rows",
                path.display(),
                archive.objects.len(),
                statements.len()
            );
            assert_eq!(inserted_rows, expected_rows, "{}", path.display());
        }
    }

    #[test]
    fn postgres_identity_tables_override_generated_values() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity.nb3");
        let mut writer =
            Nb3ExportWriter::new(File::create(&path).unwrap(), None, DatabaseType::Postgres, "app", "drizzle").unwrap();
        writer
            .write_all(
                b"CREATE SCHEMA IF NOT EXISTS \"drizzle\";\n\
                  CREATE TABLE \"drizzle\".\"events\" (\"id\" bigint GENERATED ALWAYS AS IDENTITY, \"name\" text);\n\
                  INSERT INTO \"drizzle\".\"events\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE VALUES (1, E'tab\\there');\n",
            )
            .unwrap();
        writer.finish().unwrap();
        let script = restore_script(&path).unwrap();
        // The unqualified DROP and INSERT must resolve in the archived schema, which may not exist yet.
        let create_schema = position(
            &script,
            "WHERE nspname = 'drizzle') THEN CREATE SCHEMA \"drizzle\"; END IF; END $nb3$;\nSET search_path TO \"drizzle\", public;",
        );
        let drop = position(&script, "DROP TABLE IF EXISTS \"events\" CASCADE;");
        let insert = position(
            &script,
            "INSERT INTO \"events\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE VALUES\n(1, E'tab\\there');",
        );
        assert!(create_schema < drop && drop < insert);
        assert!(Nb3ExportWriter::new(File::create(&path).unwrap(), None, DatabaseType::Sqlite, "app", "").is_err());
    }
}
