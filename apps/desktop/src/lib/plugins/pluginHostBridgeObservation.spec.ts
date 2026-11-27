// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { PluginHostBridge, type PluginHostBridgeApi } from "./pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";
import type { PluginHostObservationEvent } from "@/types/pluginObservation";

function plugin(permissions: string[]): InstalledPlugin {
  return {
    manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions, drivers: [], contributions: [] },
    compatibility: { compatible: true },
  };
}

const workbench: PluginWorkbenchContribution = { type: "workbench", id: "sample.main", label: "Sample" };

function observation(kind: string): PluginHostObservationEvent {
  return { id: 7, tsMs: 1_700_000_000_000, kind, connectionId: "conn-1", payload: { sql: "select 1" } };
}

function messagesTarget(messages: unknown[]): Window {
  return { postMessage: (message: unknown) => messages.push(message) } as unknown as Window;
}

function minimalApi(extra: Partial<PluginHostBridgeApi> = {}): PluginHostBridgeApi {
  return {
    invoke: <T = unknown>() => Promise.resolve(undefined as T),
    notify: () => Promise.resolve(),
    sendBinary: () => Promise.resolve(),
    readAsset: () => Promise.resolve({ contentType: "text/plain", dataBase64: "", etag: "" }),
    ...extra,
  };
}

describe("PluginHostBridge.forwardObservation", () => {
  it("forwards observation events whose kind matches a declared permission", () => {
    const messages: unknown[] = [];
    const bridge = new PluginHostBridge(plugin(["host.observe:queries"]), workbench, {}, () => messagesTarget(messages), minimalApi());
    bridge.forwardObservation(observation("query.finished"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      source: "dbx-host",
      type: "hostevent",
      id: 7,
      kind: "query.finished",
      tsMs: 1_700_000_000_000,
      connectionId: "conn-1",
      payload: { sql: "select 1" },
    });
  });

  it("drops events whose category permission is not declared", () => {
    const messages: unknown[] = [];
    const bridge = new PluginHostBridge(plugin(["host.observe:queries"]), workbench, {}, () => messagesTarget(messages), minimalApi());
    bridge.forwardObservation(observation("ai.tool_call_started"));
    bridge.forwardObservation(observation("transfer.progress"));
    bridge.forwardObservation(observation("connection.opened"));
    expect(messages).toHaveLength(0);
  });

  it("drops unknown kinds even when every observe permission is declared", () => {
    const messages: unknown[] = [];
    const bridge = new PluginHostBridge(plugin(["host.observe:queries", "host.observe:connections", "host.observe:ai", "host.observe:transfers", "host.observe:plugins"]), workbench, {}, () => messagesTarget(messages), minimalApi());
    bridge.forwardObservation(observation("unknown.kind"));
    expect(messages).toHaveLength(0);
  });

  it("advertises the observations capability only when the backend can subscribe", () => {
    const subscribingMessages: unknown[] = [];
    const subscribing = new PluginHostBridge(plugin(["host.observe:ai"]), workbench, {}, () => messagesTarget(subscribingMessages), minimalApi({ subscribeHostObservations: () => () => {} }));
    subscribing.sendInit();
    expect(subscribingMessages[subscribingMessages.length - 1]).toMatchObject({ type: "init", capabilities: { observations: true } });

    const plainMessages: unknown[] = [];
    const plain = new PluginHostBridge(plugin([]), workbench, {}, () => messagesTarget(plainMessages), minimalApi());
    plain.sendInit();
    expect(plainMessages[plainMessages.length - 1]).toMatchObject({ type: "init", capabilities: { observations: false } });
  });

  it("does not advertise observations to a plugin that declared no observe permission", () => {
    const messages: unknown[] = [];
    const undeclared = new PluginHostBridge(plugin(["host.events"]), workbench, {}, () => messagesTarget(messages), minimalApi({ subscribeHostObservations: () => () => {} }));
    undeclared.sendInit();
    expect(messages[messages.length - 1]).toMatchObject({ type: "init", capabilities: { observations: false } });
  });

  it("forwards drop gaps to any plugin that declared an observation permission", () => {
    const messages: unknown[] = [];
    const bridge = new PluginHostBridge(plugin(["host.observe:transfers"]), workbench, {}, () => messagesTarget(messages), minimalApi());
    bridge.forwardObservationGap({ skipped: 12 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ source: "dbx-host", type: "hosteventgap", skipped: 12 });
  });

  it("drops gap notices for plugins without an observation permission", () => {
    const messages: unknown[] = [];
    const bridge = new PluginHostBridge(plugin(["host.events"]), workbench, {}, () => messagesTarget(messages), minimalApi());
    bridge.forwardObservationGap({ skipped: 3 });
    expect(messages).toHaveLength(0);
  });
});
