// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingComponentUpdatesAfterAppUpdate,
  continuePreparedAppUpdate,
  hasPendingComponentUpdatesAfterAppRestart,
  markPendingComponentUpdatesAfterAppUpdate,
  resolveUpdateAllAction,
  runPendingComponentUpdatesBeforePluginReconnect,
  runPendingComponentUpdatePlan,
  shouldCloseUpdateCenterAfterComponentUpdate,
  takePendingComponentUpdatesAfterAppRestart,
  updateBlockerLabels,
} from "@/lib/updates/componentUpdateOrchestration";

describe("component update orchestration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lists blocked connection names and falls back to the driver label", () => {
    expect(
      updateBlockerLabels([
        { label: "MySQL", connections: ["生产 MySQL", "报表 MySQL"] },
        { label: "Oracle", connections: [] },
        { label: "DuckDB", connections: ["生产 MySQL"] },
      ]),
    ).toEqual(["生产 MySQL", "报表 MySQL", "Oracle"]);
  });

  it("keeps pending component updates across a failed or ordinary startup", () => {
    expect(markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17")).toBe(true);

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("v0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toEqual({ fromVersion: "0.6.16", targetVersion: "0.6.17", plan: { kind: "auto" } });
  });

  it("detects pending component updates before restored plugin tabs reconnect", () => {
    expect(hasPendingComponentUpdatesAfterAppRestart()).toBe(false);

    markPendingComponentUpdatesAfterAppUpdate("0.6.18", "0.6.19", { kind: "manual", categories: ["plugins"] });

    expect(hasPendingComponentUpdatesAfterAppRestart()).toBe(true);
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.19")).not.toBeNull();
    expect(hasPendingComponentUpdatesAfterAppRestart()).toBe(false);
  });

  it("consumes pending component updates before reconnecting restored plugin tabs", async () => {
    const events: string[] = [];

    await runPendingComponentUpdatesBeforePluginReconnect({
      hasPendingComponentUpdates: () => true,
      prepareStartup: async () => {
        events.push("prepare");
      },
      consumePendingComponentUpdates: async () => {
        events.push("consume");
      },
      reconnectRestoredPluginTabs: async () => {
        events.push("reconnect");
      },
    });

    expect(events).toEqual(["prepare", "consume", "reconnect"]);
  });

  it("reconnects restored plugin tabs immediately when no component update is pending", async () => {
    const events: string[] = [];
    let finishStartup = () => {};
    const startupFinished = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });

    const startup = runPendingComponentUpdatesBeforePluginReconnect({
      hasPendingComponentUpdates: () => false,
      prepareStartup: async () => {
        events.push("prepare");
        await startupFinished;
      },
      consumePendingComponentUpdates: async () => {
        events.push("consume");
      },
      reconnectRestoredPluginTabs: async () => {
        events.push("reconnect");
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["reconnect", "prepare"]);
    finishStartup();
    await startup;
    expect(events).toEqual(["reconnect", "prepare"]);
  });

  it("still reconnects restored plugin tabs when pending component updates fail", async () => {
    const events: string[] = [];

    await expect(
      runPendingComponentUpdatesBeforePluginReconnect({
        hasPendingComponentUpdates: () => true,
        prepareStartup: async () => {
          events.push("prepare");
        },
        consumePendingComponentUpdates: async () => {
          events.push("consume");
          throw new Error("update failed");
        },
        reconnectRestoredPluginTabs: async () => {
          events.push("reconnect");
        },
      }),
    ).rejects.toThrow("update failed");

    expect(events).toEqual(["prepare", "consume", "reconnect"]);
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

  it("downloads DBX before installing it with component updates", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("download-app");
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: true, hasComponentUpdates: true })).toBe("install-app");
  });

  it("persists the selected component categories when the DBX package is already prepared", () => {
    const action = resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: true, hasComponentUpdates: true });
    expect(action).toBe("install-app");

    expect(markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17", { kind: "manual", categories: ["drivers", "mcp"] })).toBe(true);
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")?.plan).toEqual({ kind: "manual", categories: ["drivers", "mcp"] });
  });

  it("continues from update all into the prepared app install", async () => {
    const rememberComponentUpdates = vi.fn(async () => true);
    const installComponents = vi.fn(async () => {});
    const installDownloadedUpdate = vi.fn(async () => {});
    const restartApp = vi.fn(async () => {});

    await continuePreparedAppUpdate({
      hasComponentUpdates: true,
      restartOnly: false,
      rememberComponentUpdates,
      installComponents,
      installDownloadedUpdate,
      restartApp,
    });

    expect(rememberComponentUpdates).toHaveBeenCalledOnce();
    expect(installDownloadedUpdate).toHaveBeenCalledOnce();
    expect(restartApp).not.toHaveBeenCalled();
    expect(installComponents).not.toHaveBeenCalled();
  });

  it("continues from update all into restart when the app update is already staged", async () => {
    const restartApp = vi.fn(async () => {});

    await continuePreparedAppUpdate({
      hasComponentUpdates: true,
      restartOnly: true,
      rememberComponentUpdates: async () => true,
      installComponents: async () => {},
      installDownloadedUpdate: async () => {},
      restartApp,
    });

    expect(restartApp).toHaveBeenCalledOnce();
  });

  it("falls back to component updates without restarting when the restart plan cannot be persisted", async () => {
    const installComponents = vi.fn(async () => {});
    const installDownloadedUpdate = vi.fn(async () => {});
    const restartApp = vi.fn(async () => {});

    await continuePreparedAppUpdate({
      hasComponentUpdates: true,
      restartOnly: false,
      rememberComponentUpdates: async () => false,
      installComponents,
      installDownloadedUpdate,
      restartApp,
    });

    expect(installComponents).toHaveBeenCalledOnce();
    expect(installDownloadedUpdate).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
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
