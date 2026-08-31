import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const quickOpenDialogSource = readFileSync(new URL("../QuickOpenDialog.vue", import.meta.url), "utf8");

describe("QuickOpenDialog theme styles", () => {
  it("keeps the shared corner style and readable foreground text", () => {
    expect(quickOpenDialogSource).toContain('class="max-w-2xl p-0 gap-0 rounded-lg overflow-hidden"');
    expect(quickOpenDialogSource).toContain("background-color: var(--warning-bg) !important;");
    expect(quickOpenDialogSource).not.toContain("border-radius: 0.75rem;");
    expect(quickOpenDialogSource).not.toContain("color: var(--warning) !important;");
  });
});
