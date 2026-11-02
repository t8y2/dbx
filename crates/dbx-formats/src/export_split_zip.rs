//! Shared support for splitting a large generated SQL export into multiple
//! parts packaged inside a single `.zip` archive, instead of one unbounded
//! `.sql` file. Used by both the whole-database export (`database_export.rs`)
//! and the single-table SQL export (`table_export.rs`).
//!
//! # Cut boundary
//! The writer never splits mid-write: it only checks the size threshold
//! *before* starting a new `write()` call and, if exceeded, rotates to the
//! next zip entry first. Every caller in this codebase writes one complete
//! SQL statement (or comment line) per `write`/`writeln!` call, so a part
//! boundary can land between two INSERT batches of the same table but never
//! inside a single statement -- every part is independently valid, replayable
//! SQL.

use std::io::Write;

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Default part size when a caller enables splitting without specifying a
/// size (should not normally happen -- the frontend always sends an explicit
/// value -- but keeps the backend safe against malformed requests).
pub const DEFAULT_SPLIT_PART_MAX_MB: u32 = 100;
pub const MIN_SPLIT_PART_MAX_MB: u32 = 1;
pub const MAX_SPLIT_PART_MAX_MB: u32 = 4096;

/// Clamp a user-supplied "max MB per part" value to a sane range so a
/// malformed or hostile request cannot create an unbounded number of zip
/// entries (too-small) or a single-part export that defeats the point
/// (too-large is still allowed up to a generous ceiling).
pub fn clamp_split_part_max_mb(value: u32) -> u32 {
    value.clamp(MIN_SPLIT_PART_MAX_MB, MAX_SPLIT_PART_MAX_MB)
}

fn split_part_max_bytes(max_mb: u32) -> u64 {
    u64::from(clamp_split_part_max_mb(max_mb)) * 1024 * 1024
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitExportManifest<'a> {
    format: &'static str,
    generated_at: String,
    source_file_name: &'a str,
    part_max_bytes: u64,
    total_parts: u32,
    parts: &'a [String],
}

/// Writes SQL export content across multiple `part-N.sql` entries inside a
/// single `.zip` archive, rotating to a new entry once the current one
/// reaches `part_max_bytes`. Call [`SplitZipExportWriter::finish`] to write
/// the trailing `manifest.json` entry and flush the archive to disk.
pub struct SplitZipExportWriter {
    zip: ZipWriter<std::fs::File>,
    options: SimpleFileOptions,
    part_max_bytes: u64,
    current_part_bytes: u64,
    part_index: u32,
    part_stem: String,
    part_extension: String,
    part_names: Vec<String>,
}

impl SplitZipExportWriter {
    /// `part_stem`/`part_extension` name each entry as `{stem}-part-{n}.{extension}`
    /// (e.g. `mydb-part-1.sql`).
    pub fn create(
        zip_path: &std::path::Path,
        max_mb: u32,
        part_stem: &str,
        part_extension: &str,
    ) -> Result<Self, String> {
        Self::create_with_overwrite(zip_path, max_mb, part_stem, part_extension, false)
    }

    pub fn create_with_overwrite(
        zip_path: &std::path::Path,
        max_mb: u32,
        part_stem: &str,
        part_extension: &str,
        prevent_overwrite: bool,
    ) -> Result<Self, String> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(!prevent_overwrite)
            .create_new(prevent_overwrite)
            .open(zip_path)
            .map_err(|error| {
                if prevent_overwrite && error.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("Backup file already exists: {}", zip_path.display())
                } else {
                    format!("Failed to create zip file: {error}")
                }
            })?;
        let zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut writer = Self {
            zip,
            options,
            part_max_bytes: split_part_max_bytes(max_mb),
            current_part_bytes: 0,
            part_index: 0,
            part_stem: sanitize_zip_entry_component(part_stem),
            part_extension: sanitize_zip_entry_component(part_extension),
            part_names: Vec::new(),
        };
        writer.start_next_part()?;
        Ok(writer)
    }

    fn start_next_part(&mut self) -> Result<(), String> {
        self.part_index += 1;
        let name = format!("{}-part-{}.{}", self.part_stem, self.part_index, self.part_extension);
        self.zip
            .start_file(&name, self.options)
            .map_err(|error| format!("Failed to start zip entry {name}: {error}"))?;
        self.part_names.push(name);
        self.current_part_bytes = 0;
        Ok(())
    }

    /// Writes one complete SQL export unit into a single part. A unit may be
    /// a DDL statement, routine body, INSERT, comment, or client-side batch
    /// delimiter such as SQL Server `GO`; it must never be assembled from
    /// multiple calls. A unit that fits starts a new part before it would
    /// exceed the configured size; an oversized individual unit remains whole
    /// as the only unavoidable exception.
    pub fn write_sql_unit(&mut self, unit: &[u8]) -> std::io::Result<()> {
        if self.current_part_bytes > 0 && self.current_part_bytes + unit.len() as u64 > self.part_max_bytes {
            self.start_next_part().map_err(std::io::Error::other)?;
        }
        self.zip.write_all(unit)?;
        self.current_part_bytes += unit.len() as u64;
        Ok(())
    }

    /// Writes the trailing `manifest.json` entry (listing every part in
    /// order) and finalizes the zip archive. Consumes the writer because the
    /// underlying `zip::ZipWriter::finish` does.
    pub fn finish(mut self, source_file_name: &str) -> Result<(), String> {
        let manifest = SplitExportManifest {
            format: "dbx-sql-export-parts-v1",
            generated_at: chrono::Local::now().to_rfc3339(),
            source_file_name,
            part_max_bytes: self.part_max_bytes,
            total_parts: self.part_index,
            parts: &self.part_names,
        };
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Failed to encode export manifest: {error}"))?;
        let stored_options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        self.zip
            .start_file("manifest.json", stored_options)
            .map_err(|error| format!("Failed to start manifest entry: {error}"))?;
        self.zip.write_all(&manifest_json).map_err(|error| format!("Failed to write export manifest: {error}"))?;
        let mut file = self.zip.finish().map_err(|error| format!("Failed to finalize zip archive: {error}"))?;
        file.flush().map_err(|error| format!("Failed to flush zip archive: {error}"))
    }
}

impl Write for SplitZipExportWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.write_sql_unit(buffer)?;
        Ok(buffer.len())
    }

    fn write_fmt(&mut self, fmt: std::fmt::Arguments<'_>) -> std::io::Result<()> {
        let mut unit = String::new();
        std::fmt::write(&mut unit, fmt).map_err(|_| std::io::Error::other("Failed to format SQL export unit"))?;
        self.write_sql_unit(unit.as_bytes())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.zip.flush()
    }
}

/// Zip entry names must not contain path separators or other characters that
/// could be misread as a directory traversal; export file stems come from
/// user-controlled database/table names, so sanitize defensively.
fn sanitize_zip_entry_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let trimmed = sanitized.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_zip_entries(path: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents).unwrap();
            entries.push((entry.name().to_string(), contents));
        }
        entries
    }

    #[test]
    fn clamps_split_part_max_mb_to_a_sane_range() {
        assert_eq!(clamp_split_part_max_mb(0), MIN_SPLIT_PART_MAX_MB);
        assert_eq!(clamp_split_part_max_mb(50), 50);
        assert_eq!(clamp_split_part_max_mb(u32::MAX), MAX_SPLIT_PART_MAX_MB);
    }

    #[test]
    fn rotates_to_a_new_part_once_the_threshold_is_reached() {
        let dir = std::env::temp_dir().join(format!("dbx-split-zip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("export.zip");

        {
            // 1 MB minimum threshold; each write is far smaller so every
            // write should land in the very first part with no rotation.
            let mut writer = SplitZipExportWriter::create(&zip_path, 1, "mydb", "sql").unwrap();
            for index in 0..5 {
                writeln!(writer, "INSERT INTO t VALUES ({index});").unwrap();
            }
            writer.finish("mydb.sql").unwrap();
        }

        let entries = read_zip_entries(&zip_path);
        let sql_entries: Vec<_> = entries.iter().filter(|(name, _)| name.ends_with(".sql")).collect();
        assert_eq!(sql_entries.len(), 1);
        assert_eq!(sql_entries[0].0, "mydb-part-1.sql");
        let manifest_entry = entries.iter().find(|(name, _)| name == "manifest.json").unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_entry.1).unwrap();
        assert_eq!(manifest["totalParts"], 1);
        assert_eq!(manifest["parts"].as_array().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn splits_into_multiple_parts_and_every_part_is_valid_statements() {
        let dir = std::env::temp_dir().join(format!("dbx-split-zip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("export.zip");
        // Force a rotation by using a threshold smaller than a single write.
        let long_statement = format!("INSERT INTO t VALUES ('{}');", "x".repeat(200));

        {
            let mut writer = SplitZipExportWriter::create(&zip_path, MIN_SPLIT_PART_MAX_MB, "mydb", "sql").unwrap();
            for index in 0..6000 {
                let line = format!("{long_statement} -- row {index}\n");
                writer.write_all(line.as_bytes()).unwrap();
            }
            writer.finish("mydb.sql").unwrap();
        }

        let entries = read_zip_entries(&zip_path);
        let mut sql_entries: Vec<_> = entries.iter().filter(|(name, _)| name.ends_with(".sql")).collect();
        sql_entries.sort_by(|a, b| a.0.cmp(&b.0));
        assert!(sql_entries.len() >= 2, "expected at least 2 parts, got {}", sql_entries.len());

        for (name, contents) in &sql_entries {
            let text = String::from_utf8(contents.clone()).unwrap();
            assert!(!text.is_empty(), "{name} must not be empty");
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                assert!(line.contains(';'), "{name} contains a line that is not a complete statement: {line}");
            }
        }

        let manifest_entry = entries.iter().find(|(name, _)| name == "manifest.json").unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_entry.1).unwrap();
        assert_eq!(manifest["totalParts"].as_u64().unwrap() as usize, sql_entries.len());
        assert_eq!(manifest["parts"].as_array().unwrap().len(), sql_entries.len());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_before_a_complete_statement_that_would_exceed_the_part_limit() {
        let dir = std::env::temp_dir().join(format!("dbx-split-zip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("export.zip");
        let statement = format!("INSERT INTO t VALUES ('{}');", "x".repeat(700 * 1024));

        {
            let mut writer = SplitZipExportWriter::create(&zip_path, MIN_SPLIT_PART_MAX_MB, "mydb", "sql").unwrap();
            writer.write_all(statement.as_bytes()).unwrap();
            writer.write_all(b"\n").unwrap();
            writer.write_all(statement.as_bytes()).unwrap();
            writer.finish("mydb.sql").unwrap();
        }

        let entries = read_zip_entries(&zip_path);
        let sql_entries: Vec<_> = entries.iter().filter(|(name, _)| name.ends_with(".sql")).collect();
        assert_eq!(sql_entries.len(), 2);
        assert!(sql_entries.iter().all(|(_, contents)| contents.len() <= 1024 * 1024));
        assert_eq!(String::from_utf8(sql_entries[0].1.clone()).unwrap(), format!("{statement}\n"));
        assert_eq!(String::from_utf8(sql_entries[1].1.clone()).unwrap(), statement);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writeln_with_multiple_format_arguments_stays_one_sql_unit() {
        // std::fmt's default Write::write_fmt dispatches one write() call per
        // format-string fragment, which would let a rotation slip in between
        // "CREATE TABLE " and the column list even though the whole macro
        // invocation is meant to emit a single DDL unit. Every real export
        // call site formats a whole statement/DDL/routine body with `writeln!`
        // (e.g. `writeln!(file, "{source}\n")`, `writeln!(file, "-- Date:
        // {timestamp}")`), so the writer overrides `write_fmt` to buffer the
        // formatted text and hand it to `write_sql_unit` in one call.
        let dir = std::env::temp_dir().join(format!("dbx-split-zip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("export.zip");
        let table_name = "orders";
        let insert = "INSERT INTO orders VALUES (1);";
        // part_max_bytes for MIN_SPLIT_PART_MAX_MB is 1 MiB. Size the column
        // list so the CREATE TABLE unit alone fits (leaving less headroom
        // than the INSERT needs), forcing the rotation to land *between* the
        // two units instead of never triggering or landing mid-DDL.
        let overhead = "CREATE TABLE ".len() + table_name.len() + " (".len() + ");".len() + "\n".len();
        let columns = "x".repeat(1024 * 1024 - overhead - 10);
        let create_table = format!("CREATE TABLE {table_name} ({columns});");

        {
            let mut writer = SplitZipExportWriter::create(&zip_path, MIN_SPLIT_PART_MAX_MB, "mydb", "sql").unwrap();
            writeln!(writer, "CREATE TABLE {table_name} ({columns});").unwrap();
            writeln!(writer, "{insert}").unwrap();
            writer.finish("mydb.sql").unwrap();
        }

        let entries = read_zip_entries(&zip_path);
        let mut sql_entries: Vec<_> = entries.iter().filter(|(name, _)| name.ends_with(".sql")).collect();
        sql_entries.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(sql_entries.len(), 2, "the oversized CREATE TABLE must rotate before the INSERT, not mid-DDL");
        let first = String::from_utf8(sql_entries[0].1.clone()).unwrap();
        let second = String::from_utf8(sql_entries[1].1.clone()).unwrap();
        assert_eq!(first, format!("{create_table}\n"), "the whole CREATE TABLE must land in one part intact");
        assert_eq!(second, format!("{insert}\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_an_oversized_individual_statement_whole_as_the_only_limit_exception() {
        let dir = std::env::temp_dir().join(format!("dbx-split-zip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("export.zip");

        let mut seed = 0x1234_5678_u32;
        let huge_payload = (0..3 * 1024 * 1024)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                char::from(b'a' + (seed >> 24) as u8 % 26)
            })
            .collect::<String>();
        let statement = format!("INSERT INTO t VALUES ('{huge_payload}');\n");

        {
            let mut writer = SplitZipExportWriter::create(&zip_path, MIN_SPLIT_PART_MAX_MB, "mydb", "sql").unwrap();
            writer.write_all(statement.as_bytes()).unwrap();
            writer.finish("mydb.sql").unwrap();
        }

        let entries = read_zip_entries(&zip_path);
        let mut sql_entries: Vec<_> = entries.iter().filter(|(name, _)| name.ends_with(".sql")).collect();
        sql_entries.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(sql_entries.len(), 1, "a single write must stay in one SQL part");
        assert_eq!(String::from_utf8(sql_entries[0].1.clone()).unwrap(), statement);

        let manifest_entry = entries.iter().find(|(name, _)| name == "manifest.json").unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_entry.1).unwrap();
        assert_eq!(manifest["totalParts"].as_u64().unwrap() as usize, sql_entries.len());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitizes_zip_entry_stem_from_untrusted_names() {
        assert_eq!(sanitize_zip_entry_component("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_zip_entry_component(""), "export");
        assert_eq!(sanitize_zip_entry_component("my db (prod)"), "my_db__prod");
    }
}
