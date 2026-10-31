//! Desktop-only escape hatch for a completed migration whose original key is
//! missing. No migration state transitions or automatic recovery live here.
use super::*;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialResetPreparation {
    pub confirmation_token: String,
    pub encrypted_record_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialResetReport {
    pub backup_path: String,
    pub cleared_record_count: usize,
    pub state: MigrationState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialResetFailure {
    pub code: String,
    pub stage: String,
    pub backup_path: Option<String>,
}

impl CredentialResetFailure {
    fn new(code: &str, stage: &str, backup: Option<&Path>) -> Self {
        Self {
            code: code.to_string(),
            stage: stage.to_string(),
            backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
        }
    }
}

pub(super) struct Confirmation {
    token: String,
    fingerprint: String,
    key_files: Vec<(PathBuf, Option<[u8; 32]>)>,
    count: usize,
    created: Instant,
}

impl Storage {
    /// Only the native desktop host opts in. Platform and policy checks still
    /// apply, so Web/CLI/MCP cannot acquire this capability via a shared profile.
    pub fn with_desktop_credential_recovery(mut self) -> Self {
        self.desktop_credential_recovery = true;
        self
    }

    pub(super) fn credential_reset_blocked_reason(&self, status: &MigrationPreflight) -> Option<String> {
        let supported = cfg!(target_os = "windows");
        #[cfg(test)]
        let supported = supported || matches!(self.secret_key_policy, SecretKeyPolicy::TestDataDir);
        let reason = if !supported || !self.desktop_credential_recovery || !self.secret_key_creation_allowed {
            Some("CREDENTIAL_RESET_UNSUPPORTED")
        } else if std::env::var_os("DBX_SECRET_KEY").is_some()
            || std::env::var_os("DBX_SECRET_KEY_FILE").is_some()
            || matches!(self.secret_key_policy, SecretKeyPolicy::ExternalOnly)
        {
            Some("CREDENTIAL_RESET_EXTERNAL_KEY")
        } else if matches!(self.secret_key_policy, SecretKeyPolicy::PlatformDefault) && !cfg!(feature = "os-keyring") {
            Some("CREDENTIAL_RESET_UNSUPPORTED")
        } else if status.state != MigrationState::Succeeded
            || status.needs_migration
            || !status.key_recovery_required
            || status.encrypted_record_count == 0
        {
            Some("CREDENTIAL_RESET_NOT_ELIGIBLE")
        } else if status.error_code.as_deref() != Some("ENCRYPTED_DATA_KEY_MISSING") {
            Some("CREDENTIAL_RESET_KEY_NOT_MISSING")
        } else {
            None
        };
        reason.map(str::to_string)
    }

    pub async fn prepare_credential_reset(&self) -> Result<CredentialResetPreparation, CredentialResetFailure> {
        // Invalidate an earlier confirmation even if the new probe fails.
        self.credential_reset_confirmation.lock().unwrap_or_else(|p| p.into_inner()).take();
        let status = self
            .retry_data_migration_inspection()
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_INSPECTION_FAILED", "inspection", None))?;
        if let Some(reason) = self.credential_reset_blocked_reason(&status) {
            return Err(CredentialResetFailure::new(&reason, "inspection", None));
        }
        let (fingerprint, count) = self
            .with_conn(|conn| {
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                Ok((database_fingerprint(&tx)?, encrypted_count(&tx)?))
            })
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_INSPECTION_FAILED", "inspection", None))?;
        // A concurrent writer may have changed the rows since preflight.
        if count != status.encrypted_record_count {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_DATA_CHANGED", "inspection", None));
        }
        let token = Uuid::new_v4().to_string();
        *self.credential_reset_confirmation.lock().unwrap_or_else(|p| p.into_inner()) = Some(Confirmation {
            token: token.clone(),
            fingerprint,
            key_files: self.key_file_digests(),
            count,
            created: Instant::now(),
        });
        Ok(CredentialResetPreparation { confirmation_token: token, encrypted_record_count: count })
    }

    pub async fn reset_credentials(
        &self,
        token: String,
        confirmed: bool,
    ) -> Result<CredentialResetReport, CredentialResetFailure> {
        self.reset_credentials_with(token, confirmed, SecretCodec::create_credential_recovery_key).await
    }

    async fn reset_credentials_with<F>(
        &self,
        token: String,
        confirmed: bool,
        provision: F,
    ) -> Result<CredentialResetReport, CredentialResetFailure>
    where
        F: FnOnce(SecretKeyPolicy, &Path) -> Result<SecretCodec, String> + Send + 'static,
    {
        let confirmation =
            self.credential_reset_confirmation.lock().unwrap_or_else(|p| p.into_inner()).take().ok_or_else(|| {
                CredentialResetFailure::new("CREDENTIAL_RESET_CONFIRMATION_EXPIRED", "confirmation", None)
            })?;
        if !confirmed || token != confirmation.token || confirmation.created.elapsed() > Duration::from_secs(600) {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_CONFIRMATION_EXPIRED", "confirmation", None));
        }
        let _lock = DATA_MIGRATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
        let _file_lock = self
            .lock_data_migration()
            .map_err(|_| CredentialResetFailure::new("MIGRATION_IN_PROGRESS", "inspection", None))?;
        if confirmation.created.elapsed() > Duration::from_secs(600) {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_CONFIRMATION_EXPIRED", "confirmation", None));
        }
        self.invalidate_secret_codec();
        let status = self
            .retry_data_migration_inspection()
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_INSPECTION_FAILED", "inspection", None))?;
        if let Some(reason) = self.credential_reset_blocked_reason(&status) {
            return Err(CredentialResetFailure::new(&reason, "inspection", None));
        }
        if confirmation.key_files != self.key_file_digests() {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_KEY_CHANGED", "inspection", None));
        }
        let expected = confirmation.fingerprint.clone();
        let unchanged = self
            .with_conn(move |conn| Ok(database_fingerprint(conn)? == expected))
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_INSPECTION_FAILED", "inspection", None))?;
        if !unchanged {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_DATA_CHANGED", "inspection", None));
        }
        let backup = self.data_dir().join(format!("dbx-credential-reset-{}", Uuid::new_v4()));
        std::fs::create_dir(&backup)
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_FAILED", "backup", None))?;
        restrict_backup_permissions(&backup);
        let backup_db = backup.join(STORAGE_DB_FILE_NAME);
        let copy = backup_db.clone();
        self.with_conn(move |conn| conn.backup(DatabaseName::Main, &copy, None).map_err(|e| e.to_string()))
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_FAILED", "backup", Some(&backup)))?;
        restrict_backup_file_permissions(&backup_db);
        let source = Connection::open_with_flags(&backup_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_INVALID", "backup", Some(&backup)))?;
        let integrity: String = source
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_INVALID", "backup", Some(&backup)))?;
        if integrity != "ok" || database_fingerprint(&source).ok().as_ref() != Some(&confirmation.fingerprint) {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_DATA_CHANGED", "backup", Some(&backup)));
        }
        drop(source);
        // FlushFileBuffers on Windows requires a handle opened for writing.
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&backup_db)
            .and_then(|f| f.sync_all())
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_FAILED", "backup", Some(&backup)))?;
        let manifest = backup.join("reset.json");
        let manifest_data = serde_json::json!({"operation": "credential-reset", "version": 1,
            "encryptedRecordCount": confirmation.count, "migrationState": "succeeded",
            "note": "Pre-reset snapshot; original key is still required to decrypt old credentials."});
        {
            use std::io::Write;
            let mut file =
                std::fs::OpenOptions::new().write(true).create_new(true).open(&manifest).map_err(|_| {
                    CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_FAILED", "backup", Some(&backup))
                })?;
            restrict_backup_file_permissions(&manifest);
            file.write_all(manifest_data.to_string().as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_BACKUP_FAILED", "backup", Some(&backup)))?;
        }
        let policy = self.secret_key_policy;
        let dir = self.data_dir().to_path_buf();
        let backup_for_tx = backup.clone();
        let result = self
            .with_conn(move |conn| Ok(reset_transaction(conn, &confirmation, policy, &dir, &backup_for_tx, provision)))
            .await
            .map_err(|_| CredentialResetFailure::new("CREDENTIAL_RESET_DATABASE_FAILED", "database", Some(&backup)))?;
        self.invalidate_secret_codec();
        let cleared = result?;
        let status = self.retry_data_migration_inspection().await.map_err(|_| {
            CredentialResetFailure::new("CREDENTIAL_RESET_POSTCHECK_FAILED", "postcheck", Some(&backup))
        })?;
        if !status.is_ready() {
            return Err(CredentialResetFailure::new("CREDENTIAL_RESET_POSTCHECK_FAILED", "postcheck", Some(&backup)));
        }
        Ok(CredentialResetReport {
            backup_path: backup.to_string_lossy().into_owned(),
            cleared_record_count: cleared,
            state: status.state,
        })
    }
}

fn encrypted_count(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM connection_secrets WHERE secret_enc IS NOT NULL AND secret_enc <> ''",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Hash a consistent, complete logical snapshot, including migration metadata
/// and non-secret tables. The fingerprint never leaves the process. Including
/// schema also rejects newly installed triggers before executing a deletion.
fn database_fingerprint(conn: &Connection) -> Result<String, String> {
    database_fingerprint_filtered(conn, false)
}

fn database_fingerprint_filtered(conn: &Connection, exclude_encrypted: bool) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    let mut schema =
        conn.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").map_err(|e| e.to_string())?;
    let mut rows = schema.query([]).map_err(|e| e.to_string())?;
    let mut tables = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let kind: String = row.get(0).map_err(|e| e.to_string())?;
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        let sql: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        digest.update(format!("{kind:?}{name:?}{sql:?}"));
        if kind == "table" {
            tables.push(name);
        }
    }
    for table in tables {
        digest.update(format!("{table:?}"));
        let name = table.replace('"', "\"\"");
        let columns =
            conn.prepare(&format!("SELECT * FROM \"{name}\" LIMIT 0")).map_err(|e| e.to_string())?.column_count();
        let order = (1..=columns).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
        let filter = if exclude_encrypted && table == "connection_secrets" {
            "WHERE secret_enc IS NULL OR secret_enc = ''"
        } else {
            ""
        };
        let mut stmt =
            conn.prepare(&format!("SELECT * FROM \"{name}\" {filter} ORDER BY {order}")).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            for i in 0..columns {
                let value = format!("{:?}", row.get_ref(i).map_err(|e| e.to_string())?);
                digest.update((value.len() as u64).to_le_bytes());
                digest.update(value.as_bytes());
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn reset_transaction<F>(
    conn: &mut Connection,
    confirmation: &Confirmation,
    policy: SecretKeyPolicy,
    dir: &Path,
    backup: &Path,
    provision: F,
) -> Result<usize, CredentialResetFailure>
where
    F: FnOnce(SecretKeyPolicy, &Path) -> Result<SecretCodec, String>,
{
    let fail = |code, stage| CredentialResetFailure::new(code, stage, Some(backup));
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))?;
    if database_fingerprint(&tx).map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))?
        != confirmation.fingerprint
    {
        return Err(fail("CREDENTIAL_RESET_DATA_CHANGED", "database"));
    }
    // Do not rely on the earlier status probe when a key can be restored while
    // the backup is being written. Any present/erroring provider stops reset.
    match SecretCodec::resolve(policy, dir, false) {
        Err(error) if matches!(error.as_str(), "MISSING_MANAGED_KEY" | "KEY_PROVIDER_UNAVAILABLE") => {}
        _ => return Err(fail("CREDENTIAL_RESET_KEY_CHANGED", "key")),
    }
    let preserved =
        database_fingerprint_filtered(&tx, true).map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))?;
    let cleared = tx
        .execute("DELETE FROM connection_secrets WHERE secret_enc IS NOT NULL AND secret_enc <> ''", [])
        .map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))?;
    if cleared != confirmation.count {
        return Err(fail("CREDENTIAL_RESET_DATA_CHANGED", "database"));
    }
    // A user-added trigger must not turn credential reset into a modification
    // of configuration/history, or leave newly written ciphertext behind.
    if database_fingerprint(&tx).map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))? != preserved {
        return Err(fail("CREDENTIAL_RESET_DATA_CHANGED", "database"));
    }
    provision(policy, dir).map_err(|error| {
        let code = match error.as_str() {
            "KEYRING_ACCESS_FAILED" => "KEYRING_ACCESS_FAILED",
            "KEYRING_WRITE_FAILED" => "KEYRING_WRITE_FAILED",
            "KEY_FILE_UNAVAILABLE" => "KEY_FILE_UNAVAILABLE",
            "CREDENTIAL_RESET_EXTERNAL_KEY" => "CREDENTIAL_RESET_EXTERNAL_KEY",
            "CREDENTIAL_RESET_KEY_CHANGED" => "CREDENTIAL_RESET_KEY_CHANGED",
            "CREDENTIAL_RESET_KEY_VERIFICATION_FAILED" => "CREDENTIAL_RESET_KEY_VERIFICATION_FAILED",
            _ => "CREDENTIAL_RESET_KEY_FAILED",
        };
        fail(code, "key")
    })?;
    tx.commit().map_err(|_| fail("CREDENTIAL_RESET_DATABASE_FAILED", "database"))?;
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::secret_codec::managed_key_path;

    async fn missing_key_storage() -> (tempfile::TempDir, Storage) {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&dir.path().join("dbx.db"))
            .await
            .unwrap()
            .with_desktop_credential_recovery();
        storage.set_secret("connection", "password", "original-secret").await.unwrap();
        storage.set_secret("ai_config.provider", "config", "{\"apiKey\":\"original\"}").await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute_batch(
                    "CREATE TABLE reset_preserved (value TEXT); INSERT INTO reset_preserved VALUES ('history/config');",
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .await
            .unwrap();
        storage.set_migration_state(MigrationState::Succeeded, None, None, None, None).await.unwrap();
        std::fs::remove_file(managed_key_path(dir.path())).unwrap();
        storage.invalidate_secret_codec();
        (dir, storage)
    }

    async fn snapshot(storage: &Storage) -> String {
        storage.with_conn(|conn| database_fingerprint(conn)).await.unwrap()
    }

    #[tokio::test]
    async fn credential_reset_backs_up_ciphertext_and_preserves_nonsecret_data() {
        let (dir, storage) = missing_key_storage().await;
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        assert_eq!(prep.encrypted_record_count, 2);
        assert!(!managed_key_path(dir.path()).exists());
        assert_eq!(before, snapshot(&storage).await, "prepare must be read-only");
        let report = storage.reset_credentials(prep.confirmation_token.clone(), true).await.unwrap();
        assert_eq!(report.cleared_record_count, 2);
        assert_eq!(report.state, MigrationState::Succeeded);
        let backup = Connection::open_with_flags(
            Path::new(&report.backup_path).join("dbx.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(database_fingerprint(&backup).unwrap(), before);
        assert_eq!(encrypted_count(&backup).unwrap(), 2);
        assert_eq!(
            storage
                .with_conn(|conn| conn
                    .query_row("SELECT value FROM reset_preserved", [], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string()))
                .await
                .unwrap(),
            "history/config"
        );
        assert!(storage.inspect_data_migration().await.unwrap().is_ready());
        assert!(storage.reset_credentials(prep.confirmation_token, true).await.is_err());
        storage.set_secret("connection", "password", "replacement").await.unwrap();
        let reopened = crate::persistence::test_storage::open_unmigrated(&dir.path().join("dbx.db")).await.unwrap();
        assert_eq!(reopened.get_secret("connection", "password").await.unwrap().as_deref(), Some("replacement"));
        storage.cleanup_migration_backups().await.unwrap();
        assert!(
            Path::new(&report.backup_path).join("dbx.db").exists(),
            "migration cleanup must not remove recovery snapshots"
        );
    }

    #[tokio::test]
    async fn credential_reset_requires_current_explicit_single_use_confirmation() {
        let (_dir, storage) = missing_key_storage().await;
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        assert_eq!(storage.reset_credentials(prep.confirmation_token, false).await.unwrap_err().stage, "confirmation");
        let prep = storage.prepare_credential_reset().await.unwrap();
        storage.credential_reset_confirmation.lock().unwrap().as_mut().unwrap().created =
            Instant::now() - Duration::from_secs(601);
        assert_eq!(storage.reset_credentials(prep.confirmation_token, true).await.unwrap_err().stage, "confirmation");
        let prep = storage.prepare_credential_reset().await.unwrap();
        assert!(storage.reset_credentials("wrong-token".into(), true).await.is_err());
        assert!(storage.reset_credentials(prep.confirmation_token, true).await.is_err());
        assert_eq!(before, snapshot(&storage).await);
    }

    #[tokio::test]
    async fn credential_reset_rejects_changed_data_and_restored_key() {
        let (dir, storage) = missing_key_storage().await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute("INSERT INTO reset_preserved VALUES ('changed')", [])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap();
        let changed = snapshot(&storage).await;
        assert_eq!(
            storage.reset_credentials(prep.confirmation_token, true).await.unwrap_err().code,
            "CREDENTIAL_RESET_DATA_CHANGED"
        );
        assert_eq!(changed, snapshot(&storage).await);
        let prep = storage.prepare_credential_reset().await.unwrap();
        SecretCodec::resolve(SecretKeyPolicy::TestDataDir, dir.path(), true).unwrap();
        assert_eq!(
            storage.reset_credentials(prep.confirmation_token, true).await.unwrap_err().code,
            "CREDENTIAL_RESET_KEY_NOT_MISSING"
        );
        assert_eq!(changed, snapshot(&storage).await);
    }

    #[tokio::test]
    async fn credential_reset_rolls_back_when_key_provisioning_fails() {
        let (_dir, storage) = missing_key_storage().await;
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        let error = storage
            .reset_credentials_with(prep.confirmation_token, true, |_, _| Err("KEYRING_WRITE_FAILED".into()))
            .await
            .unwrap_err();
        assert_eq!(error.stage, "key");
        assert_eq!(error.code, "KEYRING_WRITE_FAILED");
        assert!(Path::new(error.backup_path.as_deref().unwrap()).join("dbx.db").is_file());
        assert_eq!(before, snapshot(&storage).await);
        assert!(storage.inspect_data_migration().await.unwrap().key_recovery_required);
    }

    #[tokio::test]
    async fn credential_reset_rolls_back_on_database_failure_without_creating_key() {
        let (dir, storage) = missing_key_storage().await;
        storage.with_conn(|conn| conn.execute_batch("CREATE TRIGGER reset_reject_delete BEFORE DELETE ON connection_secrets BEGIN SELECT RAISE(ABORT, 'injected'); END;").map_err(|e| e.to_string())).await.unwrap();
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        let error = storage.reset_credentials(prep.confirmation_token, true).await.unwrap_err();
        assert_eq!(error.stage, "database");
        assert_eq!(before, snapshot(&storage).await);
        assert!(!managed_key_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn credential_reset_remains_disabled_outside_completed_desktop_missing_key_case() {
        let (_dir, mut storage) = missing_key_storage().await;
        storage.desktop_credential_recovery = false;
        assert!(!storage.inspect_data_migration().await.unwrap().credential_reset_allowed);
        assert!(storage.prepare_credential_reset().await.is_err());
        storage.desktop_credential_recovery = true;
        storage.secret_key_creation_allowed = false;
        assert!(storage.prepare_credential_reset().await.is_err());
        storage.secret_key_creation_allowed = true;
        storage.set_migration_state(MigrationState::Running, None, None, None, None).await.unwrap();
        assert!(storage.prepare_credential_reset().await.is_err());
        storage.set_migration_state(MigrationState::Succeeded, None, None, None, None).await.unwrap();
        let mut status = storage.inspect_data_migration().await.unwrap();
        assert!(status.credential_reset_allowed);
        for code in ["SECRET_KEY_INVALID", "SECRET_KEY_MISMATCH", "KEYRING_ACCESS_FAILED", "KEY_FILE_UNAVAILABLE"] {
            status.error_code = Some(code.into());
            assert!(storage.credential_reset_blocked_reason(&status).is_some());
        }
        storage.secret_key_policy = SecretKeyPolicy::ExternalOnly;
        assert!(storage.prepare_credential_reset().await.is_err());
        #[cfg(not(target_os = "windows"))]
        {
            storage.secret_key_policy = SecretKeyPolicy::PlatformDefault;
            assert!(storage.prepare_credential_reset().await.is_err());
        }
    }
    #[tokio::test]
    async fn credential_reset_preserves_completed_migration_with_running_backup() {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&dir.path().join("dbx.db"))
            .await
            .unwrap()
            .with_desktop_credential_recovery();
        storage.set_secret("connection", "password", "original").await.unwrap();
        storage.set_migration_state(MigrationState::Running, None, None, None, None).await.unwrap();
        let backup = storage.create_migration_backup().await.unwrap();
        storage.set_migration_state(MigrationState::Succeeded, Some(&backup), None, None, None).await.unwrap();
        let original_key = std::fs::read(managed_key_path(dir.path())).unwrap();
        assert!(storage.inspect_data_migration().await.unwrap().is_ready());
        let backup_db = Connection::open(Path::new(&backup).join("dbx.db")).unwrap();
        let state: String = backup_db
            .query_row("SELECT state FROM data_migrations WHERE migration_id = ?1", [SECRET_STORE_MIGRATION_ID], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(state, "running");
        std::fs::remove_file(managed_key_path(dir.path())).unwrap();
        let prep = storage.prepare_credential_reset().await.unwrap();
        std::fs::write(managed_key_path(dir.path()), original_key).unwrap();
        assert!(storage.reset_credentials(prep.confirmation_token, true).await.is_err());
        assert!(storage.retry_data_migration_inspection().await.unwrap().is_ready());
        assert_eq!(storage.get_secret("connection", "password").await.unwrap().as_deref(), Some("original"));
        assert!(Path::new(&backup).exists());
    }

    #[tokio::test]
    async fn credential_reset_rolls_back_trigger_side_effects() {
        let (_dir, storage) = missing_key_storage().await;
        storage.with_conn(|conn| conn.execute_batch("CREATE TRIGGER reset_side_effect AFTER DELETE ON connection_secrets BEGIN DELETE FROM reset_preserved; END;").map_err(|e| e.to_string())).await.unwrap();
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        let error = storage.reset_credentials(prep.confirmation_token, true).await.unwrap_err();
        assert_eq!(error.code, "CREDENTIAL_RESET_DATA_CHANGED");
        assert_eq!(before, snapshot(&storage).await);
    }

    #[tokio::test]
    async fn credential_reset_keeps_backup_and_original_rows_after_key_created_then_failure() {
        let (dir, storage) = missing_key_storage().await;
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        let error = storage
            .reset_credentials_with(prep.confirmation_token, true, |policy, path| {
                SecretCodec::create_credential_recovery_key(policy, path)?;
                Err("CREDENTIAL_RESET_KEY_VERIFICATION_FAILED".into())
            })
            .await
            .unwrap_err();
        assert_eq!(error.stage, "key");
        assert_eq!(before, snapshot(&storage).await);
        assert!(managed_key_path(dir.path()).exists());
        assert!(Path::new(error.backup_path.as_deref().unwrap()).join("dbx.db").is_file());
        // The new key must not be treated as recovery of the original key.
        assert!(!storage.inspect_data_migration().await.unwrap().is_ready());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn credential_reset_backup_failure_never_removes_rows() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, storage) = missing_key_storage().await;
        // Ensure taking the existing migration lock needs no directory write.
        drop(storage.lock_data_migration().unwrap());
        let before = snapshot(&storage).await;
        let prep = storage.prepare_credential_reset().await.unwrap();
        let permissions = std::fs::metadata(dir.path()).unwrap().permissions();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = storage.reset_credentials(prep.confirmation_token, true).await;
        std::fs::set_permissions(dir.path(), permissions).unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "CREDENTIAL_RESET_BACKUP_FAILED");
        assert_eq!(before, snapshot(&storage).await);
        assert!(!managed_key_path(dir.path()).exists());
    }
}
