export type RedisCommandSafety = "allowed" | "write" | "confirm" | "blocked";

const BLOCKED_COMMANDS = new Set(["KEYS", "FLUSHALL", "SHUTDOWN", "CONFIG", "SAVE", "BGSAVE", "SLAVEOF", "REPLICAOF", "MIGRATE", "MODULE", "SCRIPT", "EVAL", "EVALSHA"]);

const CONFIRM_COMMANDS = new Set([
  "DEL",
  "UNLINK",
  "EXPIRE",
  "EXPIREAT",
  "PEXPIRE",
  "PEXPIREAT",
  "RENAME",
  "RENAMENX",
  "GETDEL",
  "HDEL",
  "LPOP",
  "RPOP",
  "LREM",
  "LTRIM",
  "SPOP",
  "SREM",
  "ZREM",
  "ZPOPMAX",
  "ZPOPMIN",
  "ZMPOP",
  "ZREMRANGEBYLEX",
  "ZREMRANGEBYRANK",
  "ZREMRANGEBYSCORE",
  "XDEL",
  "XTRIM",
  "MOVE",
  "SORT",
  "SDIFFSTORE",
  "SINTERSTORE",
  "SUNIONSTORE",
  "ZDIFFSTORE",
  "ZINTERSTORE",
  "ZRANGESTORE",
  "ZUNIONSTORE",
  "PFMERGE",
  "GEOSEARCHSTORE",
  "FLUSHDB",
]);

const WRITE_COMMANDS = new Set([
  "APPEND",
  "BITFIELD",
  "BITOP",
  "COPY",
  "DECR",
  "DECRBY",
  "GEOADD",
  "GEORADIUS",
  "GEORADIUSBYMEMBER",
  "GETSET",
  "INCR",
  "INCRBY",
  "INCRBYFLOAT",
  "SET",
  "SETEX",
  "PSETEX",
  "SETNX",
  "SETRANGE",
  "MSET",
  "MSETNX",
  "PERSIST",
  "HSET",
  "HMSET",
  "HINCRBY",
  "HINCRBYFLOAT",
  "HSETNX",
  "LINSERT",
  "LSET",
  "LMOVE",
  "LPUSH",
  "LPUSHX",
  "PFADD",
  "RPUSH",
  "RPUSHX",
  "RESTORE",
  "SADD",
  "ZADD",
  "ZINCRBY",
  "SETBIT",
  "XADD",
  "XACK",
  "XAUTOCLAIM",
  "XCLAIM",
  "XSETID",
]);

const READ_COMMANDS = new Set([
  "GET",
  "MGET",
  "GETRANGE",
  "STRLEN",
  "GETBIT",
  "BITCOUNT",
  "BITPOS",
  "HGET",
  "HGETALL",
  "HMGET",
  "HEXISTS",
  "HLEN",
  "HKEYS",
  "HVALS",
  "HSTRLEN",
  "HRANDFIELD",
  "LRANGE",
  "LINDEX",
  "LLEN",
  "LPOS",
  "SMEMBERS",
  "SISMEMBER",
  "SMISMEMBER",
  "SCARD",
  "SDIFF",
  "SINTER",
  "SUNION",
  "SRANDMEMBER",
  "ZRANGE",
  "ZREVRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGEBYSCORE",
  "ZRANGEBYLEX",
  "ZREVRANGEBYLEX",
  "ZRANK",
  "ZREVRANK",
  "ZSCORE",
  "ZMSCORE",
  "ZCARD",
  "ZCOUNT",
  "ZLEXCOUNT",
  "ZRANDMEMBER",
  "ZDIFF",
  "ZINTER",
  "ZUNION",
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "XPENDING",
  "XINFO",
  "XREAD",
  "TYPE",
  "TTL",
  "PTTL",
  "EXPIRETIME",
  "PEXPIRETIME",
  "EXISTS",
  "SCAN",
  "SSCAN",
  "HSCAN",
  "ZSCAN",
  "DBSIZE",
  "SELECT",
  "INFO",
  "PING",
  "ECHO",
  "TIME",
  "KEYS",
  "RANDOMKEY",
  "DUMP",
  "OBJECT",
  "MEMORY",
  "GEOHASH",
  "GEOPOS",
  "GEODIST",
  "GEOSEARCH",
  "GEORADIUS_RO",
  "GEORADIUSBYMEMBER_RO",
  "PFCOUNT",
  "PUBSUB",
  "COMMAND",
  "JSON.GET",
  "JSON.TYPE",
  "JSON.OBJKEYS",
  "JSON.OBJLEN",
  "JSON.ARRLEN",
  "FT.SEARCH",
  "FT.AGGREGATE",
  "FT.INFO",
  "FT._LIST",
  "TS.GET",
  "TS.RANGE",
  "TS.REVRANGE",
  "TS.MGET",
  "TS.MRANGE",
  "TS.MREVRANGE",
  "TS.INFO",
  "TS.QUERYINDEX",
]);

export function firstRedisCommandToken(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed) return "";

  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : "";
  let token = "";
  let escaping = false;
  for (let i = quote ? 1 : 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote && ch === quote) break;
    if (!quote && /\s/.test(ch)) break;
    token += ch;
  }
  return token.toUpperCase();
}

export function classifyRedisCommandSafety(command: string): RedisCommandSafety {
  const token = firstRedisCommandToken(command);
  if (BLOCKED_COMMANDS.has(token)) return "blocked";
  if (CONFIRM_COMMANDS.has(token)) return "confirm";
  if (WRITE_COMMANDS.has(token)) return "write";
  return "allowed";
}

/** Unknown/module commands fail closed because DBX cannot prove they are read-only. */
export function redisCommandIsMutation(command: string): boolean {
  const token = firstRedisCommandToken(command);
  return !token || !READ_COMMANDS.has(token);
}

/** Resolves logical databases affected by Redis cross-database commands. */
export function redisCommandDatabaseTargets(command: string, selectedDatabase: string | number): { databases: string[]; allDatabases: boolean } {
  const argv = redisCommandArgv(command);
  const databases = new Set([String(selectedDatabase)]);
  const token = argv[0]?.toUpperCase() ?? "";
  if (token === "MOVE") addRedisDatabase(databases, argv[2]);
  if (token === "COPY") {
    const index = argv.findIndex((value) => value.toUpperCase() === "DB");
    addRedisDatabase(databases, argv[index + 1]);
  }
  if (token === "SWAPDB") {
    addRedisDatabase(databases, argv[1]);
    addRedisDatabase(databases, argv[2]);
  }
  return { databases: [...databases], allDatabases: token === "FLUSHALL" };
}

function addRedisDatabase(databases: Set<string>, value: string | undefined) {
  if (value !== undefined && /^\d+$/.test(value)) databases.add(String(Number(value)));
}

function redisCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of command.trim().replace(/;+$/, "")) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        argv.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) argv.push(current);
  return argv;
}
