import type { InstalledPlugin } from "@/types/database";
import { listPluginValueCodecs, PLUGIN_VALUE_CODEC_MAX_BYTES, PLUGIN_VALUE_CODEC_TIMEOUT_MS, validatePluginCodecBytes, validatePluginCodecResult, type PluginCodecInvoker, type PluginDecodedValue, type PluginValueCodec } from "@/lib/plugins/pluginValueCodec";

/** Versioned capability kind; older hosts simply ignore it. */
export const REDIS_PLUGIN_CODEC_KIND = "redis-value-codec-v1";
export const REDIS_PLUGIN_CODEC_MAX_BYTES = PLUGIN_VALUE_CODEC_MAX_BYTES;
export const REDIS_PLUGIN_CODEC_TIMEOUT_MS = PLUGIN_VALUE_CODEC_TIMEOUT_MS;

export type RedisPluginCodec = PluginValueCodec;

export interface RedisPluginCodecContext {
  db: number;
  keyRaw: string;
  redisType: string;
}

export type RedisPluginDecodedValue = PluginDecodedValue;

export function listRedisPluginCodecs(plugins: readonly InstalledPlugin[]): RedisPluginCodec[] {
  return listPluginValueCodecs(plugins, REDIS_PLUGIN_CODEC_KIND);
}

export function validateRedisPluginBytes(rawBase64: string): void {
  validatePluginCodecBytes(rawBase64, "Redis");
}

export function validateRedisPluginResult(result: unknown): RedisPluginDecodedValue {
  return validatePluginCodecResult(result, "Redis");
}

export type RedisCodecInvoker = PluginCodecInvoker;

export async function decodeRedisPluginValue(invoke: RedisCodecInvoker, codec: RedisPluginCodec, rawBase64: string, context: RedisPluginCodecContext): Promise<RedisPluginDecodedValue> {
  validateRedisPluginBytes(rawBase64);
  return validateRedisPluginResult(await invoke(codec.pluginId, "redis/codec/decode", { codecId: codec.codecId, rawBase64, context }, REDIS_PLUGIN_CODEC_TIMEOUT_MS));
}
