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
