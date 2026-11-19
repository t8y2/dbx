use base64::Engine;
use dbx_driver_redis::{
    connect, get_raw_value, get_value, get_value_scoped_with_preview_limit, RedisOperationScope, RedisValueData,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[tokio::test]
#[ignore = "requires a disposable server via DBX_TEST_REDIS_URL"]
async fn configured_preview_limit_reads_full_large_values_and_preserves_binary_downloads() {
    let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
    let mut con = connect(&url, Duration::from_secs(5)).await.unwrap();
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let prefix = format!("dbx11326-{}-{nonce}", std::process::id());
    let key = prefix.as_bytes();
    let scope = RedisOperationScope::default();
    for (name, bytes) in [
        ("text", vec![b'x'; 96 * 1024]),
        ("utf8", "中文🙂".repeat(10_000).into_bytes()),
        ("binary", (0..128 * 1024).map(|i| (i % 256) as u8).collect()),
    ] {
        redis::cmd("SET").arg(key).arg(&bytes).arg("EX").arg(300).query_async::<()>(&mut con).await.unwrap();
        let default_value = get_value(&mut con, key).await.unwrap();
        let RedisValueData::String { content, truncated, total_bytes } = default_value.data else {
            panic!("expected string")
        };
        assert!(truncated);
        assert_eq!(total_bytes, Some(bytes.len() as u64));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(content.raw_base64).unwrap(), bytes[..65536]);
        for limit in [256 * 1024, bytes.len()] {
            let value = get_value_scoped_with_preview_limit(&mut con, key, &scope, limit).await.unwrap();
            let RedisValueData::String { content, truncated, total_bytes } = value.data else {
                panic!("expected string")
            };
            assert!(!truncated);
            assert_eq!(total_bytes, Some(bytes.len() as u64));
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(content.raw_base64).unwrap(), bytes);
        }
        let small = get_value_scoped_with_preview_limit(&mut con, key, &scope, 1024).await.unwrap();
        let RedisValueData::String { truncated, .. } = small.data else { panic!("expected string") };
        assert!(truncated);
        let raw = get_raw_value(&mut con, key).await.unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(raw.raw_base64).unwrap(), bytes);
        println!(
            "PASS {name}: 64 KiB truncates, 256 KiB and exact boundary complete, full download preserves {} bytes",
            bytes.len()
        );
    }
    redis::cmd("DEL").arg(key).query_async::<()>(&mut con).await.unwrap();
}
