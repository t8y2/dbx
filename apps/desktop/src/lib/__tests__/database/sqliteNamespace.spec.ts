import { describe, expect, it } from "vitest";
import { isSqliteFileNamespace, normalizeSqliteNamespace, normalizeStoredConnectionDatabase } from "@/lib/database/sqliteNamespace";

describe("SQLite namespace normalization", () => {
  it("recognizes physical SQLite locations across platforms", () => {
    for (const value of ["/tmp/app.sqlite", "C:\\data\\app.db", "./relative.db3", "file:/tmp/app.sqlite", "sqlite:/tmp/app.sqlite", ":memory:"]) {
      expect(isSqliteFileNamespace(value)).toBe(true);
      expect(normalizeSqliteNamespace(value)).toBe("main");
    }
  });

  it("preserves logical attached database aliases", () => {
    expect(isSqliteFileNamespace("analytics")).toBe(false);
    expect(normalizeSqliteNamespace("analytics")).toBe("analytics");
    expect(isSqliteFileNamespace("analytics.db")).toBe(false);
    expect(normalizeSqliteNamespace("analytics.db", { database: "analytics.db" })).toBe("analytics.db");
    expect(normalizeSqliteNamespace(undefined)).toBe("main");
  });

  it("recognizes ambiguous file names only from the connection context", () => {
    expect(normalizeSqliteNamespace("primary.db", { host: "primary.db" })).toBe("main");
    expect(normalizeSqliteNamespace("legacyfile", { host: "legacyfile" })).toBe("main");
  });

  it("removes the hidden database field only for stored SQLite connections", () => {
    expect(normalizeStoredConnectionDatabase("sqlite", "/tmp/stale.sqlite")).toBeUndefined();
    expect(normalizeStoredConnectionDatabase("postgres", "app")).toBe("app");
  });
});
