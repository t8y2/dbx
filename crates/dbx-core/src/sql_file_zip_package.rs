use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

pub const SQL_FILE_ZIP_MAX_PARTS: usize = 10_000;
pub const SQL_FILE_ZIP_MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const SQL_FILE_ZIP_MAX_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const SQL_FILE_ZIP_MAX_PART_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlZipManifest {
    format: String,
    source_file_name: String,
    parts: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SqlFileZipPackage {
    pub source_file_name: String,
    pub part_names: Vec<String>,
    pub total_bytes: u64,
}

pub fn inspect_sql_file_zip_package(path: &Path) -> Result<SqlFileZipPackage, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("Failed to open SQL ZIP package: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("Invalid SQL ZIP package: {error}"))?;
    let manifest_bytes = read_zip_entry(&mut archive, "manifest.json", SQL_FILE_ZIP_MAX_MANIFEST_BYTES)?;
    let manifest: SqlZipManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| format!("Invalid SQL ZIP manifest: {error}"))?;
    if manifest.format != "dbx-sql-export-parts-v1" {
        return Err("Unsupported SQL ZIP package format".to_string());
    }
    if manifest.parts.is_empty() || manifest.parts.len() > SQL_FILE_ZIP_MAX_PARTS {
        return Err("SQL ZIP manifest has an invalid number of parts".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes = 0_u64;
    for part in &manifest.parts {
        validate_part_name(part)?;
        if !seen.insert(part) {
            return Err(format!("SQL ZIP manifest contains duplicate part: {part}"));
        }
        let entry = archive.by_name(part).map_err(|_| format!("SQL ZIP package is missing manifest part: {part}"))?;
        if entry.is_dir() || entry.size() > SQL_FILE_ZIP_MAX_PART_BYTES {
            return Err(format!("SQL ZIP part exceeds limits: {part}"));
        }
        total_bytes = total_bytes.checked_add(entry.size()).ok_or("SQL ZIP package size overflow")?;
        if total_bytes > SQL_FILE_ZIP_MAX_TOTAL_BYTES {
            return Err("SQL ZIP package exceeds total extracted size limit".to_string());
        }
    }
    Ok(SqlFileZipPackage { source_file_name: manifest.source_file_name, part_names: manifest.parts, total_bytes })
}

pub fn extract_sql_file_zip_package(path: &Path, destination: &Path) -> Result<SqlFileZipPackage, String> {
    let package = inspect_sql_file_zip_package(path)?;
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create SQL ZIP extraction directory: {error}"))?;
    let file = std::fs::File::open(path).map_err(|error| format!("Failed to open SQL ZIP package: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("Invalid SQL ZIP package: {error}"))?;
    for (index, part) in package.part_names.iter().enumerate() {
        let mut entry =
            archive.by_name(part).map_err(|_| format!("SQL ZIP package is missing manifest part: {part}"))?;
        let output = destination.join(format!("{:05}-{}", index + 1, part));
        let mut target =
            std::fs::File::create(&output).map_err(|error| format!("Failed to create extracted SQL part: {error}"))?;
        let copied =
            std::io::copy(&mut entry, &mut target).map_err(|error| format!("Failed to extract SQL part: {error}"))?;
        if copied != entry.size() {
            return Err(format!("Failed to fully extract SQL part: {part}"));
        }
        target.flush().map_err(|error| format!("Failed to flush extracted SQL part: {error}"))?;
    }
    Ok(package)
}

fn read_zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_name(name).map_err(|_| format!("SQL ZIP package is missing {name}"))?;
    if entry.is_dir() || entry.size() > max_bytes {
        return Err(format!("SQL ZIP package {name} exceeds limits"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).map_err(|error| format!("Failed to read SQL ZIP {name}: {error}"))?;
    Ok(bytes)
}

fn validate_part_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.trim().is_empty()
        || !name.ends_with(".sql")
        || path.is_absolute()
        || path.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Unsafe SQL ZIP manifest part: {name}"));
    }
    Ok(())
}

pub fn extracted_sql_zip_paths(destination: &Path, package: &SqlFileZipPackage) -> Vec<PathBuf> {
    package
        .part_names
        .iter()
        .enumerate()
        .map(|(index, part)| destination.join(format!("{:05}-{}", index + 1, part)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn write_package(path: &Path, parts: &[(&str, &str)], manifest_parts: &[&str]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, contents) in parts {
            zip.start_file(*name, options).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        let manifest = serde_json::json!({ "format": "dbx-sql-export-parts-v1", "sourceFileName": "source.sql", "parts": manifest_parts });
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn preserves_manifest_order_when_extracting_parts() {
        let dir = tempfile::tempdir().unwrap();
        let package_path = dir.path().join("package.zip");
        write_package(&package_path, &[("z.sql", "SELECT 2;\n"), ("a.sql", "SELECT 1;\n")], &["a.sql", "z.sql"]);
        let destination = dir.path().join("parts");
        let package = extract_sql_file_zip_package(&package_path, &destination).unwrap();
        let paths = extracted_sql_zip_paths(&destination, &package);
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), "SELECT 1;\n");
        assert_eq!(std::fs::read_to_string(&paths[1]).unwrap(), "SELECT 2;\n");
    }

    #[test]
    fn rejects_unsafe_manifest_paths() {
        let dir = tempfile::tempdir().unwrap();
        let package_path = dir.path().join("package.zip");
        write_package(&package_path, &[("safe.sql", "SELECT 1;\n")], &["../safe.sql"]);
        assert!(inspect_sql_file_zip_package(&package_path).unwrap_err().contains("Unsafe"));
    }
}
