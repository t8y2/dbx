// Loaded by mongo-workbench-smoke.cjs: pure in-process fixtures, never a database connection.
module.exports = function registerMigrationSmoke(test, assert, load) {
  const migration = load("mongoMigration");
  const map = (source, target, extra = {}) => ({ source, target, type: "auto", array: "reject", missing: "error", ...extra });
  const endpoint = { connectionId: "fixture", database: "fixture", schema: "", table: "target", dialect: "postgres" };
  const col = (name, data_type, extra = {}) => ({ name, data_type, is_nullable: true, column_default: null, is_primary_key: false, extra: null, ...extra });
  test("migration SQL to BSON nested mapping preserves exact numbers", () => {
    const rows = migration.sqlRowsToMongo({ columns: ["id", "amount"], column_types: ["bigint", "numeric"], rows: [["9223372036854775807", "12345678901234567890.1234"]] }, [map("id", "_id"), map("amount", "payment.amount")]);
    assert.deepEqual(rows, [{ _id: { $numberLong: "9223372036854775807" }, payment: { amount: { $numberDecimal: "12345678901234567890.1234" } } }]);
    assert.deepEqual(JSON.parse(migration.migrationMongoOperations(rows, "fixture")[0].text).documents, rows);
    for (const value of [9007199254740992, Infinity]) assert.throws(() => migration.sqlRowsToMongo({ columns: ["n"], rows: [[value]] }, [map("n", "n")]));
    assert.throws(() => migration.sqlRowsToMongo({ columns: ["n"], column_types: ["numeric"], rows: [[0.1]] }, [map("n", "n", { type: "string" })]));
    for (const value of ['{"n":9007199254740993}', '{"n":0.1234567890123456789}']) assert.throws(() => migration.sqlRowsToMongo({ columns: ["n"], rows: [[value]] }, [map("n", "n", { type: "ejson" })]));
  });
  test("migration Mongo flatten, array policy and precision validation", () => {
    const input = [{ nested: { n: { $numberLong: "9223372036854775807" } }, items: [{ $numberDecimal: "0.1234567890123456789" }] }];
    const rows = migration.mongoRowsToSql(input, [map("nested.n", "n"), map("items", "payload", { type: "ejson", array: "json" })]);
    assert.equal(rows[0].payload, JSON.stringify(input[0].items));
    assert.equal(migration.migrationSqlOperations(rows, endpoint, [col("n", "bigint"), col("payload", "text")])[0].text.includes("9223372036854775807"), true);
    assert.throws(() => migration.mongoRowsToSql(input, [map("items", "n")]));
    assert.throws(() => migration.migrationSqlOperations([{ n: { $numberDecimal: "123.456" } }], endpoint, [col("n", "numeric", { numeric_precision: 5, numeric_scale: 2 })]));
    assert.throws(() => migration.migrationSqlOperations([{ n: { $numberLong: "9223372036854775808" } }], endpoint, [col("n", "bigint")]));
    for (const path of ["__proto__.x", "a.constructor", "$set.x", "a.*"]) assert.throws(() => migration.validateMigrationMappings([map("x", path)], "sqlToMongo"));
    assert.throws(() => migration.validateMigrationMappings([map("x", "a"), map("y", "a.b")], "sqlToMongo"));
    assert.equal(migration.migrationReadSql({ ...endpoint, table: 'x";DELETE FROM x;--' }, 2), 'SELECT * FROM "x"";DELETE FROM x;--" LIMIT 3;');
  });
  test("migration text is SQL-mode independent and SQLite isolated roundtrip", () => {
    const value = "'\\'; DELETE FROM fixture;-- 中文";
    const rows = [{ payload: value }];
    for (const dialect of ["postgres", "mysql", "sqlite"]) assert.equal(migration.migrationSqlOperations(rows, { ...endpoint, dialect }, [col("payload", "text")])[0].text.includes("DELETE FROM"), false);
    // Node's embedded SQLite uses :memory: only; no external/user database is accessed.
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec('CREATE TABLE target (payload TEXT, n INTEGER)');
      const sql = migration.migrationSqlOperations([{ payload: value, n: { $numberLong: "9223372036854775807" } }], { ...endpoint, dialect: "sqlite" }, [col("payload", "text"), col("n", "integer")])[0].text;
      db.exec(sql);
      const result = db.prepare('SELECT payload, CAST(n AS TEXT) AS n FROM target').get();
      assert.equal(result.payload, value); assert.equal(result.n, "9223372036854775807");
    } finally { db.close(); }
  });
  test("migration cancellation and uncertain writes never auto-retry", async () => {
    const operations = migration.migrationMongoOperations([{ _id: 1 }, { _id: 2 }, { _id: 3 }], "fixture");
    const controller = new AbortController(); let calls = 0;
    assert.deepEqual(await migration.executeMigrationOperations(operations, async () => { calls++; controller.abort(); }, { signal: controller.signal }), { completed: 1, total: 3, status: "cancelled" });
    assert.equal(calls, 1); calls = 0;
    const result = await migration.executeMigrationOperations(operations, async () => { calls++; if (calls === 2) throw new Error("network lost"); });
    assert.deepEqual(result, { completed: 1, total: 3, status: "failed", uncertainIndex: 2, error: "network lost" }); assert.equal(calls, 2);
    const blocked = await migration.executeMigrationOperations(operations, async () => { calls++; }, { beforeWrite: () => { throw new Error("read only"); } });
    assert.equal(blocked.completed, 0); assert.equal(blocked.uncertainIndex, undefined); assert.equal(calls, 2);
    for (const response of [{ ok: 1, n: 0 }, { ok: 1, n: 1, writeErrors: [{}] }, { ok: 1, n: 1, writeConcernError: {} }, null]) assert.throws(() => migration.assertMigrationMongoAck(response));
    migration.assertMigrationMongoAck({ ok: { $numberDouble: "1.0" }, n: { $numberInt: "1" } });
  });
};
