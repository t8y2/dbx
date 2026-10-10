use super::{has_existing_index_change, TableStructureSqlOptions};
use crate::models::connection::DatabaseType;
use sqlparser::{dialect::GenericDialect, parser::Parser, tokenizer::Token};

// Scope follows the V4.2.5 SQL reference. Other releases require their own
// capability evidence; an unrecognized version is not evidence of no support.
fn documented_version(version: &str) -> bool {
    let version = version.trim();
    let version = version.strip_prefix('v').or_else(|| version.strip_prefix('V')).unwrap_or(version);
    version == "4.2.5" || version.starts_with("4.2.5.") || version.starts_with("4.2.5-")
}

pub(super) fn validate(options: &TableStructureSqlOptions) -> Vec<String> {
    if options.database_type != Some(DatabaseType::OceanbaseOracle) {
        return Vec::new();
    }
    if options.is_gaussdb_m_mode {
        return vec!["OceanBase Oracle cannot use the GaussDB M-mode index dialect.".into()];
    }
    let mut errors = Vec::new();
    for index in &options.indexes {
        if index.marked_for_drop || (index.original.is_some() && !has_existing_index_change(index)) {
            continue;
        }
        let kind = index.index_type.trim().to_ascii_uppercase();
        if kind.is_empty() || kind == "NORMAL" {
            continue;
        }
        let version = options.database_version.as_deref().unwrap_or("").trim();
        if version.is_empty() {
            errors.push(format!("OceanBase Oracle server version is unavailable; index type {kind} has not been verified. Refresh connection metadata."));
            continue;
        }
        if !documented_version(version) {
            errors.push(format!(
                "OceanBase Oracle index type {kind} has not been verified for server version {version}."
            ));
            continue;
        }
        if kind != "FUNCTION-BASED NORMAL" {
            errors.push(format!(
                "OceanBase Oracle 4.2.5 does not support index type {kind}; use NORMAL or FUNCTION-BASED NORMAL."
            ));
            continue;
        }
        if index.columns.is_empty() {
            errors.push(format!("Function index \"{}\" requires an expression.", index.name));
        }
        for expression in &index.columns {
            let parsed = Parser::new(&GenericDialect {}).try_with_sql(expression).and_then(|mut parser| {
                parser.parse_expr()?;
                if parser.peek_token().token == Token::EOF {
                    Ok(())
                } else {
                    Err(sqlparser::parser::ParserError::ParserError("expected one expression".into()))
                }
            });
            if parsed.is_err() {
                errors.push(format!("Function index \"{}\": the editor could not parse one complete SQL expression. No SQL was generated.", index.name));
            }
        }
    }
    errors
}
