import assert from "node:assert/strict";
import { test } from "vitest";
import { applyMongoGridChangesToDocument, buildMongoCopyDocumentFromOriginal, buildMongoCopyInsertDocument, buildMongoInsertDocument, buildMongoUpdateDocument, formatMongoShellLiteral, mongoDocumentIdForGrid, parseMongoDocumentInputValue, serializeMongoDocumentId } from "../../apps/desktop/src/lib/mongo/mongoDocumentValues.ts";

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

test("preserves unsafe Mongo int64 input values without JavaScript rounding", () => {
  assert.deepEqual(parseMongoDocumentInputValue("2048938405781032962"), { $numberLong: "2048938405781032962" });
  assert.equal(parseMongoDocumentInputValue("9007199254740991"), 9007199254740991);
  assert.equal(parseMongoDocumentInputValue("9223372036854775808"), "9223372036854775808");
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

test("preserves JSON-shaped strings when updating existing Mongo fields", () => {
  const original = {
    _id: "1",
    answer: '{"action":"New","values":[1]}',
    tagsText: '["draft"]',
    profile: { role: "admin" },
  };
  const changes = new Map<number, string | number | boolean | null>([
    [1, '{\n  "action": "Updated",\n  "values": [\n    1,\n    2\n  ]\n}'],
    [2, '[\n  "published"\n]'],
    [3, '{"role":"maintainer"}'],
  ]);

  const update = buildMongoUpdateDocument(changes, ["_id", "answer", "tagsText", "profile"], original);

  assert.deepEqual(update, {
    $set: {
      answer: '{\n  "action": "Updated",\n  "values": [\n    1,\n    2\n  ]\n}',
      tagsText: '[\n  "published"\n]',
      profile: { role: "maintainer" },
    },
  });
  assert.equal(formatMongoShellLiteral(update), '{"$set":{"answer":"{\\n  \\"action\\": \\"Updated\\",\\n  \\"values\\": [\\n    1,\\n    2\\n  ]\\n}","tagsText":"[\\n  \\"published\\"\\n]","profile":{"role":"maintainer"}}}');
});

test("preserves existing Mongo strings that resemble typed literals", () => {
  const original = {
    _id: "1",
    numericText: "42",
    booleanText: "true",
    dateText: 'ISODate("2026-01-01T00:00:00.000Z")',
    quotedText: '"literal"',
  };
  const changes = new Map<number, string | number | boolean | null>([
    [1, "43"],
    [2, "false"],
    [3, 'ISODate("2026-02-01T00:00:00.000Z")'],
    [4, '"changed"'],
  ]);

  assert.deepEqual(buildMongoUpdateDocument(changes, ["_id", "numericText", "booleanText", "dateText", "quotedText"], original), {
    $set: {
      numericText: "43",
      booleanText: "false",
      dateText: 'ISODate("2026-02-01T00:00:00.000Z")',
      quotedText: '"changed"',
    },
  });
});

test("keeps JSON inference for fields without an existing Mongo type", () => {
  const changes = new Map<number, string | number | boolean | null>([
    [1, '{"enabled":true}'],
    [2, "42"],
  ]);

  assert.deepEqual(buildMongoUpdateDocument(changes, ["_id", "newObject", "newNumber"], { _id: "1" }), {
    $set: {
      newObject: { enabled: true },
      newNumber: 42,
    },
  });
});

test("applies saved Mongo grid changes to the raw preview document", () => {
  const original = {
    _id: "1",
    name: "Ada",
    profile: { role: "admin" },
    archivedAt: "2026-01-01",
  };
  const changes = new Map<number, string | number | boolean | null>([
    [1, "Lin"],
    [2, '{"role":"maintainer"}'],
    [3, null],
  ]);

  assert.deepEqual(applyMongoGridChangesToDocument(original, changes, ["_id", "name", "profile", "archivedAt"]), {
    _id: "1",
    name: "Lin",
    profile: { role: "maintainer" },
  });
  assert.deepEqual(original, {
    _id: "1",
    name: "Ada",
    profile: { role: "admin" },
    archivedAt: "2026-01-01",
  });
});

test("applies Mongo grid edits without converting existing JSON strings", () => {
  const original = {
    _id: "1",
    answer: '{"action":"New"}',
    profile: { role: "admin" },
  };
  const changes = new Map<number, string | number | boolean | null>([
    [1, '{\n  "action": "Updated"\n}'],
    [2, '{"role":"maintainer"}'],
  ]);

  assert.deepEqual(applyMongoGridChangesToDocument(original, changes, ["_id", "answer", "profile"]), {
    _id: "1",
    answer: '{\n  "action": "Updated"\n}',
    profile: { role: "maintainer" },
  });
});

test("builds Mongo inserts with parsed date values", () => {
  assert.deepEqual(buildMongoInsertDocument(["ignored", 'new Date("2026-06-10T13:59:31.287Z")'], ["_id", "createdAt"]), {
    createdAt: { $date: "2026-06-10T13:59:31.287Z" },
  });
});

test("builds Mongo copy inserts with ObjectId and parsed document values", () => {
  assert.deepEqual(buildMongoCopyInsertDocument(["6743e4bfa3f6f84bc3fff6c8", "577", '{"endingBalance":{"beginningBalance":"0"},"Line":[]}', 'ISODate("2024-11-25T02:45:36.184Z")'], ["_id", "accountId", "data", "lastUpdatedDate"]), {
    _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
    accountId: 577,
    data: {
      endingBalance: {
        beginningBalance: "0",
      },
      Line: [],
    },
    lastUpdatedDate: { $date: "2024-11-25T02:45:36.184Z" },
  });
});

test("builds Mongo copy inserts without primary keys when requested", () => {
  assert.deepEqual(buildMongoCopyInsertDocument(["6743e4bfa3f6f84bc3fff6c8", "done"], ["_id", "status"], { excludePrimaryKeys: true }), {
    status: "done",
  });
});

test("projects original Mongo values without guessing types", () => {
  const original = {
    _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
    numericText: "123",
    booleanText: "true",
    jsonText: '{"kind":"literal"}',
    dateText: "2024-01-01 00:00:00",
    profile: { role: "admin" },
    hidden: "not selected",
  };

  assert.deepEqual(
    buildMongoCopyDocumentFromOriginal(original, ["ignored", "ignored", "ignored", "ignored", "ignored"], ["numericText", "booleanText", "jsonText", "dateText", "profile"], [false, false, false, false, false]),
    {
      numericText: "123",
      booleanText: "true",
      jsonText: '{"kind":"literal"}',
      dateText: "2024-01-01 00:00:00",
      profile: { role: "admin" },
    },
  );
});

test("applies only explicit Mongo grid edits to copied original documents", () => {
  assert.deepEqual(
    buildMongoCopyDocumentFromOriginal({ _id: "1", count: "123", profile: { role: "admin" } }, ["1", "456", '{"role":"maintainer"}'], ["_id", "count", "profile"], [false, true, false], { excludePrimaryKeys: true }),
    {
      count: 456,
      profile: { role: "admin" },
    },
  );
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

test("serializes typed Mongo document ids while keeping their grid display compact", () => {
  const id = { $numberLong: "2048938405781032962" };
  assert.equal(serializeMongoDocumentId(id), '{"$numberLong":"2048938405781032962"}');
  assert.equal(mongoDocumentIdForGrid(id), "2048938405781032962");
  assert.equal(serializeMongoDocumentId("2048938405781032962"), '__dbx_mongo_string_id__"2048938405781032962"');
  assert.equal(serializeMongoDocumentId('{"$numberLong":"2048938405781032962"}'), '__dbx_mongo_string_id__"{\\"$numberLong\\":\\"2048938405781032962\\"}"');
});

test("formats extended JSON int64 values as Mongo shell NumberLong literals", () => {
  assert.equal(formatMongoShellLiteral({ snowflake: { $numberLong: "9007199254740993" } }), '{"snowflake":NumberLong("9007199254740993")}');
});
