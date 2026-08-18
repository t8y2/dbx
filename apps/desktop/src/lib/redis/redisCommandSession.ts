export function nextRedisCommandDb(currentDb: number, command: string, result: unknown): number {
  if (result !== "OK") return currentDb;

  const match = command.trim().match(/^SELECT\s+(\d+)\s*;?$/i);
  if (!match) return currentDb;

  const nextDb = Number.parseInt(match[1], 10);
  return Number.isFinite(nextDb) ? nextDb : currentDb;
}

export function isRedisClearScreenCommand(command: string): boolean {
  return /^(clear|cls)\s*;?$/i.test(command.trim());
}

export function redisKeyTextToRaw(key: string): string {
  const bytes = new TextEncoder().encode(key);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Returns null when a Redis key contains bytes that cannot be represented in a text input. */
export function redisKeyRawToText(keyRaw: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(keyRaw), (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function redisKeyTextToDisplay(key: string): string {
  return key.replaceAll("\\", "\\\\");
}
