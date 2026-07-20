use percent_encoding::percent_decode_str;
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, LoadExtensionGuard, OpenFlags};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::file_validator::validate_file_path;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, CompletionAssistantCandidate, CompletionAssistantCandidateKind, CompletionAssistantMatchMode,
    CompletionAssistantObjectKind, CompletionAssistantRequest, CompletionAssistantResponse, DatabaseInfo,
    ForeignKeyInfo, IndexInfo, QueryResult, TableInfo, TriggerInfo,
};

const SQLITE_DATABASE_HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Clone)]
pub struct SqliteHandle {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteExtensionSpec {
    pub path: String,
    pub entry_point: Option<String>,
}

impl SqliteHandle {
    pub fn with_connection<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut Connection) -> Result<T, String>,
    {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&mut conn)
    }
}

pub fn attach_database(pool: &SqliteHandle, name: &str, path: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("SQLite attached database name cannot be empty".to_string());
    }
    if name.eq_ignore_ascii_case("main") || name.eq_ignore_ascii_case("temp") {
        return Err(format!("SQLite database name \"{name}\" is reserved"));
    }
    if !is_memory_database_path(path) {
        validate_file_path(path, is_network_path)?;
    }

    let sql = format!("ATTACH DATABASE ?1 AS {}", sqlite_quote_ident(name));
    pool.with_connection(|conn| {
        conn.execute(&sql, [path]).map(|_| ()).map_err(|e| format!("Failed to attach SQLite database \"{name}\": {e}"))
    })
}

pub fn validate_persistent_attachments(main_path: &str, cipher_key: &str, has_attachments: bool) -> Result<(), String> {
    if !has_attachments {
        return Ok(());
    }
    if is_memory_database_path(main_path) {
        return Err(
            "Persistent SQLite attachments are unavailable for an in-memory main database because reconnecting would discard its data."
                .to_string(),
        );
    }
    if !cipher_key.is_empty() {
        return Err(
            "Persistent SQLite attachments are unavailable for SQLCipher connections because each attached database requires an explicit key."
                .to_string(),
        );
    }
    Ok(())
}

pub async fn connect_path(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false, None, Vec::new()).await
}

pub async fn connect_path_with_extensions(
    path: &str,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false, None, extensions).await
}

pub async fn connect_path_with_cipher_key_and_extensions(
    path: &str,
    cipher_key: &str,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false, sqlite_cipher_key(cipher_key), extensions).await
}

pub async fn connect_path_create_if_missing(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, true, None, Vec::new()).await
}

pub async fn connect_path_create_if_missing_with_extensions(
    path: &str,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, true, None, extensions).await
}

pub async fn connect_path_create_if_missing_with_cipher_key(
    path: &str,
    cipher_key: &str,
) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, true, sqlite_cipher_key(cipher_key), Vec::new()).await
}

async fn connect_path_with_options(
    path: &str,
    create_if_missing: bool,
    cipher_key: Option<String>,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || open_sqlite_handle(&path, create_if_missing, cipher_key, extensions))
        .await
        .map_err(|e| e.to_string())?
}

fn open_sqlite_handle(
    path: &str,
    create_if_missing: bool,
    cipher_key: Option<String>,
    extensions: Vec<SqliteExtensionSpec>,
) -> Result<SqliteHandle, String> {
    let is_memory = is_memory_database_path(path);
    let encrypted = cipher_key.as_deref().is_some_and(|key| !key.is_empty());
    ensure_sqlcipher_available(encrypted)?;
    if !is_memory && !create_if_missing {
        validate_file_path(path, is_network_path)?;
    }

    if !is_memory && create_if_missing {
        ensure_parent_dir(path)?;
    }
    if !is_memory && !is_network_path(path) && !encrypted {
        validate_existing_sqlite_file(path)?;
    }

    let sqlcipher_attempts: &[Option<i64>] = if encrypted { &[None, Some(3), Some(2), Some(1)] } else { &[None] };
    let mut unlock_error: Option<String> = None;

    for compatibility in sqlcipher_attempts {
        let conn = open_sqlite_connection(path, create_if_missing)?;
        if let Err(err) = apply_sqlcipher_key(&conn, cipher_key.as_deref(), *compatibility) {
            unlock_error = Some(err);
            continue;
        }
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?;
        load_sqlite_extensions(&conn, &extensions)?;
        register_sqlite_compat_functions(&conn)?;

        return Ok(SqliteHandle { conn: Arc::new(Mutex::new(conn)) });
    }

    Err(unlock_error.unwrap_or_else(|| "SQLCipher database unlock failed.".to_string()))
}

fn open_sqlite_connection(path: &str, create_if_missing: bool) -> Result<Connection, String> {
    if is_memory_database_path(path) {
        return Connection::open_in_memory().map_err(|e| format!("SQLite connection failed: {e}"));
    }

    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
    if create_if_missing {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    if is_network_path(path) {
        flags |= OpenFlags::SQLITE_OPEN_URI;
        Connection::open_with_flags(sqlite_network_path_uri(path), flags)
            .map_err(|e| format!("SQLite connection failed: {e}"))
    } else {
        Connection::open_with_flags(path, flags).map_err(|e| format!("SQLite connection failed: {e}"))
    }
}

fn sqlite_cipher_key(cipher_key: &str) -> Option<String> {
    if cipher_key.is_empty() {
        None
    } else {
        Some(cipher_key.to_string())
    }
}

#[cfg(feature = "sqlite-sqlcipher")]
fn ensure_sqlcipher_available(_encrypted: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "sqlite-sqlcipher"))]
fn ensure_sqlcipher_available(encrypted: bool) -> Result<(), String> {
    if encrypted {
        Err("SQLCipher support is not compiled in this build. Rebuild with the sqlite-sqlcipher feature.".to_string())
    } else {
        Ok(())
    }
}

#[cfg(feature = "sqlite-sqlcipher")]
fn apply_sqlcipher_key(conn: &Connection, cipher_key: Option<&str>, compatibility: Option<i64>) -> Result<(), String> {
    let Some(cipher_key) = cipher_key.filter(|key| !key.is_empty()) else {
        return Ok(());
    };

    // SQLCipher requires the key before the first schema read; the verification
    // query turns wrong keys into an immediate connection error.
    conn.pragma_update(None, "key", cipher_key).map_err(|e| format!("SQLCipher key setup failed: {e}"))?;
    if let Some(compatibility) = compatibility {
        conn.pragma_update(None, "cipher_compatibility", compatibility)
            .map_err(|e| format!("SQLCipher compatibility setup failed: {e}"))?;
    }
    verify_sqlcipher_key(conn)
        .map_err(|e| format!("SQLCipher database unlock failed. Check the SQLite password/key and file type: {e}"))?;
    Ok(())
}

#[cfg(not(feature = "sqlite-sqlcipher"))]
fn apply_sqlcipher_key(
    _conn: &Connection,
    _cipher_key: Option<&str>,
    _compatibility: Option<i64>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(feature = "sqlite-sqlcipher")]
fn verify_sqlcipher_key(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
}

fn register_sqlite_compat_functions(conn: &Connection) -> Result<(), String> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS;

    if !sqlite_function_available(conn, "SELECT if(1, 2, 3)") {
        conn.create_scalar_function("if", -1, flags, sqlite_if)
            .map_err(|e| format!("SQLite compatibility function registration failed (if): {e}"))?;
    }
    if !sqlite_function_available(conn, "SELECT unistr('')") {
        conn.create_scalar_function("unistr", 1, flags, sqlite_unistr)
            .map_err(|e| format!("SQLite compatibility function registration failed (unistr): {e}"))?;
    }

    Ok(())
}

fn sqlite_function_available(conn: &Connection, sql: &str) -> bool {
    conn.query_row(sql, [], |_| Ok(())).is_ok()
}

fn sqlite_if(ctx: &Context<'_>) -> rusqlite::Result<Value> {
    if ctx.len() < 2 {
        return Err(sqlite_function_error("if() requires at least two arguments"));
    }

    let mut i = 0;
    while i + 1 < ctx.len() {
        if sqlite_truthy(ctx.get_raw(i)) {
            return Ok(sqlite_value_ref_to_owned(ctx.get_raw(i + 1)));
        }
        i += 2;
    }

    if ctx.len() % 2 == 1 {
        Ok(sqlite_value_ref_to_owned(ctx.get_raw(ctx.len() - 1)))
    } else {
        Ok(Value::Null)
    }
}

fn sqlite_unistr(ctx: &Context<'_>) -> rusqlite::Result<Value> {
    let input = match ctx.get_raw(0) {
        ValueRef::Null => return Ok(Value::Null),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => value.to_string(),
        ValueRef::Text(value) | ValueRef::Blob(value) => String::from_utf8_lossy(value).into_owned(),
    };

    sqlite_unistr_text(&input).map(Value::Text)
}

fn sqlite_truthy(value: ValueRef<'_>) -> bool {
    match value {
        ValueRef::Null => false,
        ValueRef::Integer(value) => value != 0,
        ValueRef::Real(value) => value != 0.0,
        ValueRef::Text(value) | ValueRef::Blob(value) => sqlite_text_numeric_truthy(&String::from_utf8_lossy(value)),
    }
}

fn sqlite_text_numeric_truthy(text: &str) -> bool {
    let trimmed = text.trim_start();
    for end in (1..=trimmed.len()).rev() {
        if trimmed.is_char_boundary(end) {
            if let Ok(value) = trimmed[..end].parse::<f64>() {
                return value != 0.0;
            }
        }
    }
    false
}

fn sqlite_value_ref_to_owned(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Integer(value),
        ValueRef::Real(value) => Value::Real(value),
        ValueRef::Text(value) => Value::Text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Blob(value.to_vec()),
    }
}

fn sqlite_unistr_text(input: &str) -> rusqlite::Result<String> {
    let chars: Vec<char> = input.chars().collect();
    let mut result = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] != '\\' {
            result.push(chars[i]);
            i += 1;
            continue;
        }

        if i + 1 >= chars.len() {
            result.push('\\');
            i += 1;
            continue;
        }

        match chars[i + 1] {
            '\\' => {
                result.push('\\');
                i += 2;
            }
            '+' => {
                if let Some(ch) = sqlite_unistr_codepoint(&chars, i + 2, 6)? {
                    result.push(ch);
                    i += 8;
                } else {
                    result.push('\\');
                    i += 1;
                }
            }
            'u' => {
                if let Some(ch) = sqlite_unistr_codepoint(&chars, i + 2, 4)? {
                    result.push(ch);
                    i += 6;
                } else {
                    result.push('\\');
                    i += 1;
                }
            }
            'U' => {
                if let Some(ch) = sqlite_unistr_codepoint(&chars, i + 2, 8)? {
                    result.push(ch);
                    i += 10;
                } else {
                    result.push('\\');
                    i += 1;
                }
            }
            _ => {
                if let Some(ch) = sqlite_unistr_codepoint(&chars, i + 1, 4)? {
                    result.push(ch);
                    i += 5;
                } else {
                    result.push('\\');
                    i += 1;
                }
            }
        }
    }

    Ok(result)
}

fn sqlite_unistr_codepoint(chars: &[char], start: usize, digits: usize) -> rusqlite::Result<Option<char>> {
    if start + digits > chars.len() {
        return Ok(None);
    }

    let mut value = 0_u32;
    for ch in &chars[start..start + digits] {
        let Some(digit) = ch.to_digit(16) else {
            return Ok(None);
        };
        value = (value << 4) | digit;
    }

    std::char::from_u32(value)
        .map(Some)
        .ok_or_else(|| sqlite_function_error(format!("invalid Unicode codepoint: {value:#X}")))
}

fn sqlite_function_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())))
}

pub fn path_has_sqlite_header(path: &Path) -> Result<bool, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("failed to open file: {e}"))?;
    let mut header = [0_u8; 16];
    match file.read_exact(&mut header) {
        Ok(()) => Ok(&header == SQLITE_DATABASE_HEADER),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(format!("failed to read file header: {e}")),
    }
}

fn validate_existing_sqlite_file(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.exists() {
        return Ok(());
    }
    let metadata = path.metadata().map_err(|e| format!("failed to inspect SQLite database file: {e}"))?;
    if metadata.len() == 0 {
        return Ok(());
    }
    if path_has_sqlite_header(path)? {
        return Ok(());
    }
    Err("Selected file is not a valid SQLite database file.".to_string())
}

fn load_sqlite_extensions(conn: &Connection, extensions: &[SqliteExtensionSpec]) -> Result<(), String> {
    if extensions.is_empty() {
        return Ok(());
    }

    // Extension loading is enabled only for the trusted paths from the connection config.
    let _guard =
        unsafe { LoadExtensionGuard::new(conn) }.map_err(|e| format!("SQLite extension loading failed: {e}"))?;
    for extension in extensions {
        unsafe { conn.load_extension(&extension.path, extension.entry_point.as_deref()) }
            .map_err(|e| format!("SQLite extension load failed ({}): {e}", extension.path))?;
    }
    Ok(())
}

pub fn sqlite_extension_specs_from_url_params(params: Option<&str>) -> Vec<SqliteExtensionSpec> {
    params
        .unwrap_or("")
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter_map(|part| {
            let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
            let key = decode_url_param(raw_key);
            if key != "sqlite_extension" && key != "sqlite_extensions" {
                return None;
            }
            Some(decode_url_param(raw_value))
        })
        .flat_map(|value| value.lines().filter_map(parse_sqlite_extension_spec).collect::<Vec<_>>())
        .collect()
}

fn parse_sqlite_extension_spec(value: &str) -> Option<SqliteExtensionSpec> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (path, entry_point) = match value.rsplit_once('|') {
        Some((path, entry_point)) if !path.trim().is_empty() && !entry_point.trim().is_empty() => {
            (path.trim(), Some(entry_point.trim().to_string()))
        }
        _ => (value, None),
    };
    Some(SqliteExtensionSpec { path: path.to_string(), entry_point })
}

fn decode_url_param(value: &str) -> String {
    percent_decode_str(&value.replace('+', " ")).decode_utf8_lossy().into_owned()
}

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//") || path.contains("wsl.localhost") || path.contains("wsl$")
}

fn sqlite_network_path_uri(path: &str) -> String {
    let (path_and_query, fragment) =
        path.split_once('#').map_or((path, None), |(prefix, suffix)| (prefix, Some(suffix)));
    let (file_path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
    let mut query = query.to_string();
    if !sqlite_uri_query_has_param(&query, "nolock") {
        if !query.is_empty() {
            query.push('&');
        }
        // UNC/WSL shares may not support SQLite byte-range locks reliably. Use
        // the cross-platform URI flag; unix-nolock is unavailable on Windows.
        query.push_str("nolock=1");
    }

    let mut uri = format!("file:{file_path}");
    if !query.is_empty() {
        uri.push('?');
        uri.push_str(&query);
    }
    if let Some(fragment) = fragment {
        uri.push('#');
        uri.push_str(fragment);
    }
    uri
}

fn sqlite_uri_query_has_param(query: &str, name: &str) -> bool {
    query.split('&').any(|part| {
        let key = part.split_once('=').map_or(part, |(key, _)| key);
        key.eq_ignore_ascii_case(name)
    })
}

pub fn is_memory_database_path(path: &str) -> bool {
    path.trim().eq_ignore_ascii_case(":memory:")
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn persistent_attachments_require_a_file_backed_plaintext_main_database() {
        assert!(validate_persistent_attachments("/tmp/main.sqlite", "", false).is_ok());
        assert!(validate_persistent_attachments("/tmp/main.sqlite", "", true).is_ok());

        let memory_error = validate_persistent_attachments(":memory:", "", true).unwrap_err();
        assert!(memory_error.contains("in-memory main database"), "{memory_error}");

        let cipher_error = validate_persistent_attachments("/tmp/main.sqlite", "secret", true).unwrap_err();
        assert!(cipher_error.contains("SQLCipher"), "{cipher_error}");
    }

    #[tokio::test]
    async fn connect_path_supports_memory_database_across_statements() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE memory_probe (id INTEGER PRIMARY KEY, name TEXT);")
            .await
            .expect("create table");
        execute_query(&pool, "INSERT INTO memory_probe (name) VALUES ('Ada');").await.expect("insert row");
        let result = execute_query(&pool, "SELECT name FROM memory_probe WHERE id = 1;").await.expect("select row");

        assert_eq!(result.rows[0][0], serde_json::json!("Ada"));
    }

    #[tokio::test]
    async fn text_affinity_blob_bytes_display_as_utf8_text() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(
            &pool,
            "CREATE TABLE goods (data TEXT); INSERT INTO goods (data) VALUES (X'7b227469746c65223a22e4b8ade69687227d');",
        )
        .await
        .expect("insert blob-backed JSON into TEXT column");
        let result = execute_query(&pool, "SELECT data FROM goods").await.expect("select data");

        assert_eq!(result.rows[0][0], serde_json::json!(r#"{"title":"中文"}"#));
    }

    #[tokio::test]
    async fn blob_declared_columns_stay_hex_encoded() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(
            &pool,
            "CREATE TABLE goods (data BLOB); INSERT INTO goods (data) VALUES (X'7b227469746c65223a22e4b8ade69687227d');",
        )
        .await
        .expect("insert blob-backed JSON into BLOB column");
        let result = execute_query(&pool, "SELECT data FROM goods").await.expect("select data");

        assert_eq!(result.rows[0][0], serde_json::json!("0x7b227469746c65223a22e4b8ade69687227d"));
    }

    #[tokio::test]
    async fn create_if_missing_rejects_existing_non_sqlite_file() {
        let path = std::env::temp_dir().join(format!("dbx-not-sqlite-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nnot sqlite").unwrap();

        let err = match connect_path_create_if_missing(path.to_str().unwrap()).await {
            Ok(_) => panic!("non-SQLite file should be rejected"),
            Err(err) => err,
        };

        assert!(err.contains("not a valid SQLite database"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn create_if_missing_allows_empty_custom_suffix_file() {
        let path = std::env::temp_dir().join(format!("dbx-empty-sqlite-{}.conf", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"").unwrap();

        let pool = connect_path_create_if_missing(path.to_str().unwrap()).await.expect("empty file can become SQLite");
        execute_query(&pool, "CREATE TABLE t (id INTEGER);").await.expect("write sqlite schema");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn create_if_missing_allows_sqlite_database_with_custom_suffix() {
        let path = std::env::temp_dir().join(format!("dbx-custom-sqlite-{}.conf", uuid::Uuid::new_v4()));
        {
            let pool = connect_path_create_if_missing(path.to_str().unwrap()).await.expect("create sqlite");
            execute_query(&pool, "CREATE TABLE t (id INTEGER);").await.expect("write sqlite schema");
        }

        let reopened = connect_path_create_if_missing(path.to_str().unwrap()).await.expect("reopen sqlite");
        let result = execute_query(&reopened, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't';")
            .await
            .expect("query sqlite schema");
        assert_eq!(result.rows[0][0], serde_json::json!("t"));

        let _ = std::fs::remove_file(path);
    }

    #[cfg(feature = "sqlite-sqlcipher")]
    #[tokio::test]
    async fn sqlcipher_key_creates_and_reopens_encrypted_database() {
        let path = std::env::temp_dir().join(format!("dbx-sqlcipher-{}.db", uuid::Uuid::new_v4()));
        let key = "secret key";

        {
            let pool = connect_path_create_if_missing_with_cipher_key(path.to_str().unwrap(), key)
                .await
                .expect("create encrypted sqlite");
            execute_query(&pool, "CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('encrypted');")
                .await
                .expect("write encrypted sqlite");
        }

        assert!(!path_has_sqlite_header(&path).expect("inspect encrypted header"));

        let reopened = connect_path_with_cipher_key_and_extensions(path.to_str().unwrap(), key, Vec::new())
            .await
            .expect("reopen encrypted sqlite");
        let result = execute_query(&reopened, "SELECT name FROM t").await.expect("read encrypted sqlite");
        assert_eq!(result.rows[0][0], serde_json::json!("encrypted"));

        let wrong_key =
            match connect_path_with_cipher_key_and_extensions(path.to_str().unwrap(), "wrong key", Vec::new()).await {
                Ok(_) => panic!("wrong key must fail"),
                Err(err) => err,
            };
        assert!(wrong_key.contains("SQLCipher database unlock failed"));

        let _ = std::fs::remove_file(path);
    }

    #[cfg(feature = "sqlite-sqlcipher")]
    #[tokio::test]
    async fn sqlcipher_key_opens_legacy_compatible_database() {
        let path = std::env::temp_dir().join(format!("dbx-sqlcipher-legacy-{}.db", uuid::Uuid::new_v4()));
        let key = "legacy key";

        {
            let conn =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
                    .expect("create legacy-compatible encrypted sqlite");
            conn.pragma_update(None, "key", key).expect("set SQLCipher key");
            conn.pragma_update(None, "cipher_compatibility", 3).expect("set SQLCipher compatibility");
            conn.execute_batch("CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('legacy');")
                .expect("write legacy-compatible encrypted sqlite");
        }

        let reopened = connect_path_with_cipher_key_and_extensions(path.to_str().unwrap(), key, Vec::new())
            .await
            .expect("reopen legacy-compatible encrypted sqlite");
        let result =
            execute_query(&reopened, "SELECT name FROM t").await.expect("read legacy-compatible encrypted sqlite");
        assert_eq!(result.rows[0][0], serde_json::json!("legacy"));

        let _ = std::fs::remove_file(path);
    }

    #[cfg(not(feature = "sqlite-sqlcipher"))]
    #[tokio::test]
    async fn sqlcipher_key_requires_sqlcipher_feature() {
        let err =
            match connect_path_with_cipher_key_and_extensions("/tmp/dbx-missing-sqlcipher.db", "secret", Vec::new())
                .await
            {
                Ok(_) => panic!("SQLCipher key should require feature support"),
                Err(err) => err,
            };

        assert!(err.contains("SQLCipher support is not compiled"));
    }

    #[test]
    fn sqlite_extension_specs_parse_repeated_and_multiline_url_params() {
        let params = "cache=shared&sqlite_extension=%2Fopt%2Fregexp.dylib&sqlite_extensions=%2Fopt%2Ftext.dylib%7Csqlite3_text_init%0A%2Fopt%2Fcrypto.dylib";

        assert_eq!(
            sqlite_extension_specs_from_url_params(Some(params)),
            vec![
                SqliteExtensionSpec { path: "/opt/regexp.dylib".to_string(), entry_point: None },
                SqliteExtensionSpec {
                    path: "/opt/text.dylib".to_string(),
                    entry_point: Some("sqlite3_text_init".to_string()),
                },
                SqliteExtensionSpec { path: "/opt/crypto.dylib".to_string(), entry_point: None },
            ],
        );
    }

    #[test]
    fn sqlite_extension_specs_ignore_empty_values() {
        assert!(sqlite_extension_specs_from_url_params(Some("sqlite_extension=&sqlite_extensions=%0A")).is_empty());
    }

    #[test]
    fn sqlite_network_path_uri_uses_cross_platform_nolock() {
        let path = r"\\wsl.localhost\Ubuntu\home\app\data.db";

        assert_eq!(sqlite_network_path_uri(path), r"file:\\wsl.localhost\Ubuntu\home\app\data.db?nolock=1");
    }

    #[test]
    fn sqlite_network_path_uri_appends_nolock_to_existing_query() {
        let path = r"\\wsl.localhost\Ubuntu\home\app\data.db?cache=shared";

        assert_eq!(
            sqlite_network_path_uri(path),
            r"file:\\wsl.localhost\Ubuntu\home\app\data.db?cache=shared&nolock=1"
        );
    }

    #[test]
    fn sqlite_network_path_uri_preserves_explicit_nolock_query() {
        let path = r"\\wsl.localhost\Ubuntu\home\app\data.db?nolock=1&cache=shared";

        assert_eq!(
            sqlite_network_path_uri(path),
            r"file:\\wsl.localhost\Ubuntu\home\app\data.db?nolock=1&cache=shared"
        );
    }

    #[test]
    fn normalize_if_to_iif_basic() {
        assert_eq!(normalize_sqlite_sql("SELECT if(1, 'a', 'b')"), "SELECT IIF(1, 'a', 'b')");
        assert_eq!(normalize_sqlite_sql("SELECT if(1, if(0, 'x', 'y'), 'b')"), "SELECT IIF(1, IIF(0, 'x', 'y'), 'b')");
    }

    #[test]
    fn normalize_substring_to_substr() {
        assert_eq!(normalize_sqlite_sql("SELECT substring(name, 1, 3) FROM t"), "SELECT substr(name, 1, 3) FROM t");
        assert_eq!(normalize_sqlite_sql("SELECT substring(name, 2) FROM t"), "SELECT substr(name, 2) FROM t");
    }

    #[test]
    fn normalize_preserves_string_literals() {
        let sql = "SELECT 'if(1,2,3)' AS literal, 'substring(x,1,2)', if(1, 'ok', 'no')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "SELECT 'if(1,2,3)' AS literal, 'substring(x,1,2)', IIF(1, 'ok', 'no')");
    }

    #[test]
    fn normalize_preserves_line_comments() {
        let sql = "-- if(1,2,3) is a comment\nSELECT if(1, 'x', 'y')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "-- if(1,2,3) is a comment\nSELECT IIF(1, 'x', 'y')");
    }

    #[test]
    fn normalize_preserves_block_comments() {
        let sql = "/* if(1,2,3) */ SELECT if(1, 'x', 'y')";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, "/* if(1,2,3) */ SELECT IIF(1, 'x', 'y')");
    }

    #[test]
    fn normalize_does_not_match_inside_words() {
        let sql = "SELECT difference, stiff, ifsubstring FROM t";
        let normalized = normalize_sqlite_sql(sql);
        assert_eq!(normalized, sql);
    }

    #[test]
    fn normalize_if_with_spaces_before_paren() {
        assert_eq!(normalize_sqlite_sql("SELECT if  (1, 'a', 'b')"), "SELECT IIF  (1, 'a', 'b')");
    }

    #[test]
    fn sqlite_unistr_decodes_documented_escapes() {
        assert_eq!(
            sqlite_unistr_text(r"a\0041\u0042\+000043\U00000044\\z").expect("decode unistr escapes"),
            r"aABCD\z"
        );
    }

    #[tokio::test]
    async fn view_with_if_function_works_after_normalization() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);")
            .await
            .expect("create and populate table");

        execute_query(&pool, "CREATE VIEW v AS SELECT x, IIF(x > 1, 'big', 'small') AS label FROM t")
            .await
            .expect("create view");

        let result = execute_query(&pool, "SELECT * FROM v ORDER BY x").await.expect("query view");

        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[0][1], serde_json::json!("small"));
        assert_eq!(result.rows[1][1], serde_json::json!("big"));
    }

    #[tokio::test]
    async fn view_with_stored_if_and_unistr_functions_can_be_described_and_queried() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        pool.with_connection(|conn| {
            conn.execute_batch("CREATE VIEW a AS SELECT if(1, unistr('hello'), 'world') AS a;")
                .map_err(|e| e.to_string())
        })
        .expect("create view with original SQLite 3.50 functions");

        let columns = get_columns(&pool, "", "a").await.expect("describe view");
        assert_eq!(columns.len(), 1);
        assert_eq!(columns[0].name, "a");

        let result = execute_query(&pool, "SELECT * FROM a").await.expect("query view");
        assert_eq!(result.rows[0][0], serde_json::json!("hello"));
    }

    #[tokio::test]
    async fn if_rewrite_works_in_direct_query() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        let result = execute_query(&pool, "SELECT if(1 = 1, 'yes', 'no') AS answer")
            .await
            .expect("if() should be rewritten to IIF()");

        assert_eq!(result.rows[0][0], serde_json::json!("yes"));
    }

    #[tokio::test]
    async fn bundled_sqlite_math_functions_are_available() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        let floor_result =
            execute_query(&pool, "WITH test(x) AS (VALUES (1.1), (1.2), (1.3)) SELECT FLOOR(x) FROM test")
                .await
                .expect("FLOOR() should be available");

        assert_eq!(floor_result.rows.len(), 3);
        for row in floor_result.rows {
            assert_eq!(row[0].as_f64(), Some(1.0));
        }

        let result = execute_query(&pool, "SELECT ACOS(1.0), ACOSH(1.0), ASIN(0.0), CEIL(1.2), PI()")
            .await
            .expect("SQLite math functions should be available");

        assert_eq!(result.rows[0][0].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][1].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][2].as_f64(), Some(0.0));
        assert_eq!(result.rows[0][3].as_f64(), Some(2.0));
        let pi = result.rows[0][4].as_f64().expect("PI() returns a real value");
        assert!((std::f64::consts::PI - pi).abs() < 0.00001);
    }

    #[tokio::test]
    async fn substring_rewrite_works_in_direct_query() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (name TEXT); INSERT INTO t VALUES ('hello');").await.expect("setup");

        let result = execute_query(&pool, "SELECT substring(name, 1, 2) AS s FROM t")
            .await
            .expect("substring() should be rewritten to substr()");

        assert_eq!(result.rows[0][0], serde_json::json!("he"));
    }

    #[tokio::test]
    async fn both_rewrites_combined() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");

        execute_query(&pool, "CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2);").await.expect("setup");

        let result = execute_query(&pool, "SELECT substring(if(x > 1, 'big', 'small'), 1, 1) AS s FROM t ORDER BY x")
            .await
            .expect("combined rewrite");

        assert_eq!(result.rows[0][0], serde_json::json!("s"));
        assert_eq!(result.rows[1][0], serde_json::json!("b"));
    }

    fn parse_pk(sql: &str) -> Vec<String> {
        let mut cols: Vec<String> = parse_sqlite_autoincrement_pk_columns(sql).into_iter().collect();
        cols.sort();
        cols
    }

    #[test]
    fn parses_implicit_integer_primary_key_as_autoincrement() {
        assert_eq!(parse_pk("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)"), vec!["id".to_string()]);
    }

    #[test]
    fn parses_explicit_integer_primary_key_autoincrement() {
        assert_eq!(
            parse_pk("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"),
            vec!["id".to_string()]
        );
    }

    #[test]
    fn parses_ef_core_style_named_constraint_primary_key_autoincrement() {
        // The actual table from issue #1129.
        let sql = r#"CREATE TABLE "OnlineLogs" (
            "OnlineLogId" INTEGER NOT NULL CONSTRAINT "PK_OnlineLogs" PRIMARY KEY AUTOINCREMENT,
            "LogTime" TEXT NOT NULL,
            "ReportedAddresses" TEXT NOT NULL,
            "DeviceId" TEXT NOT NULL
        )"#;
        assert_eq!(parse_pk(sql), vec!["onlinelogid".to_string()]);
    }

    #[test]
    fn does_not_match_non_integer_primary_key() {
        assert!(parse_sqlite_autoincrement_pk_columns("CREATE TABLE t (id INT PRIMARY KEY, name TEXT)").is_empty());
        assert!(parse_sqlite_autoincrement_pk_columns("CREATE TABLE t (id BIGINT PRIMARY KEY, name TEXT)").is_empty());
    }

    #[test]
    fn does_not_match_without_rowid_table() {
        let sql = "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) WITHOUT ROWID";
        assert!(parse_sqlite_autoincrement_pk_columns(sql).is_empty());
    }

    #[test]
    fn does_not_match_composite_primary_key() {
        let sql = "CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))";
        assert!(parse_sqlite_autoincrement_pk_columns(sql).is_empty());
    }

    #[test]
    fn parses_table_level_single_column_primary_key_for_integer() {
        let sql = "CREATE TABLE t (id INTEGER NOT NULL, name TEXT, PRIMARY KEY (id))";
        assert_eq!(parse_pk(sql), vec!["id".to_string()]);
    }

    #[test]
    fn ignores_non_pk_integer_not_null_column() {
        let sql = "CREATE TABLE t (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)";
        assert_eq!(parse_pk(sql), vec!["id".to_string()]);
    }

    #[test]
    fn parser_falls_back_to_empty_on_garbage_sql() {
        assert!(parse_sqlite_autoincrement_pk_columns("not a create table statement").is_empty());
        assert!(parse_sqlite_autoincrement_pk_columns("").is_empty());
    }

    #[test]
    fn parser_skips_check_expression_with_primary_key_token() {
        // PRIMARY KEY tokens inside a CHECK expression must not falsely mark the column.
        let sql = r#"CREATE TABLE t (
            id INTEGER,
            kind TEXT CHECK (kind IN ('PRIMARY KEY', 'OTHER')),
            PRIMARY KEY (id)
        )"#;
        assert_eq!(parse_pk(sql), vec!["id".to_string()]);
    }

    #[test]
    fn parser_handles_block_and_line_comments() {
        let sql = r#"CREATE TABLE t (
            -- line comment with INTEGER PRIMARY KEY tokens
            /* block comment INTEGER PRIMARY KEY */
            id INTEGER PRIMARY KEY,
            name TEXT
        )"#;
        assert_eq!(parse_pk(sql), vec!["id".to_string()]);
    }

    #[tokio::test]
    async fn get_columns_marks_integer_primary_key_as_autoincrement() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        execute_query(&pool, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").await.expect("create");

        let cols = get_columns(&pool, "main", "t").await.expect("get_columns");
        let id = cols.iter().find(|c| c.name == "id").expect("id col");
        assert_eq!(id.extra.as_deref(), Some("autoincrement"));
        let name = cols.iter().find(|c| c.name == "name").expect("name col");
        assert!(name.extra.is_none());
    }

    #[tokio::test]
    async fn get_columns_marks_ef_core_style_autoincrement_primary_key() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        execute_query(
            &pool,
            r#"CREATE TABLE "OnlineLogs" (
                "OnlineLogId" INTEGER NOT NULL CONSTRAINT "PK_OnlineLogs" PRIMARY KEY AUTOINCREMENT,
                "LogTime" TEXT NOT NULL,
                "DeviceId" TEXT NOT NULL
            )"#,
        )
        .await
        .expect("create");

        let cols = get_columns(&pool, "main", "OnlineLogs").await.expect("get_columns");
        let id = cols.iter().find(|c| c.name == "OnlineLogId").expect("OnlineLogId");
        assert_eq!(id.extra.as_deref(), Some("autoincrement"));
        for other in cols.iter().filter(|c| c.name != "OnlineLogId") {
            assert!(other.extra.is_none(), "{} should not be autoincrement", other.name);
        }
    }

    #[tokio::test]
    async fn get_columns_skips_without_rowid_table() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        execute_query(&pool, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID")
            .await
            .expect("create");

        let cols = get_columns(&pool, "main", "t").await.expect("get_columns");
        let id = cols.iter().find(|c| c.name == "id").expect("id col");
        assert!(id.extra.is_none());
    }

    #[tokio::test]
    async fn get_columns_skips_composite_primary_key() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        execute_query(&pool, "CREATE TABLE t (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b))")
            .await
            .expect("create");

        let cols = get_columns(&pool, "main", "t").await.expect("get_columns");
        for col in &cols {
            assert!(col.extra.is_none(), "{} should not be autoincrement", col.name);
        }
    }

    #[tokio::test]
    async fn get_columns_skips_non_integer_primary_key() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        // Use BIGINT to avoid SQLite's strict-table parser quirks; INT is sometimes promoted in SQLite.
        execute_query(&pool, "CREATE TABLE t (id BIGINT PRIMARY KEY, name TEXT)").await.expect("create");

        let cols = get_columns(&pool, "main", "t").await.expect("get_columns");
        let id = cols.iter().find(|c| c.name == "id").expect("id col");
        assert!(id.extra.is_none());
    }

    #[tokio::test]
    async fn completion_assistant_searches_sqlite_tables_and_columns_with_limit() {
        let pool = connect_path(":memory:").await.expect("connect in-memory SQLite");
        execute_query(
            &pool,
            "CREATE TABLE account(id INTEGER PRIMARY KEY, display_name TEXT); CREATE VIEW account_view AS SELECT id FROM account; CREATE TABLE audit_log(id INTEGER);",
        )
        .await
        .expect("setup schema");

        let tables = completion_assistant_search(
            &pool,
            &CompletionAssistantRequest {
                connection_id: "c1".to_string(),
                database: "main".to_string(),
                schema: Some("main".to_string()),
                object_kinds: vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View],
                mask: "account".to_string(),
                case_sensitive: false,
                global_search: false,
                max_results: Some(1),
                search_in_comments: false,
                search_in_definitions: false,
                parent_schema: Some("main".to_string()),
                parent_name: None,
                match_mode: Some(CompletionAssistantMatchMode::Prefix),
            },
        )
        .await
        .expect("table completion");

        assert_eq!(tables.candidates.len(), 1);
        assert!(tables.incomplete);
        assert!(!tables.fallback_used);
        assert_eq!(tables.candidates[0].name, "account");

        let columns = completion_assistant_search(
            &pool,
            &CompletionAssistantRequest {
                connection_id: "c1".to_string(),
                database: "main".to_string(),
                schema: Some("main".to_string()),
                object_kinds: vec![CompletionAssistantObjectKind::Column],
                mask: "name".to_string(),
                case_sensitive: false,
                global_search: false,
                max_results: Some(10),
                search_in_comments: false,
                search_in_definitions: false,
                parent_schema: Some("main".to_string()),
                parent_name: Some("account".to_string()),
                match_mode: Some(CompletionAssistantMatchMode::Contains),
            },
        )
        .await
        .expect("column completion");

        assert_eq!(columns.candidates.len(), 1);
        assert_eq!(columns.candidates[0].name, "display_name");
        assert_eq!(columns.candidates[0].data_type.as_deref(), Some("TEXT"));
    }

    #[tokio::test]
    async fn attached_database_metadata_uses_attached_schema() {
        let path = std::env::temp_dir().join(format!("dbx-sqlite-attach-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).expect("create attached database");
            conn.execute_batch(
                "CREATE TABLE parent(id INTEGER PRIMARY KEY); \
                 CREATE TABLE child(id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES parent(id), source TEXT NOT NULL); \
                 INSERT INTO child(parent_id, source) VALUES(NULL, 'attached'); \
                 CREATE INDEX child_parent_idx ON child(parent_id); \
                 CREATE TRIGGER child_touch AFTER INSERT ON child BEGIN UPDATE child SET parent_id = parent_id WHERE id = new.id; END;",
            )
            .expect("create attached schema");
        }

        let pool = connect_path(":memory:").await.expect("connect primary database");
        attach_database(&pool, "analytics", path.to_str().unwrap()).expect("attach database");
        execute_query(&pool, "CREATE TABLE child(source TEXT NOT NULL); INSERT INTO child(source) VALUES('main');")
            .await
            .expect("create same-named main table");

        let qualified_child = crate::sql_dialect::qualified_table_name(
            Some(crate::models::connection::DatabaseType::Sqlite),
            Some("analytics"),
            "child",
        );
        pool.with_connection(|conn| {
            let attached_source: String = conn
                .query_row(&format!("SELECT source FROM {qualified_child}"), [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            assert_eq!(attached_source, "attached");

            conn.execute(&format!("UPDATE {qualified_child} SET source = 'updated'"), [])
                .map_err(|error| error.to_string())?;
            let main_source: String = conn
                .query_row("SELECT source FROM main.child", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            let updated_attached_source: String = conn
                .query_row("SELECT source FROM analytics.child", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            assert_eq!(main_source, "main");
            assert_eq!(updated_attached_source, "updated");
            Ok(())
        })
        .expect("query attached table by qualified name");

        let databases = list_databases(&pool).await.expect("list databases");
        assert_eq!(databases.into_iter().map(|database| database.name).collect::<Vec<_>>(), vec!["main", "analytics"]);
        assert!(list_tables(&pool, "analytics")
            .await
            .expect("list attached tables")
            .iter()
            .any(|table| table.name == "child"));

        let columns = get_columns(&pool, "analytics", "child").await.expect("list attached columns");
        assert_eq!(
            columns.iter().find(|column| column.name == "id").and_then(|column| column.extra.as_deref()),
            Some("autoincrement")
        );
        assert!(list_indexes(&pool, "analytics", "child")
            .await
            .expect("list attached indexes")
            .iter()
            .any(|index| index.name == "child_parent_idx"));
        assert_eq!(list_foreign_keys(&pool, "analytics", "child").await.expect("list attached foreign keys").len(), 1);
        assert!(list_triggers(&pool, "analytics", "child")
            .await
            .expect("list attached triggers")
            .iter()
            .any(|trigger| trigger.name == "child_touch"));

        drop(pool);
        let _ = std::fs::remove_file(path);
    }
}

pub async fn list_databases(pool: &SqliteHandle) -> Result<Vec<DatabaseInfo>, String> {
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let mut stmt = conn.prepare("PRAGMA database_list").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| row.get::<_, String>("name")).map_err(|e| e.to_string())?;
            rows.filter_map(|row| match row {
                Ok(name) if !name.eq_ignore_ascii_case("temp") => Some(Ok(DatabaseInfo { name })),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_tables(pool: &SqliteHandle, schema: &str) -> Result<Vec<TableInfo>, String> {
    let pool = pool.clone();
    let schema = sqlite_schema_name(schema).to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let sql = format!(
                "SELECT name, type FROM {}.sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
                sqlite_quote_ident(&schema)
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let table_type: String = row.get(1)?;
                    Ok(TableInfo {
                        name: row.get(0)?,
                        table_type: if table_type == "view" { "VIEW".to_string() } else { "BASE TABLE".to_string() },
                        comment: None,
                        parent_schema: None,
                        parent_name: None,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn get_columns(pool: &SqliteHandle, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let pool = pool.clone();
    let schema = sqlite_schema_name(schema).to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let sql = format!("PRAGMA {}.table_info({})", sqlite_quote_ident(&schema), sqlite_quote_string(&table));
        pool.with_connection(|conn| {
            let autoincrement_columns = sqlite_autoincrement_pk_columns(conn, &schema, &table).unwrap_or_default();
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let name: String = row.get("name")?;
                    let is_pk = row.get::<_, i32>("pk")? > 0;
                    let extra = if is_pk && autoincrement_columns.contains(&name.to_ascii_lowercase()) {
                        Some("autoincrement".to_string())
                    } else {
                        None
                    };
                    Ok(ColumnInfo {
                        name,
                        data_type: row.get("type")?,
                        is_nullable: row.get::<_, i32>("notnull")? == 0,
                        column_default: row.get("dflt_value")?,
                        is_primary_key: is_pk,
                        extra,
                        comment: None,
                        numeric_precision: None,
                        numeric_scale: None,
                        character_maximum_length: None,
                        enum_values: None,
                        ..Default::default()
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn completion_assistant_search(
    pool: &SqliteHandle,
    request: &CompletionAssistantRequest,
) -> Result<CompletionAssistantResponse, String> {
    let pool = pool.clone();
    let request = request.clone();
    tokio::task::spawn_blocking(move || pool.with_connection(|conn| sqlite_completion_assistant_search(conn, &request)))
        .await
        .map_err(|e| e.to_string())?
}

fn sqlite_completion_assistant_search(
    conn: &mut Connection,
    request: &CompletionAssistantRequest,
) -> Result<CompletionAssistantResponse, String> {
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = completion_object_kinds(request);
    let mut candidates = Vec::new();

    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Schema)) {
        for schema in sqlite_completion_schemas(conn, request, limit - candidates.len())? {
            candidates.push(schema);
            if candidates.len() >= limit {
                return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
            }
        }
    }

    if kinds.iter().any(CompletionAssistantObjectKind::is_table_like) {
        for table in sqlite_completion_tables(conn, request, &kinds, limit - candidates.len())? {
            candidates.push(table);
            if candidates.len() >= limit {
                return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
            }
        }
    }

    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Column)) {
        for column in sqlite_completion_columns(conn, request, limit - candidates.len())? {
            candidates.push(column);
            if candidates.len() >= limit {
                return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
            }
        }
    }

    Ok(CompletionAssistantResponse { candidates, incomplete: false, fallback_used: false })
}

fn completion_object_kinds(request: &CompletionAssistantRequest) -> Vec<CompletionAssistantObjectKind> {
    if request.object_kinds.is_empty() {
        vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    }
}

fn sqlite_completion_schemas(
    conn: &mut Connection,
    request: &CompletionAssistantRequest,
    limit: usize,
) -> Result<Vec<CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("PRAGMA database_list").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?;
    let mut schemas = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    schemas.sort_by_key(|schema| schema.to_lowercase());
    Ok(schemas
        .into_iter()
        .filter(|schema| sqlite_completion_name_matches(schema, request))
        .take(limit)
        .map(|schema| CompletionAssistantCandidate {
            name: schema.clone(),
            kind: CompletionAssistantCandidateKind::Schema,
            database: Some(request.database.clone()),
            schema: Some(schema),
            parent_schema: None,
            parent_name: None,
            comment: None,
            data_type: None,
        })
        .collect())
}

fn sqlite_completion_tables(
    conn: &mut Connection,
    request: &CompletionAssistantRequest,
    kinds: &[CompletionAssistantObjectKind],
    limit: usize,
) -> Result<Vec<CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let schema = sqlite_completion_schema(request);
    let mut type_filters = Vec::new();
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::Table)) {
        type_filters.push("table");
    }
    if kinds.iter().any(|kind| matches!(kind, CompletionAssistantObjectKind::View)) {
        type_filters.push("view");
    }
    if type_filters.is_empty() {
        type_filters.extend(["table", "view"]);
    }
    let placeholders = std::iter::repeat_n("?", type_filters.len()).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT name, type FROM {}.sqlite_master WHERE type IN ({}) AND name NOT LIKE 'sqlite_%' AND {} ORDER BY name LIMIT ?",
        sqlite_quote_ident(&schema),
        placeholders,
        sqlite_completion_filter_sql("name", request)
    );
    let pattern = sqlite_completion_like_pattern(request);
    let mut params: Vec<&dyn rusqlite::ToSql> =
        type_filters.iter().map(|value| value as &dyn rusqlite::ToSql).collect();
    params.push(&pattern);
    params.push(&limit);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params.as_slice(), |row| {
            let object_type = row.get::<_, String>(1)?;
            Ok(CompletionAssistantCandidate {
                name: row.get(0)?,
                kind: if object_type.eq_ignore_ascii_case("view") {
                    CompletionAssistantCandidateKind::View
                } else {
                    CompletionAssistantCandidateKind::Table
                },
                database: Some(request.database.clone()),
                schema: Some(schema.clone()),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn sqlite_completion_columns(
    conn: &mut Connection,
    request: &CompletionAssistantRequest,
    limit: usize,
) -> Result<Vec<CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some(table) = request.parent_name.as_deref().filter(|table| !table.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let schema = sqlite_completion_schema(request);
    let sql = format!("PRAGMA {}.table_info({})", sqlite_quote_ident(&schema), sqlite_quote_string(table));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>("name")?, row.get::<_, String>("type")?)))
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for row in rows {
        let (name, data_type) = row.map_err(|e| e.to_string())?;
        if !sqlite_completion_name_matches(&name, request) {
            continue;
        }
        candidates.push(CompletionAssistantCandidate {
            name,
            kind: CompletionAssistantCandidateKind::Column,
            database: Some(request.database.clone()),
            schema: Some(schema.clone()),
            parent_schema: Some(schema.clone()),
            parent_name: Some(table.to_string()),
            comment: None,
            data_type: Some(data_type),
        });
        if candidates.len() >= limit {
            break;
        }
    }
    Ok(candidates)
}

fn sqlite_completion_schema(request: &CompletionAssistantRequest) -> String {
    request
        .parent_schema
        .as_deref()
        .or(request.schema.as_deref())
        .filter(|schema| !schema.trim().is_empty())
        .unwrap_or("main")
        .to_string()
}

fn sqlite_completion_name_matches(name: &str, request: &CompletionAssistantRequest) -> bool {
    let mask = request.mask.trim().trim_matches('%');
    if mask.is_empty() {
        return true;
    }
    let (name, mask) = if request.case_sensitive {
        (name.to_string(), mask.to_string())
    } else {
        (name.to_lowercase(), mask.to_lowercase())
    };
    match request.match_mode.as_ref().unwrap_or(&CompletionAssistantMatchMode::Prefix) {
        CompletionAssistantMatchMode::Prefix => name.starts_with(&mask),
        CompletionAssistantMatchMode::Contains => name.contains(&mask),
    }
}

fn sqlite_completion_filter_sql(column: &str, request: &CompletionAssistantRequest) -> String {
    if request.case_sensitive {
        format!("{column} GLOB ?")
    } else {
        format!("LOWER({column}) LIKE LOWER(?) ESCAPE '\\'")
    }
}

fn sqlite_completion_like_pattern(request: &CompletionAssistantRequest) -> String {
    let mask = request.mask.trim().trim_matches('%');
    let escaped = mask.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    match request.match_mode.as_ref().unwrap_or(&CompletionAssistantMatchMode::Prefix) {
        CompletionAssistantMatchMode::Prefix if request.case_sensitive => format!("{}*", mask.replace('[', "[[]")),
        CompletionAssistantMatchMode::Contains if request.case_sensitive => format!("*{}*", mask.replace('[', "[[]")),
        CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

pub(crate) fn sqlite_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn sqlite_quote_schema_ident(value: &str) -> String {
    sqlite_quote_ident(sqlite_schema_name(value))
}

fn sqlite_schema_name(value: &str) -> &str {
    let value = value.trim();
    if value.is_empty() {
        "main"
    } else {
        value
    }
}

fn sqlite_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Read `sqlite_master.sql` for `table` and return the lowercase column names that
/// are rowid-alias autoincrement primary keys (i.e. SQLite will assign a value when
/// the column is omitted from an INSERT). Returns `None` only on connection / query
/// errors; an unparseable build statement yields `Some(empty)`.
fn sqlite_autoincrement_pk_columns(conn: &Connection, schema: &str, table: &str) -> Option<HashSet<String>> {
    let sql =
        format!("SELECT sql FROM {}.sqlite_master WHERE type = 'table' AND name = ?1", sqlite_quote_ident(schema));
    let create_sql: Option<String> = conn.query_row(&sql, [table], |row| row.get(0)).ok().flatten();
    Some(parse_sqlite_autoincrement_pk_columns(create_sql.as_deref()?))
}

/// Parse a SQLite `CREATE TABLE` statement and return the lowercase names of columns
/// that are rowid-alias autoincrement primary keys.
///
/// A column is recognized when ALL of the following hold:
/// - The table is NOT declared `WITHOUT ROWID`.
/// - The column's declared type, after case-insensitive normalization, is exactly
///   `INTEGER` (NOT `INT`, `BIGINT`, `SMALLINT`, etc.).
/// - The column is the (only) primary key, declared either inline (`PRIMARY KEY`,
///   optionally with `AUTOINCREMENT`) or via a single-column table-level
///   `PRIMARY KEY (col)` constraint.
///
/// On any parse failure (malformed SQL, unrecognized syntax) the function returns
/// an empty set rather than panicking — callers fall back to the conservative
/// behavior of treating the column as a normal NOT NULL column.
fn parse_sqlite_autoincrement_pk_columns(create_sql: &str) -> HashSet<String> {
    let body = match extract_create_table_body(create_sql) {
        Some(body) => body,
        None => return HashSet::new(),
    };
    if has_without_rowid_clause(&body.tail) {
        return HashSet::new();
    }

    let entries = split_table_body_entries(&body.body);

    // First pass: find table-level PRIMARY KEY (col) — a single-column primary key
    // that may apply to a column declared as INTEGER elsewhere in the body.
    let mut table_level_pk: Option<String> = None;
    let mut has_composite_table_pk = false;
    for entry in &entries {
        if let Some(cols) = parse_table_level_primary_key(entry) {
            if cols.len() == 1 {
                if table_level_pk.is_none() && !has_composite_table_pk {
                    table_level_pk = Some(cols.into_iter().next().unwrap());
                }
            } else if cols.len() > 1 {
                has_composite_table_pk = true;
                table_level_pk = None;
            }
        }
    }
    if has_composite_table_pk {
        return HashSet::new();
    }

    let mut found: HashSet<String> = HashSet::new();
    let mut inline_pk_count = 0_usize;
    let mut inline_pk_candidate: Option<String> = None;

    for entry in &entries {
        if parse_table_level_primary_key(entry).is_some() {
            continue;
        }
        if is_table_level_constraint(entry) {
            continue;
        }
        let Some(column) = parse_column_definition(entry) else {
            continue;
        };
        if column.has_inline_pk {
            inline_pk_count += 1;
            inline_pk_candidate = Some(column.name.clone());
            if column.is_integer_type {
                found.insert(column.name.clone());
            }
        }
        if let Some(ref pk_name) = table_level_pk {
            if pk_name.eq_ignore_ascii_case(&column.name) && column.is_integer_type {
                found.insert(column.name.clone());
            }
        }
    }

    // Multiple inline PRIMARY KEY columns means a composite key — clear the inline matches.
    if inline_pk_count > 1 {
        if let Some(name) = inline_pk_candidate {
            found.remove(&name);
        }
        // Also drop any other inline PK columns we may have inserted.
        // (Conservative: walk entries again and remove inline PK names that ended up in `found`.)
        let mut to_remove: Vec<String> = Vec::new();
        for entry in &entries {
            if let Some(column) = parse_column_definition(entry) {
                if column.has_inline_pk && found.contains(&column.name) {
                    to_remove.push(column.name);
                }
            }
        }
        for name in to_remove {
            found.remove(&name);
        }
    }

    found
}

struct CreateTableBody {
    body: String,
    tail: String,
}

fn extract_create_table_body(create_sql: &str) -> Option<CreateTableBody> {
    let stripped = strip_sql_comments(create_sql);
    let lower = stripped.to_ascii_lowercase();
    if !lower.contains("create") || !lower.contains("table") {
        return None;
    }
    // Find the first top-level '(' after the table name.
    let bytes = stripped.as_bytes();
    let mut start = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'(' {
            start = Some(i);
            break;
        }
    }
    let start = start?;
    let mut depth = 0_usize;
    let mut end = None;
    let mut chars = stripped[start..].char_indices();
    while let Some((rel, ch)) = chars.next() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + rel);
                    break;
                }
            }
            '\'' | '"' | '`' => {
                // skip a quoted string / identifier in the loop directly
                let quote = ch;
                while let Some((_, qch)) = chars.next() {
                    if qch == quote {
                        // SQLite supports doubled quote as escape inside identifiers.
                        // Peek next char without consuming.
                        let mut peek = chars.clone();
                        if let Some((_, next_ch)) = peek.next() {
                            if next_ch == quote {
                                chars.next();
                                continue;
                            }
                        }
                        break;
                    }
                }
            }
            '[' => {
                // SQL Server style identifier — closes at first ']'.
                for (_, qch) in chars.by_ref() {
                    if qch == ']' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let body = stripped[start + 1..end].to_string();
    let tail = stripped[end + 1..].to_string();
    Some(CreateTableBody { body, tail })
}

fn has_without_rowid_clause(tail: &str) -> bool {
    let normalized: String = tail.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    normalized.contains("without rowid")
}

fn strip_sql_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            // line comment
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            } else {
                i = bytes.len();
            }
        } else if b == b'\'' || b == b'"' || b == b'`' {
            // copy quoted segment as-is (we still need it for identifier parsing later)
            let quote = b;
            out.push(b as char);
            i += 1;
            while i < bytes.len() {
                let qb = bytes[i];
                out.push(qb as char);
                if qb == quote {
                    if i + 1 < bytes.len() && bytes[i + 1] == quote {
                        // doubled quote escape
                        out.push(quote as char);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else if b == b'[' {
            out.push('[');
            i += 1;
            while i < bytes.len() {
                let qb = bytes[i];
                out.push(qb as char);
                i += 1;
                if qb == b']' {
                    break;
                }
            }
        } else {
            // copy as char (handle multi-byte utf-8 by walking)
            out.push(input[i..].chars().next().unwrap());
            i += input[i..].chars().next().unwrap().len_utf8();
        }
    }
    out
}

fn split_table_body_entries(body: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let mut current = String::new();
    let mut depth = 0_usize;
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    entries.push(trimmed.to_string());
                }
                current.clear();
            }
            '\'' | '"' | '`' => {
                let quote = ch;
                current.push(ch);
                while let Some(qch) = chars.next() {
                    current.push(qch);
                    if qch == quote {
                        if let Some(&next_ch) = chars.peek() {
                            if next_ch == quote {
                                current.push(chars.next().unwrap());
                                continue;
                            }
                        }
                        break;
                    }
                }
            }
            '[' => {
                current.push(ch);
                for qch in chars.by_ref() {
                    current.push(qch);
                    if qch == ']' {
                        break;
                    }
                }
            }
            _ => current.push(ch),
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        entries.push(trimmed.to_string());
    }
    entries
}

struct ColumnDefinition {
    name: String,
    is_integer_type: bool,
    has_inline_pk: bool,
}

fn parse_column_definition(entry: &str) -> Option<ColumnDefinition> {
    let mut tokens = tokenize_entry(entry);
    if tokens.is_empty() {
        return None;
    }
    // Skip leading "CONSTRAINT name" if it appears (rare in column defs but tolerated).
    if tokens[0].kind == TokenKind::Keyword && tokens[0].value.eq_ignore_ascii_case("constraint") && tokens.len() >= 2 {
        // not a column definition
        return None;
    }
    let name_token = tokens.remove(0);
    if name_token.kind != TokenKind::Identifier {
        return None;
    }
    let name_lower = name_token.value.to_ascii_lowercase();

    // Type token: optional, followed by optional parenthesized size.
    let mut is_integer_type = false;
    if let Some(first) = tokens.first() {
        if first.kind == TokenKind::Identifier {
            if first.value.eq_ignore_ascii_case("integer") {
                is_integer_type = true;
            }
            // consume the type token; also consume size like "(10, 2)"
            tokens.remove(0);
            if let Some(t) = tokens.first() {
                if t.value == "(" {
                    // consume balanced parens
                    let mut depth = 0_usize;
                    while !tokens.is_empty() {
                        let t = tokens.remove(0);
                        if t.value == "(" {
                            depth += 1;
                        } else if t.value == ")" {
                            depth = depth.saturating_sub(1);
                            if depth == 0 {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let has_inline_pk = tokens_contain_primary_key(&tokens);

    Some(ColumnDefinition { name: name_lower, is_integer_type, has_inline_pk })
}

fn tokens_contain_primary_key(tokens: &[Token]) -> bool {
    for window in tokens.windows(2) {
        if window[0].kind == TokenKind::Keyword
            && window[0].value.eq_ignore_ascii_case("primary")
            && window[1].kind == TokenKind::Keyword
            && window[1].value.eq_ignore_ascii_case("key")
        {
            return true;
        }
    }
    false
}

fn is_table_level_constraint(entry: &str) -> bool {
    let trimmed = entry.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("constraint")
        || lower.starts_with("primary key")
        || lower.starts_with("unique")
        || lower.starts_with("check")
        || lower.starts_with("foreign key")
}

/// If the entry is a table-level `PRIMARY KEY (col[, col, ...])` constraint,
/// return the lowercase column names. Otherwise `None`.
fn parse_table_level_primary_key(entry: &str) -> Option<Vec<String>> {
    let tokens = tokenize_entry(entry);
    let mut idx = 0;
    if idx < tokens.len()
        && tokens[idx].kind == TokenKind::Keyword
        && tokens[idx].value.eq_ignore_ascii_case("constraint")
    {
        idx += 1;
        if idx < tokens.len() && tokens[idx].kind == TokenKind::Identifier {
            idx += 1;
        }
    }
    if idx + 1 >= tokens.len() {
        return None;
    }
    if !(tokens[idx].kind == TokenKind::Keyword
        && tokens[idx].value.eq_ignore_ascii_case("primary")
        && tokens[idx + 1].kind == TokenKind::Keyword
        && tokens[idx + 1].value.eq_ignore_ascii_case("key"))
    {
        return None;
    }
    idx += 2;
    if idx >= tokens.len() || tokens[idx].value != "(" {
        return None;
    }
    idx += 1;
    let mut cols = Vec::new();
    while idx < tokens.len() && tokens[idx].value != ")" {
        if tokens[idx].kind == TokenKind::Identifier {
            cols.push(tokens[idx].value.to_ascii_lowercase());
        }
        idx += 1;
        // skip optional ASC/DESC and a comma
        while idx < tokens.len() && tokens[idx].value != "," && tokens[idx].value != ")" {
            idx += 1;
        }
        if idx < tokens.len() && tokens[idx].value == "," {
            idx += 1;
        }
    }
    Some(cols)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Identifier,
    Keyword,
    Punct,
    Other,
}

#[derive(Debug, Clone)]
struct Token {
    value: String,
    kind: TokenKind,
}

fn tokenize_entry(entry: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = entry.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }
        if ch == '"' || ch == '`' {
            let quote = ch;
            chars.next();
            let mut value = String::new();
            while let Some(&qch) = chars.peek() {
                chars.next();
                if qch == quote {
                    if chars.peek() == Some(&quote) {
                        value.push(quote);
                        chars.next();
                        continue;
                    }
                    break;
                }
                value.push(qch);
            }
            tokens.push(Token { value, kind: TokenKind::Identifier });
            continue;
        }
        if ch == '[' {
            chars.next();
            let mut value = String::new();
            while let Some(&qch) = chars.peek() {
                chars.next();
                if qch == ']' {
                    break;
                }
                value.push(qch);
            }
            tokens.push(Token { value, kind: TokenKind::Identifier });
            continue;
        }
        if ch == '\'' {
            // string literal — skip
            chars.next();
            while let Some(&qch) = chars.peek() {
                chars.next();
                if qch == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        if ch == '(' || ch == ')' || ch == ',' {
            chars.next();
            tokens.push(Token { value: ch.to_string(), kind: TokenKind::Punct });
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let mut value = String::new();
            while let Some(&wch) = chars.peek() {
                if wch.is_ascii_alphanumeric() || wch == '_' {
                    value.push(wch);
                    chars.next();
                } else {
                    break;
                }
            }
            let kind = if is_sql_keyword(&value) { TokenKind::Keyword } else { TokenKind::Identifier };
            tokens.push(Token { value, kind });
            continue;
        }
        // anything else — skip but record for completeness
        chars.next();
        tokens.push(Token { value: ch.to_string(), kind: TokenKind::Other });
    }
    tokens
}

fn is_sql_keyword(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "constraint"
            | "primary"
            | "key"
            | "not"
            | "null"
            | "default"
            | "unique"
            | "check"
            | "foreign"
            | "references"
            | "on"
            | "delete"
            | "update"
            | "cascade"
            | "set"
            | "restrict"
            | "no"
            | "action"
            | "deferrable"
            | "initially"
            | "deferred"
            | "immediate"
            | "match"
            | "collate"
            | "autoincrement"
            | "asc"
            | "desc"
            | "generated"
            | "always"
            | "stored"
            | "virtual"
            | "as"
    )
}

pub async fn list_indexes(pool: &SqliteHandle, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let pool = pool.clone();
    let schema = sqlite_schema_name(schema).to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let mut stmt = conn
                .prepare(&format!("PRAGMA {}.index_list({})", sqlite_quote_ident(&schema), sqlite_quote_string(&table)))
                .map_err(|e| e.to_string())?;
            let idx_rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>("name")?,
                        row.get::<_, i32>("unique")? != 0,
                        row.get::<_, String>("origin")?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut indexes = Vec::new();
            for (name, is_unique, origin) in idx_rows {
                let mut col_stmt = conn
                    .prepare(&format!(
                        "PRAGMA {}.index_info({})",
                        sqlite_quote_ident(&schema),
                        sqlite_quote_string(&name)
                    ))
                    .map_err(|e| e.to_string())?;
                let columns = col_stmt
                    .query_map([], |row| row.get::<_, String>("name"))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;

                indexes.push(IndexInfo {
                    name,
                    columns,
                    is_unique,
                    is_primary: origin == "pk",
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                });
            }
            Ok(indexes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_foreign_keys(pool: &SqliteHandle, schema: &str, table: &str) -> Result<Vec<ForeignKeyInfo>, String> {
    let pool = pool.clone();
    let schema = sqlite_schema_name(schema).to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let sql = format!("PRAGMA {}.foreign_key_list({})", sqlite_quote_ident(&schema), sqlite_quote_string(&table));
        pool.with_connection(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(ForeignKeyInfo {
                        name: format!("fk_{}", row.get::<_, i32>("id")?),
                        column: row.get("from")?,
                        ref_schema: None,
                        ref_table: row.get("table")?,
                        ref_column: row.get("to")?,
                        on_update: None,
                        on_delete: None,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn list_triggers(pool: &SqliteHandle, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let pool = pool.clone();
    let schema = sqlite_schema_name(schema).to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let sql = format!(
                "SELECT name, sql FROM {}.sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
                sqlite_quote_ident(&schema)
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([table], |row| {
                    let sql_text: Option<String> = row.get("sql")?;
                    let upper = sql_text.clone().unwrap_or_default().to_uppercase();
                    let timing = if upper.contains("BEFORE") {
                        "BEFORE"
                    } else if upper.contains("AFTER") {
                        "AFTER"
                    } else {
                        "INSTEAD OF"
                    };
                    let event = if upper.contains("INSERT") {
                        "INSERT"
                    } else if upper.contains("UPDATE") {
                        "UPDATE"
                    } else {
                        "DELETE"
                    };
                    Ok(TriggerInfo {
                        name: row.get("name")?,
                        event: event.to_string(),
                        timing: timing.to_string(),
                        statement: sql_text,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn execute_query(pool: &SqliteHandle, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(pool, sql, None).await
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(crate::query::MAX_ROWS).max(1)
}

const SQLITE_FUNCTION_ALIASES: &[(&str, &str)] = &[("if", "IIF"), ("substring", "substr")];

fn normalize_sqlite_sql(sql: &str) -> String {
    let mut result = String::with_capacity(sql.len());
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len && chars[i] == '-' && chars[i + 1] == '-' {
            while i < len && chars[i] != '\n' {
                result.push(chars[i]);
                i += 1;
            }
            continue;
        }

        if i + 1 < len && chars[i] == '/' && chars[i + 1] == '*' {
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                result.push(chars[i]);
                i += 1;
            }
            if i + 1 < len {
                result.push(chars[i]);
                result.push(chars[i + 1]);
                i += 2;
            }
            continue;
        }

        if chars[i] == '\'' {
            result.push(chars[i]);
            i += 1;
            while i < len {
                if chars[i] == '\'' {
                    result.push('\'');
                    i += 1;
                    if i < len && chars[i] == '\'' {
                        result.push('\'');
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    result.push(chars[i]);
                    i += 1;
                }
            }
            continue;
        }

        let prev = if i == 0 { '\0' } else { chars[i - 1] };
        let boundary = !prev.is_alphanumeric() && prev != '_' && prev != '.';

        if boundary {
            let remaining: String = chars[i..].iter().collect();
            let remaining_lower = remaining.to_lowercase();

            let mut matched = false;
            for (source, replacement) in SQLITE_FUNCTION_ALIASES {
                if remaining_lower.starts_with(*source) && chars.get(i + source.len()) != Some(&'_') {
                    let mut j = i + source.len();
                    while j < len && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if j < len && chars[j] == '(' {
                        let whitespace: String = chars[i + source.len()..j].iter().collect();
                        result.push_str(replacement);
                        result.push_str(&whitespace);
                        i = j;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

pub async fn execute_query_with_max_rows(
    pool: &SqliteHandle,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let pool = pool.clone();
    let sql = normalize_sqlite_sql(sql);
    tokio::task::spawn_blocking(move || execute_query_blocking(&pool, &sql, max_rows))
        .await
        .map_err(|e| e.to_string())?
}

fn execute_query_blocking(pool: &SqliteHandle, sql: &str, max_rows: Option<usize>) -> Result<QueryResult, String> {
    let start = Instant::now();
    let row_limit = query_result_row_limit(max_rows);

    pool.with_connection(|conn| {
        if starts_with_executable_sql_keyword(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"]) {
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let columns = stmt.column_names().iter().map(|name| name.to_string()).collect::<Vec<_>>();
            let column_decl_types =
                stmt.columns().iter().map(|column| column.decl_type().map(str::to_string)).collect::<Vec<_>>();
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            let mut result_rows = Vec::new();

            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let mut values = Vec::with_capacity(columns.len());
                for i in 0..columns.len() {
                    values.push(value_ref_to_json(
                        row.get_ref(i).map_err(|e| e.to_string())?,
                        column_decl_types.get(i).and_then(Option::as_deref),
                    ));
                }
                result_rows.push(values);
                if result_rows.len() > row_limit {
                    break;
                }
            }

            let truncated = result_rows.len() > row_limit;
            if truncated {
                result_rows.truncate(row_limit);
            }

            Ok(QueryResult {
                columns,
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: result_rows,
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated,
                session_id: None,
                has_more: false,
            })
        } else {
            conn.execute_batch(sql).map_err(|e| e.to_string())?;
            Ok(QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                rows: vec![],
                affected_rows: conn.changes(),
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
            })
        }
    })
}

fn value_ref_to_json(value: ValueRef<'_>, column_decl_type: Option<&str>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(v) => super::safe_i64_to_json(v),
        ValueRef::Real(v) => {
            serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
        }
        ValueRef::Text(v) => serde_json::Value::String(String::from_utf8_lossy(v).to_string()),
        ValueRef::Blob(v) => sqlite_blob_value_to_json(v, column_decl_type),
    }
}

fn sqlite_blob_value_to_json(bytes: &[u8], column_decl_type: Option<&str>) -> serde_json::Value {
    if is_sqlite_text_affinity(column_decl_type) {
        // SQLite columns can hold BLOB values even when declared as TEXT.
        // Match common clients by showing valid UTF-8 bytes as text for text-affinity columns.
        if let Ok(text) = std::str::from_utf8(bytes) {
            return serde_json::Value::String(text.to_string());
        }
    }
    super::binary_value_to_json(bytes)
}

fn is_sqlite_text_affinity(column_decl_type: Option<&str>) -> bool {
    let upper = column_decl_type.unwrap_or("").to_ascii_uppercase();
    upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT")
}
