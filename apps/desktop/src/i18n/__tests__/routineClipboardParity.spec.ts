import { describe, expect, it } from "vitest";
import az from "../locales/az";
import en from "../locales/en";
import es from "../locales/es";
import id from "../locales/id";
import itLocale from "../locales/it";
import ja from "../locales/ja";
import ko from "../locales/ko";
import pl from "../locales/pl";
import ptBR from "../locales/pt-BR";
import ru from "../locales/ru";
import th from "../locales/th";
import tr from "../locales/tr";
import zhCN from "../locales/zh-CN";
import zhTW from "../locales/zh-TW";

const keys = ["copyRoutine", "pasteRoutineTitle", "pasteRoutineDescription", "pasteRoutineNamePlaceholder", "pasteRoutineInvalidName", "pasteRoutineUnavailable", "pasteRoutineSuccess", "pasteRoutineRefreshFailed"] as const;
const locales = { en, az, es, id, it: itLocale, ja, ko, pl, "pt-BR": ptBR, ru, th, tr, "zh-CN": zhCN, "zh-TW": zhTW };
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("routine clipboard translations (#13903)", () => {
  it.each(Object.entries(locales))("%s supplies all labels and preserves interpolation fields", (name, locale) => {
    for (const key of keys) {
      const value = locale.contextMenu[key];
      expect(value, `${name}: contextMenu.${key}`).toBeTypeOf("string");
      expect(value.trim().length).toBeGreaterThan(0);
      expect(placeholders(value)).toEqual(placeholders(en.contextMenu[key]));
      if (name !== "en") expect(value, `${name}: contextMenu.${key} should be translated`).not.toBe(en.contextMenu[key]);
    }
  });
});
