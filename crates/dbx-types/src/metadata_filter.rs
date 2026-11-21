use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableNameFilter {
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
}

impl TableNameFilter {
    pub fn is_empty(&self) -> bool {
        self.include_patterns.iter().all(|pattern| pattern.trim().is_empty())
            && self.exclude_patterns.iter().all(|pattern| pattern.trim().is_empty())
    }
}

pub fn sql_like_pattern_matches_case_insensitive(pattern: &str, value: &str) -> bool {
    #[derive(Clone, Copy)]
    enum LikeToken {
        Any,
        One,
        Literal(char),
    }

    let mut tokens = Vec::new();
    let pattern = pattern.trim().to_lowercase();
    let mut pattern_chars = pattern.chars().peekable();
    while let Some(ch) = pattern_chars.next() {
        match ch {
            '%' => tokens.push(LikeToken::Any),
            '_' => tokens.push(LikeToken::One),
            '\\' => tokens.push(LikeToken::Literal(pattern_chars.next().unwrap_or('\\'))),
            literal => tokens.push(LikeToken::Literal(literal)),
        }
    }
    let value_chars: Vec<char> = value.to_lowercase().chars().collect();

    let mut previous = vec![false; value_chars.len() + 1];
    previous[0] = true;
    for token in tokens {
        let mut current = vec![false; value_chars.len() + 1];
        match token {
            LikeToken::Any => {
                current[0] = previous[0];
                for value_index in 1..=value_chars.len() {
                    current[value_index] = previous[value_index] || current[value_index - 1];
                }
            }
            LikeToken::One => {
                current[1..].copy_from_slice(&previous[..value_chars.len()]);
            }
            LikeToken::Literal(literal) => {
                for value_index in 1..=value_chars.len() {
                    current[value_index] = previous[value_index - 1] && value_chars[value_index - 1] == literal;
                }
            }
        }
        previous = current;
    }
    previous[value_chars.len()]
}

pub fn table_name_filter_matches(name: &str, filter: Option<&TableNameFilter>) -> bool {
    let Some(filter) = filter.filter(|filter| !filter.is_empty()) else {
        return true;
    };
    let include_patterns: Vec<&str> =
        filter.include_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    let exclude_patterns: Vec<&str> =
        filter.exclude_patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()).collect();
    let included = include_patterns.is_empty()
        || include_patterns.iter().any(|pattern| sql_like_pattern_matches_case_insensitive(pattern, name));
    included && !exclude_patterns.iter().any(|pattern| sql_like_pattern_matches_case_insensitive(pattern, name))
}
