import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 「选中当前语句」的快捷键设置项与右键菜单文案，必须由每种语言的源文件自己声明：
// 导入的 locale 会经 `withEnglishFallback` 深合并英文，缺 key 时仍能解析（但会显示英文），
// 因此这里直接断言源文件（合并前），避免静默回落。

function localeSource(name: string): string {
  return readFileSync(new URL(`../locales/${name}.ts`, import.meta.url), "utf8");
}

// 与 ../index.ts 的 supportedLocales 保持一致（12 种语言）
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "it", "pt-BR", "ru", "az", "tr", "id"] as const;

function declaredString(source: string, key: string): string | undefined {
  return source.match(new RegExp(String.raw`^\s*${key}:\s*"((?:[^"\\]|\\.)*)",\s*$`, "m"))?.[1];
}

describe("select current statement locale parity", () => {
  it.each(LOCALES)("%s declares the shortcut and context-menu labels", (name) => {
    const source = localeSource(name);

    expect(declaredString(source, "shortcutSelectCurrentStatement"), `${name}: settings.shortcutSelectCurrentStatement is missing`).toBeTruthy();
    expect(declaredString(source, "selectCurrentStatement"), `${name}: editor.contextMenu.selectCurrentStatement is missing`).toBeTruthy();
  });
});
