//! Console client commands for the query window, one family per client:
//! Oracle SQL*Plus / YashanDB yasql / DM8 disql (`DESC`, `EXEC`, `SET`, ...) and
//! PostgreSQL psql (`\d`, `\dt`). Those commands are line-terminated, live in
//! the client rather than the server, and must not be forwarded to the
//! database. This module parses one physical line into a [`ConsoleCommand`];
//! the statement splitter routes matching lines to it and the executor in
//! `dbx-core` dispatches the result.
//!
//! Verb tables are closed lists: any first word outside them is ordinary SQL
//! and passes through unchanged, so behaviour for scripts that never use
//! console syntax is bit-for-bit identical to before. MySQL and SQL Server
//! need no interception: their console syntax (`DESC`, `SHOW`, `USE`,
//! `DELIMITER`, `\G`; `GO`) is either server-side SQL or already handled by
//! the splitter.

use crate::models::connection::DatabaseType;

/// Which client's console command syntax a database accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleCommandFamily {
    /// Oracle SQL*Plus and YashanDB yasql.
    SqlPlus,
    /// DM8 disql's supported client-command subset; native SET SQL passes through.
    Disql,
    /// PostgreSQL psql backslash commands.
    Psql,
}

/// A console client command parsed from a single line of script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsoleCommand {
    /// `DESC[RIBE] object` (SQL*Plus) or `\d[+] [object]` (psql) — describe a
    /// table or view.
    Describe { object: String },
    /// `\dt[+] [pattern]` (psql) — list tables in the current database.
    ListTables { pattern: String },
    /// `EXEC[UTE] call` — run a PL/SQL call inside an anonymous block.
    Execute { call: String },
    /// `SHO[W] item` — show a client/server setting (`USER` supported first).
    Show { item: String },
    /// `SET option value` — a SQL*Plus session option.
    SetOption { option: String, value: String },
    /// `PRO[MPT] text` — echo text to the output.
    Prompt { text: String },
    /// A standalone `/` (or `RUN`) — re-execute the previous statement.
    Rerun,
    /// `EXIT` / `QUIT` — stop executing the remaining batch.
    Exit,
    /// A recognized SQL*Plus verb dbx does not implement; reported and skipped.
    Unsupported { verb: String },
}

/// SQL*Plus verbs dbx recognizes but does not implement. They parse as
/// [`ConsoleCommand::Unsupported`] so pasted scripts keep running instead of
/// dying on a server syntax error; the executor reports each skip.
const KNOWN_BUT_UNSUPPORTED_VERBS: &[&str] = &[
    "APPEND",
    "ARCHIVE",
    "BREAK",
    "BTITLE",
    "CHANGE",
    "CLEAR",
    "COLUMN",
    "COMPUTE",
    "CONNECT",
    "DEFINE",
    "DEL",
    "DISCONNECT",
    "EDIT",
    "HOST",
    "INPUT",
    "LIST",
    "PASSWORD",
    "PAUSE",
    "PRINT",
    "RECOVER",
    "REMARK",
    "SHUTDOWN",
    "SPOOL",
    "START",
    "STARTUP",
    "STORE",
    "TTITLE",
    "UNDEFINE",
    "VARIABLE",
    "WHENEVER",
    "XQUERY",
];

/// SQL*Plus `SET` system variables (closed list from the SQL*Plus reference).
/// `SET TRANSACTION`, `SET ROLE` and `SET CONSTRAINT` are server SQL and are
/// deliberately absent.
const SQLPLUS_SET_OPTIONS: &[&str] = &[
    "ANSWER",
    "APPINFO",
    "ARRAY",
    "ARRAYSIZE",
    "AUTOCOMMIT",
    "AUTOPRINT",
    "AUTORECOVERY",
    "AUTOTRACE",
    "BLOCKTERMINATOR",
    "BTITLE",
    "BUFFER",
    "CMDSEP",
    "COLSEP",
    "COMPATIBILITY",
    "CONCAT",
    "COPYCOMMIT",
    "COPYTYPECHECK",
    "DEFINE",
    "DESCRIBE",
    "ECHO",
    "EDITFILE",
    "EMBEDDED",
    "ESCAPE",
    "FEEDBACK",
    "FLAGGER",
    "FLUSH",
    "HEADING",
    "HEADSEP",
    "LINESIZE",
    "LOBOFFSET",
    "LONG",
    "LONGCHUNKSIZE",
    "MARKUP",
    "NEWPAGE",
    "NULL",
    "NUMFORMAT",
    "NUMWIDTH",
    "PAGESIZE",
    "PAUSE",
    "RECSEP",
    "RECSEPCHAR",
    "SERVEROUTPUT",
    "SHIFTINOUT",
    "SHOWMODE",
    "SILENT",
    "SPOOL",
    "SQLBLANKLINES",
    "SQLCASE",
    "SQLCODE",
    "SQLCONTINUE",
    "SQLNUMBER",
    "SQLPREFIX",
    "SQLPROMPT",
    "SQLTERMINATOR",
    "SUFFIX",
    "TAB",
    "TERMOUT",
    "TIME",
    "TIMING",
    "TRIMOUT",
    "TRIMSPOOL",
    "UNDERLINE",
    "VERIFY",
    "WRAP",
];

/// Words that begin a first-class dbx console command.
const COMMAND_VERBS: &[&str] =
    &["DESC", "DESCR", "DESCRIBE", "EXEC", "EXECUTE", "SHO", "SHOW", "PRO", "PROMPT", "SET", "EXIT", "QUIT", "RUN"];

/// Parse one line of script as a console command for the database's client
/// family. Returns `None` for anything that must stay on the normal SQL path:
/// other dialects, multi-line statements, server SQL that merely starts with
/// a verb word (`SET TRANSACTION`), and any unknown first word.
pub fn parse_console_command_for_database(statement: &str, db_type: DatabaseType) -> Option<ConsoleCommand> {
    parse_console_command_for_family(statement, crate::sql::console_command_family_for_database(db_type)?)
}

pub fn parse_console_command_for_family(statement: &str, family: ConsoleCommandFamily) -> Option<ConsoleCommand> {
    match family {
        ConsoleCommandFamily::SqlPlus => parse_sqlplus_console_command(statement, true),
        ConsoleCommandFamily::Disql => parse_disql_console_command(statement),
        ConsoleCommandFamily::Psql => parse_psql_console_command(statement),
    }
}

pub fn parse_disql_console_command(statement: &str) -> Option<ConsoleCommand> {
    match parse_sqlplus_console_command(statement, true)? {
        // DM8 has server-side SET SCHEMA, SESSION, IDENTITY_INSERT, etc. Only
        // the closed client-option list may be consumed by the console.
        ConsoleCommand::Unsupported { verb } if verb == "SET" => None,
        ConsoleCommand::SetOption { option, value }
            if option == "TIME"
                && !value
                    .split_whitespace()
                    .next()
                    .is_some_and(|word| word.eq_ignore_ascii_case("ON") || word.eq_ignore_ascii_case("OFF")) =>
        {
            None
        }
        command => Some(command),
    }
}

/// Parse one line as an Oracle SQL*Plus / YashanDB yasql command.
///
/// `enabled` must be the family gate; `None` otherwise keeps every dialect
/// that does not opt in byte-for-byte compatible.
pub fn parse_sqlplus_console_command(statement: &str, enabled: bool) -> Option<ConsoleCommand> {
    if !enabled {
        return None;
    }
    let trimmed = statement.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    // The splitter usually strips the terminator itself, but a `;`-terminated
    // line can also arrive here; SQL*Plus tolerates the trailing semicolon.
    let body = trimmed.strip_suffix(';').map_or(trimmed, str::trim);
    if body.is_empty() {
        return None;
    }
    if body.starts_with('@') {
        // `@script.sql` / `@@script.sql` — START shorthand.
        return Some(ConsoleCommand::Unsupported { verb: "START".to_string() });
    }
    let (verb, rest) = split_first_word(body);
    let rest_trimmed = rest.trim();
    match verb.to_ascii_uppercase().as_str() {
        "DESC" | "DESCR" | "DESCRIBE" => Some(ConsoleCommand::Describe { object: rest_trimmed.to_string() }),
        "EXEC" | "EXECUTE" => Some(ConsoleCommand::Execute { call: rest_trimmed.to_string() }),
        "SHO" | "SHOW" => Some(ConsoleCommand::Show { item: rest_trimmed.to_ascii_lowercase() }),
        "PRO" | "PROMPT" => Some(ConsoleCommand::Prompt { text: rest.trim_start().to_string() }),
        "SET" => parse_set_command(rest_trimmed),
        "EXIT" | "QUIT" => Some(ConsoleCommand::Exit),
        "RUN" => Some(ConsoleCommand::Rerun),
        word => KNOWN_BUT_UNSUPPORTED_VERBS
            .iter()
            .find(|verb| **verb == word)
            .map(|verb| ConsoleCommand::Unsupported { verb: verb.to_string() }),
    }
}

/// Whether a word is a console verb (or `@file` shorthand). Used by the
/// statement splitter to take over a line as soon as its first word ends, so
/// semicolons and quote characters in the command text (`PROMPT a;b`) stay
/// literal instead of being interpreted as SQL.
pub fn is_console_command_word(word: &str) -> bool {
    // `@script.sql` / `@@script.sql` is START shorthand; a bare `@` is not.
    if word.starts_with('@') {
        return word.len() > 1;
    }
    let upper = word.to_ascii_uppercase();
    COMMAND_VERBS.contains(&upper.as_str()) || KNOWN_BUT_UNSUPPORTED_VERBS.contains(&upper.as_str())
}

/// `SET` alone or with an unknown option stays client-side (SQL*Plus reports
/// SP2-0158); `SET TRANSACTION|ROLE|CONSTRAINT[S]` is server SQL and returns
/// `None` so the normal executor handles it.
fn parse_set_command(rest: &str) -> Option<ConsoleCommand> {
    if rest.is_empty() {
        return Some(ConsoleCommand::Unsupported { verb: "SET".to_string() });
    }
    let (option, value) = split_first_word(rest);
    let upper = option.to_ascii_uppercase();
    match upper.as_str() {
        "TRANSACTION" | "ROLE" | "CONSTRAINT" | "CONSTRAINTS" => None,
        _ if SQLPLUS_SET_OPTIONS.contains(&upper.as_str()) => {
            Some(ConsoleCommand::SetOption { option: upper.to_string(), value: value.trim().to_string() })
        }
        _ => Some(ConsoleCommand::Unsupported { verb: "SET".to_string() }),
    }
}

/// Parse one line as a psql backslash command. Only the describe/list verbs
/// are recognized; every other backslash command returns `None` and keeps its
/// existing pass-through-to-server behaviour (visible failure), matching the
/// psql control-command handling in the splitter.
pub fn parse_psql_console_command(statement: &str) -> Option<ConsoleCommand> {
    let trimmed = statement.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let rest = trimmed.strip_prefix('\\')?;
    let (verb, args) = split_first_word(rest);
    match verb {
        // `\d` and `\d+` with no pattern list tables (psql semantics); with
        // an argument they describe that object.
        "d" | "d+" if args.trim().is_empty() => Some(ConsoleCommand::ListTables { pattern: String::new() }),
        "d" | "d+" => Some(ConsoleCommand::Describe { object: args.trim().to_string() }),
        "dt" | "dt+" => Some(ConsoleCommand::ListTables { pattern: args.trim().to_string() }),
        _ => None,
    }
}

/// Split `word remainder…` at the first whitespace run.
fn split_first_word(text: &str) -> (&str, &str) {
    let trimmed = text.trim_start();
    match trimmed.find(char::is_whitespace) {
        Some(pos) => (&trimmed[..pos], &trimmed[pos..]),
        None => (trimmed, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(statement: &str) -> Option<ConsoleCommand> {
        parse_sqlplus_console_command(statement, true)
    }

    #[test]
    fn parses_describe_with_abbreviations_and_case() {
        assert_eq!(parse("DESC emp"), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(parse("descr emp"), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(parse("Describe SCOTT.EMP"), Some(ConsoleCommand::Describe { object: "SCOTT.EMP".into() }));
        assert_eq!(parse("  DESC emp  "), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(parse("DESC emp;"), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(parse("DESC \"My Table\""), Some(ConsoleCommand::Describe { object: "\"My Table\"".into() }));
        assert_eq!(parse("DESC"), Some(ConsoleCommand::Describe { object: String::new() }));
    }

    #[test]
    fn parses_execute_show_prompt_exit_and_rerun() {
        assert_eq!(
            parse("EXEC dbms_stats.gather_table_stats('S','T')"),
            Some(ConsoleCommand::Execute { call: "dbms_stats.gather_table_stats('S','T')".into() })
        );
        assert_eq!(parse("execute :x := 1"), Some(ConsoleCommand::Execute { call: ":x := 1".into() }));
        assert_eq!(parse("SHO USER"), Some(ConsoleCommand::Show { item: "user".into() }));
        assert_eq!(parse("show user"), Some(ConsoleCommand::Show { item: "user".into() }));
        assert_eq!(parse("PROMPT step 1; load"), Some(ConsoleCommand::Prompt { text: "step 1; load".into() }));
        assert_eq!(parse("pro hi"), Some(ConsoleCommand::Prompt { text: "hi".into() }));
        assert_eq!(parse("EXIT"), Some(ConsoleCommand::Exit));
        assert_eq!(parse("quit;"), Some(ConsoleCommand::Exit));
        assert_eq!(parse("RUN"), Some(ConsoleCommand::Rerun));
    }

    #[test]
    fn parses_set_options_and_passes_server_sql_through() {
        assert_eq!(
            parse("SET TIMING ON"),
            Some(ConsoleCommand::SetOption { option: "TIMING".into(), value: "ON".into() })
        );
        assert_eq!(
            parse("set serveroutput on"),
            Some(ConsoleCommand::SetOption { option: "SERVEROUTPUT".into(), value: "on".into() })
        );
        assert_eq!(
            parse("SET PAGESIZE 100;"),
            Some(ConsoleCommand::SetOption { option: "PAGESIZE".into(), value: "100".into() })
        );
        // Server SQL starting with SET stays on the SQL path.
        assert_eq!(parse("SET TRANSACTION READ ONLY"), None);
        assert_eq!(parse("SET ROLE DBA"), None);
        assert_eq!(parse("SET CONSTRAINT ALL IMMEDIATE"), None);
        assert_eq!(parse("SET CONSTRAINTS ALL DEFERRED;"), None);
        // Unknown SET option is a client-side skip, like SQL*Plus SP2-0158.
        assert_eq!(parse("SET BOGUS 1"), Some(ConsoleCommand::Unsupported { verb: "SET".into() }));
        assert_eq!(parse("SET"), Some(ConsoleCommand::Unsupported { verb: "SET".into() }));
    }

    #[test]
    fn recognized_unsupported_verbs_and_start_shorthand() {
        assert_eq!(parse("SPOOL out.txt"), Some(ConsoleCommand::Unsupported { verb: "SPOOL".into() }));
        assert_eq!(parse("DEFINE n = 1"), Some(ConsoleCommand::Unsupported { verb: "DEFINE".into() }));
        assert_eq!(parse("@init.sql"), Some(ConsoleCommand::Unsupported { verb: "START".into() }));
        assert_eq!(parse("REMARK a comment"), Some(ConsoleCommand::Unsupported { verb: "REMARK".into() }));
    }

    #[test]
    fn unknown_words_and_structures_stay_sql() {
        assert_eq!(parse("SELECT 1"), None);
        assert_eq!(parse("DESCRIPTION"), None);
        assert_eq!(parse("EXECUTION_LOG"), None);
        assert_eq!(parse("SETTINGS_TABLE"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse(";"), None);
        assert_eq!(parse("SELECT 1\nFROM t"), None);
        assert_eq!(parse("/"), None);
    }

    #[test]
    fn disql_commands_keep_native_set_sql_on_the_server() {
        for statement in ["DESC emp", "EXEC p(1)", "SHOW USER", "PROMPT hi", "RUN", "EXIT", "SET TIMING ON"] {
            assert!(parse_console_command_for_database(statement, DatabaseType::Dameng).is_some(), "{statement}");
        }
        for statement in [
            "SET SCHEMA DBX_TEST",
            "SET SESSION TRANSACTION READ WRITE",
            "SET IDENTITY_INSERT t ON",
            "SET TRANSACTION READ ONLY",
            "SET CONSTRAINTS ALL IMMEDIATE",
            "SET TIME ZONE '+08:00'",
            "SET TIME",
            "SET",
        ] {
            assert_eq!(parse_console_command_for_database(statement, DatabaseType::Dameng), None, "{statement}");
        }
        assert_eq!(
            crate::sql::console_command_family_for_database(DatabaseType::Dameng),
            Some(ConsoleCommandFamily::Disql)
        );
        assert_eq!(crate::sql::console_command_family_for_database(DatabaseType::OceanbaseOracle), None);
    }

    #[test]
    fn disabled_dialect_never_matches() {
        assert_eq!(parse_sqlplus_console_command("DESC emp", false), None);
        assert_eq!(parse_sqlplus_console_command("SET TIMING ON", false), None);
    }

    #[test]
    fn psql_describe_and_list_commands_parse() {
        assert_eq!(parse_psql_console_command("\\d emp"), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(parse_psql_console_command("\\d+ emp"), Some(ConsoleCommand::Describe { object: "emp".into() }));
        assert_eq!(
            parse_psql_console_command("  \\d public.emp  "),
            Some(ConsoleCommand::Describe { object: "public.emp".into() })
        );
        assert_eq!(parse_psql_console_command("\\d"), Some(ConsoleCommand::ListTables { pattern: String::new() }));
        assert_eq!(parse_psql_console_command("\\d+"), Some(ConsoleCommand::ListTables { pattern: String::new() }));
        assert_eq!(parse_psql_console_command("\\dt"), Some(ConsoleCommand::ListTables { pattern: String::new() }));
        assert_eq!(parse_psql_console_command("\\dt+"), Some(ConsoleCommand::ListTables { pattern: String::new() }));
        assert_eq!(parse_psql_console_command("\\dt t*"), Some(ConsoleCommand::ListTables { pattern: "t*".into() }));
        // Other psql meta commands keep their pass-through behaviour.
        assert_eq!(parse_psql_console_command("\\dv"), None);
        assert_eq!(parse_psql_console_command("\\l"), None);
        assert_eq!(parse_psql_console_command("\\timing on"), None);
        assert_eq!(parse_psql_console_command("SELECT 1"), None);
        assert_eq!(parse_psql_console_command(""), None);
    }

    #[test]
    fn verb_word_recognition_for_splitter() {
        assert!(is_console_command_word("DESC"));
        assert!(is_console_command_word("describe"));
        assert!(is_console_command_word("SPOOL"));
        assert!(is_console_command_word("SET"));
        assert!(is_console_command_word("@init.sql"));
        assert!(is_console_command_word("@@init.sql"));
        assert!(!is_console_command_word("SELECT"));
        assert!(!is_console_command_word("DESCRIPTION"));
        assert!(!is_console_command_word("SETTINGS"));
        assert!(!is_console_command_word("@"));
    }
}
