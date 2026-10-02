use base64::Engine;
use dbx_driver_redis::{
    connect, get_value, hash_field_update, hash_set, load_more_collection, set_hash_field_expire_at,
    set_hash_field_ttl, RedisCollectionPage, RedisHashItem, RedisValueData,
};
use redis::aio::MultiplexedConnection;
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn fields(items: Vec<RedisHashItem>, expected_ttl: Option<i64>) -> HashMap<String, String> {
    items
        .into_iter()
        .map(|item| {
            assert_eq!(item.field_ttl, expected_ttl);
            let decode = |value: &str| {
                String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value).unwrap()).unwrap()
            };
            (decode(&item.field.raw_base64), decode(&item.value.raw_base64))
        })
        .collect()
}

async fn snapshot(con: &mut MultiplexedConnection, key: &str) -> HashMap<String, String> {
    redis::cmd("HGETALL").arg(key).query_async(con).await.unwrap()
}

async fn field_ttl(con: &mut MultiplexedConnection, key: &str, field: &str) -> i64 {
    let ttls: Vec<i64> = redis::cmd("HTTL").arg(key).arg("FIELDS").arg(1).arg(field).query_async(con).await.unwrap();
    ttls[0]
}

async fn seed(con: &mut MultiplexedConnection, keys: &[String], kvrocks: bool) -> redis::RedisResult<()> {
    if kvrocks {
        redis::cmd("CONFIG").arg("SET").arg("hash-encoding-mode").arg("legacy").query_async::<()>(con).await?;
    }
    let mut command = redis::cmd("HSET");
    command.arg(&keys[0]);
    for index in 0..401 {
        command.arg(format!("f{index}")).arg(format!("v{index}"));
    }
    command.query_async::<()>(con).await?;
    if kvrocks {
        redis::cmd("CONFIG")
            .arg("SET")
            .arg("hash-encoding-mode")
            .arg("field-expiration")
            .query_async::<()>(con)
            .await?;
    }
    redis::cmd("HSET").arg(&keys[1]).arg("expiring").arg("before").query_async::<()>(con).await?;
    Ok(())
}

async fn exercise(mut con: MultiplexedConnection, keys: Vec<String>, flavor: String) {
    let key = &keys[0];
    let modern = &keys[1];
    let missing = &keys[2];
    let wrong_type = &keys[3];
    let expected_ttl = (flavor == "redis74").then_some(-1);
    redis::cmd("EXPIRE").arg(key).arg(300).query_async::<()>(&mut con).await.unwrap();
    let value = get_value(&mut con, key.as_bytes()).await.unwrap();
    assert!((1..=300).contains(&value.ttl));
    let RedisValueData::Hash { items, total, mut scan_cursor } = value.data else {
        panic!("expected hash");
    };
    assert_eq!(total, 401);
    assert!(!items.is_empty() && items.len() <= 200);
    let mut actual = fields(items, expected_ttl);
    let mut pages = 0;
    while let Some(cursor) = scan_cursor {
        pages += 1;
        assert!(pages < 100, "pagination failed to finish");
        let page = load_more_collection(&mut con, key.as_bytes(), "hash", cursor, 200, None, None).await.unwrap();
        let RedisCollectionPage::Hash { items, scan_cursor: next } = page else {
            panic!("expected hash page");
        };
        assert!(items.len() <= 200);
        actual.extend(fields(items, expected_ttl));
        scan_cursor = next;
    }
    assert!(pages > 0);
    assert_eq!(actual, (0..401).map(|index| (format!("f{index}"), format!("v{index}"))).collect());
    println!("PASS production listing/load-more: 401 fields, bounded pages, key TTL");

    hash_set(&mut con, key.as_bytes(), "added", "value", None).await.unwrap();
    hash_field_update(&mut con, key.as_bytes(), "f0", "f0", "edited").await.unwrap();
    assert_eq!(snapshot(&mut con, key).await["f0"], "edited");
    hash_field_update(&mut con, key.as_bytes(), "f0", "renamed", "moved").await.unwrap();
    let after = snapshot(&mut con, key).await;
    assert_eq!(after["added"], "value");
    assert_eq!(after["renamed"], "moved");
    assert!(!after.contains_key("f0"));
    assert!(hash_field_update(&mut con, key.as_bytes(), "f1", "f2", "collision").await.is_err());
    assert!(hash_field_update(&mut con, key.as_bytes(), "absent", "new", "missing").await.is_err());
    assert_eq!(snapshot(&mut con, key).await, after);
    let ttl: i64 = redis::cmd("TTL").arg(key).query_async(&mut con).await.unwrap();
    assert!((1..=300).contains(&ttl));
    println!("PASS production add/edit/rename/source deletion/collision/missing field/key TTL");

    if flavor != "redis74" {
        for result in [
            set_hash_field_ttl(&mut con, key.as_bytes(), "added", 120).await,
            set_hash_field_ttl(&mut con, key.as_bytes(), "added", -1).await,
            set_hash_field_expire_at(&mut con, key.as_bytes(), "added", 4_000_000_000).await,
        ] {
            let error = result.unwrap_err();
            if flavor == "kvrocks" {
                assert!(error.contains("hash field expiration is not supported by legacy hash encoding"), "{error}");
            } else {
                assert!(error.to_ascii_lowercase().contains("unknown command"), "{error}");
            }
        }
        assert_eq!(snapshot(&mut con, key).await, after);
        println!("PASS production explicit HEXPIRE/HPERSIST/HEXPIREAT errors remain visible");
    }

    if flavor != "redis72" {
        set_hash_field_ttl(&mut con, modern.as_bytes(), "expiring", 180).await.unwrap();
        for (old, new, value) in [("expiring", "expiring", "edited"), ("expiring", "renamed", "moved")] {
            let before = field_ttl(&mut con, modern, old).await;
            hash_set(&mut con, key.as_bytes(), "added", "legacy still works", None).await.unwrap();
            hash_set(&mut con, modern.as_bytes(), old, "overwrite", None).await.unwrap();
            let overwritten = field_ttl(&mut con, modern, old).await;
            assert!((1..=before).contains(&overwritten));
            hash_field_update(&mut con, modern.as_bytes(), old, new, value).await.unwrap();
            let remaining = field_ttl(&mut con, modern, new).await;
            assert!((1..=overwritten).contains(&remaining));
            assert_eq!(snapshot(&mut con, modern).await, HashMap::from([(new.to_string(), value.to_string())]));
            let RedisValueData::Hash { items, .. } = get_value(&mut con, modern.as_bytes()).await.unwrap().data else {
                panic!("expected hash");
            };
            assert_eq!(items.len(), 1);
            assert!(items[0].field_ttl.is_some_and(|ttl| (1..=remaining).contains(&ttl)));
            let RedisCollectionPage::Hash { items, .. } =
                load_more_collection(&mut con, modern.as_bytes(), "hash", 0, 200, None, None).await.unwrap()
            else {
                panic!("expected hash page");
            };
            assert_eq!(items.len(), 1);
            assert!(items[0].field_ttl.is_some_and(|ttl| (1..=remaining).contains(&ttl)));
            let RedisCollectionPage::Hash { items, .. } =
                load_more_collection(&mut con, key.as_bytes(), "hash", 0, 1, None, None).await.unwrap()
            else {
                panic!("expected hash page");
            };
            assert_eq!(items[0].field_ttl, expected_ttl);
        }
        set_hash_field_ttl(&mut con, modern.as_bytes(), "renamed", -1).await.unwrap();
        assert_eq!(field_ttl(&mut con, modern, "renamed").await, -1);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        set_hash_field_expire_at(&mut con, modern.as_bytes(), "renamed", now + 180).await.unwrap();
        assert!((1..=180).contains(&field_ttl(&mut con, modern, "renamed").await));
        println!("PASS production per-key TTL capability coexistence, remaining TTL on overwrite/edit/rename, explicit expiry");
    }

    assert!(hash_field_update(&mut con, missing.as_bytes(), "absent", "new", "value").await.is_err());
    let exists: bool = redis::cmd("EXISTS").arg(missing).query_async(&mut con).await.unwrap();
    assert!(!exists);
    let page = load_more_collection(&mut con, missing.as_bytes(), "hash", 0, 200, None, None).await.unwrap();
    assert!(matches!(page, RedisCollectionPage::Hash { items, scan_cursor: None } if items.is_empty()));
    hash_set(&mut con, missing.as_bytes(), "created", "value", None).await.unwrap();
    assert!(matches!(
        get_value(&mut con, missing.as_bytes()).await.unwrap().data,
        RedisValueData::Hash { total: 1, .. }
    ));
    hash_set(&mut con, missing.as_bytes(), "created", "value", Some(60)).await.unwrap();
    let ttl: i64 = redis::cmd("TTL").arg(missing).query_async(&mut con).await.unwrap();
    assert!((1..=60).contains(&ttl));
    println!("PASS production missing/empty hash, create, explicit key TTL");

    redis::cmd("SET").arg(wrong_type).arg("string").query_async::<()>(&mut con).await.unwrap();
    assert!(hash_set(&mut con, wrong_type.as_bytes(), "field", "value", None).await.is_err());
    assert!(load_more_collection(&mut con, wrong_type.as_bytes(), "hash", 0, 200, None, None).await.is_err());
    assert!(hash_field_update(&mut con, wrong_type.as_bytes(), "field", "new", "value").await.is_err());
    let value: String = redis::cmd("GET").arg(wrong_type).query_async(&mut con).await.unwrap();
    assert_eq!(value, "string");
    println!("PASS production WRONGTYPE errors preserve data");
}

#[tokio::test]
#[ignore = "requires disposable server via DBX_TEST_REDIS_URL and DBX_TEST_REDIS_FLAVOR=kvrocks|redis74|redis72"]
async fn production_hash_compatibility() {
    let url = std::env::var("DBX_TEST_REDIS_URL").expect("DBX_TEST_REDIS_URL");
    let flavor = std::env::var("DBX_TEST_REDIS_FLAVOR").expect("DBX_TEST_REDIS_FLAVOR");
    assert!(["kvrocks", "redis74", "redis72"].contains(&flavor.as_str()));
    let mut con = connect(&url, Duration::from_secs(5)).await.unwrap();
    let info: String = redis::cmd("INFO").arg("server").query_async(&mut con).await.unwrap();
    println!(
        "{}",
        info.lines()
            .filter(|line| line.contains("version:") || line.contains("git_sha1:"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let keys: Vec<_> = (0..4).map(|index| format!("dbx-10948-{}-{nonce}-{index}", std::process::id())).collect();
    let kvrocks = flavor == "kvrocks";
    let original: Option<HashMap<String, String>> = if kvrocks {
        Some(redis::cmd("CONFIG").arg("GET").arg("hash-encoding-mode").query_async(&mut con).await.unwrap())
    } else {
        None
    };
    let seeded = seed(&mut con, &keys, kvrocks).await;
    if let Some(original) = original {
        redis::cmd("CONFIG")
            .arg("SET")
            .arg("hash-encoding-mode")
            .arg(&original["hash-encoding-mode"])
            .query_async::<()>(&mut con)
            .await
            .unwrap();
    }
    let outcome =
        if seeded.is_ok() { Some(tokio::spawn(exercise(con.clone(), keys.clone(), flavor)).await) } else { None };
    redis::cmd("DEL").arg(&keys).query_async::<()>(&mut con).await.unwrap();
    seeded.unwrap();
    outcome.unwrap().unwrap();
}
