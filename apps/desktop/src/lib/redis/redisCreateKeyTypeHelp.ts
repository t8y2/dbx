export const REDIS_CREATE_KEY_TYPE_VALUES = ["string", "hash", "list", "set", "zset", "stream", "json"] as const;

export type RedisCreateKeyTypeValue = (typeof REDIS_CREATE_KEY_TYPE_VALUES)[number];
export type RedisCreateKeyTypeHelpKey = RedisCreateKeyTypeValue;

export interface RedisCreateKeyTypeHelp {
  key: RedisCreateKeyTypeHelpKey;
}

export interface RedisCreateKeyTypeHelpFocusState {
  openedByArrow: boolean;
  keyboardNavigating: boolean;
}

const REDIS_CREATE_KEY_TYPE_HELP: Readonly<Record<RedisCreateKeyTypeValue, RedisCreateKeyTypeHelpKey>> = {
  string: "string",
  hash: "hash",
  list: "list",
  set: "set",
  zset: "zset",
  stream: "stream",
  json: "json",
};

/** Returns help for a Redis data type offered by the Create key dialog. */
export function getRedisCreateKeyTypeHelp(rawType: string): RedisCreateKeyTypeHelp | undefined {
  const type = rawType.trim().toLowerCase() as RedisCreateKeyTypeValue;
  const key = REDIS_CREATE_KEY_TYPE_HELP[type];
  return key ? { key } : undefined;
}

/** Returns the selected offered type whose help is shown when the Select opens. */
export function redisCreateKeyTypeHelpOptionOnOpen(rawType: string): RedisCreateKeyTypeValue | undefined {
  const type = rawType.trim().toLowerCase() as RedisCreateKeyTypeValue;
  return REDIS_CREATE_KEY_TYPE_HELP[type] ? type : undefined;
}

/** Determines whether a SelectItem focus event was caused by Arrow navigation. */
export function shouldActivateRedisCreateKeyTypeHelpOnFocus(state: RedisCreateKeyTypeHelpFocusState): boolean {
  return state.openedByArrow || state.keyboardNavigating;
}
