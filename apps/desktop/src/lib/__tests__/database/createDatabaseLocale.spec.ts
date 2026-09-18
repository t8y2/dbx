import { describe, expect, it } from "vitest";
import { supportsCreateDatabaseCharset, supportsCreateDatabaseLocale } from "@/lib/database/createDatabaseSql";
import { DEFAULT_GBASE8S_DATABASE_LOCALE, defaultGbase8sDatabaseLocale, GBASE8S_DATABASE_LOCALES } from "@/lib/database/createDatabaseCharsetOptions";

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

  it("seeds the default from instance locales reporting the numeric UTF-8 code set", () => {
    // Real GBase 8s instances report dbs_collate like zh_CN.57372 (57372 = UTF-8) alongside
    // en_US.819 (ISO-8859-1); after ORDER BY 1 the plain first entry cannot hold CJK.
    expect(defaultGbase8sDatabaseLocale(["en_US.819", "zh_CN.57372"])).toBe("zh_CN.57372");
    expect(defaultGbase8sDatabaseLocale(["en_US.819", "zh_CN.utf8"])).toBe("zh_CN.utf8");
  });

  it("falls back to the first locale or the static default when no UTF-8 option exists", () => {
    expect(defaultGbase8sDatabaseLocale(["en_US.819"])).toBe("en_US.819");
    expect(defaultGbase8sDatabaseLocale([])).toBe(DEFAULT_GBASE8S_DATABASE_LOCALE);
  });
});
