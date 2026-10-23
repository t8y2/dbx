use crate::models::connection::DatabaseType;
use crate::sql_dialect::can_unquote_identifier;
use sqlparser::dialect::{Dialect, GenericDialect, MsSqlDialect};
use sqlparser::tokenizer::{Token, Tokenizer};

pub(super) fn unquote_optional_identifiers(
    reference: String,
    database_type: Option<DatabaseType>,
    identifier_quote: Option<&str>,
) -> String {
    let dialect: &dyn Dialect =
        if database_type == Some(DatabaseType::SqlServer) { &MsSqlDialect {} } else { &GenericDialect {} };
    let Ok(tokens) = Tokenizer::new(dialect, &reference).with_unescape(false).tokenize() else {
        return reference;
    };
    if tokens.iter().any(|token| !matches!(token, Token::Word(_) | Token::Period)) {
        return reference;
    }
    tokens
        .into_iter()
        .map(|token| match token {
            Token::Word(mut word) => {
                if word.quote_style.is_some() && can_unquote_identifier(&word.value, database_type, identifier_quote) {
                    word.quote_style = None;
                }
                word.to_string()
            }
            _ => token.to_string(),
        })
        .collect()
}
