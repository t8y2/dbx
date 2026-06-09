pub fn expand_tilde(path: &str) -> String {
    if !path.starts_with('~') {
        return path.to_string();
    }
    if path.len() == 1 {
        return home_dir().unwrap_or_else(|| path.to_string());
    }
    if path.as_bytes().get(1) == Some(&b'/') {
        return match home_dir() {
            Some(home) => home + &path[1..],
            None => path.to_string(),
        };
    }
    path.to_string()
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}
