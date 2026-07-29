import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function gaussdbConnection(style: "double" | "backtick"): ConnectionConfig {
  return {
    id: `gaussdb-${style}`,
    name: "GaussDB",
    db_type: "gaussdb",
    host: "127.0.0.1",
    port: 5432,
    username: "gaussdb",
    password: "",
    database: "postgres",
    external_config: { gaussdbIdentifierQuoteStyle: style },
  };
}

describe("connectionStore GaussDB identifier quote override", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("resolves the persisted compatibility mode before runtime driver metadata", async () => {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const double = gaussdbConnection("double");
    const backtick = gaussdbConnection("backtick");
    store.connections = [double, backtick];

    expect(store.connectionIdentifierQuote(double.id)).toBe('"');
    expect(store.connectionIdentifierQuote(backtick.id)).toBe("`");
  });
});
