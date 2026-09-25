import assert from "node:assert/strict";
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
