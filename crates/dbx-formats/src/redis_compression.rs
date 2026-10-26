//! Bounded, checksum-verified Redis value decompression.
use std::io::{Cursor, Read};

use flate2::{bufread::MultiGzDecoder, Decompress, FlushDecompress, Status};

use crate::redis_codec_support::{DecodeBudget, MAX_INPUT_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedisCompression {
    Gzip,
    Zlib,
    Deflate,
}

impl RedisCompression {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gzip => "gzip",
            Self::Zlib => "zlib",
            Self::Deflate => "deflate",
        }
    }
}

/// Raw DEFLATE has no reliable signature and is never automatically selected.
pub fn detect_redis_compression(bytes: &[u8]) -> Option<RedisCompression> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Some(RedisCompression::Gzip);
    }
    let [a, b, ..] = bytes else {
        return None;
    };
    if a & 0x0f == 8 && a >> 4 <= 7 && (u16::from(*a) * 256 + u16::from(*b)) % 31 == 0 {
        Some(RedisCompression::Zlib)
    } else {
        None
    }
}

pub fn decompress_redis_value_with_budget(
    bytes: &[u8],
    algorithm: Option<RedisCompression>,
    remaining: &mut usize,
) -> Option<(RedisCompression, Vec<u8>)> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return None;
    }
    let algorithm = algorithm.or_else(|| detect_redis_compression(bytes))?;
    let mut budget = DecodeBudget::new(remaining);
    budget.spend(bytes.len()).ok()?;
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    if algorithm == RedisCompression::Gzip {
        let mut decoder = MultiGzDecoder::new(Cursor::new(bytes));
        loop {
            let count = decoder.read(&mut chunk).ok()?;
            if count == 0 {
                break;
            }
            append(&mut output, &chunk[..count], &mut budget).ok()?;
        }
        if decoder.get_ref().position() as usize != bytes.len() {
            return None;
        }
    } else {
        let mut decoder = Decompress::new(algorithm == RedisCompression::Zlib);
        loop {
            let start_in = decoder.total_in();
            let start_out = decoder.total_out();
            let status = decoder.decompress(&bytes[start_in as usize..], &mut chunk, FlushDecompress::Finish).ok()?;
            let count = (decoder.total_out() - start_out) as usize;
            append(&mut output, &chunk[..count], &mut budget).ok()?;
            if status == Status::StreamEnd {
                if decoder.total_in() as usize != bytes.len() {
                    return None;
                }
                break;
            }
            if decoder.total_in() == start_in && count == 0 {
                return None;
            }
        }
    }
    Some((algorithm, output))
}

fn append(output: &mut Vec<u8>, chunk: &[u8], budget: &mut DecodeBudget<'_>) -> Result<(), ()> {
    if output.len().saturating_add(chunk.len()) > MAX_INPUT_BYTES {
        return Err(());
    }
    budget.spend(chunk.len())?;
    output.extend_from_slice(chunk);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{
        write::{DeflateEncoder, GzEncoder, ZlibEncoder},
        Compression,
    };
    use std::io::Write;

    fn compressed(input: &[u8], algorithm: RedisCompression) -> Vec<u8> {
        match algorithm {
            RedisCompression::Gzip => {
                let mut out = GzEncoder::new(Vec::new(), Compression::default());
                out.write_all(input).unwrap();
                out.finish().unwrap()
            }
            RedisCompression::Zlib => {
                let mut out = ZlibEncoder::new(Vec::new(), Compression::default());
                out.write_all(input).unwrap();
                out.finish().unwrap()
            }
            RedisCompression::Deflate => {
                let mut out = DeflateEncoder::new(Vec::new(), Compression::default());
                out.write_all(input).unwrap();
                out.finish().unwrap()
            }
        }
    }

    #[test]
    fn decodes_framed_formats_and_explicit_raw_deflate() {
        for algorithm in [RedisCompression::Gzip, RedisCompression::Zlib, RedisCompression::Deflate] {
            let bytes = compressed(b"hello dbx", algorithm);
            let mut remaining = 16 * 1024 * 1024;
            assert_eq!(
                decompress_redis_value_with_budget(&bytes, Some(algorithm), &mut remaining),
                Some((algorithm, b"hello dbx".to_vec()))
            );
            let result = decompress_redis_value_with_budget(&bytes, None, &mut remaining);
            if algorithm == RedisCompression::Deflate {
                assert_eq!(result, None);
            } else {
                assert_eq!(result, Some((algorithm, b"hello dbx".to_vec())));
            }
        }
    }

    #[test]
    fn rejects_checksum_errors_truncation_and_trailing_bytes() {
        for algorithm in [RedisCompression::Gzip, RedisCompression::Zlib, RedisCompression::Deflate] {
            let bytes = compressed(b"hello dbx", algorithm);
            for end in 0..bytes.len() {
                assert!(
                    decompress_redis_value_with_budget(&bytes[..end], Some(algorithm), &mut (16 * 1024 * 1024))
                        .is_none(),
                    "{algorithm:?} prefix {end}"
                );
            }
            let mut trailing = bytes.clone();
            trailing.push(0x42);
            assert!(
                decompress_redis_value_with_budget(&trailing, Some(algorithm), &mut (16 * 1024 * 1024)).is_none(),
                "{algorithm:?} trailing"
            );
            if algorithm != RedisCompression::Deflate {
                let mut corrupt = bytes.clone();
                let last = corrupt.len() - 1;
                corrupt[last] ^= 1;
                assert!(
                    decompress_redis_value_with_budget(&corrupt, Some(algorithm), &mut (16 * 1024 * 1024)).is_none()
                );
            }
        }
    }

    #[test]
    fn rejects_bombs_and_shared_budget_exhaustion_during_inflate() {
        let bytes = compressed(&vec![b'a'; 2 * 1024 * 1024], RedisCompression::Gzip);
        assert!(decompress_redis_value_with_budget(&bytes, None, &mut (16 * 1024 * 1024)).is_none());
        let bytes = compressed(b"hello dbx", RedisCompression::Gzip);
        let mut remaining = 8;
        assert!(decompress_redis_value_with_budget(&bytes, None, &mut remaining).is_none());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn reads_all_gzip_members() {
        let mut bytes = compressed(b"one", RedisCompression::Gzip);
        bytes.extend(compressed(b"two", RedisCompression::Gzip));
        assert_eq!(
            decompress_redis_value_with_budget(&bytes, None, &mut (16 * 1024 * 1024)),
            Some((RedisCompression::Gzip, b"onetwo".to_vec()))
        );
    }
}
