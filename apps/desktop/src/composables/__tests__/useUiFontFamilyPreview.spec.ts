import { beforeEach, describe, expect, it } from "vitest";
import { useUiFontFamilyPreview } from "@/composables/useUiFontFamilyPreview";

describe("useUiFontFamilyPreview", () => {
  beforeEach(() => {
    useUiFontFamilyPreview().clearUiFontFamilyPreview();
  });

  it("keeps a temporary font preview separate from the saved setting", () => {
    const preview = useUiFontFamilyPreview();

    preview.previewUiFontFamily("'Preview Sans', sans-serif");
    expect(preview.uiFontFamilyPreview.value).toBe("'Preview Sans', sans-serif");

    preview.clearUiFontFamilyPreview();
    expect(preview.uiFontFamilyPreview.value).toBeNull();
  });

  it("ignores empty font values", () => {
    const preview = useUiFontFamilyPreview();

    preview.previewUiFontFamily("   ");
    expect(preview.uiFontFamilyPreview.value).toBeNull();
  });
});
