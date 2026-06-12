use super::dialect::{database_label, StructureDialect};
use super::types::{EditableStructureTrigger, TableStructureSqlOptions, TriggerInfo};
use super::util::{clean, qualified_table, quote_ident};

pub(super) fn build_trigger_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    if options.triggers.is_empty() {
        return Vec::new();
    }

    let database_label = database_label(options.database_type);
    if super::dialect::capabilities_for(options.database_type).dialect != StructureDialect::Mysql {
        warnings.push(format!("Editing triggers is not supported for {database_label} from this editor."));
        return Vec::new();
    }

    let table = qualified_table(StructureDialect::Mysql, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();

    for trigger in &options.triggers {
        if trigger.marked_for_drop {
            if let Some(original) = &trigger.original {
                statements.push(drop_trigger_sql(options.schema.as_deref(), &original.name));
            }
            continue;
        }

        if let Some(original) = &trigger.original {
            if !has_trigger_change(trigger, original) {
                continue;
            }
            statements.push(drop_trigger_sql(options.schema.as_deref(), &original.name));
        }

        if let Some(sql) = create_trigger_sql(&table, trigger, warnings) {
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

fn drop_trigger_sql(schema: Option<&str>, name: &str) -> String {
    let qualified_name = if schema.is_some_and(|schema| !schema.trim().is_empty()) {
        format!(
            "{}.{}",
            quote_ident(StructureDialect::Mysql, schema.unwrap()),
            quote_ident(StructureDialect::Mysql, name)
        )
    } else {
        quote_ident(StructureDialect::Mysql, name)
    };
    format!("DROP TRIGGER {qualified_name};")
}

fn create_trigger_sql(table: &str, trigger: &EditableStructureTrigger, warnings: &mut Vec<String>) -> Option<String> {
    let name = clean(&trigger.name);
    let timing = normalize_keyword(&trigger.timing);
    let event = normalize_keyword(&trigger.event);
    let statement = clean(&trigger.statement);

    if name.is_empty() || timing.is_empty() || event.is_empty() || statement.is_empty() {
        warnings.push("Trigger name, timing, event, and statement are required.".to_string());
        return None;
    }
    if !matches!(timing.as_str(), "BEFORE" | "AFTER") {
        warnings.push(format!("Unsupported trigger timing \"{}\".", clean(&trigger.timing)));
        return None;
    }
    if !matches!(event.as_str(), "INSERT" | "UPDATE" | "DELETE") {
        warnings.push(format!("Unsupported trigger event \"{}\".", clean(&trigger.event)));
        return None;
    }

    Some(format!(
        "CREATE TRIGGER {} {timing} {event} ON {table} FOR EACH ROW\n{};",
        quote_ident(StructureDialect::Mysql, &name),
        statement.trim_end_matches(';').trim_end()
    ))
}

fn normalize_keyword(value: &str) -> String {
    clean(value).to_ascii_uppercase()
}

fn normalize_statement(value: &str) -> String {
    clean(value).trim_end_matches(';').trim().to_string()
}
