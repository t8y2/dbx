import type { InstalledPlugin } from "@/types/database";

/** Versioned capability kind; older hosts simply ignore it. */
export const REDIS_PLUGIN_CODEC_KIND = "redis-value-codec-v1";
export const REDIS_PLUGIN_CODEC_MAX_BYTES = 2 * 1024 * 1024;
export const REDIS_PLUGIN_CODEC_TIMEOUT_MS = 10_000;

export interface RedisPluginCodec {
  key: string;
  pluginId: string;
  codecId: string;
  label: string;
}

export interface RedisPluginCodecContext {
  db: number;
  keyRaw: string;
  redisType: string;
}

export interface RedisPluginDecodedValue {
  format: "json" | "text";
  value: unknown;
}

export function listRedisPluginCodecs(plugins: readonly InstalledPlugin[]): RedisPluginCodec[] {
  return plugins
    .filter((plugin) => plugin.compatibility.compatible && plugin.manifest.entrypoints?.backend)
    .flatMap((plugin) =>
      (plugin.manifest.capabilities ?? [])
        .filter((capability) => capability.kind === REDIS_PLUGIN_CODEC_KIND)
        .map((capability) => ({
          key: JSON.stringify([plugin.manifest.id, capability.id]),
          pluginId: plugin.manifest.id,
          codecId: capability.id,
          label: `${plugin.manifest.name} · ${capability.label}`,
        })),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function validateRedisPluginBytes(rawBase64: string): void {
  if (rawBase64.length > Math.ceil(REDIS_PLUGIN_CODEC_MAX_BYTES / 3) * 4) throw new Error("Redis codec input exceeds 2 MiB");
  const bytes = atob(rawBase64);
  if (bytes.length > REDIS_PLUGIN_CODEC_MAX_BYTES || btoa(bytes) !== rawBase64) throw new Error("Invalid or oversized Redis codec input");
}

export function validateRedisPluginResult(result: unknown): RedisPluginDecodedValue {
  if (!result || typeof result !== "object") throw new Error("Invalid Redis codec response");
  const response = result as Partial<RedisPluginDecodedValue>;
  if (response.format !== "json" && response.format !== "text") throw new Error("Redis codec must return json or text");
  if (response.format === "text" && typeof response.value !== "string") throw new Error("Redis text codec must return a string");
  const serialized = JSON.stringify(response.value);
  if (serialized === undefined || new TextEncoder().encode(serialized).length > REDIS_PLUGIN_CODEC_MAX_BYTES) throw new Error("Invalid or oversized Redis codec result");
  return { format: response.format, value: response.value };
}

export type RedisCodecInvoker = (pluginId: string, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

export async function decodeRedisPluginValue(invoke: RedisCodecInvoker, codec: RedisPluginCodec, rawBase64: string, context: RedisPluginCodecContext): Promise<RedisPluginDecodedValue> {
  validateRedisPluginBytes(rawBase64);
  return validateRedisPluginResult(await invoke(codec.pluginId, "redis/codec/decode", { codecId: codec.codecId, rawBase64, context }, REDIS_PLUGIN_CODEC_TIMEOUT_MS));
}
