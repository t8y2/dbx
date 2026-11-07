//! Extract only Navicat connection settings from a Wine registry file.
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use serde_json::{Map, Value};

fn section_path(line: &str) -> Option<String> {
    let raw = line.strip_prefix('[')?.split_once(']')?.0;
    quoted_string(&format!("\"{}\"", raw.replace('"', "\\\"")))
}

fn logical_lines(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut pending = String::new();
    for line in content.lines() {
        pending.push_str(line.trim());
        if pending.ends_with('\\') {
            pending.pop();
        } else {
            lines.push(std::mem::take(&mut pending));
        }
    }
    if !pending.is_empty() {
        lines.push(pending);
    }
    lines
}

fn hex_bytes(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) || value.len() > 32768 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(text, 16).ok()
        })
        .collect()
}

fn registry_bytes(value: &str) -> Option<Vec<u8>> {
    let hex = value.strip_prefix("hex:")?.replace(',', "");
    hex_bytes(&hex)
}

// Wine advapi32/cred.c protects registry credential blobs with ARC4.
// Read only the Navicat credential, using the key from the same Wine prefix.
fn rc4(key: &[u8], input: &[u8]) -> Option<Vec<u8>> {
    if key.is_empty() {
        return None;
    }
    let mut state = [0u8; 256];
    for (i, value) in state.iter_mut().enumerate() {
        *value = i as u8;
    }
    let mut j = 0;
    for i in 0..256 {
        j = (j + state[i] as usize + key[i % key.len()] as usize) % 256;
        state.swap(i, j);
    }
    let mut i = 0;
    j = 0;
    Some(
        input
            .iter()
            .map(|byte| {
                i = (i + 1) % 256;
                j = (j + state[i] as usize) % 256;
                state.swap(i, j);
                byte ^ state[(state[i] as usize + state[j] as usize) % 256]
            })
            .collect(),
    )
}

fn navicat_key(lines: &[String]) -> Option<[u8; 32]> {
    let mut section = String::new();
    let mut encryption_key = None;
    let mut credential_blob = None;
    for line in lines {
        if line.starts_with('[') {
            section = section_path(line).unwrap_or_default();
            continue;
        }
        let Some((field, value)) = line.split_once('=') else { continue };
        if section.eq_ignore_ascii_case("Software\\Wine\\Credential Manager") && field == "\"EncryptionKey\"" {
            encryption_key = registry_bytes(value);
        } else if section.eq_ignore_ascii_case("Software\\Wine\\Credential Manager\\Generic: navicat_cred")
            && field == "\"Password\""
        {
            credential_blob = registry_bytes(value);
        }
    }
    let encryption_key = encryption_key?;
    if encryption_key.len() != 8 {
        return None;
    }
    let credential = rc4(&encryption_key, &credential_blob?)?;
    let text = std::str::from_utf8(&credential).ok()?.trim_end_matches('\0');
    let mut key: [u8; 32] = hex_bytes(text)?.try_into().ok()?;
    // Navicat v3 key derivation, as documented in HyperSine's cipher analysis.
    key[25..29].copy_from_slice(&[3, 1, 3, 6]);
    Some(key)
}

fn decrypt_password(key: &[u8; 32], encrypted: &str) -> Option<String> {
    let data = hex_bytes(encrypted)?;
    if data.len() < 44 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    // Aes256Gcm verifies the trailing authentication tag before returning bytes.
    let plaintext = cipher.decrypt(Nonce::from_slice(&data[..12]), &data[12..]).ok()?;
    if plaintext.len() < 16 || plaintext.len() % 16 != 0 {
        return None;
    }
    let length = u16::from_le_bytes([plaintext[0], plaintext[1]]) as usize;
    if (length + 2).div_ceil(16) * 16 != plaintext.len() {
        return None;
    }
    String::from_utf8(plaintext.get(2..length + 2)?.to_vec()).ok()
}

fn recover_passwords(values: &mut Map<String, Value>, key: Option<&[u8; 32]>) {
    for (encrypted_field, saved_field, recovered_field) in [
        ("Pwd_2", "SavePassword_2", "DBXWinePassword"),
        ("SSH_Password_2", "SSH_SavePassword_2", "DBXWineSSHPassword"),
        ("SSH_Passphrase_2", "SSH_SavePassphrase_2", "DBXWineSSHPassphrase"),
    ] {
        let encrypted = values.remove(encrypted_field);
        let saved = values.remove(saved_field);
        if saved.as_ref().and_then(Value::as_str) == Some("0") {
            continue;
        }
        if let (Some(key), Some(encrypted)) = (key, encrypted.as_ref().and_then(Value::as_str)) {
            if let Some(password) = decrypt_password(key, encrypted) {
                values.insert(recovered_field.into(), Value::String(password));
            }
        }
    }
}

fn quoted_string(value: &str) -> Option<String> {
    // Wine uses JSON-compatible escapes plus \xHHHH for UTF-16 code units.
    let mut normalized = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        normalized.push(ch);
        if ch == '\\' {
            let escaped = chars.next()?;
            normalized.push(if escaped == 'x' { 'u' } else { escaped });
        }
    }
    serde_json::from_str(&normalized).ok()
}

fn connection_section(line: &str) -> Option<Map<String, Value>> {
    let path = section_path(line)?;
    let parts: Vec<_> = path.split('\\').collect();
    // Exact depth avoids importing schema metadata, saved queries or profiles.
    if parts.len() != 5
        || !parts[0].eq_ignore_ascii_case("software")
        || !parts[1].eq_ignore_ascii_case("premiumsoft")
        || !parts[3].eq_ignore_ascii_case("servers")
    {
        return None;
    }
    let provider = match parts[2].to_ascii_lowercase().as_str() {
        "navicat" => "MYSQL",
        "navicatmariadb" => "MARIADB",
        "navicatpg" => "POSTGRESQL",
        "navicatsqlite" => "SQLITE",
        "navicatmssql" => "MSSQL",
        "navicatora" => "ORACLE",
        "navicatmongodb" => "MONGODB",
        "navicatredis" => "REDIS",
        _ => return None,
    };
    Some(Map::from_iter([
        ("Name".into(), Value::String(parts[4].into())),
        ("ConnType".into(), Value::String(provider.into())),
    ]))
}

fn flush(current: &mut Option<Map<String, Value>>, connections: &mut Vec<Value>) {
    if let Some(values) = current.take() {
        let has_endpoint = ["Host", "DatabaseFileName"]
            .iter()
            .any(|key| values.get(*key).and_then(Value::as_str).is_some_and(|value| !value.is_empty()));
        if has_endpoint {
            connections.push(Value::Object(values));
        }
    }
}

pub(super) fn parse(content: &str) -> Vec<Value> {
    let lines = logical_lines(content);
    let key = navicat_key(&lines);
    let mut connections = Vec::new();
    let mut current = None;
    for line in &lines {
        if line.starts_with('[') {
            flush(&mut current, &mut connections);
            current = connection_section(line);
            continue;
        }
        let Some(values) = current.as_mut() else { continue };
        let Some((key, value)) = line.split_once('=') else { continue };
        let Some(key) = quoted_string(key) else { continue };
        // Only Navicat settings and its saved password fields are eligible.
        let target = match key.as_str() {
            "Host" | "Port" | "UserName" | "ServiceProvider" | "DatabaseFileName" | "UseSSH" | "SSH_Host"
            | "SSH_Port" | "SSH_UserName" | "SSH_AuthenMethod" | "SSH_PrivateKey" | "UseSSL" => key.as_str(),
            "InitialDatabase" | "Database" => "Database",
            "SID" | "ServiceName" => key.as_str(),
            "Pwd_2"
            | "SavePassword_2"
            | "SSH_Password_2"
            | "SSH_SavePassword_2"
            | "SSH_Passphrase_2"
            | "SSH_SavePassphrase_2" => key.as_str(),
            _ => continue,
        };
        let value = value.trim();
        let decoded = if let Some(hex) = value.strip_prefix("dword:") {
            u32::from_str_radix(hex, 16).ok().map(|number| number.to_string())
        } else {
            quoted_string(value)
        };
        if let Some(value) = decoded {
            values.insert(target.into(), Value::String(value));
        }
    }
    flush(&mut current, &mut connections);
    for connection in &mut connections {
        if let Some(values) = connection.as_object_mut() {
            recover_passwords(values, key.as_ref());
        }
    }
    connections
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREDENTIAL: &str = "f859ef8cf1362263e3080c962a81007e6ad9f5059bb2901e810148e1f41db604de9ce0fc684f31cf628dcf4ecac0af4d04258ee106b7b267615bfe24d3ece6e2";
    const PASSWORD: &str = "000102030405060708090a0b54103880b27d2130a9a632c938c92a79297a8e83b306d3ce1a5722d41e8dd856e693118ad7791f1fc6eb0781ab1ea14e";

    fn encrypted_registry() -> String {
        // Independent Python cryptography AESGCM fixture; no real credentials.
        let credential =
            hex_bytes(CREDENTIAL).unwrap().iter().map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(",");
        format!(
            r#"[Software\\Wine\\Credential Manager] 1
"EncryptionKey"=hex:10,11,12,13,14,15,16,17
[Software\\Wine\\Credential Manager\\Generic: navicat_cred] 1
"Password"=hex:{credential}
[Software\\PremiumSoft\\Navicat\\Servers\\Encrypted] 1
"Host"="mysql.example"
"Pwd_2"="{PASSWORD}"
"SavePassword_2"=dword:00000001
"SSH_Password_2"="{PASSWORD}"
"SSH_SavePassword_2"=dword:00000001
"SSH_Passphrase_2"="{PASSWORD}"
"SSH_SavePassphrase_2"=dword:00000001
"#
        )
    }

    #[test]
    fn recovers_authenticated_database_and_ssh_secrets() {
        let connections = parse(&encrypted_registry());
        assert_eq!(connections.len(), 1);
        for field in ["DBXWinePassword", "DBXWineSSHPassword", "DBXWineSSHPassphrase"] {
            assert_eq!(connections[0][field], "migration-demo-测试");
        }
        let serialized = serde_json::to_string(&connections).unwrap();
        assert!(!serialized.contains("EncryptionKey"));
        assert!(!serialized.contains("Pwd_2"));
        assert!(!serialized.contains("navicat_cred"));
    }

    #[test]
    fn missing_credentials_and_unsaved_passwords_stay_empty() {
        let registry = encrypted_registry();
        let only_server = registry[registry.find("[Software\\\\PremiumSoft").unwrap()..].to_string();
        assert!(parse(&only_server)[0].get("DBXWinePassword").is_none());
        let unsaved = registry.replace("\"SavePassword_2\"=dword:00000001", "\"SavePassword_2\"=dword:00000000");
        assert!(parse(&unsaved)[0].get("DBXWinePassword").is_none());
    }

    #[test]
    fn rejects_tampered_gcm_authentication_tags() {
        let mut bytes = hex_bytes(PASSWORD).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        let tampered = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let registry = encrypted_registry().replace(PASSWORD, &tampered);
        assert!(parse(&registry)[0].get("DBXWinePassword").is_none());
    }

    #[test]
    fn rc4_matches_the_standard_known_vector() {
        assert_eq!(rc4(b"Key", b"Plaintext").unwrap(), hex_bytes("bbf316e8d940af0ad3").unwrap());
    }

    #[test]
    fn imports_mysql_and_postgres_but_excludes_metadata_and_other_apps() {
        let registry = r#"WINE REGISTRY Version 2
[Software\\PremiumSoft\\Navicat\\Servers\\Demo] 123
"Host"="mysql.example"
"Port"=dword:00000cea
"UserName"="reader"
"Pwd_2"="private-blob"
[Software\\PremiumSoft\\Navicat\\Servers\\Demo\\Schemas\\app] 123
"Host"="metadata.invalid"
[Software\\OtherApp\\Servers\\Other] 123
"Host"="unrelated.invalid"
[Software\\PremiumSoft\\NavicatPG\\Servers\\Localhost] 123
"Host"="localhost"
"Port"=dword:00001538
"InitialDatabase"="postgres"
"UseSSH"=dword:00000001
"SSH_Host"="bastion.example"
"SSH_Port"=dword:00000016
"SSH_UserName"="tunnel"
"#;
        let connections = parse(registry);
        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0]["Name"], "Demo");
        assert_eq!(connections[0]["ConnType"], "MYSQL");
        assert_eq!(connections[0]["Port"], "3306");
        assert!(connections[0].get("Pwd_2").is_none());
        assert_eq!(connections[1]["ConnType"], "POSTGRESQL");
        assert_eq!(connections[1]["Port"], "5432");
        assert_eq!(connections[1]["Database"], "postgres");
        assert_eq!(connections[1]["SSH_Port"], "22");
    }

    #[test]
    fn decodes_wine_unicode_and_escaped_paths() {
        let registry = r#"[Software\\PremiumSoft\\NavicatSQLite\\Servers\\Caf\x00e9] 1
"DatabaseFileName"="C:\\data\\local.db"
"#;
        let connections = parse(registry);
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["Name"], "Café");
        assert_eq!(connections[0]["DatabaseFileName"], "C:\\data\\local.db");
    }

    #[test]
    fn malformed_and_empty_sections_are_ignored() {
        assert!(parse("[Software\\\\PremiumSoft\\\\Navicat\\\\Servers\\\\Empty]\n\"Port\"=dword:invalid").is_empty());
        assert!(parse("unrelated data").is_empty());
    }
}
