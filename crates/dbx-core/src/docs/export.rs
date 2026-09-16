use base64::Engine as _;

use crate::docs::annotations::AnnotationFile;
use crate::docs::snapshot::SchemaSnapshot;

/// The viewer bundle, built by `pnpm build:docs-export` and committed.
///
/// Committed rather than built by cargo because Rust cannot run Vite and
/// `dbx docs` must work from a plain `cargo install` on a machine with no
/// Node. `docs_export_bundle_is_current` is what keeps it honest.
const EXPORT_JS: &str = include_str!("../../assets/docs-export.js");
const EXPORT_CSS: &str = include_str!("../../assets/docs-export.css");

pub const EXPORT_LANGUAGES: [&str; 8] = ["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"];

/// Render a snapshot as one self-contained HTML file.
///
/// `snapshot` must already have annotations applied — `apply_annotations` is
/// Rust and the export has no Rust at runtime. `annotations` travels too,
/// because the merge erases what the viewer needs to colour groups:
/// `snapshot.groups` holds resolved `TableGroup`s, `annotations.groups` holds
/// the hue.
pub fn to_standalone_html(
    snapshot: &SchemaSnapshot,
    annotations: &AnnotationFile,
    lang: &str,
) -> Result<String, String> {
    if !EXPORT_LANGUAGES.contains(&lang) {
        return Err(format!("Unknown language \"{lang}\". Valid values: {}.", EXPORT_LANGUAGES.join(", ")));
    }

    let payload = serde_json::json!({ "snapshot": snapshot, "annotations": annotations, "lang": lang });
    let json = serde_json::to_vec(&payload)
        .map_err(|error| format!("Failed to serialise the documentation payload: {error}"))?;
    // base64 rather than escaped JSON: the alphabet cannot contain `<`, so no
    // escaping rule exists to forget. The alternative's correctness depends
    // on every serialisation path applying the escape.
    let encoded = base64::engine::general_purpose::STANDARD.encode(&json);

    let title = html_escape(&snapshot.project.name);
    Ok(format!(
        "<!doctype html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{title}</title>\n<style>{EXPORT_CSS}</style>\n</head>\n<body>\n<div id=\"app\"></div>\n<script type=\"application/dbx-snapshot\">{encoded}</script>\n<script>{EXPORT_JS}</script>\n</body>\n</html>\n"
    ))
}

fn html_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::annotations::AnnotationFile;
    use crate::docs::snapshot::SchemaSnapshot;

    /// `SchemaSnapshot` is `#[serde(rename_all = "camelCase")]` with
    /// `format_version` at the TOP level — not inside `project` — and
    /// `ProjectMeta` requires `name`, `databaseType`, `schemas` and
    /// `generatedAt`. `AnnotationFile` does NOT derive `Default`, and its
    /// `format_version` must be 1, so it is built explicitly.
    fn fixture() -> (SchemaSnapshot, AnnotationFile) {
        let snapshot: SchemaSnapshot = serde_json::from_str(
            r#"{"formatVersion":1,"project":{"name":"shop","databaseType":"postgres","database":"shop","schemas":["public"],"generatedAt":"2026-08-06T00:00:00Z","note":null},"tables":[],"enums":[],"relationships":[],"groups":[],"warnings":[]}"#,
        )
        .expect("fixture snapshot");
        let annotations = AnnotationFile {
            format_version: 1,
            project: None,
            groups: Vec::new(),
            tables: std::collections::BTreeMap::new(),
        };
        (snapshot, annotations)
    }

    #[test]
    fn a_note_containing_a_closing_script_tag_survives() {
        // THE reason the payload is base64. A note discussing HTML is
        // entirely plausible in a schema document, and inlined as text it
        // would terminate the script element early and inject the rest of
        // the payload as markup.
        let (snapshot, mut annotations) = fixture();
        annotations.project = Some(crate::docs::annotations::ProjectAnnotation {
            name: None,
            note: Some("</script><img src=x onerror=alert(1)>".into()),
        });
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");

        assert!(!html.contains("<img src=x"), "the payload leaked into markup");
        assert_eq!(html.matches("</script>").count(), 2, "exactly the two real script elements");
    }

    #[test]
    fn the_payload_round_trips() {
        let (snapshot, annotations) = fixture();
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");
        let start = html.find("application/dbx-snapshot").expect("payload element");
        let body = &html[start..];
        let encoded = body[body.find('>').unwrap() + 1..body.find("</script>").unwrap()].trim();
        let decoded =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).expect("valid base64");
        let value: serde_json::Value = serde_json::from_slice(&decoded).expect("valid json");
        assert_eq!(value["snapshot"]["project"]["name"], "shop");
        assert_eq!(value["lang"], "en");
    }

    #[test]
    fn the_shell_and_stylesheet_reference_no_external_resources() {
        // This test's reach stops at the hand-authored shell and the
        // bundled CSS's `url(...)` references — it does not scan EXPORT_JS
        // for network calls. A substring scan of the bundle can't prove
        // that: it legitimately contains the literal `http://` four times
        // (three SVG/MathML/xlink XML namespace URIs passed to
        // `createElementNS`, one inside the markdown autolinker building an
        // href for `www.`-prefixed text), none of which are fetched. The
        // bundle's purity is covered on the viewer side instead:
        // `componentContract.spec.ts` forbids `fetch(`, `axios` and
        // `invoke(` in every viewer source, and the manifest guard ties the
        // committed bundle to those sources.
        let (snapshot, annotations) = fixture();
        let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");

        // 1. Every `url(...)` in the emitted stylesheet must be a `data:`
        //    URI — an allowlist of the one legitimate scheme, not a
        //    blocklist of bad ones, so a new absolute font or image url()
        //    fails without anyone having to extend a list. The match is
        //    case-insensitive because CSS's `url()` function name is
        //    case-insensitive per spec (`URL(...)` is legal); an ASCII-only
        //    bundle makes a byte-wise check safe here.
        fn find_url_ci(s: &str, from: usize) -> Option<usize> {
            let bytes = s.as_bytes();
            (from..bytes.len().saturating_sub(3)).find(|&i| bytes[i..i + 4].eq_ignore_ascii_case(b"url("))
        }

        let style_start = html.find("<style>").expect("style element") + "<style>".len();
        let style_end = html.find("</style>").expect("style element closes");
        let style = &html[style_start..style_end];
        let mut cursor = 0;
        let mut url_count = 0;
        while let Some(pos) = find_url_ci(style, cursor) {
            let rest = &style[pos + "url(".len()..];
            let end = rest.find(')').expect("unterminated url(");
            let value = rest[..end].trim().trim_matches('\'').trim_matches('"');
            assert!(value.starts_with("data:"), "stylesheet references a non-data url(): {value}");
            url_count += 1;
            cursor = pos + "url(".len() + end + 1;
        }
        // A scan that finds nothing hasn't verified anything — today the
        // font is inlined via exactly one `url()`, so zero would mean the
        // build stopped inlining it, not that there is nothing left to check.
        assert!(url_count >= 1, "found no url(...) in the stylesheet — the scan above verified nothing");

        // 2. The hand-authored shell — the document with the bundle's own
        //    CSS, JS, and the base64 payload removed — must contain no
        //    `src=` or `href=` at all. Checked against the shell alone so
        //    neither the bundle's contents nor the payload can influence
        //    the result.
        let payload_start = html.find("application/dbx-snapshot").expect("payload element");
        let payload_body = &html[payload_start..];
        let encoded = payload_body[payload_body.find('>').unwrap() + 1..payload_body.find("</script>").unwrap()].trim();
        let shell = html.replace(EXPORT_CSS, "").replace(EXPORT_JS, "").replace(encoded, "");
        assert!(!shell.contains("src="), "the shell references an external src");
        assert!(!shell.contains("href="), "the shell references an external href");
    }

    #[test]
    fn an_unknown_language_is_rejected() {
        let (snapshot, annotations) = fixture();
        let error = to_standalone_html(&snapshot, &annotations, "kl").expect_err("should reject");
        assert!(error.contains("kl"), "got: {error}");
        assert!(error.contains("en"), "the error must list the valid locales, got: {error}");
    }

    /// The committed bundle must match the sources it was built from.
    ///
    /// Skips only when the crate is consumed from a published package, where
    /// `apps/desktop/` does not exist. That skip is itself a hazard — a
    /// vacuous skip in CI would silently disable this guard — so it keys off
    /// a repository-only marker rather than off the absence of the sources.
    #[test]
    fn docs_export_bundle_is_current() {
        use sha2::{Digest, Sha256};

        let workspace =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("workspace root");
        if !workspace.join("pnpm-workspace.yaml").exists() {
            return; // packaged crate: the sources are genuinely absent
        }

        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../assets/docs-export.manifest.json"))
            .expect("manifest is valid JSON");
        let sources = manifest["sources"].as_object().expect("manifest.sources");
        assert!(sources.len() > 5, "manifest lists only {} sources — the build emitted an empty graph", sources.len());

        let mut stale = Vec::new();
        for (relative, expected) in sources {
            let path = workspace.join(relative);
            let Ok(bytes) = std::fs::read(&path) else {
                stale.push(format!("{relative} (missing)"));
                continue;
            };
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if actual != expected.as_str().unwrap_or_default() {
                stale.push(relative.clone());
            }
        }

        assert!(
            stale.is_empty(),
            "the committed docs export bundle is stale.\nChanged: {}\nRun: pnpm build:docs-export",
            stale.join(", ")
        );
    }

    /// `EXPORT_JS` is interpolated into `<script>{EXPORT_JS}</script>` raw —
    /// unlike the base64 payload, nothing escapes it. That is safe against a
    /// literal `</script>` (asserted above), but the HTML tokenizer has two
    /// more states that can hide one: inside a `<script>` element, a literal
    /// `<!--` switches it to script-data-escaped, and a `<script` seen while
    /// in that state switches it again to script-data-double-escaped — where
    /// `</script>` no longer closes the element. Both sequences exist in
    /// EXPORT_JS today (third-party minified output) and are safe only
    /// because every `<!--` is closed by a `-->` before the next `<script`.
    /// This pins that ordering so a dependency bump can't silently trade it
    /// away and swallow the real closing tag, leaving the reader a blank
    /// page. Deliberately not a full tokenizer: it only checks the ordering
    /// the double-escape trap actually depends on.
    #[test]
    fn embedded_export_js_closes_every_comment_before_the_next_script_tag() {
        let lower = EXPORT_JS.to_ascii_lowercase();
        let mut pos = 0;
        while let Some(open_rel) = lower[pos..].find("<!--") {
            let open = pos + open_rel;
            let close = lower[open..].find("-->").map(|offset| open + offset);
            let next_script = lower[open..].find("<script").map(|offset| open + offset);
            match (close, next_script) {
                (Some(close), Some(script)) => assert!(
                    close < script,
                    "an unmatched <!-- at byte {open} precedes a <script at byte {script} \
                     before its --> closes — this would trap the browser in \
                     script-data-double-escaped state and swallow our own closing </script>"
                ),
                (None, Some(script)) => panic!(
                    "an unclosed <!-- at byte {open} precedes a <script at byte {script} \
                     with no matching --> anywhere after it"
                ),
                (Some(_), None) | (None, None) => {}
            }
            pos = open + "<!--".len();
        }
    }

    /// Tailwind v4 generates utility classes like `bg-background` from the
    /// `--color-*` entries inside an `@theme` block (in `tokens.css`), not
    /// from raw custom properties. If that block were lost, the build would
    /// still succeed and emit a stylesheet — just one with no utilities in
    /// it — and the export would render completely unstyled while every
    /// other test here passed. Nothing else in this file guards it.
    #[test]
    fn the_stylesheet_carries_resolved_utilities() {
        assert!(
            EXPORT_CSS.contains(".bg-background{background-color:var("),
            "the stylesheet is missing a resolved `.bg-background` utility — \
             `@theme` in tokens.css may have been lost, or the token it \
             resolves through is gone"
        );

        // `@custom-variant dark` — its failure is invisible in light mode,
        // where the export would look correct right up until dark mode
        // shipped unstyled.
        assert!(
            EXPORT_CSS.contains(":is(.dark *)"),
            "the stylesheet has no `:is(.dark *)` selector — the dark variant \
             may have been lost; this would ship undetected because light \
             mode looks fine"
        );
    }
}
