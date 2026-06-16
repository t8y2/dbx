//! Shared utilities for the message queue admin module.

/// Truncate a string to `max` bytes, respecting UTF-8 char boundaries, and
/// append an ellipsis when truncation occurs.
pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_long_string_adds_ellipsis() {
        let result = truncate("abcdefghij", 5);
        assert_eq!(result, "abcde…");
    }

    #[test]
    fn truncate_handles_multibyte_utf8_boundary() {
        let body = format!("a{}", "错".repeat(100));
        let truncated = truncate(&body, 10);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() <= 10 + "…".len());
    }
}
