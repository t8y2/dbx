import { describe, expect, it } from "vitest";
import { buildDatabaseTableEmptyPlan, buildDatabaseTableEmptyPlanLayers, buildMysqlTableMutationSql, DatabaseTableEmptyPlanError } from "@/lib/sidebar/databaseTableEmpty";

describe("database table empty plan", () => {
  it("renders MySQL mutation SQL locally and escapes backticks", () => {
    expect(buildMysqlTableMutationSql("empty", "app`db", "order`items")).toBe("DELETE FROM `app``db`.`order``items`;");
    expect(buildMysqlTableMutationSql("drop", "app", "orders")).toBe("DROP TABLE `app`.`orders`;");
    expect(buildMysqlTableMutationSql("empty", " app ", "orders")).toBe("DELETE FROM ` app `.`orders`;");
  });

  it("uses a stable table-name order for independent tables", async () => {
    const plan = await buildDatabaseTableEmptyPlan({
      database: "app",
      listTables: async () => [
        { name: "zebra", object_type: "TABLE", schema: "app" },
        { name: "alpha", object_type: "TABLE", schema: "app" },
      ],
      foreignKeysByTable: {},
      buildSql: async (table) => `DELETE FROM \`app\`.\`${table.name}\`;`,
    });

    expect(plan.map(({ target }) => target.name)).toEqual(["alpha", "zebra"]);
  });

  it("does not treat inherited object keys as foreign-key metadata", async () => {
    const foreignKeysByTable = Object.create({ toString: [{ name: "inherited", column: "id", ref_table: "parent", ref_column: "id" }] }) as Record<string, never>;
    const plan = await buildDatabaseTableEmptyPlan({
      database: "app",
      listTables: async () => [{ name: "toString", object_type: "TABLE", schema: "app" }],
      foreignKeysByTable,
      buildSql: async (table) => `DELETE FROM \`app\`.\`${table.name}\`;`,
    });

    expect(plan.map(({ target }) => target.name)).toEqual(["toString"]);
  });

  it("orders referencing tables before their parents", async () => {
    const options = {
      database: "app",
      listTables: async () => [
        { name: "parent", object_type: "TABLE", schema: "app" },
        { name: "child", object_type: "TABLE", schema: "app" },
      ],
      listForeignKeys: async (table) => (table.name === "child" ? [{ name: "fk", column: "parent_id", ref_table: "parent", ref_column: "id" }] : []),
      buildSql: async (table) => `DELETE FROM \`${table.schema}\`.\`${table.name}\`;`,
    };
    const plan = await buildDatabaseTableEmptyPlan(options);
    const layers = await buildDatabaseTableEmptyPlanLayers(options);
    expect(plan.map(({ target }) => target.name)).toEqual(["child", "parent"]);
    expect(layers[1]?.dependencies).toEqual({ parent: ["child"] });
  });

  it("stops on a foreign-key cycle instead of falling back to unsafe order", async () => {
    await expect(
      buildDatabaseTableEmptyPlan({
        database: "app",
        listTables: async () => [
          { name: "a", object_type: "TABLE", schema: "app" },
          { name: "b", object_type: "TABLE", schema: "app" },
        ],
        listForeignKeys: async (table) => [{ name: "fk", column: "id", ref_table: table.name === "a" ? "b" : "a", ref_column: "id" }],
        buildSql: async () => "DELETE FROM t;",
      }),
    ).rejects.toBeInstanceOf(DatabaseTableEmptyPlanError);
  });

  it("builds a large no-dependency plan without per-table metadata calls", async () => {
    const tables = Array.from({ length: 1000 }, (_, index) => ({ name: `table_${index}`, object_type: "TABLE", schema: "app" }));
    let metadataCalls = 0;
    const sqlProgress: Array<[number, number]> = [];
    const layers = await buildDatabaseTableEmptyPlanLayers({
      database: "app",
      listTables: async () => tables,
      foreignKeysByTable: {},
      buildSql: async (table) => `DELETE FROM \`app\`.\`${table.name}\`;`,
      onProgress: () => {
        metadataCalls += 1;
      },
      onSqlProgress: (completed, total) => {
        sqlProgress.push([completed, total]);
      },
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.items).toHaveLength(1000);
    expect(metadataCalls).toBe(1000);
    expect(sqlProgress.at(-1)).toEqual([1000, 1000]);
  });

  it("does not start table metadata loading after cancellation", async () => {
    let listTablesCalls = 0;
    await expect(
      buildDatabaseTableEmptyPlan({
        database: "app",
        listTables: async () => {
          listTablesCalls += 1;
          return [];
        },
        foreignKeysByTable: {},
        buildSql: async () => "DELETE FROM app.table;",
        isCancelled: () => true,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(listTablesCalls).toBe(0);
  });
});
