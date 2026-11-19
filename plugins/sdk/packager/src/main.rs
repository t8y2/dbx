use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::ZipArchive;

const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;

struct PackageFile {
    source: PathBuf,
    size: u64,
    permissions: u32,
    sha256: String,
}

struct ArtifactMetadataRequest {
    output: PathBuf,
    target: String,
    url: Option<String>,
    signing_key_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SigningKeyMaterial {
    pub private_seed_base64: String,
    pub public_key_base64: String,
}

pub fn generate_signing_key() -> Result<SigningKeyMaterial, String> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|error| format!("Failed to generate signing key: {error}"))?;
    let signing_key = SigningKey::from_bytes(&seed);
    Ok(SigningKeyMaterial {
        private_seed_base64: base64::engine::general_purpose::STANDARD.encode(seed),
        public_key_base64: base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
    })
}

pub fn main_entry() {
    if let Err(error) = run_cli(std::env::args().skip(1)) {
        eprintln!("dbx-plugin-packager: {error}");
        std::process::exit(1);
    }
}

pub fn run_cli<I>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    run_cli_with_output(arguments, true)
}

pub fn run_cli_silent<I>(arguments: I) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    run_cli_with_output(arguments, false)
}

fn run_cli_with_output<I>(arguments: I, print_output: bool) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    if arguments.first().map(String::as_str) == Some("sign") {
        return run_sign_cli(arguments.into_iter().skip(1), print_output);
    }
    run_package_cli(arguments, print_output)
}

fn run_package_cli<I>(arguments: I, print_output: bool) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let mut arguments = arguments.into_iter();
    let source = arguments.next().map(PathBuf::from).ok_or(usage())?;
    let output = arguments.next().map(PathBuf::from).ok_or(usage())?;
    let mut key_id = None;
    let mut artifact_metadata = None;
    let mut artifact_target = None;
    let mut artifact_url = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--key-id" => key_id = Some(arguments.next().ok_or("--key-id requires a value")?),
            "--artifact-metadata" => {
                artifact_metadata =
                    Some(PathBuf::from(arguments.next().ok_or("--artifact-metadata requires a value")?));
            }
            "--target" => artifact_target = Some(arguments.next().ok_or("--target requires a value")?),
            "--artifact-url" => artifact_url = Some(arguments.next().ok_or("--artifact-url requires a value")?),
            _ => return Err(format!("Unknown argument '{argument}'\n{}", usage())),
        }
    }
    let artifact_metadata =
        artifact_metadata_request(artifact_metadata, artifact_target, artifact_url, key_id.as_deref())?;
    if output.extension().and_then(|extension| extension.to_str()) != Some("dbxp") {
        return Err("Output file must use the .dbxp extension".to_string());
    }
    let source = std::fs::canonicalize(&source)
        .map_err(|error| format!("Failed to resolve package source {}: {error}", source.display()))?;
    if !source.join("manifest.json").is_file() {
        return Err(format!("{} is missing manifest.json", source.display()));
    }
    let output = absolute_output_path(&output)?;
    let output_parent = output.parent().ok_or("Output path has no parent")?;
    std::fs::create_dir_all(output_parent).map_err(|error| error.to_string())?;
    let output_parent = std::fs::canonicalize(output_parent).map_err(|error| error.to_string())?;
    let output = output_parent.join(output.file_name().ok_or("Output path has no file name")?);
    if output.starts_with(&source) {
        return Err("Output package must be outside the source directory".to_string());
    }
    let artifact_metadata =
        artifact_metadata.map(|request| prepare_artifact_metadata_request(request, &source, &output)).transpose()?;

    let mut files = BTreeMap::new();
    let mut total_size = 0u64;
    for entry in WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!("Package source cannot contain symbolic link {}", entry.path().display()));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if files.len() >= MAX_ARCHIVE_ENTRIES {
            return Err(format!("Package source contains more than {MAX_ARCHIVE_ENTRIES} files"));
        }
        let relative = entry.path().strip_prefix(&source).map_err(|error| error.to_string())?;
        let name = archive_name(relative)?;
        if matches!(name.as_str(), "checksums.json" | "signature.json") {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(format!("Package file '{name}' exceeds {MAX_FILE_BYTES} bytes"));
        }
        total_size = total_size.checked_add(metadata.len()).ok_or("Package source size overflow")?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(format!("Package source exceeds {MAX_UNCOMPRESSED_BYTES} uncompressed bytes"));
        }
        files.insert(
            name,
            PackageFile {
                source: entry.path().to_path_buf(),
                size: metadata.len(),
                permissions: executable_permissions(entry.path()),
                sha256: sha256_file(entry.path())?,
            },
        );
    }
    let checksums = files.iter().map(|(path, file)| (path.clone(), file.sha256.clone())).collect::<BTreeMap<_, _>>();
    let checksums = serde_json::to_vec_pretty(&serde_json::json!({
        "algorithm": "sha256",
        "files": checksums
    }))
    .map_err(|error| error.to_string())?;
    let signature = signing_key(key_id.as_deref())?
        .map(|(key_id, key)| {
            serde_json::to_vec_pretty(&serde_json::json!({
                "algorithm": "ed25519",
                "key_id": key_id,
                "signature": base64::engine::general_purpose::STANDARD.encode(key.sign(&checksums).to_bytes())
            }))
            .map_err(|error| error.to_string())
        })
        .transpose()?;

    let temporary = output_parent.join(format!(
        ".{}.{}.tmp",
        output.file_name().and_then(|name| name.to_str()).unwrap_or("plugin.dbxp"),
        std::process::id()
    ));
    let package_result = write_package(&temporary, files, &checksums, signature.as_deref());
    if let Err(error) = package_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    let package_size = std::fs::metadata(&temporary).map_err(|error| error.to_string())?.len();
    if package_size > MAX_PACKAGE_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Output package exceeds {MAX_PACKAGE_BYTES} bytes"));
    }
    if output.exists() {
        std::fs::remove_file(&output).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &output).map_err(|error| error.to_string())?;
    sync_directory(&output_parent)?;
    if let Some(request) = artifact_metadata {
        write_artifact_metadata(&request, &output, package_size)?;
    }
    if print_output {
        println!("{}", output.display());
    }
    Ok(())
}

fn run_sign_cli<I>(arguments: I, print_output: bool) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let mut arguments = arguments.into_iter();
    let input = arguments.next().map(PathBuf::from).ok_or(sign_usage())?;
    let output = arguments.next().map(PathBuf::from).ok_or(sign_usage())?;
    let mut key_id = None;
    let mut artifact_metadata = None;
    let mut artifact_target = None;
    let mut artifact_url = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--key-id" => key_id = Some(arguments.next().ok_or("--key-id requires a value")?),
            "--artifact-metadata" => {
                artifact_metadata =
                    Some(PathBuf::from(arguments.next().ok_or("--artifact-metadata requires a value")?));
            }
            "--target" => artifact_target = Some(arguments.next().ok_or("--target requires a value")?),
            "--artifact-url" => artifact_url = Some(arguments.next().ok_or("--artifact-url requires a value")?),
            _ => return Err(format!("Unknown argument '{argument}'\n{}", sign_usage())),
        }
    }
    let key_id = key_id.ok_or("sign requires --key-id")?;
    let (_, signing_key) = signing_key(Some(&key_id))?.ok_or("DBX_PLUGIN_SIGNING_KEY is required")?;
    let artifact_metadata = artifact_metadata_request(artifact_metadata, artifact_target, artifact_url, Some(&key_id))?;
    sign_existing_package(&input, &output, &key_id, &signing_key, artifact_metadata, print_output)
}

fn sign_existing_package(
    input: &Path,
    output: &Path,
    key_id: &str,
    signing_key: &SigningKey,
    artifact_metadata: Option<ArtifactMetadataRequest>,
    print_output: bool,
) -> Result<(), String> {
    validate_key_id(key_id)?;
    if input.extension().and_then(|extension| extension.to_str()) != Some("dbxp") {
        return Err("Input file must use the .dbxp extension".to_string());
    }
    if output.extension().and_then(|extension| extension.to_str()) != Some("dbxp") {
        return Err("Output file must use the .dbxp extension".to_string());
    }
    let input = std::fs::canonicalize(input)
        .map_err(|error| format!("Failed to resolve candidate package {}: {error}", input.display()))?;
    if std::fs::metadata(&input).map_err(|error| error.to_string())?.len() > MAX_PACKAGE_BYTES {
        return Err(format!("Candidate package exceeds {MAX_PACKAGE_BYTES} bytes"));
    }
    let checksums = validate_unsigned_candidate(&input)?;
    let signature = serde_json::to_vec_pretty(&serde_json::json!({
        "algorithm": "ed25519",
        "key_id": key_id,
        "signature": base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&checksums).to_bytes())
    }))
    .map_err(|error| error.to_string())?;

    let output = absolute_output_path(output)?;
    let output_parent = output.parent().ok_or("Output path has no parent")?;
    std::fs::create_dir_all(output_parent).map_err(|error| error.to_string())?;
    let output_parent = std::fs::canonicalize(output_parent).map_err(|error| error.to_string())?;
    let output = output_parent.join(output.file_name().ok_or("Output path has no file name")?);
    if output == input {
        return Err("Signed output must differ from the unsigned candidate package".to_string());
    }
    let artifact_metadata =
        artifact_metadata.map(|request| prepare_artifact_metadata_request(request, &input, &output)).transpose()?;
    let temporary = output_parent.join(format!(
        ".{}.{}.tmp",
        output.file_name().and_then(|name| name.to_str()).unwrap_or("plugin.dbxp"),
        std::process::id()
    ));
    std::fs::copy(&input, &temporary).map_err(|error| error.to_string())?;
    let append_result = (|| {
        let file = OpenOptions::new().read(true).write(true).open(&temporary).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipWriter::new_append(file).map_err(|error| error.to_string())?;
        archive
            .start_file(
                "signature.json",
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .unix_permissions(0o644),
            )
            .map_err(|error| error.to_string())?;
        archive.write_all(&signature).map_err(|error| error.to_string())?;
        archive.finish().map_err(|error| error.to_string())?.sync_all().map_err(|error| error.to_string())
    })();
    if let Err(error) = append_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    let package_size = std::fs::metadata(&temporary).map_err(|error| error.to_string())?.len();
    if package_size > MAX_PACKAGE_BYTES {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Signed package exceeds {MAX_PACKAGE_BYTES} bytes"));
    }
    if output.exists() {
        std::fs::remove_file(&output).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &output).map_err(|error| error.to_string())?;
    sync_directory(&output_parent)?;
    if let Some(request) = artifact_metadata {
        write_artifact_metadata(&request, &output, package_size)?;
    }
    if print_output {
        println!("{}", output.display());
    }
    Ok(())
}

fn validate_unsigned_candidate(input: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(input).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("Failed to read candidate package: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!("Candidate package contains more than {MAX_ARCHIVE_ENTRIES} entries"));
    }
    let mut names = HashSet::new();
    let mut actual_checksums = BTreeMap::new();
    let mut checksums_raw = None;
    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            return Err(format!("Candidate package contains directory entry '{}'", entry.name()));
        }
        let name = entry.name().to_string();
        validate_archive_entry_name(&name)?;
        if !names.insert(name.clone()) {
            return Err(format!("Candidate package contains duplicate entry '{name}'"));
        }
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(format!("Candidate package contains symbolic link '{name}'"));
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("Candidate package file '{name}' exceeds {MAX_FILE_BYTES} bytes"));
        }
        total_size = total_size.checked_add(entry.size()).ok_or("Candidate package size overflow")?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(format!("Candidate package exceeds {MAX_UNCOMPRESSED_BYTES} uncompressed bytes"));
        }
        if name == "signature.json" {
            return Err(
                "Candidate package is already signed; official signing requires an unsigned package".to_string()
            );
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if name == "checksums.json" {
            checksums_raw = Some(bytes);
        } else {
            actual_checksums.insert(name, hex_digest(Sha256::digest(bytes)));
        }
    }
    if !names.contains("manifest.json") {
        return Err("Candidate package is missing manifest.json".to_string());
    }
    let checksums_raw = checksums_raw.ok_or("Candidate package is missing checksums.json")?;
    let checksums: serde_json::Value =
        serde_json::from_slice(&checksums_raw).map_err(|error| format!("Failed to parse checksums.json: {error}"))?;
    if checksums.get("algorithm").and_then(serde_json::Value::as_str) != Some("sha256") {
        return Err("Candidate package uses an unsupported checksum algorithm".to_string());
    }
    let declared = checksums
        .get("files")
        .and_then(serde_json::Value::as_object)
        .ok_or("Candidate package checksums.json files must be an object")?;
    if declared.len() != actual_checksums.len() {
        return Err("Candidate package checksums do not cover the package exactly".to_string());
    }
    for (path, actual) in actual_checksums {
        let expected = declared
            .get(&path)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("Candidate package checksums are missing '{path}'"))?;
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err(format!("Candidate package checksum mismatch for '{path}'"));
        }
    }
    Ok(checksums_raw)
}

fn validate_archive_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('\\') || archive_name(Path::new(name))? != name {
        return Err(format!("Candidate package contains unsafe path '{name}'"));
    }
    Ok(())
}

fn artifact_metadata_request(
    output: Option<PathBuf>,
    target: Option<String>,
    url: Option<String>,
    signing_key_id: Option<&str>,
) -> Result<Option<ArtifactMetadataRequest>, String> {
    match (output, target, url) {
        (None, None, None) => Ok(None),
        (Some(output), Some(target), url) => {
            validate_artifact_target(&target)?;
            if let Some(signing_key_id) = signing_key_id {
                validate_key_id(signing_key_id)?;
            }
            if url.as_deref().is_some_and(|value| value.trim().is_empty()) {
                return Err("--artifact-url cannot be empty".to_string());
            }
            Ok(Some(ArtifactMetadataRequest {
                output,
                target,
                url,
                signing_key_id: signing_key_id.map(str::to_string),
            }))
        }
        (None, Some(_), _) => Err("--target requires --artifact-metadata".to_string()),
        (None, None, Some(_)) => Err("--artifact-url requires --artifact-metadata and --target".to_string()),
        (Some(_), None, _) => Err("--artifact-metadata requires --target".to_string()),
    }
}

fn prepare_artifact_metadata_request(
    mut request: ArtifactMetadataRequest,
    source: &Path,
    package_output: &Path,
) -> Result<ArtifactMetadataRequest, String> {
    request.output = absolute_output_path(&request.output)?;
    let parent = request.output.parent().ok_or("Artifact metadata path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
    request.output = parent.join(request.output.file_name().ok_or("Artifact metadata path has no file name")?);
    if request.output.starts_with(source) {
        return Err("Artifact metadata must be outside the package source directory".to_string());
    }
    if request.output == package_output {
        return Err("Artifact metadata path must differ from the package output".to_string());
    }
    Ok(request)
}

fn write_artifact_metadata(
    request: &ArtifactMetadataRequest,
    package_output: &Path,
    package_size: u64,
) -> Result<(), String> {
    let url = request.url.clone().unwrap_or_else(|| {
        package_output.file_name().and_then(|name| name.to_str()).unwrap_or("plugin.dbxp").to_string()
    });
    let mut metadata = serde_json::json!({
        "target": request.target,
        "url": url,
        "sha256": sha256_file(package_output)?,
        "size": package_size
    });
    if let Some(signing_key_id) = &request.signing_key_id {
        metadata["signingKeyId"] = serde_json::Value::String(signing_key_id.clone());
    }
    let mut metadata = serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    metadata.push(b'\n');
    write_bytes_atomically(&request.output, &metadata)
}

fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Output path has no parent")?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("artifact.json"),
        std::process::id()
    ));
    let mut file =
        OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    sync_directory(parent)
}

fn write_package(
    output: &Path,
    files: BTreeMap<String, PackageFile>,
    checksums: &[u8],
    signature: Option<&[u8]>,
) -> Result<(), String> {
    let file = OpenOptions::new().write(true).create_new(true).open(output).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    for (path, package_file) in files {
        archive
            .start_file(
                path,
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .unix_permissions(package_file.permissions),
            )
            .map_err(|error| error.to_string())?;
        let mut source = File::open(&package_file.source).map_err(|error| error.to_string())?;
        let mut digest = Sha256::new();
        let mut copied = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            copied = copied.checked_add(read as u64).ok_or("Package source size overflow")?;
            if copied > package_file.size {
                break;
            }
            digest.update(&buffer[..read]);
            archive.write_all(&buffer[..read]).map_err(|error| error.to_string())?;
        }
        if copied != package_file.size || hex_digest(digest.finalize()) != package_file.sha256 {
            return Err(format!("Package source changed while reading {}", package_file.source.display()));
        }
    }
    archive
        .start_file(
            "checksums.json",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o644),
        )
        .map_err(|error| error.to_string())?;
    archive.write_all(checksums).map_err(|error| error.to_string())?;
    if let Some(signature) = signature {
        archive
            .start_file(
                "signature.json",
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated)
                    .unix_permissions(0o644),
            )
            .map_err(|error| error.to_string())?;
        archive.write_all(signature).map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

fn signing_key(key_id: Option<&str>) -> Result<Option<(String, SigningKey)>, String> {
    let encoded = std::env::var("DBX_PLUGIN_SIGNING_KEY").ok();
    match (key_id, encoded) {
        (None, None) => Ok(None),
        (Some(_), None) => Err("DBX_PLUGIN_SIGNING_KEY is required when --key-id is provided".to_string()),
        (None, Some(_)) => Err("--key-id is required when DBX_PLUGIN_SIGNING_KEY is set".to_string()),
        (Some(key_id), Some(encoded)) => {
            validate_key_id(key_id)?;
            let signing_key = decode_signing_key(&encoded)?;
            if let Ok(expected_public_key) = std::env::var("DBX_PLUGIN_SIGNING_PUBLIC_KEY") {
                verify_signing_public_key(&signing_key, &expected_public_key)?;
            }
            Ok(Some((key_id.to_string(), signing_key)))
        }
    }
}

fn decode_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("Invalid DBX_PLUGIN_SIGNING_KEY: {error}"))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "DBX_PLUGIN_SIGNING_KEY must contain 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn verify_signing_public_key(signing_key: &SigningKey, expected: &str) -> Result<(), String> {
    let expected = base64::engine::general_purpose::STANDARD
        .decode(expected.trim())
        .map_err(|error| format!("Invalid DBX_PLUGIN_SIGNING_PUBLIC_KEY: {error}"))?;
    let expected: [u8; 32] =
        expected.try_into().map_err(|_| "DBX_PLUGIN_SIGNING_PUBLIC_KEY must contain 32 bytes".to_string())?;
    if signing_key.verifying_key().to_bytes() != expected {
        return Err("DBX_PLUGIN_SIGNING_KEY does not match DBX_PLUGIN_SIGNING_PUBLIC_KEY".to_string());
    }
    Ok(())
}

fn absolute_output_path(output: &Path) -> Result<PathBuf, String> {
    if output.is_absolute() {
        return Ok(output.to_path_buf());
    }
    std::env::current_dir().map(|current| current.join(output)).map_err(|error| error.to_string())
}

pub fn validate_key_id(key_id: &str) -> Result<(), String> {
    if key_id.is_empty()
        || key_id.len() > 128
        || !key_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':'))
    {
        return Err("Signing key id contains unsupported characters".to_string());
    }
    Ok(())
}

fn validate_artifact_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 64
        || !target
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
    {
        return Err("Artifact target contains unsupported characters".to_string());
    }
    Ok(())
}

fn archive_name(path: &Path) -> Result<String, String> {
    path.components()
        .map(|component| match component {
            std::path::Component::Normal(value) => {
                value.to_str().map(str::to_string).ok_or("Package path is not UTF-8".to_string())
            }
            _ => Err(format!("Unsafe package path: {}", path.display())),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    bytes.as_ref().iter().fold(String::with_capacity(64), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

#[cfg(unix)]
fn executable_permissions(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path).map(|metadata| metadata.permissions().mode() & 0o777).unwrap_or(0o644)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(unix))]
fn executable_permissions(path: &Path) -> u32 {
    path.parent()
        .and_then(Path::file_name)
        .is_some_and(|parent| parent.to_string_lossy().contains('-'))
        .then_some(0o755)
        .unwrap_or(0o644)
}

fn usage() -> String {
    format!(
        "Usage: dbx-plugin-packager <source-dir> <output.dbxp> [--key-id ID] [--artifact-metadata FILE --target TARGET [--artifact-url URL]]\n       {}",
        sign_usage()
    )
}

fn sign_usage() -> String {
    "dbx-plugin-packager sign <unsigned.dbxp> <signed.dbxp> --key-id ID [--artifact-metadata FILE --target TARGET [--artifact-url URL]]".to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::path::Path;

    use base64::Engine;
    use ed25519_dalek::{Signature, SigningKey, Verifier};
    use zip::ZipArchive;

    use super::{
        archive_name, artifact_metadata_request, decode_signing_key, generate_signing_key, hex_digest, run_package_cli,
        sign_existing_package, validate_artifact_target, validate_key_id, verify_signing_public_key,
    };

    #[test]
    fn generates_matching_ed25519_key_material() {
        let material = generate_signing_key().unwrap();
        let seed: [u8; 32] =
            base64::engine::general_purpose::STANDARD.decode(material.private_seed_base64).unwrap().try_into().unwrap();
        let public_key: [u8; 32] =
            base64::engine::general_purpose::STANDARD.decode(material.public_key_base64).unwrap().try_into().unwrap();
        assert_eq!(SigningKey::from_bytes(&seed).verifying_key().to_bytes(), public_key);
    }

    #[test]
    fn validates_configured_repository_public_key() {
        let signing_key = decode_signing_key(&base64::engine::general_purpose::STANDARD.encode([7u8; 32])).unwrap();
        let matching = base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes());
        verify_signing_public_key(&signing_key, &matching).unwrap();

        let different = base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(verify_signing_public_key(&signing_key, &different).unwrap_err().contains("does not match"));
    }

    #[test]
    fn validates_signing_key_ids() {
        validate_key_id("vendor.release:2026-07").unwrap();
        assert!(validate_key_id("contains spaces").is_err());
        assert!(validate_key_id("").is_err());
    }

    #[test]
    fn validates_artifact_targets() {
        validate_artifact_target("darwin-arm64").unwrap();
        validate_artifact_target("universal").unwrap();
        assert!(validate_artifact_target("Darwin ARM64").is_err());
    }

    #[test]
    fn requires_target_for_artifact_metadata() {
        assert!(artifact_metadata_request(Some("artifact.json".into()), None, None, Some("vendor.release")).is_err());
        assert!(artifact_metadata_request(None, Some("universal".to_string()), None, Some("vendor.release")).is_err());
        assert!(artifact_metadata_request(
            Some("artifact.json".into()),
            Some("universal".to_string()),
            Some("plugin.dbxp".to_string()),
            None,
        )
        .unwrap()
        .is_some());
        assert!(artifact_metadata_request(
            Some("artifact.json".into()),
            Some("universal".to_string()),
            Some("plugin.dbxp".to_string()),
            Some("vendor.release"),
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn normalizes_safe_archive_names_and_rejects_parent_paths() {
        assert_eq!(archive_name(Path::new("bin/darwin-arm64/plugin")).unwrap(), "bin/darwin-arm64/plugin");
        assert!(archive_name(Path::new("../plugin")).is_err());
    }

    #[test]
    fn renders_lowercase_sha256_hex() {
        assert_eq!(hex_digest([0x00, 0x7f, 0xa5, 0xff]), "007fa5ff");
    }

    #[test]
    fn store_signs_an_existing_unsigned_candidate_package() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("manifest.json"), r#"{"manifest_version":1,"id":"example.plugin"}"#).unwrap();
        std::fs::write(source.join("asset.txt"), "candidate").unwrap();
        let unsigned = root.path().join("unsigned.dbxp");
        let signed = root.path().join("signed.dbxp");
        run_package_cli([source.to_string_lossy().into_owned(), unsigned.to_string_lossy().into_owned()], false)
            .unwrap();

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        sign_existing_package(&unsigned, &signed, "dbx-store.test", &signing_key, None, false).unwrap();

        let mut archive = ZipArchive::new(std::fs::File::open(&signed).unwrap()).unwrap();
        let mut checksums = Vec::new();
        archive.by_name("checksums.json").unwrap().read_to_end(&mut checksums).unwrap();
        let signature: serde_json::Value = {
            let mut raw = Vec::new();
            archive.by_name("signature.json").unwrap().read_to_end(&mut raw).unwrap();
            serde_json::from_slice(&raw).unwrap()
        };
        assert_eq!(signature["key_id"], "dbx-store.test");
        let signature_bytes: [u8; 64] = base64::engine::general_purpose::STANDARD
            .decode(signature["signature"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        signing_key.verifying_key().verify(&checksums, &Signature::from_bytes(&signature_bytes)).unwrap();
        assert!(sign_existing_package(
            &signed,
            &root.path().join("resigned.dbxp"),
            "dbx-store.test",
            &signing_key,
            None,
            false
        )
        .unwrap_err()
        .contains("already signed"));
    }
}
