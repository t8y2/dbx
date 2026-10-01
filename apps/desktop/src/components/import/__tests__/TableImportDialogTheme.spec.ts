import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Fixes #10142: In dark mode, native select dropdown menus in TableImportDialog
// (such as column mapping and conflict policy) rendered with a bright white
// popup background and light-colored text in Chromium/WebView2 because native
// select/option elements did not specify color-scheme or popover colors.
const tableImportDialogSource = readFileSync(new URL("../TableImportDialog.vue", import.meta.url), "utf8");
const tokensCssSource = readFileSync(new URL("../../../styles/tokens.css", import.meta.url), "utf8");
const globalsCssSource = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");

describe("TableImportDialog theme and select color consistency (#10142)", () => {
  it("declares color-scheme: light in :root and color-scheme: dark in .dark within tokens.css", () => {
    expect(tokensCssSource).toMatch(/:root\s*\{[^}]*color-scheme:\s*light;/);
    expect(tokensCssSource).toMatch(/\.dark\s*\{[^}]*color-scheme:\s*dark;/);
  });

  it("declares select color-scheme and option background in globals.css", () => {
    expect(globalsCssSource).toMatch(/select\s*\{[^}]*color-scheme:\s*light;/);
    expect(globalsCssSource).toMatch(/\.dark select[^}]*color-scheme:\s*dark;/);
    expect(globalsCssSource).toMatch(/select option\s*\{[^}]*background-color:\s*var\(--popover\);[^}]*color:\s*var\(--popover-foreground\);/);
  });

  it("applies color-scheme and text-foreground to native select controls in TableImportDialog.vue", () => {
    expect(tableImportDialogSource).toContain('id="table-import-conflict-policy"');
    expect(tableImportDialogSource).toMatch(/id="table-import-conflict-policy"[^>]*\[color-scheme:light\] dark:\[color-scheme:dark\]/);
    expect(tableImportDialogSource).toMatch(/id="table-import-conflict-policy"[^>]*text-foreground/);

    expect(tableImportDialogSource).toMatch(/class="[^"]*h-7 w-full min-w-0 rounded-md[^"]*\[color-scheme:light\] dark:\[color-scheme:dark\]/);
    expect(tableImportDialogSource).toMatch(/class="[^"]*h-7 w-full min-w-0 rounded-md[^"]*text-foreground/);
  });

  it("applies bg-popover and text-popover-foreground to option elements in TableImportDialog.vue", () => {
    expect(tableImportDialogSource).toMatch(/<option[^>]*class="[^"]*bg-popover text-popover-foreground[^"]*"[^>]*>\s*\{\{ t\("tableImport\.skipColumn"\) \}\}\s*<\/option>/);
    expect(tableImportDialogSource).toMatch(/<option[^>]*class="[^"]*bg-popover text-popover-foreground[^"]*"[^>]*>\s*\{\{\s*column\.name\s*\}\}\s*<\/option>/);
  });
});
