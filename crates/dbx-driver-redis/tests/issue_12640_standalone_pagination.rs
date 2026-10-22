//! Real-environment verification for issue #12640: pagination of large hash and
//! set collections on a standalone Redis.
//!
//! Replays the exact call sequence the desktop app performs after the fix —
//! `get_value_scoped_with_preview_limit` mints the continuation cursor under the
//! connection/database scope, and every `load_more_collection_scoped` reuses the
//! same scope — and also pins the pre-fix pairing (an unscoped continuation),
//! which a real server rejects.
//!
//! Run against a standalone Redis:
//!   DBX_REDIS_STANDALONE_URL=redis://127.0.0.1:6379 cargo test -p dbx-driver-redis \
//!     --test issue_12640_standalone_pagination -- --ignored
//!
//! The test owns two keys in database 0 and deletes them before and after the
//! walk, so it is safe to point at a shared development server.

use std::collections::HashSet;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dbx_driver_redis::{
    get_value_scoped_with_preview_limit, load_more_collection, load_more_collection_scoped, select_db,
    RedisCollectionPage, RedisOperationScope, RedisValueData, STRING_PREVIEW_MAX_BYTES,
};

const FIELDS: usize = 4000;
const PAGE: usize = 200;
/// Fields written per HSET/SADD command. Seeding 4000 single-command writes in
/// one pipeline overruns the client's default 500 ms response timeout as soon
/// as the server is not on localhost.
const SEED_BATCH: usize = 200;

async fn connect() -> redis::aio::MultiplexedConnection {
    let url = std::env::var("DBX_REDIS_STANDALONE_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let client = redis::Client::open(url).expect("open redis url");
    let config = redis::AsyncConnectionConfig::new()
        .set_connection_timeout(Some(std::time::Duration::from_secs(10)))
        .set_response_timeout(Some(std::time::Duration::from_secs(60)));
    let mut con = client.get_multiplexed_async_connection_with_config(&config).await.expect("connect redis");
    select_db(&mut con, 0).await.expect("select db");
    con
}

async fn del_keys(con: &mut redis::aio::MultiplexedConnection) {
    let _: i64 =
        redis::cmd("DEL").arg("issue-12640-hash").arg("issue-12640-set").query_async(con).await.expect("clean keys");
}

async fn seed_hash(con: &mut redis::aio::MultiplexedConnection, key: &str) {
    for start in (0..FIELDS).step_by(SEED_BATCH) {
        let end = (start + SEED_BATCH).min(FIELDS);
        let mut cmd = redis::cmd("HSET");
        cmd.arg(key);
        for index in start..end {
            cmd.arg(format!("field:{index}")).arg(format!("value:{index}"));
        }
        let _: i64 = cmd.query_async(con).await.expect("seed hash batch");
    }
}

async fn seed_set(con: &mut redis::aio::MultiplexedConnection, key: &str) {
    for start in (0..FIELDS).step_by(SEED_BATCH) {
        let end = (start + SEED_BATCH).min(FIELDS);
        let mut cmd = redis::cmd("SADD");
        cmd.arg(key);
        for index in start..end {
            cmd.arg(format!("member:{index}"));
        }
        let _: i64 = cmd.query_async(con).await.expect("seed set batch");
    }
}

fn decoded(item: &impl AsRef<str>) -> String {
    String::from_utf8(BASE64.decode(item.as_ref()).expect("base64 payload")).expect("utf8 payload")
}

/// Walks a hash from its first scoped read to the last page, asserting every
/// field arrives exactly once and the walk terminates.
async fn walk_hash(con: &mut redis::aio::MultiplexedConnection, key: &str, scope: &RedisOperationScope) {
    let value = get_value_scoped_with_preview_limit(con, key.as_bytes(), scope, STRING_PREVIEW_MAX_BYTES)
        .await
        .expect("first hash page");
    let RedisValueData::Hash { items, scan_cursor, total } = value.data else {
        panic!("expected hash value");
    };
    assert_eq!(total, FIELDS as u64);
    assert!(!items.is_empty(), "the first page must carry fields");

    let mut seen: HashSet<String> = items.iter().map(|item| decoded(&item.field.raw_base64)).collect();
    let Some(mut cursor) = scan_cursor else {
        panic!("a 4000-field hash must offer a continuation");
    };

    // Pre-fix pairing: the desktop app continued standalone collections under the
    // default scope, which a real server rejects without issuing any scan.
    let unscoped = load_more_collection(con, key.as_bytes(), "hash", cursor, PAGE, None, None).await;
    assert!(
        unscoped.is_err(),
        "an unscoped continuation must be rejected, got {:?}",
        unscoped.ok().map(|page| match page {
            RedisCollectionPage::Hash { items, .. } => items.len(),
            _ => 0,
        })
    );

    let foreign_conn_scope = RedisOperationScope { connection_id: "foreign-scope-verify".to_string(), db: scope.db };
    let foreign_conn =
        load_more_collection_scoped(con, key.as_bytes(), "hash", cursor, PAGE, None, None, &foreign_conn_scope).await;
    assert!(foreign_conn.is_err(), "a foreign connection hash continuation must be rejected");

    let foreign_db_scope =
        RedisOperationScope { connection_id: scope.connection_id.clone(), db: if scope.db == 0 { 1 } else { 0 } };
    let foreign_db =
        load_more_collection_scoped(con, key.as_bytes(), "hash", cursor, PAGE, None, None, &foreign_db_scope).await;
    assert!(foreign_db.is_err(), "a foreign db hash continuation must be rejected");

    let mut rounds = 0usize;
    while cursor != 0 {
        let page = load_more_collection_scoped(con, key.as_bytes(), "hash", cursor, PAGE, None, None, scope)
            .await
            .expect("scoped hash continuation");
        let RedisCollectionPage::Hash { items, scan_cursor } = page else {
            panic!("expected hash page");
        };
        let before = seen.len();
        seen.extend(items.iter().map(|item| decoded(&item.field.raw_base64)));
        assert_eq!(seen.len() - before, items.len(), "no page may re-serve a field");
        match scan_cursor {
            // The marker is an opaque session handle: it stays the same while
            // the session still buffers a page and only switches to the server
            // scan cursor once the buffer drains.
            Some(next) => cursor = next,
            None => break,
        }
        rounds += 1;
        assert!(rounds <= 5 * FIELDS / PAGE + 8, "pagination must terminate");
    }

    assert_eq!(seen.len(), FIELDS, "every field must arrive exactly once");
    for index in 0..FIELDS {
        assert!(seen.contains(&format!("field:{index}")), "missing field:{index}");
    }
}

/// Same walk for sets: the sibling collection that shares the overflow session
/// mechanism and the same pre-fix scope mismatch.
async fn walk_set(con: &mut redis::aio::MultiplexedConnection, key: &str, scope: &RedisOperationScope) {
    let value = get_value_scoped_with_preview_limit(con, key.as_bytes(), scope, STRING_PREVIEW_MAX_BYTES)
        .await
        .expect("first set page");
    let RedisValueData::Set { items, scan_cursor, total } = value.data else {
        panic!("expected set value");
    };
    assert_eq!(total, FIELDS as u64);

    let mut seen: HashSet<String> = items.iter().map(|item| decoded(&item.member.raw_base64)).collect();
    let Some(mut cursor) = scan_cursor else {
        panic!("a 4000-member set must offer a continuation");
    };
    let unscoped = load_more_collection(con, key.as_bytes(), "set", cursor, PAGE, None, None).await;
    assert!(unscoped.is_err(), "an unscoped set continuation must be rejected");

    let foreign_conn_scope = RedisOperationScope { connection_id: "foreign-scope-verify".to_string(), db: scope.db };
    let foreign_conn =
        load_more_collection_scoped(con, key.as_bytes(), "set", cursor, PAGE, None, None, &foreign_conn_scope).await;
    assert!(foreign_conn.is_err(), "a foreign connection set continuation must be rejected");

    let foreign_db_scope =
        RedisOperationScope { connection_id: scope.connection_id.clone(), db: if scope.db == 0 { 1 } else { 0 } };
    let foreign_db =
        load_more_collection_scoped(con, key.as_bytes(), "set", cursor, PAGE, None, None, &foreign_db_scope).await;
    assert!(foreign_db.is_err(), "a foreign db set continuation must be rejected");

    let mut rounds = 0usize;
    while cursor != 0 {
        let page = load_more_collection_scoped(con, key.as_bytes(), "set", cursor, PAGE, None, None, scope)
            .await
            .expect("scoped set continuation");
        let RedisCollectionPage::Set { items, scan_cursor } = page else {
            panic!("expected set page");
        };
        let before = seen.len();
        seen.extend(items.iter().map(|item| decoded(&item.member.raw_base64)));
        assert_eq!(seen.len() - before, items.len(), "no page may re-serve a member");
        match scan_cursor {
            Some(next) => cursor = next,
            None => break,
        }
        rounds += 1;
        assert!(rounds <= 5 * FIELDS / PAGE + 8, "pagination must terminate");
    }

    assert_eq!(seen.len(), FIELDS, "every member must arrive exactly once");
}

#[tokio::test]
#[ignore = "requires a standalone Redis at DBX_REDIS_STANDALONE_URL (default redis://127.0.0.1:6379)"]
async fn standalone_hash_and_set_pagination_walk_large_collections_under_one_scope() {
    let mut con = connect().await;
    let scope = RedisOperationScope { connection_id: "issue-12640-verify".to_string(), db: 0 };

    del_keys(&mut con).await;
    seed_hash(&mut con, "issue-12640-hash").await;
    seed_set(&mut con, "issue-12640-set").await;

    walk_hash(&mut con, "issue-12640-hash", &scope).await;
    walk_set(&mut con, "issue-12640-set", &scope).await;

    del_keys(&mut con).await;
}
