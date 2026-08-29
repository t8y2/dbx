import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("connection dialog scrolling", () => {
  it("keeps every configuration tab inside a shrinkable form viewport", () => {
    expect(dialogSource).toContain('connection-dialog-content--config${scrollableAdvancedNacos ? " connection-dialog-content--scrollable" : ""}');
    expect(dialogSource.match(/<TabsContent[^>]*class="m-0 flex min-h-0 flex-1 flex-col overflow-hidden">/g)).toHaveLength(4);
    expect(dialogSource.match(/class="connection-form-body grid min-h-0 flex-1 scroll-pb-6 gap-4 overflow-y-auto/g)).toHaveLength(4);
    expect(dialogSource).toMatch(/\.connection-dialog-content--scrollable\s*\{[\s\S]*?height:\s*min\(720px, calc\(var\(--dbx-viewport-height\) - 2rem\)\);/);
    expect(dialogSource).toMatch(/@media \(max-height: 720px\)[\s\S]*?height:\s*calc\(var\(--dbx-viewport-height\) - 2rem\);/);
    expect(dialogSource).toMatch(/\.connection-dialog-content--config \.connection-form-body\s*\{[\s\S]*?align-content:\s*start;/);
  });

  it("keeps the transport form inside a shrinkable scroll viewport", () => {
    expect(dialogSource).toContain('<TabsContent v-if="canUseTransportLayers" value="transport" class="m-0 flex min-h-0 flex-1 flex-col overflow-hidden">');
    expect(dialogSource).toContain('class="connection-form-body grid min-h-0 flex-1 scroll-pb-6 gap-4 overflow-y-auto overflow-x-hidden pt-4 pr-2 pb-6"');
  });

  it("keeps Nacos cards at their content height on both form tabs", () => {
    expect(dialogSource.match(/:class="\{ 'connection-form-body--nacos': form\.db_type === 'nacos' \}"/g)).toHaveLength(2);
    expect(dialogSource).toMatch(/\.connection-form-body--nacos\s*\{[\s\S]*?grid-auto-rows:\s*max-content;/);
  });
});
