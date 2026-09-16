import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionTreeSource = readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8");

describe("ConnectionTree danger dialog guard", () => {
  it("refuses to open a new danger dialog while a previous danger operation is still running", () => {
    expect(connectionTreeSource).toMatch(/function openSidebarDangerDialog\(request: SidebarDangerDialogRequest\) \{\s*if \(sidebarDangerRunningExecutionId\.value\) \{\s*toast\(t\("contextMenu\.dangerOperationAlreadyRunning"\), \d+\);\s*return;\s*\}/);
  });
});
