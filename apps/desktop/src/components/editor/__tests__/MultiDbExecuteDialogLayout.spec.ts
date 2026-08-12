import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../MultiDbExecuteDialog.vue", import.meta.url), "utf8");

describe("MultiDbExecuteDialog footer layout", () => {
  it("keeps the target group manager close button aligned with the main dialog footer", () => {
    expect(dialogSource).toContain('<DialogFooter class="mx-0 mb-0 shrink-0 border-t px-5 py-3">\n          <Button variant="outline" @click="manageGroups = false">');
  });
});
