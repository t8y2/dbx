use std::{
    collections::HashMap,
    io::{self, Cursor, Read},
};

use mysql_common::binlog::{
    consts::BinlogVersion,
    events::{EventData, OptionalMetadataField, RowsEventData},
    row::BinlogRow,
    EventStreamReader,
};

pub const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct Inspection {
    pub events: u64,
    pub end_position: u64,
    pub server_version: String,
    pub rows: u64,
    pub commits: u64,
    pub partial_rows: u64,
    pub unsupported_events: u64,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug)]
pub struct Diagnostic {
    pub position: u64,
    pub event_type: u8,
}

#[derive(Debug, Clone)]
pub struct RowChange {
    pub position: u64,
    pub database: Vec<u8>,
    pub table: Vec<u8>,
    pub before: Option<BinlogRow>,
    pub after: Option<BinlogRow>,
    pub before_columns: Vec<usize>,
    pub after_columns: Vec<usize>,
    pub full_image: bool,
    pub has_signedness: bool,
    pub has_column_names: bool,
    pub wire_columns: Vec<WireColumn>,
    pub event_size: usize,
}

#[derive(Debug, Clone)]
pub struct WireColumn {
    pub type_code: u8,
    pub metadata: Vec<u8>,
    pub nullable: bool,
}

pub(crate) enum LogEvent {
    Row(RowChange),
    Begin { position: u64 },
    Commit { end_position: u64, timestamp: u32 },
    Rollback,
    Gtid { position: u64, value: Option<String> },
    Barrier { position: u64, event_type: u8 },
}

pub(crate) fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn frame<R: Read>(input: &mut R, position: u64) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 19];
    match input.read_exact(&mut header[..1]) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    input.read_exact(&mut header[1..]).map_err(|error| invalid(format!("truncated header at {position}: {error}")))?;
    let size = u32::from_le_bytes(header[9..13].try_into().unwrap()) as usize;
    if !(23..=MAX_EVENT_BYTES).contains(&size) {
        return Err(invalid(format!("invalid event size {size} at {position}")));
    }
    let next = u32::from_le_bytes(header[13..17].try_into().unwrap()) as u64;
    if next != position + size as u64 {
        return Err(invalid(format!("invalid next position {next} at {position}")));
    }
    let mut bytes = vec![0; size];
    bytes[..19].copy_from_slice(&header);
    input.read_exact(&mut bytes[19..]).map_err(|error| invalid(format!("truncated body at {position}: {error}")))?;
    Ok(Some(bytes))
}

fn validate_checksum(bytes: &[u8], position: u64) -> io::Result<()> {
    let end = bytes.len() - 4;
    let expected = u32::from_le_bytes(bytes[end..].try_into().unwrap());
    let mut hash = crc32fast::Hasher::new();
    if bytes[4] == 15 {
        // MySQL excludes the mutable BINLOG_IN_USE flag from the FDE checksum.
        hash.update(&bytes[..17]);
        hash.update(&[bytes[17] & !1, bytes[18]]);
        hash.update(&bytes[19..end]);
    } else {
        hash.update(&bytes[..end]);
    }
    if hash.finalize() != expected {
        return Err(invalid(format!("checksum mismatch at {position}")));
    }
    Ok(())
}

fn unsupported(result: &mut Inspection, position: u64, event_type: u8) {
    result.unsupported_events += 1;
    if result.diagnostics.len() < 32 {
        result.diagnostics.push(Diagnostic { position, event_type });
    }
}

fn inspect_rows(
    rows: &RowsEventData<'_>,
    decoder: &EventStreamReader,
    position: u64,
    event_size: usize,
    result: &mut Inspection,
    on_row: &mut impl FnMut(RowChange) -> io::Result<()>,
) -> io::Result<()> {
    let table = decoder.get_tme(rows.table_id()).ok_or_else(|| invalid(format!("missing table map at {position}")))?;
    if table.columns_count() != rows.num_columns() {
        return Err(invalid(format!("table map column count mismatch at {position}")));
    }
    let before_columns: Vec<usize> =
        rows.columns_before_image().map(|bits| bits.iter_ones().collect()).unwrap_or_default();
    let after_columns: Vec<usize> =
        rows.columns_after_image().map(|bits| bits.iter_ones().collect()).unwrap_or_default();
    let full_image = rows.columns_before_image().is_none_or(|bits| bits.all())
        && rows.columns_after_image().is_none_or(|bits| bits.all());
    let mut has_signedness = false;
    let mut has_column_names = false;
    for field in table.iter_optional_meta() {
        match field? {
            OptionalMetadataField::Signedness(_) => has_signedness = true,
            OptionalMetadataField::ColumnName(_) => has_column_names = true,
            _ => {}
        }
    }
    for row in rows.rows(table) {
        let (before, after) = row?;
        result.rows += 1;
        if !full_image {
            result.partial_rows += 1;
        }
        let wire_columns = (0..table.columns_count() as usize)
            .map(|i| {
                Ok(WireColumn {
                    type_code: table
                        .get_column_type(i)
                        .map_err(|e| invalid(e.to_string()))?
                        .ok_or_else(|| invalid("missing wire column type"))? as u8,
                    metadata: table.get_column_metadata(i).unwrap_or_default().to_vec(),
                    nullable: table.null_bitmask().get(i).as_deref().copied().unwrap_or(false),
                })
            })
            .collect::<io::Result<Vec<_>>>()?;
        on_row(RowChange {
            position,
            database: table.database_name_raw().to_vec(),
            table: table.table_name_raw().to_vec(),
            before,
            after,
            before_columns: before_columns.clone(),
            after_columns: after_columns.clone(),
            full_image,
            has_signedness,
            has_column_names,
            wire_columns,
            event_size,
        })?;
    }
    Ok(())
}

pub fn inspect<R: Read>(input: R, mut on_row: impl FnMut(RowChange)) -> io::Result<Inspection> {
    scan(input, |event| {
        if let LogEvent::Row(row) = event {
            on_row(row);
        }
        Ok(())
    })
}

pub(crate) fn scan<R: Read>(
    mut input: R,
    mut on_event: impl FnMut(LogEvent) -> io::Result<()>,
) -> io::Result<Inspection> {
    let mut magic = [0u8; 4];
    input.read_exact(&mut magic)?;
    if magic != *b"\xfebin" {
        return Err(invalid("invalid binlog magic"));
    }
    let mut result = Inspection { end_position: 4, ..Inspection::default() };
    let mut decoder = EventStreamReader::new(BinlogVersion::Version4);
    let mut table_maps = HashMap::<[u8; 6], usize>::new();
    while let Some(bytes) = frame(&mut input, result.end_position)? {
        let position = result.end_position;
        if position + bytes.len() as u64 > 512 * 1024 * 1024 || result.events >= 1_000_000 {
            return Err(invalid("binlog inspection file/event limit exceeded"));
        }
        if (result.events == 0) != (bytes[4] == 15) {
            return Err(invalid(format!("missing or duplicate format description at {position}")));
        }
        if bytes[4] == 15 && (bytes.len() < 81 || bytes[bytes.len() - 5] != 1) {
            return Err(invalid("probe requires a CRC32 format description"));
        }
        validate_checksum(&bytes, position)?;
        if bytes[4] == 19 {
            if bytes.len() < 27 || bytes.len() > 1024 * 1024 {
                return Err(invalid("invalid table map size"));
            }
            table_maps.insert(bytes[19..25].try_into().unwrap(), bytes.len());
            if table_maps.len() > 128 || table_maps.values().sum::<usize>() > 8 * 1024 * 1024 {
                return Err(invalid("table map limit exceeded"));
            }
        }
        let event = decoder.read(Cursor::new(&bytes))?.ok_or_else(|| invalid("decoder returned no event"))?;
        match event.read_data()? {
            Some(EventData::FormatDescriptionEvent(description)) => {
                result.server_version = description.server_version().trim_end_matches('\0').to_owned();
            }
            Some(EventData::RowsEvent(RowsEventData::PartialUpdateRowsEvent(_))) => {
                unsupported(&mut result, position, bytes[4]);
                on_event(LogEvent::Barrier { position, event_type: bytes[4] })?;
            }
            Some(EventData::RowsEvent(rows)) => {
                inspect_rows(&rows, &decoder, position, bytes.len(), &mut result, &mut |row| {
                    on_event(LogEvent::Row(row))
                })?;
            }
            Some(EventData::XidEvent(_)) => {
                result.commits += 1;
                on_event(LogEvent::Commit {
                    end_position: position + bytes.len() as u64,
                    timestamp: event.header().timestamp(),
                })?;
            }
            Some(EventData::QueryEvent(query)) => {
                let sql = query.query_raw().trim_ascii();
                if sql.eq_ignore_ascii_case(b"COMMIT") {
                    result.commits += 1;
                    on_event(LogEvent::Commit {
                        end_position: position + bytes.len() as u64,
                        timestamp: event.header().timestamp(),
                    })?;
                } else if sql.eq_ignore_ascii_case(b"BEGIN") {
                    on_event(LogEvent::Begin { position })?;
                } else if sql.eq_ignore_ascii_case(b"ROLLBACK") {
                    on_event(LogEvent::Rollback)?;
                } else {
                    unsupported(&mut result, position, bytes[4]);
                    on_event(LogEvent::Barrier { position, event_type: bytes[4] })?;
                }
            }
            Some(EventData::GtidEvent(gtid)) if !gtid.is_tagged() => {
                let sid: String = gtid.sid().iter().map(|byte| format!("{byte:02x}")).collect();
                let value = format!(
                    "{}-{}-{}-{}-{}:{}",
                    &sid[..8],
                    &sid[8..12],
                    &sid[12..16],
                    &sid[16..20],
                    &sid[20..],
                    gtid.gno()
                );
                on_event(LogEvent::Gtid { position, value: Some(value) })?;
            }
            Some(EventData::AnonymousGtidEvent(_)) => on_event(LogEvent::Gtid { position, value: None })?,
            Some(
                EventData::TableMapEvent(_)
                | EventData::PreviousGtidsEvent(_)
                | EventData::RowsQueryEvent(_)
                | EventData::RotateEvent(_)
                | EventData::StopEvent,
            ) => {}
            _ => {
                unsupported(&mut result, position, bytes[4]);
                on_event(LogEvent::Barrier { position, event_type: bytes[4] })?;
            }
        }
        result.events += 1;
        result.end_position += bytes.len() as u64;
    }
    if result.events == 0 {
        return Err(invalid("missing format description"));
    }
    Ok(result)
}
