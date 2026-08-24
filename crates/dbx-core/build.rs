use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseDescriptor {
    schema_version: u32,
    order: u32,
    db_type: String,
    rust_variant: String,
}

fn main() {
    let cargo_manifest_dir_str = env::var("CARGO_MANIFEST_DIR").unwrap();
    let cargo_manifest_dir = Path::new(&cargo_manifest_dir_str);
    let plugins_dir = cargo_manifest_dir.join("..").join("..").join("plugins");
    let out_dir_str = env::var("OUT_DIR").unwrap();
    let out_dir = Path::new(&out_dir_str);

    generate_core_dialects(&plugins_dir.join("dialects"), out_dir);
    generate_connection_type_registry(&plugins_dir.join("connection-types"), out_dir);
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

fn generate_connection_type_registry(connection_types_dir: &Path, out_dir: &Path) {
    let connection_types_dir =
        std::fs::canonicalize(connection_types_dir).unwrap_or_else(|_| connection_types_dir.to_path_buf());
    println!("cargo::rerun-if-changed={}", connection_types_dir.display());

    let mut descriptors = Vec::new();
    let mut db_types = HashSet::new();
    let mut rust_variants = HashSet::new();
    let mut orders = HashSet::new();

    for path in yaml_entries(&connection_types_dir) {
        println!("cargo::rerun-if-changed={}", path.display());
        let content = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("Cannot read {}", path.display()));
        let descriptor: DatabaseDescriptor = serde_yaml_ng::from_str(&content)
            .unwrap_or_else(|error| panic!("Invalid connection type descriptor {}: {error}", path.display()));
        assert_eq!(descriptor.schema_version, 1, "{} must use schemaVersion 1", path.display());
        assert!(db_types.insert(descriptor.db_type.clone()), "Duplicate database type {}", descriptor.db_type);
        assert!(
            rust_variants.insert(descriptor.rust_variant.clone()),
            "Duplicate Rust database variant {}",
            descriptor.rust_variant
        );
        assert!(orders.insert(descriptor.order), "Duplicate connection type descriptor order {}", descriptor.order);

        let mut public_descriptor: serde_json::Value = serde_yaml_ng::from_str(&content)
            .unwrap_or_else(|error| panic!("Invalid connection type descriptor {}: {error}", path.display()));
        let public_object = public_descriptor.as_object_mut().expect("Database descriptor must be an object");
        public_object.remove("schemaVersion");
        public_object.remove("order");
        public_object.remove("rustVariant");
        descriptors.push((descriptor, public_descriptor));
    }

    descriptors.sort_by_key(|(descriptor, _)| descriptor.order);
    let public_descriptors = descriptors.iter().map(|(_, descriptor)| descriptor.clone()).collect::<Vec<_>>();
    let manifest = serde_json::json!({ "schemaVersion": 1, "drivers": public_descriptors });
    std::fs::write(
        out_dir.join("database_manifest.json"),
        serde_json::to_string(&manifest).expect("Failed to serialize database manifest"),
    )
    .expect("Failed to write database_manifest.json");

    let mut code = String::from(
        "#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq, Hash)]\n\
         #[cfg_attr(feature = \"openapi\", derive(utoipa::ToSchema))]\n\
         pub enum DatabaseType {\n",
    );
    for (descriptor, _) in &descriptors {
        code.push_str(&format!(
            "    #[serde(rename = \"{}\")]\n    {},\n",
            descriptor.db_type, descriptor.rust_variant
        ));
    }
    code.push_str("}\n\nimpl DatabaseType {\n");
    code.push_str("    pub const ALL: &'static [Self] = &[\n");
    for (descriptor, _) in &descriptors {
        code.push_str(&format!("        Self::{},\n", descriptor.rust_variant));
    }
    code.push_str("    ];\n\n    pub const fn as_str(self) -> &'static str {\n        match self {\n");
    for (descriptor, _) in &descriptors {
        code.push_str(&format!("            Self::{} => \"{}\",\n", descriptor.rust_variant, descriptor.db_type));
    }
    code.push_str("        }\n    }\n}\n");
    std::fs::write(out_dir.join("database_type.rs"), code).expect("Failed to write database_type.rs");
}
