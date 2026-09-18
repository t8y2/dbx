use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};

use super::{
    archive::MAX_DOCUMENT,
    metadata::{self, CollectionMetadata},
    PreparedCollection,
};

pub(super) fn reader(path: &Path, gzip: bool) -> Result<Box<dyn Read>, String> {
    regular_file(path)?;
    let reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    if gzip {
        Ok(Box::new(BufReader::with_capacity(64 * 1024, MultiGzDecoder::new(reader))))
    } else {
        Ok(Box::new(reader))
    }
}

fn reject_link(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let is_link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let is_link = {
        use std::os::windows::fs::MetadataExt;
        is_link || metadata.file_attributes() & 0x400 != 0
    };
    if is_link {
        return Err(format!("Dump sources cannot contain links: {}", path.display()));
    }
    Ok(metadata)
}

pub(super) fn regular_file(path: &Path) -> Result<(), String> {
    if !reject_link(path)?.is_file() {
        return Err(format!("Not a regular dump file: {}", path.display()));
    }
    Ok(())
}

pub(super) fn copy_stream(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    check: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut buffer = [0; 64 * 1024];
    loop {
        check()?;
        let length = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        writer.write_all(&buffer[..length]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn write_file(
    path: &Path,
    gzip: bool,
    write: impl FnOnce(&mut dyn Write) -> Result<(), String>,
) -> Result<(), String> {
    let file = std::io::BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
    if gzip {
        let mut writer = GzEncoder::new(file, Compression::default());
        write(&mut writer)?;
        writer.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())
    } else {
        let mut writer = file;
        write(&mut writer)?;
        writer.flush().map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct Files {
    data: Option<PathBuf>,
    metadata: Option<PathBuf>,
}

fn collect(
    path: &Path,
    depth: usize,
    gzip: bool,
    groups: &mut BTreeMap<(String, String), Files>,
) -> Result<(), String> {
    if depth > 3 || !reject_link(path)?.is_dir() {
        return Err("Invalid dump directory layout".into());
    }
    let database =
        path.file_name().and_then(|name| name.to_str()).ok_or_else(|| "Invalid database directory name".to_string())?;
    let mut subdirectories = Vec::new();
    let mut has_data = false;
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let info = reject_link(&path)?;
        if info.is_dir() {
            subdirectories.push(path);
            continue;
        }
        if !info.is_file() {
            return Err("Unsupported dump directory entry".into());
        }
        let filename = entry.file_name().to_str().ok_or_else(|| "Invalid dump filename".to_string())?.to_string();
        let (base, metadata_file, compressed) = if let Some(base) = filename.strip_suffix(".metadata.json.gz") {
            (base, true, true)
        } else if let Some(base) = filename.strip_suffix(".bson.gz") {
            (base, false, true)
        } else if let Some(base) = filename.strip_suffix(".metadata.json") {
            (base, true, false)
        } else if let Some(base) = filename.strip_suffix(".bson") {
            (base, false, false)
        } else {
            continue;
        };
        if compressed != gzip {
            return Err(format!("Gzip option does not match dump file {filename}"));
        }
        metadata::validate_database(database)?;
        has_data = true;
        let group = groups.entry((database.into(), base.into())).or_default();
        let slot = if metadata_file { &mut group.metadata } else { &mut group.data };
        if slot.replace(path).is_some() {
            return Err("Duplicate dump filename".into());
        }
        if groups.len() > 100_000 {
            return Err("Too many dump collections".into());
        }
    }
    if has_data && !subdirectories.is_empty() {
        return Err(
            "Mixed database files and directories; select a single database directory or a dump root without oplog"
                .into(),
        );
    }
    for directory in subdirectories {
        collect(&directory, depth + 1, gzip, groups)?;
    }
    Ok(())
}

pub(super) fn inspect(
    path: &Path,
    gzip: bool,
    manifest: Option<&[super::MongoDumpFile]>,
) -> Result<Vec<PreparedCollection>, String> {
    let mut groups = BTreeMap::new();
    if let Some(manifest) = manifest {
        let mut seen = std::collections::HashSet::new();
        for file in manifest {
            let relative = super::source::relative_path(&file.path)?;
            if !seen.insert(file.path.clone()) {
                return Err("Duplicate dump manifest path".into());
            }
            let database = relative
                .parent()
                .and_then(Path::file_name)
                .and_then(|s| s.to_str())
                .ok_or("Directory uploads require database-relative paths")?;
            metadata::validate_database(database)?;
            let filename = relative.file_name().unwrap().to_str().ok_or("Invalid dump filename")?;
            let plain = filename.strip_suffix(".gz").unwrap_or(filename);
            let (base, is_metadata) = if let Some(base) = plain.strip_suffix(".metadata.json") {
                (base, true)
            } else if let Some(base) = plain.strip_suffix(".bson") {
                (base, false)
            } else {
                continue;
            };
            if filename.ends_with(".gz") != gzip {
                return Err(format!("Gzip option does not match dump file {filename}"));
            }
            let group = groups.entry((database.to_string(), base.to_string())).or_insert_with(Files::default);
            let slot = if is_metadata { &mut group.metadata } else { &mut group.data };
            if slot.replace(path.join(relative)).is_some() {
                return Err("Duplicate dump namespace".into());
            }
        }
    } else {
        collect(path, 0, gzip, &mut groups)?;
    }
    let mut entries = Vec::new();
    let root = path;
    let mut namespaces = std::collections::HashSet::new();
    let mut metadata_bytes = 0usize;
    for ((database, basename), files) in groups {
        // Truncated official filenames may end mid-escape; collectionName is authoritative.
        let fallback = metadata::unescape_collection(&basename).unwrap_or_default();
        let metadata = if let Some(path) = &files.metadata {
            let mut json = String::new();
            reader(path, gzip)?.take(MAX_DOCUMENT as u64 + 1).read_to_string(&mut json).map_err(|e| e.to_string())?;
            if json.len() > MAX_DOCUMENT {
                return Err("Collection metadata exceeds 16 MiB".into());
            }
            metadata_bytes = metadata_bytes.saturating_add(json.len());
            if metadata_bytes > 128 * 1024 * 1024 {
                return Err("Dump metadata exceeds 128 MiB".into());
            }
            if json.trim().is_empty() {
                CollectionMetadata::empty(&fallback)
            } else {
                CollectionMetadata::from_json(&json, &fallback)?
            }
        } else {
            CollectionMetadata::empty(&fallback)
        };
        metadata.validate()?;
        if !namespaces.insert((database.clone(), metadata.collection_name.clone())) {
            return Err("Duplicate dump namespace".into());
        }
        let mut entry = PreparedCollection {
            database,
            metadata,
            path: None,
            documents: 0,
            size_bytes: 0,
            metadata_path: files.metadata,
        };
        match files.data {
            Some(path) => {
                if entry.metadata.is_view() {
                    return Err("View dump unexpectedly contains BSON data".into());
                }
                entry.size_bytes = if let Some(manifest) = manifest {
                    manifest.iter().find(|f| path == root.join(&f.path)).map(|f| f.size_bytes).unwrap_or(0)
                } else {
                    regular_file(&path)?;
                    std::fs::metadata(&path).map_err(|e| e.to_string())?.len()
                };
                entry.path = Some(path);
            }
            None if !entry.metadata.is_view() => {
                return Err(format!("Missing BSON file for {}", entry.metadata.collection_name))
            }
            None => {}
        }
        entries.push(entry);
    }
    Ok(entries)
}

pub(super) fn publish_files(
    root: &Path,
    database: &str,
    entries: &[PreparedCollection],
    gzip: bool,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let database_dir = root.join(database);
    std::fs::create_dir_all(&database_dir).map_err(|e| e.to_string())?;
    let mut names = std::collections::HashSet::new();
    for entry in entries {
        check()?;
        let basename = metadata::escaped_collection(&entry.metadata.collection_name);
        let filesystem_key = if cfg!(windows) { basename.to_lowercase() } else { basename.clone() };
        if !names.insert(filesystem_key) {
            return Err("Collection names collide on this filesystem; use archive format".into());
        }
        let suffix = if gzip { ".gz" } else { "" };
        write_file(&database_dir.join(format!("{basename}.metadata.json{suffix}")), gzip, |writer| {
            writer.write_all(entry.metadata.to_json()?.as_bytes()).map_err(|e| e.to_string())
        })?;
        if let Some(path) = &entry.path {
            write_file(&database_dir.join(format!("{basename}.bson{suffix}")), gzip, |writer| {
                copy_stream(&mut *reader(path, false)?, writer, &mut check)
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_file_accepts_files_and_rejects_directories() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("records.bson");
        std::fs::write(&file, []).unwrap();
        regular_file(&file).unwrap();
        assert!(regular_file(root.path()).unwrap_err().contains("Not a regular dump file"));
    }

    #[cfg(unix)]
    #[test]
    fn reject_link_rejects_file_and_directory_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("records.bson");
        std::fs::write(&file, []).unwrap();
        for (name, target) in [("file-link", file.as_path()), ("directory-link", root.path())] {
            let link = root.path().join(name);
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert!(reject_link(&link).unwrap_err().contains("Dump sources cannot contain links"));
        }
    }
}
