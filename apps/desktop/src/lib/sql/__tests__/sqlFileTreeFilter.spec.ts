import { describe, expect, it } from "vitest";
import type { SqlFileEntry } from "@/lib/backend/api";
import { compareSqlFileEntries, filterAndSortSqlFileEntries, recursivelySortSqlFileEntries } from "../sqlFileTreeFilter";

describe("sqlFileTreeFilter", () => {
  const sampleEntries: SqlFileEntry[] = [
    {
      name: "queries",
      path: "/sql/queries",
      is_dir: true,
      children: [
        { name: "select_user.sql", path: "/sql/queries/select_user.sql", is_dir: false, children: [] },
        { name: "get_orders.sql", path: "/sql/queries/get_orders.sql", is_dir: false, children: [] },
        { name: "file10.sql", path: "/sql/queries/file10.sql", is_dir: false, children: [] },
        { name: "file2.sql", path: "/sql/queries/file2.sql", is_dir: false, children: [] },
      ],
    },
    {
      name: "migrations",
      path: "/sql/migrations",
      is_dir: true,
      children: [
        {
          name: "2024",
          path: "/sql/migrations/2024",
          is_dir: true,
          children: [{ name: "01_init.sql", path: "/sql/migrations/2024/01_init.sql", is_dir: false, children: [] }],
        },
        {
          name: "2025",
          path: "/sql/migrations/2025",
          is_dir: true,
          children: [{ name: "02_add_user_roles.sql", path: "/sql/migrations/2025/02_add_user_roles.sql", is_dir: false, children: [] }],
        },
      ],
    },
    { name: "root_zebra.sql", path: "/sql/root_zebra.sql", is_dir: false, children: [] },
    { name: "root_alpha.sql", path: "/sql/root_alpha.sql", is_dir: false, children: [] },
  ];

  describe("compareSqlFileEntries", () => {
    it("always sorts directories before files in both asc and desc orders", () => {
      const dir: SqlFileEntry = { name: "z_dir", path: "/z_dir", is_dir: true, children: [] };
      const file: SqlFileEntry = { name: "a_file.sql", path: "/a_file.sql", is_dir: false, children: [] };

      expect(compareSqlFileEntries(dir, file, "asc")).toBeLessThan(0);
      expect(compareSqlFileEntries(file, dir, "asc")).toBeGreaterThan(0);
      expect(compareSqlFileEntries(dir, file, "desc")).toBeLessThan(0);
      expect(compareSqlFileEntries(file, dir, "desc")).toBeGreaterThan(0);
    });

    it("performs natural numeric comparison in ascending order", () => {
      const f1: SqlFileEntry = { name: "file2.sql", path: "/file2.sql", is_dir: false, children: [] };
      const f2: SqlFileEntry = { name: "file10.sql", path: "/file10.sql", is_dir: false, children: [] };

      expect(compareSqlFileEntries(f1, f2, "asc")).toBeLessThan(0);
      expect(compareSqlFileEntries(f2, f1, "asc")).toBeGreaterThan(0);
    });

    it("inverts comparison in descending order", () => {
      const f1: SqlFileEntry = { name: "file2.sql", path: "/file2.sql", is_dir: false, children: [] };
      const f2: SqlFileEntry = { name: "file10.sql", path: "/file10.sql", is_dir: false, children: [] };

      expect(compareSqlFileEntries(f1, f2, "desc")).toBeGreaterThan(0);
      expect(compareSqlFileEntries(f2, f1, "desc")).toBeLessThan(0);
    });
  });

  describe("recursivelySortSqlFileEntries", () => {
    it("sorts folders and files recursively in ascending order", () => {
      const sorted = recursivelySortSqlFileEntries(sampleEntries, "asc");

      expect(sorted.map((e) => e.name)).toEqual(["migrations", "queries", "root_alpha.sql", "root_zebra.sql"]);

      const queries = sorted.find((e) => e.name === "queries")!;
      expect(queries.children.map((c) => c.name)).toEqual(["file2.sql", "file10.sql", "get_orders.sql", "select_user.sql"]);

      const migrations = sorted.find((e) => e.name === "migrations")!;
      expect(migrations.children.map((c) => c.name)).toEqual(["2024", "2025"]);
    });

    it("sorts folders and files recursively in descending order", () => {
      const sorted = recursivelySortSqlFileEntries(sampleEntries, "desc");

      expect(sorted.map((e) => e.name)).toEqual(["queries", "migrations", "root_zebra.sql", "root_alpha.sql"]);

      const queries = sorted.find((e) => e.name === "queries")!;
      expect(queries.children.map((c) => c.name)).toEqual(["select_user.sql", "get_orders.sql", "file10.sql", "file2.sql"]);

      const migrations = sorted.find((e) => e.name === "migrations")!;
      expect(migrations.children.map((c) => c.name)).toEqual(["2025", "2024"]);
    });
  });

  describe("filterAndSortSqlFileEntries", () => {
    it("returns all items recursively sorted when query is empty or whitespace", () => {
      const result = filterAndSortSqlFileEntries(sampleEntries, "   ", "asc");
      expect(result.entries.map((e) => e.name)).toEqual(["migrations", "queries", "root_alpha.sql", "root_zebra.sql"]);
      expect(result.autoExpanded.size).toBe(0);
      expect(result.matchCount).toBe(12);
    });

    it("filters files by name case-insensitively and auto-expands ancestor directories", () => {
      const result = filterAndSortSqlFileEntries(sampleEntries, "USER", "asc");

      expect(result.entries.map((e) => e.name)).toEqual(["migrations", "queries"]);

      const migrations = result.entries.find((e) => e.name === "migrations")!;
      expect(migrations.children.map((c) => c.name)).toEqual(["2025"]);
      expect(migrations.children[0].children.map((c) => c.name)).toEqual(["02_add_user_roles.sql"]);

      const queries = result.entries.find((e) => e.name === "queries")!;
      expect(queries.children.map((c) => c.name)).toEqual(["select_user.sql"]);

      expect(Array.from(result.autoExpanded).sort()).toEqual(["/sql/migrations", "/sql/migrations/2025", "/sql/queries"]);
    });

    it("keeps all children of a directory when the directory name itself matches", () => {
      const result = filterAndSortSqlFileEntries(sampleEntries, "queries", "desc");

      expect(result.entries.map((e) => e.name)).toEqual(["queries"]);
      const queries = result.entries[0];
      expect(queries.children.map((c) => c.name)).toEqual(["select_user.sql", "get_orders.sql", "file10.sql", "file2.sql"]);
      expect(result.autoExpanded.has("/sql/queries")).toBe(true);
    });

    it("returns empty entries when no item matches", () => {
      const result = filterAndSortSqlFileEntries(sampleEntries, "non_existent_keyword", "asc");
      expect(result.entries).toEqual([]);
      expect(result.autoExpanded.size).toBe(0);
      expect(result.matchCount).toBe(0);
    });
  });
});
