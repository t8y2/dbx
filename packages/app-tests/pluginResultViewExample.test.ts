import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const helloWorkbenchSource = readFileSync("plugins/examples/hello-workbench/ui/index.html", "utf8");

test("hello-workbench forwards the result schema when rerunning a query", () => {
  const queryDataCall = /window\.dbxPlugin\.queryData\(\{([\s\S]*?)\}\)/.exec(helloWorkbenchSource);

  assert.ok(queryDataCall);
  assert.match(queryDataCall[1], /schema:\s*resultContext\.schema \|\| undefined/);
});
