import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../../apps/desktop/src/styles/globals.css", import.meta.url), "utf8");

function readDarkPalette() {
  const match = globalsCss.match(/\.dark\s*\{(?<body>[\s\S]*?)\n\}/);
  assert.ok(match?.groups?.body, "expected globals.css to define a .dark palette");

  return Object.fromEntries(
    [...match.groups.body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

test("dark app palette uses IDEA-style low-glare surfaces", () => {
  const palette = readDarkPalette();

  assert.equal(palette.background, "#2b2d30");
  assert.equal(palette.foreground, "#c9d1d9");
  assert.equal(palette.card, "#313335");
  assert.equal(palette.popover, "#313335");
  assert.equal(palette.border, "#45484a");
  assert.equal(palette.sidebar, "#252629");
  assert.equal(palette["muted-foreground"], "#9aa0a6");
});
