import type { InstalledPlugin } from "@/types/database";

/**
 * Shared host side of plugin value codecs (Redis values, SQL result cells).
 * Each surface declares its own versioned capability kind and sidecar method;
 * the limits and the response contract are identical.
 */
export const PLUGIN_VALUE_CODEC_MAX_BYTES = 2 * 1024 * 1024;
export const PLUGIN_VALUE_CODEC_TIMEOUT_MS = 10_000;

export interface PluginValueCodec {
  key: string;
  pluginId: string;
  codecId: string;
  label: string;
}

export interface PluginDecodedValue {
  format: "json" | "text";
  value: unknown;
}

export type PluginCodecInvoker = (pluginId: string, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

export function listPluginValueCodecs(plugins: readonly InstalledPlugin[], kind: string): PluginValueCodec[] {
  return plugins
    .filter((plugin) => plugin.compatibility.compatible && plugin.manifest.entrypoints?.backend)
    .flatMap((plugin) =>
      (plugin.manifest.capabilities ?? [])
        .filter((capability) => capability.kind === kind)
        .map((capability) => ({
          key: JSON.stringify([plugin.manifest.id, capability.id]),
          pluginId: plugin.manifest.id,
          codecId: capability.id,
          label: `${plugin.manifest.name} · ${capability.label}`,
        })),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** `surface` only names the codec in error messages, e.g. "Redis" or "SQL". */
export function validatePluginCodecBytes(rawBase64: string, surface: string): void {
  if (rawBase64.length > Math.ceil(PLUGIN_VALUE_CODEC_MAX_BYTES / 3) * 4) throw new Error(`${surface} codec input exceeds 2 MiB`);
  const bytes = atob(rawBase64);
  if (bytes.length > PLUGIN_VALUE_CODEC_MAX_BYTES || btoa(bytes) !== rawBase64) throw new Error(`Invalid or oversized ${surface} codec input`);
}

export function validatePluginCodecResult(result: unknown, surface: string): PluginDecodedValue {
  if (!result || typeof result !== "object") throw new Error(`Invalid ${surface} codec response`);
  const response = result as Partial<PluginDecodedValue>;
  if (response.format !== "json" && response.format !== "text") throw new Error(`${surface} codec must return json or text`);
  if (response.format === "text" && typeof response.value !== "string") throw new Error(`${surface} text codec must return a string`);
  const serialized = JSON.stringify(response.value);
  if (serialized === undefined || new TextEncoder().encode(serialized).length > PLUGIN_VALUE_CODEC_MAX_BYTES) throw new Error(`Invalid or oversized ${surface} codec result`);
  return { format: response.format, value: response.value };
}
