import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const connectionIsOpen = vi.hoisted(() => vi.fn());

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

/**
 * Backend connection-liveness messages (#4339).
 *
 * The backend publishes `lost` only once a connection has no pools left, but the message is
 * asynchronous: it can be delivered after the user already reconnected. The store therefore
 * confirms with the read-only `connectionIsOpen` before it touches the sidebar, and must never
 * confirm with `checkConnectionHealth` (which removes pools and reconnects).
 *
 * `resync` is sent when the transport dropped messages; those are unrecoverable, so the store
 * re-checks everything it still shows as connected.
 */
describe("connectionStore keepalive liveness", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
    connectionIsOpen.mockReset();
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectionIsOpen,
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
  });

  async function loadStore() {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    return useConnectionStore();
  }

  it("flips the sidebar offline only once the read-only confirm reports no pool", async () => {
    connectionIsOpen.mockResolvedValue(false);
    const store = await loadStore();
    store.connectedIds.add("c1");

    await store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "c1", failureKind: "probe_failed" });

    expect(connectionIsOpen).toHaveBeenCalledWith("c1");
    expect(store.connectedIds.has("c1")).toBe(false);
  });

  it("keeps the connection when the confirm reports it open again", async () => {
    // A reconnect that finished before the message was delivered: the pool is back, so a late
    // message must not grey out a connection the user is actively using.
    connectionIsOpen.mockResolvedValue(true);
    const store = await loadStore();
    store.connectedIds.add("c1");

    await store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "c1", failureKind: "timed_out" });

    expect(store.connectedIds.has("c1")).toBe(true);
  });

  it("ignores messages for connections this frontend does not consider connected", async () => {
    const store = await loadStore();

    await store.handleConnectionLivenessMessage({
      kind: "lost",
      connectionId: "never-connected",
      failureKind: "probe_failed",
    });

    expect(connectionIsOpen).not.toHaveBeenCalled();
    expect(store.connectedIds.size).toBe(0);
  });

  it("leaves the sidebar untouched when the confirm itself fails", async () => {
    // A failed confirm says nothing about the connection, so the status must not be guessed.
    connectionIsOpen.mockRejectedValue(new Error("ipc unavailable"));
    const store = await loadStore();
    store.connectedIds.add("c1");

    await store.handleConnectionLivenessMessage({ kind: "lost", connectionId: "c1", failureKind: "probe_failed" });

    expect(store.connectedIds.has("c1")).toBe(true);
  });

  it("re-checks every connected connection on a resync instead of keeping a dropped loss", async () => {
    // The transport dropped messages, so the ids whose loss was dropped are unknown: the store
    // has to re-check the whole connected set, or one sidebar stays green indefinitely.
    const store = await loadStore();
    store.connectedIds.add("dead");
    store.connectedIds.add("alive");
    connectionIsOpen.mockImplementation((connectionId: string) => Promise.resolve(connectionId === "alive"));

    await store.handleConnectionLivenessMessage({ kind: "resync" });

    expect(connectionIsOpen).toHaveBeenCalledWith("dead");
    expect(connectionIsOpen).toHaveBeenCalledWith("alive");
    expect(store.connectedIds.has("dead")).toBe(false);
    expect(store.connectedIds.has("alive")).toBe(true);
  });

  it("does not query the backend on a resync when nothing is connected", async () => {
    const store = await loadStore();

    await store.handleConnectionLivenessMessage({ kind: "resync" });

    expect(connectionIsOpen).not.toHaveBeenCalled();
  });
});
