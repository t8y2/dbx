import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  canFullHighlightRedisText,
  findRedisTextMatches,
  isTextContentSearchDragSource,
  nextRedisSearchMatchIndex,
  REDIS_VALUE_SEARCH_FULL_HIGHLIGHT_MAX_CHARS,
  REDIS_VALUE_SEARCH_MATCH_LIMIT,
  renderRedisTextSearchHtml,
  redisValueSearchStatus,
} from "../../apps/desktop/src/lib/redis/redisValueSearch.ts";

test("findRedisTextMatches is case-insensitive and limited", () => {
  const text = "alpha BETA alpha";
  assert.deepEqual(findRedisTextMatches(text, "ALPHA"), [
    { start: 0, end: 5 },
    { start: 11, end: 16 },
  ]);
  assert.equal(findRedisTextMatches(text, "alpha", 1).length, 1);
  assert.deepEqual(findRedisTextMatches("a+b aab", "a+b"), [{ start: 0, end: 3 }]);
});

test("findRedisTextMatches preserves offsets across Unicode case folding", () => {
  const text = "İabc";
  const matches = findRedisTextMatches(text, "ABC");

  assert.deepEqual(matches, [{ start: 1, end: 4 }]);
  assert.equal(text.slice(matches[0].start, matches[0].end), "abc");
  assert.match(renderRedisTextSearchHtml(text, "ABC", 0), />abc<\/mark>/);
});

test("navigation and status helpers", () => {
  assert.equal(nextRedisSearchMatchIndex(1, 1, 2), 0);
  assert.equal(redisValueSearchStatus(0, 0), "0/0");
  assert.equal(redisValueSearchStatus(0, REDIS_VALUE_SEARCH_MATCH_LIMIT, true), `1/${REDIS_VALUE_SEARCH_MATCH_LIMIT}+`);
  assert.equal(canFullHighlightRedisText(REDIS_VALUE_SEARCH_FULL_HIGHLIGHT_MAX_CHARS + 1), false);
  assert.match(renderRedisTextSearchHtml("hi <x>", "hi", 0), /document-search-match-active/);
});

test("drag source allows grip button, blocks input", () => {
  const fake = (hits: string[]) =>
    ({
      closest(sel: string) {
        return sel
          .split(",")
          .map((s) => s.trim())
          .some((s) => hits.includes(s))
          ? {}
          : null;
      },
    }) as unknown as Element;
  assert.equal(isTextContentSearchDragSource(fake(["[data-drag-handle]", "button"])), true);
  assert.equal(isTextContentSearchDragSource(fake(["input"])), false);
});

test("content find is for STRING + RedisJSON + member detail; hash toolbar search stays; no list filter", () => {
  const viewer = readFileSync(new URL("../../apps/desktop/src/components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
  const jsonEditor = readFileSync(new URL("../../apps/desktop/src/components/redis/RedisJsonEditor.vue", import.meta.url), "utf8");
  const browser = readFileSync(new URL("../../apps/desktop/src/components/redis/RedisKeyBrowser.vue", import.meta.url), "utf8");
  const documentBrowser = readFileSync(new URL("../../apps/desktop/src/components/document/DocumentBrowser.vue", import.meta.url), "utf8");

  assert.match(viewer, /valueSearchSupported/);
  // STRING, RedisJSON, or member detail.
  assert.match(viewer, /showMemberDetail\.value \|\| isStringLikeKind\.value \|\| redisKind\.value === "json"/);
  assert.match(viewer, /function openValueSearch/);
  assert.match(viewer, /function onHashSearch/);
  assert.match(viewer, /v-model="hashSearchQuery"/);
  assert.match(viewer, /data-redis-member-detail/);
  assert.match(viewer, /v-if="valueSearchOpen && showMemberDetail"/);
  assert.match(viewer, /ref="redisJsonEditorRef"/);
  assert.doesNotMatch(viewer, /filterRedisCollectionByQuery/);
  assert.doesNotMatch(viewer, /valueSearchIsCollectionMode/);
  // Builtin find is a prop defaulting to true; only value-viewer owned editors disable it.
  assert.match(jsonEditor, /enableBuiltinFind\?:/);
  assert.match(jsonEditor, /enableBuiltinFind:\s*true/);
  assert.match(viewer, /:enable-builtin-find="false"/);
  // DocumentBrowser must not pass enable-builtin-find=false (keeps CM find).
  assert.doesNotMatch(documentBrowser, /enable-builtin-find/);
  assert.match(browser, /valueViewerRef\.value\?\.focusSearch\(\)/);
});

test("find panel uses absolute positioning (dialog-safe, typeable)", () => {
  const bar = readFileSync(new URL("../../apps/desktop/src/components/common/TextContentSearchBar.vue", import.meta.url), "utf8");
  assert.doesNotMatch(bar, /<Teleport/);
  assert.doesNotMatch(bar, /class="[^"]*\bfixed\b/);
  assert.match(bar, /absolute right-3 top-3/);
  assert.match(bar, /data-draggable-search-panel/);
  // Input must stop propagation so panel drag handler never captures typing clicks.
  assert.match(bar, /@pointerdown\.stop/);
  assert.match(bar, /@mousedown\.stop/);
  // Esc must not bubble to Dialog (would close member detail).
  assert.match(bar, /@keydown\.escape\.prevent\.stop/);
});

test("find input must keep focus while typing (no focus:true on body scroll)", () => {
  const viewer = readFileSync(new URL("../../apps/desktop/src/components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
  // Navigation/scroll must not steal focus into the value body.
  assert.match(viewer, /focus:\s*false/);
  assert.doesNotMatch(viewer, /scrollContentSearchMatchIntoView\(\{\s*focus:\s*true/);
  assert.doesNotMatch(viewer, /textarea\.focus\(/);
});

test("focusSearch works for open member detail without prior pointer activation", () => {
  const viewer = readFileSync(new URL("../../apps/desktop/src/components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
  assert.match(viewer, /!showMemberDetail\.value\) return false/);
  assert.match(viewer, /function focusSearch/);
});
