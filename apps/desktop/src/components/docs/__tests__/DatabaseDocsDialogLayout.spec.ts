import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DatabaseDocsDialog.vue", import.meta.url), "utf8");

describe("DatabaseDocsDialog layout", () => {
  it("reserves header space for the absolute close button", () => {
    expect(dialogSource).toMatch(/<DialogHeader class="[^"]*\bpr-12\b[^"]*">/);
  });
});
