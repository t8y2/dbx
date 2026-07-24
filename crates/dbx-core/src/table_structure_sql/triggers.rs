use super::dialect::{database_label, StructureDialect};
use super::types::{EditableStructureTrigger, TableStructureSqlOptions, TriggerInfo};
use super::util::{clean, qualified_table, quote_ident};

pub(super) fn build_trigger_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    if options.triggers.is_empty() {
        return Vec::new();
    }

    let dialect = super::dialect::capabilities_for(options.database_type).dialect;
    let database_label = database_label(options.database_type);
    if !matches!(dialect, StructureDialect::Mysql | StructureDialect::Oracle) {
        warnings.push(format!("Editing triggers is not supported for {database_label} from this editor."));
        return Vec::new();
    }

    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();

    for trigger in &options.triggers {
        if trigger.marked_for_drop {
            if let Some(original) = &trigger.original {
                statements.push(drop_trigger_sql(dialect, options.schema.as_deref(), &original.name));
            }
            continue;
        }

        if let Some(original) = &trigger.original {
            if !has_trigger_change(trigger, original) {
                continue;
            }
            // Oracle can replace a trigger in place; renames still require dropping the old object.
            if dialect != StructureDialect::Oracle || clean(&trigger.name) != clean(&original.name) {
                statements.push(drop_trigger_sql(dialect, options.schema.as_deref(), &original.name));
            }
        }

        if let Some(sql) = create_trigger_sql(dialect, options.schema.as_deref(), &table, trigger, warnings) {
            statements.push(sql);
        }
    }

    statements
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
    dialect: StructureDialect,
    schema: Option<&str>,
    table: &str,
    trigger: &EditableStructureTrigger,
    warnings: &mut Vec<String>,
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
        StructureDialect::Oracle => {
            create_oracle_trigger_sql(schema, table, &name, &timing, &event, &statement, warnings)
        }
        _ => None,
    }
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
    schema: Option<&str>,
    table: &str,
    name: &str,
    timing: &str,
    event: &str,
    statement: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let Some((timing_clause, row_level)) = oracle_trigger_timing(timing) else {
        warnings.push(format!("Unsupported Oracle trigger timing \"{timing}\"."));
        return None;
    };
    if !is_supported_oracle_trigger_event(event) {
        warnings.push(format!("Unsupported Oracle trigger event \"{}\".", clean(event)));
        return None;
    }

    let trigger_name = if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!(
            "{}.{}",
            quote_ident(StructureDialect::Oracle, schema.unwrap()),
            quote_ident(StructureDialect::Oracle, name)
        )
    } else {
        quote_ident(StructureDialect::Oracle, name)
    };
    let row_clause = if row_level { "\nFOR EACH ROW" } else { "" };
    let statement = statement.trim_end().trim_end_matches('/').trim_end().trim_end_matches(';').trim_end();

    Some(format!(
        "CREATE OR REPLACE TRIGGER {trigger_name} {timing_clause} {event} ON {table}{row_clause}\n{statement};"
    ))
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
