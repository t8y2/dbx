import type { EditorSettings } from "@/stores/settingsStore";

/**
 * Settings export/import (issue #12111).
 *
 * The settings dialog exposes a lot of preferences, and copying them by hand
 * across machines is both slow and easy to get wrong. This module owns the file
 * format: a versioned envelope so an older build can refuse a newer file
 * instead of silently dropping half of it.
 *
 * Only `editorSettings` is exported. Connections, credentials and AI provider
 * keys live in other stores and never reach this file; on top of that, any
 * property that looks like a secret is stripped defensively, because the file
 * is written to disk in plaintext.
 */
export const SETTINGS_EXPORT_SCHEMA_VERSION = 1;

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|secret|password|passwd|token|credential)/i;

export interface SettingsExportDocument {
  schemaVersion: number;
  exportedAt: string;
  editorSettings: Partial<EditorSettings>;
}

export type SettingsExportErrorCode = "empty" | "invalidJson" | "notAnObject" | "missingSchemaVersion" | "unsupportedSchemaVersion" | "missingEditorSettings";

export type ParseSettingsExportResult = { ok: true; settings: Partial<EditorSettings> } | { ok: false; code: SettingsExportErrorCode; schemaVersion?: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop every property whose name looks like a credential, at any depth. */
export function stripSensitiveSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveSettings);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    out[key] = stripSensitiveSettings(entry);
  }
  return out;
}

export function serializeSettingsExport(options: { editorSettings: Partial<EditorSettings>; exportedAt?: Date }): string {
  const exportedAt = options.exportedAt ?? new Date();
  const document: SettingsExportDocument = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAt.toISOString(),
    // Round-trip through JSON so Vue proxies and `undefined` values never leak
    // into the file.
    editorSettings: stripSensitiveSettings(JSON.parse(JSON.stringify(options.editorSettings))) as Partial<EditorSettings>,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `dbx-settings-2026-10-20T04-12-33-000Z.json` — no colons, so Windows accepts it. */
export function settingsExportFileName(exportedAt: Date = new Date()): string {
  return `dbx-settings-${exportedAt.toISOString().replace(/:/g, "-")}.json`;
}

export function parseSettingsExport(text: string): ParseSettingsExportResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: "invalidJson" };
  }
  if (!isPlainObject(parsed)) return { ok: false, code: "notAnObject" };
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) return { ok: false, code: "missingSchemaVersion" };
  if (schemaVersion > SETTINGS_EXPORT_SCHEMA_VERSION) return { ok: false, code: "unsupportedSchemaVersion", schemaVersion };
  if (!isPlainObject(parsed.editorSettings)) return { ok: false, code: "missingEditorSettings" };
  return { ok: true, settings: parsed.editorSettings as Partial<EditorSettings> };
}
