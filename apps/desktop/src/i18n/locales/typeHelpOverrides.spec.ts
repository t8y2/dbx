import { describe, expect, it } from "vitest";
import en from "./en";
import esMessages from "./es";
import itMessages from "./it";
import jaMessages from "./ja";
import ptBRMessages from "./pt-BR";
import zhTWMessages from "./zh-TW";

type TypeHelpLocale = { structureEditor: Record<string, Record<string, string>>; redis: Record<string, Record<string, string>> };

const english = en as unknown as TypeHelpLocale;
const es = esMessages as unknown as TypeHelpLocale;
const itLocale = itMessages as unknown as TypeHelpLocale;
const ja = jaMessages as unknown as TypeHelpLocale;
const ptBR = ptBRMessages as unknown as TypeHelpLocale;
const zhTW = zhTWMessages as unknown as TypeHelpLocale;
const locales = { es, it: itLocale, ja, "pt-BR": ptBR, "zh-TW": zhTW };
const directories = [
  ["structureEditor", "mysqlDataTypeHelp"],
  ["structureEditor", "postgresDataTypeHelp"],
  ["structureEditor", "sqliteDataTypeHelp"],
  ["redis", "createKeyTypeHelp"],
] as const;

describe("localized type help", () => {
  it("provides every English help key directly in each supported locale", () => {
    for (const [localeName, locale] of Object.entries(locales)) {
      for (const [section, directory] of directories) {
        const localized = (locale as unknown as Record<string, Record<string, Record<string, unknown>>>)[section]?.[directory] ?? {};
        for (const key of Object.keys(english[section]![directory]!)) {
          expect(localized[key], `${localeName}.${section}.${directory}.${key}`).toEqual(expect.any(String));
        }
      }
    }
  });

  it("does not silently use the English copy for representative entries", () => {
    for (const locale of Object.values(locales)) {
      expect(locale.structureEditor.mysqlDataTypeHelp.int).not.toBe(english.structureEditor.mysqlDataTypeHelp.int);
      expect(locale.structureEditor.postgresDataTypeHelp.jsonb).not.toBe(english.structureEditor.postgresDataTypeHelp.jsonb);
      expect(locale.structureEditor.sqliteDataTypeHelp.integer).not.toBe(english.structureEditor.sqliteDataTypeHelp.integer);
      expect(locale.redis.createKeyTypeHelp.string).not.toBe(english.redis.createKeyTypeHelp.string);
    }
  });

  it("keeps concrete database facts in the Spanish translations", () => {
    expect(es.structureEditor.mysqlDataTypeHelp.int).toContain("4 bytes");
    expect(es.structureEditor.mysqlDataTypeHelp.jsonMysql).toContain("max_allowed_packet");
    expect(es.structureEditor.mysqlDataTypeHelp.geometry).toContain("SRID");
    expect(es.structureEditor.postgresDataTypeHelp.jsonb).toContain("índices");
    expect(es.structureEditor.sqliteDataTypeHelp.integer).toContain("rowid");
    expect(es.redis.createKeyTypeHelp.stream).toContain("XACK");
  });

  it("keeps concrete database facts in the Italian translations", () => {
    expect(itLocale.structureEditor.mysqlDataTypeHelp.int).toContain("4 byte");
    expect(itLocale.structureEditor.mysqlDataTypeHelp.jsonMysql).toContain("max_allowed_packet");
    expect(itLocale.structureEditor.mysqlDataTypeHelp.geometry).toContain("SRID");
    expect(itLocale.structureEditor.postgresDataTypeHelp.jsonb).toContain("indici");
    expect(itLocale.structureEditor.sqliteDataTypeHelp.integer).toContain("rowid");
    expect(itLocale.redis.createKeyTypeHelp.stream).toContain("XACK");
  });

  it("keeps concrete database facts in the Japanese translations", () => {
    expect(ja.structureEditor.mysqlDataTypeHelp.int).toContain("4 バイト");
    expect(ja.structureEditor.mysqlDataTypeHelp.jsonMariaDb).toContain("LONGTEXT");
    expect(ja.structureEditor.mysqlDataTypeHelp.geometry).toContain("SRID");
    expect(ja.structureEditor.mysqlDataTypeHelp.integerDisplayWidth).toContain("非推奨");
    expect(ja.structureEditor.postgresDataTypeHelp.jsonb).toContain("重複キー");
    expect(ja.structureEditor.postgresDataTypeHelp.pgLsn).toContain("WAL");
    expect(ja.structureEditor.sqliteDataTypeHelp.integer).toContain("rowid");
    expect(ja.structureEditor.sqliteDataTypeHelp.text).toContain("CHECK");
    expect(ja.redis.createKeyTypeHelp.stream).toContain("XACK");
  });

  it("keeps concrete database facts in the Brazilian Portuguese translations", () => {
    for (const directory of [ptBR.structureEditor.mysqlDataTypeHelp, ptBR.structureEditor.postgresDataTypeHelp, ptBR.structureEditor.sqliteDataTypeHelp]) {
      expect(Object.values(directory)).not.toContain(expect.stringContaining("{type}"));
    }
    expect(ptBR.structureEditor.mysqlDataTypeHelp.int).toContain("4 bytes");
    expect(ptBR.structureEditor.mysqlDataTypeHelp.jsonMysql).toContain("max_allowed_packet");
    expect(ptBR.structureEditor.mysqlDataTypeHelp.jsonMariaDb).toContain("LONGTEXT");
    expect(ptBR.structureEditor.mysqlDataTypeHelp.geometry).toContain("SRID");
    expect(ptBR.structureEditor.mysqlDataTypeHelp.integerDisplayWidth).toContain("obsoleta");
    expect(ptBR.structureEditor.postgresDataTypeHelp.jsonb).toContain("chaves duplicadas");
    expect(ptBR.structureEditor.postgresDataTypeHelp.bytea).toContain("TOAST");
    expect(ptBR.structureEditor.postgresDataTypeHelp.pgLsn).toContain("WAL");
    expect(ptBR.structureEditor.sqliteDataTypeHelp.integer).toContain("rowid");
    expect(ptBR.structureEditor.sqliteDataTypeHelp.text).toContain("CHECK");
    expect(ptBR.redis.createKeyTypeHelp.stream).toContain("XACK");
  });

  it("keeps concrete database facts in the Traditional Chinese translations", () => {
    for (const directory of [zhTW.structureEditor.mysqlDataTypeHelp, zhTW.structureEditor.postgresDataTypeHelp, zhTW.structureEditor.sqliteDataTypeHelp]) {
      expect(Object.values(directory)).not.toContain(expect.stringContaining("{type}"));
    }
    expect(zhTW.structureEditor.mysqlDataTypeHelp.int).toContain("4 位元組");
    expect(zhTW.structureEditor.mysqlDataTypeHelp.jsonMysql).toContain("max_allowed_packet");
    expect(zhTW.structureEditor.mysqlDataTypeHelp.jsonMariaDb).toContain("LONGTEXT");
    expect(zhTW.structureEditor.mysqlDataTypeHelp.geometry).toContain("SRID");
    expect(zhTW.structureEditor.mysqlDataTypeHelp.integerDisplayWidth).toContain("淘汰");
    expect(zhTW.structureEditor.postgresDataTypeHelp.jsonb).toContain("重複鍵");
    expect(zhTW.structureEditor.postgresDataTypeHelp.bytea).toContain("TOAST");
    expect(zhTW.structureEditor.postgresDataTypeHelp.pgLsn).toContain("WAL");
    expect(zhTW.structureEditor.sqliteDataTypeHelp.integer).toContain("rowid");
    expect(zhTW.structureEditor.sqliteDataTypeHelp.text).toContain("CHECK");
    expect(zhTW.redis.createKeyTypeHelp.stream).toContain("XACK");
  });
});
