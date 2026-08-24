import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const browserSource = readFileSync(new URL("../KvKeyBrowser.vue", import.meta.url), "utf8");

describe("KvKeyBrowser Base64 UTF-8 preview", () => {
  it("keeps the preview opt-in for backend-specific wrappers", () => {
    expect(browserSource).toContain("enableBase64Utf8Preview?: boolean");
    expect(browserSource).toContain("enableBase64Utf8Preview: false");
  });

  it("copies the selected derived view while preserving the raw value path", () => {
    expect(browserSource).toContain("selectedValueClipboardText");
    expect(browserSource).toContain("copyToClipboard(selectedValueClipboardText.value)");
    expect(browserSource.match(/selectedBase64ViewMode\.value = "utf8"/g)).toHaveLength(2);
    expect(browserSource).toContain("editValue.value = selectedTextValue.value");
    expect(browserSource).toContain("value: selectedValue.value.value");
  });

  it("offers explicit UTF-8 and Base64 view controls with error feedback", () => {
    expect(browserSource).toContain('data-testid="kv-base64-utf8-view"');
    expect(browserSource).toContain('data-testid="kv-base64-raw-view"');
    expect(browserSource).toContain("labels.utf8PreviewLossy");
    expect(browserSource).toContain("labels.utf8PreviewUnavailable");
  });
});
