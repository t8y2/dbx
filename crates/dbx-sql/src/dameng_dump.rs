//! Dameng native export/import (`.dmp`) command construction and log parsing.
//!
//! DBX's generic export is row-by-row and slow for a whole schema. Dameng ships the
//! native `dexp`/`dimp` command-line tools (DM8) which export/import a schema or a set
//! of tables to/from a `.dmp` file in seconds. This module builds the invocation and
//! interprets the tool's log so the caller can drive the external process.
//!
//! Security note (known limitation, flagged for maintainers in the PR): Dameng requires
//! `USERID` to be the FIRST command-line argument — unlike Oracle, the password cannot be
//! moved into the `PARFILE`. So the password is necessarily visible in the process list
//! (`ps -ef`) for the duration of the run. `PARFILE` keeps the schema/table parameters out
//! of the process list; FILE/LOG travel on the command line because Windows dexp rejects
//! forward-slash paths there (#13585).

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DamengDumpKind {
    Export,
    Import,
}

/// A single `KEY=value` token in a dexp/dimp parameter file. Values are emitted verbatim
/// (the caller is responsible for quoting identifiers); the builder quotes file/log paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamengDumpRequest {
    pub db_type: DatabaseType,
    pub kind: DamengDumpKind,
    /// Absolute path to the `dexp`/`dimp` executable (configured by the user; the Dameng
    /// client tools are not bundled with DBX).
    pub tool_path: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// `.dmp` file to write (export) or read (import).
    pub file_path: String,
    /// `.log` file the tool writes.
    pub log_path: String,
    /// Schemas to export/import (SCHEMAS=). Empty means whole-database / not schema-scoped.
    pub schemas: Vec<String>,
    /// Explicit tables (TABLES=), mutually exclusive with `schemas` in practice.
    pub tables: Vec<String>,
    /// Import only: `REMAP_SCHEMA=SRC:DST`.
    pub remap_schema: Option<(String, String)>,
    /// Import only: `TABLE_EXISTS_ACTION=SKIP|REPLACE|TRUNCATE|APPEND`.
    pub table_exists_action: Option<String>,
}

/// A bounded trailing slice of a tool's output, for appending to a failure message.
///
/// The tool's own log is preferred when it exists, but a parameter error stops the run
/// before the LOG file is written; the console capture then carries the only copy of the
/// real reason. Either way the tail is what matters — dexp prints its cause last.
pub fn diagnostic_tail(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim_end_matches(['\n', '\r']);
    if trimmed.len() <= max_chars {
        return trimmed.to_string();
    }
    let floor = trimmed.len() - max_chars;
    let start = floor + trimmed[floor..].find('\n').map_or(0, |i| i + 1);
    trimmed[start..].to_string()
}

/// The `USERID` token, always the first argument: `USERID=<user>/<password>@<host>:<port>`.
/// Password is NOT URL-escaped; Dameng accepts it verbatim. A `/` or `@` inside the user or
/// password would be parsed as a field separator (the tool parses up to the first `@`), and a
/// space would end the token early, so callers must reject those up front via
/// [`userid_field_error`] instead of launching.
pub fn userid_token(user: &str, password: &str, host: &str, port: u16) -> String {
    format!("USERID={user}/{password}@{host}:{port}")
}

/// Returns the field name whose value cannot be encoded in the `USERID` token
/// (`/` separates user/password, `@` starts the host part, a space ends the token),
/// or `None` if both are safe to pass.
pub fn userid_field_error(user: &str, password: &str) -> Option<&'static str> {
    [(user, "username"), (password, "password")].into_iter().find_map(|(field, name)| {
        (field.contains('/') || field.contains('@') || field.contains(char::is_whitespace)).then_some(name)
    })
}

/// Render a FILE/LOG path for the command line.
///
/// Dameng validates FILE/LOG as *file names*: its documentation lists `/` and `:`
/// among the characters such a name may not contain. On Windows the tool does not
/// treat a forward slash as a directory separator, so a normalised
/// `D:/data/target.dmp` is rejected as "无效的文件路径" (#13585), while the native
/// `D:\data\target.dmp` used in every documented Windows example is accepted.
/// Windows-shaped paths therefore get the native separator back.
///
/// Nothing is quoted: [`build_command`] hands each value to `Command` as a single
/// argv entry, so spaces survive without the `"` that Dameng also rejects.
fn native_path_value(path: &str) -> String {
    let bytes = path.as_bytes();
    let windows_shaped =
        (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
            || path.starts_with("//");
    if windows_shaped {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// Contents of the PARFILE: the non-sensitive parameters, one `KEY=value` per line.
///
/// FILE/LOG are deliberately not written here. They travel as command-line
/// arguments (see [`build_command`]) so Windows paths keep their native
/// separators and never pass through the PARFILE value parser (#13585).
pub fn build_parfile_contents(req: &DamengDumpRequest) -> String {
    let mut lines: Vec<String> = Vec::new();
    if !req.schemas.is_empty() {
        lines.push(format!("SCHEMAS={}", req.schemas.join(",")));
    }
    if !req.tables.is_empty() {
        lines.push(format!("TABLES={}", req.tables.join(",")));
    }
    match req.kind {
        DamengDumpKind::Export => {
            // Match SQLark's fast, non-interactive defaults.
            lines.push("TABLESPACE=N".to_string());
            lines.push("DROP=N".to_string());
        }
        DamengDumpKind::Import => {
            if let Some((src, dst)) = &req.remap_schema {
                lines.push(format!("REMAP_SCHEMA={src}:{dst}"));
            }
            if let Some(action) = &req.table_exists_action {
                lines.push(format!("TABLE_EXISTS_ACTION={action}"));
            }
        }
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// The full argv (program + USERID + PARFILE + FILE + LOG). The caller writes
/// `parfile_path` (with [`build_parfile_contents`]) before invoking. USERID must be
/// the first argument.
///
/// FILE/LOG are command-line arguments rather than PARFILE lines: on Windows dexp
/// validates them as file names and rejects the forward-slash form as an invalid
/// path (#13585). `Command` passes each argument verbatim, so a native path with
/// spaces needs no quoting.
pub fn build_command(req: &DamengDumpRequest, parfile_path: &str) -> Vec<String> {
    vec![
        req.tool_path.clone(),
        userid_token(&req.user, &req.password, &req.host, req.port),
        format!("PARFILE={parfile_path}"),
        format!("FILE={}", native_path_value(&req.file_path)),
        format!("LOG={}", native_path_value(&req.log_path)),
    ]
}

/// Build the message the user sees for a run that did not report success.
///
/// `parse_dump_log` can only classify the text it was handed. Two cases leave it without a
/// usable classification: the tool stops before writing its log file (log and console are
/// both empty or generic), or it writes a log whose tail carries no recognised marker. The
/// exit status and the raw output are the only evidence left, so both are folded in here —
/// a bare "did not report success" tells the user nothing about which parameter upset dexp.
pub fn failure_message(outcome: &DamengDumpOutcome, exit_code: Option<i32>, text: &str) -> String {
    let mut message = outcome.error.clone().unwrap_or_else(|| "dexp/dimp did not report success".to_string());

    if let Some(code) = exit_code {
        if code != 0 {
            message.push_str(&format!(" (exit code {code})"));
        }
    }

    let tail = diagnostic_tail(text, DIAGNOSTIC_TAIL_MAX_CHARS);
    if !tail.is_empty() && !message.contains(&tail) {
        message.push_str("\n\n dexp/dimp output:\n");
        message.push_str(&tail);
    }

    message
}

/// How much of the tool's output to attach to a failure message. dexp is chatty on success
/// and quiet on failure, so a small slice still carries the cause while keeping the UI sane.
const DIAGNOSTIC_TAIL_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamengDumpOutcome {
    pub success: bool,
    pub warnings: bool,
    pub elapsed_seconds: Option<String>,
    pub error: Option<String>,
}

/// Interpret a dexp/dimp log body. Success is signalled by "成功终止导出/导入" (or the
/// English "terminated successfully"); a per-line "[警告]" marks warnings; "DMException"
/// or a missing success marker with an error line marks failure.
pub fn parse_dump_log(text: &str, kind: DamengDumpKind) -> DamengDumpOutcome {
    let success_zh = match kind {
        DamengDumpKind::Export => text.contains("成功终止导出"),
        DamengDumpKind::Import => text.contains("成功终止导入"),
    };
    let success_en = text.to_ascii_lowercase().contains("terminated successfully");
    let success = success_zh || success_en;

    let warnings = text.contains("[警告]");

    let elapsed_seconds = text.lines().rev().find(|l| l.contains("共花费")).and_then(|l| {
        l.split_whitespace().find_map(|tok| {
            let t = tok.trim_end_matches('s');
            if !t.is_empty() && t.parse::<f64>().is_ok() {
                Some(format!("{t}s"))
            } else {
                None
            }
        })
    });

    let error = if success {
        None
    } else {
        text.lines()
            .rev()
            .find(|l| {
                l.contains("DMException")
                    || l.contains("错误")
                    || l.contains("失败")
                    || l.contains("EXP-")
                    || l.contains("IMP-")
            })
            .map(|l| l.trim().to_string())
            .or_else(|| Some("dexp/dimp did not report success".to_string()))
    };

    DamengDumpOutcome { success, warnings, elapsed_seconds, error }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: DamengDumpKind) -> DamengDumpRequest {
        DamengDumpRequest {
            db_type: DatabaseType::Dameng,
            kind,
            tool_path: "/opt/dmdbms/bin/dexp".to_string(),
            host: "127.0.0.1".to_string(),
            port: 5236,
            user: "SYSDBA".to_string(),
            password: "Dameng123".to_string(),
            file_path: "/tmp/dbx_dcss.dmp".to_string(),
            log_path: "/tmp/dbx_dcss.log".to_string(),
            schemas: vec!["DCSS".to_string()],
            tables: vec![],
            remap_schema: None,
            table_exists_action: None,
        }
    }

    #[test]
    fn userid_is_first_and_carries_credentials() {
        assert_eq!(userid_token("SYSDBA", "Dameng123", "127.0.0.1", 5236), "USERID=SYSDBA/Dameng123@127.0.0.1:5236");
    }

    #[test]
    fn userid_field_error_flags_breaking_chars_in_either_field() {
        assert_eq!(userid_field_error("SYSDBA", "Dameng123"), None);
        assert_eq!(userid_field_error("SYSDBA", "p@ss"), Some("password"));
        assert_eq!(userid_field_error("SYSDBA", "p/ss"), Some("password"));
        assert_eq!(userid_field_error("user@dba", "Dameng123"), Some("username"));
        assert_eq!(userid_field_error("us/er", "Dameng123"), Some("username"));
    }

    #[test]
    fn export_parfile_leaves_paths_to_the_command_line() {
        let par = build_parfile_contents(&req(DamengDumpKind::Export));
        assert_eq!(par, "SCHEMAS=DCSS\nTABLESPACE=N\nDROP=N\n");
        assert!(!par.contains("FILE="), "FILE must not ride in the PARFILE: {par}");
        assert!(!par.contains("LOG="), "LOG must not ride in the PARFILE: {par}");
    }

    #[test]
    fn command_passes_windows_paths_with_native_separators() {
        let mut r = req(DamengDumpKind::Export);
        r.file_path = r"C:\Users\dbx\dump.dcss.dmp".to_string();
        r.log_path = r"C:\Users\dbx\AppData\Local\Temp\dbx-dameng-dump\task.log".to_string();
        let argv = build_command(&r, r"C:\Users\dbx\AppData\Local\Temp\task.par");
        assert!(argv.contains(&r"FILE=C:\Users\dbx\dump.dcss.dmp".to_string()), "got: {argv:?}");
        assert!(
            argv.contains(&r"LOG=C:\Users\dbx\AppData\Local\Temp\dbx-dameng-dump\task.log".to_string()),
            "got: {argv:?}"
        );
    }

    #[test]
    fn command_restores_backslashes_on_forward_slash_windows_paths() {
        // #13585: the PARFILE path normaliser produced D:/data/... and dexp answered
        // "无效的文件路径". The command line must carry the native form instead.
        let mut r = req(DamengDumpKind::Import);
        r.file_path = "D:/dumps/dcss.dmp".to_string();
        let argv = build_command(&r, "/tmp/task.par");
        assert!(argv.contains(&r"FILE=D:\dumps\dcss.dmp".to_string()), "got: {argv:?}");
    }

    #[test]
    fn command_keeps_a_path_with_spaces_as_one_unquoted_argument() {
        let mut r = req(DamengDumpKind::Export);
        r.file_path = r"C:\Users\John Smith\dump.dmp".to_string();
        let argv = build_command(&r, "/tmp/task.par");
        assert!(argv.contains(&r"FILE=C:\Users\John Smith\dump.dmp".to_string()), "got: {argv:?}");
        assert!(!argv.iter().any(|arg| arg.contains('"')), "quotes are invalid in FILE/LOG: {argv:?}");
    }

    #[test]
    fn command_keeps_unix_paths_untouched() {
        let argv = build_command(&req(DamengDumpKind::Export), "/tmp/dbx_dcss.par");
        assert!(argv.contains(&"FILE=/tmp/dbx_dcss.dmp".to_string()), "got: {argv:?}");
        assert!(argv.contains(&"LOG=/tmp/dbx_dcss.log".to_string()), "got: {argv:?}");
    }

    #[test]
    fn userid_field_error_rejects_whitespace() {
        assert_eq!(userid_field_error("SYSDBA", "Pass word01"), Some("password"));
        assert_eq!(userid_field_error("SYSDBA", "Dameng+123"), None);
    }

    #[test]
    fn diagnostic_tail_keeps_the_cause_and_stays_bounded() {
        // trailing newlines go, the whole text comes back when it fits
        assert_eq!(diagnostic_tail("a\nb\n", 10), "a\nb");
        assert_eq!(diagnostic_tail("a\nb", 3), "a\nb");
        // a zero budget asks for nothing
        assert_eq!(diagnostic_tail("a\nb", 0), "");
        let long = (0..100).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let tail = diagnostic_tail(&long, 20);
        assert!(tail.len() <= 24, "bounded: {tail}");
        assert!(tail.ends_with("line 99"), "keeps the cause: {tail}");
        assert!(tail.starts_with("line "), "cuts on a line boundary: {tail}");
    }

    #[test]
    fn failure_message_carries_exit_code_and_raw_output() {
        // The #12837 shape: an empty log plus an unrecognised-parameter line on the console.
        let empty_parse = parse_dump_log("", DamengDumpKind::Export);
        assert!(!empty_parse.success);
        let message =
            failure_message(&empty_parse, Some(3), "dexp: unrecognized parameter TABLESPACE\nusage: dexp ...");
        assert!(message.contains("(exit code 3)"), "got: {message}");
        assert!(message.contains("unrecognized parameter TABLESPACE"), "got: {message}");
        assert!(message.contains("dexp/dimp output:"), "got: {message}");
    }

    #[test]
    fn failure_message_stays_quiet_on_success_parse() {
        let log = "dexp V8\n成功终止导出, 没有出现警告\n";
        let outcome = parse_dump_log(log, DamengDumpKind::Export);
        assert!(outcome.success);
        // Not called on the success path, but it must not fabricate output for a parsed log.
        let message = failure_message(&outcome, Some(0), log);
        assert!(!message.contains("exit code"), "got: {message}");
    }

    #[test]
    fn command_puts_userid_first_then_parfile_and_paths() {
        let argv = build_command(&req(DamengDumpKind::Export), "/tmp/dbx_dcss.par");
        assert_eq!(argv[0], "/opt/dmdbms/bin/dexp");
        assert_eq!(argv[1], "USERID=SYSDBA/Dameng123@127.0.0.1:5236");
        assert_eq!(argv[2], "PARFILE=/tmp/dbx_dcss.par");
        assert_eq!(argv[3], "FILE=/tmp/dbx_dcss.dmp");
        assert_eq!(argv[4], "LOG=/tmp/dbx_dcss.log");
    }

    #[test]
    fn import_parfile_adds_remap_and_exists_action() {
        let mut r = req(DamengDumpKind::Import);
        r.remap_schema = Some(("DCSS".to_string(), "DCSS_BAK".to_string()));
        r.table_exists_action = Some("SKIP".to_string());
        let par = build_parfile_contents(&r);
        assert!(par.contains("REMAP_SCHEMA=DCSS:DCSS_BAK"));
        assert!(par.contains("TABLE_EXISTS_ACTION=SKIP"));
        assert!(!par.contains("TABLESPACE=N"));
    }

    #[test]
    fn parses_real_successful_export_log() {
        // Excerpt of the actual dexp run against DM8 (schema dcss, 90 tables, 4.032s).
        let log = "dexp V8 \nversion: 03134284552\nstart dexp: SYSDBA/******@127.0.0.1:5236 FILE=/tmp/dbx_dcss.dmp\n开始导出模式[dcss].....\n共导出 90 个TABLE \n模式[dcss]导出结束.....\n成功导出 第1 个SCHEMA ：dcss\n整个导出过程共花费    4.032 s\n\n成功终止导出, 没有出现警告\n";
        let out = parse_dump_log(log, DamengDumpKind::Export);
        assert!(out.success, "should be success: {out:?}");
        assert!(!out.warnings);
        assert_eq!(out.elapsed_seconds.as_deref(), Some("4.032s"));
        assert_eq!(out.error, None);
    }

    #[test]
    fn parses_real_successful_import_log() {
        let log = "dimp V8 \nstart dimp: SYSDBA/******@127.0.0.1:5236\n[908/908]整个导入过程共花费   16.299 s\n\n成功终止导入, 没有出现警告\n";
        let out = parse_dump_log(log, DamengDumpKind::Import);
        assert!(out.success);
        assert_eq!(out.elapsed_seconds.as_deref(), Some("16.299s"));
    }

    #[test]
    fn detects_failure_and_warning() {
        let warn = "dexp V8\n[警告]文件\"/tmp/x.dmp\"已经存在\n是否覆盖(y/n):";
        let out = parse_dump_log(warn, DamengDumpKind::Export);
        assert!(!out.success);
        assert!(out.warnings);
        assert!(out.error.is_some());

        let err = "dexp V8\ndm.jdbc.driver.DMException: 第1 行第5 列附近出现错误";
        let out = parse_dump_log(err, DamengDumpKind::Export);
        assert!(!out.success);
        assert!(out.error.unwrap().contains("DMException"));
    }
}
