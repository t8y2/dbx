import { strict as assert } from "node:assert";
import { test } from "vitest";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR } from "../../apps/desktop/src/lib/editorThemes.ts";
import { documentViewerFontStyle } from "../../apps/desktop/src/lib/documentViewerFontStyle.ts";

test("document viewer font style follows editor font settings", () => {
  assert.deepEqual(
    documentViewerFontStyle({
      fontFamily: "'Cascadia Code', monospace",
      fontSize: 16,
    }),
    {
      [EDITOR_FONT_FAMILY_CSS_VAR]: "'Cascadia Code', monospace",
      [EDITOR_FONT_SIZE_CSS_VAR]: "16px",
    },
  );
});
