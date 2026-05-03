# Config Export/Import

Export your database connections (with encrypted passwords) to migrate between machines.

## Export

1. Click the **Export** button (↓) in the sidebar header
2. Enter a passphrase to encrypt your passwords
3. Choose a save location
4. The exported file contains all connections with passwords, encrypted

## Import

1. Click the **Import** button (↑) in the sidebar header
2. Select the exported file
3. If encrypted, enter the passphrase
4. Connections are imported with passwords restored

## Security

- Passwords are encrypted using AES-256-GCM with PBKDF2 key derivation
- Without the passphrase, the file cannot be decrypted
- The export file is a standard JSON file that can be transferred via USB drive, cloud storage, etc.

## Backward Compatibility

Import also supports:
- Plain JSON files exported from older versions (without passwords)
- Raw connection config arrays

Connections are deduplicated by name + host + port during import.
