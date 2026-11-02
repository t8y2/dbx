use super::{
    value_text, write_bytes, DataGridArrayFormat, DataGridDsvOptions, DataGridExtractError, DataGridExtractErrorCode,
    DataGridHeaderCase, DataGridHeaderFormat, DataGridHeaderPosition, DataGridQuotePolicy, ExtractContext,
};
use std::borrow::Cow;
use std::io::Write;

const MAX_SEPARATOR_CHARACTERS: usize = 8;
const MAX_NULL_TEXT_CHARACTERS: usize = 64;

/// A single DSV data cell. NULL is carried as structured state (not pre-flattened
/// into the `null_text` string) so the sentinel can be encoded distinctly from a
/// string value that happens to equal it.
enum DsvCell<'a> {
    Null,
    Text(Cow<'a, str>, bool, bool),
}

pub(super) fn write_dsv(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
    options: &DataGridDsvOptions,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    validate_dsv_options(options, true)?;
    let header_position = match options.header_position {
        DataGridHeaderPosition::Top | DataGridHeaderPosition::Bottom => Some(options.header_position),
        DataGridHeaderPosition::Legacy if options.include_column_header => Some(DataGridHeaderPosition::Top),
        DataGridHeaderPosition::Legacy | DataGridHeaderPosition::None => None,
    };
    let mut first_row = true;
    if header_position == Some(DataGridHeaderPosition::Top) {
        first_row = false;
        write_dsv_header_rows(context, output, options, quote_char_triggers_quoting)?;
    }
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if !first_row {
            write_bytes(output, options.row_separator.as_bytes())?;
        }
        write_dsv_data_row(
            output,
            context.selected_source_indexes.iter().zip(&context.selected_columns).map(|(source_index, column)| {
                let value = &row[*source_index];
                if value.is_null() {
                    DsvCell::Null
                } else {
                    let is_numeric_string =
                        value.as_str().is_some_and(|text| !text.is_empty() && text.parse::<f64>().is_ok());
                    let numeric_type = is_numeric_type(column.data_type.as_deref());
                    let mut text = format_array_value(
                        value_text(value).into_owned(),
                        value,
                        column.data_type.as_deref(),
                        options.array_format,
                    );
                    text = replace_line_feeds(text, &options.line_feed_escape_string);
                    let is_numeric =
                        value.is_number() || (numeric_type && text.parse::<f64>().is_ok()) || is_numeric_string;
                    if options.escape_formulas && starts_formula(&text) && !is_numeric {
                        text.insert(0, '\'');
                    }
                    DsvCell::Text(Cow::Owned(text), numeric_type, is_numeric_string)
                }
            }),
            options,
            options.include_row_header.then(|| (row_index + 1).to_string()),
            quote_char_triggers_quoting,
        )?;
        first_row = false;
    }
    if header_position == Some(DataGridHeaderPosition::Bottom) {
        if !first_row {
            write_bytes(output, options.row_separator.as_bytes())?;
        }
        write_dsv_header_rows(context, output, options, quote_char_triggers_quoting)?;
    }
    Ok(())
}

/// Writes the configured header rows at the current output position: one row
/// for every format except `NameAndDescriptionTwoRows`, which stacks the
/// description row above the name row (#13305).
fn write_dsv_header_rows(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
    options: &DataGridDsvOptions,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    if options.header_format == DataGridHeaderFormat::NameAndDescriptionTwoRows {
        write_dsv_row(
            output,
            context.selected_columns.iter().map(|column| {
                Cow::Owned(two_row_header_cell(column.description.as_deref().unwrap_or_default(), options))
            }),
            options,
            options.include_row_header.then(|| "#".to_string()),
            quote_char_triggers_quoting,
        )?;
        write_bytes(output, options.row_separator.as_bytes())?;
        write_dsv_row(
            output,
            context
                .selected_columns
                .iter()
                .map(|column| Cow::Owned(two_row_header_cell(&column.display_name, options))),
            options,
            options.include_row_header.then(|| "#".to_string()),
            quote_char_triggers_quoting,
        )?;
        return Ok(());
    }
    write_dsv_row(
        output,
        context.selected_columns.iter().map(|column| Cow::Owned(header_label(column, options))),
        options,
        options.include_row_header.then(|| "#".to_string()),
        quote_char_triggers_quoting,
    )
}

/// A `NameAndDescriptionTwoRows` header cell: the same case, line-feed and
/// formula transforms `header_label` applies, without the one-line fallback.
fn two_row_header_cell(label: &str, options: &DataGridDsvOptions) -> String {
    let mut cell = match options.header_case {
        DataGridHeaderCase::Preserve => label.to_owned(),
        DataGridHeaderCase::Upper => label.to_uppercase(),
        DataGridHeaderCase::Lower => label.to_lowercase(),
    };
    cell = replace_line_feeds(cell, &options.line_feed_escape_string);
    if options.escape_formulas && starts_formula(&cell) {
        cell.insert(0, '\'');
    }
    cell
}

fn header_label(column: &super::DataGridExtractColumn, options: &DataGridDsvOptions) -> String {
    let label = match options.header_format {
        // The two-row format never renders a single combined label; its cells
        // come from two_row_header_cell instead.
        DataGridHeaderFormat::NameAndDescriptionTwoRows => column.display_name.clone(),
        DataGridHeaderFormat::Name => column.display_name.clone(),
        DataGridHeaderFormat::Description => {
            column.description.as_deref().filter(|text| !text.is_empty()).unwrap_or(&column.display_name).to_owned()
        }
        DataGridHeaderFormat::Both => column
            .description
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(|description| format!("{} ({description})", column.display_name))
            .unwrap_or_else(|| column.display_name.clone()),
    };
    let mut label = match options.header_case {
        DataGridHeaderCase::Preserve => label,
        DataGridHeaderCase::Upper => label.to_uppercase(),
        DataGridHeaderCase::Lower => label.to_lowercase(),
    };
    label = replace_line_feeds(label, &options.line_feed_escape_string);
    if options.escape_formulas && starts_formula(&label) {
        label.insert(0, '\'');
    }
    label
}

fn is_numeric_type(data_type: Option<&str>) -> bool {
    let ty = data_type.unwrap_or_default().trim().to_ascii_lowercase();
    let tokens: Vec<_> =
        ty.split(|character: char| !character.is_ascii_alphanumeric()).filter(|token| !token.is_empty()).collect();
    let Some(first) = tokens.first().copied() else { return false };
    let exact = [
        "int",
        "integer",
        "smallint",
        "bigint",
        "tinyint",
        "mediumint",
        "decimal",
        "numeric",
        "number",
        "float",
        "double",
        "real",
        "serial",
        "bigserial",
        "smallserial",
        "money",
        "smallmoney",
        "dec",
        "fixed",
    ];
    exact.contains(&first)
        || tokens.contains(&"unsigned")
        || ["int", "uint", "float", "double", "decimal", "numeric", "number", "serial"].iter().any(|prefix| {
            first
                .strip_prefix(prefix)
                .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit()))
        })
}

fn starts_formula(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|first| matches!(first, '=' | '+' | '-' | '@' | '＝' | '＋' | '－' | '＠' | '\t' | '\r' | '\n'))
}

fn replace_line_feeds(mut value: String, replacement: &str) -> String {
    if replacement.is_empty() {
        return value;
    }
    value = value.replace("\r\n", replacement).replace('\n', replacement);
    value
}

fn format_array_value(
    mut text: String,
    value: &serde_json::Value,
    data_type: Option<&str>,
    format: DataGridArrayFormat,
) -> String {
    if format == DataGridArrayFormat::Preserve {
        return text;
    }
    let is_array = value.is_array() || data_type.unwrap_or_default().to_ascii_lowercase().contains("array");
    if !is_array {
        return text;
    }
    let (open, close) = match format {
        DataGridArrayFormat::Braces => ('{', '}'),
        DataGridArrayFormat::Brackets => ('[', ']'),
        DataGridArrayFormat::Parentheses => ('(', ')'),
        DataGridArrayFormat::Preserve => return text,
    };
    let first = text.chars().next();
    let last = text.chars().last();
    if matches!((first, last), (Some('['), Some(']')) | (Some('{'), Some('}')) | (Some('('), Some(')'))) {
        text.replace_range(..1, &open.to_string());
        let last_index = text.len() - 1;
        text.replace_range(last_index.., &close.to_string());
    }
    text
}

/// Writes a row of header strings (column names / row-number header). Headers
/// are never NULL, so they use the plain string field writer.
fn write_dsv_row<'a>(
    output: &mut dyn Write,
    values: impl Iterator<Item = Cow<'a, str>>,
    options: &DataGridDsvOptions,
    row_header: Option<String>,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    let mut first = true;
    if let Some(header) = row_header {
        write_dsv_field(output, &header, options, quote_char_triggers_quoting)?;
        first = false;
    }
    for value in values {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        write_dsv_field(output, &value, options, quote_char_triggers_quoting)?;
        first = false;
    }
    Ok(())
}

/// Writes a row of data cells, preserving NULL as a distinct sentinel.
fn write_dsv_data_row<'a>(
    output: &mut dyn Write,
    cells: impl Iterator<Item = DsvCell<'a>>,
    options: &DataGridDsvOptions,
    row_header: Option<String>,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    let mut first = true;
    if let Some(header) = row_header {
        write_dsv_field(output, &header, options, quote_char_triggers_quoting)?;
        first = false;
    }
    for cell in cells {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        write_dsv_data_field(output, &cell, options, quote_char_triggers_quoting)?;
        first = false;
    }
    Ok(())
}

/// Whether a value must be wrapped in quotes. A value is always quoted when it
/// contains a separator or a line break, because those would otherwise corrupt
/// the record shape. Whether a bare quote character forces quoting is
/// format-dependent: RFC4180 formats (CSV/DSV/one-row) must escape an embedded
/// quote, but plain delimited formats such as TSV are parsed by splitting on the
/// separator alone (there is no quote state machine on paste-back), so a value
/// that merely contains `"` must be emitted verbatim rather than wrapped and
/// doubled.
fn dsv_needs_quote(value: &str, options: &DataGridDsvOptions, quote_char_triggers_quoting: bool) -> bool {
    value.contains(&options.column_separator)
        || value.contains(&options.row_separator)
        || (quote_char_triggers_quoting && value.contains(options.quote))
        || value.contains('\r')
        || value.contains('\n')
}

fn write_quoted_dsv_field(
    output: &mut dyn Write,
    value: &str,
    options: &DataGridDsvOptions,
) -> Result<(), DataGridExtractError> {
    let quote = options.quote;
    let mut quote_buffer = [0; 4];
    let quote_text = quote.encode_utf8(&mut quote_buffer);
    write_bytes(output, quote_text.as_bytes())?;
    let mut segments = value.split(quote);
    if let Some(first) = segments.next() {
        write_bytes(output, first.as_bytes())?;
    }
    for segment in segments {
        write_bytes(output, quote_text.as_bytes())?;
        write_bytes(output, quote_text.as_bytes())?;
        write_bytes(output, segment.as_bytes())?;
    }
    write_bytes(output, quote_text.as_bytes())
}

/// Encodes a header (non-data) string field. Quotes per policy; a header equal
/// to the NULL sentinel is NOT special-cased because headers are not data.
fn write_dsv_field(
    output: &mut dyn Write,
    value: &str,
    options: &DataGridDsvOptions,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    let should_quote = match options.quote_policy {
        DataGridQuotePolicy::Always => true,
        DataGridQuotePolicy::Never => false,
        DataGridQuotePolicy::Strings | DataGridQuotePolicy::AllButNumbers | DataGridQuotePolicy::AllIncludingNulls => {
            true
        }
        DataGridQuotePolicy::Minimal => dsv_needs_quote(value, options, quote_char_triggers_quoting),
    };
    if !should_quote {
        return write_bytes(output, value.as_bytes());
    }
    write_quoted_dsv_field(output, value, options)
}

/// Encodes a data cell. NULL is always written as the bare sentinel (never
/// quoted/escaped); a string equal to the sentinel is force-quoted in Minimal
/// mode so it stays distinguishable from a real NULL. Under Always the string is
/// quoted and the bare NULL still differs; under Never the two are inherently
/// indistinguishable (documented limitation).
fn write_dsv_data_field(
    output: &mut dyn Write,
    cell: &DsvCell<'_>,
    options: &DataGridDsvOptions,
    quote_char_triggers_quoting: bool,
) -> Result<(), DataGridExtractError> {
    match cell {
        DsvCell::Null => match options.quote_policy {
            DataGridQuotePolicy::AllIncludingNulls => write_quoted_dsv_field(output, &options.null_text, options),
            _ => write_bytes(output, options.null_text.as_bytes()),
        },
        DsvCell::Text(value, numeric_type, numeric_string) => {
            let should_quote = match options.quote_policy {
                DataGridQuotePolicy::Always => true,
                DataGridQuotePolicy::Never => false,
                DataGridQuotePolicy::Strings => {
                    !numeric_type
                        || (options.quote_numeric_strings && *numeric_string)
                        || dsv_needs_quote(value, options, quote_char_triggers_quoting)
                }
                DataGridQuotePolicy::AllButNumbers => {
                    !numeric_type || dsv_needs_quote(value, options, quote_char_triggers_quoting)
                }
                DataGridQuotePolicy::AllIncludingNulls => true,
                DataGridQuotePolicy::Minimal => {
                    dsv_needs_quote(value, options, quote_char_triggers_quoting)
                        || (options.quote_numeric_strings && *numeric_string)
                        || value.as_ref() == options.null_text.as_str()
                }
            };
            if !should_quote {
                return write_bytes(output, value.as_bytes());
            }
            write_quoted_dsv_field(output, value, options)
        }
    }
}

pub(super) fn write_one_row(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    let options = DataGridDsvOptions { column_separator: ",".to_string(), ..context.request.options.dsv.clone() };
    validate_dsv_options(&options, false)?;
    let mut first = true;
    for row in &context.request.rows {
        for (source_index, column) in context.selected_source_indexes.iter().zip(&context.selected_columns) {
            if !first {
                write_bytes(output, options.column_separator.as_bytes())?;
            }
            let value = &row[*source_index];
            let cell = if value.is_null() {
                DsvCell::Null
            } else {
                let numeric_string = value.as_str().is_some_and(|text| !text.is_empty() && text.parse::<f64>().is_ok());
                DsvCell::Text(value_text(value), is_numeric_type(column.data_type.as_deref()), numeric_string)
            };
            // A one-row extraction is an RFC4180 CSV record, so embedded quotes must
            // be escaped.
            write_dsv_data_field(output, &cell, &options, true)?;
            first = false;
        }
    }
    Ok(())
}

fn validate_dsv_options(options: &DataGridDsvOptions, uses_row_separator: bool) -> Result<(), DataGridExtractError> {
    if options.column_separator.is_empty() || (uses_row_separator && options.row_separator.is_empty()) {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV column and row separators must not be empty.",
        ));
    }
    if options.column_separator.chars().count() > MAX_SEPARATOR_CHARACTERS
        || options.row_separator.chars().count() > MAX_SEPARATOR_CHARACTERS
        || options.null_text.chars().count() > MAX_NULL_TEXT_CHARACTERS
        || options.line_feed_escape_string.chars().count() > 32
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV separators may contain at most 8 characters, NULL text at most 64 characters, and line-feed replacement at most 32 characters.",
        ));
    }
    if uses_row_separator
        && (options.column_separator.contains(&options.row_separator)
            || options.row_separator.contains(&options.column_separator))
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV column and row separators must not overlap.",
        ));
    }
    if options.quote.is_control()
        || options.column_separator.contains(options.quote)
        || (uses_row_separator && options.row_separator.contains(options.quote))
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV quote must be a non-control character that is not part of a separator.",
        ));
    }
    Ok(())
}
