//! Data-only PHP serialization decoding; no PHP runtime or class hooks run.

use std::collections::BTreeMap;

use serde_json::{Map, Number, Value};

use crate::redis_codec_support::{DecodeBudget, MAX_INPUT_BYTES, MAX_NODES};

/// Decode only data-bearing PHP types. Unsafe JavaScript integers deliberately
/// become decimal strings instead of reproducing the desktop decoder's rounding.
/// References, custom serialization and non-finite doubles are not representable
/// as ordinary JSON data and return `None`.
pub fn decode_php_serialized_with_budget(bytes: &[u8], remaining: &mut usize) -> Option<Value> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return None;
    }
    let mut parser = Parser { bytes, pos: 0, budget: DecodeBudget::new(remaining) };
    let value = parser.value(0).ok()?;
    (parser.pos == bytes.len()).then_some(value)
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum Key {
    Integer(String),
    Text(String),
}

impl Key {
    fn text(&self) -> &str {
        match self {
            Self::Integer(text) | Self::Text(text) => text,
        }
    }

    fn into_text(self) -> String {
        match self {
            Self::Integer(text) | Self::Text(text) => text,
        }
    }
}

struct Parser<'input, 'budget> {
    bytes: &'input [u8],
    pos: usize,
    budget: DecodeBudget<'budget>,
}

impl<'input> Parser<'input, '_> {
    fn expect(&mut self, token: &[u8]) -> Result<(), ()> {
        self.budget.spend(token.len())?;
        let end = self.pos.checked_add(token.len()).ok_or(())?;
        if self.bytes.get(self.pos..end) != Some(token) {
            return Err(());
        }
        self.pos = end;
        Ok(())
    }

    fn token(&mut self, delimiter: u8) -> Result<&'input str, ()> {
        let start = self.pos;
        loop {
            self.budget.spend(1)?;
            let byte = *self.bytes.get(self.pos).ok_or(())?;
            self.pos += 1;
            if byte == delimiter {
                let token = &self.bytes[start..self.pos - 1];
                self.budget.spend(token.len())?;
                return std::str::from_utf8(token).map_err(|_| ());
            }
        }
    }

    fn length(&mut self) -> Result<usize, ()> {
        let text = self.token(b':')?;
        self.budget.spend(text.len())?;
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        let count = text.parse::<usize>().map_err(|_| ())?;
        if count > MAX_INPUT_BYTES {
            return Err(());
        }
        Ok(count)
    }

    fn quoted_text(&mut self, terminator: &[u8]) -> Result<String, ()> {
        let length = self.length()?;
        self.expect(b"\"")?;
        let end = self.pos.checked_add(length).ok_or(())?;
        let bytes = self.bytes.get(self.pos..end).ok_or(())?;
        // Charge reading, validating UTF-8 and copying before allocating.
        self.budget.spend(length.checked_mul(3).ok_or(())?)?;
        let text = std::str::from_utf8(bytes).map_err(|_| ())?;
        self.pos = end;
        self.expect(terminator)?;
        Ok(text.to_owned())
    }

    fn integer(&mut self) -> Result<String, ()> {
        self.expect(b"i:")?;
        let text = self.token(b';')?;
        self.budget.spend(text.len().checked_mul(2).ok_or(())?)?;
        let digits = text.strip_prefix('-').unwrap_or(text);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        let digits = digits.trim_start_matches('0');
        let digits = if digits.is_empty() { "0" } else { digits };
        let negative = text.starts_with('-') && digits != "0";
        let length = digits.len() + usize::from(negative);
        self.budget.spend(length)?;
        let mut normalized = String::with_capacity(length);
        if negative {
            normalized.push('-');
        }
        normalized.push_str(digits);
        Ok(normalized)
    }

    fn real(&mut self) -> Result<Value, ()> {
        self.expect(b"d:")?;
        let text = self.token(b';')?;
        self.budget.spend(text.len().checked_mul(2).ok_or(())?)?;
        let bytes = text.as_bytes();
        let mut pos = usize::from(bytes.first() == Some(&b'-'));
        let start = pos;
        while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if start == pos {
            return Err(());
        }
        if bytes.get(pos) == Some(&b'.') {
            pos += 1;
            let start = pos;
            while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
                pos += 1;
            }
            if start == pos {
                return Err(());
            }
        }
        if matches!(bytes.get(pos), Some(b'e' | b'E')) {
            pos += 1;
            if matches!(bytes.get(pos), Some(b'+' | b'-')) {
                pos += 1;
            }
            let start = pos;
            while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
                pos += 1;
            }
            if start == pos {
                return Err(());
            }
        }
        if pos != bytes.len() {
            return Err(());
        }
        let number = text.parse::<f64>().map_err(|_| ())?;
        Number::from_f64(number).map(Value::Number).ok_or(())
    }

    fn value(&mut self, depth: usize) -> Result<Value, ()> {
        self.budget.node(depth)?;
        match self.bytes.get(self.pos) {
            Some(b'N') => {
                self.expect(b"N;")?;
                Ok(Value::Null)
            }
            Some(b'b') => {
                self.expect(b"b:")?;
                let boolean = match self.token(b';')? {
                    "0" => false,
                    "1" => true,
                    _ => return Err(()),
                };
                Ok(Value::Bool(boolean))
            }
            Some(b'i') => {
                let text = self.integer()?;
                self.budget.spend(text.len())?;
                match text.parse::<i64>() {
                    Ok(number) if number.unsigned_abs() <= 9_007_199_254_740_991 => Ok(Value::Number(number.into())),
                    _ => Ok(Value::String(text)),
                }
            }
            Some(b'd') => self.real(),
            Some(b's') => {
                self.expect(b"s:")?;
                self.quoted_text(b"\";").map(Value::String)
            }
            Some(b'a') => self.array(depth),
            Some(b'O') => self.object(depth),
            _ => Err(()),
        }
    }

    fn key(&mut self, depth: usize) -> Result<Key, ()> {
        self.budget.node(depth)?;
        match self.bytes.get(self.pos) {
            Some(b'i') => self.integer().map(Key::Integer),
            Some(b's') => {
                self.expect(b"s:")?;
                self.quoted_text(b"\";").map(Key::Text)
            }
            _ => Err(()),
        }
    }

    fn map_work(&mut self, key_length: usize, count: usize) -> Result<(), ()> {
        // Bound tree comparisons even for keys with long common prefixes.
        let height = (usize::BITS - count.leading_zeros()) as usize + 1;
        self.budget.spend(
            key_length.checked_add(1).and_then(|n| n.checked_mul(height)).and_then(|n| n.checked_mul(16)).ok_or(())?,
        )
    }

    fn array(&mut self, depth: usize) -> Result<Value, ()> {
        self.expect(b"a:")?;
        let count = self.length()?;
        if count > MAX_NODES / 2 {
            return Err(());
        }
        self.expect(b"{")?;
        let mut indexes = BTreeMap::<Key, usize>::new();
        let mut values = Vec::new();
        let mut sequential = true;
        for _ in 0..count {
            let key = self.key(depth + 1)?;
            let value = self.value(depth + 1)?;
            self.map_work(key.text().len(), indexes.len())?;
            if let Some(index) = indexes.get(&key) {
                values[*index] = value;
            } else {
                self.budget.spend(128)?;
                sequential &= matches!(&key, Key::Integer(text) if text.parse::<usize>() == Ok(values.len()));
                indexes.insert(key, values.len());
                values.push(value);
            }
        }
        self.expect(b"}")?;
        if sequential {
            return Ok(Value::Array(values));
        }
        let mut object = Map::new();
        for (key, index) in indexes {
            self.map_work(key.text().len(), object.len())?;
            self.budget.spend(64)?;
            let key = key.into_text();
            if object.contains_key(&key) {
                // Integer 0 and string "0" are distinct desktop Map keys, but
                // cannot both survive JSON object conversion without data loss.
                return Err(());
            }
            object.insert(key, std::mem::take(&mut values[index]));
        }
        Ok(Value::Object(object))
    }

    fn object(&mut self, depth: usize) -> Result<Value, ()> {
        self.expect(b"O:")?;
        let class_name = self.quoted_text(b"\":")?;
        let count = self.length()?;
        if count > MAX_NODES / 2 {
            return Err(());
        }
        self.expect(b"{")?;
        self.budget.spend(70)?;
        let mut object = Map::new();
        object.insert("$class".to_owned(), Value::String(class_name));
        for _ in 0..count {
            let Key::Text(name) = self.key(depth + 1)? else {
                return Err(());
            };
            let value = self.value(depth + 1)?;
            self.map_work(name.len(), object.len())?;
            self.budget.spend(64)?;
            object.insert(name, value);
        }
        self.expect(b"}")?;
        Ok(Value::Object(object))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redis_codec_support::{MAX_DEPTH, MAX_INPUT_BYTES, MAX_NODES};
    use serde_json::json;

    fn decode(bytes: impl AsRef<[u8]>) -> Option<Value> {
        decode_php_serialized_with_budget(bytes.as_ref(), &mut (16 * 1024 * 1024))
    }

    #[test]
    fn desktop_scalar_and_container_fixtures() {
        for (input, expected) in [
            ("N;", json!(null)),
            ("b:0;", json!(false)),
            ("b:1;", json!(true)),
            ("i:-42;", json!(-42)),
            ("d:1.5;", json!(1.5)),
            ("d:-12.5e+2;", json!(-1250.0)),
            ("s:9:\"hello dbx\";", json!("hello dbx")),
            ("a:0:{}", json!([])),
            ("a:3:{i:0;s:9:\"hello dbx\";i:1;i:42;i:2;b:1;}", json!(["hello dbx", 42, true])),
            ("a:2:{s:3:\"msg\";s:9:\"hello dbx\";s:5:\"count\";d:1.5;}", json!({"msg": "hello dbx", "count": 1.5})),
            ("a:1:{s:5:\"outer\";a:2:{i:0;s:3:\"one\";i:1;a:1:{i:0;i:7;}}}", json!({"outer": ["one", [7]]})),
        ] {
            assert_eq!(decode(input), Some(expected), "{input}");
        }
    }

    #[test]
    fn byte_counted_utf8_strings_and_class_names() {
        assert_eq!(decode("s:6:\"你好\";"), Some(json!("你好")));
        assert_eq!(decode("a:1:{s:5:\"label\";s:6:\"你好\";}"), Some(json!({"label": "你好"})));
        assert_eq!(decode("O:6:\"你好\":0:{}"), Some(json!({"$class": "你好"})));
        assert_eq!(decode(b"s:3:\"a\0b\";"), Some(json!("a\0b")));
    }

    #[test]
    fn objects_remain_plain_data_including_protected_properties() {
        assert_eq!(
            decode("O:8:\"JobState\":2:{s:5:\"state\";s:4:\"done\";s:7:\"retries\";i:0;}"),
            Some(json!({"$class": "JobState", "state": "done", "retries": 0}))
        );
        assert_eq!(
            decode("O:7:\"Exploit\":2:{s:8:\"__wakeup\";s:5:\"never\";s:9:\"\0*\0secret\";i:7;}"),
            Some(json!({"$class": "Exploit", "__wakeup": "never", "\0*\0secret": 7}))
        );
    }

    #[test]
    fn integers_preserve_precision_beyond_javascript_safe_range() {
        assert_eq!(decode("i:9007199254740991;"), Some(json!(9007199254740991_i64)));
        assert_eq!(decode("i:9007199254740992;"), Some(json!("9007199254740992")));
        assert_eq!(decode("i:-9223372036854775808;"), Some(json!("-9223372036854775808")));
        assert_eq!(decode("i:18446744073709551616;"), Some(json!("18446744073709551616")));
        assert_eq!(decode("i:-000000000000000000009007199254740992;"), Some(json!("-9007199254740992")));
    }

    #[test]
    fn array_key_order_duplicates_and_sparse_maps_match_desktop() {
        assert_eq!(decode("a:3:{i:0;s:1:\"a\";i:0;s:1:\"b\";i:1;s:1:\"c\";}"), Some(json!(["b", "c"])));
        assert_eq!(decode("a:2:{i:1;i:1;i:0;i:2;}"), Some(json!({"1": 1, "0": 2})));
        assert_eq!(decode("a:1:{i:8;i:7;}"), Some(json!({"8": 7})));
        assert_eq!(decode("a:1:{s:1:\"0\";i:7;}"), Some(json!({"0": 7})));
    }

    #[test]
    fn rejects_malformed_unsupported_and_unrepresentable_inputs() {
        for input in [
            "",
            "hello dbx",
            "N;?",
            "N",
            "b:2;",
            "b:-1;",
            "b:00;",
            "i:;",
            "i:+1;",
            "i:1.5;",
            "d:INF;",
            "d:-INF;",
            "d:NAN;",
            "d:1e999;",
            "d:;",
            "d:.5;",
            "d:1.;",
            "d:+1;",
            "d:1e;",
            "s:-1:\"\";",
            "s:999999999999999999999999999999999:\"\";",
            "s:99:\"short\";",
            "s:2:\"你好\";",
            "a:-1:{}",
            "a:999999999999999999999999999999:{}",
            "a:2:{i:0;N;}",
            "a:1:{b:1;N;}",
            "a:1:{a:0:{};N;}",
            "a:2:{i:0;i:1;s:1:\"0\";i:2;}",
            "O:1:\"X\":-1:{}",
            "O:1:\"X\":1:{i:0;N;}",
            "C:1:\"X\":0:{}",
            "R:1;",
            "r:1;",
            "E:3:\"X:Y\";",
        ] {
            assert_eq!(decode(input), None, "accepted {input:?}");
        }
        assert_eq!(decode(b"s:1:\"\xff\";"), None);
        assert_eq!(decode(b"O:1:\"\xff\":0:{}"), None);
    }

    #[test]
    fn rejects_every_truncation_of_nested_fixture() {
        let input = b"a:1:{s:5:\"outer\";a:2:{i:0;s:3:\"one\";i:1;a:1:{i:0;i:7;}}}";
        assert!(decode(input).is_some());
        for end in 0..input.len() {
            assert_eq!(decode(&input[..end]), None, "accepted prefix {end}");
        }
    }

    #[test]
    fn shared_budget_input_depth_and_node_limits_apply() {
        let mut remaining = 4096;
        assert_eq!(decode_php_serialized_with_budget(b"i:42;", &mut remaining), Some(json!(42)));
        assert!(remaining < 4096);
        let mut exhausted = 40;
        assert_eq!(decode_php_serialized_with_budget(b"s:6:\"abcdef\";", &mut exhausted), None);
        assert_eq!(exhausted, 0);
        assert_eq!(decode_php_serialized_with_budget(b"N;", &mut exhausted), None);
        assert_eq!(decode(vec![b'N'; MAX_INPUT_BYTES + 1]), None);
        let nested = format!("{}N;{}", "a:1:{i:0;".repeat(MAX_DEPTH - 1), "}".repeat(MAX_DEPTH - 1));
        assert!(decode(nested).is_some());
        let nested = format!("{}N;{}", "a:1:{i:0;".repeat(MAX_DEPTH), "}".repeat(MAX_DEPTH));
        assert_eq!(decode(nested), None);
        let wide = format!("a:{}:{{{}}}", MAX_NODES / 2, "i:0;N;".repeat(MAX_NODES / 2));
        assert_eq!(decode(wide), None);
        assert_eq!(decode("a:1048576:{}"), None);
    }
}
