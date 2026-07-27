import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("connection dialog accessibility", () => {
  it("moves initial focus to an input inside the dialog", () => {
    expect(dialogSource).toContain('<Input v-model="dbSearchQuery" v-connection-dialog-auto-focus');
    expect(dialogSource).toContain('<Input v-model="form.name" v-connection-dialog-auto-focus');
    expect(dialogSource).toContain("const vConnectionDialogAutoFocus: ObjectDirective<HTMLInputElement>");
    expect(dialogSource).toContain("input.focus({ preventScroll: true })");
    expect(dialogSource).not.toMatch(/<DialogContent[^>]*\stabindex="-1"/);
  });

  it("reserves focus ring space around the scrollable category navigation", () => {
    const nav = dialogSource.match(/<nav data-connection-category-nav class="([^"]+)"/)?.[1] ?? "";

    expect(nav).toContain("px-0.5");
    expect(nav).toContain("pt-0.5");
    expect(nav).toContain("sm:py-0.5");
  });
});
