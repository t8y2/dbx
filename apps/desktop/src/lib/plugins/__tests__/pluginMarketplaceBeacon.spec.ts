import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beaconPluginInstall } from "@/lib/plugins/pluginMarketplace";

function lastBeaconBody(): Record<string, unknown> {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const body = calls[calls.length - 1]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : {};
}

function storedInstallationId(): string {
  return localStorage.getItem("dbx-installation-id") ?? "";
}

describe("beaconPluginInstall", () => {
  const backing = new Map<string, string>();
  beforeEach(() => {
    backing.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(undefined));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends id, version and install kind by default", () => {
    beaconPluginInstall("io.dbx.ssh", "1.2.3");
    expect(lastBeaconBody()).toMatchObject({ id: "io.dbx.ssh", version: "1.2.3", kind: "install" });
  });

  it("forwards the update kind so updates cannot inflate install counts", () => {
    beaconPluginInstall("io.dbx.ssh", "1.2.4", "update");
    expect(lastBeaconBody()).toMatchObject({ kind: "update" });
  });

  it("generates a uuid installation id once and reuses it across beacons", () => {
    beaconPluginInstall("io.dbx.ssh", "1.2.3");
    const first = lastBeaconBody().clientId;
    expect(first).toBe(storedInstallationId());
    expect(String(first)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    beaconPluginInstall("io.dbx.ldap", "2.0.0");
    expect(lastBeaconBody().clientId).toBe(first);
  });

  it("regenerates a malformed stored installation id instead of sending it", () => {
    backing.set("dbx-installation-id", "not-a-uuid");
    beaconPluginInstall("io.dbx.ssh", "1.2.3");
    const clientId = String(lastBeaconBody().clientId);
    expect(clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(clientId).toBe(storedInstallationId());
  });

  it("sends an empty clientId when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => {
        throw new Error("unavailable");
      },
      removeItem: () => undefined,
    });
    beaconPluginInstall("io.dbx.ssh", "1.2.3");
    expect(lastBeaconBody().clientId).toBe("");
  });
});
