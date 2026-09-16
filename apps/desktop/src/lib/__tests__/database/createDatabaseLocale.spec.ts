import { describe, expect, it } from "vitest";
import { supportsCreateDatabaseCharset, supportsCreateDatabaseLocale } from "@/lib/database/createDatabaseSql";
import { DEFAULT_GBASE8S_DATABASE_LOCALE, GBASE8S_DATABASE_LOCALES } from "@/lib/database/createDatabaseCharsetOptions";

describe("GBase 8s / Informix create-database locale support", () => {
  it("offers a locale picker only for the gbase8s profile", () => {
    expect(supportsCreateDatabaseLocale("gbase", "gbase8s")).toBe(true);
    // Plain Informix's agent has no directive handling, so the locale picker must stay hidden
    // there until InformixAgent implements it; showing it would silently ignore the choice.
    expect(supportsCreateDatabaseLocale("informix", undefined)).toBe(false);
  });

  it("does not treat GBase 8a or MySQL as locale-picking", () => {
    expect(supportsCreateDatabaseLocale("gbase", "gbase8a")).toBe(false);
    expect(supportsCreateDatabaseLocale("mysql", "mysql")).toBe(false);
    // The MySQL charset path stays independent of the Informix locale path.
    expect(supportsCreateDatabaseCharset("mysql", "mysql")).toBe(true);
    expect(supportsCreateDatabaseCharset("gbase", "gbase8s")).toBe(false);
  });

  it("defaults to a Chinese-capable UTF-8 locale", () => {
    expect(GBASE8S_DATABASE_LOCALES).toContain("zh_CN.utf8");
    expect(DEFAULT_GBASE8S_DATABASE_LOCALE).toBe("zh_CN.utf8");
  });
});
