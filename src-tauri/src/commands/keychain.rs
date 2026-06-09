use std::process::Command;

/// Read a macOS Keychain generic password by service name.
/// Triggers a system authorization dialog (Touch ID / password) for each unique service.
#[tauri::command]
pub async fn read_keychain_password(service: String, account: Option<String>) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, account);
        return Err("Keychain access is only available on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("security");
        cmd.args(["find-generic-password", "-s", &service, "-w"]);
        if let Some(ref acct) = account {
            cmd.args(["-a", acct]);
        }

        let output = cmd.output().map_err(|e| format!("Failed to run security command: {e}"))?;

        if output.status.success() {
            let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(password)
        } else {
            // Exit code 44 = user cancelled the authorization dialog
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if output.status.code() == Some(44) || stderr.contains("User canceled") {
                Ok(String::new()) // Return empty instead of error for cancelled
            } else if stderr.contains("could not be found") || stderr.contains("The specified item could not be found")
            {
                Ok(String::new()) // No entry found — not an error
            } else {
                Err(format!("Keychain read failed: {}", stderr.trim()))
            }
        }
    }
}

/// Read multiple Keychain passwords in one call. Returns a map of service -> password.
/// Services that fail or are cancelled get an empty string.
#[tauri::command]
pub async fn read_keychain_passwords(services: Vec<String>) -> Result<Vec<(String, String)>, String> {
    let mut results = Vec::with_capacity(services.len());
    for service in services {
        let password = read_keychain_password(service.clone(), None).await.unwrap_or_default();
        results.push((service, password));
    }
    Ok(results)
}
