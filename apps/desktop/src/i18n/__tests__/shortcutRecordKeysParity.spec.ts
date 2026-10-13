import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #11787 的快捷键录入按钮与录入态提示，必须由每种语言的源文件自己声明：导入的 locale
// 会经 `withEnglishFallback` 深合并英文，缺 key 时仍能解析（但会显示英文），因此这里
// 直接断言源文件（合并前），避免静默回落。

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

// 与 ../index.ts 的 supportedLocales 保持一致（12 种语言）
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "it", "pt-BR", "ru", "az", "tr", "id"] as const;

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

describe("shortcut record-keys locale parity", () => {
  it.each(LOCALES)("%s declares the recorder button and recording hint", (name) => {
    const source = localeSource(name);

    expect(declaredString(source, "shortcutRecordKeys"), `${name}: settings.shortcutRecordKeys is missing`).toBeTruthy();
    expect(declaredString(source, "shortcutRecordKeysRecordingHint"), `${name}: settings.shortcutRecordKeysRecordingHint is missing`).toBeTruthy();
    expect(declaredString(source, "shortcutRecordKeysWindowInactive"), `${name}: settings.shortcutRecordKeysWindowInactive is missing`).toBeTruthy();
  });
});
