import { describe, expect, it } from "vitest";
import { buildMongoQueryResultOperations, formatMongoQueryResultOperationPreview, type MongoQueryResultGridChanges } from "@/lib/mongo/mongoQueryResultEditing";
import type { MongoInputValue } from "@/lib/mongo/mongoDocumentValues";

const COLUMNS = ["_id", "name", "score"];

function changes(overrides: Partial<MongoQueryResultGridChanges> = {}): MongoQueryResultGridChanges {
  return {
    dirtyRows: new Map(),
    deletedRows: new Set(),
    columns: COLUMNS,
    rows: [
      ["507f1f77bcf86cd799439011", "ada", 1],
      ["507f1f77bcf86cd799439012", "bob", 2],
    ],
    ...overrides,
  };
}

function documents(): unknown[] {
  return [
    { _id: { $oid: "507f1f77bcf86cd799439011" }, name: "ada", score: 1 },
    { _id: { $oid: "507f1f77bcf86cd799439012" }, name: "bob", score: 2 },
  ];
}

function target(documentList: unknown[] = documents()) {
  return { idColumn: "_id", documentAt: (rowIndex: number) => documentList[rowIndex] };
}

function dirty(entries: [number, [number, MongoInputValue][]][]): Map<number, Map<number, MongoInputValue>> {
  return new Map(entries.map(([rowIndex, cells]) => [rowIndex, new Map(cells)]));
}

describe("MongoDB query result grid mutations", () => {
  it("turns rows marked for deletion into deleteOne operations keyed by the document _id", () => {
    const operations = buildMongoQueryResultOperations(changes({ deletedRows: new Set([1]) }), target());

    expect(operations).toEqual([{ kind: "delete", rowIndex: 1, id: { $oid: "507f1f77bcf86cd799439012" } }]);
  });

  it("deletes every selected row and keeps updates ahead of deletions", () => {
    const operations = buildMongoQueryResultOperations(changes({ dirtyRows: dirty([[0, [[1, "ada2"]]]]), deletedRows: new Set([1]) }), target());

    expect(operations.map((operation) => [operation.kind, operation.rowIndex])).toEqual([
      ["update", 0],
      ["delete", 1],
    ]);
  });

  it("falls back to the grid cell when no raw document backs the row", () => {
    const operations = buildMongoQueryResultOperations(changes({ deletedRows: new Set([0, 1]) }), target([]));

    expect(operations).toEqual([
      { kind: "delete", rowIndex: 0, id: "507f1f77bcf86cd799439011" },
      { kind: "delete", rowIndex: 1, id: "507f1f77bcf86cd799439012" },
    ]);
  });

  it.each([
    { label: "an out-of-range row index", deletedRows: new Set([7]) },
    { label: "a blank id cell", deletedRows: new Set([0]), rows: [["   ", "ada", 1]] as MongoInputValue[][] },
    { label: "a null id cell", deletedRows: new Set([0]), rows: [[null, "ada", 1]] as MongoInputValue[][] },
  ])("skips a deletion with $label rather than targeting the wrong document", ({ deletedRows, rows }) => {
    expect(buildMongoQueryResultOperations(changes({ deletedRows, ...(rows ? { rows } : {}) }), target([]))).toEqual([]);
  });

  it("produces no operations when the result has no _id column", () => {
    const withoutId = changes({ columns: ["name", "score"], deletedRows: new Set([0]), dirtyRows: dirty([[1, [[0, "bob2"]]]]) });

    expect(buildMongoQueryResultOperations(withoutId, target())).toEqual([]);
  });

  it("previews a deletion as a shell deleteOne against the queried collection", () => {
    const [operation] = buildMongoQueryResultOperations(changes({ deletedRows: new Set([0]) }), target());

    expect(formatMongoQueryResultOperationPreview("users", operation!)).toBe('db.getCollection("users").deleteOne({_id: ObjectId("507f1f77bcf86cd799439011")})');
  });

  it("keeps previewing updates as shell updateOne calls", () => {
    const [operation] = buildMongoQueryResultOperations(changes({ dirtyRows: dirty([[1, [[1, "bob2"]]]]) }), target());

    expect(formatMongoQueryResultOperationPreview("users", operation!)).toBe('db.getCollection("users").updateOne({_id: ObjectId("507f1f77bcf86cd799439012")}, {"$set":{"name":"bob2"}})');
  });

  it("drops an update whose dirty cells produce no field changes", () => {
    const idOnly = changes({ dirtyRows: dirty([[0, [[0, "507f1f77bcf86cd799439099"]]]]) });

    expect(buildMongoQueryResultOperations(idOnly, target())).toEqual([]);
  });
});
