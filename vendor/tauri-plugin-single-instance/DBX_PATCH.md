# DBX profile-scoped single instance

Based on crates.io `tauri-plugin-single-instance` 2.4.3, licensed Apache-2.0 OR MIT.

Adds the optional `Builder::secret` ASCII-alphanumeric suffix to the existing Windows mutex/window names, Linux D-Bus name/path, and macOS Unix socket. The application bundle identifier, callback protocol, and no-secret behavior remain unchanged. macOS retains the selected socket in managed state for cleanup.

DBX supplies a 128-bit SHA-256 directory digest, keeping socket paths short and filesystem paths out of global endpoint names. The directory is created and canonicalized before the lock is initialized. This is a namespace discriminator, not an authentication credential.
