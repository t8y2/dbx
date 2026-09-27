import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_IMAGE_SURFACE_VARS } from "@/lib/app/appBackgroundImage";

/**
 * While a wallpaper is active the app republishes `--background` (and the other
 * surface tokens) with the configured alpha, so a dialog that paints itself with
 * `bg-background` turns translucent and its text becomes hard to read. These
 * dialogs used to override the opaque `bg-popover` surface with `!bg-background`,
 * so they are pinned to `bg-background-solid` here.
 */
const DIALOG_SOURCES = {
  "codeSnapshot/CodeSnapshotDialog.vue": "../../../components/codeSnapshot/CodeSnapshotDialog.vue",
  "grid/GridSnapshotDialog.vue": "../../../components/grid/GridSnapshotDialog.vue",
  "editor/DelimitedListDialog.vue": "../../../components/editor/DelimitedListDialog.vue",
  "editor/SqlParameterDialog.vue": "../../../components/editor/SqlParameterDialog.vue",
  "objects/ProcedureExecutionDialog.vue": "../../../components/objects/ProcedureExecutionDialog.vue",
} as const;

describe("dialog surfaces under a wallpaper", () => {
  it("keeps --background in the translucent wallpaper surface set", () => {
    expect(BACKGROUND_IMAGE_SURFACE_VARS).toContain("--background");
  });

  for (const [label, relativePath] of Object.entries(DIALOG_SOURCES)) {
    it(`${label} paints an opaque surface`, () => {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      const dialogContentClasses = Array.from(source.matchAll(/<DialogContent\b[^>]*class="([^"]*)"/g), (match) => match[1]);
      expect(dialogContentClasses.length).toBeGreaterThan(0);
      for (const classes of dialogContentClasses) {
        expect(classes).toContain("bg-background-solid");
        expect(classes).not.toMatch(/(^|\s)!bg-background(\s|$)/);
      }
    });
  }
});
