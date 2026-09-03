pub fn expand_tilde(path: &str) -> String {
    expand_tilde_with(path, home_dir, named_user_home)
}

fn expand_tilde_with(
    path: &str,
    current_home: impl FnOnce() -> Option<String>,
    named_home: impl FnOnce(&str) -> Option<String>,
) -> String {
    if !path.starts_with('~') {
        return path.to_string();
    }
    if path.len() == 1 {
        return current_home().unwrap_or_else(|| path.to_string());
    }
    if path.as_bytes().get(1) == Some(&b'/') {
        return match current_home() {
            Some(home) => home + &path[1..],
            None => path.to_string(),
        };
    }

    let named_path = &path[1..];
    let (username, suffix) =
        named_path.find('/').map_or((named_path, ""), |index| (&named_path[..index], &named_path[index..]));

    named_home(username).map_or_else(|| path.to_string(), |home| home + suffix)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}

#[cfg(all(unix, not(target_os = "redox")))]
fn named_user_home(username: &str) -> Option<String> {
    nix::unistd::User::from_name(username).ok().flatten().and_then(|user| user.dir.into_os_string().into_string().ok())
}

#[cfg(any(not(unix), target_os = "redox"))]
fn named_user_home(_username: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::expand_tilde_with;

    fn no_named_user(_username: &str) -> Option<String> {
        None
    }

    #[test]
    fn preserves_paths_without_a_leading_tilde() {
        assert_eq!(
            expand_tilde_with(
                "relative/file",
                || panic!("ordinary paths must not resolve the current home"),
                |_| panic!("ordinary paths must not resolve a named home")
            ),
            "relative/file"
        );
        assert_eq!(
            expand_tilde_with(
                "/absolute/file",
                || panic!("ordinary paths must not resolve the current home"),
                |_| panic!("ordinary paths must not resolve a named home")
            ),
            "/absolute/file"
        );
    }

    #[test]
    fn expands_current_user_home_forms() {
        assert_eq!(expand_tilde_with("~", || Some("/home/current".into()), no_named_user), "/home/current");
        assert_eq!(
            expand_tilde_with(
                "~/.ssh/config",
                || Some("/home/current".into()),
                |_| panic!("current-user paths must not resolve a named home")
            ),
            "/home/current/.ssh/config"
        );
    }

    #[test]
    fn preserves_current_user_forms_when_home_is_unavailable() {
        assert_eq!(expand_tilde_with("~", || None, no_named_user), "~");
        assert_eq!(expand_tilde_with("~/.ssh/config", || None, no_named_user), "~/.ssh/config");
    }

    #[test]
    fn expands_named_user_home_forms() {
        let named_home = |username: &str| (username == "alice").then(|| "/Users/alice".to_string());

        assert_eq!(expand_tilde_with("~alice", || None, named_home), "/Users/alice");
        assert_eq!(expand_tilde_with("~alice/.ssh/agent.sock", || None, named_home), "/Users/alice/.ssh/agent.sock");
        assert_eq!(expand_tilde_with("~alice/", || None, named_home), "/Users/alice/");
    }

    #[test]
    fn preserves_unresolved_or_non_posix_named_user_forms() {
        assert_eq!(expand_tilde_with("~missing/.ssh/agent.sock", || None, no_named_user), "~missing/.ssh/agent.sock");
        assert_eq!(expand_tilde_with("~alice\\.ssh\\agent.sock", || None, no_named_user), "~alice\\.ssh\\agent.sock");
        assert_eq!(expand_tilde_with("~~/.ssh/agent.sock", || None, no_named_user), "~~/.ssh/agent.sock");
    }
}
