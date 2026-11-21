//! Bounded, data-only MessagePack decoding for Redis values.

use crate::redis_codec_support::{DecodeBudget, MAX_INPUT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{Map, Number, Value};

pub fn decode_msgpack_with_budget(bytes: &[u8], remaining: &mut usize) -> Option<Value> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return None;
    }
    let mut budget = DecodeBudget::new(remaining);
    budget.spend(bytes.len()).ok()?;
    let mut reader = Reader { bytes, pos: 0 };
    let value = reader.value(&mut budget, 0).ok()?;
    (reader.pos == bytes.len()).then_some(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize, budget: &mut DecodeBudget<'_>) -> Result<&'a [u8], ()> {
        let end = self.pos.checked_add(count).ok_or(())?;
        let bytes = self.bytes.get(self.pos..end).ok_or(())?;
        budget.spend(count)?;
        self.pos = end;
        Ok(bytes)
    }

    fn uint(&mut self, count: usize, budget: &mut DecodeBudget<'_>) -> Result<u64, ()> {
        Ok(self.take(count, budget)?.iter().fold(0, |value, byte| (value << 8) | u64::from(*byte)))
    }

    fn string(&mut self, count: usize, budget: &mut DecodeBudget<'_>) -> Result<Value, ()> {
        let text = std::str::from_utf8(self.take(count, budget)?).map_err(|_| ())?;
        budget.spend(count)?;
        Ok(Value::String(text.to_owned()))
    }

    fn binary(&mut self, count: usize, budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, ()> {
        let bytes = self.take(count, budget)?;
        if let Ok(text) = std::str::from_utf8(bytes) {
            budget.spend(count)?;
            return Ok(Value::String(text.strip_prefix('\u{feff}').unwrap_or(text).to_owned()));
        }
        budget.node(depth + 1)?;
        budget.spend(count.div_ceil(3).checked_mul(4).ok_or(())?)?;
        let mut object = Map::new();
        object.insert("$bytes".into(), Value::String(STANDARD.encode(bytes)));
        Ok(Value::Object(object))
    }

    fn array(&mut self, count: usize, budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, ()> {
        if count > self.bytes.len() - self.pos {
            return Err(());
        }
        let mut values = Vec::new();
        for _ in 0..count {
            values.push(self.value(budget, depth + 1)?);
        }
        Ok(Value::Array(values))
    }

    fn map(&mut self, count: usize, budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, ()> {
        if count > (self.bytes.len() - self.pos) / 2 {
            return Err(());
        }
        let mut values = Map::new();
        for _ in 0..count {
            if !matches!(
                self.bytes.get(self.pos),
                Some(0x00..=0x7f | 0xa0..=0xbf | 0xca..=0xd3 | 0xd9..=0xdb | 0xe0..=0xff)
            ) {
                return Err(());
            }
            let key = match self.value(budget, depth + 1)? {
                Value::String(key) => key,
                Value::Number(number) if number.is_f64() => number_key(number.as_f64().ok_or(())?),
                Value::Number(number) => number.to_string(),
                _ => return Err(()),
            };
            // Match the desktop decoder's rejection of prototype-mutating keys.
            if key == "__proto__" {
                return Err(());
            }
            let value = self.value(budget, depth + 1)?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }

    fn value(&mut self, budget: &mut DecodeBudget<'_>, depth: usize) -> Result<Value, ()> {
        budget.node(depth)?;
        let tag = self.uint(1, budget)? as u8;
        match tag {
            0x00..=0x7f => Ok(Value::from(tag)),
            0x80..=0x8f => self.map(usize::from(tag & 15), budget, depth),
            0x90..=0x9f => self.array(usize::from(tag & 15), budget, depth),
            0xa0..=0xbf => self.string(usize::from(tag & 31), budget),
            0xc0 => Ok(Value::Null),
            0xc2 => Ok(Value::Bool(false)),
            0xc3 => Ok(Value::Bool(true)),
            0xc4..=0xc6 => {
                let count = self.uint(1 << (tag - 0xc4), budget)? as usize;
                self.binary(count, budget, depth)
            }
            0xca => {
                let value = f32::from_bits(self.uint(4, budget)? as u32);
                Ok(float(f64::from(value)))
            }
            0xcb => Ok(float(f64::from_bits(self.uint(8, budget)?))),
            0xcc..=0xcf => Ok(unsigned(self.uint(1 << (tag - 0xcc), budget)?)),
            0xd0..=0xd3 => {
                let width = 1 << (tag - 0xd0);
                let raw = self.uint(width, budget)?;
                let shift = 64 - width * 8;
                Ok(signed(((raw << shift) as i64) >> shift))
            }
            0xd9..=0xdb => {
                let count = self.uint(1 << (tag - 0xd9), budget)? as usize;
                self.string(count, budget)
            }
            0xdc..=0xdd => {
                let count = self.uint(2 << (tag - 0xdc), budget)? as usize;
                self.array(count, budget, depth)
            }
            0xde..=0xdf => {
                let count = self.uint(2 << (tag - 0xde), budget)? as usize;
                self.map(count, budget, depth)
            }
            0xe0..=0xff => Ok(Value::from(tag as i8)),
            // Reserved marker and extension records need an explicit type contract.
            _ => Err(()),
        }
    }
}

fn unsigned(value: u64) -> Value {
    if value <= 9_007_199_254_740_991 {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

fn signed(value: i64) -> Value {
    if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value) {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

fn float(value: f64) -> Value {
    Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
}

fn number_key(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let scientific = format!("{value:e}");
        if let Some((mantissa, exponent)) = scientific.split_once('e') {
            if !exponent.starts_with('-') {
                return format!("{mantissa}e+{exponent}");
            }
        }
        return scientific;
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode(bytes: &[u8]) -> Option<serde_json::Value> {
        decode_msgpack_with_budget(bytes, &mut (16 * 1024 * 1024))
    }

    #[test]
    fn decodes_desktop_objects_arrays_and_scalars() {
        assert_eq!(
            decode(&[
                0x82, 0xa4, b't', b'a', b's', b'k', 0xa3, b'a', b'd', b'd', 0xa5, b'v', b'a', b'l', b'u', b'e', 3
            ]),
            Some(json!({"task":"add","value":3}))
        );
        assert_eq!(
            decode(&[0x94, 0xa5, b'h', b'e', b'l', b'l', b'o', 1, 0xc0, 0xc3]),
            Some(json!(["hello", 1, null, true]))
        );
        assert_eq!(decode(&[0xa5, b'p', b'l', b'a', b'i', b'n']), Some(json!("plain")));
        assert_eq!(decode(&[0xc2]), Some(json!(false)));
        assert_eq!(decode(&[0x90]), Some(json!([])));
        assert_eq!(decode(&[0x80]), Some(json!({})));
    }

    #[test]
    fn binary_values_use_utf8_or_base64() {
        assert_eq!(decode(&[0xc4, 3, b'd', b'b', b'x']), Some(json!("dbx")));
        assert_eq!(decode(&[0xc4, 3, 0, 0xff, 0xfe]), Some(json!({"$bytes":"AP/+"})));
        assert_eq!(decode(&[0xc5, 0, 0]), Some(json!("")));
        assert_eq!(decode(&[0xc6, 0, 0, 0, 1, b'x']), Some(json!("x")));
    }

    #[test]
    fn integers_preserve_values_beyond_javascript_precision() {
        assert_eq!(decode(&[0xcf, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Some(json!(9007199254740991u64)));
        assert_eq!(decode(&[0xcf, 0, 0x20, 0, 0, 0, 0, 0, 1]), Some(json!("9007199254740993")));
        assert_eq!(
            decode(&[0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            Some(json!("18446744073709551615"))
        );
        assert_eq!(decode(&[0xd3, 0x80, 0, 0, 0, 0, 0, 0, 0]), Some(json!("-9223372036854775808")));
        assert_eq!(decode(&[0x81, 0xff, 42]), Some(json!({"-1":42})));
    }

    #[test]
    fn map_keys_match_desktop_string_and_number_contract() {
        assert_eq!(decode(&[0x81, 0xca, 0x3f, 0x80, 0, 0, 7]), Some(json!({"1":7})));
        assert_eq!(decode(&[0x82, 0xa1, b'x', 1, 0xa1, b'x', 2]), Some(json!({"x":2})));
        assert!(decode(&[0x81, 0xc4, 1, b'x', 7]).is_none());
    }

    #[test]
    fn binary_text_matches_desktop_bom_handling() {
        assert_eq!(decode(&[0xc4, 4, 0xef, 0xbb, 0xbf, b'x']), Some(json!("x")));
    }

    #[test]
    fn decodes_all_numeric_widths_and_nonfinite_json_values() {
        for (bytes, expected) in [
            (vec![0xcc, 0xff], json!(255)),
            (vec![0xcd, 1, 0], json!(256)),
            (vec![0xce, 0xff, 0xff, 0xff, 0xff], json!(4294967295u64)),
            (vec![0xd0, 0x80], json!(-128)),
            (vec![0xd1, 0x80, 0], json!(-32768)),
            (vec![0xd2, 0x80, 0, 0, 0], json!(-2147483648i64)),
            (vec![0xca, 0x3f, 0xc0, 0, 0], json!(1.5)),
            (vec![0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0], json!(1.5)),
            (vec![0xca, 0x7f, 0x80, 0, 0], json!(null)),
        ] {
            assert_eq!(decode(&bytes), Some(expected), "{bytes:x?}");
        }
    }

    #[test]
    fn decodes_wide_string_and_container_headers() {
        assert_eq!(decode(&[0xd9, 1, b'x']), Some(json!("x")));
        assert_eq!(decode(&[0xda, 0, 1, b'x']), Some(json!("x")));
        assert_eq!(decode(&[0xdb, 0, 0, 0, 1, b'x']), Some(json!("x")));
        assert_eq!(decode(&[0xdc, 0, 1, 7]), Some(json!([7])));
        assert_eq!(decode(&[0xdd, 0, 0, 0, 1, 7]), Some(json!([7])));
        assert_eq!(decode(&[0xde, 0, 1, 0xa1, b'x', 7]), Some(json!({"x":7})));
        assert_eq!(decode(&[0xdf, 0, 0, 0, 1, 0xa1, b'x', 7]), Some(json!({"x":7})));
    }

    #[test]
    fn rejects_corruption_trailing_data_extensions_and_invalid_keys() {
        for bytes in [
            vec![],
            vec![0xc1],
            vec![1, 2],
            vec![0xa2, b'x'],
            vec![0xd9, 1, 0xff],
            vec![0x81, 0xc3, 1],
            vec![0xdd, 0xff, 0xff, 0xff, 0xff],
            vec![0xdf, 0xff, 0xff, 0xff, 0xff],
            vec![0xd6, 0xff, 0, 0, 0, 0],
            vec![0xc7, 1, 42, 0],
        ] {
            assert!(decode(&bytes).is_none(), "{bytes:x?}");
        }
        let mut prototype = vec![0x81, 0xa9];
        prototype.extend_from_slice(b"__proto__");
        prototype.push(1);
        assert!(decode(&prototype).is_none());
    }

    #[test]
    fn rejects_every_truncated_prefix_of_a_complete_value() {
        let bytes = [0x82, 0xa1, b'x', 0xcf, 0, 0x20, 0, 0, 0, 0, 0, 1, 0xa1, b'y', 0x92, 0xc4, 2, 0xff, 0xfe, 0xc0];
        assert!(decode(&bytes).is_some());
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end]).is_none());
        }
    }

    #[test]
    fn enforces_input_depth_nodes_and_shared_work() {
        assert!(decode(&vec![0; 1024 * 1024 + 1]).is_none());
        let mut deep = vec![0x91; 64];
        deep.push(0);
        assert!(decode(&deep).is_none());
        let mut many = vec![0xdd, 0, 0, 0x80, 0];
        many.resize(many.len() + 32768, 0);
        assert!(decode(&many).is_none());
        let mut remaining = 20;
        assert!(decode_msgpack_with_budget(&[0x91, 1], &mut remaining).is_none());
        assert_eq!(remaining, 0);
        assert!(decode_msgpack_with_budget(&[1], &mut remaining).is_none());
    }
}
