use super::{
    transposed_markdown_labels, value_text, write_bytes, DataGridExtractError, DataGridExtractErrorCode,
    DataGridTransposedMarkdownLabels, ExtractContext,
};
use serde_json::Value;
use std::io::{self, Write};
use unicode_width::UnicodeWidthStr;

pub(super) fn write_markdown(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    if let Some(labels) = transposed_markdown_labels(context.request) {
        return write_transposed_markdown(context, labels, output);
    }
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

fn write_transposed_markdown(
    context: &ExtractContext<'_>,
    labels: &DataGridTransposedMarkdownLabels,
    output: &mut dyn Write,
) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"| ")?;
    write_markdown_text(output, &labels.field)?;
    for index in 0..context.request.rows.len() {
        write_bytes(output, b" | ")?;
        write_markdown_text(output, &labels.data)?;
        if context.request.rows.len() > 1 {
            write_bytes(output, format!(" {}", index + 1).as_bytes())?;
        }
    }
    write_bytes(output, b" |\n| ---")?;
    for _ in &context.request.rows {
        write_bytes(output, b" | ---")?;
    }
    write_bytes(output, b" |")?;
    for column in &context.selected_columns {
        write_bytes(output, b"\n| ")?;
        write_markdown_text(output, &column.display_name)?;
        for row in &context.request.rows {
            write_bytes(output, b" | ")?;
            match &row[column.source_index] {
                Value::Null => write_bytes(output, b"NULL")?,
                Value::String(text) => write_markdown_text(output, text)?,
                value => serde_json::to_writer(MarkdownTextWriter(output), value).map_err(|error| {
                    DataGridExtractError::new(DataGridExtractErrorCode::EncodingFailed, error.to_string())
                })?,
            }
        }
        write_bytes(output, b" |")?;
    }
    Ok(())
}

// Escape directly into the bounded output, including serialized JSON values,
// rather than allocating an entire wide row or an expanded escaped cell.
struct MarkdownTextWriter<'a>(&'a mut dyn Write);

impl Write for MarkdownTextWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut start = 0;
        for (index, byte) in buffer.iter().enumerate() {
            let escaped: &[u8] = match byte {
                b'\\' => b"\\\\",
                b'|' => b"\\|",
                b'\n' if index > 0 && buffer[index - 1] == b'\r' => b"",
                b'\r' | b'\n' => b"<br>",
                _ => continue,
            };
            self.0.write_all(&buffer[start..index])?;
            self.0.write_all(escaped)?;
            start = index + 1;
        }
        self.0.write_all(&buffer[start..])?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

fn write_markdown_text(output: &mut dyn Write, text: &str) -> Result<(), DataGridExtractError> {
    MarkdownTextWriter(output)
        .write_all(text.as_bytes())
        .map_err(|error| DataGridExtractError::new(DataGridExtractErrorCode::EncodingFailed, error.to_string()))
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
