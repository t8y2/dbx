use dbx_formats::{
    redis_msgpack::decode_msgpack_with_budget, redis_php::decode_php_serialized_with_budget,
    redis_pickle::decode_pickle_with_budget, redis_protobuf::decode_protobuf_with_budget,
};
use serde_json::Value;

#[test]
fn matches_shared_desktop_codec_fixtures() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("fixtures/redis_codecs.json")).unwrap();
    for fixture in fixtures {
        let bytes = fixture["hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        let mut remaining = 16 * 1024 * 1024;
        let result = match fixture["codec"].as_str().unwrap() {
            "msgpack" => decode_msgpack_with_budget(&bytes, &mut remaining),
            "pickle" => decode_pickle_with_budget(&bytes, &mut remaining),
            "php-serialize" => decode_php_serialized_with_budget(&bytes, &mut remaining),
            "protobuf" => decode_protobuf_with_budget(&bytes, &mut remaining),
            _ => unreachable!(),
        };
        assert_eq!(result, Some(fixture["expected"].clone()), "{}", fixture["name"]);
    }
}
