import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("GBase 8s connection dialog", () => {
  it("hydrates DBSERVERNAME when editing a saved connection", () => {
    expect(dialogSource).toContain('gbase_server: config.gbase_server || ""');
  });
});
