use super::{
    value_text, write_bytes, DataGridDsvOptions, DataGridExtractError, DataGridExtractErrorCode, DataGridQuotePolicy,
    ExtractContext,
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
    Text(Cow<'a, str>),
}

pub(super) fn write_dsv(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
    options: &DataGridDsvOptions,
) -> Result<(), DataGridExtractError> {
    validate_dsv_options(options, true)?;
    let mut first_row = true;
    if options.include_column_header {
        write_dsv_row(
            output,
            context.selected_columns.iter().map(|column| Cow::Borrowed(column.display_name.as_str())),
            options,
            options.include_row_header.then(|| "#".to_string()),
        )?;
        first_row = false;
    }
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if !first_row {
            write_bytes(output, options.row_separator.as_bytes())?;
        }
        write_dsv_data_row(
            output,
            context.selected_source_indexes.iter().map(|source_index| {
                let value = &row[*source_index];
                if value.is_null() {
                    DsvCell::Null
                } else {
                    DsvCell::Text(value_text(value))
                }
            }),
            options,
            options.include_row_header.then(|| (row_index + 1).to_string()),
        )?;
        first_row = false;
    }
    Ok(())
}

/// Writes a row of header strings (column names / row-number header). Headers
/// are never NULL, so they use the plain string field writer.
fn write_dsv_row<'a>(
    output: &mut dyn Write,
    values: impl Iterator<Item = Cow<'a, str>>,
    options: &DataGridDsvOptions,
    row_header: Option<String>,
) -> Result<(), DataGridExtractError> {
    let mut first = true;
    if let Some(header) = row_header {
        write_dsv_field(output, &header, options)?;
        first = false;
    }
    for value in values {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        write_dsv_field(output, &value, options)?;
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
) -> Result<(), DataGridExtractError> {
    let mut first = true;
    if let Some(header) = row_header {
        write_dsv_field(output, &header, options)?;
        first = false;
    }
    for cell in cells {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        write_dsv_data_field(output, &cell, options)?;
        first = false;
    }
    Ok(())
}

fn dsv_needs_quote(value: &str, options: &DataGridDsvOptions) -> bool {
    value.contains(&options.column_separator)
        || value.contains(&options.row_separator)
        || value.contains(options.quote)
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
) -> Result<(), DataGridExtractError> {
    let should_quote = match options.quote_policy {
        DataGridQuotePolicy::Always => true,
        DataGridQuotePolicy::Never => false,
        DataGridQuotePolicy::Minimal => dsv_needs_quote(value, options),
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
) -> Result<(), DataGridExtractError> {
    match cell {
        DsvCell::Null => write_bytes(output, options.null_text.as_bytes()),
        DsvCell::Text(value) => {
            let should_quote = match options.quote_policy {
                DataGridQuotePolicy::Always => true,
                DataGridQuotePolicy::Never => false,
                DataGridQuotePolicy::Minimal => {
                    dsv_needs_quote(value, options) || value.as_ref() == options.null_text.as_str()
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
    let values = context
        .request
        .rows
        .iter()
        .flat_map(|row| context.selected_source_indexes.iter().map(move |source_index| &row[*source_index]));
    let mut first = true;
    for value in values {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        let cell = if value.is_null() { DsvCell::Null } else { DsvCell::Text(value_text(value)) };
        write_dsv_data_field(output, &cell, &options)?;
        first = false;
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
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV separators may contain at most 8 characters and NULL text at most 64 characters.",
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
