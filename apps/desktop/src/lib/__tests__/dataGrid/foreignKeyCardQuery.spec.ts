import { describe, expect, it } from "vitest";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { FOREIGN_KEY_CARD_MAX_DEPTH, foreignKeyCardPreviewPaths, foreignKeyCardTemplatePaths, loadForeignKeyCardRecord, loadForeignKeyCardRelations, type ForeignKeyCardQueryDeps, type ForeignKeyCardTableRef } from "@/lib/dataGrid/foreignKeyCardQuery";
import type { ColumnInfo, ForeignKeyInfo } from "@/types/database";

function column(name: string): ColumnInfo {
  return { name, data_type: "text", is_nullable: true, column_default: null, is_primary_key: name === "id", extra: null };
}

const TABLES: Record<string, { columns: string[]; foreignKeys: ForeignKeyInfo[]; rows: Record<string, CellValue>[] }> = {
  users: {
    columns: ["id", "name", "avatar", "department_id", "manager_id"],
    foreignKeys: [
      { name: "fk_dept", column: "department_id", ref_table: "departments", ref_column: "id" },
      { name: "fk_mgr", column: "manager_id", ref_table: "users", ref_column: "id" },
    ],
    rows: [
      { id: 1, name: "Ann", avatar: "a.png", department_id: 10, manager_id: 2 },
      { id: 2, name: "Bob", avatar: "b.png", department_id: 20, manager_id: null },
    ],
  },
  departments: {
    columns: ["id", "name", "company_id"],
    foreignKeys: [{ name: "fk_company", column: "company_id", ref_table: "companies", ref_column: "id" }],
    rows: [
      { id: 10, name: "R&D", company_id: 100 },
      { id: 20, name: "Sales", company_id: 100 },
    ],
  },
  companies: { columns: ["id", "name"], foreignKeys: [], rows: [{ id: 100, name: "Acme" }] },
};

function createDeps() {
  const selects: { table: string; columns: string[] | undefined }[] = [];
  const deps: ForeignKeyCardQueryDeps = {
    columns: async (ref) => TABLES[ref.table].columns.map(column),
    foreignKeys: async (ref) => TABLES[ref.table].foreignKeys,
    condition: async (_ref, columnName, _info, value) => `${columnName}=${value}`,
    async selectRow(ref, columns, whereInput) {
      selects.push({ table: ref.table, columns });
      const [key, raw] = whereInput.split("=");
      const row = TABLES[ref.table].rows.find((candidate) => String(candidate[key]) === raw);
      if (!row) return undefined;
      return Object.fromEntries((columns ?? TABLES[ref.table].columns).map((name) => [name, row[name]]));
    },
  };
  return { deps, selects };
}

const USERS: ForeignKeyCardTableRef = { schema: "main", table: "users" };

describe("foreign key card query", () => {
  it("parses dotted placeholder paths", () => {
    expect(foreignKeyCardTemplatePaths("{{ name }} {{department_id.name}} {{NAME}} {{a..b}}")).toEqual([["name"], ["department_id", "name"]]);
  });

  it("selects only the columns the template uses", async () => {
    const { deps, selects } = createDeps();
    const record = await loadForeignKeyCardRecord(USERS, "id=1", [["Name"], ["avatar"], ["missing"]], deps);
    expect(selects).toEqual([{ table: "users", columns: ["name", "avatar"] }]);
    expect(record).toEqual({ name: "Ann", avatar: "a.png" });
  });

  it("selects the whole row without a template", async () => {
    const { deps, selects } = createDeps();
    await loadForeignKeyCardRecord(USERS, "id=1", undefined, deps);
    expect(selects).toEqual([{ table: "users", columns: undefined }]);
  });

  it("follows foreign keys of the referenced table", async () => {
    const { deps, selects } = createDeps();
    const record = await loadForeignKeyCardRecord(USERS, "id=1", [["name"], ["department_id", "name"], ["department_id", "company_id", "name"], ["manager_id", "name"]], deps);
    expect(record).toMatchObject({
      name: "Ann",
      department_id: 10,
      "department_id.name": "R&D",
      "department_id.company_id.name": "Acme",
      "manager_id.name": "Bob",
    });
    expect(selects[0]).toEqual({ table: "users", columns: ["name", "department_id", "manager_id"] });
    expect(selects).toContainEqual({ table: "departments", columns: ["name", "company_id"] });
  });

  it("skips relations whose value is NULL or that are not foreign keys", async () => {
    const { deps } = createDeps();
    const record = await loadForeignKeyCardRecord(
      USERS,
      "id=2",
      [
        ["manager_id", "name"],
        ["name", "length"],
      ],
      deps,
    );
    expect(record).toEqual({ manager_id: null, name: "Bob" });
  });

  it("stops expanding at the maximum depth", async () => {
    const { deps } = createDeps();
    const deep = ["manager_id", "manager_id", "manager_id", "manager_id", "name"].slice(0, FOREIGN_KEY_CARD_MAX_DEPTH + 1);
    const record = await loadForeignKeyCardRecord(USERS, "id=1", [deep], deps);
    expect(Object.keys(record ?? {}).every((key) => key.split(".").length <= FOREIGN_KEY_CARD_MAX_DEPTH)).toBe(true);
  });

  it("lists one level of relations for the editor", async () => {
    const { deps } = createDeps();
    const relations = await loadForeignKeyCardRelations(USERS, deps);
    expect(relations.map((relation) => [relation.column, relation.table])).toEqual([
      ["department_id", "departments"],
      ["manager_id", "users"],
    ]);
    const paths = foreignKeyCardPreviewPaths(TABLES.users.columns.map(column), relations);
    expect(paths).toContainEqual(["department_id", "company_id"]);
    expect(paths).toContainEqual(["avatar"]);
  });

  it("ignores composite foreign keys", async () => {
    const { deps } = createDeps();
    const relations = await loadForeignKeyCardRelations(USERS, {
      ...deps,
      foreignKeys: async () => [
        { name: "fk_pair", column: "a", ref_table: "t", ref_column: "x" },
        { name: "fk_pair", column: "b", ref_table: "t", ref_column: "y" },
      ],
    });
    expect(relations).toEqual([]);
  });
});
