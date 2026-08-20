import { describe, expect, it } from "vitest";
import type { ConnectionConfig, SidebarLayout, TunnelProfile } from "@/types/database";
import { buildConnectionConfigBundle, parseConnectionConfigObject, selectConnectionConfigBundle, snapshotConnectionsForExport } from "./connectionConfigTransfer";

function conn(id: string, name: string, extras: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id,
    name,
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
    ...extras,
  };
}

const layout: SidebarLayout = {
  groups: [
    { id: "prod", name: "Prod", collapsed: false },
    { id: "dev", name: "Dev", collapsed: false },
  ],
  order: [
    {
      type: "group",
      id: "prod",
      children: [
        { type: "connection", id: "a" },
        { type: "connection", id: "b" },
      ],
    },
    {
      type: "group",
      id: "dev",
      children: [{ type: "connection", id: "c" }],
    },
    { type: "connection", id: "d" },
  ],
};

const tunnel1 = { type: "ssh", id: "tunnel-1", host: "bastion-1", port: 22, user: "root" } as TunnelProfile;
const tunnel2 = { type: "ssh", id: "tunnel-2", host: "bastion-2", port: 22, user: "root" } as TunnelProfile;

describe("connectionConfigTransfer", () => {
  it("filters connections, empty groups, and unused tunnel profiles", () => {
    const connections = [
      conn("a", "A", { transport_layers: [{ type: "ssh", id: "layer-a", host: "", port: 22, user: "", profile_id: "tunnel-1" }] }),
      conn("b", "B", { transport_layers: [{ type: "ssh", id: "layer-b", host: "", port: 22, user: "", profile_id: "tunnel-2" }] }),
      conn("c", "C", { transport_layers: [{ type: "ssh", id: "layer-c", host: "", port: 22, user: "", profile_id: "tunnel-1" }] }),
      conn("d", "D"),
    ];

    const bundle = buildConnectionConfigBundle(connections, layout, [tunnel1, tunnel2], ["a", "c"]);
    expect(bundle.connections.map((connection) => connection.id)).toEqual(["a", "c"]);
    expect(bundle.layout?.groups.map((group) => group.name)).toEqual(["Prod", "Dev"]);
    expect(bundle.tunnelProfiles?.map((profile) => profile.id)).toEqual(["tunnel-1"]);
    expect(bundle.connections.some((connection) => connection.id === "b")).toBe(false);
  });

  it("keeps a shared tunnel profile only once", () => {
    const connections = [conn("a", "A", { transport_layers: [{ type: "ssh", id: "layer-a", host: "", port: 22, user: "", profile_id: "tunnel-1" }] }), conn("c", "C", { transport_layers: [{ type: "ssh", id: "layer-c", host: "", port: 22, user: "", profile_id: "tunnel-1" }] })];
    const bundle = buildConnectionConfigBundle(connections, null, [tunnel1, tunnel1, tunnel2], ["a", "c"]);
    expect(bundle.tunnelProfiles).toEqual([tunnel1]);
  });

  it("exports the full set when no selection is provided", () => {
    const connections = [conn("a", "A"), conn("b", "B"), conn("c", "C"), conn("d", "D")];
    const bundle = buildConnectionConfigBundle(connections, layout, [tunnel1], undefined);
    expect(bundle.connections.map((connection) => connection.id)).toEqual(["a", "b", "c", "d"]);
    expect(bundle.layout?.order.some((entry) => entry.type === "connection" && entry.id === "d")).toBe(true);
  });

  it("snapshots inherited timeouts before filtering", () => {
    const exported = snapshotConnectionsForExport([conn("a", "A", { connect_timeout_inherit: true, connect_timeout_secs: 99, query_timeout_inherit: true, query_timeout_secs: 99 })], {
      connectTimeoutSecs: () => 7,
      queryTimeoutSecs: () => 12,
    });
    expect(exported[0]).toMatchObject({
      connect_timeout_secs: 7,
      connect_timeout_inherit: true,
      query_timeout_secs: 12,
      query_timeout_inherit: true,
    });
  });

  it("parses legacy arrays and dbx-config payloads without inventing a layout", () => {
    expect(parseConnectionConfigObject([conn("a", "A")])).toEqual({ connections: [conn("a", "A")] });
    expect(parseConnectionConfigObject({ format: "dbx-config", connections: [conn("a", "A")] })).toEqual({ connections: [conn("a", "A")] });
  });

  it("selects a preview subset without mutating the original preview", () => {
    const preview = {
      connections: [conn("a", "A"), conn("b", "B"), conn("c", "C")],
      layout,
      tunnelProfiles: [tunnel1, tunnel2],
    };
    const selected = selectConnectionConfigBundle(preview, ["a", "c"]);
    expect(selected.connections.map((connection) => connection.id)).toEqual(["a", "c"]);
    expect(preview.connections).toHaveLength(3);
    expect(selected.layout?.order.some((entry) => entry.type === "connection" && entry.id === "d")).toBe(false);
  });
});
