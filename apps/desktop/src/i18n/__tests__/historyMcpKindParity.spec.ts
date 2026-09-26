import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Non-SQL MCP history entries persist activity_kind "mcp" and the details
// dialog resolves the label through `history.kinds.${kind}`. Assert every
// locale that carries the history kinds cluster declares the mcp entry:
// imported modules are deep-merged with English via withEnglishFallback, so a
// dropped key would be invisible post-merge.

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

function historyKindsCluster(source: string): string | undefined {
  return (source.match(/kinds: \{[^}]*\}/g) ?? []).find((cluster) => cluster.includes("redis_command:"));
}

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "it", "pt-BR", "ru", "az", "tr"] as const;

describe("history kinds mcp label parity", () => {
  it.each(LOCALES)("%s: history.kinds declares mcp", (name) => {
    const cluster = historyKindsCluster(localeSource(name));
    expect(cluster, `${name}: history kinds cluster not found`).toBeDefined();
    expect(cluster, `${name}: history.kinds.mcp is missing`).toMatch(/(^|[^A-Za-z_])mcp:\s*"/);
  });
});
