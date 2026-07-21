import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");

describe("AppTabBar close confirmation layout", () => {
  it("allows long unbroken tab titles to shrink and wrap inside the dialog", () => {
    expect(tabBarSource).toMatch(/<DialogContent class="[^"]*\bmin-w-0\b[^"]*\bsm:max-w-md\b/);
    expect(tabBarSource).toMatch(/<div class="[^"]*\bmin-w-0\b[^"]*\bspace-y-2\b">\s*<p class="[^"]*\bwrap-anywhere\b/);
  });

  it("keeps all single and bulk close actions while allowing the footer to wrap", () => {
    expect(tabBarSource).toMatch(/<DialogFooter class="[^"]*\bmin-w-0\b[^"]*\bsm:flex-wrap\b">/);
    expect(tabBarSource).toContain('v-if="showCloseConfirmBulkActions" variant="secondary" @click="handleDiscardAllAndClose"');
    expect(tabBarSource).toContain('v-if="showCloseConfirmBulkActions" @click="handleSaveAllAndClose"');
    expect(tabBarSource).toContain('@click="handleDiscardAndClose"');
    expect(tabBarSource).toContain('@click="handleSaveAndClose"');
    expect(tabBarSource).toContain('@click="handleCancelClose"');
  });
});
