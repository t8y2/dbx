use crate::models::connection::ConnectionConfig;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const MAIN_PASSWORD_KEY: &str = "password";
pub const SSH_PASSWORD_KEY: &str = "ssh_password";
pub const SSH_KEY_PASSPHRASE_KEY: &str = "ssh_key_passphrase";
pub const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
pub const PROXY_PASSWORD_KEY: &str = "proxy_password";
pub const REDIS_SENTINEL_PASSWORD_KEY: &str = "redis_sentinel_password";
pub const CONNECTION_STRING_KEY: &str = "connection_string";

pub trait ConnectionSecretStore {
    fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String>;
    fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String>;
    fn delete_secret_prefix(&self, _connection_id: &str, _key_prefix: &str) -> Result<(), String> {
        Ok(())
    }
}

pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_store(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path).ok().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
    }

    fn write_store(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

impl ConnectionSecretStore for FileSecretStore {
    fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
        let mut map = self.read_store();
        map.insert(secret_account(connection_id, key), secret.to_string());
        self.write_store(&map)
    }

    fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
        Ok(self.read_store().get(&secret_account(connection_id, key)).cloned())
    }

    fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
        let mut map = self.read_store();
        map.remove(&secret_account(connection_id, key));
        self.write_store(&map)
    }

    fn delete_secret_prefix(&self, connection_id: &str, key_prefix: &str) -> Result<(), String> {
        let mut map = self.read_store();
        let account_prefix = secret_account(connection_id, key_prefix);
        map.retain(|key, _| !key.starts_with(&account_prefix));
        self.write_store(&map)
    }
}

pub fn save_connections_to_file(
    path: &Path,
    configs: &[ConnectionConfig],
    store: &dyn ConnectionSecretStore,
) -> Result<(), String> {
    delete_removed_connection_secrets(path, configs, store)?;
    for config in configs {
        persist_secret(store, &config.id, MAIN_PASSWORD_KEY, &config.password)?;
        persist_secret(store, &config.id, SSH_PASSWORD_KEY, &config.ssh_password)?;
        persist_secret(store, &config.id, SSH_KEY_PASSPHRASE_KEY, &config.ssh_key_passphrase)?;
        delete_secret_prefix(store, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
        for (index, hop) in config.ssh_tunnels.iter().enumerate() {
            persist_secret(store, &config.id, &ssh_tunnel_password_key(index, hop), &hop.password)?;
            persist_secret(store, &config.id, &ssh_tunnel_key_passphrase_key(index, hop), &hop.key_passphrase)?;
        }
        persist_secret(store, &config.id, PROXY_PASSWORD_KEY, &config.proxy_password)?;
        persist_secret(store, &config.id, REDIS_SENTINEL_PASSWORD_KEY, &config.redis_sentinel_password)?;
        persist_optional_secret(store, &config.id, CONNECTION_STRING_KEY, config.connection_string.as_deref())?;
    }

    write_sanitized_connections(path, configs)
}

pub fn load_connections_from_file(
    path: &Path,
    store: &dyn ConnectionSecretStore,
) -> Result<Vec<ConnectionConfig>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut configs = read_connections(path)?;
    let mut needs_rewrite = false;
    for config in &mut configs {
        if config.password.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, MAIN_PASSWORD_KEY)? {
                config.password = secret;
            }
        } else {
            store.set_secret(&config.id, MAIN_PASSWORD_KEY, &config.password)?;
            needs_rewrite = true;
        }

        if config.ssh_password.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, SSH_PASSWORD_KEY)? {
                config.ssh_password = secret;
            }
        } else {
            store.set_secret(&config.id, SSH_PASSWORD_KEY, &config.ssh_password)?;
            needs_rewrite = true;
        }

        if config.ssh_key_passphrase.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, SSH_KEY_PASSPHRASE_KEY)? {
                config.ssh_key_passphrase = secret;
            }
        } else {
            store.set_secret(&config.id, SSH_KEY_PASSPHRASE_KEY, &config.ssh_key_passphrase)?;
            needs_rewrite = true;
        }

        for (index, hop) in config.ssh_tunnels.iter_mut().enumerate() {
            if hop.password.is_empty() {
                if let Some(secret) = store.get_secret(&config.id, &ssh_tunnel_password_key(index, hop))? {
                    hop.password = secret;
                }
            } else {
                store.set_secret(&config.id, &ssh_tunnel_password_key(index, hop), &hop.password)?;
                needs_rewrite = true;
            }
            if hop.key_passphrase.is_empty() {
                if let Some(secret) = store.get_secret(&config.id, &ssh_tunnel_key_passphrase_key(index, hop))? {
                    hop.key_passphrase = secret;
                }
            } else {
                store.set_secret(&config.id, &ssh_tunnel_key_passphrase_key(index, hop), &hop.key_passphrase)?;
                needs_rewrite = true;
            }
        }

        if config.proxy_password.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, PROXY_PASSWORD_KEY)? {
                config.proxy_password = secret;
            }
        } else {
            store.set_secret(&config.id, PROXY_PASSWORD_KEY, &config.proxy_password)?;
            needs_rewrite = true;
        }

        if config.redis_sentinel_password.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, REDIS_SENTINEL_PASSWORD_KEY)? {
                config.redis_sentinel_password = secret;
            }
        } else {
            store.set_secret(&config.id, REDIS_SENTINEL_PASSWORD_KEY, &config.redis_sentinel_password)?;
            needs_rewrite = true;
        }

        match config.connection_string.as_deref().filter(|secret| !secret.is_empty()) {
            Some(secret) => {
                store.set_secret(&config.id, CONNECTION_STRING_KEY, secret)?;
                needs_rewrite = true;
            }
            None => {
                if let Some(secret) = store.get_secret(&config.id, CONNECTION_STRING_KEY)? {
                    config.connection_string = Some(secret);
                }
            }
        }
    }

    if needs_rewrite {
        write_sanitized_connections(path, &configs)?;
    }

    Ok(configs)
}

fn delete_removed_connection_secrets(
    path: &Path,
    configs: &[ConnectionConfig],
    store: &dyn ConnectionSecretStore,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let previous = match read_connections(path) {
        Ok(configs) => configs,
        Err(_) => return Ok(()),
    };
    let current_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    for config in previous {
        if current_ids.contains(config.id.as_str()) {
            continue;
        }
        store.delete_secret(&config.id, MAIN_PASSWORD_KEY)?;
        store.delete_secret(&config.id, SSH_PASSWORD_KEY)?;
        store.delete_secret(&config.id, SSH_KEY_PASSPHRASE_KEY)?;
        delete_secret_prefix(store, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
        store.delete_secret(&config.id, CONNECTION_STRING_KEY)?;
    }
    Ok(())
}

fn persist_secret(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        store.delete_secret(connection_id, key)
    } else {
        store.set_secret(connection_id, key, secret)
    }
}

fn persist_optional_secret(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key: &str,
    secret: Option<&str>,
) -> Result<(), String> {
    match secret.filter(|secret| !secret.is_empty()) {
        Some(secret) => store.set_secret(connection_id, key, secret),
        None => store.delete_secret(connection_id, key),
    }
}

fn delete_secret_prefix(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key_prefix: &str,
) -> Result<(), String> {
    store.delete_secret_prefix(connection_id, key_prefix)
}

fn ssh_tunnel_secret_segment(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    if hop.id.trim().is_empty() {
        index.to_string()
    } else {
        hop.id.clone()
    }
}

fn ssh_tunnel_password_key(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    format!("{}{}.password", SSH_TUNNEL_SECRET_PREFIX, ssh_tunnel_secret_segment(index, hop))
}

fn ssh_tunnel_key_passphrase_key(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    format!("{}{}.key_passphrase", SSH_TUNNEL_SECRET_PREFIX, ssh_tunnel_secret_segment(index, hop))
}

fn read_connections(path: &Path) -> Result<Vec<ConnectionConfig>, String> {
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

fn write_sanitized_connections(path: &Path, configs: &[ConnectionConfig]) -> Result<(), String> {
    let sanitized = sanitize_connections(configs);
    let json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn sanitize_connections(configs: &[ConnectionConfig]) -> Vec<ConnectionConfig> {
    configs
        .iter()
        .cloned()
        .map(|mut config| {
            config.password.clear();
            config.ssh_password.clear();
            config.ssh_key_passphrase.clear();
            for hop in &mut config.ssh_tunnels {
                hop.password.clear();
                hop.key_passphrase.clear();
            }
            config.proxy_password.clear();
            config.redis_sentinel_password.clear();
            config.connection_string = None;
            config
        })
        .collect()
}

pub fn secret_account(connection_id: &str, key: &str) -> String {
    format!("connection:{connection_id}:{key}")
}

#[cfg(test)]
mod tests {
    use super::{
        load_connections_from_file, save_connections_to_file, ConnectionSecretStore, CONNECTION_STRING_KEY,
        MAIN_PASSWORD_KEY, REDIS_SENTINEL_PASSWORD_KEY, SSH_PASSWORD_KEY,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType, ProxyType, SshTunnelConfig};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::Path;

    #[derive(Default)]
    struct MemorySecretStore {
        values: RefCell<HashMap<String, String>>,
        deleted: RefCell<Vec<String>>,
    }

    impl MemorySecretStore {
        fn set_existing(&self, connection_id: &str, key: &str, value: &str) {
            self.values.borrow_mut().insert(secret_key(connection_id, key), value.to_string());
        }

        fn get_existing(&self, connection_id: &str, key: &str) -> Option<String> {
            self.values.borrow().get(&secret_key(connection_id, key)).cloned()
        }

        fn was_deleted(&self, connection_id: &str, key: &str) -> bool {
            self.deleted.borrow().contains(&secret_key(connection_id, key))
        }
    }

    impl ConnectionSecretStore for MemorySecretStore {
        fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
            self.values.borrow_mut().insert(secret_key(connection_id, key), secret.to_string());
            Ok(())
        }

        fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(&secret_key(connection_id, key)).cloned())
        }

        fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(&secret_key(connection_id, key));
            self.deleted.borrow_mut().push(secret_key(connection_id, key));
            Ok(())
        }

        fn delete_secret_prefix(&self, connection_id: &str, key_prefix: &str) -> Result<(), String> {
            let prefix = secret_key(connection_id, key_prefix);
            self.values.borrow_mut().retain(|key, _| !key.starts_with(&prefix));
            self.deleted.borrow_mut().push(prefix);
            Ok(())
        }
    }

    fn secret_key(connection_id: &str, key: &str) -> String {
        format!("{connection_id}:{key}")
    }

    fn temp_connections_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-connection-secrets-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("connections.json")
    }

    fn connection(id: &str, password: &str, ssh_password: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: format!("{id} connection"),
            db_type: DatabaseType::Postgres,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "localhost".to_string(),
            port: 5432,
            username: "postgres".to_string(),
            password: password.to_string(),
            database: Some("postgres".to_string()),
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            ssh_enabled: !ssh_password.is_empty(),
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: ssh_password.to_string(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssh_connect_timeout_secs: crate::models::connection::default_ssh_connect_timeout_secs(),
            ssh_tunnels: Vec::new(),
            connect_timeout_secs: crate::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: crate::models::connection::default_query_timeout_secs(),
            proxy_enabled: false,
            proxy_type: ProxyType::Socks5,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            ssl: false,
            ca_cert_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
        }
    }

    fn ssh_hop(id: &str, password: &str, passphrase: &str) -> SshTunnelConfig {
        SshTunnelConfig {
            id: id.to_string(),
            name: String::new(),
            enabled: true,
            host: "bastion".to_string(),
            port: 22,
            user: "user".to_string(),
            password: password.to_string(),
            key_path: "~/.ssh/id_ed25519".to_string(),
            key_passphrase: passphrase.to_string(),
            connect_timeout_secs: 5,
            expose_lan: false,
        }
    }

    fn read_configs(path: &Path) -> Vec<ConnectionConfig> {
        let json = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn save_connections_moves_passwords_to_secret_store_and_redacts_file() {
        let path = temp_connections_file("save-redacts");
        let store = MemorySecretStore::default();
        let mut config = connection("main", "db-secret", "ssh-secret");
        config.ssh_tunnels = vec![ssh_hop("hop-1", "hop-secret", "hop-key")];
        config.redis_sentinel_password = "sentinel-secret".to_string();
        let configs = vec![config];

        save_connections_to_file(&path, &configs, &store).unwrap();

        assert_eq!(store.get_existing("main", MAIN_PASSWORD_KEY).as_deref(), Some("db-secret"));
        assert_eq!(store.get_existing("main", SSH_PASSWORD_KEY).as_deref(), Some("ssh-secret"));
        assert_eq!(store.get_existing("main", "ssh_tunnels.hop-1.password").as_deref(), Some("hop-secret"));
        assert_eq!(store.get_existing("main", "ssh_tunnels.hop-1.key_passphrase").as_deref(), Some("hop-key"));
        assert_eq!(store.get_existing("main", REDIS_SENTINEL_PASSWORD_KEY).as_deref(), Some("sentinel-secret"));
        let persisted = read_configs(&path);
        assert_eq!(persisted[0].password, "");
        assert_eq!(persisted[0].ssh_password, "");
        assert_eq!(persisted[0].ssh_tunnels[0].password, "");
        assert_eq!(persisted[0].ssh_tunnels[0].key_passphrase, "");
        assert_eq!(persisted[0].redis_sentinel_password, "");
    }

    #[test]
    fn load_connections_restores_passwords_from_secret_store() {
        let path = temp_connections_file("load-restores");
        let store = MemorySecretStore::default();
        store.set_existing("main", MAIN_PASSWORD_KEY, "db-secret");
        store.set_existing("main", SSH_PASSWORD_KEY, "ssh-secret");
        store.set_existing("main", "ssh_tunnels.hop-1.password", "hop-secret");
        store.set_existing("main", "ssh_tunnels.hop-1.key_passphrase", "hop-key");
        store.set_existing("main", REDIS_SENTINEL_PASSWORD_KEY, "sentinel-secret");
        let mut sanitized_config = connection("main", "", "");
        sanitized_config.ssh_tunnels = vec![ssh_hop("hop-1", "", "")];
        let sanitized = vec![sanitized_config];
        std::fs::write(&path, serde_json::to_string_pretty(&sanitized).unwrap()).unwrap();

        let loaded = load_connections_from_file(&path, &store).unwrap();

        assert_eq!(loaded[0].password, "db-secret");
        assert_eq!(loaded[0].ssh_password, "ssh-secret");
        assert_eq!(loaded[0].ssh_tunnels[0].password, "hop-secret");
        assert_eq!(loaded[0].ssh_tunnels[0].key_passphrase, "hop-key");
        assert_eq!(loaded[0].redis_sentinel_password, "sentinel-secret");
    }

    #[test]
    fn load_connections_migrates_plaintext_passwords_and_rewrites_sanitized_file() {
        let path = temp_connections_file("migrates-plaintext");
        let store = MemorySecretStore::default();
        let legacy = vec![connection("legacy", "plain-db", "plain-ssh")];
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let loaded = load_connections_from_file(&path, &store).unwrap();

        assert_eq!(loaded[0].password, "plain-db");
        assert_eq!(loaded[0].ssh_password, "plain-ssh");
        assert_eq!(store.get_existing("legacy", MAIN_PASSWORD_KEY).as_deref(), Some("plain-db"));
        assert_eq!(store.get_existing("legacy", SSH_PASSWORD_KEY).as_deref(), Some("plain-ssh"));
        let persisted = read_configs(&path);
        assert_eq!(persisted[0].password, "");
        assert_eq!(persisted[0].ssh_password, "");
    }

    #[test]
    fn save_connections_deletes_secrets_for_removed_connections() {
        let path = temp_connections_file("deletes-removed");
        let store = MemorySecretStore::default();
        let previous = vec![connection("old", "", ""), connection("kept", "", "")];
        std::fs::write(&path, serde_json::to_string_pretty(&previous).unwrap()).unwrap();
        store.set_existing("old", MAIN_PASSWORD_KEY, "old-db");
        store.set_existing("old", SSH_PASSWORD_KEY, "old-ssh");
        store.set_existing("kept", MAIN_PASSWORD_KEY, "kept-db");

        save_connections_to_file(&path, &[connection("kept", "new-db", "")], &store).unwrap();

        assert!(store.was_deleted("old", MAIN_PASSWORD_KEY));
        assert!(store.was_deleted("old", SSH_PASSWORD_KEY));
        assert_eq!(store.get_existing("kept", MAIN_PASSWORD_KEY).as_deref(), Some("new-db"));
    }

    #[test]
    fn save_connections_moves_connection_string_to_secret_store_and_restores_it() {
        let path = temp_connections_file("connection-string");
        let store = MemorySecretStore::default();
        let mut config = connection("mongo", "", "");
        config.db_type = DatabaseType::MongoDb;
        config.connection_string = Some("mongodb://user:secret@localhost/app".to_string());

        save_connections_to_file(&path, &[config], &store).unwrap();

        assert_eq!(
            store.get_existing("mongo", CONNECTION_STRING_KEY).as_deref(),
            Some("mongodb://user:secret@localhost/app")
        );
        let persisted = read_configs(&path);
        assert_eq!(persisted[0].connection_string, None);

        let loaded = load_connections_from_file(&path, &store).unwrap();
        assert_eq!(loaded[0].connection_string.as_deref(), Some("mongodb://user:secret@localhost/app"));
    }
}
