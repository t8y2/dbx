//! Bounded schema-less Protobuf wire decoding for Redis values.

use crate::redis_codec_support::{DecodeBudget, MAX_INPUT_BYTES};
use serde_json::{map::Entry, Map, Value};

pub fn decode_protobuf_with_budget(bytes: &[u8], remaining: &mut usize) -> Option<Value> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return None;
    }
    let mut budget = DecodeBudget::new(remaining);
    budget.spend(bytes.len()).ok()?;
    message(bytes, &mut budget, 0).ok()
}

enum Error {
    Invalid,
    Limit,
}

impl From<()> for Error {
    fn from(_: ()) -> Self {
        Self::Limit
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize, budget: &mut DecodeBudget<'_>) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(count).ok_or(Error::Invalid)?;
        let bytes = self.bytes.get(self.pos..end).ok_or(Error::Invalid)?;
        budget.spend(count)?;
        self.pos = end;
        Ok(bytes)
    }

    fn varint(&mut self, budget: &mut DecodeBudget<'_>) -> Result<u64, Error> {
        let mut value = 0;
        for index in 0..10 {
            let byte = self.take(1, budget)?[0];
            if index == 9 && byte > 1 {
                return Err(Error::Invalid);
            }
            value |= u64::from(byte & 127) << (7 * index);
            if byte & 128 == 0 {
                return Ok(value);
            }
        }
        Err(Error::Invalid)
    }
}

fn message(bytes: &[u8], budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, Error> {
    budget.node(depth)?;
    let mut reader = Reader { bytes, pos: 0 };
    let mut fields = Map::new();
    while reader.pos < bytes.len() {
        budget.node(depth + 1)?;
        let tag = reader.varint(budget)?;
        let field = tag >> 3;
        if field == 0 || field > 0x1fff_ffff {
            return Err(Error::Invalid);
        }
        let value = match tag & 7 {
            0 => {
                let raw = reader.varint(budget)?;
                if raw <= 9_007_199_254_740_991 {
                    Value::from(raw)
                } else {
                    Value::String(raw.to_string())
                }
            }
            1 => Value::String(hex(reader.take(8, budget)?, budget)?),
            2 => {
                let length = usize::try_from(reader.varint(budget)?).map_err(|_| Error::Invalid)?;
                delimited(reader.take(length, budget)?, budget, depth + 1)?
            }
            5 => Value::String(hex(reader.take(4, budget)?, budget)?),
            _ => return Err(Error::Invalid),
        };
        match fields.entry(field.to_string()) {
            Entry::Vacant(entry) => {
                entry.insert(value);
            }
            Entry::Occupied(mut entry) => {
                if let Value::Array(values) = entry.get_mut() {
                    values.push(value);
                } else {
                    budget.node(depth + 1)?;
                    let previous = entry.insert(Value::Null);
                    entry.insert(Value::Array(vec![previous, value]));
                }
            }
        }
    }
    if fields.is_empty() {
        return Err(Error::Invalid);
    }
    Ok(Value::Object(fields))
}

fn delimited(bytes: &[u8], budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, Error> {
    if !bytes.is_empty() {
        match message(bytes, budget, depth) {
            Ok(value) => return Ok(value),
            Err(Error::Limit) => return Err(Error::Limit),
            // Failed guesses retain all node/work charges. Each slice is tried once.
            Err(Error::Invalid) => {}
        }
    }
    budget.spend(bytes.len())?;
    if let Ok(text) = std::str::from_utf8(bytes) {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        if text.chars().all(|ch| ch >= ' ' || matches!(ch, '\t' | '\n' | '\r')) {
            budget.spend(bytes.len())?;
            return Ok(Value::String(text.to_owned()));
        }
    }
    budget.node(depth + 1)?;
    let mut object = Map::new();
    object.insert("$bytes".into(), Value::String(hex(bytes, budget)?));
    Ok(Value::Object(object))
}

fn hex(bytes: &[u8], budget: &mut DecodeBudget<'_>) -> Result<String, Error> {
    let length = bytes.len().checked_mul(2).ok_or(Error::Limit)?;
    budget.spend(length)?;
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(length);
    for byte in bytes {
        result.push(char::from(DIGITS[usize::from(byte >> 4)]));
        result.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode(bytes: &[u8]) -> Option<serde_json::Value> {
        decode_protobuf_with_budget(bytes, &mut (16 * 1024 * 1024))
    }

    #[test]
    fn decodes_desktop_varints_strings_repetition_and_nested_fields() {
        assert_eq!(
            decode(&[0x08, 0x96, 1, 0x12, 9, b'h', b'e', b'l', b'l', b'o', b' ', b'd', b'b', b'x']),
            Some(json!({"1":150,"2":"hello dbx"}))
        );
        assert_eq!(decode(&[0x1a, 1, b'a', 0x1a, 1, b'b', 0x1a, 1, b'c']), Some(json!({"3":["a","b","c"]})));
        assert_eq!(decode(&[0x0a, 2, 8, 7]), Some(json!({"1":{"1":7}})));
        assert_eq!(decode(&[0x08, 1, 0x0a, 2, 8, 7]), Some(json!({"1":[1,{"1":7}]})));
    }

    #[test]
    fn length_delimited_values_use_nested_then_readable_utf8_then_hex() {
        assert_eq!(decode(&[0x0a, 2, 0, 0xff]), Some(json!({"1":{"$bytes":"00ff"}})));
        assert_eq!(decode(&[0x0a, 2, b'a', 0]), Some(json!({"1":{"$bytes":"6100"}})));
        assert_eq!(decode(&[0x0a, 3, b'\t', b'\n', b'\r']), Some(json!({"1":"\t\n\r"})));
        assert_eq!(decode(&[0x0a, 2, 0xc3, 0xa9]), Some(json!({"1":"\u{e9}"})));
        assert_eq!(decode(&[0x0a, 0]), Some(json!({"1":""})));
        // "\u{10}A" is valid wire data and wins over text heuristics.
        assert_eq!(decode(&[0x0a, 2, 0x10, b'A']), Some(json!({"1":{"2":65}})));
    }

    #[test]
    fn fixed_width_fields_render_original_byte_order_as_hex() {
        assert_eq!(
            decode(&[0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x15, 0xff, 0, 0xaa, 0x55]),
            Some(json!({"1":"0102030405060708","2":"ff00aa55"}))
        );
    }

    #[test]
    fn text_matches_desktop_bom_handling() {
        assert_eq!(decode(&[0x0a, 4, 0xef, 0xbb, 0xbf, b'x']), Some(json!({"1":"x"})));
    }

    #[test]
    fn large_varints_are_exact_and_maximum_field_is_accepted() {
        assert_eq!(
            decode(&[8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40]),
            Some(json!({"1":"4611686018427387904"}))
        );
        assert_eq!(
            decode(&[8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1]),
            Some(json!({"1":"18446744073709551615"}))
        );
        assert_eq!(decode(&[0xf8, 0xff, 0xff, 0xff, 0x0f, 1]), Some(json!({"536870911":1})));
    }

    #[test]
    fn rejects_invalid_tags_overflow_and_truncated_wire_values() {
        for bytes in [
            vec![],
            vec![0],
            vec![1],
            vec![0x0b],
            vec![0x0c],
            vec![0x0e],
            vec![0x0f],
            vec![8],
            vec![8, 0x80],
            vec![0x0a, 9, b'h', b'e', b'l', b'l'],
            vec![0x09, 1, 2],
            vec![0x0d, 1, 2],
            vec![8, 1, 0],
            vec![0x80, 0x80, 0x80, 0x80, 0x10, 1],
            vec![8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2],
            vec![8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0],
            vec![0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 1],
        ] {
            assert!(decode(&bytes).is_none(), "{bytes:x?}");
        }
    }

    #[test]
    fn failed_nested_attempts_charge_the_shared_budget() {
        let payload = [0x0a, 4, 8, 1, 0, 0];
        let mut remaining = 1024;
        assert_eq!(decode_protobuf_with_budget(&payload, &mut remaining), Some(json!({"1":{"$bytes":"08010000"}})));
        assert!(remaining < 1024 - 3 * 32);
        let mut remaining = 95;
        assert!(decode_protobuf_with_budget(&payload, &mut remaining).is_none());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn enforces_input_depth_and_node_limits() {
        assert!(decode(&vec![0; 1024 * 1024 + 1]).is_none());
        let mut deep = vec![8, 1];
        for _ in 0..64 {
            let len = deep.len();
            let mut outer = vec![0x0a];
            let mut value = len;
            while value >= 128 {
                outer.push((value as u8 & 127) | 128);
                value >>= 7;
            }
            outer.push(value as u8);
            outer.extend(deep);
            deep = outer;
        }
        assert!(decode(&deep).is_none());
        assert!(decode(&[8, 1].repeat(32768)).is_none());
    }
}
