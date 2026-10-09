use base64::Engine;
use dbx_driver_redis::{connect, get_value, load_more_collection, RedisCollectionPage, RedisValueData};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[tokio::test]
#[ignore = "requires a disposable server via DBX_TEST_REDIS_URL"]
async fn binary_hash_listing_preserves_bytes_and_connection() {
    let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
    let mut con = connect(&url, Duration::from_secs(5)).await.unwrap();
    let info: Vec<redis::Value> = redis::cmd("COMMAND").arg("INFO").arg("HTTL").query_async(&mut con).await.unwrap();
    let supports_ttl = !matches!(info.first(), None | Some(redis::Value::Nil));
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let prefix = format!("dbx-8585-{}-{nonce}", std::process::id());
    let keys = [prefix.as_bytes().to_vec(), [prefix.as_bytes(), b"\xff\r\n"].concat()];
    let expected: HashMap<Vec<u8>, Vec<u8>> = (0..2563_u32)
        .map(|index| {
            let suffix: &[u8] = if index % 2 == 0 { b"\xf3" } else { b"\r\n" };
            let field = [format!("\x03accu_test{index}.IoStatu").as_bytes(), suffix].concat();
            let value = [b"\x01\x00com.accu.MeasureValueEx\xf4\x01".as_slice(), &index.to_le_bytes()].concat();
            (field, value)
        })
        .collect();
    for key in &keys {
        let mut seed = redis::cmd("HSET");
        seed.arg(key);
        for (field, value) in &expected {
            seed.arg(field).arg(value);
        }
        seed.query_async::<()>(&mut con).await.unwrap();
        redis::cmd("EXPIRE").arg(key).arg(300).query_async::<()>(&mut con).await.unwrap();
        let value = get_value(&mut con, key).await.unwrap();
        let RedisValueData::Hash { items, total, mut scan_cursor } = value.data else { panic!("expected hash") };
        assert_eq!(total, 2563);
        assert!(!items.is_empty() && items.len() <= 200);
        let mut actual = HashMap::new();
        let mut page = items;
        let mut pages = 0;
        loop {
            for item in page {
                assert_eq!(item.field_ttl, supports_ttl.then_some(-1));
                let decode = |blob: &str| base64::engine::general_purpose::STANDARD.decode(blob).unwrap();
                actual.insert(decode(&item.field.raw_base64), decode(&item.value.raw_base64));
            }
            let Some(cursor) = scan_cursor else { break };
            pages += 1;
            assert!(pages < 100);
            let RedisCollectionPage::Hash { items, scan_cursor: next } =
                load_more_collection(&mut con, key, "hash", cursor, 200, None, None).await.unwrap()
            else {
                panic!("expected hash page")
            };
            assert!(items.len() <= 200);
            page = items;
            scan_cursor = next;
        }
        assert!(pages > 0);
        assert_eq!(actual, expected);
        let pong: String = redis::cmd("PING").query_async(&mut con).await.unwrap();
        assert_eq!(pong, "PONG");
        println!("PASS: 2563 binary fields/values, all pages, binary key={}, TTL supported={supports_ttl}, same connection PING", key != &keys[0]);
    }
    redis::cmd("DEL").arg(&keys).query_async::<()>(&mut con).await.unwrap();
}
