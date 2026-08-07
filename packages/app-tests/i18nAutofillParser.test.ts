import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vitest";

test("i18n autofill parses locale roots with imported shorthand sections", () => {
  const output = execFileSync(process.execPath, [".github/scripts/i18n-autofill.mjs", "--dry-run", "--base-ref", "HEAD"], {
    encoding: "utf8",
  });

  assert.match(output, /No new zh-CN i18n keys compared with HEAD/);
});
