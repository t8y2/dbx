import { describe, expect, it } from "vitest";
import { buildDeployObjectResults, buildDeploySqlObjects, sortSchemaDiffObjects, type DeployObjectRef, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import type { DeployStatementResult } from "@/lib/schema/deployTxResult";

function makeObject(id: string, operationType: SchemaDiffObject["operationType"], objectKind: SchemaDiffObject["objectKind"] = "table", name = id, deploySql?: string): SchemaDiffObject {
  return {
    id,
    operationType,
    objectKind,
    name,
    selected: true,
    deploySql,
    sourceDdl: operationType === "create" || operationType === "modify" ? `CREATE TABLE ${name} (id INT);` : undefined,
    targetDdl: operationType === "delete" ? `CREATE TABLE ${name} (id INT);` : undefined,
  };
}

describe("buildDeploySqlObjects", () => {
  it("returns selected top-level objects with their SQL", () => {
    const objects = [makeObject("table-a", "create"), makeObject("table-b", "delete")];
    const items = buildDeploySqlObjects(objects);
    expect(items).toHaveLength(2);
    expect(items[0].sql).toContain("Create table: table-a");
    expect(items[1].sql).toContain("Drop table: table-b");
  });

  it("ignores children and unselected objects", () => {
    const objects: SchemaDiffObject[] = [makeObject("table-a", "create"), { id: "col-1", operationType: "none", objectKind: "table", name: "col1", selected: true }, { id: "table-b", operationType: "create", objectKind: "table", name: "table-b", selected: false }];
    const items = buildDeploySqlObjects(objects);
    expect(items).toHaveLength(1);
    expect(items[0].objectId).toBe("table-a");
  });
});

describe("buildDeployObjectResults", () => {
  it("marks all objects success when all statements succeed", () => {
    const objects = [makeObject("table-a", "create"), makeObject("table-b", "create", "table", "table-b")];
    const items = buildDeploySqlObjects(objects);
    const statements: DeployStatementResult[] = items.map((item, index) => ({
      index,
      statement: item.sql.includes(";") ? item.sql.split("\n").pop() : item.sql,
      status: "success",
      affectedRows: 1,
    }));
    const results = buildDeployObjectResults(objects, statements);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "success")).toBe(true);
  });

  it("marks an object failed when any of its statements failed", () => {
    const obj = makeObject("table-a", "create", "table", "table-a", "CREATE TABLE table-a (id INT); CREATE INDEX idx ON table-a (id);");
    const statements: DeployStatementResult[] = [
      { index: 0, statement: "CREATE TABLE table-a (id INT)", status: "success" },
      { index: 1, statement: "CREATE INDEX idx ON table-a (id)", status: "failed", error: "duplicate index" },
    ];
    const results = buildDeployObjectResults([obj], statements);
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBe("duplicate index");
  });

  it("marks objects as failed when no statement results are provided", () => {
    const objects = [makeObject("table-a", "create")];
    const results = buildDeployObjectResults(objects, []);
    expect(results[0].status).toBe("failed");
  });

  it("falls back to order-based assignment when statement text does not substring-match", () => {
    const objects = [makeObject("table-a", "delete", "table", "table-a", "DROP TABLE IF EXISTS table-a;"), makeObject("table-b", "create", "table", "table-b")];
    // Simulates backend quoting identifiers differently from the generated SQL.
    const statements: DeployStatementResult[] = [
      { index: 0, statement: 'DROP TABLE IF EXISTS "table-a";', status: "failed", error: "no such table" },
      { index: 1, statement: "CREATE TABLE table-b (id INT)", status: "success" },
    ];
    const results = buildDeployObjectResults(objects, statements);
    expect(results[0].status).toBe("failed");
    expect(results[0].error).toBe("no such table");
    expect(results[1].status).toBe("success");
  });
});

describe("sortSchemaDiffObjects", () => {
  it("orders objects by deployOrder", () => {
    const objects = [makeObject("table-users", "create", "table", "users"), makeObject("seq-user-id", "create", "sequence", "user_id_seq")];
    const deployOrder: DeployObjectRef[] = [
      { kind: "sequence", name: "user_id_seq" },
      { kind: "table", name: "users" },
    ];
    const sorted = sortSchemaDiffObjects(objects, deployOrder);
    expect(sorted[0].name).toBe("user_id_seq");
    expect(sorted[1].name).toBe("users");
  });

  it("keeps objects not in deployOrder at the end in original order", () => {
    const objects = [makeObject("table-a", "create", "table", "a"), makeObject("table-b", "create", "table", "b"), makeObject("table-c", "create", "table", "c")];
    const deployOrder: DeployObjectRef[] = [{ kind: "table", name: "c" }];
    const sorted = sortSchemaDiffObjects(objects, deployOrder);
    expect(sorted[0].name).toBe("c");
    expect(sorted[1].name).toBe("a");
    expect(sorted[2].name).toBe("b");
  });

  it("returns the original array when no deployOrder is provided", () => {
    const objects = [makeObject("table-a", "create", "table", "a"), makeObject("table-b", "create", "table", "b")];
    const sorted = sortSchemaDiffObjects(objects, undefined);
    expect(sorted[0].name).toBe("a");
    expect(sorted[1].name).toBe("b");
  });
});
