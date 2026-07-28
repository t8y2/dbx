//! Post-processing of MySQL `SHOW CREATE TABLE` DDL for database export.
//!
//! Two transforms, both applied to the table-options tail (the text after the
//! column list's closing `)`):
//! - **opt-in** strip of the table-level `AUTO_INCREMENT=N` clause. The value `N`
//!   is the source table's current sequence position — correct for the source
//!   DB, but noise (and misleading) in a fresh-install script.
//! - **always-on** rewrite of legacy `ROW_FORMAT=COMPACT|REDUNDANT` to
//!   `ROW_FORMAT=DYNAMIC`, for MySQL 8+ export compatibility.
//!
//! The options tail is parsed with [`winnow`] into structured `(key, value, span)`
//! records. Edits are applied to the *original* string by byte span, so every
//! byte that is not an edited option is preserved verbatim (parse-to-locate,
//! not re-serialize — no fidelity drift). Any parse failure **fails open**: the
//! original DDL is returned unchanged, because the correctness of exported DDL
//! matters more than this cosmetic option.
//!
//! Why winnow and not a regex: the value of `AUTO_INCREMENT`/`COMMENT` options
//! can contain the literal text `AUTO_INCREMENT=N` inside a quoted string (e.g.
//! `COMMENT='starts at AUTO_INCREMENT=1000'`). A quote-aware parser skips those
//! correctly; a blind regex cannot. winnow 1.x is already in the build graph
//! (transitively, via `toml_edit`), so adding it as a direct dependency compiles
//! no new code.

use std::ops::Range;

use winnow::ascii::multispace1;
use winnow::combinator::{alt, delimited, opt, preceded, repeat};
use winnow::prelude::*;
use winnow::stream::LocatingSlice;
use winnow::token::{none_of, take_till, take_until, take_while};
use winnow::ModalResult;

/// Knobs for [`normalize_mysql_export_ddl`].
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct DdlNormalizeOptions {
    /// When true, drop the table-level `AUTO_INCREMENT=N` option from the DDL.
    pub omit_auto_increment: bool,
}

/// One parsed MySQL table option, e.g. `ENGINE=InnoDB`, `AUTO_INCREMENT=121`,
/// `COMMENT='...'`, or a bare keyword such as `DEFAULT`.
#[derive(Debug, Clone)]
struct ParsedOption {
    /// Byte span of the option *core* (`KEY[=VALUE]`, excluding surrounding
    /// whitespace), relative to the options tail.
    span: Range<usize>,
    /// Upper-cased key, for case-insensitive matching.
    key: String,
    /// Raw value (without surrounding quotes), if the option had `= value`.
    value: Option<String>,
}

const AUTO_INCREMENT: &str = "AUTO_INCREMENT";
const ROW_FORMAT: &str = "ROW_FORMAT";

/// Entry point. Returns the (possibly edited) DDL. On any structural surprise
/// the input is returned unchanged.
pub(crate) fn normalize_mysql_export_ddl(ddl: &str, opts: DdlNormalizeOptions) -> String {
    // One winnow pass over the whole DDL (wrapped in `LocatingSlice`), so every
    // option carries an absolute byte span into `ddl` — no offset math.
    let Some(options) = parse_create_table_options(ddl) else {
        return ddl.to_string(); // fail-open: unparseable DDL returned verbatim
    };

    // Compute edits as absolute byte ranges in `ddl`. An empty replacement means
    // "delete this range".
    let bytes = ddl.as_bytes();
    let mut edits: Vec<(Range<usize>, &'static str)> = Vec::new();
    for opt in &options {
        let Range { start, end } = opt.span;
        if opts.omit_auto_increment && opt.key == AUTO_INCREMENT {
            // Preserve line endings because they may terminate a preceding line comment.
            let start = if start > 0 && matches!(bytes[start - 1], b' ' | b'\t') { start - 1 } else { start };
            edits.push((start..end, ""));
        } else if opt.key == ROW_FORMAT {
            if let Some(value) = opt.value.as_deref() {
                let value = value.to_ascii_uppercase();
                if value == "COMPACT" || value == "REDUNDANT" {
                    edits.push((start..end, "ROW_FORMAT=DYNAMIC"));
                }
            }
        }
    }

    if edits.is_empty() {
        return ddl.to_string();
    }

    // Apply edits to the original string. Distinct options never overlap; sort
    // by start and stitch the kept slices around each edit.
    edits.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(ddl.len());
    let mut cursor = 0usize;
    for (range, replacement) in &edits {
        if range.start < cursor {
            continue; // defensive: never expected for distinct options
        }
        out.push_str(&ddl[cursor..range.start]);
        out.push_str(replacement);
        cursor = range.end;
    }
    out.push_str(&ddl[cursor..]);
    out
}

// ---------------------------------------------------------------------------
// winnow parser.
//
// One pass over the whole DDL (wrapped in `LocatingSlice`), so every parsed
// option carries an absolute byte span into `ddl`. The column-definition body
// is skipped with a recursive balanced-`(...)` parser — it never inspects
// column content, only tracks nesting and quoted spans so a `(` inside a type
// like `decimal(30,6)` or inside a backtick-quoted table name doesn't fool it.
// Any parse failure fails open (the caller returns the original DDL).
// ---------------------------------------------------------------------------

/// Parse `CREATE TABLE <name> ( <columns> ) <options…>` into the table options,
/// each with an absolute byte span. The column body is skipped, not modeled.
fn parse_create_table_options(ddl: &str) -> Option<Vec<ParsedOption>> {
    // `skip_create_table_prefix` + `skip_column_body` position the stream at the
    // options tail; `preceded` discards them. `parse_peek` allows a trailing `;`
    // or an unmodeled option shape without failing the whole parse.
    let mut parser = preceded(
        (skip_create_table_prefix, skip_column_body),
        repeat(0.., preceded(skip_ws_and_comments, table_option.with_span())).fold(
            Vec::new,
            |mut acc: Vec<ParsedOption>, (mut option, span)| {
                option.span = span;
                acc.push(option);
                acc
            },
        ),
    );
    match parser.parse_peek(LocatingSlice::new(ddl)) {
        Ok((_remaining, options)) => Some(options),
        Err(_) => None,
    }
}

/// Consume the `CREATE TABLE [IF NOT EXISTS] <name>` prefix, stopping just before
/// the column-list opening `(`. Quoted identifiers and comments are consumed
/// whole, so a `(` inside e.g. `` `weird(name)` `` is not mistaken for the
/// column-list opener.
fn skip_create_table_prefix(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    repeat(0.., alt((sql_quoted, sql_line_comment, sql_block_comment, none_of('(').void())))
        .fold(|| (), |(), _| ())
        .parse_next(input)
}

/// Consume one balanced `(...)` group (the column body), skipping nested parens,
/// quoted strings, and comments. Produces no value.
fn skip_column_body(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    delimited('(', repeat(0.., column_body_token).fold(|| (), |(), _| ()), ')').parse_next(input)
}

/// One token inside the column body: a nested balanced group, a quoted string,
/// a comment, or any single non-`)` character. `skip_column_body` is tried first
/// so nested `(` is handled recursively, not as a plain character.
fn column_body_token(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    alt((skip_column_body, sql_quoted, sql_line_comment, sql_block_comment, none_of(')').void())).parse_next(input)
}

/// A `-- …` or `# …` line comment (to end of line). Produces no value.
fn sql_line_comment(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    alt((("--", take_till(0.., ['\n', '\r'])).void(), ('#', take_till(0.., ['\n', '\r'])).void())).parse_next(input)
}

/// A `/* … */` block comment (MySQL block comments do not nest). Produces no value.
fn sql_block_comment(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    ("/*", take_until(0.., "*/"), "*/").void().parse_next(input)
}

/// Parses one table option: `KEY`, `KEY=VALUE`, or `KEY = VALUE`.
fn table_option(input: &mut LocatingSlice<&str>) -> ModalResult<ParsedOption> {
    let key = option_key.parse_next(input)?;
    let value =
        opt(preceded(delimited(skip_ws_and_comments, '=', skip_ws_and_comments), option_value)).parse_next(input)?;
    Ok(ParsedOption { span: 0..0, key, value })
}

/// An option key: run of ASCII alphanumerics and `_`, upper-cased for matching.
fn option_key(input: &mut LocatingSlice<&str>) -> ModalResult<String> {
    take_while(1.., |c: char| c.is_ascii_alphanumeric() || c == '_')
        .map(|s: &str| s.to_ascii_uppercase())
        .parse_next(input)
}

/// An option value: either a quoted SQL token (whose content we do not need —
/// only its byte span, to keep the tail parse moving past `COMMENT='...'`) or a
/// bare token (identifier/number).
fn option_value(input: &mut LocatingSlice<&str>) -> ModalResult<String> {
    alt((sql_quoted.value(String::new()), bare_value.map(|s: &str| s.to_string()))).parse_next(input)
}

fn bare_value<'i>(input: &mut LocatingSlice<&'i str>) -> ModalResult<&'i str> {
    take_while(1.., |c: char| c.is_ascii_alphanumeric() || c == '_').parse_next(input)
}

/// Skip any run of whitespace and/or SQL comments. Used as the separator between
/// table options so that a comment sitting between options (or between `)` and
/// the first option, or around `=`) does not stop the parse short of later
/// options like `AUTO_INCREMENT`. Matches zero or more chunks (so it also acts
/// like `multispace0` when there is nothing but whitespace).
fn skip_ws_and_comments(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    repeat(0.., alt((multispace1.void(), sql_line_comment, sql_block_comment)))
        .fold(|| (), |(), _| ())
        .parse_next(input)
}

/// Any single-, double-, or backtick-quoted SQL token (content discarded).
fn sql_quoted(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    alt((sql_single_quoted, sql_double_quoted, sql_backtick_quoted)).parse_next(input)
}

/// Consumes a `'…'` token honoring `''` doubling, producing no value. The
/// `repeat(...).fold((), ..)` discards fragments while pinning the accumulator
/// type (a bare `repeat(...).void()` cannot infer it).
fn sql_single_quoted(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    delimited('\'', repeat(0.., alt(("''", take_till(1.., '\'')))).fold(|| (), |(), _| ()), '\'').parse_next(input)
}

fn sql_double_quoted(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    delimited('"', repeat(0.., alt(("\"\"", take_till(1.., '"')))).fold(|| (), |(), _| ()), '"').parse_next(input)
}

fn sql_backtick_quoted(input: &mut LocatingSlice<&str>) -> ModalResult<()> {
    delimited('`', repeat(0.., alt(("``", take_till(1.., '`')))).fold(|| (), |(), _| ()), '`').parse_next(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(omit_auto_increment: bool) -> DdlNormalizeOptions {
        DdlNormalizeOptions { omit_auto_increment }
    }

    #[test]
    fn strips_table_level_auto_increment() {
        let ddl = "CREATE TABLE `t` (`id` bigint NOT NULL AUTO_INCREMENT) ENGINE=InnoDB AUTO_INCREMENT=121 DEFAULT CHARSET=utf8mb4";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` bigint NOT NULL AUTO_INCREMENT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    #[test]
    fn preserves_column_level_auto_increment() {
        let ddl = "CREATE TABLE `t` (`id` bigint NOT NULL AUTO_INCREMENT) ENGINE=InnoDB AUTO_INCREMENT=5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        // Table-level gone, column-level bare AUTO_INCREMENT untouched.
        assert!(out.contains("`id` bigint NOT NULL AUTO_INCREMENT"));
        assert!(!out.contains("AUTO_INCREMENT=5"));
    }

    #[test]
    fn keeps_auto_increment_when_option_off() {
        let ddl = "CREATE TABLE `t` (`id` bigint NOT NULL AUTO_INCREMENT) ENGINE=InnoDB AUTO_INCREMENT=121";
        assert_eq!(normalize_mysql_export_ddl(ddl, opts(false)), ddl);
    }

    #[test]
    fn no_double_space_left_behind() {
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=7 COLLATE=utf8mb4_bin";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB COLLATE=utf8mb4_bin");
        assert!(!out.contains("  "));
    }

    #[test]
    fn auto_increment_inside_comment_is_not_stripped() {
        let ddl =
            "CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=9 COMMENT='see AUTO_INCREMENT=1000 in docs'";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        // Table-level `AUTO_INCREMENT=9` is removed; the COMMENT literal (including
        // its inner `AUTO_INCREMENT=1000` text) is preserved verbatim — this is the
        // quote-awareness a blind regex could not provide.
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB COMMENT='see AUTO_INCREMENT=1000 in docs'");
    }

    #[test]
    fn comment_between_close_paren_and_first_option() {
        let ddl = "CREATE TABLE `t` (`id` int) /* generated by tool x */ ENGINE=InnoDB AUTO_INCREMENT=5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) /* generated by tool x */ ENGINE=InnoDB");
    }

    #[test]
    fn block_comment_between_options_ignores_inner_parens() {
        // The `(` and `)` inside the block comment must stay opaque; they must
        // not be mistaken for column-list delimiters or option boundaries.
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB /* see (a) and )b( */ AUTO_INCREMENT=5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB /* see (a) and )b( */");
    }

    #[test]
    fn auto_increment_inside_block_comment_not_stripped() {
        // Only the real table-level option is removed; the one inside the block
        // comment is opaque and preserved verbatim.
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB /* AUTO_INCREMENT=999 */ AUTO_INCREMENT=5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB /* AUTO_INCREMENT=999 */");
    }

    #[test]
    fn line_comment_between_options() {
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB -- remember to bump\nAUTO_INCREMENT=5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB -- remember to bump\n");
    }

    #[test]
    fn comment_around_equals_sign_in_option() {
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT/*c*/=/*c*/5";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB");
    }

    #[test]
    fn rewrites_legacy_row_format() {
        let ddl = "CREATE TABLE `t` (`p` varchar(9)) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=COMPACT";
        let out = normalize_mysql_export_ddl(ddl, opts(false));
        assert_eq!(out, "CREATE TABLE `t` (`p` varchar(9)) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC");
    }

    #[test]
    fn row_format_rewrite_is_case_insensitive_and_normalizes_output() {
        let ddl = "CREATE TABLE `t` (`p` text) engine=InnoDB row_format = redundant";
        let out = normalize_mysql_export_ddl(ddl, opts(false));
        assert_eq!(out, "CREATE TABLE `t` (`p` text) engine=InnoDB ROW_FORMAT=DYNAMIC");
    }

    #[test]
    fn non_legacy_row_format_untouched() {
        let ddl = "CREATE TABLE `t` (`p` text) ENGINE=InnoDB ROW_FORMAT=COMPRESSED";
        assert_eq!(normalize_mysql_export_ddl(ddl, opts(false)), ddl);
    }

    #[test]
    fn both_transforms_compose() {
        let ddl = "CREATE TABLE `t` (`p` text) ENGINE=InnoDB AUTO_INCREMENT=42 ROW_FORMAT=COMPACT DEFAULT CHARSET=utf8";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`p` text) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8");
    }

    #[test]
    fn nested_parens_in_column_body_do_not_confuse_tail_location() {
        let ddl = "CREATE TABLE `t` (`amount` decimal(30,6) NOT NULL, `st` enum('a','b') NOT NULL, CHECK (amount > 0)) ENGINE=InnoDB AUTO_INCREMENT=3";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert!(out.contains("decimal(30,6)"));
        assert!(out.contains("enum('a','b')"));
        assert!(out.contains("CHECK (amount > 0)"));
        assert!(!out.contains("AUTO_INCREMENT=3"));
    }

    #[test]
    fn table_name_containing_paren_does_not_mislocate_tail() {
        // The `(` inside the backtick-quoted table name must not be mistaken for
        // the column-list opener; the real options tail is after the column list.
        let ddl = "CREATE TABLE `weird(name)` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=7";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `weird(name)` (`id` int) ENGINE=InnoDB");
    }

    #[test]
    fn multibyte_comment_survives_byte_offset_edit() {
        let ddl = "CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=11 COMMENT='每日收益表'";
        let out = normalize_mysql_export_ddl(ddl, opts(true));
        assert_eq!(out, "CREATE TABLE `t` (`id` int) ENGINE=InnoDB COMMENT='每日收益表'");
    }

    #[test]
    fn malformed_ddl_fails_open_unchanged() {
        let ddl = "CREATE TABLE `t` (`id` int"; // unbalanced paren
        assert_eq!(normalize_mysql_export_ddl(ddl, opts(true)), ddl);
    }
}
