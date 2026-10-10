use super::foreign_key::{qualified, require_alter, require_table};
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDefinition {
    pub name: String,
    pub expression: String,
    pub enabled: bool,
    pub validated: bool,
    pub deferrable: bool,
    pub initially_deferred: bool,
    pub rely: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckChange {
    pub schema: String,
    pub table_name: String,
    pub original_name: Option<String>,
    pub desired: Option<CheckDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckChangePreview {
    pub statements: Vec<String>,
    pub revision: String,
    pub current_constraint: Option<CheckDefinition>,
    pub affected_objects: Vec<String>,
    pub recovery_statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckChangeResult {
    pub success: bool,
    pub steps: Vec<ConstraintChangeStep>,
    pub current_constraint: Option<CheckDefinition>,
    pub original_constraint: Option<CheckDefinition>,
    pub refresh_error: Option<String>,
    pub recovery_statements: Vec<String>,
}

pub async fn preview_check_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: CheckChange,
) -> Result<CheckChangePreview, String> {
    let engine = require_engine(state, connection_id).await?;
    preview_check(&CoreSession { state, connection_id, database, engine }, &change).await
}

pub async fn apply_check_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: CheckChange,
    revision: &str,
) -> Result<CheckChangeResult, String> {
    let engine = require_engine(state, connection_id).await?;
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    crate::query::check_read_only_for_connection(state, &pool_key, "ALTER TABLE").await?;
    let result = apply_check(&CoreSession { state, connection_id, database, engine }, &change, revision).await;
    crate::object_cache::invalidate_connection_object_cache(&state.storage, connection_id).await;
    result
}

// Validate only the expression boundary. Keep the original text for DDL and
// recovery; the returned text converts q-literals for semantic readback parsing.
fn expression_boundary(expression: &str) -> Result<String, String> {
    let chars: Vec<char> = expression.chars().collect();
    if expression.trim().is_empty() || chars.contains(&'\0') {
        return Err("CHECK expression is empty or contains NUL.".into());
    }
    let mut i = 0;
    let mut depth = 0;
    let mut normalized = String::new();
    while i < chars.len() {
        let start = i;
        if chars[i] == '-' && chars.get(i + 1) == Some(&'-') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            normalized.push('\n');
            continue;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 >= chars.len() {
                return Err("Unterminated CHECK expression comment.".into());
            }
            i += 2;
            normalized.push(' ');
            continue;
        }
        if matches!(chars[i], 'q' | 'Q') && chars.get(i + 1) == Some(&'\'') {
            let open = *chars.get(i + 2).ok_or("Unterminated q-quoted literal.")?;
            let close = match open {
                '[' => ']',
                '(' => ')',
                '{' => '}',
                '<' => '>',
                other => other,
            };
            i += 3;
            let content = i;
            while i + 1 < chars.len() && !(chars[i] == close && chars[i + 1] == '\'') {
                i += 1;
            }
            if i + 1 >= chars.len() {
                return Err("Unterminated q-quoted literal.".into());
            }
            normalized.push('\'');
            for character in &chars[content..i] {
                normalized.push(*character);
                if *character == '\'' {
                    normalized.push('\'');
                }
            }
            normalized.push('\'');
            i += 2;
            continue;
        }
        if matches!(chars[i], '\'' | '"') {
            let quote = chars[i];
            i += 1;
            loop {
                if i >= chars.len() {
                    return Err("Unterminated CHECK expression quote.".into());
                }
                if chars[i] == quote {
                    i += 1;
                    if chars.get(i) == Some(&quote) {
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            normalized.extend(chars[start..i].iter());
            continue;
        }
        match chars[i] {
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return Err("CHECK expression closes its outer boundary.".into());
                }
                depth -= 1;
            }
            ';' => return Err("CHECK expression cannot contain a statement delimiter.".into()),
            _ => {}
        }
        normalized.push(chars[i]);
        i += 1;
    }
    if depth != 0 {
        return Err("Unbalanced CHECK expression parentheses.".into());
    }
    Ok(normalized)
}

fn canonical_expression(expression: &str) -> Option<sqlparser::ast::Statement> {
    use sqlparser::{
        ast::{Expr, VisitMut, VisitorMut},
        dialect::GenericDialect,
        parser::Parser,
        tokenizer::{Token, Tokenizer},
    };
    use std::ops::ControlFlow;
    struct Normalize;
    impl VisitorMut for Normalize {
        type Break = ();
        fn post_visit_expr(&mut self, expr: &mut Expr) -> ControlFlow<()> {
            if let Expr::Nested(inner) = expr {
                *expr = *inner.clone();
            }
            match expr {
                Expr::Identifier(identifier) => identifier.quote_style = Some('"'),
                Expr::CompoundIdentifier(identifiers) => {
                    for identifier in identifiers {
                        identifier.quote_style = Some('"');
                    }
                }
                _ => {}
            }
            ControlFlow::Continue(())
        }
    }
    let normalized = expression_boundary(expression).ok()?;
    let tokens = Tokenizer::new(&GenericDialect {}, &normalized).tokenize().ok()?;
    let source = tokens
        .into_iter()
        .map(|token| match token {
            Token::Word(mut word) if word.quote_style.is_none() => {
                word.value = word.value.to_uppercase();
                Token::Word(word).to_string()
            }
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut statements =
        Parser::parse_sql(&GenericDialect {}, &format!("SELECT 1 FROM DBX_CHECK_SOURCE WHERE {source}")).ok()?;
    if statements.len() != 1 {
        return None;
    }
    let _ = statements.visit(&mut Normalize);
    // Compare the normalized tree. Rendering after removing Nested expressions
    // loses parentheses that distinguish different operator groupings.
    Some(statements.remove(0))
}

async fn read_check(
    session: &impl ConstraintSession,
    change: &CheckChange,
    name: &str,
) -> Result<Option<CheckDefinition>, String> {
    let result = read(session,&format!("SELECT CONSTRAINT_NAME,SEARCH_CONDITION,STATUS,VALIDATED,DEFERRABLE,DEFERRED,COALESCE(RELY,'NORELY') FROM ALL_CONSTRAINTS WHERE OWNER={} AND TABLE_NAME={} AND CONSTRAINT_NAME={} AND CONSTRAINT_TYPE='C'",literal(&change.schema),literal(&change.table_name),literal(name))).await?;
    if result.rows.len() > 1 {
        return Err("Ambiguous CHECK constraint metadata.".into());
    }
    let Some(row) = result.rows.first() else { return Ok(None) };
    let key = CheckDefinition {
        name: text(row, 0)?,
        expression: text(row, 1)?,
        enabled: flag(row, 2, "ENABLED", "DISABLED")?,
        validated: flag(row, 3, "VALIDATED", "NOT VALIDATED")?,
        deferrable: flag(row, 4, "DEFERRABLE", "NOT DEFERRABLE")?,
        initially_deferred: flag(row, 5, "DEFERRED", "IMMEDIATE")?,
        rely: flag(row, 6, "RELY", "NORELY")?,
    };
    expression_boundary(&key.expression)?;
    Ok(Some(key))
}

fn check_sql(engine: Engine, change: &CheckChange, key: &CheckDefinition) -> Result<String, String> {
    expression_boundary(&key.expression)?;
    if key.initially_deferred && !key.deferrable {
        return Err("An initially deferred CHECK must be deferrable.".into());
    }
    if engine == Engine::OceanBaseOracle && (key.deferrable || key.initially_deferred) {
        return Err("OceanBase Oracle does not support deferred CHECK constraints.".into());
    }
    let deferred = if engine == Engine::Oracle {
        format!(
            " {} INITIALLY {}",
            if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
            if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }
        )
    } else {
        String::new()
    };
    Ok(format!(
        "ALTER TABLE {} ADD CONSTRAINT {} CHECK (\n{}\n){deferred}{} {} {}",
        qualified(&change.schema, &change.table_name)?,
        identifier(&key.name)?,
        key.expression,
        if key.rely { " RELY" } else { "" },
        if key.enabled { "ENABLE" } else { "DISABLE" },
        if key.validated { "VALIDATE" } else { "NOVALIDATE" }
    ))
}

async fn preview_check(session: &impl ConstraintSession, change: &CheckChange) -> Result<CheckChangePreview, String> {
    let target = qualified(&change.schema, &change.table_name)?;
    if change.original_name.is_none() && change.desired.is_none() {
        return Err("No CHECK change was requested.".into());
    }
    // Reject boundary escapes before sending any expression to the database.
    if let Some(desired) = &change.desired {
        check_sql(session.engine(), change, desired)?;
        let name_identifier = identifier(&desired.name)?;
        let name_probe = match session.engine() {
            Engine::OceanBaseOracle => format!("SELECT LENGTHB({}) FROM DUAL", literal(&desired.name)),
            Engine::Oracle => format!("SELECT 1 AS {name_identifier} FROM DUAL"),
        };
        let name_length = count(session, &name_probe)
            .await
            .map_err(|error| format!("Cannot confirm a valid constraint name; no DDL was executed. {error}"))?;
        if session.engine() == Engine::OceanBaseOracle && name_length > 128 {
            return Err("The constraint name exceeds OceanBase Oracle's 128-byte limit; no DDL was executed.".into());
        }
    }
    let stamp = require_table(session, &change.schema, &change.table_name).await?;
    let identity = read(session, "SELECT USER FROM DUAL").await?;
    let user = text(identity.rows.first().ok_or("Current database user is unavailable.")?, 0)?;
    require_alter(session, &change.schema, &change.table_name, &user).await?;
    let current = match &change.original_name {
        Some(name) => Some(
            read_check(session, change, name).await?.ok_or("The original CHECK constraint is no longer visible.")?,
        ),
        None => None,
    };
    if let Some(old) = &current {
        let nonnullable = read(
            session,
            &format!(
                "SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE OWNER={} AND TABLE_NAME={} AND NULLABLE='N'",
                literal(&change.schema),
                literal(&change.table_name)
            ),
        )
        .await?;
        for row in &nonnullable.rows {
            let expression = format!("{} IS NOT NULL", identifier(&text(row, 0)?)?);
            if canonical_expression(&old.expression)
                .zip(canonical_expression(&expression))
                .is_some_and(|(old, column)| old == column)
            {
                return Err("This CHECK enforces a column NOT NULL property. Edit column nullability instead.".into());
            }
        }
    }
    let recovery =
        current.as_ref().map(|key| check_sql(session.engine(), change, key)).transpose()?.into_iter().collect();
    let mut statements = Vec::new();
    if let Some(desired) = &change.desired {
        let collision = count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_CONSTRAINTS WHERE OWNER={} AND CONSTRAINT_NAME={}",
                literal(&change.schema),
                literal(&desired.name)
            ),
        )
        .await?;
        if collision != u64::from(current.as_ref().is_some_and(|old| old.name == desired.name)) {
            return Err("The CHECK constraint name is already used or its visibility changed.".into());
        }
        let filter = if desired.validated { "ROWNUM=1" } else { "1=0" };
        if count(session, &format!("SELECT COUNT(*) FROM {target} WHERE NOT (\n{}\n) AND {filter}", desired.expression))
            .await?
            != 0
        {
            return Err("Existing rows violate the CHECK expression; no DDL was executed.".into());
        }
        statements.push(check_sql(session.engine(), change, desired)?);
    }
    if current == change.desired {
        statements.clear();
    } else {
        let state_only = current.as_ref().zip(change.desired.as_ref()).is_some_and(|(old, desired)| {
            let mut old = old.clone();
            old.enabled = desired.enabled;
            old.validated = desired.validated;
            old == *desired
        });
        if state_only {
            let desired = change.desired.as_ref().unwrap();
            statements = vec![format!(
                "ALTER TABLE {target} {} {} CONSTRAINT {}",
                if desired.enabled { "ENABLE" } else { "DISABLE" },
                if desired.validated { "VALIDATE" } else { "NOVALIDATE" },
                identifier(&desired.name)?
            )];
        } else if let Some(old) = &current {
            statements.insert(0, format!("ALTER TABLE {target} DROP CONSTRAINT {}", identifier(&old.name)?));
        }
    }
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(session.engine(), change, &current, stamp)).map_err(|error| error.to_string())?
        )
    );
    Ok(CheckChangePreview {
        statements,
        revision,
        current_constraint: current,
        affected_objects: vec![target],
        recovery_statements: recovery,
    })
}

fn same_check(actual: &CheckDefinition, desired: &CheckDefinition) -> bool {
    let mut normalized = actual.clone();
    normalized.expression = desired.expression.clone();
    normalized == *desired
        && (actual.expression == desired.expression
            || canonical_expression(&actual.expression)
                .zip(canonical_expression(&desired.expression))
                .is_some_and(|(actual, desired)| actual == desired))
}

async fn apply_check(
    session: &impl ConstraintSession,
    change: &CheckChange,
    revision: &str,
) -> Result<CheckChangeResult, String> {
    let plan = preview_check(session, change).await?;
    if plan.revision != revision {
        return Err("The CHECK definition changed after preview; no DDL was executed.".into());
    }
    let mut steps = Vec::new();
    for (index, sql) in plan.statements.iter().enumerate() {
        let executed = async {
            if index == 0 {
                if let Some(old) = &plan.current_constraint {
                    if read_check(session, change, &old.name).await?.as_ref() != Some(old) {
                        return Err("The CHECK definition changed during execution.".to_string());
                    }
                }
            }
            session.query(sql).await.map(|_| ())
        }
        .await;
        let success = executed.is_ok();
        steps.push(ConstraintChangeStep { sql: sql.clone(), success, error: executed.err() });
        if !success {
            break;
        }
    }
    let readback = async {
        require_table(session, &change.schema, &change.table_name).await?;
        let original = match &change.original_name {
            Some(name) => read_check(session, change, name).await?,
            None => None,
        };
        let current = match &change.desired {
            Some(desired) if Some(&desired.name) == change.original_name.as_ref() => original.clone(),
            Some(desired) => read_check(session, change, &desired.name).await?,
            None => original.clone(),
        };
        Ok::<_, String>((original, current))
    }
    .await;
    let ((original, current), mut refresh_error) = match readback {
        Ok(value) => (value, None),
        Err(error) => ((None, None), Some(error)),
    };
    let complete = steps.len() == plan.statements.len() && steps.iter().all(|step| step.success);
    let matches = match (&current, &change.desired) {
        (Some(actual), Some(desired)) => same_check(actual, desired),
        (None, None) => true,
        _ => false,
    };
    let desired = matches
        && (change.desired.as_ref().map(|key| &key.name) == change.original_name.as_ref() || original.is_none());
    if complete && refresh_error.is_none() && !desired {
        refresh_error=Some("DDL finished, but the actual CHECK expression or state could not be confirmed. Review the dictionary definition; the change is not marked successful.".into());
    }
    let recovery = if refresh_error.is_none() && original.is_none() && current.is_none() {
        plan.recovery_statements
    } else {
        Vec::new()
    };
    Ok(CheckChangeResult {
        success: complete && desired && refresh_error.is_none(),
        steps,
        current_constraint: current,
        original_constraint: original,
        refresh_error,
        recovery_statements: recovery,
    })
}

#[cfg(test)]
mod tests;
