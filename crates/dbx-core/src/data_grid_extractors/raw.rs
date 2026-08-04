use super::{value_text, write_bytes, DataGridExtractError, ExtractContext};
use std::io::Write;

/// Writes selected cell values without DSV escaping. Tabs and newlines retain
/// the selection shape, while each value itself remains unchanged.
pub(super) fn write_raw(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if row_index > 0 {
            write_bytes(output, b"\n")?;
        }
        for (column_index, source_index) in context.selected_source_indexes.iter().enumerate() {
            if column_index > 0 {
                write_bytes(output, b"\t")?;
            }
            write_bytes(output, value_text(&row[*source_index]).as_bytes())?;
        }
    }
    Ok(())
}
