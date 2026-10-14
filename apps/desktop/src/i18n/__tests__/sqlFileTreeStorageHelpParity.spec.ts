import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import id from "../locales/id";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

// SQL 文件面板顶部的小问号说明这一侧的内容来源（磁盘上的 .sql 文件），
// SQL 库一侧已有自己的说明，所有语言都必须提供译文，避免回落到英文。
const KEY = "storageHelp";

const locales: Array<[string, Record<string, unknown>]> = [
  ["en", en as Record<string, unknown>],
  ["az", az as Record<string, unknown>],
  ["es", es],
  ["id", id],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["ru", ru],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

function sqlFileTreeHelp(locale: Record<string, unknown>): unknown {
  const tree = locale.sqlFileTree;
  if (!tree || typeof tree !== "object") return undefined;
  return (tree as Record<string, unknown>)[KEY];
}

const englishHelp = sqlFileTreeHelp(en as Record<string, unknown>);

describe("SQL file panel storage help i18n messages", () => {
  it("en resolves sqlFileTree.storageHelp to text", () => {
    expect(englishHelp, "sqlFileTree.storageHelp missing from locales/en.ts").toBeTypeOf("string");
  });

  it("en explains that the panel lists real .sql files on disk", () => {
    expect(englishHelp).toContain(".sql");
    expect(englishHelp).toContain("Open Folder");
  });

  it.each(locales.slice(1))("%s translates sqlFileTree.storageHelp instead of using the English fallback", (_name, locale) => {
    const help = sqlFileTreeHelp(locale);
    expect(help, `${_name} sqlFileTree.storageHelp`).toBeTypeOf("string");
    expect(help, `${_name} sqlFileTree.storageHelp should not reuse the English text`).not.toBe(englishHelp);
  });

  it("zh-CN points at the Open Folder flow", () => {
    const help = sqlFileTreeHelp(zhCN as Record<string, unknown>) as string;
    expect(help).toContain("打开文件夹");
    expect(help).toContain(".sql");
  });
});
