use super::{value_text, write_bytes, DataGridExtractError, ExtractContext};
use std::io::Write;
use unicode_width::UnicodeWidthStr;

pub(super) fn write_markdown(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    let headers = context.selected_columns.iter().map(|column| markdown_text(&column.display_name));
    write_bytes(output, format!("| {} |\n", headers.collect::<Vec<_>>().join(" | ")).as_bytes())?;
    write_bytes(
        output,
        format!("| {} |", context.selected_columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")).as_bytes(),
    )?;
    for row in &context.request.rows {
        write_bytes(output, b"\n")?;
        let values =
            context.selected_source_indexes.iter().map(|source_index| markdown_text(&value_text(&row[*source_index])));
        write_bytes(output, format!("| {} |", values.collect::<Vec<_>>().join(" | ")).as_bytes())?;
    }
    Ok(())
}

pub(super) fn write_html(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"<table>\n  <thead><tr>")?;
    for column in &context.selected_columns {
        write_bytes(output, format!("<th>{}</th>", html_text(&column.display_name)).as_bytes())?;
    }
    write_bytes(output, b"</tr></thead>\n  <tbody>")?;
    for row in &context.request.rows {
        write_bytes(output, b"\n    <tr>")?;
        for source_index in &context.selected_source_indexes {
            let value = &row[*source_index];
            write_bytes(output, format!("<td>{}</td>", html_text(&value_text(value))).as_bytes())?;
        }
        write_bytes(output, b"</tr>")?;
    }
    write_bytes(output, b"\n  </tbody>\n</table>")
}

pub(super) fn write_xml(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rows>")?;
    for row in &context.request.rows {
        write_bytes(output, b"\n  <row>")?;
        for (column, source_index) in context.selected_columns.iter().zip(&context.selected_source_indexes) {
            let value = &row[*source_index];
            let name = html_text(&column.display_name);
            if value.is_null() {
                write_bytes(output, format!("\n    <column name=\"{name}\" null=\"true\" />").as_bytes())?;
            } else {
                write_bytes(
                    output,
                    format!("\n    <column name=\"{name}\">{}</column>", html_text(&value_text(value))).as_bytes(),
                )?;
            }
        }
        write_bytes(output, b"\n  </row>")?;
    }
    write_bytes(output, b"\n</rows>")
}

pub(super) fn write_pretty(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    let widths = context
        .selected_columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            context
                .request
                .rows
                .iter()
                .map(|row| value_text(&row[context.selected_source_indexes[index]]).replace(['\r', '\n'], " ").width())
                .fold(column.display_name.width(), usize::max)
        })
        .collect::<Vec<_>>();
    write_pretty_border(output, &widths)?;
    write_pretty_row(output, context.selected_columns.iter().map(|column| column.display_name.as_str()), &widths)?;
    write_pretty_border(output, &widths)?;
    for row in &context.request.rows {
        let values = context
            .selected_source_indexes
            .iter()
            .map(|source_index| value_text(&row[*source_index]).replace(['\r', '\n'], " "));
        write_pretty_owned_row(output, values, &widths)?;
    }
    write_pretty_border(output, &widths)
}

fn write_pretty_owned_row(
    output: &mut dyn Write,
    values: impl Iterator<Item = String>,
    widths: &[usize],
) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"|")?;
    for (index, value) in values.enumerate() {
        let padding = widths.get(index).copied().unwrap_or_default().saturating_sub(value.width());
        write_bytes(output, b" ")?;
        write_bytes(output, value.as_bytes())?;
        write_repeated_byte(output, b' ', padding)?;
        write_bytes(output, b" |")?;
    }
    write_bytes(output, b"\n")
}

fn write_pretty_border(output: &mut dyn Write, widths: &[usize]) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"+")?;
    for width in widths {
        write_repeated_byte(output, b'-', width.saturating_add(2))?;
        write_bytes(output, b"+")?;
    }
    write_bytes(output, b"\n")
}

fn write_pretty_row<'a>(
    output: &mut dyn Write,
    values: impl Iterator<Item = &'a str>,
    widths: &[usize],
) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"|")?;
    for (index, value) in values.enumerate() {
        let padding = widths.get(index).copied().unwrap_or_default().saturating_sub(value.width());
        write_bytes(output, b" ")?;
        write_bytes(output, value.as_bytes())?;
        write_repeated_byte(output, b' ', padding)?;
        write_bytes(output, b" |")?;
    }
    write_bytes(output, b"\n")
}

fn write_repeated_byte(output: &mut dyn Write, byte: u8, mut count: usize) -> Result<(), DataGridExtractError> {
    let mut buffer = [0u8; 1024];
    buffer.fill(byte);
    while count > 0 {
        let chunk_size = count.min(buffer.len());
        write_bytes(output, &buffer[..chunk_size])?;
        count -= chunk_size;
    }
    Ok(())
}

fn markdown_text(value: &str) -> String {
    value.replace('\\', "\\\\").replace('|', "\\|").replace(['\r', '\n'], "<br>")
}

fn html_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}
