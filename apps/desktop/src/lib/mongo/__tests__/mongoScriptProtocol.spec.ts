import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import workerSource from "../mongoScriptWorker.js?raw";
import { assertMongoScriptJson, mongoScriptOperation } from "../mongoScriptProtocol";
const request = (method: string, args: unknown[]) => ({ id: 1, collection: "collection", method, args });
describe("Mongo script bridge", () => {
  it("bounds read cursors and explicitly scopes writes to the selected namespace", () => {
    expect(mongoScriptOperation(request("find", [{}, {}, { limit: 25, skip: 10 }]), "db").operation).toMatchObject({ kind: "find", limit: 25, skip: 10 });
    const operation = mongoScriptOperation(request("insertOne", [{ value: "$danger" }]), "db").operation;
    expect(operation.kind).toBe("write");
    if (operation.kind === "write") expect(JSON.parse(operation.command)).toEqual({ insert: "collection", documents: [{ value: "$danger" }], ordered: true });
  });
  it("classifies aggregate output as writes and rejects nested writes", () => {
    expect(mongoScriptOperation(request("aggregate", [[{ $merge: { into: { db: "other", coll: "target" } } }]]), "db").operation).toMatchObject({
      kind: "write",
      targetDatabase: "other",
    });
    expect(() => mongoScriptOperation(request("aggregate", [[{ $facet: { inner: [{ $out: "target" }] } }]]), "db")).toThrow();
  });
  it("rejects arbitrary methods, missing filters, invalid options and unbounded reads", () => {
    for (const input of [request("runCommand", [{ dropDatabase: 1 }]), request("deleteMany", []), request("find", [{}, {}, { limit: 0 }]), request("updateOne", [{}, { $set: { value: 1 } }, { bypassDocumentValidation: true }]), request("replaceOne", [{}, { $set: { value: 1 } }])])
      expect(() => mongoScriptOperation(input, "db")).toThrow();
  });
  it("accepts only simple find projections and direction-only sorts", () => {
    for (const projection of [{ name: 1, _id: 0 }, { secret: false }, { name: true, age: 1 }, {}]) expect(() => mongoScriptOperation(request("find", [{}, projection, { sort: { name: 1, age: -1 } }]), "db")).not.toThrow();
    for (const projection of [{ name: 1, age: 0 }, { items: { $slice: 2 } }, { items: { $elemMatch: { active: true } } }, { "items.$": 1 }, { "items.0": 1 }, { name: "$other" }, { a: 1, "a.b": 1 }]) expect(() => mongoScriptOperation(request("find", [{}, projection]), "db")).toThrow();
    for (const sort of [{ age: 0 }, { age: { $meta: "textScore" } }, { $natural: 1 }]) expect(() => mongoScriptOperation(request("find", [{}, {}, { sort }]), "db")).toThrow();
  });
  it("rejects find-only filter operators rather than changing aggregate semantics", () => {
    for (const filter of [{ $where: "return true" }, { point: { $near: [0, 0] } }, { point: { $nearSphere: [0, 0] } }, { $and: [{ point: { $near: [0, 0] } }] }, { items: { $elemMatch: { $where: "return true" } } }]) {
      for (const method of ["find", "countDocuments"]) expect(() => mongoScriptOperation(request(method, [filter]), "db")).toThrow("Unsupported");
    }
    expect(() => mongoScriptOperation(request("find", [{ $expr: { $eq: ["$value", { $literal: { $where: "data" } }] } }]), "db")).not.toThrow();
    expect(() => mongoScriptOperation(request("find", [{ $text: { $search: "example" } }]), "db")).not.toThrow();
  });
  it("rejects values that JSON would silently lose or change before write review", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("must not invoke getter");
      },
    });
    for (const value of [undefined, NaN, Infinity, -Infinity, -0, 9007199254740992, 1n, new Date(), /secret/, new Map(), new Set(), () => {}, Symbol("x"), circular, accessor, Array(2)]) {
      expect(() => mongoScriptOperation(request("insertOne", [{ value }]), "db")).toThrow();
    }
    const shared = { value: 1 };
    expect(() => assertMongoScriptJson({ a: shared, b: shared, id: { $oid: "507f1f77bcf86cd799439011" }, long: { $numberLong: "9007199254740993" }, nan: { $numberDouble: "NaN" } })).not.toThrow();
  });
  it("validates worker values before structured cloning and keeps BSON helpers usable", async () => {
    async function run(source: string): Promise<{ type: string; message?: string; request?: unknown }[]> {
      const messages: { type: string; message?: string; request?: unknown }[] = [];
      const self: { onmessage?: (event: { data: unknown }) => Promise<void> } = {};
      runInNewContext(workerSource, {
        self,
        postMessage: (message: { type: string; request?: { id: number } }) => {
          messages.push(message);
          if (message.type === "rpc") void self.onmessage!({ data: { type: "response", id: message.request!.id, value: { ok: 1 } } });
        },
      });
      await self.onmessage!({ data: { type: "start", source } });
      return messages;
    }
    for (const source of [
      "await db.items.insertOne({value: /secret/})",
      "await db.items.insertOne({value: new Date()})",
      "await db.items.insertOne({value: undefined})",
      "const x={}; x.self=x; await db.items.insertOne(x)",
      "await db.items.insertOne({get value(){return 1}})",
      "await db.items.insertOne({value: NumberLong(9007199254740993)})",
    ]) {
      const messages = await run(source);
      expect(messages.some((message) => message.type === "rpc")).toBe(false);
      expect(messages.at(-1)?.type).toBe("error");
    }
    const messages = await run('await db.items.insertOne({id:ObjectId("507f1f77bcf86cd799439011"), at:ISODate("2026-01-01T00:00:00Z"), long:NumberLong("9007199254740993")})');
    expect(messages.at(-1)?.type).toBe("done");
    const call = messages.find((message) => message.type === "rpc");
    expect(call?.request).toMatchObject({ args: [{ long: { $numberLong: "9007199254740993" } }] });
  });
});
