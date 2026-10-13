import { describe, expect, it, vi } from "vitest";
import { compareMongoDocuments, planMongoSync } from "../mongoCompare";
import { canonicalDocuments, executeMongoSync, mongoSyncCommand, readMongoCompareSnapshot, type MongoCompareApi, type MongoCompareEndpoint } from "../mongoCompareRuntime";

const source: MongoCompareEndpoint = { connectionId: "source", database: "db", collection: "col", filter: "{}" };
const target: MongoCompareEndpoint = { ...source, connectionId: "target" };
const page = (docs: Record<string, unknown>[]) => ({ documents: docs, extended_documents: docs });

describe("Mongo compare read and sync", () => {
  it("reads batches until an empty page and detects limit + 1 without relying on count estimates", async () => {
    const docs = Array.from({ length: 501 }, (_, i) => ({ _id: i }));
    const api = {
      mongoRunCommand: vi.fn(),
      mongoFindDocuments: vi.fn(async (_id, _db, _col, skip, limit) => page(docs.slice(skip, skip + Math.min(limit, 200)))),
    } satisfies MongoCompareApi;
    const options = { limit: 600, executionId: "id", signal: new AbortController().signal };
    const result = await readMongoCompareSnapshot(api, source, options);
    expect(result).toEqual({ documents: docs, truncated: false });
    expect(api.mongoFindDocuments).toHaveBeenCalledTimes(4);
    expect((await readMongoCompareSnapshot(api, source, { ...options, limit: 500 })).truncated).toBe(true);
  });

  it("rejects malformed filters, unsafe display JSON, invalid limits, and cancellation", async () => {
    const api = { mongoFindDocuments: vi.fn(), mongoRunCommand: vi.fn() };
    const controller = new AbortController();
    const options = { limit: 100, executionId: "id", signal: controller.signal };
    await expect(readMongoCompareSnapshot(api, { ...source, filter: "[]" }, options)).rejects.toMatchObject({ code: "invalidFilter" });
    await expect(readMongoCompareSnapshot(api, source, { ...options, limit: 0 })).rejects.toMatchObject({ code: "invalidLimit" });
    expect(() => canonicalDocuments({ documents: [{ _id: "display" }] })).toThrow();
    controller.abort();
    await expect(readMongoCompareSnapshot(api, source, options)).rejects.toMatchObject({ code: "cancelled" });
    expect(api.mongoFindDocuments).not.toHaveBeenCalled();
  });

  it("preflights both endpoints, uses strict EJSON commands and preserves shell-looking strings", async () => {
    const left = { _id: { $oid: "507f1f77bcf86cd799439011" }, value: 'ISODate("2020-01-01")' };
    const right = { ...left, value: "before" };
    const row = compareMongoDocuments([left], [right], { matchFields: ["_id"] }).rows[0];
    const change = planMongoSync(row, "target")!;
    const api = { mongoFindDocuments: vi.fn(async (id: string) => page([id === "source" ? left : right])), mongoRunCommand: vi.fn(async () => page([{ ok: 1, n: 1 }])) };
    await executeMongoSync(api, source, target, ["_id"], [change]);
    expect(api.mongoFindDocuments).toHaveBeenCalledTimes(4);
    const command = JSON.parse(api.mongoRunCommand.mock.calls[0][2]);
    expect(command.updates[0]).toMatchObject({ u: left, upsert: false, multi: false });
    expect(command.updates[0].q.$expr.$eq[1].$literal).toEqual(right);
  });

  it("aborts before any write if either snapshot is changed or a custom key is ambiguous", async () => {
    const row = compareMongoDocuments([{ _id: 1, key: "a", n: 2 }], [{ _id: 1, key: "a", n: 1 }], { matchFields: ["key"] }).rows[0];
    const change = planMongoSync(row, "target")!;
    const api = {
      mongoFindDocuments: vi.fn(async (id: string) => page(id === "source" ? [row.source!] : [{ _id: 1, key: "a", n: 3 }])),
      mongoRunCommand: vi.fn(),
      mongoListIndexSpecs: vi.fn(async () => [{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: false, partial_filter_expression: null, properties_complete: true }]),
    };
    await expect(executeMongoSync(api, source, target, ["key"], [change])).rejects.toMatchObject({ code: "conflict" });
    expect(api.mongoRunCommand).not.toHaveBeenCalled();
    api.mongoFindDocuments.mockImplementation(async (id) => page(id === "source" ? [row.source!] : [row.target!, row.target!]));
    await expect(executeMongoSync(api, source, target, ["key"], [change])).rejects.toMatchObject({ code: "conflict" });
  });

  it.each(["update", "delete"] as const)("allows custom-key %s without an index while retaining snapshot guards", async (kind) => {
    const before = { _id: 1, key: "a", value: "old" };
    const after = { ...before, value: "new" };
    const row = compareMongoDocuments(kind === "update" ? [after] : [], [before], { matchFields: ["key"] }).rows[0];
    const change = planMongoSync(row, "target")!;
    const api = {
      mongoFindDocuments: vi.fn(async (id: string) => page(id === "target" ? [before] : kind === "update" ? [after] : [])),
      mongoRunCommand: vi.fn(async () => page([{ ok: 1, n: 1 }])),
    };
    expect(change.kind).toBe(kind === "update" ? "replace" : "delete");
    await executeMongoSync(api, source, target, ["key"], [change]);
    expect(api.mongoFindDocuments).toHaveBeenCalledTimes(4);
    expect(api.mongoRunCommand).toHaveBeenCalledOnce();
    api.mongoFindDocuments.mockImplementation(async (id: string) => page(id === "target" ? [{ ...before, value: "changed" }] : kind === "update" ? [after] : []));
    await expect(executeMongoSync(api, source, target, ["key"], [change])).rejects.toMatchObject({ code: "conflict" });
    expect(api.mongoRunCommand).toHaveBeenCalledOnce();
  });

  it("requires a server-enforced unique index for custom match keys before the first write", async () => {
    const row = compareMongoDocuments([{ _id: 1, key: "a" }], [], { matchFields: ["key"] }).rows[0];
    const change = planMongoSync(row, "target")!;
    const api = {
      mongoFindDocuments: vi.fn(async (id: string) => page(id === "source" ? [row.source!] : [])),
      mongoRunCommand: vi.fn(async () => page([{ ok: 1, n: 1 }])),
      mongoListIndexSpecs: vi.fn(async () => [] as Array<{ keys: { field: string; direction: string }[]; is_unique: boolean; is_sparse: boolean; partial_filter_expression: string | null; properties_complete: boolean }>),
    };
    for (const unsafe of [
      [],
      [{ keys: [{ field: "key", direction: "1" }], is_unique: false, is_sparse: false, partial_filter_expression: null, properties_complete: true }],
      [{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: false, partial_filter_expression: null, properties_complete: false }],
      [
        {
          keys: [
            { field: "key", direction: "1" },
            { field: "other", direction: "1" },
          ],
          is_unique: true,
          is_sparse: false,
          partial_filter_expression: null,
          properties_complete: true,
        },
      ],
      [{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: true, partial_filter_expression: null, properties_complete: true }],
      [{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: false, partial_filter_expression: "{}", properties_complete: true }],
    ]) {
      api.mongoListIndexSpecs.mockResolvedValueOnce(unsafe);
      await expect(executeMongoSync(api, source, target, ["key"], [change])).rejects.toMatchObject({ code: "uniqueIndexRequired" });
    }
    expect(api.mongoFindDocuments).not.toHaveBeenCalled();
    expect(api.mongoRunCommand).not.toHaveBeenCalled();
    api.mongoListIndexSpecs.mockResolvedValueOnce([{ keys: [{ field: "key", direction: "1" }], is_unique: true, is_sparse: false, partial_filter_expression: null, properties_complete: true }]);
    await executeMongoSync(api, source, target, ["key"], [change]);
    expect(api.mongoRunCommand).toHaveBeenCalledOnce();
  });

  it("checks the receiving endpoint in reverse sync and honours cancellation during metadata reads", async () => {
    const row = compareMongoDocuments([], [{ _id: 2, key: "a", region: "west" }], { matchFields: ["key", "region"] }).rows[0];
    const change = planMongoSync(row, "source")!;
    const controller = new AbortController();
    const api = {
      mongoFindDocuments: vi.fn(async (id: string) => page(id === "target" ? [row.target!] : [])),
      mongoRunCommand: vi.fn(async () => page([{ ok: 1, n: 1 }])),
      mongoListIndexSpecs: vi.fn(async () => [{ keys: [{ field: "key", direction: "-1" }], is_unique: true, is_sparse: false, partial_filter_expression: null, properties_complete: true }]),
    };
    await executeMongoSync(api, target, source, ["key", "region"], [change]);
    expect(api.mongoListIndexSpecs).toHaveBeenCalledWith("source", "db", "col");
    expect(api.mongoRunCommand).toHaveBeenCalledOnce();
    api.mongoListIndexSpecs.mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });
    await expect(executeMongoSync(api, target, source, ["key"], [change], undefined, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(api.mongoRunCommand).toHaveBeenCalledOnce();
  });

  it("checks zero matched CAS writes, command write errors, and write concern errors", async () => {
    const row = compareMongoDocuments([{ _id: 1, n: 2 }], [{ _id: 1, n: 1 }], { matchFields: ["_id"] }).rows[0];
    const change = planMongoSync(row, "target")!;
    for (const reply of [
      { ok: 1, n: 0 },
      { ok: 1, n: 0, writeErrors: [{ errmsg: "duplicate" }] },
      { ok: 1, n: 1, writeConcernError: { errmsg: "timeout" } },
    ]) {
      const api = { mongoFindDocuments: vi.fn(async (id: string) => page([id === "source" ? row.source! : row.target!])), mongoRunCommand: vi.fn(async () => page([reply])) };
      await expect(executeMongoSync(api, source, target, ["_id"], [change])).rejects.toBeInstanceOf(Error);
    }
  });

  it("supports reverse direction and deletion with destination snapshot guards", async () => {
    const row = compareMongoDocuments([{ _id: 1 }], [], { matchFields: ["_id"] }).rows[0];
    const change = planMongoSync(row, "source")!;
    const api = { mongoFindDocuments: vi.fn(async (id: string) => page(id === "source" ? [row.source!] : [])), mongoRunCommand: vi.fn(async () => page([{ ok: 1, n: 1 }])) };
    await executeMongoSync(api, target, source, ["_id"], [change]);
    expect(mongoSyncCommand("col", change)).toMatchObject({ delete: "col", deletes: [{ limit: 1 }] });
  });
});
