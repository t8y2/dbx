import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Issue #10117: the grid duration hints and the meilisearch result summary
// switched from fixed-unit placeholders ("{ms} ms", "{us} µs", "{time} 毫秒")
// to the pre-formatted "{duration}" placeholder produced by
// formatQueryDuration/formatDurationUs. Assertions run against locale SOURCE
// text: imported modules are deep-merged with English via withEnglishFallback,
// so a dropped key would be invisible post-merge.

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

function declaredValue(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

const GRID_DURATION_KEYS = ["serverExecuteTime", "agentExecuteTime", "clientRequestWait", "resultViewUpdate"] as const;
// Locales that carry the grid duration cluster; az/tr intentionally do not and
// fall back to en.
const GRID_DURATION_LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "it", "pt-BR", "ru"] as const;
const RESULT_SUMMARY_LOCALES = [...GRID_DURATION_LOCALES, "az", "tr"];

describe("grid duration hint placeholder parity", () => {
  it.each(GRID_DURATION_LOCALES.flatMap((name) => GRID_DURATION_KEYS.map((key) => ({ name, key }))))("$name: grid.$key uses {duration}", ({ name, key }) => {
    const value = declaredValue(localeSource(name), key);
    expect(value, `${name}: grid.${key} is missing`).toBeDefined();
    expect(value, `${name}: grid.${key}`).toContain("{duration}");
    expect(value, `${name}: grid.${key}`).not.toMatch(/\{(ms|us|time)\}/);
  });

  it("az/tr keep falling back to en for the grid duration cluster", () => {
    for (const name of ["az", "tr"] as const) {
      for (const key of GRID_DURATION_KEYS) {
        expect(declaredValue(localeSource(name), key), `${name}: grid.${key} should stay undeclared`).toBeUndefined();
      }
    }
  });
});

describe("meilisearch resultSummary placeholder parity", () => {
  it.each(RESULT_SUMMARY_LOCALES)("%s: meilisearch.resultSummary uses {duration}", (name) => {
    const value = declaredValue(localeSource(name), "resultSummary");
    expect(value, `${name}: meilisearch.resultSummary is missing`).toBeDefined();
    expect(value, `${name}: meilisearch.resultSummary`).toContain("{count}");
    expect(value, `${name}: meilisearch.resultSummary`).toContain("{duration}");
    expect(value, `${name}: meilisearch.resultSummary`).not.toMatch(/\{(ms|us|time)\}/);
  });
});
