import assert from "node:assert/strict";
import { test } from "vitest";
import { applyDocumentStoreIdentityPlan, insertDocumentStoreDocument, writeDocumentStoreDocument } from "../../apps/desktop/src/lib/app/documentStoreSave.ts";
import type { DocumentStoreWriteApis } from "../../apps/desktop/src/lib/app/documentStoreSave.ts";

function mockApis(overrides: Partial<DocumentStoreWriteApis> = {}): DocumentStoreWriteApis & {
  calls: Array<{ op: string; args: unknown[] }>;
} {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  return {
    calls,
    insert: async (...args) => {
      calls.push({ op: "insert", args });
      return overrides.insert ? overrides.insert(...args) : "new-id";
    },
    update: async (...args) => {
      calls.push({ op: "update", args });
      return overrides.update ? overrides.update(...args) : 1;
    },
    delete: async (...args) => {
      calls.push({ op: "delete", args });
      return overrides.delete ? overrides.delete(...args) : 1;
    },
  };
}

test("ES replace puts body under current identity with routing arg", async () => {
  const apis = mockApis();
  await applyDocumentStoreIdentityPlan({
    kind: "elasticsearch",
    plan: { action: "replace", writeId: "doc-1", writeRouting: "shard-a" },
    document: { _id: "doc-1", _routing: "shard-a", title: "hello" },
    apis,
  });
  assert.equal(apis.calls.length, 1);
  assert.equal(apis.calls[0]?.op, "update");
  assert.equal(apis.calls[0]?.args[0], "doc-1");
  assert.equal(apis.calls[0]?.args[2], "shard-a");
  // Body must not embed identity metadata.
  assert.equal(apis.calls[0]?.args[1], '{"title":"hello"}');
});

test("ES same-id routing change rekeys: write new routing then delete old", async () => {
  const apis = mockApis();
  await applyDocumentStoreIdentityPlan({
    kind: "elasticsearch",
    plan: {
      action: "rekey",
      writeId: "doc-1",
      writeRouting: "shard-b",
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
    document: { _id: "doc-1", _routing: "shard-b", title: "hello" },
    apis,
  });
  assert.deepEqual(
    apis.calls.map((call) => call.op),
    ["update", "delete"],
  );
  assert.deepEqual(apis.calls[0]?.args, ["doc-1", '{"title":"hello"}', "shard-b"]);
  assert.deepEqual(apis.calls[1]?.args, ["doc-1", "shard-a"]);
});

test("ES id+routing change rekeys with both coordinates", async () => {
  const apis = mockApis();
  await applyDocumentStoreIdentityPlan({
    kind: "elasticsearch",
    plan: {
      action: "rekey",
      writeId: "doc-2",
      writeRouting: "shard-b",
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
    document: { _id: "doc-2", _routing: "shard-b", title: "hello" },
    apis,
  });
  assert.deepEqual(apis.calls[0]?.args, ["doc-2", '{"title":"hello"}', "shard-b"]);
  assert.deepEqual(apis.calls[1]?.args, ["doc-1", "shard-a"]);
});

test("failed write does not delete the old document", async () => {
  const apis = mockApis({
    update: async () => {
      throw new Error("write failed");
    },
  });
  await assert.rejects(
    () =>
      applyDocumentStoreIdentityPlan({
        kind: "elasticsearch",
        plan: {
          action: "rekey",
          writeId: "doc-1",
          writeRouting: "shard-b",
          deleteId: "doc-1",
          deleteRouting: "shard-a",
        },
        document: { title: "hello" },
        apis,
      }),
    /write failed/,
  );
  assert.deepEqual(
    apis.calls.map((call) => call.op),
    ["update"],
  );
  assert.equal(
    apis.calls.some((call) => call.op === "delete"),
    false,
  );
});

test("Mongo rekey inserts then deletes without routing", async () => {
  const apis = mockApis();
  await applyDocumentStoreIdentityPlan({
    kind: "mongodb",
    plan: {
      action: "rekey",
      writeId: "new",
      deleteId: "old",
    },
    document: { _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" }, name: "Ada" },
    apis,
  });
  assert.deepEqual(
    apis.calls.map((call) => call.op),
    ["insert", "delete"],
  );
  assert.match(String(apis.calls[0]?.args[0]), /aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(apis.calls[0]?.args[1], undefined);
  assert.deepEqual(apis.calls[1]?.args, ["old", undefined]);
});

test("ES insert with routing passes routing API arg and strips body metadata", async () => {
  const apis = mockApis();
  await insertDocumentStoreDocument({
    kind: "elasticsearch",
    document: { _routing: "tenant-1", title: "hello" },
    routing: "tenant-1",
    apis,
  });
  assert.equal(apis.calls[0]?.op, "insert");
  assert.equal(apis.calls[0]?.args[0], '{"title":"hello"}');
  assert.equal(apis.calls[0]?.args[1], "tenant-1");
});

test("ES insert with explicit id uses put + routing", async () => {
  const apis = mockApis();
  await insertDocumentStoreDocument({
    kind: "elasticsearch",
    document: { _id: "doc-1", _routing: "tenant-1", title: "hello" },
    explicitId: "doc-1",
    routing: "tenant-1",
    apis,
  });
  assert.equal(apis.calls[0]?.op, "update");
  assert.deepEqual(apis.calls[0]?.args, ["doc-1", '{"title":"hello"}', "tenant-1"]);
});

test("writeDocumentStoreDocument put requires id", async () => {
  const apis = mockApis();
  await assert.rejects(
    () =>
      writeDocumentStoreDocument({
        kind: "elasticsearch",
        op: "put",
        document: { title: "x" },
        apis,
      }),
    /requires an id/,
  );
  assert.equal(apis.calls.length, 0);
});
