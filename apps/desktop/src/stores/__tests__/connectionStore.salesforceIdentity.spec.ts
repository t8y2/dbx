import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import type { SalesforceCurrentUser } from "@/types/salesforce";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function salesforceConnection(): ConnectionConfig {
  return {
    id: "sf-1",
    name: "Salesforce",
    db_type: "salesforce",
    host: "acme--qas1.sandbox.my.salesforce.com",
    port: 443,
    username: "ada@example.com",
    password: "",
    database: "",
    read_only: false,
  } as ConnectionConfig;
}

const identity: SalesforceCurrentUser = {
  userId: "005xx000001Swag",
  name: "Ada Lovelace",
  email: "ada@example.com",
  organizationId: "00Dxx0000001gEQ",
  username: "ada@example.com.qas1",
  profileName: "System Administrator",
  isAdmin: true,
  orgName: "Acme QA Sandbox",
};

async function createStore(salesforceCurrentUser: ReturnType<typeof vi.fn>) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
    connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    salesforceCurrentUser,
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [salesforceConnection()];
  // Already connected: the identity lookup must never trigger a connect of its own.
  store.connectedIds.add("sf-1");
  return store;
}

describe("connectionStore salesforce identity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("resolves the identity once per connection and serves it from cache afterwards", async () => {
    const api = vi.fn().mockResolvedValue(identity);
    const store = await createStore(api);

    expect(store.salesforceCurrentUser("sf-1")).toBeNull();
    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toEqual(identity);
    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toEqual(identity);

    expect(store.salesforceCurrentUser("sf-1")).toEqual(identity);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("sf-1");
  });

  it("deduplicates concurrent lookups into one request", async () => {
    const api = vi.fn().mockResolvedValue(identity);
    const store = await createStore(api);

    const [first, second] = await Promise.all([store.loadSalesforceCurrentUser("sf-1"), store.loadSalesforceCurrentUser("sf-1")]);

    expect(first).toEqual(identity);
    expect(second).toEqual(identity);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("hides the badge on failure without caching it, so a later lookup can recover", async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error("Connection not found")).mockResolvedValueOnce(identity);
    const store = await createStore(api);

    // The badge and the save-confirmation warning are advisory: a failed probe
    // must resolve quietly instead of throwing into the caller.
    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toBeNull();
    expect(store.salesforceCurrentUser("sf-1")).toBeNull();

    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toEqual(identity);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("does not cache a response that carries no identity", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...identity, userId: "", username: "", name: "" })
      .mockResolvedValueOnce(identity);
    const store = await createStore(api);

    await store.loadSalesforceCurrentUser("sf-1");
    expect(store.salesforceCurrentUser("sf-1")).toBeNull();

    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toEqual(identity);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("keeps an identity whose admin probe did not resolve", async () => {
    const api = vi.fn().mockResolvedValue({ ...identity, isAdmin: null, profileName: undefined });
    const store = await createStore(api);

    await expect(store.loadSalesforceCurrentUser("sf-1")).resolves.toMatchObject({ username: "ada@example.com.qas1", isAdmin: null });
    expect(store.salesforceCurrentUser("sf-1")?.profileName).toBeUndefined();
  });

  it("resolves quietly without a connection id", async () => {
    const api = vi.fn().mockResolvedValue(identity);
    const store = await createStore(api);

    await expect(store.loadSalesforceCurrentUser("")).resolves.toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});
