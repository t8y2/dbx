use std::env;
use std::path::Path;

fn main() {
    let cargo_manifest_dir_str = env::var("CARGO_MANIFEST_DIR").unwrap();
    let cargo_manifest_dir = Path::new(&cargo_manifest_dir_str);
    let dialects_dir = cargo_manifest_dir.join("..").join("..").join("plugins").join("dialects");
    let dialects_dir = std::fs::canonicalize(&dialects_dir).unwrap_or(dialects_dir);

    let out_dir_str = env::var("OUT_DIR").unwrap();
    let dest_path = Path::new(&out_dir_str).join("core_dialects.rs");

    let mut entries: Vec<_> = std::fs::read_dir(&dialects_dir)
        .expect("Cannot read plugins/dialects directory")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "yaml" || ext == "yml"))
        .collect();
    entries.sort_by_key(|e| e.file_name());

    // Watch the directory itself so additions/removals of dialect files trigger a rebuild.
    println!("cargo::rerun-if-changed={}", dialects_dir.to_str().unwrap());

    let mut code = String::from("{\n");

    for entry in &entries {
        let path = entry.path();
        let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
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
