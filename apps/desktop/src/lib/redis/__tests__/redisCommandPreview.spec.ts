import { describe, expect, it } from "vitest";
import { quoteRedisArg, quoteRedisBytes, quoteRedisKeyRaw, redisDeleteGroupPreview, redisDeleteKeysPreview, redisDeleteValueItemPreview, redisFlushDbPreview } from "../redisCommandPreview";
import { redisKeyTextToRaw } from "../redisCommandSession";

describe("quoteRedisArg and quoteRedisBytes", () => {
  it("quotes empty string", () => {
    expect(quoteRedisArg("")).toBe('""');
    expect(quoteRedisBytes(new Uint8Array([]))).toBe('""');
  });

  it("leaves simple keys unquoted", () => {
    expect(quoteRedisArg("simple_key")).toBe("simple_key");
    expect(quoteRedisArg("user:123:profile")).toBe("user:123:profile");
    expect(quoteRedisArg("cache-key.v1")).toBe("cache-key.v1");
  });

  it("quotes keys with whitespace", () => {
    expect(quoteRedisArg("key with space")).toBe('"key with space"');
    expect(quoteRedisArg("key\twith\ttab")).toBe('"key\\twith\\ttab"');
    expect(quoteRedisArg("key\nwith\nnewline")).toBe('"key\\nwith\\nnewline"');
  });

  it("quotes keys with quotes or backslashes with exact single-escaping", () => {
    expect(quoteRedisArg('key"with"doublequote')).toBe('"key\\"with\\"doublequote"');
    expect(quoteRedisArg("key'with'singlequote")).toBe("\"key'with'singlequote\"");
    expect(quoteRedisArg("key\\with\\backslash")).toBe('"key\\\\with\\\\backslash"');
  });

  it("quotes binary bytes and control characters with \\xHH", () => {
    const binaryBytes = new Uint8Array([0x00, 0x01, 0x1f, 0x7f, 0xff]);
    expect(quoteRedisBytes(binaryBytes)).toBe('"\\x00\\x01\\x1f\\x7f\\xff"');
  });

  it("preserves valid UTF-8 sequences verbatim inside quotes without swallowing adjacent ASCII or escaping", () => {
    expect(quoteRedisArg("用户:123:设置")).toBe('"用户:123:设置"');

    // Reproductions from zipg review [P1]:
    // 1) e4 b8 ad 5c 6e -> "中\n" in bytes, must escape backslash as \\ and preserve 'n', not produce "中\n"
    const zhongBackslashN = new Uint8Array([0xe4, 0xb8, 0xad, 0x5c, 0x6e]);
    expect(quoteRedisBytes(zhongBackslashN)).toBe('"中\\\\n"');

    // 2) c3 a9 22 0a -> "é\"\n" in bytes, must escape quote as \" and newline as \n, not produce unclosed quote
    const eAcuteQuoteNewline = new Uint8Array([0xc3, 0xa9, 0x22, 0x0a]);
    expect(quoteRedisBytes(eAcuteQuoteNewline)).toBe('"é\\"\\n"');

    // 3) Adjacent ASCII special characters before and after UTF-8 characters
    // Space:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x20]))).toBe('"中 "');
    expect(quoteRedisBytes(new Uint8Array([0x20, 0xe4, 0xb8, 0xad]))).toBe('" 中"');
    // Newline:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x0a]))).toBe('"中\\n"');
    expect(quoteRedisBytes(new Uint8Array([0x0a, 0xe4, 0xb8, 0xad]))).toBe('"\\n中"');
    // Quote:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x22]))).toBe('"中\\""');
    expect(quoteRedisBytes(new Uint8Array([0x22, 0xe4, 0xb8, 0xad]))).toBe('"\\"中"');
    // Backslash:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x5c]))).toBe('"中\\\\"');
    expect(quoteRedisBytes(new Uint8Array([0x5c, 0xe4, 0xb8, 0xad]))).toBe('"\\\\中"');
    // Controls:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x00]))).toBe('"中\\x00"');
    expect(quoteRedisBytes(new Uint8Array([0x00, 0xe4, 0xb8, 0xad]))).toBe('"\\x00中"');
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0x09]))).toBe('"中\\t"');
    // Binary bytes:
    expect(quoteRedisBytes(new Uint8Array([0xe4, 0xb8, 0xad, 0xff]))).toBe('"中\\xff"');
    expect(quoteRedisBytes(new Uint8Array([0xff, 0xe4, 0xb8, 0xad]))).toBe('"\\xff中"');
    expect(quoteRedisBytes(new Uint8Array([0x80, 0xe4, 0xb8, 0xad, 0x80]))).toBe('"\\x80中\\x80"');
    // Broken/truncated UTF-8 sequence followed by space:
    expect(quoteRedisBytes(new Uint8Array([0xc3, 0x20]))).toBe('"\\xc3 "');
  });

  it("quotes RedisBlob objects using raw_base64 bytes", () => {
    const utf8Blob = { raw_base64: btoa("hello world"), encoding: "utf8" };
    expect(quoteRedisArg(utf8Blob)).toBe('"hello world"');

    const binaryBlob = { raw_base64: btoa("\x00\xff"), encoding: "binary" };
    expect(quoteRedisArg(binaryBlob)).toBe('"\\x00\\xff"');
  });
});

describe("quoteRedisKeyRaw", () => {
  it("recovers exact bytes from key_raw without double backslash escaping", () => {
    const rawWithBackslash = redisKeyTextToRaw("cache\\session");
    expect(quoteRedisKeyRaw(rawWithBackslash)).toBe('"cache\\\\session"');
  });

  it("quotes binary key_raw containing null bytes and high bytes", () => {
    const binaryRaw = btoa("k\x00\xff");
    expect(quoteRedisKeyRaw(binaryRaw)).toBe('"k\\x00\\xff"');
  });
});

describe("redisFlushDbPreview", () => {
  it("prefixes with SELECT in standalone mode when database is provided", () => {
    expect(redisFlushDbPreview(6)).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("db6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview(0)).toBe("SELECT 0\nFLUSHDB");
    expect(redisFlushDbPreview("0")).toBe("SELECT 0\nFLUSHDB");
  });

  it("returns FLUSHDB when database is absent or empty", () => {
    expect(redisFlushDbPreview(undefined)).toBe("FLUSHDB");
    expect(redisFlushDbPreview(null)).toBe("FLUSHDB");
    expect(redisFlushDbPreview("")).toBe("FLUSHDB");
  });

  it("omits SELECT in Cluster mode because Cluster does not allow SELECT", () => {
    expect(redisFlushDbPreview(6, true)).toBe("FLUSHDB");
    expect(redisFlushDbPreview("db3", true)).toBe("FLUSHDB");
  });
});

describe("redisDeleteKeysPreview", () => {
  it("returns empty string when key list is empty", () => {
    expect(redisDeleteKeysPreview([])).toBe("");
  });

  it("formats single and multiple keys", () => {
    expect(redisDeleteKeysPreview(["user:1"])).toBe("DEL user:1");
    expect(redisDeleteKeysPreview(["user:1", "user:2", "cache:session with space"])).toBe('DEL user:1 user:2 "cache:session with space"');
  });

  it("chunks large key lists across multiple DEL lines", () => {
    const keys = Array.from({ length: 7 }, (_, i) => `key:${i + 1}`);
    const preview = redisDeleteKeysPreview(keys, 3);
    expect(preview).toBe("DEL key:1 key:2 key:3\nDEL key:4 key:5 key:6\nDEL key:7");
  });

  it("handles base64 key_raw directly with raw: true", () => {
    const keyRaws = [redisKeyTextToRaw("user:1"), redisKeyTextToRaw("path\\to\\key"), btoa("bin\x00key")];
    const preview = redisDeleteKeysPreview(keyRaws, { raw: true });
    expect(preview).toBe('DEL user:1 "path\\\\to\\\\key" "bin\\x00key"');
  });

  it("prefixes SELECT for non-zero database in standalone mode", () => {
    const keys = ["k1", "k2"];
    expect(redisDeleteKeysPreview(keys, { database: 3 })).toBe("SELECT 3\nDEL k1 k2");
    expect(redisDeleteKeysPreview(keys, { database: 0 })).toBe("DEL k1 k2");
  });

  it("groups keys strictly by CRC16 hash slot in Cluster mode to prevent CROSSSLOT", () => {
    // 1) Keys in different slots are segregated into separate DEL commands
    // 'k1' (slot 12706) and 'k2' (slot 449)
    expect(redisDeleteKeysPreview(["k1", "k2"], { isCluster: true })).toBe("DEL k1\nDEL k2");
    // SELECT is also omitted in Cluster mode
    expect(redisDeleteKeysPreview(["k1", "k2"], { database: 3, isCluster: true })).toBe("DEL k1\nDEL k2");

    // 2) Keys sharing the same hash tag {user} belong to the exact same slot and can be combined
    const sameSlotKeys = ["{user}:1", "{user}:2", "{user}:3"];
    expect(redisDeleteKeysPreview(sameSlotKeys, { isCluster: true })).toBe('DEL "{user}:1" "{user}:2" "{user}:3"');

    // 3) Mixed keys across multiple slots are grouped with their respective slot without cross-slot mixing
    const mixedKeys = ["{alpha}:1", "{beta}:1", "{alpha}:2", "{gamma}:1", "{beta}:2"];
    const clusterPreview = redisDeleteKeysPreview(mixedKeys, { isCluster: true });
    expect(clusterPreview).toBe('DEL "{alpha}:1" "{alpha}:2"\nDEL "{beta}:1" "{beta}:2"\nDEL "{gamma}:1"');

    // 4) Keys within the same slot exceeding chunkSize are chunked across lines
    const sevenSameSlotKeys = Array.from({ length: 7 }, (_, i) => `{slot}:item:${i + 1}`);
    const chunkedCluster = redisDeleteKeysPreview(sevenSameSlotKeys, { isCluster: true, chunkSize: 3 });
    expect(chunkedCluster).toBe('DEL "{slot}:item:1" "{slot}:item:2" "{slot}:item:3"\nDEL "{slot}:item:4" "{slot}:item:5" "{slot}:item:6"\nDEL "{slot}:item:7"');

    // 5) Base64 raw binary keys with hash tags in Cluster mode
    const rawTagKey1 = redisKeyTextToRaw("{tag}:bin\x00key1");
    const rawTagKey2 = redisKeyTextToRaw("{tag}:bin\x00key2");
    const rawOtherKey = redisKeyTextToRaw("other_slot_key");
    const rawClusterPreview = redisDeleteKeysPreview([rawTagKey1, rawTagKey2, rawOtherKey], { isCluster: true, raw: true });
    expect(rawClusterPreview).toBe('DEL "{tag}:bin\\x00key1" "{tag}:bin\\x00key2"\nDEL other_slot_key');
  });
});

describe("redisDeleteGroupPreview", () => {
  it("formats bounded standalone scan-and-delete command with batch limit 512", () => {
    const preview = redisDeleteGroupPreview("user:*");
    expect(preview).toContain("# Applicable: Standalone Redis");
    expect(preview).toContain("SCAN COUNT 500, bounded DEL <= 512 keys per batch");
    expect(preview).toContain("python3 - << 'EOF'");
    expect(preview).toContain('HOST = "127.0.0.1"');
    expect(preview).toContain("PORT = 6379");
    expect(preview).toContain("DB = 0");
    expect(preview).toContain('PATTERN = "user:*".encode("utf-8")');
    expect(preview).toContain("SCAN_COUNT = 500");
    expect(preview).toContain("BATCH_SIZE = 512");
    expect(preview).not.toContain("xargs");
    expect(preview).not.toContain("EVAL");
  });

  it("includes explicit database in standalone mode", () => {
    const preview = redisDeleteGroupPreview("user:*", { database: 2 });
    expect(preview).toContain("# Applicable: Standalone Redis (db 2)");
    expect(preview).toContain("DB = 2");
    expect(preview).toContain('cmd.extend(["-n", str(DB)])');
    expect(preview).toContain('send_resp(f, [b"SELECT", str(DB).encode("utf-8")])');
  });

  it("formats cluster preview with slot-routed execution and avoids cross-slot DEL", () => {
    const preview = redisDeleteGroupPreview("cache:*", { isCluster: true });
    expect(preview).toContain("# Applicable: Redis Cluster (slot-routed multi-node execution)");
    expect(preview).toContain("IS_CLUSTER = True");
    expect(preview).toContain('send_resp(f, [b"CLUSTER", b"NODES"])');
    expect(preview).toContain("get_crc16_slot");
    expect(preview).toContain("binascii.crc_hqx");
    expect(preview).toContain('cmd.append("-c")');
    expect(preview).not.toContain("xargs");
    expect(preview).not.toContain("EVAL");
  });

  it("includes connection context for authentication, host, port, and TLS", () => {
    const preview = redisDeleteGroupPreview("secure:*", {
      database: 1,
      connection: {
        host: "redis.prod.internal",
        port: 6380,
        username: "ops",
        password: "secret'\"pass",
        tls: true,
      },
    });
    expect(preview).toContain('HOST = "redis.prod.internal"');
    expect(preview).toContain("PORT = 6380");
    expect(preview).toContain('USERNAME = "ops"');
    expect(preview).toContain('PASSWORD = "secret\'\\"pass"');
    expect(preview).toContain("TLS = True");
    expect(preview).toContain("DB = 1");
  });
});

describe("redisDeleteValueItemPreview", () => {
  it("formats key deletion", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "key" })).toBe("DEL user:100");
  });

  it("formats hash field deletion with raw bytes and special characters", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "email" })).toBe("HDEL user:100 email");
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "path\\field" })).toBe('HDEL user:100 "path\\\\field"');

    const binaryBlob = { raw_base64: btoa("\x00\x01\xff"), encoding: "binary" };
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: binaryBlob })).toBe('HDEL user:100 "\\x00\\x01\\xff"');
  });

  it("formats set member deletion with raw bytes and special characters", () => {
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: "vip" })).toBe("SREM tags vip");

    const binaryBlob = { raw_base64: btoa("sub\x00member"), encoding: "binary" };
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: binaryBlob })).toBe('SREM tags "sub\\x00member"');
  });

  it("formats zset member deletion", () => {
    expect(redisDeleteValueItemPreview("leaderboard", { kind: "zset", member: "player1" })).toBe("ZREM leaderboard player1");
  });

  it("formats list index removal", () => {
    expect(redisDeleteValueItemPreview("queue", { kind: "list", index: 2 })).toBe('LSET queue 2 "__DELETED_PLACEHOLDER__"\nLREM queue 1 "__DELETED_PLACEHOLDER__"');
  });

  it("respects raw key and non-zero database options", () => {
    const rawKey = redisKeyTextToRaw("user\\name");
    const preview = redisDeleteValueItemPreview(rawKey, { kind: "hash", field: "attr" }, { raw: true, database: 4 });
    expect(preview).toBe('SELECT 4\nHDEL "user\\\\name" attr');
  });

  it("omits SELECT in Cluster mode", () => {
    const rawKey = redisKeyTextToRaw("user\\name");
    const preview = redisDeleteValueItemPreview(rawKey, { kind: "hash", field: "attr" }, { raw: true, database: 4, isCluster: true });
    expect(preview).toBe('HDEL "user\\\\name" attr');
  });
});
