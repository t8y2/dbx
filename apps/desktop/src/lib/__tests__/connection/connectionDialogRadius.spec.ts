import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("connection dialog corner style", () => {
  it("uses the shared corner radius token for configuration controls", () => {
    expect(dialogSource).toContain("border-radius: var(--dbx-radius-fixed-4, 4px);");
    expect(dialogSource).not.toMatch(/\.connection-config-step[\s\S]*?border-radius:\s*4px;/);
  });
});
