use super::*;
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, Tokenizer, Word};

#[derive(Clone, PartialEq)]
pub struct NativeJobSchedulerReferenceTarget {
    pub kind: NativeJobReferenceKind,
    pub reference: NativeJobObjectReference,
}

/// Normalize one reference without treating dots or commas inside quoted names as separators.
/// Ordinary action bodies are not references. NULL means an explicit detach, with no new target.
pub fn native_job_scheduler_reference_target(
    attribute: &str,
    value: &Value,
    job_owner: &str,
    job_type: &str,
) -> Result<Option<NativeJobSchedulerReferenceTarget>, &'static str> {
    let default_kind = match attribute.to_ascii_uppercase().as_str() {
        "PROGRAM_NAME" => NativeJobReferenceKind::Program,
        "SCHEDULE_NAME" => NativeJobReferenceKind::Schedule,
        "CREDENTIAL_NAME" | "CONNECT_CREDENTIAL_NAME" => NativeJobReferenceKind::Credential,
        "DESTINATION_NAME" => NativeJobReferenceKind::Destination,
        "JOB_ACTION" if job_type.eq_ignore_ascii_case("CHAIN") => NativeJobReferenceKind::Chain,
        _ => return Ok(None),
    };
    if value.is_null() {
        return Ok(None);
    }
    let invalid = "native_job_reference_input_invalid";
    let (kind, reference) = match value {
        Value::Object(object) => {
            let reference: NativeJobObjectReference = serde_json::from_value(value.clone()).map_err(|_| invalid)?;
            let kind = object
                .get("kind")
                .map(|kind| serde_json::from_value(kind.clone()).map_err(|_| invalid))
                .transpose()?
                .unwrap_or(default_kind);
            (kind, reference)
        }
        Value::String(name) => (default_kind, legacy_reference(name, job_owner)?),
        _ => return Err(invalid),
    };
    let compatible = kind == default_kind
        || matches!(
            (default_kind, kind),
            (NativeJobReferenceKind::Schedule, NativeJobReferenceKind::Window | NativeJobReferenceKind::WindowGroup)
                | (NativeJobReferenceKind::Destination, NativeJobReferenceKind::DestinationGroup)
        );
    if !compatible || [&reference.owner, &reference.name].iter().any(|value| value.is_empty() || value.contains('\0')) {
        return Err(invalid);
    }
    Ok(Some(NativeJobSchedulerReferenceTarget { kind, reference }))
}

fn legacy_reference(value: &str, job_owner: &str) -> Result<NativeJobObjectReference, &'static str> {
    let invalid = "native_job_reference_input_invalid";
    if value.contains('\0') {
        return Err(invalid);
    }
    let tokens = Tokenizer::new(&OracleDialect {}, value).tokenize().map_err(|_| invalid)?;
    // Skip spacing, not comments: a native object-name value is not a SQL statement.
    let tokens: Vec<_> = tokens
        .into_iter()
        .filter(|token| {
            !matches!(
                token,
                Token::Whitespace(
                    sqlparser::tokenizer::Whitespace::Space
                        | sqlparser::tokenizer::Whitespace::Newline
                        | sqlparser::tokenizer::Whitespace::Tab
                )
            )
        })
        .collect();
    let identifier = |word: &Word| match word.quote_style {
        Some('"') => Ok(word.value.clone()),
        None => Ok(word.value.to_uppercase()),
        _ => Err(invalid),
    };
    match tokens.as_slice() {
        [Token::Word(name)] => Ok(NativeJobObjectReference { owner: job_owner.into(), name: identifier(name)? }),
        [Token::Word(owner), Token::Period, Token::Word(name)] => {
            Ok(NativeJobObjectReference { owner: identifier(owner)?, name: identifier(name)? })
        }
        _ => Err(invalid),
    }
}
