import { readFileSync } from "node:fs";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import en from "../locales/en";
import es from "../locales/es";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import th from "../locales/th";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales = [
  ["en", en, "Compile all"],
  ["es", es, "Compilar todos"],
  ["it", itLocale, "Compila tutto"],
  ["ja", ja, "すべてコンパイル"],
  ["ko", ko, "모두 컴파일"],
  ["pt-BR", ptBR, "Compilar tudo"],
  ["ru", ru, "Компилировать все"],
  ["th", th, "คอมไพล์ทั้งหมด"],
  ["zh-CN", zhCN, "编译全部"],
  ["zh-TW", zhTW, "全部編譯"],
] as const;

const componentSource = readFileSync(new URL("../../components/objects/OracleInvalidObjectsDialog.vue", import.meta.url), "utf8");
const literalKeys = [...componentSource.matchAll(/t\(["'](processList\.oracleInvalidObjects\.[A-Za-z]+)["']/g)].map((match) => match[1]!);
const batchStatuses = ["pending", "running", "unsupported", "valid", "still-invalid", "already-valid", "target-changed", "deleted", "failed", "unknown", "not-run"];

describe("invalid object dialog locale messages", () => {
  it.each(locales)("resolves all dialog messages in %s", (locale, messages, expectedCompileAll) => {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } });
    const rawMessages = messages as { processList: { oracleInvalidObjects: Record<string, string> } };

    for (const key of literalKeys) {
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key);
    }
    for (const status of batchStatuses) {
      const key = `processList.oracleInvalidObjects.batchStatus.${status}`;
      expect(i18n.global.t(key), `${locale}: ${key}`).not.toBe(key);
    }
    expect(i18n.global.t("processList.oracleInvalidObjects.compileAll")).toBe(expectedCompileAll);
    const message = (key: string, values?: Record<string, number>) => i18n.global.t(`processList.oracleInvalidObjects.${key}`, values);
    const expectedPlaceholders: Record<string, string[]> = {
      selectedTypeCount: ["{count}"],
      filterCount: ["{matched}", "{total}"],
      batchCompileFiltered: ["{count}"],
    };
    for (const key of ["nameFilterLabel", "filterName", "filterTypes", "allTypes", "selectedTypeCount", "clearFilters", "filterCount", "currentlyLoaded", "batchSelectFiltered", "batchCompileFiltered", "compileFiltered", "noFilterMatches"]) {
      expect(message(key), `${locale}: ${key}`).not.toBe(`processList.oracleInvalidObjects.${key}`);
      const actualPlaceholders = [...rawMessages.processList.oracleInvalidObjects[key]!.matchAll(/\{[^{}]+\}/g)].map(([placeholder]) => placeholder).sort();
      expect(actualPlaceholders, `${locale}: ${key} placeholders`).toEqual((expectedPlaceholders[key] ?? []).sort());
    }
    expect(message("filterCount", { matched: 3, total: 5 })).toContain("3");
    expect(message("filterCount", { matched: 3, total: 5 })).toContain("5");
    expect(message("selectedTypeCount", { count: 2 })).toContain("2");
    expect(message("batchCompileFiltered", { count: 2 })).toContain("2");
    expect(message("noFilterMatches")).not.toBe("");
  });
});
