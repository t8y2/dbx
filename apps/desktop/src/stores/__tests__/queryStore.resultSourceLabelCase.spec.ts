import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalizeQueryResultSourceLabel, useQueryStore } from "@/stores/queryStore";
import type { ColumnInfo, QueryResult } from "@/types/database";

function sampleResult(sourceLabel?: string, sourceStatement?: string): QueryResult {
  return {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
    sourceLabel,
    sourceStatement,
  };
}

describe("result tab sourceLabel canonical casing (#10092)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe("canonicalizeQueryResultSourceLabel helper", () => {
    it("canonicalizes table name to tableMeta casing when SQL had uppercase", () => {
      const next = canonicalizeQueryResultSourceLabel("amis_base.ADMIN_PAGES", "SELECT * FROM ADMIN_PAGES", { tableName: "admin_pages", database: "amis_base" }, { database: "amis_base", databaseType: "mysql" });
      expect(next).toBe("amis_base.admin_pages");
    });

    it("canonicalizes table name to tableMeta casing when SQL had lowercase", () => {
      const next = canonicalizeQueryResultSourceLabel("amis_base.admin_pages", "SELECT * FROM admin_pages", { tableName: "admin_pages", database: "amis_base" }, { database: "amis_base", databaseType: "mysql" });
      expect(next).toBe("amis_base.admin_pages");
    });

    it("normalizes qualifier casing when matching tableMeta database or schema", () => {
      const next = canonicalizeQueryResultSourceLabel("AMIS_BASE.ADMIN_PAGES", "SELECT * FROM AMIS_BASE.ADMIN_PAGES", { tableName: "admin_pages", database: "amis_base" }, { database: "amis_base", databaseType: "mysql" });
      expect(next).toBe("amis_base.admin_pages");
    });

    it("supports schema qualifier in postgres / oracle dialects", () => {
      const next = canonicalizeQueryResultSourceLabel("PUBLIC.USERS", "SELECT * FROM PUBLIC.USERS", { tableName: "users", schema: "public" }, { database: "app", databaseType: "postgres" });
      expect(next).toBe("public.users");
    });

    it("handles unqualified tables", () => {
      const next = canonicalizeQueryResultSourceLabel("ADMIN_PAGES", "SELECT * FROM ADMIN_PAGES", { tableName: "admin_pages" }, { databaseType: "sqlite" });
      expect(next).toBe("admin_pages");
    });

    it("leaves preamble custom names untouched", () => {
      const next = canonicalizeQueryResultSourceLabel("MyCustomReport", "SELECT * FROM ADMIN_PAGES", { tableName: "admin_pages", database: "amis_base" }, { database: "amis_base", databaseType: "mysql" });
      expect(next).toBeUndefined();
    });

    it("keeps existing qualifier text when it does not match schema or database", () => {
      const next = canonicalizeQueryResultSourceLabel("other_qualifier.ADMIN_PAGES", "SELECT * FROM other_qualifier.ADMIN_PAGES", { tableName: "admin_pages", database: "amis_base" }, { database: "amis_base", databaseType: "mysql" });
      expect(next).toBe("other_qualifier.admin_pages");
    });
  });

  describe("applyQueryMetadataPatch in queryStore", () => {
    it("updates sourceLabel on tab.result and matching tab.results entry", () => {
      const store = useQueryStore();
      const tabId = store.createTab("conn-1", "amis_base", "Query", "query");
      const tab = store.tabs.find((t) => t.id === tabId)!;
      const result = sampleResult("amis_base.ADMIN_PAGES", "SELECT * FROM ADMIN_PAGES");
      tab.result = result;
      tab.results = [result];

      store.applyQueryMetadataPatch(
        tab,
        {
          tableMeta: {
            tableName: "admin_pages",
            database: "amis_base",
            columns: [] as ColumnInfo[],
            primaryKeys: [],
          },
        } as never,
        "mysql",
        "amis_base",
      );

      expect(tab.result.sourceLabel).toBe("amis_base.admin_pages");
      expect(tab.results[0].sourceLabel).toBe("amis_base.admin_pages");
    });

    it("updates only matching entry in multi-result tab", () => {
      const store = useQueryStore();
      const tabId = store.createTab("conn-1", "amis_base", "Query", "query");
      const tab = store.tabs.find((t) => t.id === tabId)!;
      const firstResult = sampleResult("amis_base.other_table", "SELECT * FROM other_table");
      const secondResult = sampleResult("amis_base.ADMIN_PAGES", "SELECT * FROM ADMIN_PAGES");
      tab.results = [firstResult, secondResult];
      tab.activeResultIndex = 1;
      tab.result = secondResult;

      store.applyQueryMetadataPatch(
        tab,
        {
          tableMeta: {
            tableName: "admin_pages",
            database: "amis_base",
            columns: [] as ColumnInfo[],
            primaryKeys: [],
          },
        } as never,
        "mysql",
        "amis_base",
      );

      expect(tab.result.sourceLabel).toBe("amis_base.admin_pages");
      expect(tab.results[1].sourceLabel).toBe("amis_base.admin_pages");
      expect(tab.results[0].sourceLabel).toBe("amis_base.other_table");
    });

    it("does not overwrite custom preamble sourceLabel during patch", () => {
      const store = useQueryStore();
      const tabId = store.createTab("conn-1", "amis_base", "Query", "query");
      const tab = store.tabs.find((t) => t.id === tabId)!;
      const result = sampleResult("CustomTitle", "SELECT * FROM ADMIN_PAGES");
      tab.result = result;
      tab.results = [result];

      store.applyQueryMetadataPatch(
        tab,
        {
          tableMeta: {
            tableName: "admin_pages",
            database: "amis_base",
            columns: [] as ColumnInfo[],
            primaryKeys: [],
          },
        } as never,
        "mysql",
        "amis_base",
      );

      expect(tab.result.sourceLabel).toBe("CustomTitle");
      expect(tab.results[0].sourceLabel).toBe("CustomTitle");
    });
  });
});
