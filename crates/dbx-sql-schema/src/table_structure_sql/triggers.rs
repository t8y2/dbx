use super::dialect::{database_label, StructureDialect};
use super::types::{EditableStructureTrigger, TableStructureSqlOptions, TriggerInfo};
use super::util::{clean, qualified_new_table, qualified_table, quote_ident, quote_new_ident};

pub(super) fn build_trigger_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    build_trigger_sql_with_mode(options, warnings, false)
}

pub(super) fn build_trigger_sql_for_new_table(
    options: &TableStructureSqlOptions,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    build_trigger_sql_with_mode(options, warnings, true)
}

fn build_trigger_sql_with_mode(
    options: &TableStructureSqlOptions,
    warnings: &mut Vec<String>,
    for_new_table: bool,
) -> Vec<String> {
    if options.triggers.is_empty() {
        return Vec::new();
    }

    let dialect = super::dialect::capabilities_for(options.database_type, options.driver_profile.as_deref()).dialect;
    let database_label = database_label(options.database_type);
    if !matches!(dialect, StructureDialect::Mysql | StructureDialect::Oracle | StructureDialect::SqlServer) {
        if options.triggers.iter().any(has_trigger_edit) {
            warnings.push(format!("Editing triggers is not supported for {database_label} from this editor."));
        }
        return Vec::new();
    }

    let table = if for_new_table {
        qualified_new_table(options.database_type, dialect, options.schema.as_deref(), &options.table_name)
    } else {
        qualified_table(dialect, options.schema.as_deref(), &options.table_name)
    };
    let mut statements = Vec::new();

    for trigger in &options.triggers {
        if trigger.marked_for_drop {
            if let Some(original) = &trigger.original {
                statements.push(drop_trigger_sql(dialect, options.schema.as_deref(), &original.name));
            }
            continue;
        }

        if let Some(original) = &trigger.original {
            if dialect == StructureDialect::Oracle {
                if has_trigger_change(trigger, original) {
                    warnings.push(format!(
                        "Editing existing Oracle trigger \"{}\" requires its complete source definition.",
                        original.name
                    ));
                }
                continue;
            }
            if !has_trigger_change(trigger, original) {
                continue;
            }
            // Oracle can replace a trigger in place; renames still require dropping the old object.
            if dialect != StructureDialect::Oracle || clean(&trigger.name) != clean(&original.name) {
                statements.push(drop_trigger_sql(dialect, options.schema.as_deref(), &original.name));
            }
        }

        if let Some(sql) = create_trigger_sql(
            options.database_type,
            dialect,
            options.schema.as_deref(),
            &table,
            trigger,
            warnings,
            for_new_table,
        ) {
            statements.push(sql);
            // SQL Server rebuilds via DROP + CREATE, which resets is_disabled to
            // enabled; restore the catalog-reported disabled state explicitly.
            // `table` is already qualified the same way the CREATE's ON clause is.
            if dialect == StructureDialect::SqlServer
                && trigger.original.as_ref().is_some_and(|original| original.enabled == Some(false))
            {
                let schema = options.schema.as_deref();
                let trigger_name = qualified_trigger_object_name(dialect, schema, &trigger.name);
                statements.push(format!("DISABLE TRIGGER {trigger_name} ON {table};"));
            }
        }
    }

    statements
}

fn qualified_trigger_object_name(dialect: StructureDialect, schema: Option<&str>, name: &str) -> String {
    if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!("{}.{}", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, name))
    } else {
        quote_ident(dialect, name)
    }
}

fn has_trigger_edit(trigger: &EditableStructureTrigger) -> bool {
    trigger.marked_for_drop || trigger.original.as_ref().is_none_or(|original| has_trigger_change(trigger, original))
}

fn has_trigger_change(trigger: &EditableStructureTrigger, original: &TriggerInfo) -> bool {
    clean(&trigger.name) != clean(&original.name)
        || normalize_keyword(&trigger.timing) != normalize_keyword(&original.timing)
        || normalize_keyword(&trigger.event) != normalize_keyword(&original.event)
        || normalize_statement(&trigger.statement) != normalize_statement(original.statement.as_deref().unwrap_or(""))
}

fn drop_trigger_sql(dialect: StructureDialect, schema: Option<&str>, name: &str) -> String {
    let qualified_name = if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!("{}.{}", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, name))
    } else {
        quote_ident(dialect, name)
    };
    format!("DROP TRIGGER {qualified_name};")
}

fn create_trigger_sql(
    database_type: Option<crate::models::connection::DatabaseType>,
    dialect: StructureDialect,
    schema: Option<&str>,
    table: &str,
    trigger: &EditableStructureTrigger,
    warnings: &mut Vec<String>,
    for_new_table: bool,
) -> Option<String> {
    let name = clean(&trigger.name);
    let timing = normalize_keyword(&trigger.timing);
    let event = clean(&trigger.event);
    let statement = clean(&trigger.statement);

    if name.is_empty() || timing.is_empty() || event.is_empty() || statement.is_empty() {
        warnings.push("Trigger name, timing, event, and statement are required.".to_string());
        return None;
    }
    match dialect {
        StructureDialect::Mysql => create_mysql_trigger_sql(table, &name, &timing, &event, &statement, warnings),
        StructureDialect::SqlServer => {
            create_sqlserver_trigger_sql(schema, table, &name, &timing, &event, &statement, warnings)
        }
        StructureDialect::Oracle => create_oracle_trigger_sql(
            database_type,
            schema,
            table,
            &name,
            &timing,
            &event,
            &statement,
            warnings,
            for_new_table,
        ),
        _ => None,
    }
}

fn create_sqlserver_trigger_sql(
    schema: Option<&str>,
    table: &str,
    name: &str,
    timing: &str,
    event: &str,
    statement: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    if !matches!(timing, "AFTER" | "INSTEAD OF") {
        warnings.push(format!("Unsupported SQL Server trigger timing \"{timing}\"."));
        return None;
    }

    let mut events = Vec::new();
    for item in event.split([',', '\n']) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let normalized_item = item.to_ascii_uppercase();
        for event in normalized_item.split(" OR ") {
            let event = event.trim().to_string();
            if !matches!(event.as_str(), "INSERT" | "UPDATE" | "DELETE") {
                warnings.push(format!("Unsupported SQL Server trigger event \"{}\".", item));
                return None;
            }
            if !events.contains(&event) {
                events.push(event);
            }
        }
    }
    if events.is_empty() {
        warnings.push("SQL Server trigger event is required.".to_string());
        return None;
    }

    let trigger_name = if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!(
            "{}.{}",
            quote_ident(StructureDialect::SqlServer, schema.unwrap()),
            quote_ident(StructureDialect::SqlServer, name)
        )
    } else {
        quote_ident(StructureDialect::SqlServer, name)
    };
    let body = sqlserver_trigger_body(statement);
    if body.is_empty() {
        warnings.push("SQL Server trigger statement is required.".to_string());
        return None;
    }
    Some(format!(
        "CREATE TRIGGER {trigger_name} ON {table} {timing} {} AS\n{};",
        events.join(", "),
        body.trim_end_matches(';').trim_end()
    ))
}

fn sqlserver_trigger_body(statement: &str) -> &str {
    let statement = statement.trim();
    if statement.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("AS")) {
        return statement[2..].trim_start();
    }
    if !statement.to_ascii_uppercase().starts_with("CREATE TRIGGER") {
        return statement;
    }

    // The body separator is the standalone AS that follows the event list
    // (`... AFTER INSERT, UPDATE AS <body>`); earlier AS tokens can appear in
    // trigger options such as `WITH EXECUTE AS OWNER`, so the first standalone
    // AS alone is not a reliable split point.
    let mut seen_event = false;
    let mut token = String::new();
    let mut char_indices = statement.char_indices().peekable();
    while let Some((index, ch)) = char_indices.next() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            token.push(ch);
            if !char_indices.peek().is_some_and(|(_, next)| next.is_ascii_alphanumeric() || *next == '_') {
                if token.eq_ignore_ascii_case("AS") && seen_event {
                    return statement[index + 1..].trim_start();
                }
                if matches!(token.to_ascii_uppercase().as_str(), "INSERT" | "UPDATE" | "DELETE" | "LOGON") {
                    seen_event = true;
                }
                token.clear();
            }
        } else {
            token.clear();
        }
    }
    statement
}

fn create_mysql_trigger_sql(
    table: &str,
    name: &str,
    timing: &str,
    event: &str,
    statement: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let event = normalize_keyword(event);
    if !matches!(timing, "BEFORE" | "AFTER") {
        warnings.push(format!("Unsupported trigger timing \"{timing}\"."));
        return None;
    }
    if !matches!(event.as_str(), "INSERT" | "UPDATE" | "DELETE") {
        warnings.push(format!("Unsupported trigger event \"{}\".", clean(&event)));
        return None;
    }

    Some(format!(
        "CREATE TRIGGER {} {timing} {event} ON {table} FOR EACH ROW\n{};",
        quote_ident(StructureDialect::Mysql, name),
        statement.trim_end_matches(';').trim_end()
    ))
}

fn create_oracle_trigger_sql(
    database_type: Option<crate::models::connection::DatabaseType>,
    schema: Option<&str>,
    table: &str,
    name: &str,
    timing: &str,
    event: &str,
    statement: &str,
    warnings: &mut Vec<String>,
    for_new_table: bool,
) -> Option<String> {
    let Some((timing_clause, row_level)) = oracle_trigger_timing(timing) else {
        warnings.push(format!("Unsupported Oracle trigger timing \"{timing}\"."));
        return None;
    };
    if !is_supported_oracle_trigger_event(event) {
        warnings.push(format!("Unsupported Oracle trigger event \"{}\".", clean(event)));
        return None;
    }

    let trigger_identifier = if for_new_table {
        quote_new_ident(database_type, StructureDialect::Oracle, name)
    } else {
        quote_ident(StructureDialect::Oracle, name)
    };
    let trigger_name = if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!("{}.{}", quote_ident(StructureDialect::Oracle, schema.unwrap()), trigger_identifier)
    } else {
        trigger_identifier
    };
    let row_clause = if row_level { "\nFOR EACH ROW" } else { "" };
    let statement = oracle_trigger_body(statement);
    if starts_with_trigger_declaration(statement) {
        // Oracle triggers are edited through their complete source definition, so a declaration we
        // could not strip means dumping the raw statement after our own `FOR EACH ROW` would send
        // invalid DDL to the server (ORA-04079) and abort the clone half way.
        warnings.push(format!(
            "Trigger \"{name}\" could not be cloned automatically; its stored source is not a plain PL/SQL body. Recreate it manually on {table}."
        ));
        return None;
    }
    let statement = statement.trim_end().trim_end_matches('/').trim_end().trim_end_matches(';').trim_end();
    if statement.is_empty() {
        warnings.push(format!("Trigger \"{name}\" has an empty body and was skipped."));
        return None;
    }

    Some(format!(
        "CREATE OR REPLACE TRIGGER {trigger_name} {timing_clause} {event} ON {table}{row_clause}\n{statement};"
    ))
}

/// Oracle triggers come back from the driver as `ALL_SOURCE` text. When the dictionary declaration
/// and the stored source cannot be aligned line by line — a trigger written on a single line — the
/// raw source is returned instead of the body, and appending it after our own `FOR EACH ROW`
/// produces invalid DDL (`ORA-04079`). Strip the declaration the same way `sqlserver_trigger_body`
/// strips `CREATE TRIGGER ... AS`.
fn oracle_trigger_body(statement: &str) -> &str {
    let statement = statement.trim();
    if !starts_with_trigger_declaration(statement) {
        return statement;
    }
    match oracle_trigger_body_start(statement) {
        Some(index) => statement[index..].trim_end(),
        None => statement,
    }
}

fn starts_with_trigger_declaration(statement: &str) -> bool {
    let keywords = leading_keywords(statement, 4);
    match keywords.first().map(String::as_str) {
        Some("TRIGGER") => true,
        Some("CREATE") => keywords.iter().any(|keyword| keyword == "TRIGGER"),
        _ => false,
    }
}

fn leading_keywords(statement: &str, limit: usize) -> Vec<String> {
    let mut keywords = Vec::new();
    let mut current = String::new();
    for ch in statement.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch.to_ascii_uppercase());
            continue;
        }
        if !current.is_empty() {
            keywords.push(std::mem::take(&mut current));
            if keywords.len() == limit {
                return keywords;
            }
        }
    }
    if !current.is_empty() && keywords.len() < limit {
        keywords.push(current);
    }
    keywords
}

/// Returns the offset where the PL/SQL block of an Oracle trigger declaration starts, skipping
/// string literals, quoted identifiers, and comments so a `WHEN` condition cannot be mistaken for
/// the body. The declaration always closes with the `ON <table>` clause before the body begins.
fn oracle_trigger_body_start(statement: &str) -> Option<usize> {
    let bytes = statement.as_bytes();
    let mut index = 0;
    let mut seen_on = false;
    let mut word_start: Option<usize> = None;
    while index < bytes.len() {
        let ch = bytes[index] as char;
        if ch == '\'' || ch == '"' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] as char == ch {
                    index += 1;
                    break;
                }
                index += 1;
            }
            word_start = None;
            continue;
        }
        if ch == '-' && bytes.get(index + 1) == Some(&b'-') {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            word_start = None;
            continue;
        }
        if ch == '/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            word_start = None;
            continue;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word_start.get_or_insert(index);
            index += 1;
            continue;
        }
        if let Some(start) = word_start.take() {
            let word = &statement[start..index];
            if is_oracle_trigger_body_keyword(word, seen_on) {
                return Some(start);
            }
            if word.eq_ignore_ascii_case("ON") {
                seen_on = true;
            }
        }
        index += 1;
    }
    if let Some(start) = word_start {
        let word = &statement[start..];
        if is_oracle_trigger_body_keyword(word, seen_on) {
            return Some(start);
        }
    }
    None
}

fn is_oracle_trigger_body_keyword(word: &str, seen_on: bool) -> bool {
    seen_on
        && (word.eq_ignore_ascii_case("DECLARE")
            || word.eq_ignore_ascii_case("BEGIN")
            || word.eq_ignore_ascii_case("CALL"))
}

fn oracle_trigger_timing(timing: &str) -> Option<(&'static str, bool)> {
    match timing {
        "BEFORE" | "BEFORE EACH ROW" => Some(("BEFORE", true)),
        "AFTER" | "AFTER EACH ROW" => Some(("AFTER", true)),
        "INSTEAD OF" | "INSTEAD OF EACH ROW" => Some(("INSTEAD OF", true)),
        "BEFORE STATEMENT" => Some(("BEFORE", false)),
        "AFTER STATEMENT" => Some(("AFTER", false)),
        _ => None,
    }
}

fn is_supported_oracle_trigger_event(event: &str) -> bool {
    if event.contains([';', '\n', '\r']) || event.contains("--") || event.contains("/*") {
        return false;
    }
    let upper = event.to_ascii_uppercase();
    let clauses: Vec<&str> = upper.split(" OR ").map(str::trim).collect();
    !clauses.is_empty()
        && clauses.iter().all(|clause| {
            matches!(*clause, "INSERT" | "DELETE")
                || *clause == "UPDATE"
                || clause.strip_prefix("UPDATE OF ").is_some_and(|columns| !columns.trim().is_empty())
        })
}

fn normalize_keyword(value: &str) -> String {
    clean(value).to_ascii_uppercase()
}

fn normalize_statement(value: &str) -> String {
    clean(value).trim_end_matches(';').trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlserver_trigger_body_splits_after_event_list_not_execute_as() {
        // The AS inside `WITH EXECUTE AS OWNER` must not be treated as the body separator.
        let source = "CREATE TRIGGER dbo.t ON dbo.tbl WITH EXECUTE AS OWNER AFTER INSERT AS PRINT 'x'";
        assert_eq!(sqlserver_trigger_body(source), "PRINT 'x'");
        let no_options = "CREATE TRIGGER dbo.t ON dbo.tbl AFTER UPDATE AS SELECT 1 AS a";
        assert_eq!(sqlserver_trigger_body(no_options), "SELECT 1 AS a");
        let leading_as = "AS SELECT 2";
        assert_eq!(sqlserver_trigger_body(leading_as), "SELECT 2");
    }

    #[test]
    fn oracle_trigger_body_strips_single_line_dictionary_source() {
        // Oracle stores a trigger written on one line with its declaration and body on the same
        // line, so the driver cannot align ALL_SOURCE with the dictionary DESCRIPTION and returns
        // the whole statement. t8y2/dbx#9731.
        let source = "trigger dbx_v1_trg_bi before insert on dbx_v1_trg for each row begin null; end;";
        assert_eq!(oracle_trigger_body(source), "begin null; end;");

        let with_when = "TRIGGER audit_trg BEFORE INSERT ON \"HR\".\"ORDERS\" FOR EACH ROW WHEN (NEW.STATUS <> 'BEGIN') BEGIN NULL; END;";
        assert_eq!(oracle_trigger_body(with_when), "BEGIN NULL; END;");

        let full_ddl = "CREATE OR REPLACE TRIGGER \"HR\".\"AUDIT_TRG\" BEFORE INSERT ON \"HR\".\"ORDERS\" FOR EACH ROW\nDECLARE\n  v NUMBER;\nBEGIN\n  NULL;\nEND;";
        assert_eq!(oracle_trigger_body(full_ddl), "DECLARE\n  v NUMBER;\nBEGIN\n  NULL;\nEND;");

        let call_trigger = "TRIGGER call_trg BEFORE INSERT ON HR.ORDERS FOR EACH ROW CALL log_insert()";
        assert_eq!(oracle_trigger_body(call_trigger), "CALL log_insert()");
    }

    #[test]
    fn oracle_trigger_body_keeps_plain_bodies_untouched() {
        let body = "DECLARE\n  v NUMBER;\nBEGIN\n  v := 1; -- ON BEGIN\nEND;";
        assert_eq!(oracle_trigger_body(body), body);

        // A body that merely mentions the keywords must not be truncated.
        let literal = "BEGIN\n  INSERT INTO log_v2 VALUES ('on', 'begin');\nEND;";
        assert_eq!(oracle_trigger_body(literal), literal);

        // Without the ON clause the declaration cannot be split safely, so the source is kept.
        let unsplittable = "TRIGGER odd_trg COMPOUND TRIGGER";
        assert_eq!(oracle_trigger_body(unsplittable), unsplittable);
    }
}
