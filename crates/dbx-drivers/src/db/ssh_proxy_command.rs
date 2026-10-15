//! Executing an OpenSSH-style `ProxyCommand` for an SSH tunnel.
//!
//! Only a small allowlist of transport helpers may be spawned: the SSH config
//! (and a shared tunnel profile) is data that can come from a cloned repo or a
//! synced profile, so running an arbitrary shell command from it would be a
//! code-execution footgun. The command is split into arguments ourselves (no
//! shell), which also means shell metacharacters cannot be used to chain extra
//! commands onto an allowlisted binary.
//!
//! Tokens `%h` (host), `%p` (port), `%r` (remote user) and `%%` are expanded
//! from the effective SSH endpoint before the program starts. `%n` (the
//! original host alias) is not available once the host has been resolved, so
//! it expands to the same value as `%h` — prefer `%h` in new configs.

use std::process::Stdio;
#[cfg(any(target_os = "macos", test))]
use std::{ffi::OsStr, io, path::Path};

use tokio::io::{AsyncReadExt, Join};
use tokio::process::{ChildStdin, ChildStdout, Command};

/// Transport helpers that a `ProxyCommand` may invoke. Compared against the
/// basename of the first argv token, case-insensitively, with a trailing
/// `.exe` ignored.
pub const ALLOWED_PROXY_COMMAND_BINARIES: &[&str] =
    &["nc", "ncat", "netcat", "cloudflared", "socat", "connect", "corkscrew", "ssh"];

/// Expands `%h`/`%p`/`%r`/`%n`/`%%` in a `ProxyCommand` template.
pub fn expand_proxy_command_tokens(command: &str, host: &str, port: u16, user: &str) -> String {
    let mut expanded = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        match chars.next() {
            Some('h') | Some('n') => expanded.push_str(host),
            Some('p') => expanded.push_str(&port.to_string()),
            Some('r') => expanded.push_str(user),
            Some('%') => expanded.push('%'),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    expanded
}

/// Splits a `ProxyCommand` into argv with POSIX-like quote handling: single
/// quotes are literal, double quotes allow `\` escapes, and a backslash
/// outside quotes escapes the next character.
pub fn parse_proxy_command_argv(command: &str) -> Result<Vec<String>, String> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut quote: Option<char> = None;
    let mut chars = command.chars();

    while let Some(ch) = chars.next() {
        match quote {
            Some(open) => {
                if ch == open {
                    quote = None;
                    has_token = true;
                } else if open == '"' && ch == '\\' {
                    if let Some(escaped) = chars.next() {
                        current.push(escaped);
                    }
                    has_token = true;
                } else {
                    current.push(ch);
                    has_token = true;
                }
            }
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                has_token = true;
            }
            None if ch == '\\' => {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                    has_token = true;
                }
            }
            None if ch.is_whitespace() => {
                if has_token {
                    argv.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            None => {
                current.push(ch);
                has_token = true;
            }
        }
    }

    if quote.is_some() {
        return Err("ProxyCommand has an unterminated quote".to_string());
    }
    if has_token {
        argv.push(current);
    }
    if argv.is_empty() {
        return Err("ProxyCommand is empty".to_string());
    }
    Ok(argv)
}

/// Returns `Ok(())` when the program is on the allowlist, otherwise a message
/// naming the allowed binaries.
pub fn validate_proxy_command_program(program: &str) -> Result<(), String> {
    let basename = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let basename = basename.strip_suffix(".exe").unwrap_or(basename);
    if ALLOWED_PROXY_COMMAND_BINARIES.iter().any(|allowed| allowed.eq_ignore_ascii_case(basename)) {
        return Ok(());
    }
    Err(format!(
        "ProxyCommand program '{program}' is not allowed; supported helpers: {}",
        ALLOWED_PROXY_COMMAND_BINARIES.join(", ")
    ))
}

#[cfg(any(target_os = "macos", test))]
fn homebrew_directories(arch: &str) -> [&'static str; 2] {
    if arch == "aarch64" {
        ["/opt/homebrew/bin", "/usr/local/bin"]
    } else {
        ["/usr/local/bin", "/opt/homebrew/bin"]
    }
}

#[cfg(any(target_os = "macos", test))]
fn spawn_with_homebrew_fallback<T>(
    program: &str,
    path: Option<&OsStr>,
    directories: &[&str; 2],
    mut spawn: impl FnMut(&Path) -> io::Result<T>,
    path_entry_exists: impl Fn(&Path) -> bool,
) -> Result<T, String> {
    let original_error = match spawn(Path::new(program)) {
        Ok(child) => return Ok(child),
        Err(error) => error,
    };
    let original_message = || format!("Failed to start ProxyCommand '{program}': {original_error}");

    // An explicit path, or any error other than NotFound, must retain its
    // original meaning. A PATH entry with a missing script interpreter can
    // also produce NotFound, so never replace that program with Homebrew's.
    if program.contains(['/', '\\']) || original_error.kind() != io::ErrorKind::NotFound {
        return Err(original_message());
    }
    if path.is_some_and(|path| std::env::split_paths(path).any(|directory| path_entry_exists(&directory.join(program))))
    {
        return Err(format!(
            "{}; a PATH entry exists, so check its executable or interpreter, or configure an explicit helper path",
            original_message()
        ));
    }

    for directory in directories {
        let candidate = Path::new(directory).join(program);
        match spawn(&candidate) {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Failed to start ProxyCommand '{}': {error}", candidate.display()));
            }
        }
    }
    Err(format!(
        "{}; configure ProxyCommand with the helper's absolute path if it is installed elsewhere",
        original_message()
    ))
}

/// Starts the `ProxyCommand` process and returns its stdin/stdout joined into
/// one duplex stream for the SSH handshake. The child is reaped in the
/// background; dropping the stream closes its stdin, which makes the usual
/// helpers (`nc`, `cloudflared`) exit.
pub fn spawn_proxy_command_stream(
    command: &str,
    host: &str,
    port: u16,
    user: &str,
) -> Result<Join<ChildStdout, ChildStdin>, String> {
    let expanded = expand_proxy_command_tokens(command, host, port, user);
    let argv = parse_proxy_command_argv(&expanded)?;
    let (program, args) = argv.split_first().expect("parse_proxy_command_argv never returns empty");
    validate_proxy_command_program(program)?;

    let spawn = |path: &std::path::Path| {
        Command::new(path).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
    };
    #[cfg(target_os = "macos")]
    let mut child = spawn_with_homebrew_fallback(
        program,
        std::env::var_os("PATH").as_deref(),
        &homebrew_directories(std::env::consts::ARCH),
        spawn,
        |path| path.symlink_metadata().is_ok(),
    )?;
    #[cfg(not(target_os = "macos"))]
    let mut child = spawn(std::path::Path::new(program))
        .map_err(|error| format!("Failed to start ProxyCommand '{program}': {error}"))?;

    let Some(stdout) = child.stdout.take() else {
        return Err("ProxyCommand stdout pipe is unavailable".to_string());
    };
    let Some(stdin) = child.stdin.take() else {
        return Err("ProxyCommand stdin pipe is unavailable".to_string());
    };
    let mut stderr = child.stderr.take();

    tokio::spawn(async move {
        if let Some(stderr) = stderr.as_mut() {
            let mut buffer = [0u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        log::debug!("ProxyCommand stderr: {}", String::from_utf8_lossy(&buffer[..read]).trim_end())
                    }
                }
            }
        }
        let _ = child.wait().await;
    });

    Ok(tokio::io::join(stdout, stdin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn test_path() -> std::ffi::OsString {
        std::env::join_paths(["/usr/bin", "/bin"]).unwrap()
    }

    fn not_found() -> io::Error {
        io::Error::from(io::ErrorKind::NotFound)
    }

    #[test]
    fn expands_host_port_and_user_tokens() {
        assert_eq!(expand_proxy_command_tokens("nc %h %p", "db.internal", 2222, "deploy"), "nc db.internal 2222");
        assert_eq!(expand_proxy_command_tokens("ssh -W %h:%p jump", "10.0.0.5", 22, "root"), "ssh -W 10.0.0.5:22 jump");
        assert_eq!(expand_proxy_command_tokens("run %% literal", "h", 1, "u"), "run % literal");
        assert_eq!(expand_proxy_command_tokens("user %r", "h", 1, "deploy"), "user deploy");
    }

    #[test]
    fn keeps_unknown_tokens_verbatim() {
        assert_eq!(expand_proxy_command_tokens("tool %z %h", "h", 1, "u"), "tool %z h");
    }

    #[test]
    fn parses_quoted_arguments() {
        assert_eq!(
            parse_proxy_command_argv("cloudflared access ssh --hostname db.internal").unwrap(),
            vec!["cloudflared", "access", "ssh", "--hostname", "db.internal"]
        );
        assert_eq!(parse_proxy_command_argv("tool 'a b' \"c d\"").unwrap(), vec!["tool", "a b", "c d"]);
        assert_eq!(parse_proxy_command_argv("tool a\\ b").unwrap(), vec!["tool", "a b"]);
    }

    #[test]
    fn rejects_unterminated_quotes() {
        assert!(parse_proxy_command_argv("tool 'oops").is_err());
    }

    #[test]
    fn allowlist_accepts_known_helpers_and_rejects_others() {
        assert!(validate_proxy_command_program("nc").is_ok());
        assert!(validate_proxy_command_program("/usr/bin/nc").is_ok());
        assert!(validate_proxy_command_program("cloudflared.exe").is_ok());
        assert!(validate_proxy_command_program("ssh").is_ok());
        let error = validate_proxy_command_program("/bin/sh").unwrap_err();
        assert!(error.contains("not allowed"), "{error}");
        assert!(error.contains("nc"), "{error}");
    }

    #[test]
    fn shell_metacharacters_are_not_executed() {
        // `;` is a plain argument character because we never involve a shell;
        // the allowlist still rejects non-helper programs.
        let argv = parse_proxy_command_argv("nc %h %p; rm -rf /").unwrap();
        assert_eq!(argv, vec!["nc", "%h", "%p;", "rm", "-rf", "/"]);
        assert!(validate_proxy_command_program(&argv[0]).is_ok());
    }

    #[test]
    fn homebrew_order_matches_build_architecture() {
        assert_eq!(homebrew_directories("aarch64"), ["/opt/homebrew/bin", "/usr/local/bin"]);
        assert_eq!(homebrew_directories("x86_64"), ["/usr/local/bin", "/opt/homebrew/bin"]);
    }

    #[test]
    fn original_path_wins_for_allowlisted_helpers() {
        for program in ["socat", "cloudflared"] {
            validate_proxy_command_program(program).unwrap();
            let attempts = RefCell::new(Vec::new());
            let path = test_path();
            let result = spawn_with_homebrew_fallback(
                program,
                Some(&path),
                &homebrew_directories("aarch64"),
                |candidate| {
                    attempts.borrow_mut().push(candidate.to_path_buf());
                    Ok(())
                },
                |_| false,
            );
            assert!(result.is_ok());
            assert_eq!(*attempts.borrow(), [Path::new(program)]);
        }
        assert!(validate_proxy_command_program("sh").is_err());
    }

    #[test]
    fn not_found_falls_back_to_both_homebrew_directories() {
        let path = test_path();
        let attempts = RefCell::new(Vec::new());
        let result = spawn_with_homebrew_fallback(
            "socat",
            Some(&path),
            &homebrew_directories("aarch64"),
            |candidate| {
                attempts.borrow_mut().push(candidate.to_path_buf());
                if candidate == Path::new("/usr/local/bin/socat") {
                    Ok(())
                } else {
                    Err(not_found())
                }
            },
            |_| false,
        );
        assert!(result.is_ok());
        assert_eq!(
            *attempts.borrow(),
            [Path::new("socat"), Path::new("/opt/homebrew/bin/socat"), Path::new("/usr/local/bin/socat")]
        );
    }

    #[test]
    fn missing_path_still_tries_homebrew_directories() {
        let attempts = RefCell::new(Vec::new());
        let result = spawn_with_homebrew_fallback(
            "cloudflared",
            None,
            &homebrew_directories("aarch64"),
            |candidate| {
                attempts.borrow_mut().push(candidate.to_path_buf());
                if candidate == Path::new("/opt/homebrew/bin/cloudflared") {
                    Ok(())
                } else {
                    Err(not_found())
                }
            },
            |_| panic!("an absent PATH has no entries to probe"),
        );
        assert!(result.is_ok());
        assert_eq!(*attempts.borrow(), [Path::new("cloudflared"), Path::new("/opt/homebrew/bin/cloudflared")]);
    }

    #[test]
    fn explicit_paths_and_non_not_found_errors_do_not_fall_back() {
        let path = test_path();
        for program in ["/custom/bin/socat", "./socat", "tools/cloudflared"] {
            validate_proxy_command_program(program).unwrap();
            let attempts = RefCell::new(Vec::new());
            let error = spawn_with_homebrew_fallback::<()>(
                program,
                Some(&path),
                &homebrew_directories("aarch64"),
                |candidate| {
                    attempts.borrow_mut().push(candidate.to_path_buf());
                    Err(not_found())
                },
                |_| false,
            )
            .unwrap_err();
            assert_eq!(*attempts.borrow(), [Path::new(program)]);
            assert!(error.contains(program));
        }
        let attempts = RefCell::new(Vec::new());
        let error = spawn_with_homebrew_fallback::<()>(
            "socat",
            Some(&path),
            &homebrew_directories("aarch64"),
            |candidate| {
                attempts.borrow_mut().push(candidate.to_path_buf());
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            },
            |_| false,
        )
        .unwrap_err();
        assert_eq!(*attempts.borrow(), [Path::new("socat")]);
        assert!(error.to_lowercase().contains("permission denied"));
    }

    #[test]
    fn existing_path_entry_with_missing_interpreter_is_not_overridden() {
        let path = test_path();
        let attempts = RefCell::new(Vec::new());
        let error = spawn_with_homebrew_fallback::<()>(
            "socat",
            Some(&path),
            &homebrew_directories("aarch64"),
            |candidate| {
                attempts.borrow_mut().push(candidate.to_path_buf());
                Err(not_found())
            },
            |candidate| candidate == Path::new("/usr/bin/socat"),
        )
        .unwrap_err();
        assert_eq!(*attempts.borrow(), [Path::new("socat")]);
        assert!(error.contains("interpreter"));
    }

    #[test]
    fn candidate_permission_error_names_attempted_path() {
        let path = test_path();
        let attempts = RefCell::new(Vec::new());
        let error = spawn_with_homebrew_fallback::<()>(
            "socat",
            Some(&path),
            &homebrew_directories("aarch64"),
            |candidate| {
                attempts.borrow_mut().push(candidate.to_path_buf());
                if candidate == Path::new("socat") {
                    Err(not_found())
                } else {
                    Err(io::Error::from(io::ErrorKind::PermissionDenied))
                }
            },
            |_| false,
        )
        .unwrap_err();
        assert_eq!(*attempts.borrow(), [Path::new("socat"), Path::new("/opt/homebrew/bin/socat")]);
        assert!(error.contains("/opt/homebrew/bin/socat"));
        assert!(error.to_lowercase().contains("permission denied"));
    }

    #[test]
    fn missing_candidates_offer_explicit_path_hint() {
        let path = test_path();
        let error = spawn_with_homebrew_fallback::<()>(
            "cloudflared",
            Some(&path),
            &homebrew_directories("x86_64"),
            |_| Err(not_found()),
            |_| false,
        )
        .unwrap_err();
        assert!(error.contains("ProxyCommand 'cloudflared'"));
        assert!(error.contains("absolute path"));
    }
}
