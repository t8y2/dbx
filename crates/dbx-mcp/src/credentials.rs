pub struct BackgroundCredentialGuard {
    #[cfg(all(target_os = "macos", feature = "os-keyring"))]
    _interaction: security_framework::os::macos::keychain::KeychainUserInteractionLock,
}

pub fn disable_background_interaction() -> Result<BackgroundCredentialGuard, String> {
    Ok(BackgroundCredentialGuard {
        #[cfg(all(target_os = "macos", feature = "os-keyring"))]
        _interaction: security_framework::os::macos::keychain::SecKeychain::disable_user_interaction().map_err(
            |error| format!("KEYRING_ACCESS_FAILED: cannot disable background Keychain interaction: {error}"),
        )?,
    })
}

pub fn startup_error(error: String) -> String {
    #[cfg(all(target_os = "macos", feature = "os-keyring"))]
    if error.contains("KEYRING_ACCESS_FAILED") {
        return format!(
            "{error} Unlock the user Keychain, then run the same official dbx-mcp executable with \
             --authorize-keychain once in a terminal and restart your MCP client. \
             Do not add that command to MCP client arguments."
        );
    }
    error
}

#[cfg(not(all(target_os = "macos", feature = "os-keyring")))]
pub fn authorize_keychain() -> Result<(), String> {
    Err("KEYCHAIN_AUTHORIZATION_UNSUPPORTED: this command requires an official macOS build with OS keyring support"
        .to_string())
}

#[cfg(all(target_os = "macos", feature = "os-keyring"))]
pub fn authorize_keychain() -> Result<(), String> {
    use security_framework::os::macos::{
        code_signing::{Flags, SecCode, SecRequirement},
        keychain::{SecKeychain, SecPreferencesDomain},
        passwords::find_generic_password,
    };

    let untrusted = |error| format!("KEYCHAIN_AUTHORIZATION_UNTRUSTED: {error}");
    let requirement: SecRequirement = RELEASE_REQUIREMENT.parse().map_err(|error| untrusted(format!("{error}")))?;
    // Validate the running code, not just a possibly replaced file at its path.
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::STRICT_VALIDATE, &requirement))
        .map_err(|error| untrusted(format!("expected the official DBX Developer ID identity: {error}")))?;
    let executable = std::env::current_exe().map_err(|error| untrusted(format!("{error}")))?;
    let signature = std::process::Command::new("/usr/bin/codesign")
        .args(["--display", "--verbose=4", "--requirements", "-"])
        .arg(executable)
        .output()
        .map_err(|error| untrusted(format!("cannot inspect signing identity: {error}")))?;
    if !signature.status.success() {
        return Err(untrusted("cannot inspect signing identity".to_string()));
    }
    let info =
        format!("{}\n{}", String::from_utf8_lossy(&signature.stdout), String::from_utf8_lossy(&signature.stderr));
    validate_signature_info(&info).map_err(|error| untrusted(error.to_string()))?;

    // Match keyring's User-domain lookup exactly; never authorize a same-name
    // item from another keychain, provision a new key, or rewrite an ACL.
    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|error| format!("KEYRING_ACCESS_FAILED: cannot open the user Keychain: {error}"))?;
    let (_password, _item) =
        find_generic_password(Some(&[keychain]), "com.dbx.app.secret-store.v1", "local-data-encryption-key").map_err(
            |error| {
                if error.code() == -25300 {
                    "SECRET_KEY_UNAVAILABLE: no existing DBX Keychain key; use Desktop data-security setup".to_string()
                } else {
                    format!("KEYRING_ACCESS_FAILED: existing DBX Keychain key cannot be authorized: {error}")
                }
            },
        )?;
    Ok(())
}

#[cfg(any(all(target_os = "macos", feature = "os-keyring"), test))]
const RELEASE_REQUIREMENT: &str = "identifier \"com.dbx.app.mcp\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"TVDM965TDL\"";

#[cfg(any(all(target_os = "macos", feature = "os-keyring"), test))]
fn validate_signature_info(info: &str) -> Result<(), &'static str> {
    let has_line = |expected| info.lines().any(|line| line == expected);
    if !has_line("Identifier=com.dbx.app.mcp")
        || !has_line("TeamIdentifier=TVDM965TDL")
        || has_line("Signature=adhoc")
        || !info
            .lines()
            .any(|line| line.strip_prefix("Timestamp=").is_some_and(|value| !value.is_empty() && value != "none"))
    {
        return Err("missing official release identity or secure timestamp");
    }
    let normalize = |value: &str| -> String {
        value.replace("/* exists */", "exists").chars().filter(|c| !c.is_whitespace() && *c != '"').collect()
    };
    let mut designated = info.lines().filter_map(|line| line.strip_prefix("designated => "));
    if !designated.next().is_some_and(|value| normalize(value) == normalize(RELEASE_REQUIREMENT))
        || designated.next().is_some()
    {
        return Err("a stable Developer ID designated requirement is required");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signature() -> String {
        format!(
            "Identifier=com.dbx.app.mcp\nTeamIdentifier=TVDM965TDL\nTimestamp=Oct 3, 2026\ndesignated => {}\n",
            RELEASE_REQUIREMENT.replace("exists", "/* exists */")
        )
    }

    #[test]
    fn accepts_the_stable_release_designated_requirement() {
        assert!(validate_signature_info(&signature()).is_ok());
    }

    #[test]
    fn rejects_unstable_or_incomplete_signatures() {
        let valid = signature();
        for invalid in [
            valid.replace("Identifier=com.dbx.app.mcp", "Identifier=com.dbx.other"),
            valid.replace("TeamIdentifier=TVDM965TDL", "TeamIdentifier=OTHERTEAM1"),
            valid.replace("Timestamp=Oct 3, 2026", "Timestamp=none"),
            valid.replace("Timestamp=Oct 3, 2026", "Timestamp="),
            valid.replace("Timestamp=Oct 3, 2026\n", ""),
            format!("{valid}Signature=adhoc\n"),
            valid.replace(&RELEASE_REQUIREMENT.replace("exists", "/* exists */"), "cdhash H\"abcd\""),
            valid.replace("designated => ", "missing => "),
            format!("{valid}designated => cdhash H\"abcd\"\n"),
        ] {
            assert!(validate_signature_info(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn startup_guidance_preserves_the_provider_error() {
        let error = "SECRET_KEY_UNAVAILABLE: KEYRING_ACCESS_FAILED".to_string();
        let result = startup_error(error.clone());
        assert!(result.starts_with(&error));
        assert_eq!(result.contains("--authorize-keychain"), cfg!(all(target_os = "macos", feature = "os-keyring")));
        assert_eq!(startup_error("DATA_MIGRATION_REQUIRED".to_string()), "DATA_MIGRATION_REQUIRED");
    }

    #[cfg(not(all(target_os = "macos", feature = "os-keyring")))]
    #[test]
    fn unsupported_platform_policy_does_not_attempt_keychain_authorization() {
        assert!(authorize_keychain().unwrap_err().starts_with("KEYCHAIN_AUTHORIZATION_UNSUPPORTED"));
        assert!(disable_background_interaction().is_ok());
    }
}
