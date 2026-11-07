// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { datagripKeychainService, parseDataGripImport, type DataGripImportPayload } from "@/lib/imports/datagripImport";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ readKeychainPasswords: vi.fn(), saveConnections: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", () => ({ readKeychainPasswords: mocks.readKeychainPasswords, saveConnections: mocks.saveConnections }));

import { useConnectionStore } from "@/stores/connectionStore";

const payload: DataGripImportPayload = {
  format: "datagrip-import",
  dataSources: `
    <project>
      <component name="DataSourceManagerImpl">
        <data-source name="Alpha" uuid="uuid-alpha">
          <driver-ref>postgresql</driver-ref>
          <jdbc-url>jdbc:postgresql://alpha.example:5432/app</jdbc-url>
        </data-source>
        <data-source name="Beta" uuid="uuid-beta">
          <driver-ref>postgresql</driver-ref>
          <jdbc-url>jdbc:postgresql://beta.example:5432/app</jdbc-url>
        </data-source>
      </component>
    </project>
  `,
};

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.readKeychainPasswords.mockReset().mockImplementation(async (services: string[]) => services.map((service) => [service, `keychain:${service}`]));
  mocks.saveConnections.mockReset().mockResolvedValue(undefined);
});

describe("DataGrip Keychain import scope", () => {
  it("reads and fills only the selected row of a multi-connection DataGrip source", async () => {
    const [alpha, beta] = parseDataGripImport(payload).connections;
    const store = useConnectionStore();
    const imported = (connection: ConnectionConfig, id: string, password = ""): ConnectionConfig => ({ ...connection, id, password });
    store.connections = [
      imported(alpha, "new-alpha"),
      // Unselected row from the same source, even though it is a fresh import target.
      imported(beta, "new-beta"),
      // Pre-existing connection with the selected row's identity, not created by this import.
      imported(alpha, "existing-alpha", "user-entered"),
    ];

    const filled = await store.applyDataGripKeychainPasswords({ payload, targets: [{ source: alpha, connectionId: "new-alpha" }] });

    expect(filled).toBe(1);
    expect(mocks.readKeychainPasswords).toHaveBeenCalledTimes(1);
    expect(mocks.readKeychainPasswords).toHaveBeenCalledWith([datagripKeychainService("uuid-alpha")]);
    const byId = new Map(store.connections.map((connection) => [connection.id, connection.password]));
    expect(byId.get("new-alpha")).toBe(`keychain:${datagripKeychainService("uuid-alpha")}`);
    expect(byId.get("new-beta")).toBe("");
    expect(byId.get("existing-alpha")).toBe("user-entered");
  });

  it("never writes a DataGrip password to a matching connection imported from another app", async () => {
    const [alpha] = parseDataGripImport(payload).connections;
    const store = useConnectionStore();
    // Same name, host, port and database as the DataGrip row, but a different account and password.
    const dbeaver: ConnectionConfig = { ...alpha, id: "new-dbeaver", username: "dbeaver-user", password: "dbeaver-secret" };
    const datagrip: ConnectionConfig = { ...alpha, id: "new-datagrip", username: "datagrip-user", password: "" };
    store.connections = [dbeaver, datagrip];

    const filled = await store.applyDataGripKeychainPasswords({ payload, targets: [{ source: alpha, connectionId: "new-datagrip" }] });

    expect(filled).toBe(1);
    const byId = new Map(store.connections.map((connection) => [connection.id, connection.password]));
    expect(byId.get("new-datagrip")).toBe(`keychain:${datagripKeychainService("uuid-alpha")}`);
    expect(byId.get("new-dbeaver")).toBe("dbeaver-secret");
  });

  it("skips the Keychain entirely when no selected row maps to a created connection", async () => {
    const [alpha] = parseDataGripImport(payload).connections;
    const store = useConnectionStore();
    store.connections = [];
    expect(await store.applyDataGripKeychainPasswords({ payload, targets: [] })).toBe(0);
    expect(await store.applyDataGripKeychainPasswords({ payload, targets: [{ source: { ...alpha, name: "Unknown" }, connectionId: "new-alpha" }] })).toBe(0);
    expect(mocks.readKeychainPasswords).not.toHaveBeenCalled();
  });
});
