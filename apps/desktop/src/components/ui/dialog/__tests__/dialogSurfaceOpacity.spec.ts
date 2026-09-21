import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIALOG_SHELLS = ["DialogContent.vue", "DialogScrollContent.vue"] as const;

function dialogShellSource(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("dialog shell surfaces", () => {
  // While a wallpaper is active --background (and the other root surfaces) are
  // tinted with alpha, so a dialog painted with bg-background lets the image
  // bleed through its body. Card/popover surfaces stay opaque on purpose.
  it.each(DIALOG_SHELLS)("%s paints its surface with an opaque token", (file) => {
    const source = dialogShellSource(file);

    expect(source).toContain('data-slot="dialog-content"');
    expect(source).toMatch(/\bbg-(popover|card)\b/);
    expect(source).not.toMatch(/\bbg-background\b/);
  });
});
