import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("connection dialog scrolling", () => {
  it("gives the configuration step a definite viewport-constrained height", () => {
    expect(dialogSource).toContain("return `${widthClass} connection-dialog-content--config`;");
    expect(dialogSource).toMatch(/\.connection-dialog-content--config\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?@media \(max-height: 720px\)[\s\S]*?height:\s*calc\(var\(--dbx-viewport-height\) - 2rem\);/);
    expect(dialogSource).toMatch(/\.connection-dialog-content--config \.connection-form-body\s*\{[\s\S]*?align-content:\s*start;/);
  });

  it("keeps the transport form inside a shrinkable scroll viewport", () => {
    expect(dialogSource).toContain('<TabsContent v-if="canUseTransportLayers" value="transport" class="m-0 min-h-0 flex-1 overflow-hidden">');
    expect(dialogSource).toContain('class="connection-form-body grid h-full min-h-0 gap-4 overflow-y-auto overflow-x-hidden pt-4 pr-2"');
  });
});
