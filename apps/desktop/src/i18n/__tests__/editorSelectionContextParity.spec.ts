import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The editor's "Send to AI" entry (#10058) resolves its chip copy through
// `ai.selectionChipLabel` / `ai.selectionChipDetail` and reports a deleted
// source connection through `ai.externalTargetUnavailable`. Imported locale
// modules are deep-merged with English by `withEnglishFallback`, so a locale
// that silently lost one of these keys would still resolve — to English text.
// Assert the locale SOURCES instead, pre-merge.

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

// Source of truth: `supportedLocales` in ../index.ts (11 entries, `ru` included).
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "it", "pt-BR", "ru", "az", "tr"] as const;

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

describe("editor selection context locale parity", () => {
  it.each(LOCALES)("%s declares the selection-context keys", (name) => {
    const source = localeSource(name);

    expect(declaredString(source, "selectionChipLabel"), `${name}: ai.selectionChipLabel is missing`).toBeTruthy();
    expect(declaredString(source, "externalTargetUnavailable"), `${name}: ai.externalTargetUnavailable is missing`).toBeTruthy();
    // Both placeholders are substituted from the chip title: dropping one renders
    // the raw `{name}`/`{count}` to the user.
    const detail = declaredString(source, "selectionChipDetail");
    expect(detail, `${name}: ai.selectionChipDetail is missing`).toBeTruthy();
    expect(detail).toContain("{name}");
    expect(detail).toContain("{count}");
  });

  it.each(LOCALES)("%s anchors the keys in the attachment cluster", (name) => {
    const source = localeSource(name);
    const truncated = source.indexOf("attachmentTruncatedStatus:");
    const selectionLabel = source.indexOf("selectionChipLabel:");

    // Anchored next to the attachment strings they belong with, so the cluster
    // stays reviewable (i18n-locales.md: cluster anchoring).
    expect(truncated).toBeGreaterThanOrEqual(0);
    expect(selectionLabel).toBeGreaterThan(truncated);
  });
});
