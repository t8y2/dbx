use base64::{engine::general_purpose::STANDARD, Engine};
use dbx_formats::{
    redis_compression::{decompress_redis_value_with_budget, detect_redis_compression, RedisCompression},
    redis_java::decode_java_serialized_with_budget,
    redis_msgpack::decode_msgpack_with_budget,
    redis_php::decode_php_serialized_with_budget,
    redis_pickle::decode_pickle_with_budget,
    redis_protobuf::decode_protobuf_with_budget,
};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RedisDecode {
    Auto,
    JavaSerialized,
    Msgpack,
    Pickle,
    PhpSerialize,
    Protobuf,
}

#[derive(Debug, Clone, Copy, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RedisDecompress {
    Auto,
    Gzip,
    Zlib,
    Deflate,
}

fn detected_codec(bytes: &[u8]) -> Option<RedisDecode> {
    if bytes.starts_with(&[0xac, 0xed, 0, 5]) {
        return Some(RedisDecode::JavaSerialized);
    }
    if bytes.len() >= 3 && bytes[0] == 0x80 && (2..=5).contains(&bytes[1]) && bytes.last() == Some(&b'.') {
        return Some(RedisDecode::Pickle);
    }
    if bytes.starts_with(b"N;") || matches!(bytes, [b'a' | b'O' | b'b' | b'i' | b'd' | b's', b':', ..]) {
        return Some(RedisDecode::PhpSerialize);
    }
    if matches!(bytes.first(), Some(0x80..=0x9f | 0xdc..=0xdf)) {
        return Some(RedisDecode::Msgpack);
    }
    None
}

fn decoded(bytes: &[u8], codec: RedisDecode, remaining: &mut usize) -> Option<(&'static str, Value)> {
    let (name, value) = match codec {
        RedisDecode::JavaSerialized => ("java-serialized", decode_java_serialized_with_budget(bytes, remaining)?),
        RedisDecode::Msgpack => ("msgpack", decode_msgpack_with_budget(bytes, remaining)?),
        RedisDecode::Pickle => ("pickle", decode_pickle_with_budget(bytes, remaining)?),
        RedisDecode::PhpSerialize => ("php-serialize", decode_php_serialized_with_budget(bytes, remaining)?),
        RedisDecode::Protobuf => ("protobuf", decode_protobuf_with_budget(bytes, remaining)?),
        RedisDecode::Auto => return None,
    };
    Some((name, value))
}

fn decode_display(
    display: &str,
    codec: Option<RedisDecode>,
    decompress: Option<RedisDecompress>,
    remaining: &mut usize,
) -> Option<Value> {
    // Bound the whole pipeline as well as each parser; failed attempts debit both.
    let allowance = (*remaining).min(4 * 1024 * 1024);
    let mut local = allowance;
    let result = decode_display_inner(display, codec, decompress, &mut local);
    *remaining -= allowance - local;
    result
}

fn decode_display_inner(
    display: &str,
    codec: Option<RedisDecode>,
    decompress: Option<RedisDecompress>,
    remaining: &mut usize,
) -> Option<Value> {
    if display.len() > 4 * 1024 * 1024 {
        return None;
    }
    *remaining = remaining.checked_sub(display.len())?;
    let mut bytes = Vec::new();
    let mut input = display.bytes();
    while let Some(byte) = input.next() {
        if bytes.len() >= 1024 * 1024 {
            return None;
        }
        bytes.push(if byte != b'\\' {
            byte
        } else {
            match input.next()? {
                b'\\' => b'\\',
                b'x' => {
                    let high = (input.next()? as char).to_digit(16)?;
                    let low = (input.next()? as char).to_digit(16)?;
                    (high * 16 + low) as u8
                }
                _ => return None,
            }
        });
    }
    let algorithm = match decompress {
        Some(RedisDecompress::Gzip) => Some(RedisCompression::Gzip),
        Some(RedisDecompress::Zlib) => Some(RedisCompression::Zlib),
        Some(RedisDecompress::Deflate) => Some(RedisCompression::Deflate),
        Some(RedisDecompress::Auto) | None => detect_redis_compression(&bytes),
    };
    let (bytes, compression) = if let Some(algorithm) = algorithm {
        let (algorithm, output) = decompress_redis_value_with_budget(&bytes, Some(algorithm), remaining)?;
        (output, Some(algorithm.as_str()))
    } else {
        (bytes, None)
    };
    let selected = match codec {
        Some(RedisDecode::Auto) => detected_codec(&bytes),
        other => other,
    };
    let mut envelope = if let Some(selected) = selected {
        let (name, value) = decoded(&bytes, selected, remaining)?;
        json!({"codec":name,"value":value})
    } else if compression.is_some() {
        *remaining = remaining.checked_sub(bytes.len())?;
        let value = match String::from_utf8(bytes) {
            Ok(mut text) => {
                if text.starts_with('\u{feff}') {
                    text.drain(..3);
                }
                Value::String(text)
            }
            Err(error) => {
                let length = error.as_bytes().len().div_ceil(3).checked_mul(4)?;
                *remaining = remaining.checked_sub(length)?;
                json!({"$bytes":STANDARD.encode(error.as_bytes())})
            }
        };
        json!({"value":value})
    } else {
        return None;
    };
    *remaining = remaining.checked_sub(64)?;
    if let Some(compression) = compression {
        envelope["compression"] = json!(compression);
    }
    Some(envelope)
}

pub(crate) fn decode_redis_result(
    value: &Value,
    codec: Option<RedisDecode>,
    decompress: Option<RedisDecompress>,
) -> Value {
    if codec.is_none() && decompress.is_none() {
        return value.clone();
    }
    decode_value(value, codec, decompress, &mut (16 * 1024 * 1024))
}

fn decode_value(
    value: &Value,
    codec: Option<RedisDecode>,
    decompress: Option<RedisDecompress>,
    remaining: &mut usize,
) -> Value {
    match value {
        Value::String(display) => {
            decode_display(display, codec, decompress, remaining).unwrap_or_else(|| value.clone())
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|value| decode_value(value, codec, decompress, remaining)).collect())
        }
        Value::Object(values) => {
            values.iter().map(|(key, value)| (key.clone(), decode_value(value, codec, decompress, remaining))).collect()
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
fn auto_decode(value: &Value) -> Value {
    decode_redis_result(value, Some(RedisDecode::Auto), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_binary_strings_and_preserves_unrecognized_values() {
        let java = r"\xac\xed\x00\x05t\x00\x03a\\b";
        let input = json!([java, "plain text", null, 42, {"field": java}]);
        let decoded = json!({"codec":"java-serialized","value":"a\\b"});
        assert_eq!(auto_decode(&input), json!([decoded, "plain text", null, 42, {"field":decoded}]));
    }

    #[test]
    fn malformed_streams_and_literal_escape_text_remain_unchanged() {
        for value in
            [r"\xac\xed\x00\x05", r"\xac\xed\x00\x05t\x00\x05abc", r"\\xac\\xed\\x00\\x05", r"\xac\xed\x00\x05\q"]
        {
            assert_eq!(auto_decode(&json!(value)), json!(value));
        }
    }

    #[test]
    fn does_not_decode_a_successful_java_string_twice() {
        let display = r"\xac\xed\x00\x05t\x00\x10\\xac\\xed\\x00\\x05";
        assert_eq!(auto_decode(&json!(display)), json!({"codec":"java-serialized","value":r"\xac\xed\x00\x05"}));
    }

    #[test]
    fn matches_the_actual_driver_display_for_shared_java_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_java.json")).unwrap();
        for fixture in fixtures {
            let bytes = fixture["hex"]
                .as_str()
                .unwrap()
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect::<Vec<_>>();
            let display = dbx_core::db::redis_driver::redis_key_bytes_to_display(&bytes);
            assert_eq!(
                auto_decode(&json!(display)),
                json!({"codec":"java-serialized","value":fixture["expected"]}),
                "{}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn shares_expansion_budget_across_a_large_mget_reply() {
        // Every reference repeats the same string in normalized JSON, just as
        // the desktop codec does. Small binary input can therefore expand.
        let mut bytes = vec![0xac, 0xed, 0, 5, 0x74];
        bytes.extend(30_000_u16.to_be_bytes());
        bytes.extend(vec![b'a'; 30_000]);
        for _ in 0..100 {
            bytes.extend([0x71, 0, 0x7e, 0, 0]);
        }
        let display = dbx_core::db::redis_driver::redis_key_bytes_to_display(&bytes);
        let input = json!(vec![display.clone(); 20]);
        let output = auto_decode(&input);
        let values = output.as_array().unwrap();
        assert!(values[0].is_object());
        assert_eq!(values.last().unwrap(), &json!(display));
        let expanded_bytes = serde_json::to_vec(&output).unwrap().len();
        assert!(expanded_bytes < 20 * 1024 * 1024, "{expanded_bytes}");
    }
}

#[cfg(test)]
mod extended_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn auto_decodes_msgpack_containers() {
        assert_eq!(auto_decode(&json!(r"\x81\xa1x\x01")), json!({"codec":"msgpack","value":{"x":1}}));
    }
}

#[cfg(test)]
mod full_codec_tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
    fn display(bytes: &[u8]) -> Value {
        json!(dbx_core::db::redis_driver::redis_key_bytes_to_display(bytes))
    }
    fn mode(name: &str) -> RedisDecode {
        serde_json::from_value(json!(name)).unwrap()
    }

    #[test]
    fn explicit_codecs_match_all_desktop_fixtures_and_auto_remains_conservative() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_codecs.json")).unwrap();
        for fixture in fixtures {
            let codec = fixture["codec"].as_str().unwrap();
            let input = display(&bytes(fixture["hex"].as_str().unwrap()));
            assert_eq!(
                decode_redis_result(&input, Some(mode(codec)), None),
                json!({"codec":codec,"value":fixture["expected"]}),
                "{}",
                fixture["name"]
            );
        }
        for bytes in [b"hello".as_slice(), &[0x08, 7], &[0xa1, b'x'], &[42]] {
            let input = display(bytes);
            assert_eq!(auto_decode(&input), input);
        }
        let legacy_header = display(&[0x80, 1, b'N', b'.']);
        assert_eq!(auto_decode(&legacy_header), legacy_header);
        assert_eq!(
            decode_redis_result(&legacy_header, Some(RedisDecode::Pickle), None),
            json!({"codec":"pickle","value":null})
        );
        let input = display(&[42]);
        assert_eq!(
            decode_redis_result(&input, Some(RedisDecode::Msgpack), None),
            json!({"codec":"msgpack","value":42})
        );
    }

    #[test]
    fn decompresses_alone_or_before_each_codec() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_compression.json")).unwrap();
        for fixture in fixtures {
            let input = display(&bytes(fixture["hex"].as_str().unwrap()));
            let algorithm = fixture["compression"].as_str().unwrap();
            let decompress: RedisDecompress = serde_json::from_value(json!(algorithm)).unwrap();
            let codec = fixture["codec"].as_str().map(mode);
            let mut expected = json!({"compression":algorithm,"value":fixture["expected"]});
            if let Some(codec) = fixture["codec"].as_str() {
                expected["codec"] = json!(codec);
            }
            assert_eq!(decode_redis_result(&input, codec, Some(decompress)), expected, "{}", fixture["name"]);
            if algorithm != "deflate" {
                assert_eq!(decode_redis_result(&input, codec, Some(RedisDecompress::Auto)), expected);
                if codec.is_some() {
                    assert_eq!(decode_redis_result(&input, codec, None), expected);
                }
            }
        }
    }

    #[test]
    fn preserves_default_corrupt_compression_and_shared_pipeline_budget() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_compression.json")).unwrap();
        for fixture in fixtures {
            let bytes = bytes(fixture["hex"].as_str().unwrap());
            let input = display(&bytes);
            assert_eq!(decode_redis_result(&input, None, None), input);
            let algorithm: RedisDecompress = serde_json::from_value(fixture["compression"].clone()).unwrap();
            let corrupt = display(&bytes[..bytes.len() - 1]);
            assert_eq!(decode_redis_result(&corrupt, Some(RedisDecode::Auto), Some(algorithm)), corrupt);
            let mut budget = 0;
            assert_eq!(decode_value(&input, Some(RedisDecode::Auto), Some(algorithm), &mut budget), input);
        }
    }
}

#[cfg(test)]
mod compressed_budget_tests {
    use super::*;
    fn display(hex: &str) -> Value {
        let bytes = hex
            .as_bytes()
            .chunks_exact(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        json!(dbx_core::db::redis_driver::redis_key_bytes_to_display(&bytes))
    }
    #[test]
    fn compressed_mget_expansion_shares_the_command_budget() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_compression_limits.json"))
                .unwrap();
        let input = display(fixtures["amplifying_java_gzip"].as_str().unwrap());
        let output = auto_decode(&json!(vec![input.clone(); 20]));
        let values = output.as_array().unwrap();
        assert!(values[0].is_object());
        assert_eq!(values.last(), Some(&input));
        assert!(serde_json::to_vec(&output).unwrap().len() < 20 * 1024 * 1024);
    }
    #[test]
    fn compressed_bomb_retains_original_display() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_compression_limits.json"))
                .unwrap();
        let input = display(fixtures["bomb_gzip"].as_str().unwrap());
        assert_eq!(auto_decode(&input), input);
    }
}
