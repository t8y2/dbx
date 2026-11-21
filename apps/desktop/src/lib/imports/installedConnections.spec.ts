// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { combineInstalledConnectionSelections, loadInstalledConnectionGroups, planInstalledConnectionImport } from "./installedConnections";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => vi.resetAllMocks());

describe("automatic connection discovery", () => {
  async function wineSelection() {
    invoke.mockResolvedValue([
      { source: "navicat", label: "Navicat (Wine)", path: "/wine/user.reg", content: JSON.stringify({ format: "navicat-wine-import", connections: [{ Name: "Wine MySQL", ConnType: "MYSQL", Host: "mysql.example", Port: "3306", UserName: "reader", DBXWinePassword: "synthetic-password" }] }) },
    ]);
    const result = await loadInstalledConnectionGroups();
    expect(result.errors).toEqual([]);
    const group = result.groups[0];
    return { group, connectionIds: group.preview.connections.map((connection) => connection.id) };
  }

  it("carries locally recovered passwords into imported configs with password saving enabled", async () => {
    const selection = await wineSelection();
    expect(selection.group.preview.connections[0]).toMatchObject({ password: "synthetic-password", save_password: true });
  });

  it("fills an existing matching connection's empty password without creating a duplicate", async () => {
    const selection = await wineSelection();
    const current = { ...selection.group.preview.connections[0], id: "existing-id", password: "", note: "Keep this note", color: "#123456" };
    const plan = planInstalledConnectionImport([selection], [current]);
    expect(plan.preview.connections).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: "existing-id", password: "synthetic-password", note: "Keep this note", color: "#123456", save_password: true });
    expect(current.password).toBe("");
  });

  it("keeps an existing password and skips repeated Wine imports", async () => {
    const selection = await wineSelection();
    const current = { ...selection.group.preview.connections[0], id: "existing-id", password: "user-entered-password" };
    const plan = planInstalledConnectionImport([selection], [current]);
    expect(plan.preview.connections).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(current.password).toBe("user-entered-password");
  });

  it("does not put recovered credentials into a different endpoint or an unselected connection", async () => {
    const selection = await wineSelection();
    const current = { ...selection.group.preview.connections[0], id: "existing-id", host: "other.example", password: "" };
    const plan = planInstalledConnectionImport([selection], [current]);
    expect(plan.updates).toEqual([]);
    expect(plan.preview.connections).toHaveLength(1);
    expect(planInstalledConnectionImport([{ ...selection, connectionIds: [] }], [current]).updates).toEqual([]);
  });

  it("ignores recovered-password fields in ordinary manually loaded Navicat JSON", async () => {
    invoke.mockResolvedValue([{ source: "navicat", label: "Navicat", path: "/navicat/connections.json", content: JSON.stringify({ connections: [{ Name: "Manual", ConnType: "MYSQL", Host: "mysql.example", DBXWinePassword: "not-a-native-recovered-password" }] }) }]);
    const result = await loadInstalledConnectionGroups();
    expect(result.groups[0].preview.connections[0].password).toBe("");
  });
  it("loads Wine registry connection settings with the database type, endpoint and SSH options", async () => {
    invoke.mockResolvedValue([
      {
        source: "navicat",
        label: "Navicat (Wine)",
        path: "/wine/user.reg",
        content: JSON.stringify({
          connections: [
            { Name: "Wine MySQL", ConnType: "MYSQL", Host: "mysql.example", Port: "3306", UserName: "reader", UseSSL: "1" },
            { Name: "Wine PostgreSQL", ConnType: "POSTGRESQL", Host: "localhost", Port: "5432", Database: "postgres", UseSSH: "1", SSH_Host: "bastion.example", SSH_Port: "22", SSH_UserName: "tunnel" },
          ],
        }),
      },
    ]);
    const result = await loadInstalledConnectionGroups();
    expect(result.errors).toEqual([]);
    expect(result.groups[0].label).toBe("Navicat (Wine)");
    const [mysql, postgres] = result.groups[0].preview.connections;
    expect(mysql.name).toBe("Wine MySQL");
    expect(mysql.db_type).toBe("mysql");
    expect(mysql.ssl).toBe(true);
    expect(mysql.password).toBe("");
    expect(postgres.db_type).toBe("postgres");
    expect(postgres.database).toBe("postgres");
    expect(postgres.transport_layers?.[0]).toMatchObject({ type: "ssh", host: "bastion.example", port: 22, user: "tunnel" });
  });
  it("loads Navicat saved JSON and NCX as Navicat connections", async () => {
    invoke.mockResolvedValue([
      { source: "navicat", label: "Navicat", path: "/navicat/connections.json", content: JSON.stringify({ connections: [{ name: "Native", connType: "MYSQL", host: "native.example", port: 3306 }] }) },
      { source: "navicat", label: "Navicat", path: "/navicat/export.ncx", content: '<Connections><Connection Name="Exported" ConnType="POSTGRESQL" Host="export.example" Port="5432" /></Connections>' },
    ]);
    const result = await loadInstalledConnectionGroups();
    expect(result.errors).toEqual([]);
    expect(result.groups.map((group) => group.preview.connections[0].name)).toEqual(["Native", "Exported"]);
    expect(result.groups.every((group) => group.source === "navicat")).toBe(true);
  });
  it("reads saved connections automatically and isolates unreadable app sources", async () => {
    invoke.mockResolvedValue([
      { source: "dbeaver", label: "DBeaver", path: "/broken", content: "invalid" },
      {
        source: "rdm",
        label: "Redis Desktop Manager",
        path: "/redis",
        content: JSON.stringify({
          format: "rdm-import",
          content: JSON.stringify([
            { name: "Production", host: "prod.example", port: 6379 },
            { name: "Staging", host: "stage.example", port: 6379 },
          ]),
        }),
      },
    ]);
    const result = await loadInstalledConnectionGroups();
    expect(invoke).toHaveBeenCalledWith("discover_connection_sources");
    expect(result.errors).toHaveLength(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].preview.connections.map((connection) => connection.name)).toEqual(["Production", "Staging"]);
    const selected = result.groups[0].preview.connections[1];
    const combined = combineInstalledConnectionSelections([{ group: result.groups[0], connectionIds: [selected.id] }]);
    expect(combined.connections.map((connection) => connection.name)).toEqual(["Staging"]);
    expect(combineInstalledConnectionSelections([{ group: result.groups[0], connectionIds: [] }]).connections).toEqual([]);
  });
});
