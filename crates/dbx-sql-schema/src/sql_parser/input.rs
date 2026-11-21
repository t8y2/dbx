use std::path::{Path, PathBuf};

use crate::models::connection::ConnectionConfig;
use crate::schema_diff::SchemaDiffPreparationOptions;
use crate::sql_parser::meta::{validate_sql_meta_consistency, MetaData, MetaReader};

#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum InputSource {
    DdlFiles(Vec<PathBuf>),
    DatabaseConnection(ConnectionConfig),
    GitDiff { repo_path: PathBuf, base_commit: String, target_commit: String },
    MetaData(MetaData),
}

#[derive(Debug, Clone)]
pub struct ResolvedInput {
    pub source: InputSource,
    pub meta: Option<MetaData>,
    pub ddl_sql: Option<String>,
    pub has_errors: bool,
    pub warnings: Vec<String>,
}

pub struct InputResolver;

impl InputResolver {
    pub fn discover_ddl_files(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if !dir.is_dir() {
            return files;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return files,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(Self::discover_ddl_files(&path));
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if matches!(ext, "sql" | "ddl" | "txt") {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !file_name.starts_with('.') {
                    files.push(path);
                }
            }
        }
        files
    }

    pub fn load_meta_for(sql_path: &Path) -> Option<MetaData> {
        let dir = sql_path.parent()?;
        let stem = sql_path.file_stem().and_then(|s| s.to_str())?;
        for ext in &["meta.json", "meta.yaml", "meta.yml"] {
            let meta_path = dir.join(format!("{}.{}", stem, ext));
            if meta_path.exists() {
                if let Ok(meta) = MetaReader::from_file(&meta_path) {
                    return Some(meta);
                }
            }
        }
        let meta_path = dir.join(".dbmeta.json");
        if meta_path.exists() {
            if let Ok(meta) = MetaReader::from_file(&meta_path) {
                return Some(meta);
            }
        }
        None
    }

    pub fn resolve(inputs: Vec<InputSource>) -> ResolvedInput {
        let mut meta: Option<MetaData> = None;
        let mut sql_parts: Vec<String> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut live_db: Option<ConnectionConfig> = None;

        for input in inputs {
            match input {
                InputSource::DdlFiles(files) => {
                    for file in files {
                        if let Ok(content) = std::fs::read_to_string(&file) {
                            if let Some(file_meta) = Self::load_meta_for(&file) {
                                let mw = validate_sql_meta_consistency(&content, &file_meta);
                                warnings.extend(mw.into_iter().map(|w| format!("{}: {}", file.display(), w)));
                                meta = Self::merge_meta(meta.take(), Some(file_meta));
                            }
                            sql_parts.push(content);
                        } else {
                            warnings.push(format!("Cannot read DDL file: {}", file.display()));
                        }
                    }
                }
                InputSource::DatabaseConnection(config) => {
                    live_db = Some(config);
                }
                InputSource::GitDiff { repo_path, base_commit, target_commit } => {
                    match crate::sql_parser::git::GitDiffScanner::new(&repo_path, &base_commit, &target_commit) {
                        Ok(scanner) => match scanner.scan() {
                            Ok(entries) => {
                                for entry in entries {
                                    sql_parts.push(entry.sql_content);
                                }
                            }
                            Err(e) => warnings.push(format!("Git diff scan error: {e}")),
                        },
                        Err(e) => warnings.push(format!("Git scanner init error: {e}")),
                    }
                }
                InputSource::MetaData(m) => {
                    meta = Self::merge_meta(meta.take(), Some(m));
                }
            }
        }

        if let Some(ref meta_data) = meta {
            let mw = MetaReader::validate_consistency(meta_data);
            warnings.extend(mw);
        }

        let source = if let Some(config) = live_db {
            InputSource::DatabaseConnection(config)
        } else {
            InputSource::DdlFiles(Vec::new())
        };

        ResolvedInput {
            source,
            meta,
            ddl_sql: if sql_parts.is_empty() { None } else { Some(sql_parts.join("\n\n")) },
            has_errors: warnings.iter().any(|w| w.starts_with("Cannot read") || w.contains("error")),
            warnings,
        }
    }

    fn merge_meta(existing: Option<MetaData>, incoming: Option<MetaData>) -> Option<MetaData> {
        match (existing, incoming) {
            (None, incoming) => incoming,
            (existing, None) => existing,
            (Some(mut e), Some(i)) => {
                e.dialect = e.dialect.or(i.dialect);
                e.version = e.version.or(i.version);
                e.charset = e.charset.or(i.charset);
                e.collation = e.collation.or(i.collation);
                e.sql_mode = e.sql_mode.or(i.sql_mode);
                e.explicit_dependencies.extend(i.explicit_dependencies);
                Some(e)
            }
        }
    }

    pub fn normalize_to_diff_options(resolved: ResolvedInput) -> (SchemaDiffPreparationOptions, Vec<String>) {
        let mut options = SchemaDiffPreparationOptions {
            source_tables: Vec::new(),
            target_tables: Vec::new(),
            source_details: Vec::new(),
            target_details: Vec::new(),
            source_functions: Vec::new(),
            target_functions: Vec::new(),
            source_sequences: Vec::new(),
            target_sequences: Vec::new(),
            source_rules: Vec::new(),
            target_rules: Vec::new(),
            source_owners: Vec::new(),
            target_owners: Vec::new(),
            database_type: crate::models::connection::DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            ..Default::default()
        };

        if let Some(ref meta) = resolved.meta {
            if let Some(ref dialect) = meta.dialect {
                let db_type = dialect_to_database_type(dialect);
                options.database_type = db_type;
            }
        }

        (options, resolved.warnings)
    }
}

fn dialect_to_database_type(dialect: &str) -> crate::models::connection::DatabaseType {
    match dialect.to_ascii_lowercase().as_str() {
        "mysql" | "mariadb" | "tidb" => crate::models::connection::DatabaseType::Mysql,
        "postgres" | "postgresql" => crate::models::connection::DatabaseType::Postgres,
        "sqlite" => crate::models::connection::DatabaseType::Sqlite,
        "sqlserver" | "mssql" => crate::models::connection::DatabaseType::SqlServer,
        "clickhouse" => crate::models::connection::DatabaseType::ClickHouse,
        "duckdb" => crate::models::connection::DatabaseType::DuckDb,
        "oracle" => crate::models::connection::DatabaseType::Oracle,
        _ => crate::models::connection::DatabaseType::Mysql,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn discovers_sql_files_in_directory() {
        let dir = std::env::temp_dir().join("dbx_test_ddl_discover");
        let _ = std::fs::create_dir_all(&dir);
        let mut f1 = std::fs::File::create(dir.join("schema.sql")).unwrap();
        f1.write_all(b"CREATE TABLE t (id INT);").unwrap();
        let mut f2 = std::fs::File::create(dir.join("data.ddl")).unwrap();
        f2.write_all(b"INSERT INTO t VALUES (1);").unwrap();
        let _hidden = std::fs::File::create(dir.join(".ignore.sql")).unwrap();

        let files = InputResolver::discover_ddl_files(&dir);
        let names: Vec<String> =
            files.iter().filter_map(|f| f.file_name().and_then(|n| n.to_str()).map(|s| s.to_string())).collect();
        assert!(names.contains(&"schema.sql".to_string()));
        assert!(names.contains(&"data.ddl".to_string()));
        assert!(!names.contains(&".ignore.sql".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loads_meta_file_for_sql() {
        let dir = std::env::temp_dir().join("dbx_test_meta_load");
        let _ = std::fs::create_dir_all(&dir);
        let sql_path = dir.join("test.sql");
        let meta_path = dir.join("test.meta.json");
        std::fs::write(&sql_path, "CREATE TABLE t (id INT);").unwrap();
        std::fs::write(&meta_path, r#"{"dialect": "postgres", "version": "15"}"#).unwrap();

        let meta = InputResolver::load_meta_for(&sql_path);
        assert!(meta.is_some());
        assert_eq!(meta.unwrap().dialect.as_deref(), Some("postgres"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_uses_meta_dialect() {
        let resolved = ResolvedInput {
            source: InputSource::DdlFiles(Vec::new()),
            meta: Some(MetaData {
                dialect: Some("postgres".into()),
                version: None,
                charset: None,
                collation: None,
                sql_mode: None,
                explicit_dependencies: std::collections::HashMap::new(),
            }),
            ddl_sql: Some("CREATE TABLE t (id INT);".into()),
            has_errors: false,
            warnings: Vec::new(),
        };
        let (options, _) = InputResolver::normalize_to_diff_options(resolved);
        assert_eq!(options.database_type, crate::models::connection::DatabaseType::Postgres);
    }

    #[test]
    fn resolve_adds_has_errors_on_failed_read() {
        let resolved = InputResolver::resolve(vec![InputSource::DdlFiles(vec![PathBuf::from(
            r"C:\non_existent_dir\nonexistent.sql",
        )])]);
        assert!(resolved.has_errors);
        assert_eq!(resolved.warnings.len(), 1);
    }

    #[test]
    fn resolve_merges_meta_from_multiple_sources() {
        let meta1 = InputSource::MetaData(MetaData {
            dialect: Some("mysql".into()),
            version: Some("8.0".into()),
            charset: None,
            collation: None,
            sql_mode: None,
            explicit_dependencies: std::collections::HashMap::new(),
        });
        let meta2 = InputSource::MetaData(MetaData {
            dialect: None,
            version: None,
            charset: Some("utf8mb4".into()),
            collation: None,
            sql_mode: None,
            explicit_dependencies: std::collections::HashMap::new(),
        });
        let resolved = InputResolver::resolve(vec![meta1, meta2]);
        assert_eq!(resolved.meta.as_ref().and_then(|m| m.dialect.as_deref()), Some("mysql"));
        assert_eq!(resolved.meta.as_ref().and_then(|m| m.charset.as_deref()), Some("utf8mb4"));
    }

    #[test]
    fn empty_ddl_dir_returns_no_files() {
        let dir = std::env::temp_dir().join("dbx_test_empty_ddl");
        let _ = std::fs::create_dir_all(&dir);
        let files = InputResolver::discover_ddl_files(&dir);
        assert!(files.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
