use super::{canceled_error, is_canceled, request_large_value_with_cancel, LargeValueRequest};
use crate::connection::AppState;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotExportCell {
    pub row_index: usize,
    pub column_index: usize,
    pub value_ref: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotExportRequest {
    pub context: LargeValueRequest,
    pub format: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub cells: Vec<SnapshotExportCell>,
    #[serde(default)]
    pub quote_mode: dbx_formats::csv_export::CsvQuoteMode,
    pub null_literal: Option<String>,
}

/// Original result references only. A temporary cell file bounds memory even for
/// formula-guard inspection; callers publish the output only after success.
pub async fn write_snapshot_export(
    state: &AppState,
    request: SnapshotExportRequest,
    output: &mut std::fs::File,
) -> Result<(), String> {
    let registered = request.context.execution_id.as_ref().map(|id| {
        state.running_queries.register_task(
            id.clone(),
            crate::query_cancel::RunningTaskMetadata::query(
                request.context.connection_id.clone(),
                request.context.database.clone(),
                request.context.client_session_id.clone(),
            ),
        )
    });
    let cancel = registered.as_ref().map(|task| task.token());
    write_snapshot_export_with_fetch(request, output, cancel.clone(), |chunk_request| {
        request_large_value_with_cancel(state, chunk_request, false, cancel.clone())
    })
    .await
}

async fn write_snapshot_export_with_fetch<F, Fut>(
    request: SnapshotExportRequest,
    output: &mut std::fs::File,
    cancel: Option<tokio_util::sync::CancellationToken>,
    mut fetch: F,
) -> Result<(), String>
where
    F: FnMut(LargeValueRequest) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut buffered = std::io::BufWriter::new(output);
    let output = &mut buffered;
    if request.format != "csv" && request.format != "json" {
        return Err("Unsupported snapshot export format".into());
    }
    if request.rows.iter().any(|row| row.len() != request.columns.len()) {
        return Err("Invalid snapshot export row".into());
    }
    let mut refs = HashMap::new();
    for cell in &request.cells {
        if cell.row_index >= request.rows.len()
            || cell.column_index >= request.columns.len()
            || cell.value_ref.is_empty()
            || cell.value_ref.len() > 128
            || refs.insert((cell.row_index, cell.column_index), cell.value_ref.as_str()).is_some()
        {
            return Err("Invalid snapshot export cell".into());
        }
    }
    // JSON objects cannot preserve duplicate labels. Reject rather than dropping a column.
    if request.format == "json" {
        let mut names = std::collections::HashSet::new();
        if request.columns.iter().any(|name| !names.insert(name)) {
            return Err("JSON export requires unique column names; use CSV".into());
        }
    }
    let json = request.format == "json";
    if json {
        output.write_all(b"[").map_err(|e| e.to_string())?;
    } else {
        let mut header = String::new();
        for (index, name) in request.columns.iter().enumerate() {
            if index > 0 {
                header.push(',');
            }
            dbx_formats::csv_export::push_csv_field(&mut header, name, request.quote_mode);
        }
        output.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    }
    for (row_index, row) in request.rows.iter().enumerate() {
        if is_canceled(&cancel) {
            return Err(canceled_error());
        }
        output
            .write_all(if json {
                if row_index == 0 {
                    b"{"
                } else {
                    b",{"
                }
            } else {
                b"\n"
            })
            .map_err(|e| e.to_string())?;
        for (column_index, value) in row.iter().enumerate() {
            if column_index > 0 {
                output.write_all(b",").map_err(|e| e.to_string())?;
            }
            if json {
                serde_json::to_writer(&mut *output, &request.columns[column_index]).map_err(|e| e.to_string())?;
                output.write_all(b":").map_err(|e| e.to_string())?;
            }
            if let Some(value_ref) = refs.get(&(row_index, column_index)) {
                let mut cell_file = tempfile::tempfile().map_err(|e| e.to_string())?;
                let mut chunk_request = request.context.clone();
                chunk_request.value_ref = (*value_ref).to_string();
                chunk_request.offset = 0;
                chunk_request.limit = 4096;
                let mut original_kind: Option<String> = None;
                loop {
                    if is_canceled(&cancel) {
                        return Err(canceled_error());
                    }
                    let chunk = fetch(chunk_request.clone()).await?;
                    let (data, next, eof, kind) = checked_chunk(&chunk, chunk_request.offset)?;
                    if original_kind.as_deref().is_some_and(|original| original != kind) {
                        return Err("LOB chunk type changed".into());
                    }
                    if original_kind.is_none() && kind == "binary" {
                        cell_file.write_all(b"0x").map_err(|e| e.to_string())?;
                    }
                    original_kind = Some(kind.to_string());
                    cell_file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
                    if eof {
                        break;
                    }
                    chunk_request.offset = next;
                }
                cell_file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                let guard = !json
                    && stream_formula_guard(BufReader::new(CancelableReader {
                        reader: &mut cell_file,
                        cancel: &cancel,
                    }))?;
                cell_file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                let quoted = json
                    || request.quote_mode == dbx_formats::csv_export::CsvQuoteMode::All
                    || csv_needs_quotes(CancelableReader { reader: &mut cell_file, cancel: &cancel })?;
                cell_file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                if quoted {
                    output.write_all(b"\"").map_err(|e| e.to_string())?;
                }
                if guard {
                    output.write_all(b"'").map_err(|e| e.to_string())?;
                }
                let mut buffer = [0_u8; 8192];
                loop {
                    if is_canceled(&cancel) {
                        return Err(canceled_error());
                    }
                    let count = cell_file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    write_escaped(output, &buffer[..count], json)?;
                }
                if quoted {
                    output.write_all(b"\"").map_err(|e| e.to_string())?;
                }
            } else if json {
                serde_json::to_writer(&mut *output, value).map_err(|e| e.to_string())?;
            } else {
                let mut cell = String::new();
                dbx_formats::csv_export::push_query_result_csv_row_with_options(
                    &mut cell,
                    std::slice::from_ref(value),
                    request.quote_mode,
                    request.null_literal.as_deref(),
                );
                output.write_all(cell.as_bytes()).map_err(|e| e.to_string())?;
            }
        }
        if json {
            output.write_all(b"}").map_err(|e| e.to_string())?;
        }
    }
    if is_canceled(&cancel) {
        return Err(canceled_error());
    }
    if json {
        output.write_all(b"]").map_err(|e| e.to_string())?;
    }
    output.flush().map_err(|e| e.to_string())
}

struct CancelableReader<'a, R> {
    reader: R,
    cancel: &'a Option<tokio_util::sync::CancellationToken>,
}
impl<R: Read> Read for CancelableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if is_canceled(self.cancel) {
            return Err(std::io::Error::other(canceled_error()));
        }
        self.reader.read(buffer)
    }
}

pub(super) fn checked_chunk(chunk: &Value, offset: u64) -> Result<(&str, u64, bool, &str), String> {
    if chunk.get("status").and_then(Value::as_str) != Some("ok") {
        return Err("LOB snapshot expired; execute the query again".into());
    }
    let data = chunk.get("data").and_then(Value::as_str).ok_or("Invalid LOB data")?;
    let next = chunk.get("next_offset").and_then(Value::as_u64).ok_or("Invalid LOB offset")?;
    let eof = chunk.get("eof").and_then(Value::as_bool).ok_or("Invalid LOB EOF")?;
    let kind = chunk.get("value_kind").and_then(Value::as_str).ok_or("Invalid LOB type")?;
    if next < offset || next - offset > 4096 || (!eof && next == offset) {
        return Err("Invalid LOB offset".into());
    }
    let amount = match kind {
        "text" => data.chars().count(),
        "binary" if data.len() <= 8192 && data.len() % 2 == 0 && data.bytes().all(|b| b.is_ascii_hexdigit()) => {
            data.len() / 2
        }
        _ => return Err("Invalid LOB chunk encoding".into()),
    };
    if amount as u64 != next - offset {
        return Err("Invalid LOB chunk length".into());
    }
    Ok((data, next, eof, kind))
}

fn write_escaped(output: &mut impl Write, bytes: &[u8], json: bool) -> Result<(), String> {
    for &byte in bytes {
        match byte {
            b'"' => output.write_all(if json { b"\\\"" } else { b"\"\"" }),
            b'\\' if json => output.write_all(b"\\\\"),
            0..=31 if json => write!(output, "\\u{byte:04x}"),
            _ => output.write_all(&[byte]),
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn csv_needs_quotes(mut reader: impl Read) -> Result<bool, String> {
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(false);
        }
        if buffer[..count].iter().any(|&byte| matches!(byte, b',' | b'"' | b'\n' | b'\r')) {
            return Ok(true);
        }
    }
}

// Same cell-level guard as dbx-formats, including negative decimals and literal
// apostrophes, without retaining leading spaces/zeroes or the complete cell.
fn stream_formula_guard(reader: impl Read) -> Result<bool, String> {
    let mut bytes = reader.bytes();
    let mut next = || bytes.next().transpose().map_err(|e| e.to_string());
    let mut byte = next()?;
    if byte == Some(b'\'') {
        byte = next()?;
        if byte == Some(b'\'') {
            return Ok(true);
        }
    }
    while byte == Some(b' ') {
        byte = next()?;
    }
    if byte != Some(b'-') {
        return Ok(byte.is_some_and(|b| b"=+@\t\r".contains(&b)));
    }
    byte = next()?;
    if matches!(byte, Some(b'+') | Some(b'-')) {
        byte = next()?;
    }
    let mut digits = 0_usize;
    let mut significant = 0;
    let mut dot = false;
    loop {
        match byte {
            Some(b'0'..=b'9') => {
                digits += 1;
                if byte != Some(b'0') || significant > 0 {
                    significant += 1;
                }
                if significant > 15 {
                    return Ok(true);
                }
            }
            Some(b'.') if !dot && digits > 0 => {
                dot = true;
                digits = 0;
                significant = 0;
            }
            None => return Ok(digits == 0),
            _ => return Ok(true),
        }
        byte = next()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_guard_matches_existing_cell_semantics() {
        for value in [
            "",
            "plain",
            "=cmd",
            "  +86",
            "-1",
            "-1.25",
            "-00000000000000000000000000001",
            "-1.00000000000000001",
            "-2+cmd",
            "-",
            "'-1",
            "'=cmd",
            "''text",
            "'plain",
            "  --1",
            "-.1",
            "\ttext",
        ] {
            let mut expected = String::new();
            dbx_formats::csv_export::push_formula_guard(&mut expected, value);
            assert_eq!(stream_formula_guard(value.as_bytes()).unwrap(), !expected.is_empty(), "{value}");
        }
    }
    #[test]
    fn escapes_chunk_boundaries_without_changing_utf8_or_binary_hex() {
        let text = "中🙂\"\\\n\0";
        for split in 0..=text.len() {
            let mut out = Vec::new();
            write_escaped(&mut out, &text.as_bytes()[..split], true).unwrap();
            write_escaped(&mut out, &text.as_bytes()[split..], true).unwrap();
            assert_eq!(serde_json::from_slice::<String>(&[b"\"".as_slice(), &out, b"\""].concat()).unwrap(), text);
        }
    }
    #[test]
    fn rejects_expiry_invalid_offsets_and_incomplete_hex() {
        for chunk in [
            serde_json::json!({"status":"expired"}),
            serde_json::json!({"status":"ok","data":"0","next_offset":1,"eof":true,"value_kind":"binary"}),
            serde_json::json!({"status":"ok","data":"a","next_offset":5000,"eof":true,"value_kind":"text"}),
        ] {
            assert!(checked_chunk(&chunk, 0).is_err());
        }
        let chunk = serde_json::json!({"status":"ok","data":"🙂","next_offset":1,"eof":true,"value_kind":"text"});
        assert_eq!(checked_chunk(&chunk, 0).unwrap().1, 1);
    }

    fn request(format: &str) -> SnapshotExportRequest {
        serde_json::from_value(serde_json::json!({
            "context": {"connectionId":"original-connection","database":"oracletest","valueRef":"","clientSessionId":"original-session"},
            "format":format,"columns":["ID","PAYLOAD"],"rows":[[1,"preview"]],
            "cells":[{"rowIndex":0,"columnIndex":1,"valueRef":"original-locator"}],"nullLiteral":"\\N"
        })).unwrap()
    }

    #[tokio::test]
    async fn production_writer_preserves_unicode_quotes_and_original_context_in_multiple_chunks() {
        let original = format!(" =cmd{}\"\\\n", "中🙂".repeat(3000));
        let chars: Vec<char> = original.chars().collect();
        for format in ["csv", "json"] {
            let mut file = tempfile::tempfile().unwrap();
            let mut offsets = Vec::new();
            write_snapshot_export_with_fetch(request(format), &mut file, None, |chunk_request| {
                assert_eq!(chunk_request.value_ref, "original-locator");
                assert_eq!(chunk_request.connection_id, "original-connection");
                assert_eq!(chunk_request.client_session_id.as_deref(), Some("original-session"));
                assert_eq!(chunk_request.limit, 4096);
                offsets.push(chunk_request.offset);
                let begin = chunk_request.offset as usize;
                let end = (begin + 4096).min(chars.len());
                std::future::ready(Ok(serde_json::json!({"status":"ok","data":chars[begin..end].iter().collect::<String>(),"next_offset":end,"eof":end==chars.len(),"value_kind":"text"})))
            }).await.unwrap();
            assert_eq!(offsets, vec![0, 4096]);
            file.seek(SeekFrom::Start(0)).unwrap();
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            if format == "json" {
                assert_eq!(serde_json::from_str::<Value>(&text).unwrap()[0]["PAYLOAD"], original);
            } else {
                assert_eq!(
                    text,
                    dbx_formats::csv_export::format_query_result_csv_with_options(
                        &["ID".into(), "PAYLOAD".into()],
                        &[vec![Value::from(1), Value::from(original.clone())]],
                        dbx_formats::csv_export::CsvQuoteMode::All,
                        Some("\\N")
                    )
                );
            }
        }
    }

    #[tokio::test]
    async fn production_writer_never_completes_on_mid_read_expiry_or_cancel() {
        for cancel_read in [false, true] {
            let token = tokio_util::sync::CancellationToken::new();
            let mut file = tempfile::tempfile().unwrap();
            let mut calls = 0;
            let error = write_snapshot_export_with_fetch(request("json"), &mut file, Some(token.clone()), |chunk_request| {
                calls += 1;
                if cancel_read { token.cancel(); }
                std::future::ready(Ok(if chunk_request.offset == 0 {
                    serde_json::json!({"status":"ok","data":"first","next_offset":5,"eof":false,"value_kind":"text"})
                } else { serde_json::json!({"status":"expired"}) }))
            }).await.unwrap_err();
            assert_eq!(calls, if cancel_read { 1 } else { 2 });
            assert!(!error.is_empty());
        }
    }

    #[tokio::test]
    async fn production_writer_keeps_blob_hex_prefix_once_and_all_byte_values() {
        let hex: String = (0..=255_u8).map(|byte| format!("{byte:02x}")).collect();
        let mut file = tempfile::tempfile().unwrap();
        write_snapshot_export_with_fetch(request("json"), &mut file, None, |chunk_request| {
            let begin = chunk_request.offset as usize;
            let end = (begin + 127).min(256);
            std::future::ready(Ok(serde_json::json!({"status":"ok","data":&hex[begin*2..end*2],"next_offset":end,"eof":end==256,"value_kind":"binary"})))
        }).await.unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let result: Value = serde_json::from_reader(file).unwrap();
        assert_eq!(result[0]["PAYLOAD"], format!("0x{hex}"));
    }

    #[tokio::test]
    async fn necessary_quotes_and_formula_guard_match_existing_export() {
        for value in ["plain", "", "-000000000000000000001", " =cmd", "'plain", "'=cmd", "a,b", "a\"b"] {
            let mut req = request("csv");
            req.quote_mode = dbx_formats::csv_export::CsvQuoteMode::Necessary;
            let mut file = tempfile::tempfile().unwrap();
            write_snapshot_export_with_fetch(req, &mut file, None, |_| {
                std::future::ready(Ok(serde_json::json!({
                    "status":"ok","data":value,"next_offset":value.chars().count(),"eof":true,"value_kind":"text"
                })))
            })
            .await
            .unwrap();
            file.seek(SeekFrom::Start(0)).unwrap();
            let mut output = String::new();
            file.read_to_string(&mut output).unwrap();
            assert_eq!(
                output,
                dbx_formats::csv_export::format_query_result_csv_with_options(
                    &["ID".into(), "PAYLOAD".into()],
                    &[vec![Value::from(1), Value::from(value)]],
                    dbx_formats::csv_export::CsvQuoteMode::Necessary,
                    Some("\\N")
                )
            );
        }
    }

    #[test]
    fn cancelled_formula_scan_stops_instead_of_retrying_forever() {
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let cancel = Some(token);
        assert!(stream_formula_guard(BufReader::new(CancelableReader {
            reader: b"   -0000".as_slice(),
            cancel: &cancel
        }))
        .is_err());
    }
}
