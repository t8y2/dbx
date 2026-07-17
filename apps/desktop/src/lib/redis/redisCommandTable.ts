/**
 * Static Redis command metadata, distilled from the official Redis command table
 * (redis-doc `commands.json` / the `COMMAND` output). Kept offline and lightweight:
 * we only retain what the editor syntax diagnostics need — `arity` and `group` —
 * plus a `safety` hint for command gating and write-command highlighting.
 *
 * Arity semantics (matches the Redis `COMMAND` reply, command name INCLUDED in the count):
 *   arity > 0  → the command takes exactly `arity` tokens (e.g. GET key → arity 2).
 *   arity < 0  → the command takes AT LEAST `-arity` tokens (e.g. MSET k v [k v ...] → arity -3).
 *
 * `safety` is aligned with the token-level sets in `redisCommandSafety.ts` (used to gate
 * execution). `write` commands mutate data without a confirmation prompt; `confirm`
 * commands are destructive/structural enough to ask first. Here it is recorded
 * per-command (including subcommands) so diagnostics can be more precise than the
 * first-token classification.
 *
 * Subcommands are keyed as `"MAIN SUB"` in UPPER CASE (e.g. `"CONFIG GET"`, `"XGROUP CREATE"`).
 */
import type { RedisCommandSafety } from "@/lib/redis/redisCommandSafety";

export interface RedisCommandSpec {
  /** Token count including the command name. Positive = exact, negative = minimum (-N). */
  arity: number;
  /** Redis command group: string/list/hash/.../server. */
  group: string;
  /** Danger level for diagnostic highlighting. */
  safety: RedisCommandSafety;
}

type Spec = [arity: number, group: string, safety?: RedisCommandSafety];

const WRITE_WITHOUT_CONFIRM = new Set([
  "APPEND",
  "BITFIELD",
  "BITOP",
  "CLIENT SETINFO",
  "CLIENT SETNAME",
  "COPY",
  "DECR",
  "DECRBY",
  "GEOADD",
  "GEORADIUS",
  "GEORADIUSBYMEMBER",
  "GETSET",
  "HINCRBY",
  "HINCRBYFLOAT",
  "HMSET",
  "HSET",
  "HSETNX",
  "INCR",
  "INCRBY",
  "INCRBYFLOAT",
  "LINSERT",
  "LMOVE",
  "LPUSH",
  "LPUSHX",
  "MSET",
  "MSETNX",
  "PERSIST",
  "PFADD",
  "PSETEX",
  "RESTORE",
  "RPUSH",
  "RPUSHX",
  "SADD",
  "SET",
  "SETBIT",
  "SETEX",
  "SETNX",
  "SETRANGE",
  "XACK",
  "XADD",
  "XAUTOCLAIM",
  "XCLAIM",
  "XGROUP CREATE",
  "XGROUP CREATECONSUMER",
  "XGROUP SETID",
  "XSETID",
  "ZADD",
  "ZINCRBY",
]);

// Compact tuple form → expanded into the record below.
const RAW_COMMANDS: Record<string, Spec> = {
  // ---- String ----
  APPEND: [3, "string", "confirm"],
  DECR: [2, "string", "confirm"],
  DECRBY: [3, "string", "confirm"],
  GET: [2, "string"],
  GETDEL: [2, "string", "confirm"],
  GETEX: [-2, "string"],
  GETRANGE: [4, "string"],
  GETSET: [3, "string", "confirm"],
  INCR: [2, "string", "confirm"],
  INCRBY: [3, "string", "confirm"],
  INCRBYFLOAT: [3, "string", "confirm"],
  LCS: [-3, "string"],
  MGET: [-2, "string"],
  MSET: [-3, "string", "confirm"],
  MSETNX: [-3, "string", "confirm"],
  PSETEX: [4, "string", "confirm"],
  SET: [-3, "string", "confirm"],
  SETEX: [4, "string", "confirm"],
  SETNX: [3, "string", "confirm"],
  SETRANGE: [4, "string", "confirm"],
  STRLEN: [2, "string"],

  // ---- Generic key ----
  COPY: [-3, "generic", "confirm"],
  DEL: [-2, "generic", "confirm"],
  DUMP: [2, "generic"],
  EXISTS: [-2, "generic"],
  EXPIRE: [-3, "generic", "confirm"],
  EXPIREAT: [-3, "generic", "confirm"],
  KEYS: [2, "generic", "blocked"],
  MIGRATE: [-6, "generic", "blocked"],
  MOVE: [3, "generic", "confirm"],
  OBJECT_ENCODING: [3, "generic"],
  OBJECT_FREQ: [3, "generic"],
  OBJECT_IDLETIME: [3, "generic"],
  OBJECT_REFCOUNT: [3, "generic"],
  OBJECT_HELP: [2, "generic"],
  PERSIST: [2, "generic", "confirm"],
  PEXPIRE: [-3, "generic", "confirm"],
  PEXPIREAT: [-3, "generic", "confirm"],
  PTTL: [2, "generic"],
  RANDOMKEY: [1, "generic"],
  RENAME: [3, "generic", "confirm"],
  RENAMENX: [3, "generic", "confirm"],
  RESTORE: [-4, "generic", "confirm"],
  SCAN: [-2, "generic"],
  SORT: [-2, "generic", "confirm"],
  SORT_RO: [-2, "generic"],
  TOUCH: [-2, "generic"],
  TTL: [2, "generic"],
  TYPE: [2, "generic"],
  UNLINK: [-2, "generic", "confirm"],
  WAIT: [3, "generic"],
  WAITAOF: [4, "generic"],

  // ---- List ----
  BLMOVE: [6, "list"],
  BLMPOP: [-4, "list"],
  BLPOP: [-3, "list"],
  BRPOP: [-3, "list"],
  BRPOPLPUSH: [4, "list"],
  LINDEX: [3, "list"],
  LINSERT: [5, "list", "confirm"],
  LLEN: [2, "list"],
  LMOVE: [5, "list", "confirm"],
  LMPOP: [-4, "list", "confirm"],
  LPOP: [-2, "list", "confirm"],
  LPOS: [-2, "list"],
  LPUSH: [-3, "list", "confirm"],
  LPUSHX: [-3, "list", "confirm"],
  LRANGE: [4, "list"],
  LREM: [4, "list", "confirm"],
  LSET: [4, "list", "confirm"],
  LTRIM: [4, "list", "confirm"],
  RPOP: [-2, "list", "confirm"],
  RPOPLPUSH: [4, "list", "confirm"],
  RPUSH: [-3, "list", "confirm"],
  RPUSHX: [-3, "list", "confirm"],

  // ---- Hash ----
  HDEL: [-3, "hash", "confirm"],
  HEXISTS: [3, "hash"],
  HGET: [3, "hash"],
  HGETALL: [2, "hash"],
  HINCRBY: [4, "hash", "confirm"],
  HINCRBYFLOAT: [4, "hash", "confirm"],
  HKEYS: [2, "hash"],
  HLEN: [2, "hash"],
  HMGET: [-3, "hash"],
  HMSET: [-4, "hash", "confirm"],
  HRANDFIELD: [-2, "hash"],
  HSCAN: [-3, "hash"],
  HSET: [-4, "hash", "confirm"],
  HSETNX: [4, "hash", "confirm"],
  HSTRLEN: [3, "hash"],
  HVALS: [2, "hash"],

  // ---- Set ----
  SADD: [-3, "set", "confirm"],
  SCARD: [2, "set"],
  SDIFF: [-2, "set"],
  SDIFFSTORE: [-3, "set", "confirm"],
  SINTER: [-2, "set"],
  SINTERCARD: [-3, "set"],
  SINTERSTORE: [-3, "set", "confirm"],
  SISMEMBER: [3, "set"],
  SMEMBERS: [2, "set"],
  SMISMEMBER: [-3, "set"],
  SMOVE: [4, "set", "confirm"],
  SPOP: [-2, "set", "confirm"],
  SRANDMEMBER: [-2, "set"],
  SREM: [-3, "set", "confirm"],
  SSCAN: [-3, "set"],
  SUNION: [-2, "set"],
  SUNIONSTORE: [-3, "set", "confirm"],

  // ---- Sorted set ----
  BZMPOP: [-3, "zset"],
  BZPOPMAX: [-3, "zset"],
  BZPOPMIN: [-3, "zset"],
  ZADD: [-4, "zset", "confirm"],
  ZCARD: [2, "zset"],
  ZCOUNT: [4, "zset"],
  ZDIFF: [-3, "zset"],
  ZDIFFSTORE: [-4, "zset", "confirm"],
  ZINCRBY: [4, "zset", "confirm"],
  ZINTER: [-3, "zset"],
  ZINTERCARD: [-3, "zset"],
  ZINTERSTORE: [-4, "zset", "confirm"],
  ZLEXCOUNT: [4, "zset"],
  ZMPOP: [-3, "zset", "confirm"],
  ZMSCORE: [-3, "zset"],
  ZPOPMAX: [-2, "zset", "confirm"],
  ZPOPMIN: [-2, "zset", "confirm"],
  ZRANDMEMBER: [-2, "zset"],
  ZRANGE: [-4, "zset"],
  ZRANGEBYLEX: [-4, "zset"],
  ZRANGEBYSCORE: [-4, "zset"],
  ZRANGESTORE: [-5, "zset", "confirm"],
  ZRANK: [-3, "zset"],
  ZREM: [-3, "zset", "confirm"],
  ZREMRANGEBYLEX: [4, "zset", "confirm"],
  ZREMRANGEBYRANK: [4, "zset", "confirm"],
  ZREMRANGEBYSCORE: [4, "zset", "confirm"],
  ZREVRANGE: [-4, "zset"],
  ZREVRANGEBYLEX: [-4, "zset"],
  ZREVRANGEBYSCORE: [-4, "zset"],
  ZREVRANK: [-3, "zset"],
  ZSCAN: [-3, "zset"],
  ZSCORE: [3, "zset"],
  ZUNION: [-3, "zset"],
  ZUNIONSTORE: [-4, "zset", "confirm"],

  // ---- Bitmap ----
  BITCOUNT: [-2, "bitmap"],
  BITFIELD: [-2, "bitmap", "confirm"],
  BITFIELD_RO: [-2, "bitmap"],
  BITOP: [-4, "bitmap", "confirm"],
  BITPOS: [-3, "bitmap"],
  GETBIT: [3, "bitmap"],
  SETBIT: [4, "bitmap", "confirm"],

  // ---- Hyperloglog ----
  PFADD: [-2, "hyperloglog", "confirm"],
  PFCOUNT: [-2, "hyperloglog"],
  PFMERGE: [-2, "hyperloglog", "confirm"],

  // ---- Geo ----
  GEOADD: [-5, "geo", "confirm"],
  GEODIST: [-4, "geo"],
  GEOHASH: [-3, "geo"],
  GEOPOS: [-3, "geo"],
  GEORADIUS: [-6, "geo", "confirm"],
  GEORADIUS_RO: [-6, "geo"],
  GEORADIUSBYMEMBER: [-5, "geo", "confirm"],
  GEORADIUSBYMEMBER_RO: [-5, "geo"],
  GEOSEARCH: [-7, "geo"],
  GEOSEARCHSTORE: [-8, "geo", "confirm"],

  // ---- Stream ----
  XACK: [-4, "stream", "confirm"],
  XADD: [-5, "stream", "confirm"],
  XAUTOCLAIM: [-7, "stream", "confirm"],
  XCLAIM: [-6, "stream", "confirm"],
  XDEL: [-3, "stream", "confirm"],
  "XGROUP CREATE": [-6, "stream", "confirm"],
  "XGROUP CREATECONSUMER": [5, "stream", "confirm"],
  "XGROUP DELCONSUMER": [4, "stream", "confirm"],
  "XGROUP DESTROY": [4, "stream", "confirm"],
  "XGROUP HELP": [2, "stream"],
  "XGROUP SETID": [-5, "stream", "confirm"],
  "XINFO CONSUMERS": [4, "stream"],
  "XINFO GROUPS": [3, "stream"],
  "XINFO HELP": [2, "stream"],
  "XINFO STREAM": [-3, "stream"],
  XLEN: [2, "stream"],
  XPENDING: [-3, "stream"],
  XRANGE: [-4, "stream"],
  XREAD: [-4, "stream"],
  XREADGROUP: [-7, "stream"],
  XREVRANGE: [-4, "stream"],
  XSETID: [-3, "stream", "confirm"],
  XTRIM: [-4, "stream", "confirm"],

  // ---- Pub/Sub ----
  PSUBSCRIBE: [-2, "pubsub"],
  PUBLISH: [3, "pubsub"],
  "PUBSUB CHANNELS": [-2, "pubsub"],
  "PUBSUB NUMPAT": [1, "pubsub"],
  "PUBSUB NUMSUB": [-2, "pubsub"],
  "PUBSUB SHARDCHANNELS": [-2, "pubsub"],
  "PUBSUB SHARDNUMSUB": [-2, "pubsub"],
  PUNSUBSCRIBE: [-1, "pubsub"],
  SPUBLISH: [3, "pubsub"],
  SSUBSCRIBE: [2, "pubsub"],
  SUBSCRIBE: [-2, "pubsub"],
  SUNSUBSCRIBE: [-1, "pubsub"],
  UNSUBSCRIBE: [-1, "pubsub"],

  // ---- Transactions ----
  DISCARD: [1, "transactions"],
  EXEC: [1, "transactions"],
  MULTI: [1, "transactions"],
  UNWATCH: [1, "transactions"],
  WATCH: [-2, "transactions"],

  // ---- Scripting ----
  EVAL: [-3, "scripting", "blocked"],
  EVALSHA: [-3, "scripting", "blocked"],
  EVAL_RO: [-3, "scripting", "blocked"],
  EVALSHA_RO: [-3, "scripting", "blocked"],
  FCALL: [-3, "scripting"],
  FCALL_RO: [-3, "scripting"],
  "FUNCTION DELETE": [3, "scripting", "confirm"],
  "FUNCTION DUMP": [2, "scripting"],
  "FUNCTION FLUSH": [-2, "scripting", "confirm"],
  "FUNCTION LIST": [-2, "scripting"],
  "FUNCTION LOAD": [-3, "scripting", "confirm"],
  "FUNCTION RESTORE": [-4, "scripting", "confirm"],
  "FUNCTION STATS": [1, "scripting"],
  "SCRIPT EXISTS": [-2, "scripting", "blocked"],
  "SCRIPT FLUSH": [-2, "scripting", "blocked"],
  "SCRIPT KILL": [1, "scripting", "blocked"],
  "SCRIPT LOAD": [2, "scripting", "blocked"],

  // ---- Connection ----
  AUTH: [-2, "connection"],
  ECHO: [2, "connection"],
  HELLO: [-1, "connection"],
  PING: [-1, "connection"],
  QUIT: [1, "connection"],
  RESET: [1, "connection"],
  SELECT: [2, "connection"],
  "CLIENT CACHING": [3, "connection"],
  "CLIENT GETNAME": [1, "connection"],
  "CLIENT GETREDIR": [1, "connection"],
  "CLIENT ID": [1, "connection"],
  "CLIENT INFO": [1, "connection"],
  "CLIENT KILL": [-3, "connection", "confirm"],
  "CLIENT LIST": [-2, "connection"],
  "CLIENT NO-EVICT": [2, "connection"],
  "CLIENT NO-TOUCH": [2, "connection"],
  "CLIENT PAUSE": [-2, "connection"],
  "CLIENT REPLY": [2, "connection"],
  "CLIENT SETINFO": [-3, "connection"],
  "CLIENT SETNAME": [3, "connection"],
  "CLIENT TRACKING": [-3, "connection"],
  "CLIENT TRACKINGINFO": [1, "connection"],
  "CLIENT UNPAUSE": [1, "connection"],

  // ---- Server ----
  BGREWRITEAOF: [1, "server"],
  BGSAVE: [-1, "server", "blocked"],
  "COMMAND COUNT": [1, "server"],
  "COMMAND DOCS": [-2, "server"],
  "COMMAND GETKEYS": [-3, "server"],
  "COMMAND INFO": [-2, "server"],
  "COMMAND LIST": [-2, "server"],
  "CONFIG GET": [-2, "server", "blocked"],
  "CONFIG RESETSTAT": [1, "server", "blocked"],
  "CONFIG REWRITE": [1, "server", "blocked"],
  "CONFIG SET": [-3, "server", "blocked"],
  DBSIZE: [1, "server"],
  FAILOVER: [-1, "server", "confirm"],
  FLUSHALL: [-1, "server", "blocked"],
  FLUSHDB: [-1, "server", "confirm"],
  INFO: [-1, "server"],
  LASTSAVE: [1, "server"],
  "MEMORY USAGE": [-3, "server"],
  "MEMORY STATS": [1, "server"],
  "MEMORY PURGE": [1, "server"],
  "MEMORY DOCS": [1, "server"],
  "MODULE LIST": [1, "server", "blocked"],
  "MODULE LOAD": [-3, "server", "blocked"],
  "MODULE LOADEX": [-3, "server", "blocked"],
  "MODULE UNLOAD": [3, "server", "blocked"],
  MONITOR: [1, "server"],
  REPLICAOF: [3, "server", "blocked"],
  ROLE: [1, "server"],
  SAVE: [1, "server", "blocked"],
  SHUTDOWN: [-1, "server", "blocked"],
  SLAVEOF: [3, "server", "blocked"],
  "SLOWLOG GET": [-2, "server"],
  "SLOWLOG LEN": [1, "server"],
  "SLOWLOG RESET": [1, "server"],
  "SLOWLOG HELP": [1, "server"],
  SWAPDB: [3, "server", "confirm"],
  SYNC: [1, "server"],
  TIME: [1, "server"],

  // ---- Cluster ----
  "CLUSTER ADDSLOTS": [-3, "cluster", "confirm"],
  "CLUSTER COUNT-FAILURE-REPORTS": [2, "cluster"],
  "CLUSTER COUNTKEYSINSLOT": [3, "cluster"],
  "CLUSTER DELSLOTS": [-3, "cluster", "confirm"],
  "CLUSTER FAILOVER": [-2, "cluster", "confirm"],
  "CLUSTER FLUSHSLOTS": [1, "cluster", "confirm"],
  "CLUSTER FORGET": [2, "cluster", "confirm"],
  "CLUSTER GETKEYSINSLOT": [4, "cluster"],
  "CLUSTER INFO": [1, "cluster"],
  "CLUSTER KEYSLOT": [2, "cluster"],
  "CLUSTER LINKS": [1, "cluster"],
  "CLUSTER MEET": [-4, "cluster", "confirm"],
  "CLUSTER MYID": [1, "cluster"],
  "CLUSTER NODES": [1, "cluster"],
  "CLUSTER REPLICAS": [2, "cluster"],
  "CLUSTER REPLICATE": [2, "cluster", "confirm"],
  "CLUSTER RESET": [-2, "cluster", "confirm"],
  "CLUSTER SAVECONFIG": [1, "cluster", "confirm"],
  "CLUSTER SET-CONFIG-EPOCH": [2, "cluster", "confirm"],
  "CLUSTER SETSLOT": [-4, "cluster", "confirm"],
  "CLUSTER SHARDS": [1, "cluster"],
  "CLUSTER SLAVES": [2, "cluster"],
  "CLUSTER SLOTS": [1, "cluster"],
  READONLY: [1, "cluster"],
  READWRITE: [1, "cluster"],
};

function commandTableSafety(name: string, safety?: RedisCommandSafety): RedisCommandSafety {
  if (safety === "confirm" && WRITE_WITHOUT_CONFIRM.has(name.toUpperCase())) return "write";
  return safety ?? "allowed";
}

export const REDIS_COMMAND_TABLE: Record<string, RedisCommandSpec> = Object.fromEntries(Object.entries(RAW_COMMANDS).map(([name, [arity, group, safety]]) => [name.toUpperCase(), { arity, group, safety: commandTableSafety(name, safety) }]));

/**
 * Resolve a command spec. Handles two-token subcommands (e.g. `XGROUP CREATE`,
 * `CONFIG GET`) by trying `MAIN SUB` first, then falling back to the main token.
 */
export function resolveRedisCommandSpec(argvUpper: readonly string[]): RedisCommandSpec | undefined {
  if (argvUpper.length === 0) return undefined;
  const main = argvUpper[0];
  if (argvUpper.length >= 2) {
    const sub = `${main} ${argvUpper[1]}`;
    const subSpec = REDIS_COMMAND_TABLE[sub];
    if (subSpec) return subSpec;
  }
  return REDIS_COMMAND_TABLE[main];
}

/**
 * Minimal argv tokenizer for the first two tokens of a Redis command line —
 * enough to resolve a spec (which only needs the command head, optionally a
 * subcommand). Single-quoted, double-quoted and unquoted tokens are supported
 * with backslash escapes; quoting errors are tolerated (the token still resolves).
 * Kept local so this module stays self-contained (no dependency on the syntax
 * diagnostics tokenizer).
 */
function firstRedisArgvUpper(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n && tokens.length < 2) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const quote = line[i] === '"' || line[i] === "'" ? line[i] : "";
    let token = "";
    let escaping = false;
    if (quote) i++;
    while (i < n) {
      const ch = line[i];
      if (escaping) {
        token += ch;
        escaping = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        i++;
        continue;
      }
      if (quote && ch === quote) {
        i++;
        break;
      }
      if (!quote && /\s/.test(ch)) break;
      token += ch;
      i++;
    }
    tokens.push(token.toUpperCase());
  }
  return tokens;
}

// Commands marked `safety: "blocked"` because they are dangerous/administrative,
// but which do NOT actually change the key set of the current db — so they should
// NOT trigger key-name completion cache invalidation. (e.g. KEYS is read-only;
// SAVE/BGSAVE/SHUTDOWN/REPLICAOF/SLAVEOF are server admin.) Everything else in the
// `blocked` set (FLUSHALL, MIGRATE, EVAL[ESHA]) may mutate keys and is left in.
const NON_MUTATING_BLOCKED = new Set(["KEYS", "BGSAVE", "SAVE", "SHUTDOWN", "REPLICAOF", "SLAVEOF"]);

/**
 * True when a command may change the key set of the db it ran on (adds/edits/
 * removes/renames keys, or wipes the db), and therefore the cached key-name
 * completion for that db is potentially stale and should be dropped.
 *
 * Mapping from the diagnostic `safety` field:
 *   - `write`/`confirm` → every write command mutates keys (SET/DEL/INCR/HSET/...).
 *   - `blocked`  → mostly destructive/admin; we keep the ones that may touch keys
 *                  (FLUSHALL, MIGRATE, EVAL[ESHA]) and exclude the read-only/admin
 *                  ones in `NON_MUTATING_BLOCKED`.
 *   - `allowed`  → read-only (GET/LRANGE/SCAN/...), never invalidates.
 *
 * Commands absent from the table (unknown or read-only extensions) are treated as
 * non-mutating so we never thrash the cache on lookups.
 */
export function isRedisMutatingCommand(command: string): boolean {
  const argv = firstRedisArgvUpper(command);
  const spec = resolveRedisCommandSpec(argv);
  if (!spec) return false;
  if (spec.safety === "write" || spec.safety === "confirm") return true;
  if (spec.safety === "blocked") {
    return !NON_MUTATING_BLOCKED.has(argv[0]);
  }
  return false;
}
