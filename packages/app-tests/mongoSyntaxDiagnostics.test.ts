import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { buildMongoSyntaxDiagnostics, shouldRunMongoDiagnostics } from "../../apps/desktop/src/lib/mongo/mongoSyntaxDiagnostics";

/** The exact text a diagnostic underlines, so span placement is asserted and not just line numbers. */
function underlined(source: string, cursor = -1): Array<{ severity: string; text: string; message: string }> {
  const lines = source.split("\n");
  return buildMongoSyntaxDiagnostics(source, cursor).map((diagnostic) => {
    const { span } = diagnostic;
    const text =
      span.start_line === span.end_line ? lines[span.start_line - 1]!.slice(span.start_column - 1, span.end_column) : [lines[span.start_line - 1]!.slice(span.start_column - 1), ...lines.slice(span.start_line, span.end_line - 1), lines[span.end_line - 1]!.slice(0, span.end_column)].join("\n");
    return { severity: diagnostic.severity, text, message: diagnostic.message };
  });
}

test("valid commands and comments produce no diagnostics", () => {
  for (const source of ["db.reports.find({a: 1})", 'db["my-coll"].updateOne({a: 1}, {$set: {b: 2}}, {upsert: true})', "// just a note", "db.a.find({});\ndb.b.countDocuments({})", ""]) {
    assert.deepEqual(buildMongoSyntaxDiagnostics(source), [], source);
  }
});

test("underlines the offending value constructor and names the argument", () => {
  const [single] = underlined('db.reports.find({id: Foo("x")})');
  assert.equal(single?.severity, "error");
  assert.equal(single?.text, 'Foo("x")');
  assert.match(single!.message, /Unsupported value Foo\(\.\.\.\) in the filter argument of find\(\)/);

  // Works across lines and through `new`, and finds the call inside a nested document.
  const [nested] = underlined("db.reports.updateOne(\n  { phone: '+84' },\n  { $set: { t: new Bar(1) } }\n)");
  assert.equal(nested?.text, "Bar(1)");
  assert.match(nested!.message, /update argument of updateOne\(\)/);
});

test("underlines the update operator in a replaceOne replacement", () => {
  const [diagnostic] = underlined("db.reports.replaceOne({a: 1}, {$set: {b: 2}})");
  assert.equal(diagnostic?.text, "$set");
  assert.match(diagnostic!.message, /use updateOne\(\)/);
});

test("underlines the command head for unsupported methods and wrong argument shapes", () => {
  const [unsupported] = underlined('db.reports.mapReduce("x")');
  assert.equal(unsupported?.text, "db.reports.mapReduce");
  assert.match(unsupported!.message, /mapReduce\(\) is not supported/);

  const [shape] = underlined("db.reports.insertOne({a: 1}, {writeConcern: {w: 1}})");
  assert.equal(shape?.text, "db.reports.insertOne");
  assert.equal(shape?.message, "insertOne() expects one document.");

  const [dbLevel] = underlined("db.adminCommand({ping: 1})");
  assert.equal(dbLevel?.text, "db.adminCommand");
});

test("warns about writes with no effective filter and about dropping a collection", () => {
  const [every] = underlined("db.reports.deleteMany({})");
  assert.equal(every?.severity, "warning");
  assert.equal(every?.text, "db.reports.deleteMany");
  assert.match(every!.message, /every document in reports/);

  const [arbitrary] = underlined("db.reports.updateOne({}, {$set: {a: 1}})");
  assert.match(arbitrary!.message, /an arbitrary document in reports/);
  assert.match(underlined("db.reports.replaceOne({_id: {$exists: true}}, {a: 1})")[0]!.message, /replace .* arbitrary document/);
  assert.match(underlined("db.reports.drop()")[0]!.message, /drops the reports collection/);
  assert.equal(underlined('db.getCollection("my-coll").drop()')[0]?.text, 'db.getCollection("my-coll").drop');

  assert.match(underlined("db.reports.bulkWrite([{ insertOne: { document: { a: 1 } } }, { deleteMany: { filter: {} } }])")[0]!.message, /bulkWrite contains an operation with no effective filter/);

  // Wrapping the command in getSiblingDB() does not hide it.
  const [sibling] = underlined('db.getSiblingDB("archive").reports.deleteMany({})');
  assert.equal(sibling?.severity, "warning");
  assert.equal(sibling?.text, 'db.getSiblingDB("archive").reports.deleteMany');
  assert.match(sibling!.message, /every document in reports/);

  // A bounded write is not a warning.
  assert.deepEqual(buildMongoSyntaxDiagnostics("db.reports.deleteMany({status: 'stale'})"), []);
  assert.deepEqual(buildMongoSyntaxDiagnostics("db.reports.bulkWrite([{ deleteMany: { filter: { status: 'stale' } } }])"), []);
  assert.deepEqual(buildMongoSyntaxDiagnostics('db.getSiblingDB("archive").reports.deleteMany({status: "stale"})'), []);
});

test("warns about find-and-modify commands with no effective filter", () => {
  for (const [source, action] of [
    ["db.reports.findOneAndUpdate({}, {$set: {status: 'archived'}})", "update"],
    ["db.reports.findOneAndReplace({}, {status: 'archived'})", "replace"],
    ["db.reports.findOneAndDelete({})", "delete"],
  ] as const) {
    const [diagnostic] = underlined(source);
    assert.equal(diagnostic?.severity, "warning", source);
    assert.match(diagnostic!.message, new RegExp(`${action} an arbitrary document in reports`), source);
  }

  for (const source of ["db.reports.findOneAndUpdate({_id: 1}, {$set: {status: 'archived'}})", "db.reports.findOneAndReplace({_id: 1}, {status: 'archived'})", "db.reports.findOneAndDelete({_id: 1})"]) {
    assert.deepEqual(buildMongoSyntaxDiagnostics(source), [], source);
  }
});

test("reports each statement separately", () => {
  const diagnostics = underlined("db.a.find({});\ndb.b.foo();\ndb.c.find({})");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.text, "db.b.foo");
});

test("does not flag a command the cursor is still typing", () => {
  const typing = "db.reports.find({a: 1";
  assert.deepEqual(buildMongoSyntaxDiagnostics(typing, typing.length), []);
  assert.deepEqual(buildMongoSyntaxDiagnostics(`${typing}\n`, typing.length + 1), []);
  assert.equal(shouldRunMongoDiagnostics(typing, typing.length), false);

  // Once the cursor has left it, an unclosed command is an error.
  assert.equal(shouldRunMongoDiagnostics("db.reports.find({a: 1})", 23), true);
  const [left] = underlined(typing, -1);
  assert.equal(left?.severity, "error");
  assert.match(left!.message, /unclosed/i);
  assert.equal(shouldRunMongoDiagnostics("", 0), false);
});

test("keeps completed diagnostics while the cursor is in an unfinished command", () => {
  const source = "db.a.deleteMany({});\ndb.b.find({";
  const [diagnostic] = underlined(source, source.length);
  assert.equal(diagnostic?.severity, "warning");
  assert.equal(diagnostic?.text, "db.a.deleteMany");
  assert.match(diagnostic!.message, /every document in a/);

  const unfinished = underlined(source, 0).find((diagnostic) => diagnostic.severity === "error");
  assert.match(unfinished!.message, /unclosed/i);

  const queryEditorSource = readFileSync("apps/desktop/src/components/editor/QueryEditor.vue", "utf8");
  const mongoBranch = queryEditorSource.slice(queryEditorSource.indexOf('if (props.databaseType === "mongodb")'), queryEditorSource.indexOf('if (props.databaseType === "redis")'));
  assert.doesNotMatch(mongoBranch, /shouldRunMongoDiagnostics/);
  assert.match(mongoBranch, /setSemanticDiagnostics\(buildMongoSyntaxDiagnostics\(sql, cursor\)\)/);
});
