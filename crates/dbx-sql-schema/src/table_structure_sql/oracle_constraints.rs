use std::ops::ControlFlow;

use sqlparser::ast::{Expr, Visitor};
use sqlparser::dialect::OracleDialect;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, Tokenizer};

use super::dialect::StructureDialect;
use super::util::{qualified_table, quote_ident};
use super::{
    OracleCheckConstraint, OracleConstraintChange, OracleConstraintDefinition, TableStructureSqlOptions,
    TableStructureSqlResult,
};
use crate::models::connection::DatabaseType;

pub(super) fn build_changes(options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let changes = options.oracle_constraint_changes.as_deref().unwrap_or_default();
    let reject = |message: &str| TableStructureSqlResult { statements: vec![], warnings: vec![message.into()] };
    let Some(database_type @ (DatabaseType::Oracle | DatabaseType::OceanbaseOracle)) = options.database_type else {
        return reject("CHECK and UNIQUE changes require Oracle or OceanBase Oracle.");
    };
    if options.is_gaussdb_m_mode {
        return reject("Apply CHECK or UNIQUE changes separately from other table structure drafts.");
    }
    let mut ordinary_options = options.clone();
    ordinary_options.oracle_constraint_changes = None;
    let ordinary = super::build_table_structure_change_sql(ordinary_options);
    if !ordinary.statements.is_empty() || !ordinary.warnings.is_empty() {
        return reject("Apply CHECK or UNIQUE changes separately from other table structure drafts.");
    }

    let mut names = std::collections::HashSet::new();
    for change in changes {
        let (original, target) = match (&change.original, &change.target) {
            (None, None) => return reject("A constraint change must have an original or target definition."),
            (original, target) => (original, target),
        };
        if database_type == DatabaseType::Oracle {
            if let Some(OracleConstraintDefinition::Unique(old)) = original {
                let requires_drop = match target {
                    None => true,
                    Some(OracleConstraintDefinition::Unique(new)) => {
                        old.columns != new.columns || old.state.deferrable != new.state.deferrable
                    }
                    Some(_) => true,
                };
                if requires_drop && !matches!(change.index_policy.as_str(), "keep" | "drop") {
                    return reject("Oracle UNIQUE rebuilds require an explicit KEEP INDEX or DROP INDEX choice.");
                }
                if old.state.enabled
                    && target.as_ref().is_some_and(
                        |value| matches!(value, OracleConstraintDefinition::Unique(new) if !new.state.enabled),
                    )
                    && !matches!(change.index_policy.as_str(), "keep" | "drop")
                {
                    return reject(
                        "Disabling an Oracle UNIQUE constraint requires an explicit KEEP INDEX or DROP INDEX choice.",
                    );
                }
            }
        }
        for (is_original, definition) in [(true, original.as_ref()), (false, target.as_ref())] {
            let Some(definition) = definition else { continue };
            let name = match definition {
                OracleConstraintDefinition::Check(check) => &check.name,
                OracleConstraintDefinition::Unique(unique) => &unique.name,
            };
            if name.trim().is_empty() {
                return reject("Constraint names must not be empty.");
            }
            match definition {
                OracleConstraintDefinition::Check(check) => {
                    if let Err(message) = validate_check(check, database_type == DatabaseType::Oracle) {
                        return reject(message);
                    }
                }
                OracleConstraintDefinition::Unique(unique) => {
                    if let Err(message) = validate_unique(
                        unique,
                        database_type,
                        options.schema.as_deref(),
                        &options.table_name,
                        is_original,
                        &change.index_policy,
                    ) {
                        return reject(message);
                    }
                }
            }
        }
        if let Some(target) = target.as_ref() {
            let name = match target {
                OracleConstraintDefinition::Check(check) => &check.name,
                OracleConstraintDefinition::Unique(unique) => &unique.name,
            };
            if !names.insert(name.clone()) {
                return reject("Target constraint names must not repeat.");
            }
        }
    }

    let dialect = StructureDialect::Oracle;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();
    let mut validated_statements = Vec::new();
    for OracleConstraintChange { original, target, index_policy } in changes {
        if original == target {
            continue;
        }
        match (original, target) {
            (None, Some(OracleConstraintDefinition::Check(check))) => {
                statements.push(add_check(&table, check, database_type))
            }
            (Some(OracleConstraintDefinition::Check(old)), None) => statements.push(drop_constraint(&table, &old.name)),
            (Some(OracleConstraintDefinition::Check(old)), Some(OracleConstraintDefinition::Check(new))) => {
                if old.expression != new.expression
                    || old.state.deferrable != new.state.deferrable
                    || (database_type == DatabaseType::OceanbaseOracle && old.name != new.name)
                {
                    statements.push(drop_constraint(&table, &old.name));
                    statements.push(add_check(&table, new, database_type));
                } else if old.name != new.name && old.state == new.state {
                    if database_type == DatabaseType::Oracle {
                        statements.push(format!(
                            "ALTER TABLE {table} RENAME CONSTRAINT {} TO {};",
                            quote_ident(dialect, &old.name),
                            quote_ident(dialect, &new.name)
                        ));
                    } else {
                        statements.push(drop_constraint(&table, &old.name));
                        statements.push(add_check(&table, new, database_type));
                    }
                } else if old.state != new.state {
                    if old.state.deferrable != new.state.deferrable {
                        statements.push(drop_constraint(&table, &old.name));
                        statements.push(add_check(&table, new, database_type));
                    } else {
                        let name = quote_ident(dialect, &old.name);
                        if old.state.enabled != new.state.enabled || old.state.validated != new.state.validated {
                            let enabled = if new.state.enabled { "ENABLE" } else { "DISABLE" };
                            let validated = if new.state.validated { "VALIDATE" } else { "NOVALIDATE" };
                            statements.push(format!("ALTER TABLE {table} {enabled} {validated} CONSTRAINT {name};"));
                        }
                        if old.state.rely != new.state.rely {
                            statements.push(format!(
                                "ALTER TABLE {table} MODIFY CONSTRAINT {name} {};",
                                if new.state.rely { "RELY" } else { "NORELY" }
                            ));
                        }
                        if old.state.initially_deferred != new.state.initially_deferred {
                            statements.push(format!(
                                "ALTER TABLE {table} MODIFY CONSTRAINT {name} INITIALLY {};",
                                if new.state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }
                            ));
                        }
                        if old.name != new.name {
                            statements.push(format!(
                                "ALTER TABLE {table} RENAME CONSTRAINT {} TO {};",
                                quote_ident(dialect, &old.name),
                                quote_ident(dialect, &new.name)
                            ));
                        }
                    }
                }
            }
            (None, Some(OracleConstraintDefinition::Unique(unique))) => {
                if let Some(statement) = add_unique(&table, unique, database_type, index_policy) {
                    statements.push(statement);
                } else {
                    return reject("A verified supporting index or a collision-free new index name is required.");
                }
            }
            (Some(OracleConstraintDefinition::Unique(old)), None) => {
                statements.push(drop_unique(&table, old, database_type, index_policy));
            }
            (Some(OracleConstraintDefinition::Unique(old)), Some(OracleConstraintDefinition::Unique(new))) => {
                if database_type == DatabaseType::Oracle
                    && old.columns == new.columns
                    && old.name != new.name
                    && old.state == new.state
                {
                    statements.push(format!(
                        "ALTER TABLE {table} RENAME CONSTRAINT {} TO {};",
                        quote_ident(dialect, &old.name),
                        quote_ident(dialect, &new.name)
                    ));
                } else if old.columns == new.columns && (old.name == new.name || database_type == DatabaseType::Oracle)
                {
                    if old.state != new.state {
                        if old.state.deferrable != new.state.deferrable {
                            statements.push(drop_unique(&table, old, database_type, index_policy));
                            if let Some(statement) = add_unique(&table, new, database_type, index_policy) {
                                statements.push(statement);
                            } else {
                                return reject(
                                    "A verified supporting index or a collision-free new index name is required.",
                                );
                            }
                        } else {
                            let name = quote_ident(dialect, &old.name);
                            if database_type == DatabaseType::Oracle
                                && !old.state.enabled
                                && new.state.enabled
                                && old.index.name.is_empty()
                            {
                                if let Some(statement) = add_unique(&table, new, database_type, index_policy) {
                                    statements.push(drop_unique(&table, old, database_type, "keep"));
                                    statements.push(statement);
                                } else {
                                    return reject("Re-enabling a UNIQUE constraint without an index requires a collision-free supporting-index name.");
                                }
                                continue;
                            }
                            if old.state.enabled != new.state.enabled || old.state.validated != new.state.validated {
                                let enabled = if new.state.enabled { "ENABLE" } else { "DISABLE" };
                                let validated = if new.state.validated { "VALIDATE" } else { "NOVALIDATE" };
                                let index_clause =
                                    if database_type == DatabaseType::Oracle && old.state.enabled && !new.state.enabled
                                    {
                                        match index_policy.as_str() {
                                        "keep" => " KEEP INDEX",
                                        "drop" => " DROP INDEX",
                                        _ => return reject(
                                            "Disabling an Oracle UNIQUE constraint requires KEEP INDEX or DROP INDEX.",
                                        ),
                                    }
                                    } else {
                                        ""
                                    };
                                statements.push(format!(
                                    "ALTER TABLE {table} {enabled} {validated} CONSTRAINT {name}{index_clause};"
                                ));
                            }
                            if old.state.rely != new.state.rely {
                                statements.push(format!(
                                    "ALTER TABLE {table} MODIFY CONSTRAINT {name} {};",
                                    if new.state.rely { "RELY" } else { "NORELY" }
                                ));
                            }
                            if old.state.initially_deferred != new.state.initially_deferred {
                                statements.push(format!(
                                    "ALTER TABLE {table} MODIFY CONSTRAINT {name} INITIALLY {};",
                                    if new.state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }
                                ));
                            }
                            if old.name != new.name {
                                statements.push(format!(
                                    "ALTER TABLE {table} RENAME CONSTRAINT {} TO {};",
                                    quote_ident(dialect, &old.name),
                                    quote_ident(dialect, &new.name)
                                ));
                            }
                        }
                    }
                } else {
                    statements.push(drop_unique(&table, old, database_type, index_policy));
                    if let Some(statement) = add_unique(&table, new, database_type, index_policy) {
                        statements.push(statement);
                    } else {
                        return reject("A verified supporting index or a collision-free new index name is required.");
                    }
                }
            }
            _ => return reject("This CHECK/UNIQUE change shape is not supported yet."),
        }
    }
    for statement in statements {
        if statement.to_ascii_uppercase().contains(" CHECK (") {
            let tokens = match Tokenizer::new(&OracleDialect, &statement).tokenize() {
                Ok(tokens) => tokens,
                Err(_) => return reject("Generated CHECK DDL failed structural validation."),
            };
            let check_token = tokens
                .iter()
                .position(|token| matches!(token, Token::Word(word) if word.value.eq_ignore_ascii_case("CHECK")));
            let Some(check_token) = check_token else {
                return reject("Generated CHECK DDL failed structural validation.");
            };
            let open = tokens
                .iter()
                .enumerate()
                .skip(check_token + 1)
                .find(|(_, token)| matches!(token, Token::LParen))
                .map(|(index, _)| index);
            let Some(open) = open else {
                return reject("Generated CHECK DDL failed structural validation.");
            };
            let mut depth = 0usize;
            let mut close = None;
            for (index, token) in tokens.iter().enumerate().skip(open) {
                match token {
                    Token::LParen => depth += 1,
                    Token::RParen => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(index);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(close) = close else {
                return reject("Generated CHECK DDL failed structural validation.");
            };
            if close <= open {
                return reject("Generated CHECK DDL failed structural validation.");
            }
        }
        validated_statements.push(statement);
    }
    TableStructureSqlResult { statements: validated_statements, warnings: vec![] }
}

fn validate_unique(
    unique: &super::OracleUniqueConstraint,
    database_type: DatabaseType,
    schema: Option<&str>,
    table_name: &str,
    is_original: bool,
    index_policy: &str,
) -> Result<(), &'static str> {
    if unique.columns.is_empty() || unique.columns.iter().any(|column| column.trim().is_empty()) {
        return Err("UNIQUE constraints require nonempty ordered columns.");
    }
    if unique.columns.iter().collect::<std::collections::HashSet<_>>().len() != unique.columns.len() {
        return Err("UNIQUE constraint columns must not repeat.");
    }
    if unique.state.initially_deferred && !unique.state.deferrable {
        return Err("Initially deferred UNIQUE constraints must be deferrable.");
    }
    if database_type == DatabaseType::OceanbaseOracle
        && (!unique.state.enabled
            || !unique.state.validated
            || unique.state.deferrable
            || unique.state.initially_deferred
            || unique.state.rely
            || (is_original && unique.rely_raw != "NULL"))
    {
        return Err("OceanBase Oracle UNIQUE changes require the verified ENABLED, VALIDATED, NOT DEFERRABLE, IMMEDIATE, RELY NULL state.");
    }
    if database_type == DatabaseType::OceanbaseOracle && index_policy != "none" {
        return Err("OceanBase Oracle manages a UNIQUE constraint and its paired index as one object.");
    }
    if database_type == DatabaseType::Oracle && !matches!(index_policy, "keep" | "drop" | "none") {
        return Err("UNIQUE supporting index policy is not supported.");
    }
    if index_policy == "drop" && unique.index.sharing != "exclusive" {
        return Err("A supporting index cannot be dropped when sharing is known or unknown.");
    }
    if is_original && unique.index.name.trim().is_empty() {
        if !unique.index.metadata_complete || unique.state.enabled {
            return Err("An enabled UNIQUE constraint requires a complete supporting-index identity.");
        }
    } else if !unique.index.name.trim().is_empty() {
        let index = &unique.index;
        if !index.metadata_complete
            || index.owner.trim().is_empty()
            || index.name.trim().is_empty()
            || index.owner != schema.unwrap_or_default()
            || index.table_owner != schema.unwrap_or_default()
            || index.table_name != table_name
            || index.index_type != "NORMAL"
            || (unique.state.deferrable && index.uniqueness != "NONUNIQUE")
            || !matches!(index.uniqueness.as_str(), "UNIQUE" | "NONUNIQUE")
            || index.status != "VALID"
            || index.partitioned
            || index.visibility != "VISIBLE"
            || match database_type {
                DatabaseType::Oracle => index.secondary.as_deref().is_some_and(|value| value != "N"),
                DatabaseType::OceanbaseOracle => index.secondary.is_some(),
                _ => true,
            }
            || index.columns.len() != unique.columns.len()
            || !same_identifier_set(&index.columns, &unique.columns)
            || index.directions.len() != index.columns.len()
            || index.directions.iter().any(|direction| direction != "ASC")
            || index.key_is_expression.len() != index.columns.len()
            || index.key_is_expression.iter().any(|is_expression| *is_expression)
            || !index.included_columns.is_empty()
        {
            return Err("UNIQUE supporting index metadata is incomplete or outside the verified ordinary-index shape.");
        }
    } else if database_type == DatabaseType::Oracle
        && unique.state.enabled
        && (unique.index.new_name.as_deref().is_none_or(str::is_empty)
            || !unique.index.new_name_available
            || unique.index.owner != schema.unwrap_or_default())
    {
        return Err("A collision-free new UNIQUE index name is required.");
    }
    if unique.index.new_name.as_deref().is_some_and(str::is_empty)
        || (unique.index.new_name.is_some() && !unique.index.new_name_available)
        || (unique.index.new_name.is_some() && unique.index.owner != schema.unwrap_or_default())
    {
        return Err("The replacement UNIQUE index name is missing or already in use.");
    }
    Ok(())
}

fn validate_check(check: &OracleCheckConstraint, oracle: bool) -> Result<(), &'static str> {
    if check.expression.trim().is_empty() {
        return Err("CHECK expression must not be empty.");
    }
    let mut parser = Parser::new(&OracleDialect)
        .try_with_sql(&check.expression)
        .map_err(|_| "CHECK expression is not supported by the Oracle expression parser.")?;
    let expression =
        parser.parse_expr().map_err(|_| "CHECK expression is not supported by the Oracle expression parser.")?;
    if !matches!(parser.peek_token().token, Token::EOF) {
        return Err("CHECK expression must contain exactly one expression.");
    }
    struct SubqueryGuard(bool);
    impl Visitor for SubqueryGuard {
        type Break = ();
        fn pre_visit_expr(&mut self, expression: &Expr) -> ControlFlow<Self::Break> {
            if matches!(expression, Expr::Subquery(_) | Expr::InSubquery { .. } | Expr::Exists { .. }) {
                self.0 = true;
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        }
    }
    let mut guard = SubqueryGuard(false);
    let _ = sqlparser::ast::Visit::visit(&expression, &mut guard);
    if guard.0 {
        return Err("Subqueries are not supported in CHECK expressions.");
    }
    if (check.state.initially_deferred && !check.state.deferrable)
        || (!oracle && (check.state.deferrable || check.state.initially_deferred || check.state.rely))
    {
        return Err("This CHECK constraint state is not supported.");
    }
    Ok(())
}

fn add_check(table: &str, check: &OracleCheckConstraint, database_type: DatabaseType) -> String {
    format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} CHECK (\n{}\n){};",
        quote_ident(StructureDialect::Oracle, &check.name),
        check.expression,
        constraint_state_suffix(&check.state, database_type)
    )
}

fn add_unique(
    table: &str,
    unique: &super::OracleUniqueConstraint,
    database_type: DatabaseType,
    index_policy: &str,
) -> Option<String> {
    let dialect = StructureDialect::Oracle;
    let columns = unique.columns.iter().map(|column| quote_ident(dialect, column)).collect::<Vec<_>>().join(", ");
    let index = &unique.index;
    let using_index = if !unique.state.enabled || database_type == DatabaseType::OceanbaseOracle {
        String::new()
    } else if !index.name.is_empty()
        && index.metadata_complete
        && index_policy != "drop"
        && index.sharing == "exclusive"
        && if unique.state.deferrable {
            index.uniqueness == "NONUNIQUE"
        } else {
            matches!(index.uniqueness.as_str(), "UNIQUE" | "NONUNIQUE")
        }
        && same_identifier_set(&index.columns, &unique.columns)
    {
        format!(" USING INDEX {}", qualified_table(dialect, Some(&index.owner), &index.name))
    } else {
        let new_name = index.new_name.as_deref()?;
        let index_ref = qualified_table(dialect, Some(&index.owner), new_name);
        let kind = if unique.state.deferrable || !unique.state.validated { "INDEX" } else { "UNIQUE INDEX" };
        format!(" USING INDEX (CREATE {kind} {index_ref} ON {table} ({columns}))")
    };
    // OceanBase UNIQUE only supports the default state already enforced by validate_unique.
    let (before_index, after_index) = if database_type == DatabaseType::OceanbaseOracle {
        (String::new(), String::new())
    } else {
        constraint_state_parts(&unique.state, database_type)
    };
    Some(format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} UNIQUE ({columns}){before_index}{using_index}{after_index};",
        quote_ident(dialect, &unique.name),
    ))
}

fn drop_unique(
    table: &str,
    unique: &super::OracleUniqueConstraint,
    database_type: DatabaseType,
    index_policy: &str,
) -> String {
    let index_clause = match (database_type, index_policy) {
        (DatabaseType::Oracle, "keep") => " KEEP INDEX",
        (DatabaseType::Oracle, "drop") => " DROP INDEX",
        _ => "",
    };
    format!(
        "ALTER TABLE {table} DROP CONSTRAINT {}{index_clause};",
        quote_ident(StructureDialect::Oracle, &unique.name)
    )
}

fn constraint_state_parts(state: &super::OraclePrimaryKeyState, database_type: DatabaseType) -> (String, String) {
    let enabled = if state.enabled { "ENABLE" } else { "DISABLE" };
    let validated = if state.validated { "VALIDATE" } else { "NOVALIDATE" };
    let rely = if state.rely { "RELY" } else { "NORELY" };
    if database_type == DatabaseType::Oracle {
        (
            format!(
                " {} INITIALLY {} {rely}",
                if state.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
                if state.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }
            ),
            format!(" {enabled} {validated}"),
        )
    } else {
        (String::new(), format!(" {enabled} {validated}"))
    }
}

fn constraint_state_suffix(state: &super::OraclePrimaryKeyState, database_type: DatabaseType) -> String {
    let (before_index, after_index) = constraint_state_parts(state, database_type);
    format!("{before_index}{after_index}")
}

fn same_identifier_set(left: &[String], right: &[String]) -> bool {
    left.len() == right.len() && left.iter().all(|left| right.iter().any(|right| left == right))
}

fn drop_constraint(table: &str, name: &str) -> String {
    format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(StructureDialect::Oracle, name))
}

#[cfg(test)]
mod additional_tests {
    use super::*;

    #[test]
    fn check_add_keeps_closing_parenthesis_outside_line_comment() {
        let check = OracleCheckConstraint {
            name: "CK_T".into(),
            expression: "A > 0 -- tail comment".into(),
            state: super::super::OraclePrimaryKeyState {
                enabled: true,
                validated: true,
                deferrable: false,
                initially_deferred: false,
                rely: false,
            },
        };
        let sql = add_check("\"APP\".\"T\"", &check, DatabaseType::Oracle);
        assert!(sql
            .contains("CHECK (\nA > 0 -- tail comment\n) NOT DEFERRABLE INITIALLY IMMEDIATE NORELY ENABLE VALIDATE;"));
    }
}
