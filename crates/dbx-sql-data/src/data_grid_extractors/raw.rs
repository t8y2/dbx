use super::{value_text, write_bytes, DataGridExtractError, ExtractContext};
use std::io::Write;

/// Writes one selected column without escaping or spreadsheet formula guards.
/// Rows are joined with a newline; tabs, quotes and embedded line breaks inside
/// each value are preserved, and NULL cells remain empty.
pub(super) fn write_raw(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if row_index > 0 {
            write_bytes(output, b"\n")?;
        }
        for (column_index, source_index) in context.selected_source_indexes.iter().enumerate() {
            if column_index > 0 {
                write_bytes(output, b"\t")?;
            }
            if !row[*source_index].is_null() {
                write_bytes(output, value_text(&row[*source_index]).as_bytes())?;
            }
        }
    }
    Ok(())
}
