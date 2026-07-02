import assert from "node:assert/strict";
import { test } from "vitest";
import { buildMongoCopyInsertDocument, buildMongoInsertDocument, buildMongoUpdateDocument, formatMongoShellLiteral, parseMongoDocumentInputValue } from "../../apps/desktop/src/lib/mongoDocumentValues.ts";

test("parses Mongo shell ISODate literals as extended JSON dates", () => {
  assert.deepEqual(parseMongoDocumentInputValue('ISODate("2026-06-10T13:59:31.287Z")'), {
    $date: "2026-06-10T13:59:31.287Z",
  });
  assert.deepEqual(parseMongoDocumentInputValue('"ISODate(\\"2026-06-10T13:59:31.287Z\\")"'), {
    $date: "2026-06-10T13:59:31.287Z",
  });
});

test("parses legacy Mongo date display values as UTC dates", () => {
  assert.deepEqual(parseMongoDocumentInputValue("2025-08-14 02:25:43.718"), {
    $date: "2025-08-14T02:25:43.718Z",
  });
  assert.equal(parseMongoDocumentInputValue('"2025-08-14 02:25:43.718"'), "2025-08-14 02:25:43.718");
});

test("builds Mongo grid updates with set and unset operators", () => {
  const changes = new Map<number, string | number | boolean | null>([
    [1, "Ada"],
    [2, 'ISODate("2026-06-10T13:59:31.287Z")'],
    [3, null],
  ]);

  assert.deepEqual(buildMongoUpdateDocument(changes, ["_id", "name", "createdAt", "archivedAt"]), {
    $set: {
      name: "Ada",
      createdAt: { $date: "2026-06-10T13:59:31.287Z" },
    },
    $unset: {
      archivedAt: "",
    },
  });
});

test("builds Mongo inserts with parsed date values", () => {
  assert.deepEqual(buildMongoInsertDocument(["ignored", 'new Date("2026-06-10T13:59:31.287Z")'], ["_id", "createdAt"]), {
    createdAt: { $date: "2026-06-10T13:59:31.287Z" },
  });
});

test("builds Mongo copy inserts with ObjectId and parsed document values", () => {
  assert.deepEqual(
    buildMongoCopyInsertDocument(
      ["6743e4bfa3f6f84bc3fff6c8", "577", '{"endingBalance":{"beginningBalance":"0"},"Line":[]}', 'ISODate("2024-11-25T02:45:36.184Z")'],
      ["_id", "accountId", "data", "lastUpdatedDate"],
    ),
    {
      _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
      accountId: 577,
      data: {
        endingBalance: {
          beginningBalance: "0",
        },
        Line: [],
      },
      lastUpdatedDate: { $date: "2024-11-25T02:45:36.184Z" },
    },
  );
});

test("builds Mongo copy inserts without primary keys when requested", () => {
  assert.deepEqual(buildMongoCopyInsertDocument(["6743e4bfa3f6f84bc3fff6c8", "done"], ["_id", "status"], { excludePrimaryKeys: true }), {
    status: "done",
  });
});

test("formats extended JSON dates as Mongo shell ISODate literals", () => {
  assert.equal(
    formatMongoShellLiteral({
      $set: {
        createdAt: { $date: "2026-06-10T13:59:31.287Z" },
      },
    }),
    '{"$set":{"createdAt":ISODate("2026-06-10T13:59:31.287Z")}}',
  );
});

test("formats extended JSON object ids as Mongo shell ObjectId literals", () => {
  assert.equal(formatMongoShellLiteral({ $oid: "6743e4bfa3f6f84bc3fff6c8" }), 'ObjectId("6743e4bfa3f6f84bc3fff6c8")');
});
