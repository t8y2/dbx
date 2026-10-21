//! Request the CSSColor4 implementation in the fixed WebView2 109 Win7 build.
//! Chromium 109 includes color-mix()/OKLCH behind the CSSColor4 Blink feature.
use std::ops::Range;

const FEATURE: &str = "CSSColor4";
const ENABLE: &str = "--enable-blink-features=";
const DISABLE: &str = "--disable-blink-features=";

// Keep every unrelated argument verbatim, including Windows paths and quoted
// values. Chromium uses the last occurrence of a repeated switch.
fn last_value(args: &str, switch: &str) -> Option<Range<usize>> {
    let bytes = args.as_bytes();
    let mut cursor = 0;
    let mut result = None;
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let mut start = cursor;
        let mut quoted = false;
        let mut slashes = 0;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if byte.is_ascii_whitespace() && !quoted {
                break;
            }
            if byte == b'"' && slashes % 2 == 0 {
                quoted = !quoted;
            }
            slashes = if byte == b'\\' { slashes + 1 } else { 0 };
            cursor += 1;
        }
        let mut end = cursor;
        if start == end || quoted {
            continue;
        }
        if bytes[start] == b'"' && bytes[end - 1] == b'"' {
            start += 1;
            end -= 1;
        }
        let token = &args[start..end];
        if !token.get(..switch.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(switch)) {
            continue;
        }
        start += switch.len();
        if end > start && bytes[start] == b'"' && bytes[end - 1] == b'"' {
            start += 1;
            end -= 1;
        }
        result = Some(start..end);
    }
    result
}

fn contains_feature(args: &str, switch: &str) -> bool {
    last_value(args, switch).is_some_and(|range| args[range].split(',').any(|name| name.trim() == FEATURE))
}

fn add_feature(args: &str, switch: &str) -> String {
    if contains_feature(args, switch) {
        return args.to_owned();
    }
    let mut updated = args.to_owned();
    if let Some(range) = last_value(args, switch) {
        let separator = if args[range.clone()].trim().is_empty() { "" } else { "," };
        updated.insert_str(range.end, &format!("{separator}{FEATURE}"));
    } else {
        if !updated.is_empty() && !updated.as_bytes().last().is_some_and(|byte| byte.is_ascii_whitespace()) {
            updated.push(' ');
        }
        updated.push_str(switch);
        updated.push_str(FEATURE);
    }
    updated
}

pub(crate) fn configure(args: &str, win7_build: bool, disabled: bool) -> String {
    if !win7_build {
        return args.to_owned();
    }
    if disabled {
        return add_feature(args, DISABLE);
    }
    if contains_feature(args, DISABLE) {
        return args.to_owned();
    }
    add_feature(args, ENABLE)
}

pub(crate) fn requested(args: &str) -> bool {
    contains_feature(args, ENABLE) && !contains_feature(args, DISABLE)
}

#[cfg(test)]
mod tests {
    use super::{configure, requested};

    #[test]
    fn only_requests_the_feature_for_the_win7_package() {
        assert_eq!(configure("", false, false), "");
        assert_eq!(configure("--disable-gpu", false, true), "--disable-gpu");
        assert_eq!(configure("", true, false), "--enable-blink-features=CSSColor4");
    }

    #[test]
    fn preserves_other_arguments_and_feature_names() {
        let args = r#"--user-agent="DBX test browser" --disable-gpu --enable-blink-features=FeatureA,FeatureB"#;
        assert_eq!(configure(args, true, false), format!("{args},CSSColor4"));
    }

    #[test]
    fn preserves_quoted_feature_lists() {
        for (args, expected) in [
            (
                r#"--enable-blink-features="FeatureA" --disable-gpu"#,
                r#"--enable-blink-features="FeatureA,CSSColor4" --disable-gpu"#,
            ),
            (r#""--enable-blink-features=FeatureA""#, r#""--enable-blink-features=FeatureA,CSSColor4""#),
            (r#"--enable-blink-features="""#, r#"--enable-blink-features="CSSColor4""#),
        ] {
            assert_eq!(configure(args, true, false), expected);
        }
    }

    #[test]
    fn does_not_duplicate_the_feature() {
        let args = "--enable-blink-features=FeatureA,CSSColor4";
        assert_eq!(configure(args, true, false), args);
        assert_eq!(configure(&configure(args, true, false), true, false), args);
    }

    #[test]
    fn updates_the_last_switch_without_reactivating_ignored_features() {
        let args = "--enable-blink-features=CSSColor4,Ignored --enable-blink-features=Active";
        assert_eq!(configure(args, true, false), format!("{args},CSSColor4"));
        assert!(!requested(args));
        assert!(requested(&configure(args, true, false)));
    }

    #[test]
    fn respects_an_explicit_disable_switch() {
        let args = "--enable-blink-features=FeatureA --disable-blink-features=CSSColor4,FeatureB";
        assert_eq!(configure(args, true, false), args);
        assert!(!requested(args));
    }

    #[test]
    fn opt_out_disables_the_feature_and_preserves_other_switches() {
        let args = "--enable-blink-features=CSSColor4,FeatureA --disable-blink-features=FeatureB";
        let disabled = configure(args, true, true);
        assert_eq!(disabled, format!("{args},CSSColor4"));
        assert!(!requested(&disabled));
        assert_eq!(configure(&disabled, true, true), disabled);
    }

    #[test]
    fn quoted_unrelated_arguments_do_not_look_like_switches() {
        let args = r#"--user-agent="test --enable-blink-features=Fake" --proxy-server="http://127.0.0.1:8080""#;
        assert_eq!(configure(args, true, false), format!("{args} --enable-blink-features=CSSColor4"));
    }
}
