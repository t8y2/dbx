import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import it_ from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import ptBR from "../locales/pt-BR";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const locales: Array<[string, Record<string, unknown>]> = [
  ["az", az],
  ["en", en],
  ["es", es],
  ["it", it_],
  ["ja", ja],
  ["ko", ko],
  ["pt-BR", ptBR],
  ["tr", tr],
  ["zh-CN", zhCN],
  ["zh-TW", zhTW],
];

const BATCH_TERMINATE_KEYS = ["batchTerminate", "batchTerminateTitle", "batchTerminateConfirm", "batchTerminateRunning", "batchTerminateSummary"];

describe("process list batch terminate locale parity", () => {
  it.each(locales)("%s ships every batch terminate key", (_name, locale) => {
    const processList = (locale as { processList: Record<string, unknown> }).processList;
    for (const key of BATCH_TERMINATE_KEYS) {
      expect(typeof processList[key]).toBe("string");
      expect(String(processList[key]).trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the count and summary placeholders in every locale", () => {
    for (const [_name, locale] of locales) {
      const processList = (locale as { processList: Record<string, string> }).processList;
      expect(processList.batchTerminate).toContain("{count}");
      expect(processList.batchTerminateConfirm).toContain("{count}");
      expect(processList.batchTerminateSummary).toContain("{succeeded}");
      expect(processList.batchTerminateSummary).toContain("{failed}");
    }
  });
});
