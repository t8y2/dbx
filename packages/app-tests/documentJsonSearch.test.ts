import assert from "node:assert/strict";
import { test } from "vitest";

import { findDocumentTextMatches, renderDocumentJsonHtml } from "../../apps/desktop/src/lib/document/documentJsonSearch.ts";

test("findDocumentTextMatches finds case-insensitive document matches", () => {
  assert.deepEqual(findDocumentTextMatches('"City": "Shanghai", "backupCity": "shanghai"', "SHANGHAI"), [
    { start: 9, end: 17 },
    { start: 35, end: 43 },
  ]);
});

test("renderDocumentJsonHtml keeps syntax highlighting and marks the active match", () => {
  const html = renderDocumentJsonHtml('{"profile":{"city":"Shanghai"}}', "city", 0);

  assert.match(html, /json-key/);
  assert.match(html, /document-search-match-active/);
  assert.match(html, /data-document-search-active="true"/);
  assert.match(html, />city</);
});

test("renderDocumentJsonHtml escapes document content", () => {
  const html = renderDocumentJsonHtml('{"value":"<script>"}');

  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});
