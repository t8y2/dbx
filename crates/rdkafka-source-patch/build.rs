//! Work around confluentinc/librdkafka#5204: `rdkafka_conf.c` uses
//! `#ifdef WITH_OAUTHBEARER_OIDC` but CMake's `cmakedefine01` always defines
//! the macro (as 0 or 1), so `curl/curl.h` is required even when `WITH_CURL=0`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let Some(registry_root) = cargo_registry_src_root() else {
        println!("cargo:warning=rdkafka-source-patch: could not locate Cargo registry");
        return;
    };

    let mut patched = 0usize;
    for mirror in fs::read_dir(&registry_root).into_iter().flatten().flatten() {
        if !mirror.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mirror_path = mirror.path();
        let Ok(entries) = fs::read_dir(&mirror_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("rdkafka-sys-") {
                continue;
            }
            let conf_c = entry.path().join("librdkafka/src/rdkafka_conf.c");
            if patch_rdkafka_conf_c(&conf_c) {
                patched += 1;
            }
        }
    }

    if patched == 0 {
        println!(
            "cargo:warning=rdkafka-source-patch: no rdkafka-sys sources found under {}",
            registry_root.display()
        );
    }
}

fn cargo_registry_src_root() -> Option<PathBuf> {
    if let Ok(home) = env::var("CARGO_HOME") {
        let root = PathBuf::from(home).join("registry/src");
        if root.is_dir() {
            return Some(root);
        }
    }

    for key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = env::var(key) {
            let root = PathBuf::from(home).join(".cargo/registry/src");
            if root.is_dir() {
                return Some(root);
            }
        }
    }

    None
}

fn patch_rdkafka_conf_c(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) => {
            println!(
                "cargo:warning=rdkafka-source-patch: failed to read {}: {err}",
                path.display()
            );
            return false;
        }
    };

    if !content.contains("#ifdef WITH_OAUTHBEARER_OIDC") {
        return false;
    }

    let patched = content.replace(
        "#ifdef WITH_OAUTHBEARER_OIDC",
        "#if WITH_OAUTHBEARER_OIDC",
    );

    if let Err(err) = fs::write(path, patched) {
        println!(
            "cargo:warning=rdkafka-source-patch: failed to write {}: {err}",
            path.display()
        );
        return false;
    }

    println!(
        "cargo:warning=rdkafka-source-patch: patched {} for librdkafka#5204",
        path.display()
    );
    true
}
