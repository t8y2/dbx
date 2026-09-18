use std::env;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    generate_core_dialects(&manifest_dir.join("../../plugins/dialects"), &out_dir);
}

fn yaml_entries(directory: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(directory)
        .unwrap_or_else(|_| panic!("Cannot read {} directory", directory.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "yaml" || extension == "yml"))
        .collect();
    entries.sort();
    entries
}

fn generate_core_dialects(dialects_dir: &Path, out_dir: &Path) {
    let dialects_dir = std::fs::canonicalize(dialects_dir).unwrap_or_else(|_| dialects_dir.to_path_buf());
    let dest_path = out_dir.join("core_dialects.rs");
    let entries = yaml_entries(&dialects_dir);

    // Watch the directory itself so additions/removals of dialect files trigger a rebuild.
    println!("cargo::rerun-if-changed={}", dialects_dir.to_str().unwrap());

    let mut code = String::from("{\n");

    for path in &entries {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
        let file_name = path.file_stem().unwrap().to_str().unwrap();
        let path_str = canonical.to_str().unwrap();

        // Watch each dialect file individually. Editing a single YAML must invalidate
        // the embedded `core_dialects.rs`, otherwise the compiled binary keeps a stale
        // type catalog (e.g. old type names) and silently misbehaves (see field mapping).
        println!("cargo::rerun-if-changed={}", path_str);

        code.push_str("match crate::sql_dialect::dialect_loader::DialectPluginLoader::load_from_string(\n");
        code.push_str(&format!("    include_str!(\"{}\"),\n", path_str.replace('\\', "\\\\")));
        code.push_str("    None,\n");
        code.push_str(") {\n");
        code.push_str("    Ok((_kind, yaml, descriptor)) => {\n");
        code.push_str("        let name = yaml.dialect.name.clone();\n");
        code.push_str("        registry.register_descriptor(&name, descriptor, yaml);\n");
        code.push_str("    }\n");
        code.push_str(&format!("    Err(e) => log::warn!(\"Failed to load core dialect '{}': {{e}}\"),\n", file_name));
        code.push_str("};\n");
    }

    code.push_str("}\n");

    std::fs::write(&dest_path, code).expect("Failed to write core_dialects.rs");
}
