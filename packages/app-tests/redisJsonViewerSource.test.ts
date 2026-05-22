import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createRedisShikiJsonHighlighter } from "../../apps/desktop/src/lib/redisJsonHighlighter.ts";

const redisViewerSource = readFileSync(
  join(process.cwd(), "apps/desktop/src/components/redis/RedisValueViewer.vue"),
  "utf8",
);
const jsonTreeSource = readFileSync(join(process.cwd(), "apps/desktop/src/components/redis/RedisJsonTree.vue"), "utf8");

test("Redis string values expose JSON and raw content views", () => {
  assert.match(redisViewerSource, /stringValueDetail/);
  assert.match(redisViewerSource, /stringValueView === 'json'/);
  assert.match(redisViewerSource, /RedisJsonTree/);
  assert.match(redisViewerSource, /redis\.jsonView/);
  assert.match(redisViewerSource, /redis\.rawContent/);
});

test("Redis JSON tree supports folding and word wrap", () => {
  assert.match(jsonTreeSource, /collapsedPaths/);
  assert.match(jsonTreeSource, /toggleCollapsed/);
  assert.match(jsonTreeSource, /wordWrap/);
  assert.match(jsonTreeSource, /ChevronRight/);
  assert.match(jsonTreeSource, /ChevronDown/);
});

test("Redis JSON raw content uses Shiki highlighting safely", async () => {
  assert.match(redisViewerSource, /createRedisShikiJsonHighlighter/);
  assert.match(redisViewerSource, /:highlight-json="highlightRedisJson"/);
  assert.match(redisViewerSource, /v-html="memberRawJsonHtml"/);

  const highlight = await createRedisShikiJsonHighlighter({ appearance: () => "dark" });
  const html = highlight('{"name":"<script>","active":true}');

  assert.match(html, /style=/);
  assert.match(html, /(?:&lt;|&#x3C;)script(?:&gt;|>)/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<pre/);
});

test("Redis collection and stream values are virtualized", () => {
  assert.match(redisViewerSource, /RecycleScroller/);
  assert.match(redisViewerSource, /DynamicScroller/);
  assert.match(redisViewerSource, /:items="collectionRows"/);
  assert.match(redisViewerSource, /:items="streamRows"/);
  assert.doesNotMatch(redisViewerSource, /v-for="\(item, idx\) in collectionItems"/);
  assert.doesNotMatch(redisViewerSource, /v-for="entry in data\.value"/);
});
