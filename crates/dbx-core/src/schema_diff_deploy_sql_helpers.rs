// Per-object DDL emitters used by generate_schema_sync_sql_inner.
// Included into schema_diff.rs so they can access the module's private helpers.

use crate::sql_dialect::ddl_profile::RenameColumnSyntax;

fn emit_function_diff_lines(
    diff: &FunctionDiff,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
) -> Vec<String> {
    let profile = profile_for(db_type);
    let mut lines = Vec::new();
    lines.push(String::new());
    match diff.diff_type.as_str() {
        "added" | "modified" => {
            if let Some(source) = &diff.source {
                if let Some(template) = profile.function_create_template {
                    let verb = if diff.diff_type == "added" { "Create" } else { "Alter" };
                    lines.push(format!("-- {verb} function: {}", diff.name));
                    let create_kw = if profile.create_function_or_replace {
                        "CREATE OR REPLACE FUNCTION"
                    } else {
                        "CREATE FUNCTION"
                    };
                    let name = qualified_name(&diff.name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[("create_kw", create_kw), ("name", &name), ("definition", &source.definition)],
                    ));
                } else {
                    lines.push(format!(
                        "-- Skip function {}: target database does not support function DDL generation",
                        diff.name
                    ));
                }
            }
        }
        "removed" => {
            if let Some(template) = profile.function_drop_template {
                lines.push(format!("-- Drop function: {}", diff.name));
                let name = qualified_name(&diff.name, db_type, schema);
                lines.push(DdlDialectProfile::render_template(
                    template,
                    &[("name", &name), ("cascade", cascade)],
                ));
            } else {
                lines.push(format!("-- Skip drop function {}: unsupported on target", diff.name));
            }
        }
        _ => {}
    }
    lines
}

fn emit_sequence_diff_lines(
    diff: &SequenceDiff,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
) -> Vec<String> {
    let profile = profile_for(db_type);
    let mut lines = Vec::new();
    lines.push(String::new());
    match diff.diff_type.as_str() {
        "added" => {
            if let Some(source) = &diff.source {
                if let Some(template) = profile.sequence_create_template {
                    lines.push(format!("-- Create sequence: {}", diff.name));
                    let name = qualified_name(&diff.name, db_type, schema);
                    let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[
                            ("name", &name),
                            ("data_type", &source.data_type),
                            ("start_value", &source.start_value),
                            ("increment", &source.increment),
                            ("min_value", &source.min_value),
                            ("max_value", &source.max_value),
                            ("cycle", cycle),
                        ],
                    ));
                } else {
                    lines.push(format!(
                        "-- Skip sequence {}: target database does not support sequence DDL generation",
                        diff.name
                    ));
                }
            }
        }
        "removed" => {
            if let Some(template) = profile.sequence_drop_template {
                lines.push(format!("-- Drop sequence: {}", diff.name));
                let name = qualified_name(&diff.name, db_type, schema);
                lines.push(DdlDialectProfile::render_template(
                    template,
                    &[("name", &name), ("cascade", cascade)],
                ));
            } else {
                lines.push(format!("-- Skip drop sequence {}: unsupported on target", diff.name));
            }
        }
        "modified" => {
            if let Some(source) = &diff.source {
                if let Some(template) = profile.sequence_alter_template {
                    lines.push(format!("-- Alter sequence: {}", diff.name));
                    let name = qualified_name(&diff.name, db_type, schema);
                    let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[
                            ("name", &name),
                            ("data_type", &source.data_type),
                            ("start_value", &source.start_value),
                            ("increment", &source.increment),
                            ("min_value", &source.min_value),
                            ("max_value", &source.max_value),
                            ("cycle", cycle),
                        ],
                    ));
                } else {
                    lines.push(format!("-- Skip alter sequence {}: unsupported on target", diff.name));
                }
            }
        }
        _ => {}
    }
    lines
}

fn emit_rule_diff_lines(
    diff: &RuleDiff,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
) -> Vec<String> {
    let profile = profile_for(db_type);
    let mut lines = Vec::new();
    lines.push(String::new());
    if profile.rule_drop_template.is_none() && !profile.supports_rule_ddl {
        lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
        return lines;
    }
    match diff.diff_type.as_str() {
        "added" => {
            if let Some(source) = &diff.source {
                if profile.supports_rule_ddl {
                    lines.push(format!("-- Create rule: {}", diff.name));
                    lines.push(source.definition.clone());
                } else {
                    lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                }
            }
        }
        "removed" => {
            if let Some(template) = profile.rule_drop_template {
                lines.push(format!("-- Drop rule: {}", diff.name));
                if let Some(rule) = diff.source.as_ref().or(diff.target.as_ref()) {
                    let table_name = qualified_name(&rule.table_name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                    ));
                }
            } else {
                lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
            }
        }
        "modified" => {
            if let Some(source) = &diff.source {
                if let Some(template) = profile.rule_drop_template {
                    lines.push(format!("-- Alter rule: {}", diff.name));
                    let table_name = qualified_name(&source.table_name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                    ));
                    lines.push(source.definition.clone());
                } else {
                    lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                }
            }
        }
        _ => {}
    }
    lines
}

fn emit_owner_diff_lines(
    diff: &OwnerDiff,
    db_type: DatabaseType,
    schema: Option<&str>,
) -> Vec<String> {
    let profile = profile_for(db_type);
    let mut lines = Vec::new();
    lines.push(String::new());
    if let (Some(source), Some(_target)) = (&diff.source, &diff.target) {
        if let Some(template) = profile.owner_alter_template {
            let object_type = match source.object_type.as_str() {
                "TABLE" => "TABLE",
                "VIEW" => "VIEW",
                "SEQUENCE" => "SEQUENCE",
                _ => "TABLE",
            };
            let name = qualified_name(&diff.object_name, db_type, schema);
            lines.push(DdlDialectProfile::render_template(
                template,
                &[("object_type", object_type), ("name", &name), ("owner", &source.owner)],
            ));
        } else {
            lines.push(format!("-- Skip OWNER change for {}: unsupported on target", diff.object_name));
        }
    }
    lines
}

fn emit_table_diff_lines(
    diff: &TableDiff,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
) -> (Vec<String>, Vec<MissingRollbackObject>) {
    let mut lines = Vec::new();
    let mut missing_objects: Vec<MissingRollbackObject> = Vec::new();
    let profile = profile_for(db_type);
    let table = qualified_name(&diff.name, db_type, schema);

    let map_type = |source_type: &str| -> String {
        let tgt = DialectKind::from_database_type(db_type);
        if let Some(user_target) = FieldMapping::apply_with_params(field_mappings, source_type, tgt) {
            return user_target;
        }
        rewrite_column_type(source_type, db_type, source_dialect)
    };

    if diff.diff_type == "added" && diff.object_type.as_deref() != Some("view") {
        let has_structured_snapshot = diff.columns.as_ref().is_some_and(|columns| !columns.is_empty());
        let is_rollback_recreation = diff.ddl.is_none() && diff.target_ddl.is_some();
        let is_same_dialect = source_dialect
            .map(|src| DialectKind::from_database_type(db_type) == src)
            .unwrap_or(false);
        if is_rollback_recreation {
            if has_structured_snapshot {
                let trigger_infos: Vec<TriggerInfo> = diff
                    .triggers
                    .as_ref()
                    .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                let (generated, missing) = generate_create_table_sql(
                    &diff.name,
                    diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |columns| columns.as_slice()),
                    diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |indexes| indexes.as_slice()),
                    diff.foreign_keys
                        .as_ref()
                        .map_or(&[] as &[ForeignKeyDiff], |foreign_keys| foreign_keys.as_slice()),
                    diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()),
                    db_type,
                    schema,
                    None,
                    field_mappings,
                    &trigger_infos,
                );
                if !generated.is_empty() {
                    lines.push(generated);
                }
                missing_objects.extend(missing);
            } else if let Some(ddl) = diff.target_ddl.as_deref() {
                lines.push(format!("-- Recreate table from native target DDL: {}", diff.name));
                lines.push(format!("{};", ddl.trim_end_matches(';')));
                lines.push(String::new());
            }
        } else if is_same_dialect
            || (source_dialect.is_none()
                && diff.ddl.is_some()
                && (profile.prefers_native_source_ddl || !has_structured_snapshot))
        {
            if let Some(ddl) = &diff.ddl {
                lines.push(format!(
                    "-- Create {}: {}",
                    diff.object_type.as_deref().unwrap_or("table"),
                    diff.name
                ));
                lines.push(format!("{};", ddl));
                lines.push(String::new());
            } else if let Some(cols) = &diff.columns {
                let trigger_infos: Vec<TriggerInfo> = diff
                    .triggers
                    .as_ref()
                    .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                let (gen, missing) = generate_create_table_sql(
                    &diff.name,
                    cols,
                    diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                    diff.foreign_keys
                        .as_ref()
                        .map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                    diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                    db_type,
                    schema,
                    source_dialect,
                    field_mappings,
                    &trigger_infos,
                );
                if !gen.is_empty() {
                    lines.push(gen);
                }
                missing_objects.extend(missing);
            }
        } else if has_structured_snapshot {
            let trigger_infos: Vec<TriggerInfo> = diff
                .triggers
                .as_ref()
                .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
            let (gen, missing) = generate_create_table_sql(
                &diff.name,
                diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |v| v.as_slice()),
                diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                diff.foreign_keys
                    .as_ref()
                    .map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                db_type,
                schema,
                source_dialect,
                field_mappings,
                &trigger_infos,
            );
            if !gen.is_empty() {
                lines.push(gen);
            }
            missing_objects.extend(missing);
        }
        return (lines, missing_objects);
    }

    if diff.diff_type == "added" && diff.object_type.as_deref() == Some("view") {
        lines.push(format!("-- View exists only in source: {}", diff.name));
        lines.push("-- Source view definition is not available from this driver yet.".to_string());
        lines.push(String::new());
        return (lines, missing_objects);
    }

    if diff.diff_type == "removed" {
        lines.push(format!(
            "-- Drop {}: {}",
            diff.object_type.as_deref().unwrap_or("table"),
            diff.name
        ));
        lines.push(drop_object_sql(diff, db_type, schema, cascade));
        lines.push(String::new());
        return (lines, missing_objects);
    }

    if diff.diff_type != "modified" {
        return (lines, missing_objects);
    }

    let mut parts = Vec::new();
    let mut standalone_statements = Vec::new();
    if let Some(foreign_keys) = &diff.foreign_keys {
        for fk in foreign_keys {
            if fk.diff_type == "removed" || fk.diff_type == "modified" {
                lines.push(drop_foreign_key_sql(&diff.name, &fk.name, db_type, schema,
                ));
            }
        }
    }

    if let Some(columns) = &diff.columns {
        let convert_col =
            |col: &ColumnInfo| -> ColumnInfo { ColumnInfo { data_type: map_type(&col.data_type), ..col.clone() } };
        for column in columns {
            match column.diff_type.as_str() {
                "added" => {
                    if let Some(source) = &column.source {
                        parts.push(format!("  ADD COLUMN {}", column_def(&convert_col(source), db_type)));
                    }
                }
                "removed" => {
                    parts.push(format!("  DROP COLUMN {}", quote_id(&column.name, db_type)));
                }
                "modified" => {
                    if let Some(source) = &column.source {
                        let mapped = convert_col(source);
                        if profile.alter_uses_modify_column {
                            if column.changes.iter().any(|change| !change.starts_with("order:")) {
                                parts.push(format!("  MODIFY COLUMN {}", column_def(&mapped, db_type)));
                            }
                        } else {
                            let name = quote_id(&column.name, db_type);
                            if column.changes.iter().any(|change| change.starts_with("type:")) {
                                parts.push(format!("  ALTER COLUMN {name} TYPE {}", mapped.data_type));
                            }
                            if column.changes.iter().any(|change| change.starts_with("nullable:")) {
                                parts.push(if source.is_nullable {
                                    format!("  ALTER COLUMN {name} DROP NOT NULL")
                                } else {
                                    format!("  ALTER COLUMN {name} SET NOT NULL")
                                });
                            }
                            if column.changes.iter().any(|change| change.starts_with("default:")) {
                                parts.push(if let Some(default) = &source.column_default {
                                    format!("  ALTER COLUMN {name} SET DEFAULT {default}")
                                } else {
                                    format!("  ALTER COLUMN {name} DROP DEFAULT")
                                });
                            }
                        }
                    }
                }
                "renamed" => {
                    if let (Some(source), Some(target_col)) = (&column.source, &column.target) {
                        let mapped = convert_col(source);
                        match profile.rename_column {
                            RenameColumnSyntax::MysqlChangeColumn => {
                                let old_name = quote_id(&target_col.name, db_type);
                                parts.push(format!(
                                    "  CHANGE COLUMN {} {}",
                                    old_name,
                                    column_def(&mapped, db_type)
                                ));
                            }
                            RenameColumnSyntax::RenameColumn => {
                                let old_name = quote_id(&target_col.name, db_type);
                                let new_name = quote_id(&column.name, db_type);
                                parts.push(format!("  RENAME COLUMN {old_name} TO {new_name}"));
                                if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                    parts.push(format!("  ALTER COLUMN {new_name} TYPE {}", mapped.data_type));
                                }
                                if source.is_nullable != target_col.is_nullable {
                                    let action = if source.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                                    parts.push(format!("  ALTER COLUMN {new_name} {action}"));
                                }
                            }
                            RenameColumnSyntax::AlterColumnRenameTo => {
                                let old_name = quote_id(&target_col.name, db_type);
                                let new_name = quote_id(&column.name, db_type);
                                parts.push(format!("  ALTER COLUMN {old_name} RENAME TO {new_name}"));
                                if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                    parts.push(format!(
                                        "  ALTER COLUMN {new_name} SET DATA TYPE {}",
                                        mapped.data_type
                                    ));
                                }
                            }
                            RenameColumnSyntax::SqlServerSpRename => {
                                let target_table = qualified_name(&diff.name, db_type, schema);
                                let full_obj_path =
                                    format!("{target_table}.{}", quote_id(&target_col.name, db_type));
                                standalone_statements.push(format!(
                                    "EXEC sp_rename '{}', '{}', 'COLUMN';",
                                    full_obj_path.replace('\'', "''"),
                                    column.name.replace('\'', "''")
                                ));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if !standalone_statements.is_empty() || !parts.is_empty() {
        lines.push(format!("-- Alter table: {}", diff.name));
        lines.extend(standalone_statements);
        if !parts.is_empty() {
            if profile.alter_batches_clauses {
                lines.push(format!("ALTER TABLE {table}"));
                lines.push(format!("{};", parts.join(",\n")));
            } else {
                for part in parts {
                    lines.push(format!("ALTER TABLE {table}{part};"));
                }
            }
        }
        lines.push(String::new());
    }

    if !profile.column_comment_via_modify_only {
        if let Some(columns) = &diff.columns {
            for column in columns {
                if let Some(source) = &column.source {
                    if column.changes.iter().any(|change| change.starts_with("comment:")) {
                        lines.push(column_comment_sql(
                            &diff.name,
                            &column.name,
                            source.comment.as_deref().unwrap_or_default(),
                            db_type,
                            schema,
                        ));
                    }
                    if column.diff_type == "added" {
                        if let Some(comment) = &source.comment {
                            lines.push(column_comment_sql(&diff.name, &column.name, comment, db_type, schema,
                            ));
                        }
                    }
                    if column.diff_type == "renamed" {
                        if let Some(comment) = &source.comment {
                            lines.push(column_comment_sql(&diff.name, &column.name, comment, db_type, schema,
                            ));
                        }
                    }
                }
            }
        }
    }

    if diff.source_table_comment.is_some() && diff.source_table_comment != diff.target_table_comment {
        let comment = diff
            .source_table_comment
            .as_ref()
            .and_then(|comment| comment.as_deref())
            .unwrap_or_default();
        lines.push(table_comment_sql(&diff.name, comment, db_type, schema,
        ));
    }

    if let Some(indexes) = &diff.indexes {
        for index in indexes {
            match index.diff_type.as_str() {
                "added" => {
                    if let Some(source) = &index.source {
                        lines.push(create_index_sql(&diff.name, source, db_type, schema,
                        ));
                    }
                }
                "removed" => lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema,
                )),
                "modified" => {
                    if let Some(source) = &index.source {
                        lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema,
                        ));
                        lines.push(create_index_sql(&diff.name, source, db_type, schema,
                        ));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(foreign_keys) = &diff.foreign_keys {
        for fk in foreign_keys {
            if fk.diff_type == "added" || fk.diff_type == "modified" {
                if let Some(source) = &fk.source {
                    lines.push(add_foreign_key_sql(&diff.name, source, db_type, schema,
                    ));
                }
            }
        }
    }

    if let Some(triggers) = &diff.triggers {
        for trigger in triggers {
            lines.push(format!(
                "-- Trigger {}: {} on {}; review trigger definition manually.",
                trigger.diff_type, trigger.name, diff.name
            ));
        }
    }

    if diff.indexes.as_ref().is_some_and(|indexes| !indexes.is_empty())
        || diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
        || diff.triggers.as_ref().is_some_and(|triggers| !triggers.is_empty())
    {
        lines.push(String::new());
    }

    if profile.warn_fk_needs_table_rebuild
        && diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
    {
        lines.push(format!(
            "-- Foreign key synchronization may require table rebuild for: {}",
            diff.name
        ));
        lines.push(String::new());
    }

    (lines, missing_objects)
}
