# Windows credential recovery acceptance check

Use a disposable Windows user profile and test data only. The platform key is
shared by DBX installations under that profile; do not remove credentials from
a real user's profile to reproduce this scenario.

1. Build the desktop app with its normal `os-keyring` feature. Save a test
   connection password and an AI API key, and complete `secret-store-v1`.
   Keep a copy of the original key using the test environment's credential
   tooling, and take a full test-data backup.
2. Remove only the test profile's DBX key, then restart. Verify the recovery
   heading, connection count and encrypted-record count. The count represents
   records, not necessarily individual passwords. The ordinary migration step
   indicator and “backup required: no” must not appear.
3. Restore the original key, click “Recheck key”, and verify both the UI and
   native startup gate release. Test the original credentials. Retained
   migration backup databases with `state=running` must not block startup.
4. Reproduce missing key again. Open the reset confirmation, cancel, and verify
   no records or key were changed. Reopen it; reset must be disabled until the
   acknowledgement is checked. Double clicking must submit only once.
5. Confirm reset. Verify a separate `dbx-credential-reset-*` directory contains
   a readable, integrity-checked pre-reset `dbx.db` and `reset.json`. The old
   encrypted records must still exist in that backup. The active database must
   retain connections, groups, history, SQL and `secret-store-v1=succeeded`.
6. Enter DBX, save replacement credentials, quit, restart and read them back.
   Verify the new key exists in Windows Credential Manager. Migration backup
   cleanup must not remove the credential-reset backup.
7. Repeat with a denied credential-store access, an incorrect existing key, a
   corrupt key and explicit `DBX_SECRET_KEY` / `DBX_SECRET_KEY_FILE` overrides.
   None may offer or accept reset. Missing key in a portable desktop profile
   should provision its managed key file, without changing the global key.
8. Fault checks: deny backup-directory creation; deny credential-store writes;
   change test data after confirmation; restore the key while the confirmation
   is open. Each must stop safely, preserve the original rows and display the
   classified error (and backup path if a backup was created).
9. Interrupt before transaction commit and after commit using a debugger.
   Before commit the original database rows must remain; after commit a fresh
   launch must read the new persistent key. If key creation succeeded but the
   transaction failed, retain that key and the old-data backup; the UI must not
   claim that old passwords were recovered.

Automated coverage uses an isolated managed-key provider for transaction,
backup, confirmation, rollback and restart behavior. It does not substitute for
these Windows native credential-store checks. Recovery backups retain old data,
but decrypting those old credentials still requires the original key.
