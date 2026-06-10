export type RedisCommandSafety = "allowed" | "confirm" | "blocked";

const BLOCKED_COMMANDS = new Set(["KEYS", "FLUSHALL", "SHUTDOWN", "CONFIG", "SAVE", "BGSAVE", "SLAVEOF", "REPLICAOF", "MIGRATE", "MODULE", "SCRIPT", "EVAL", "EVALSHA"]);

const CONFIRM_COMMANDS = new Set([
  "DEL",
  "UNLINK",
  "EXPIRE",
  "EXPIREAT",
  "PEXPIRE",
  "PEXPIREAT",
  "PERSIST",
  "RENAME",
  "RENAMENX",
  "SET",
  "SETEX",
  "PSETEX",
  "SETNX",
  "MSET",
  "MSETNX",
  "HSET",
  "HDEL",
  "LPUSH",
  "RPUSH",
  "LPOP",
  "RPOP",
  "LSET",
  "LREM",
  "SADD",
  "SREM",
  "ZADD",
  "ZREM",
  "XADD",
  "XDEL",
  "FLUSHDB",
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
  return "allowed";
}
