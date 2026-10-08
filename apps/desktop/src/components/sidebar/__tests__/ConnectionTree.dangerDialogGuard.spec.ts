import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dangerDialogHostSource = readFileSync(new URL("../SidebarDangerDialogHost.vue", import.meta.url), "utf8");

describe("Shared danger dialog guard", () => {
  it("refuses to open a new danger dialog while a previous danger operation is still running", () => {
    expect(dangerDialogHostSource).toMatch(/function showSidebarDangerDialog\(request: SidebarDangerDialogRequest\) \{\s*if \(sidebarDangerRunningExecutionId\.value[^\n]*\) \{\s*toast\(t\("contextMenu\.dangerOperationAlreadyRunning"\), \d+\);\s*return;\s*\}/);
  });
});
