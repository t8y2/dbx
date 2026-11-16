//! MongoDB Database Tools archive format 0.1, see common/archive/spec.md upstream.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Write};

use crc::{Crc, Digest, CRC_64_XZ};
use mongodb::bson::{doc, Document};

use super::{metadata::CollectionMetadata, PreparedCollection};

const MAGIC: u32 = 0x8199_e26d;
const TERMINATOR: [u8; 4] = [255; 4];
// Go hash/crc64 with the ECMA table reflects bits and complements the initial/final state.
const CRC: Crc<u64> = Crc::<u64>::new(&CRC_64_XZ);
pub(super) const MAX_DOCUMENT: usize = 16 * 1024 * 1024;

pub(super) enum Frame {
    End,
    Terminator,
    Document(Vec<u8>),
}

pub(super) fn read_frame(reader: &mut dyn Read) -> Result<Frame, String> {
    let frame = read_raw_frame(reader)?;
    if let Frame::Document(bytes) = &frame {
        mongodb::bson::from_slice::<Document>(bytes).map_err(|e| format!("Invalid BSON document: {e}"))?;
    }
    Ok(frame)
}

pub(super) fn read_raw_frame(reader: &mut dyn Read) -> Result<Frame, String> {
    let mut header = [0; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(Frame::End),
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    reader.read_exact(&mut header[1..]).map_err(|e| format!("Truncated BSON header: {e}"))?;
    if header == TERMINATOR {
        return Ok(Frame::Terminator);
    }
    let length = i32::from_le_bytes(header);
    if !(5..=MAX_DOCUMENT as i32).contains(&length) {
        return Err(format!("Invalid BSON frame length: {length}"));
    }
    let mut bytes = vec![0; length as usize];
    bytes[..4].copy_from_slice(&header);
    reader.read_exact(&mut bytes[4..]).map_err(|e| format!("Truncated BSON document: {e}"))?;
    mongodb::bson::RawDocument::from_bytes(&bytes).map_err(|e| format!("Invalid BSON document: {e}"))?;
    Ok(Frame::Document(bytes))
}

fn document(frame: Frame) -> Result<Document, String> {
    match frame {
        Frame::Document(bytes) => mongodb::bson::from_slice(&bytes).map_err(|e| e.to_string()),
        _ => Err("Expected an archive BSON header".into()),
    }
}

fn string(doc: &Document, key: &str) -> Result<String, String> {
    doc.get_str(key).map(String::from).map_err(|_| format!("Archive header is missing {key}"))
}

fn write_document(writer: &mut dyn Write, doc: &Document) -> Result<(), String> {
    let bytes = mongodb::bson::to_vec(doc).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_DOCUMENT {
        return Err("Archive metadata exceeds the BSON document limit".into());
    }
    writer.write_all(&bytes).map_err(|e| e.to_string())
}

pub(super) fn inspect(
    reader: &mut dyn Read,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Vec<PreparedCollection>, String> {
    let mut magic = [0; 4];
    reader.read_exact(&mut magic).map_err(|e| format!("Invalid MongoDB archive: {e}"))?;
    if u32::from_le_bytes(magic) != MAGIC {
        return Err("Not a MongoDB --archive file".into());
    }
    let header = document(read_frame(reader)?)?;
    if header.get_str("version") != Ok("0.1") {
        return Err("Unsupported MongoDB archive version".into());
    }
    let mut entries = Vec::<PreparedCollection>::new();
    let mut namespaces = HashMap::new();
    let mut metadata_bytes = 0usize;
    loop {
        check()?;
        let frame = read_frame(reader)?;
        if matches!(frame, Frame::Terminator) {
            break;
        }
        let header = document(frame)?;
        let database = string(&header, "db")?;
        super::metadata::validate_database(&database)?;
        let name = string(&header, "collection")?;
        let json = string(&header, "metadata")?;
        metadata_bytes += json.len();
        if entries.len() >= 100_000 || metadata_bytes > 128 * 1024 * 1024 {
            return Err("Archive metadata exceeds the supported limit".into());
        }
        let metadata = if json.is_empty() {
            CollectionMetadata::empty(&name)
        } else {
            CollectionMetadata::from_json(&json, &name)?
        };
        metadata.validate()?;
        if metadata.collection_name != name {
            return Err("Archive namespace does not match collection metadata".into());
        }
        if header.get_str("type").is_ok_and(|kind| kind == "timeseries") {
            return Err("Time-series archives require server-specific restore support".into());
        }
        let index = entries.len();
        if namespaces.insert((database.clone(), name), index).is_some() {
            return Err("Duplicate archive namespace".into());
        }
        entries.push(PreparedCollection {
            database,
            metadata,
            path: None,
            documents: 0,
            size_bytes: 0,
            metadata_path: None,
        });
    }
    Ok(entries)
}

pub(super) enum StreamEvent {
    Document(usize, Vec<u8>),
    End(usize),
}

pub(super) fn stream(
    reader: &mut dyn Read,
    expected: &[PreparedCollection],
    mut check: impl FnMut() -> Result<(), String>,
    mut emit: impl FnMut(StreamEvent) -> Result<(), String>,
) -> Result<(), String> {
    let entries = inspect(reader, &mut check)?;
    let namespaces: HashMap<_, _> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| ((e.database.clone(), e.metadata.collection_name.clone()), i))
        .collect();
    if entries.len() != expected.len() {
        return Err("Archive metadata changed after preview".into());
    }
    let mut mapped = Vec::with_capacity(entries.len());
    for entry in &entries {
        let index = expected
            .iter()
            .position(|e| e.database == entry.database && e.metadata.collection_name == entry.metadata.collection_name)
            .ok_or("Archive metadata changed after preview")?;
        if expected[index].metadata.to_json()? != entry.metadata.to_json()? {
            return Err("Archive metadata changed after preview".into());
        }
        mapped.push(index);
    }
    let mut digests: Vec<Digest<'_, u64>> = entries.iter().map(|_| CRC.digest()).collect();
    let mut finished = vec![false; entries.len()];
    loop {
        check()?;
        let frame = read_frame(reader)?;
        if matches!(frame, Frame::End) {
            break;
        }
        let header = document(frame)?;
        let namespace = (string(&header, "db")?, string(&header, "collection")?);
        let index = *namespaces.get(&namespace).ok_or_else(|| "Unknown namespace in archive data".to_string())?;
        if finished[index] {
            return Err("Archive contains data after namespace EOF".into());
        }
        let eof = header.get_bool("EOF").map_err(|_| "Archive header is missing EOF".to_string())?;
        let checksum = header.get_i64("CRC").map_err(|_| "Archive header is missing CRC".to_string())? as u64;
        if eof {
            if !matches!(read_frame(reader)?, Frame::Terminator) {
                return Err("Invalid archive EOF terminator".into());
            }
            if digests[index].clone().finalize() != checksum {
                return Err(format!("Archive checksum mismatch: {}.{}", namespace.0, namespace.1));
            }
            finished[index] = true;
            emit(StreamEvent::End(mapped[index]))?;
            continue;
        }
        if checksum != 0 {
            return Err("Non-EOF archive header contains a checksum".into());
        }
        let entry = &entries[index];
        loop {
            check()?;
            match read_raw_frame(reader)? {
                Frame::Document(bytes) => {
                    if entry.metadata.is_view() {
                        return Err("Archive contains BSON documents for a view".into());
                    }
                    digests[index].update(&bytes);
                    emit(StreamEvent::Document(mapped[index], bytes))?;
                }
                Frame::Terminator => break,
                Frame::End => return Err("Truncated archive namespace segment".into()),
            }
        }
    }
    for (index, entry) in entries.iter().enumerate() {
        if !finished[index] {
            return Err(format!("Missing archive EOF: {}.{}", entry.database, entry.metadata.collection_name));
        }
    }
    Ok(())
}

pub(super) fn pack(
    writer: &mut dyn Write,
    entries: &[PreparedCollection],
    server_version: &str,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    writer.write_all(&MAGIC.to_le_bytes()).map_err(|e| e.to_string())?;
    write_document(
        writer,
        &doc! { "concurrent_collections": 1i32, "version": "0.1", "server_version": server_version, "tool_version": concat!("DBX ", env!("CARGO_PKG_VERSION")) },
    )?;
    for entry in entries {
        check()?;
        write_document(
            writer,
            &doc! { "db": &entry.database, "collection": &entry.metadata.collection_name, "metadata": entry.metadata.to_json()?, "size": entry.documents as i64, "type": if entry.metadata.is_view() { "view" } else { "" } },
        )?;
    }
    writer.write_all(&TERMINATOR).map_err(|e| e.to_string())?;
    for entry in entries {
        check()?;
        if entry.metadata.is_view() {
            write_document(
                writer,
                &doc! { "db": &entry.database, "collection": &entry.metadata.collection_name, "EOF": true, "CRC": 0i64 },
            )?;
            writer.write_all(&TERMINATOR).map_err(|e| e.to_string())?;
            continue;
        }
        let mut digest = CRC.digest();
        let path = entry.path.as_ref().ok_or_else(|| "Missing collection BSON file".to_string())?;
        let mut reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
        let mut opened = false;
        loop {
            check()?;
            match read_frame(&mut reader)? {
                Frame::End => break,
                Frame::Terminator => return Err("Unexpected terminator in BSON file".into()),
                Frame::Document(bytes) => {
                    if !opened {
                        write_document(
                            writer,
                            &doc! { "db": &entry.database, "collection": &entry.metadata.collection_name, "EOF": false, "CRC": 0i64 },
                        )?;
                        opened = true;
                    }
                    writer.write_all(&bytes).map_err(|e| e.to_string())?;
                    digest.update(&bytes);
                }
            }
        }
        if opened {
            writer.write_all(&TERMINATOR).map_err(|e| e.to_string())?;
        }
        write_document(
            writer,
            &doc! { "db": &entry.database, "collection": &entry.metadata.collection_name, "EOF": true, "CRC": digest.finalize() as i64 },
        )?;
        writer.write_all(&TERMINATOR).map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_matches_go_crc64_ecma() {
        assert_eq!(CRC.checksum(b"123456789"), 0x995d_c9bb_df19_39fa);
    }
}
