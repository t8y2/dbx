import { describe, expect, it } from "vitest";

import { canObserveHostEvent, declaresAnyObservationPermission, PLUGIN_OBSERVATION_PERMISSIONS, pluginObservationCategory, pluginObservationPermission, SIDECAR_SKIPPED_OBSERVATION_KINDS } from "./pluginObservation";
import type { PluginHostObservationEvent } from "@/types/pluginObservation";

function event(kind: string): PluginHostObservationEvent {
  return { id: 1, tsMs: 1, kind, payload: {} };
}

describe("pluginObservation", () => {
  it("maps every category prefix to its permission", () => {
    expect(pluginObservationPermission("query.started")).toBe(PLUGIN_OBSERVATION_PERMISSIONS.queries);
    expect(pluginObservationPermission("connection.opened")).toBe(PLUGIN_OBSERVATION_PERMISSIONS.connections);
    expect(pluginObservationPermission("ai.tool_call_started")).toBe(PLUGIN_OBSERVATION_PERMISSIONS.ai);
    expect(pluginObservationPermission("transfer.progress")).toBe(PLUGIN_OBSERVATION_PERMISSIONS.transfers);
    expect(pluginObservationPermission("plugin.activated")).toBe(PLUGIN_OBSERVATION_PERMISSIONS.plugins);
  });

  it("fails closed for unknown kinds", () => {
    expect(pluginObservationCategory("unknown.kind")).toBeUndefined();
    expect(pluginObservationPermission("unknown.kind")).toBeUndefined();
    expect(pluginObservationPermission("")).toBeUndefined();
    expect(canObserveHostEvent(event("unknown.kind"), () => true)).toBe(false);
  });

  it("gates delivery on the declared permission only", () => {
    const declared = new Set<string>([PLUGIN_OBSERVATION_PERMISSIONS.queries]);
    const hasPermission = (permission: string) => declared.has(permission);
    expect(canObserveHostEvent(event("query.finished"), hasPermission)).toBe(true);
    expect(canObserveHostEvent(event("ai.tool_call_started"), hasPermission)).toBe(false);
  });

  it("detects manifests with any observation permission", () => {
    expect(declaresAnyObservationPermission(undefined)).toBe(false);
    expect(declaresAnyObservationPermission(["host.events"])).toBe(false);
    expect(declaresAnyObservationPermission(["host.observe:queries"])).toBe(true);
    expect(declaresAnyObservationPermission(["host.events", "host.observe:plugins"])).toBe(true);
  });

  it("keeps delta streams UI-only", () => {
    expect(SIDECAR_SKIPPED_OBSERVATION_KINDS).toContain("ai.text_delta");
    expect(SIDECAR_SKIPPED_OBSERVATION_KINDS).toContain("ai.reasoning_delta");
    expect(SIDECAR_SKIPPED_OBSERVATION_KINDS).not.toContain("ai.tool_call_started");
  });
});
