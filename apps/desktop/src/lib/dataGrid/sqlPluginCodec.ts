import type { DatabaseType, InstalledPlugin } from "@/types/database";
import { isBinaryCellColumnType, parseBinaryCellBytes } from "@/lib/dataGrid/binaryCellDownload";
import { listPluginValueCodecs, PLUGIN_VALUE_CODEC_MAX_BYTES, PLUGIN_VALUE_CODEC_TIMEOUT_MS, validatePluginCodecBytes, validatePluginCodecResult, type PluginCodecInvoker, type PluginDecodedValue, type PluginValueCodec } from "@/lib/plugins/pluginValueCodec";

/** Versioned capability kind for SQL result cells; older hosts simply ignore it. */
export const SQL_PLUGIN_CODEC_KIND = "sql-value-codec-v1";
export const SQL_PLUGIN_CODEC_METHOD = "sql/codec/decode";

/** Column facts only: no row values, credentials or connection configuration. */
export interface SqlPluginCodecContext {
  dbType?: DatabaseType;
  columnName?: string;
  columnType?: string;
}

/** A context-menu request to open one cell's transform panel on plugin decoding. */
export interface PluginDecodeRequest {
  id: number;
  /** `${rowId}:${colIndex}`, the transform panel identity in the cell detail dialog. */
  identity: string;
}

export type SqlPluginCodecInput = { ok: true; rawBase64: string } | { ok: false; reason: "nullValue" | "incomplete" | "tooLarge" | "undecodableBinary" };

export function listSqlPluginCodecs(plugins: readonly InstalledPlugin[]): PluginValueCodec[] {
  return listPluginValueCodecs(plugins, SQL_PLUGIN_CODEC_KIND);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/**
 * Turns the cell into the bytes a codec receives: binary columns pass their
 * original bytes, every other value its UTF-8 text. Truncated previews never
 * reach a plugin, because a codec cannot tell a cut-off payload from a corrupt one.
 */
export function sqlPluginCodecInput(source: string | null, options: { columnType?: string; databaseType?: DatabaseType; incomplete?: boolean } = {}): SqlPluginCodecInput {
  if (source === null) return { ok: false, reason: "nullValue" };
  if (options.incomplete) return { ok: false, reason: "incomplete" };
  let bytes: Uint8Array;
  if (isBinaryCellColumnType(options.columnType)) {
    const parsed = parseBinaryCellBytes(source, options.columnType, options.databaseType);
    if (!parsed) return { ok: false, reason: "undecodableBinary" };
    bytes = parsed;
  } else {
    bytes = new TextEncoder().encode(source);
  }
  if (bytes.length > PLUGIN_VALUE_CODEC_MAX_BYTES) return { ok: false, reason: "tooLarge" };
  return { ok: true, rawBase64: bytesToBase64(bytes) };
}

export async function decodeSqlPluginValue(invoke: PluginCodecInvoker, codec: PluginValueCodec, rawBase64: string, context: SqlPluginCodecContext): Promise<PluginDecodedValue> {
  validatePluginCodecBytes(rawBase64, "SQL");
  return validatePluginCodecResult(await invoke(codec.pluginId, SQL_PLUGIN_CODEC_METHOD, { codecId: codec.codecId, rawBase64, context }, PLUGIN_VALUE_CODEC_TIMEOUT_MS), "SQL");
}

/** Text shown in the transform panel; JSON results are pretty-printed, never rendered as HTML. */
export function sqlPluginDecodedText(decoded: PluginDecodedValue): string {
  return decoded.format === "text" ? String(decoded.value) : JSON.stringify(decoded.value, null, 2);
}
