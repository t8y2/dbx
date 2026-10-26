use dbx_formats::redis_java::decode_java_serialized;
use serde_json::{json, Value};

fn hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn decodes_java_strings_and_rejects_truncated_streams() {
    let bytes = hex("aced0005740008736f6d6574657874");
    assert_eq!(decode_java_serialized(&bytes), Some(json!("sometext")));
    for end in 0..bytes.len() {
        assert_eq!(decode_java_serialized(&bytes[..end]), None, "prefix {end}");
    }
    assert_eq!(decode_java_serialized(b"plain text"), None);
}

#[test]
fn matches_desktop_normalization_for_real_object_output_streams() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("fixtures/redis_java.json")).unwrap();
    for fixture in fixtures {
        let bytes = hex(fixture["hex"].as_str().unwrap());
        assert_eq!(decode_java_serialized(&bytes), Some(fixture["expected"].clone()), "{}", fixture["name"]);
    }
}

#[test]
fn rejects_invalid_references_tags_and_unbounded_lengths() {
    for input in [
        "aced0005757200025b494dba602676eab2a50200007870ffffffff", // negative array length
        "aced0005757200025b494dba602676eab2a502000078707fffffff", // oversized array length
        "aced000571007e0000",                                     // unknown reference
        "aced000574ffff",                                         // string length exceeds input
        "aced00057c0000000100000000",                             // long-string length exceeds input
        "aced000577ff",                                           // block length exceeds input
        "aced00057affffffff",                                     // long-block length exceeds input
        "aced000578",                                             // end-block outside annotations
        "aced000579",                                             // unsupported reset
        "aced00057370",                                           // object without a descriptor
        "aced0005740003eda080", // lone UTF-16 surrogate must not become replacement text
        "aced00057200015800000000000000000200007871007e0000", // cyclic superclass
        "aced000576720001580000000000000001020001490001667671007e00007870", // unfinished descriptor
    ] {
        assert_eq!(decode_java_serialized(&hex(input)), None, "{input}");
    }
}

#[test]
fn decodes_long_strings_and_multiple_stream_roots() {
    let text = "a".repeat(70_000);
    let mut bytes = hex("aced00057c");
    bytes.extend((text.len() as u64).to_be_bytes());
    bytes.extend(text.as_bytes());
    assert_eq!(decode_java_serialized(&bytes), Some(json!(text)));
    assert_eq!(
        decode_java_serialized(&hex("aced00057400016171007e0000")),
        Some(json!({"$id":"#1","$values":["a","a"]}))
    );
}

#[test]
fn bounds_repeated_field_type_references_before_copying_them() {
    // One 60 KiB type name referenced by 60,000 fields would amplify to several
    // GiB if the allocation budget were checked only after cloning the strings.
    let mut bytes = hex("aced000572000158000000000000000002ea60");
    for index in 0..60_000 {
        bytes.extend(b"L\x00\x01f");
        if index == 0 {
            bytes.push(0x74);
            bytes.extend(60_000_u16.to_be_bytes());
            bytes.extend(vec![b'A'; 60_000]);
        } else {
            bytes.extend(hex("71007e0001"));
        }
    }
    bytes.extend(hex("7870"));
    assert!(bytes.len() < 1024 * 1024);
    assert!(decode_java_serialized(&bytes).is_none());
}

#[test]
fn rejects_every_truncated_fixture_and_survives_corrupted_bytes() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("fixtures/redis_java.json")).unwrap();
    for fixture in fixtures {
        let bytes = hex(fixture["hex"].as_str().unwrap());
        for end in 0..bytes.len() {
            assert!(decode_java_serialized(&bytes[..end]).is_none(), "{} prefix {end}", fixture["name"]);
        }
        for index in 0..bytes.len() {
            for replacement in [0, 0xff] {
                let mut corrupted = bytes.clone();
                corrupted[index] = replacement;
                let _ = decode_java_serialized(&corrupted);
            }
        }
    }
}

#[test]
fn bounds_input_nodes_depth_and_output_amplification() {
    let mut oversized = vec![0x70; 1024 * 1024 + 1];
    oversized[..4].copy_from_slice(&[0xac, 0xed, 0, 5]);
    assert!(decode_java_serialized(&oversized).is_none());

    let mut repeated = hex("aced00057c0000000000010000");
    repeated.extend(vec![b'a'; 65536]);
    for _ in 0..1000 {
        repeated.extend(hex("71007e0000"));
    }
    assert!(decode_java_serialized(&repeated).is_none());

    let mut nodes = hex("aced0005");
    nodes.extend(vec![0x70; 40000]);
    assert!(decode_java_serialized(&nodes).is_none());

    // First array declares Object[], later arrays reuse that class descriptor.
    let mut nested = hex("aced0005757200135b4c6a6176612e6c616e672e4f626a6563743b90ce589f1073296c020000787000000001");
    for _ in 0..100 {
        nested.extend(hex("7571007e000000000001"));
    }
    nested.push(0x70);
    assert!(decode_java_serialized(&nested).is_none());
}
