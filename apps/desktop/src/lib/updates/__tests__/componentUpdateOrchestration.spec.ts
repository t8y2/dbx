// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingComponentUpdatesAfterAppUpdate, markPendingComponentUpdatesAfterAppUpdate, resolveUpdateAllAction, runPendingComponentUpdatePlan, shouldCloseUpdateCenterAfterComponentUpdate, takePendingComponentUpdatesAfterAppRestart } from "@/lib/updates/componentUpdateOrchestration";

describe("component update orchestration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps pending component updates across a failed or ordinary startup", () => {
    expect(markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17")).toBe(true);

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("v0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toEqual({ fromVersion: "0.6.16", targetVersion: "0.6.17", plan: { kind: "auto" } });
  });

  it("consumes a successful restart exactly once", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).not.toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toBeNull();
  });

  it("does not run components on startup when no DBX update was requested", () => {
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
  });

  it("discards malformed pending state", () => {
    localStorage.setItem("dbx:updates:pending-components-after-restart", "not-json");

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toBeNull();
    expect(localStorage.getItem("dbx:updates:pending-components-after-restart")).toBeNull();
  });

  it("does not clear pending state when the current version cannot be read", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");

    expect(takePendingComponentUpdatesAfterAppRestart("")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).not.toBeNull();
  });

  it("preserves explicit update-all categories across restart", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17", { kind: "manual", categories: ["drivers", "plugins"] });

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toEqual({
      fromVersion: "0.6.16",
      targetVersion: "0.6.17",
      plan: { kind: "manual", categories: ["drivers", "plugins"] },
    });
  });

  it("does not replace a manual update-all plan with the automatic restart plan", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17", { kind: "manual", categories: ["jdbc"] });
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")?.plan).toEqual({ kind: "manual", categories: ["jdbc"] });
  });

  it("retains a manual plan after a failed update and consumes it once after retry", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17", { kind: "manual", categories: ["plugins"] });

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")?.plan).toEqual({ kind: "manual", categories: ["plugins"] });
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toBeNull();
  });

  it("treats pending state from the previous implementation as an automatic plan", () => {
    localStorage.setItem("dbx:updates:pending-components-after-restart", JSON.stringify({ fromVersion: "0.6.16", targetVersion: "0.6.17" }));

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")?.plan).toEqual({ kind: "auto" });
  });

  it("downloads DBX before deferring component updates", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("download-app");
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: true, hasComponentUpdates: true })).toBe("defer-components");
  });

  it("persists the selected component categories when the DBX package is already prepared", () => {
    const action = resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: true, hasComponentUpdates: true });
    expect(action).toBe("defer-components");

    expect(markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17", { kind: "manual", categories: ["drivers", "mcp"] })).toBe(true);
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")?.plan).toEqual({ kind: "manual", categories: ["drivers", "mcp"] });
  });

  it("updates components immediately when no DBX update exists or the package cannot be installed", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: false, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("update-components");
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: false, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("update-components");
  });

  it("does nothing when no update is available", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: false, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: false })).toBe("none");
  });

  it("closes the update center after a successful component-only update with nothing left to install", () => {
    expect(
      shouldCloseUpdateCenterAfterComponentUpdate({
        failedCount: 0,
        skippedDriverCount: 0,
        hasAppUpdate: false,
        remainingComponentUpdateCount: 0,
      }),
    ).toBe(true);
  });

  it("keeps the update center open when an update failed or a driver update was skipped", () => {
    const base = { hasAppUpdate: false, remainingComponentUpdateCount: 0 };
    expect(shouldCloseUpdateCenterAfterComponentUpdate({ ...base, failedCount: 1, skippedDriverCount: 0 })).toBe(false);
    expect(shouldCloseUpdateCenterAfterComponentUpdate({ ...base, failedCount: 0, skippedDriverCount: 1 })).toBe(false);
  });

  it("keeps the update center open while the app or another component still needs an update", () => {
    const base = { failedCount: 0, skippedDriverCount: 0 };
    expect(shouldCloseUpdateCenterAfterComponentUpdate({ ...base, hasAppUpdate: true, remainingComponentUpdateCount: 0 })).toBe(false);
    expect(shouldCloseUpdateCenterAfterComponentUpdate({ ...base, hasAppUpdate: false, remainingComponentUpdateCount: 1 })).toBe(false);
  });

  it("can explicitly clear pending state", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");
    clearPendingComponentUpdatesAfterAppUpdate();

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toBeNull();
  });

  it("dispatches automatic and manual plans to their matching installers", async () => {
    const installCategories = vi.fn().mockResolvedValue("manual");
    const autoUpdateEnabledComponents = vi.fn().mockResolvedValue("auto");
    const updates = { installCategories, autoUpdateEnabledComponents };

    await expect(runPendingComponentUpdatePlan({ fromVersion: "0.6.16", targetVersion: "0.6.17", plan: { kind: "manual", categories: ["jdbc"] } }, updates)).resolves.toBe("manual");
    await expect(runPendingComponentUpdatePlan({ fromVersion: "0.6.16", targetVersion: "0.6.17", plan: { kind: "auto" } }, updates)).resolves.toBe("auto");

    expect(installCategories).toHaveBeenCalledWith(["jdbc"]);
    expect(autoUpdateEnabledComponents).toHaveBeenCalledOnce();
  });
});
