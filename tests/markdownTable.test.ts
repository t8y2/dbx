import { strict as assert } from "node:assert";
import test from "node:test";
import { formatMarkdownTable } from "../src/lib/markdownTable.ts";

test("escapes markdown table pipes and normalizes newlines", () => {
  const markdown = formatMarkdownTable({
    columns: ["id", "payload|kind"],
    rows: [
      [1, "a|b"],
      [2, "line one\nline two"],
    ],
  });

  assert.equal(markdown, [
    "| id  | payload\\|kind        |",
    "| --- | -------------------- |",
    "| 1   | a\\|b                 |",
    "| 2   | line one<br>line two |",
    "",
  ].join("\n"));
});
