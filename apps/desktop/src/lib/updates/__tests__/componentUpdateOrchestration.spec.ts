// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { clearPendingComponentUpdatesAfterAppUpdate, markPendingComponentUpdatesAfterAppUpdate, resolveUpdateAllAction, takePendingComponentUpdatesAfterAppRestart } from "@/lib/updates/componentUpdateOrchestration";

describe("component update orchestration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps pending component updates across a failed or ordinary startup", () => {
    expect(markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17")).toBe(true);

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("v0.6.16")).toBeNull();
    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toEqual({ fromVersion: "0.6.16", targetVersion: "0.6.17" });
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

  it("downloads DBX before deferring component updates", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("download-app");
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: true, appUpdatePrepared: true, hasComponentUpdates: true })).toBe("defer-components");
  });

  it("updates components immediately when no DBX update exists or the package cannot be installed", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: false, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("update-components");
    expect(resolveUpdateAllAction({ hasAppUpdate: true, appUpdateCanInstall: false, appUpdatePrepared: false, hasComponentUpdates: true })).toBe("update-components");
  });

  it("does nothing when no update is available", () => {
    expect(resolveUpdateAllAction({ hasAppUpdate: false, appUpdateCanInstall: true, appUpdatePrepared: false, hasComponentUpdates: false })).toBe("none");
  });

  it("can explicitly clear pending state", () => {
    markPendingComponentUpdatesAfterAppUpdate("0.6.16", "0.6.17");
    clearPendingComponentUpdatesAfterAppUpdate();

    expect(takePendingComponentUpdatesAfterAppRestart("0.6.17")).toBeNull();
  });
});
