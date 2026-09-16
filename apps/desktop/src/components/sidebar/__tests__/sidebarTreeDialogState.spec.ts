import { describe, expect, it } from "vitest";
import { resetSidebarTreeDialogState, sidebarDangerRunningCancel, sidebarDangerRunningExecutionId } from "../sidebarTreeDialogState";

describe("resetSidebarTreeDialogState", () => {
  it("clears the danger-running singleton", () => {
    sidebarDangerRunningExecutionId.value = "exec-1";
    sidebarDangerRunningCancel.value = () => {};

    resetSidebarTreeDialogState();

    expect(sidebarDangerRunningExecutionId.value).toBe("");
    expect(sidebarDangerRunningCancel.value).toBeNull();
  });
});
