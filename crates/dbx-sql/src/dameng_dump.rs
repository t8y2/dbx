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
//! (`ps -ef`) for the duration of the run. `PARFILE` is still used for the non-sensitive
//! parameters to keep the command line short and debuggable.

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

/// The `USERID` token, always the first argument: `USERID=<user>/<password>@<host>:<port>`.
/// Password is NOT URL-escaped; Dameng accepts it verbatim. If the password contains
/// characters that break the token, the caller should still pass it through — the tool
/// parses up to the first `@`.
pub fn userid_token(user: &str, password: &str, host: &str, port: u16) -> String {
    format!("USERID={user}/{password}@{host}:{port}")
}

/// Contents of the PARFILE: the non-sensitive parameters, one `KEY=value` per line.
/// File/log paths are double-quoted so spaces and Windows backslashes survive.
pub fn build_parfile_contents(req: &DamengDumpRequest) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("FILE=\"{}\"", req.file_path));
    lines.push(format!("LOG=\"{}\"", req.log_path));
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

/// The full argv (program + USERID + PARFILE). The caller writes `parfile_path` (with
/// [`build_parfile_contents`]) before invoking. USERID must be the first argument.
pub fn build_command(req: &DamengDumpRequest, parfile_path: &str) -> Vec<String> {
    vec![
        req.tool_path.clone(),
        userid_token(&req.user, &req.password, &req.host, req.port),
        format!("PARFILE={parfile_path}"),
    ]
}

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

    let elapsed_seconds = text
        .lines()
        .rev()
        .find(|l| l.contains("共花费"))
        .and_then(|l| {
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
            .find(|l| l.contains("DMException") || l.contains("错误") || l.contains("失败") || l.contains("EXP-") || l.contains("IMP-"))
            .map(|l| l.trim().to_string())
            .or_else(|| Some("dexp/dimp did not report success".to_string()))
    };

    DamengDumpOutcome {
        success,
        warnings,
        elapsed_seconds,
        error,
    }
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
        assert_eq!(
            userid_token("SYSDBA", "Dameng123", "127.0.0.1", 5236),
            "USERID=SYSDBA/Dameng123@127.0.0.1:5236"
        );
    }

    #[test]
    fn export_parfile_matches_real_invocation() {
        let par = build_parfile_contents(&req(DamengDumpKind::Export));
        assert_eq!(
            par,
            "FILE=\"/tmp/dbx_dcss.dmp\"\nLOG=\"/tmp/dbx_dcss.log\"\nSCHEMAS=DCSS\nTABLESPACE=N\nDROP=N\n"
        );
    }

    #[test]
    fn command_puts_userid_first_then_parfile() {
        let argv = build_command(&req(DamengDumpKind::Export), "/tmp/dbx_dcss.par");
        assert_eq!(argv[0], "/opt/dmdbms/bin/dexp");
        assert_eq!(argv[1], "USERID=SYSDBA/Dameng123@127.0.0.1:5236");
        assert_eq!(argv[2], "PARFILE=/tmp/dbx_dcss.par");
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
