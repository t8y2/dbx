import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// reka-ui's SelectItem throws on value="" (SelectItem.js: "A <SelectItem /> must
// have a value prop that is not an empty string"). The throw happens while the
// select's dismissable layer is up, and the leftover layer then blocks every
// click in the app — dialogs can no longer be closed. These dialogs use
// sentinel values instead; keep it that way.
const multiDbDialogSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/editor/MultiDbExecuteDialog.vue"), "utf8");
const tagPanelSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/config/TagManagementPanel.vue"), "utf8");

describe("Select empty-value regression guard", () => {
  it("keeps the multi-db target-group select free of empty SelectItem values", () => {
    expect(multiDbDialogSource).not.toMatch(/<SelectItem\s+value=""/);
    expect(multiDbDialogSource).toContain("NO_GROUP_VALUE");
  });

  it("keeps the tag environment select free of empty SelectItem values", () => {
    expect(tagPanelSource).not.toMatch(/<SelectItem\s+value=""/);
    expect(tagPanelSource).toContain("ALL_ENVIRONMENTS");
  });
});
