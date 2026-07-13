import type { SqlSafetyOptions } from "./sql-safety.js";

export type RedisCommandSafety = "allowed" | "write" | "confirm" | "blocked";

export interface RedisCommandResult {
  command: string;
  safety: RedisCommandSafety;
  value: unknown;
}

export interface RedisCommandOptions {
  skipSafetyCheck?: boolean;
  timeoutMs?: number;
}

export interface RedisCommandSafetyDecision {
  allowed: boolean;
  command?: string;
  safety?: RedisCommandSafety;
  reason?: string;
  skipSafetyCheck?: boolean;
}

const BLOCKED_REDIS_COMMANDS = new Set(["KEYS", "FLUSHALL", "SHUTDOWN", "CONFIG", "SAVE", "BGSAVE", "SLAVEOF", "REPLICAOF", "MIGRATE", "MODULE", "SCRIPT", "EVAL", "EVALSHA"]);

const CONFIRM_REDIS_COMMANDS = new Set([
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

const WRITE_REDIS_COMMANDS = new Set([
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

const READ_REDIS_COMMANDS = new Set([
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

export function firstRedisCommandToken(commandText: string): string | undefined {
  try {
    return parseRedisCommandArgv(commandText)[0]?.toUpperCase();
  } catch {
    const token = commandText.trim().match(/^\S+/)?.[0]?.toUpperCase();
    return token || undefined;
  }
}

export function classifyRedisCommand(commandText: string): RedisCommandSafety {
  const command = firstRedisCommandToken(commandText);
  if (!command) return "blocked";
  if (BLOCKED_REDIS_COMMANDS.has(command)) return "blocked";
  if (CONFIRM_REDIS_COMMANDS.has(command)) return "confirm";
  if (WRITE_REDIS_COMMANDS.has(command)) return "write";
  return "allowed";
}

/** Unknown/module commands fail closed because MCP cannot prove they are read-only. */
export function redisCommandIsMutation(commandText: string): boolean {
  const command = firstRedisCommandToken(commandText);
  return !command || !READ_REDIS_COMMANDS.has(command);
}

/** Resolves logical databases affected by Redis cross-database commands. */
export function redisCommandDatabaseTargets(commandText: string, selectedDatabase: number, markedDatabases: string[] = []): string[] {
  let argv: string[];
  try {
    argv = parseRedisCommandArgv(commandText);
  } catch {
    return [String(selectedDatabase)];
  }
  const databases = new Set([String(selectedDatabase)]);
  const command = argv[0]?.toUpperCase() ?? "";
  if (command === "MOVE") addRedisDatabase(databases, argv[2]);
  if (command === "COPY") {
    const index = argv.findIndex((value) => value.toUpperCase() === "DB");
    addRedisDatabase(databases, argv[index + 1]);
  }
  if (command === "SWAPDB") {
    addRedisDatabase(databases, argv[1]);
    addRedisDatabase(databases, argv[2]);
  }
  if (command === "FLUSHALL") markedDatabases.forEach((database) => databases.add(database));
  return [...databases];
}

function addRedisDatabase(databases: Set<string>, value: string | undefined) {
  if (value !== undefined && /^\d+$/.test(value)) databases.add(String(Number(value)));
}

export function evaluateRedisCommandSafety(commandText: string, options: SqlSafetyOptions = {}): RedisCommandSafetyDecision {
  const command = firstRedisCommandToken(commandText);
  if (!command) {
    return { allowed: false, reason: "Redis command is empty." };
  }

  const safety = classifyRedisCommand(command);
  if (safety === "blocked" && !options.allowDangerous) {
    return {
      allowed: false,
      command,
      safety,
      reason: `Dangerous Redis command "${command}" is blocked. Set DBX_MCP_ALLOW_DANGEROUS_SQL=1 to allow it.`,
    };
  }

  if (safety !== "allowed" && !options.allowWrites) {
    return {
      allowed: false,
      command,
      safety,
      reason: "MCP Redis command execution is read-only for this session. Set DBX_MCP_ALLOW_WRITES=1 to allow write or dangerous commands.",
    };
  }

  return {
    allowed: true,
    command,
    safety,
    skipSafetyCheck: safety === "blocked" && options.allowDangerous === true,
  };
}

export function parseRedisCommandArgv(commandText: string): string[] {
  const trimmed = commandText.trimEnd().replace(/;+$/, "");
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const ch of trimmed) {
    if (escaping) {
      if (ch === "n") current += "\n";
      else if (ch === "r") current += "\r";
      else if (ch === "t") current += "\t";
      else current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Redis command has an unterminated quote");
  if (current) argv.push(current);
  if (argv.length === 0) throw new Error("Redis command is empty");
  return argv;
}
