use std::path::{Component, Path, PathBuf};

use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::{
    DatabaseType, SqlFileEncoding, SqlFileProgress, SqlFileStreamDecoder, SqlParsingOptions, StreamingSqlFileSplitter,
};

const MAX_DEPTH: usize = 16;
const MAX_FILES: usize = 256;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct PreparedSqlIncludes {
    // Keep the private expanded scripts alive until execution has finished.
    _directory: tempfile::TempDir,
    pub paths: Vec<PathBuf>,
    sources: Vec<SourceSpan>,
}

struct SourceSpan {
    first: usize,
    last: usize,
    source: String,
}

impl PreparedSqlIncludes {
    pub(super) fn source_for(&self, progress: &SqlFileProgress) -> Option<&str> {
        if progress.file_index.is_some()
            || progress.statement_index == 0
            || (progress.statement_summary.is_empty() && progress.error.is_none())
        {
            return None;
        }
        let index = self.sources.partition_point(|span| span.last < progress.statement_index);
        self.sources.get(index).filter(|span| span.first <= progress.statement_index).map(|span| span.source.as_str())
    }
}

struct Expansion<'a> {
    root: PathBuf,
    active: Vec<PathBuf>,
    files: usize,
    bytes: u64,
    encoding: SqlFileEncoding,
    normalize_mysql_binary_literals: bool,
    token: &'a CancellationToken,
    splitter: StreamingSqlFileSplitter,
    statement_count: usize,
    sources: Vec<SourceSpan>,
}

fn directive(line: &str) -> Result<Option<&str>, String> {
    let line = line.trim();
    let Some(value) = line.strip_prefix("-- @include") else { return Ok(None) };
    if !value.is_empty() && !value.starts_with(char::is_whitespace) {
        return Ok(None);
    }
    let value = value.trim();
    let path = if value.starts_with('"') || value.starts_with('\'') {
        let quote = value.chars().next().unwrap();
        value.strip_prefix(quote).and_then(|v| v.strip_suffix(quote)).unwrap_or("")
    } else {
        value
    };
    if path.is_empty() || path.contains(['\0', '\r', '\n']) {
        return Err("Expected -- @include \"relative/path.sql\"".to_string());
    }
    Ok(Some(path))
}

impl Expansion<'_> {
    fn record_statements(&mut self, count: usize) {
        if count == 0 {
            return;
        }
        let source = self
            .active
            .last()
            .expect("SQL text is written from an active source file")
            .strip_prefix(&self.root)
            .expect("source is confined to the root")
            .to_string_lossy()
            .replace('\\', "/")
            .chars()
            .map(|ch| if ch.is_control() { '\u{fffd}' } else { ch })
            .collect::<String>();
        let first = self.statement_count + 1;
        self.statement_count += count;
        // Store ranges per file visit, not an unbounded filename per SQL statement.
        if let Some(previous) = self.sources.last_mut().filter(|span| span.source == source && span.last + 1 == first) {
            previous.last = self.statement_count;
        } else {
            self.sources.push(SourceSpan { first, last: self.statement_count, source });
        }
    }

    async fn write(&mut self, output: &mut tokio::fs::File, text: &str) -> Result<(), String> {
        self.bytes = self.bytes.saturating_add(text.len() as u64);
        if self.bytes > MAX_BYTES {
            return Err("SQL includes exceed the 1 GiB expanded size limit".to_string());
        }
        let count = self.splitter.push_chunk(text).len();
        self.record_statements(count);
        output.write_all(text.as_bytes()).await.map_err(|error| error.to_string())
    }

    async fn line(&mut self, source: &Path, output: &mut tokio::fs::File, line: &str) -> Result<(), String> {
        if self.token.is_cancelled() {
            return Err("SQL include preparation cancelled".to_string());
        }
        if self.splitter.can_start_file_directive() {
            if let Some(relative) = directive(line)? {
                if !self.splitter.is_at_file_directive_boundary() {
                    return Err("SQL include directives must appear between complete statements".to_string());
                }
                // Normalize Windows-style relative paths on every desktop platform.
                let normalized = relative.replace('\\', "/");
                let relative = Path::new(&normalized);
                if relative.has_root()
                    || relative.is_absolute()
                    || normalized.contains(':')
                    || relative.components().any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
                    || !relative
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("sql"))
                {
                    return Err("SQL includes require a relative .sql path without parent traversal".to_string());
                }
                let target = source.parent().unwrap().join(relative);
                Box::pin(self.file(&target, output)).await?;
                self.write(output, "\n").await?;
                return Ok(());
            }
        }
        self.write(output, line).await
    }

    async fn file(&mut self, source: &Path, output: &mut tokio::fs::File) -> Result<(), String> {
        if self.token.is_cancelled() {
            return Err("SQL include preparation cancelled".to_string());
        }
        let source = tokio::fs::canonicalize(source).await.map_err(|error| format!("{}: {error}", source.display()))?;
        if !source.starts_with(&self.root) {
            return Err(format!("SQL include escapes the entry script directory: {}", source.display()));
        }
        if self.active.contains(&source) {
            return Err(format!("Cyclic SQL include: {}", source.display()));
        }
        self.files += 1;
        if self.files > MAX_FILES || self.active.len() >= MAX_DEPTH {
            return Err("SQL includes exceed the 256-file or 16-level limit".to_string());
        }
        let metadata = tokio::fs::metadata(&source).await.map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err(format!("SQL include is not a regular file: {}", source.display()));
        }
        if metadata.len() > MAX_BYTES {
            return Err("SQL include input exceeds the 1 GiB limit".to_string());
        }
        self.active.push(source.clone());
        let mut decoder = SqlFileStreamDecoder::open_for_import(
            &source,
            self.encoding.to_encoding(),
            self.normalize_mysql_binary_literals,
            None,
        )
        .await?;
        let mut pending = String::new();
        let mut line_number = 0;
        while let Some(chunk) = decoder.next_chunk().await? {
            if self.token.is_cancelled() {
                return Err("SQL include preparation cancelled".to_string());
            }
            pending.push_str(&chunk);
            let mut start = 0;
            while let Some(end) = pending[start..].find('\n') {
                let end = start + end + 1;
                if end - start > MAX_LINE_BYTES {
                    return Err("SQL includes contain a line larger than 16 MiB".to_string());
                }
                line_number += 1;
                self.line(&source, output, &pending[start..end])
                    .await
                    .map_err(|error| format!("{}:{line_number}: {error}", source.display()))?;
                start = end;
            }
            pending.drain(..start);
            if pending.len() > MAX_LINE_BYTES {
                return Err("SQL includes contain a line larger than 16 MiB".to_string());
            }
        }
        if !pending.is_empty() {
            self.line(&source, output, &pending)
                .await
                .map_err(|error| format!("{}:{}: {error}", source.display(), line_number + 1))?;
        }
        // A trailing line comment ends here; unterminated quoted SQL does not.
        self.write(output, "\n").await?;
        if self.active.len() > 1 && !self.splitter.is_at_file_directive_boundary() {
            return Err(format!("Included SQL must end with a complete statement delimiter: {}", source.display()));
        }
        self.active.pop();
        Ok(())
    }
}

pub(super) async fn prepare_sql_file_includes(
    paths: &[&Path],
    encoding: SqlFileEncoding,
    database_type: Option<DatabaseType>,
    options: SqlParsingOptions,
    normalize_mysql_binary_literals: bool,
    token: &CancellationToken,
) -> Result<PreparedSqlIncludes, String> {
    if paths.is_empty() {
        return Err("No SQL files selected".to_string());
    }
    let directory =
        tempfile::Builder::new().prefix("dbx-sql-includes-").tempdir().map_err(|error| error.to_string())?;
    let mut expanded = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut total_files = 0;
    let mut total_statements = 0;
    let mut sources = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        if !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("sql")) {
            return Err("SQL includes require uncompressed .sql entry files".to_string());
        }
        let source = tokio::fs::canonicalize(path).await.map_err(|error| error.to_string())?;
        let folder = directory.path().join(index.to_string());
        tokio::fs::create_dir(&folder).await.map_err(|error| error.to_string())?;
        let target = folder.join(path.file_name().ok_or("Missing SQL file name")?);
        let mut output = tokio::fs::File::create(&target).await.map_err(|error| error.to_string())?;
        let mut expansion = Expansion {
            root: source.parent().ok_or("Missing SQL file directory")?.to_path_buf(),
            active: Vec::new(),
            files: total_files,
            bytes: total_bytes,
            encoding,
            normalize_mysql_binary_literals,
            token,
            splitter: StreamingSqlFileSplitter::new(database_type, options, false),
            statement_count: total_statements,
            sources: Vec::new(),
        };
        expansion.file(&source, &mut output).await?;
        expansion.active.push(source.clone());
        let splitter =
            std::mem::replace(&mut expansion.splitter, StreamingSqlFileSplitter::new(database_type, options, false));
        expansion.record_statements(splitter.finish().len());
        output.flush().await.map_err(|error| error.to_string())?;
        total_bytes = expansion.bytes;
        total_files = expansion.files;
        total_statements = expansion.statement_count;
        sources.extend(expansion.sources);
        expanded.push(target);
    }
    Ok(PreparedSqlIncludes { _directory: directory, paths: expanded, sources })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

    #[tokio::test]
    async fn executor_expands_before_dispatch_and_preserves_session_and_error_policy() {
        use crate::connection::{AppState, PoolKind};
        use crate::sql::{SqlFileRequest, SqlFileStatus};
        use std::time::Instant;
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let database_path = dir.path().join("queries.sqlite");
        let config = serde_json::from_value(serde_json::json!({
            "id": "include-conn", "name": "Includes", "db_type": "sqlite",
            "host": database_path, "port": 0, "username": "", "password": "", "database": null
        }))
        .unwrap();
        state.configs.write().await.insert("include-conn".into(), config);
        let pool = crate::db::sqlite::connect_path_create_if_missing(database_path.to_str().unwrap()).await.unwrap();
        let root = dir.path().join("main.sql");
        let mut request: SqlFileRequest = serde_json::from_value(serde_json::json!({
            "executionId": "includes-run", "connectionId": "include-conn", "database": "",
            "filePath": root, "continueOnError": false, "resolveIncludes": true
        }))
        .unwrap();
        for (script, continues, expected) in [
            (
                "CREATE TABLE shared(v INTEGER);\nCREATE TEMP TABLE session_values(v INTEGER);\n-- @include child.sql\nINSERT INTO shared SELECT v FROM session_values;\nINSERT INTO shared VALUES(2);",
                false,
                SqlFileStatus::Done,
            ),
            ("INSERT INTO shared VALUES(3);\n-- @include missing.sql", true, SqlFileStatus::Error),
            ("-- @include failure.sql\nINSERT INTO shared VALUES(4);", false, SqlFileStatus::Error),
            ("-- @include failure.sql\nINSERT INTO shared VALUES(5);", true, SqlFileStatus::Done),
        ] {
            std::fs::write(&root, script).unwrap();
            std::fs::write(dir.path().join("child.sql"), "INSERT INTO session_values VALUES(1);").unwrap();
            std::fs::write(dir.path().join("failure.sql"), "INSERT INTO missing_table VALUES(0);").unwrap();
            let session_key = state.session_pool_key_for_test("include-conn", None, "sql-file-includes-run").await;
            state
                .update_connection_pools(|pools| {
                    pools.insert("include-conn".into(), PoolKind::Sqlite(pool.clone()));
                    pools.insert(session_key, PoolKind::Sqlite(pool.clone()));
                })
                .await;
            request.continue_on_error = continues;
            let mut events = Vec::new();
            let result = super::super::execute_sql_file_path(
                &state,
                &request,
                &root,
                CancellationToken::new(),
                Instant::now(),
                |event| events.push(event),
            )
            .await;
            assert_eq!(result.is_err(), expected == SqlFileStatus::Error, "{result:?}");
            assert_eq!(events.last().unwrap().status, expected);
            if script.contains("failure.sql") {
                let failure = events.iter().find(|event| event.status == SqlFileStatus::StatementFailed).unwrap();
                assert!(failure.statement_summary.starts_with("[failure.sql] "), "{failure:?}");
                assert!(failure.error.as_deref().unwrap().starts_with("[failure.sql] "));
                if let Err(error) = &result { assert!(error.starts_with("[failure.sql] "), "{error}"); }
            }
            if continues && script.contains("failure.sql") {
                assert_eq!(events.last().unwrap().failure_count, 1, "{events:?}");
                assert_eq!(events.last().unwrap().success_count, 1, "{events:?}");
            }
        }
        let rows = crate::db::sqlite::execute_query(&pool, "SELECT v FROM shared ORDER BY v").await.unwrap().rows;
        assert_eq!(rows, vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)], vec![serde_json::json!(5)]]);
    }

    async fn expand(path: &Path) -> Result<PreparedSqlIncludes, String> {
        prepare_sql_file_includes(
            &[path],
            SqlFileEncoding::Auto,
            Some(DatabaseType::Sqlite),
            SqlParsingOptions::for_database_type_and_compatibility(DatabaseType::Sqlite, None),
            false,
            &CancellationToken::new(),
        )
        .await
    }

    #[tokio::test]
    async fn sqlserver_includes_share_go_batch_boundaries_and_source_order() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("shared")).unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "SELECT 0;\nGO\n-- @include shared/seed.sql\nSELECT 2;\nGO\n").unwrap();
        std::fs::write(dir.path().join("shared/seed.sql"), "SELECT '-- @include absent.sql';\nGO").unwrap();
        let options = SqlParsingOptions::for_database_type_and_compatibility(DatabaseType::SqlServer, None);
        let result = prepare_sql_file_includes(
            &[&root],
            SqlFileEncoding::Auto,
            Some(DatabaseType::SqlServer),
            options,
            false,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let expanded = std::fs::read_to_string(&result.paths[0]).unwrap();
        let mut splitter = StreamingSqlFileSplitter::new(Some(DatabaseType::SqlServer), options, false);
        let mut statements = splitter.push_chunk(&expanded);
        statements.extend(splitter.finish());
        assert_eq!(statements.len(), 3);
        assert!(statements[0].sql.contains("SELECT 0"));
        assert!(statements[1].sql.contains("absent.sql"));
        assert!(statements[2].sql.contains("SELECT 2"));
        assert_eq!(
            result.sources.iter().map(|span| span.source.as_str()).collect::<Vec<_>>(),
            ["main.sql", "shared/seed.sql", "main.sql"]
        );
    }

    #[tokio::test]
    async fn mysql_non_comment_dashes_cannot_hide_pending_sql_before_include() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "--foo\n-- @include absent.sql\n").unwrap();
        let options = SqlParsingOptions::for_database_type_and_compatibility(DatabaseType::Mysql, None);
        let error = prepare_sql_file_includes(
            &[&root],
            SqlFileEncoding::Auto,
            Some(DatabaseType::Mysql),
            options,
            true,
            &CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("between complete statements"), "{error}");
        std::fs::write(&root, "-- real comment\n-- @include child.sql\n").unwrap();
        std::fs::write(dir.path().join("child.sql"), "SELECT 1;\n").unwrap();
        assert!(prepare_sql_file_includes(
            &[&root],
            SqlFileEncoding::Auto,
            Some(DatabaseType::Mysql),
            options,
            true,
            &CancellationToken::new()
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn provenance_ranges_stay_bounded_and_distinguish_repeated_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(
            &root,
            format!("{}-- @include child.sql\n{}", "SELECT 1;\n".repeat(1000), "SELECT 3;\n".repeat(1000)),
        )
        .unwrap();
        std::fs::write(dir.path().join("child.sql"), "SELECT 2;\n".repeat(1000)).unwrap();
        let result = expand(&root).await.unwrap();
        assert_eq!(result.sources.len(), 3);
        assert_eq!((result.sources[0].first, result.sources[0].last), (1, 1000));
        assert_eq!((result.sources[1].first, result.sources[1].last), (1001, 2000));
        assert_eq!((result.sources[2].first, result.sources[2].last), (2001, 3000));
        assert_eq!(result.sources[1].source, "child.sql");
    }

    #[tokio::test]
    async fn nested_repeated_includes_execute_in_place_and_cleanup_private_output() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("shared")).unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT);\n-- @include \"shared/insert row.sql\"\nINSERT INTO t(value) VALUES('middle');\n-- @include shared/insert row.sql\nINSERT INTO t(value) VALUES('last');").unwrap();
        std::fs::write(dir.path().join("shared/insert row.sql"), "-- @include leaf.sql\n").unwrap();
        std::fs::write(dir.path().join("shared/leaf.sql"), "INSERT INTO t(value) VALUES('included');").unwrap();
        let result = expand(&root).await.unwrap();
        let output = result.paths[0].clone();
        let sql = std::fs::read_to_string(&output).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(&sql).unwrap();
        let values = db
            .prepare("SELECT value FROM t ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(values, ["included", "middle", "included", "last"]);
        assert!(!sql.contains("@include"));
        drop(result);
        assert!(!output.exists());
        assert!(root.exists());
    }

    #[tokio::test]
    async fn text_inside_literals_and_block_comments_is_not_a_directive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        let sql = "CREATE TABLE t(v TEXT);\n/*\n-- @include absent.sql\n*/\nINSERT INTO t VALUES('text\n-- @include absent.sql\nstill text');\n";
        std::fs::write(&root, sql).unwrap();
        let result = expand(&root).await.unwrap();
        let expanded = std::fs::read_to_string(&result.paths[0]).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(&expanded).unwrap();
        let value: String = db.query_row("SELECT v FROM t", [], |row| row.get(0)).unwrap();
        assert!(value.contains("-- @include absent.sql"));
    }

    #[tokio::test]
    async fn preflight_rejects_missing_cycles_traversal_and_invalid_directives() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        for (directive, error) in [
            ("-- @include missing.sql", "missing.sql"),
            ("-- @include main.sql", "Cyclic"),
            ("-- @include ../outside.sql", "relative .sql"),
            ("-- @include C:\\outside.sql", "relative .sql"),
            ("-- @include /outside.sql", "relative .sql"),
            ("-- @include secret.txt", "relative .sql"),
            ("-- @include \"unclosed.sql", "Expected"),
            ("-- @include", "Expected"),
        ] {
            std::fs::write(&root, format!("CREATE TABLE never_executed(v);\n{directive}\n")).unwrap();
            assert!(expand(&root).await.err().unwrap().contains(error), "{directive}");
        }
        std::fs::write(&root, "SELECT\n-- @include main.sql\n1;").unwrap();
        assert!(expand(&root).await.err().unwrap().contains("between complete"));
        std::fs::write(&root, "-- @include child.sql").unwrap();
        std::fs::write(dir.path().join("child.sql"), "SELECT 1").unwrap();
        assert!(expand(&root).await.err().unwrap().contains("statement delimiter"));
    }

    #[tokio::test]
    async fn decodes_each_file_independently_and_preserves_unicode() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "CREATE TABLE t(v TEXT);\n-- @include child.sql\n").unwrap();
        let sql = "INSERT INTO t VALUES('中文');\n";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(sql.encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(dir.path().join("child.sql"), bytes).unwrap();
        let result = expand(&root).await.unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(&std::fs::read_to_string(&result.paths[0]).unwrap()).unwrap();
        let value: String = db.query_row("SELECT v FROM t", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "中文");
    }

    #[tokio::test]
    async fn enforces_depth_file_limits_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..=MAX_DEPTH {
            std::fs::write(dir.path().join(format!("{n}.sql")), format!("-- @include {}.sql", n + 1)).unwrap();
        }
        let root = dir.path().join("0.sql");
        assert!(expand(&root).await.err().unwrap().contains("limit"));
        std::fs::write(&root, "-- @include child.sql\n".repeat(MAX_FILES)).unwrap();
        std::fs::write(dir.path().join("child.sql"), "SELECT 1;").unwrap();
        assert!(expand(&root).await.err().unwrap().contains("limit"));
        let token = CancellationToken::new();
        token.cancel();
        assert!(prepare_sql_file_includes(
            &[&root],
            SqlFileEncoding::Auto,
            Some(DatabaseType::Sqlite),
            SqlParsingOptions::default(),
            false,
            &token
        )
        .await
        .err()
        .unwrap()
        .contains("cancelled"));
    }

    #[tokio::test]
    async fn explicit_utf8_keeps_mysql_binary_literal_normalization_in_included_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "-- @include child.sql\n").unwrap();
        std::fs::write(dir.path().join("child.sql"), b"INSERT INTO t VALUES (_binary '\xff\x00');\n").unwrap();
        let result = prepare_sql_file_includes(
            &[&root],
            SqlFileEncoding::Utf8,
            Some(DatabaseType::Mysql),
            SqlParsingOptions::for_database_type_and_compatibility(DatabaseType::Mysql, None),
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let expanded = std::fs::read_to_string(&result.paths[0]).unwrap();
        assert!(expanded.contains("X'FF00'"), "{expanded}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_outside_entry_directory() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.sql"), "SELECT 1;").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.sql"), dir.path().join("child.sql")).unwrap();
        let root = dir.path().join("main.sql");
        std::fs::write(&root, "-- @include child.sql").unwrap();
        assert!(expand(&root).await.err().unwrap().contains("escapes"));
    }
}
