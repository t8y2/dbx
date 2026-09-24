import { describe, expect, it } from "vitest";
import type { ConnectionConfig, SidebarLayout, TunnelProfile } from "@/types/database";
import { buildConnectionConfigBundle, parseConnectionConfigObject, prepareConnectionConfigImport, scrubConnectionForPlaintextExport, scrubTunnelProfileForPlaintextExport, selectConnectionConfigBundle, snapshotConnectionsForExport } from "./connectionConfigTransfer";

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

  it("keeps stable ids and removes secrets from plaintext exports", () => {
    const exported = scrubConnectionForPlaintextExport(
      conn("stable", "A", {
        password: "db-password",
        init_script: "CREATE USER secret",
        connection_string: "postgres://user:password@host/db",
        url_params: "applicationName=dbx&PASSWORD=url-password&sslmode=require",
        connection_secrets: { api_token: "plugin-token" },
        transport_layers: [{ type: "ssh", id: "layer", host: "bastion", port: 22, user: "root", password: "ssh-password", key_passphrase: "key-password" }],
        external_config: { auth: { password: "nested-password" }, safe: "value" },
      }),
    );
    expect(exported.id).toBe("stable");
    expect(exported.password).toBe("");
    expect(exported.connection_secrets).toEqual({});
    expect(JSON.stringify(exported)).not.toContain("db-password");
    expect(JSON.stringify(exported)).not.toContain("nested-password");
    expect(JSON.stringify(exported)).not.toContain("plugin-token");
    expect(exported.url_params).toBe("applicationName=dbx&PASSWORD=&sslmode=require");
    expect(JSON.stringify(exported)).not.toContain("url-password");
    expect(scrubTunnelProfileForPlaintextExport({ type: "http_tunnel", id: "t", url: "https://example", token: "token" })).toMatchObject({ id: "t", token: "" });
  });

  it("redacts structured API key auth without removing unrelated values or mutating the source", () => {
    const source = conn("mq", "MQ", {
      external_config: {
        auth: { kind: "apiKey", header: "X-Api-Key", value: "api-key-secret" },
        value: "public-root",
        nested: [{ auth: { kind: "apiKey", header: "Authorization", value: "nested-api-key" } }, { auth: { kind: "basic", username: "user", password: "basic-password", value: "public-auth" } }, { kind: "apiKey", value: "public-non-auth" }],
      },
    });

    const exported = scrubConnectionForPlaintextExport(source);

    expect(exported.external_config).toEqual({
      auth: { kind: "apiKey", header: "X-Api-Key", value: "" },
      value: "public-root",
      nested: [{ auth: { kind: "apiKey", header: "Authorization", value: "" } }, { auth: { kind: "basic", username: "user", password: "", value: "public-auth" } }, { kind: "apiKey", value: "public-non-auth" }],
    });
    expect(source.external_config).toMatchObject({ auth: { value: "api-key-secret" } });
    expect(JSON.stringify(exported)).not.toContain("api-key-secret");
    expect(JSON.stringify(exported)).not.toContain("nested-api-key");
    expect(JSON.stringify(exported)).not.toContain("basic-password");
  });

  it("parses legacy arrays and dbx-config payloads without inventing a layout", () => {
    expect(parseConnectionConfigObject([conn("a", "A")])).toEqual({ connections: [conn("a", "A")] });
    expect(parseConnectionConfigObject({ format: "dbx-config", connections: [conn("a", "A")] })).toEqual({ connections: [conn("a", "A")] });
  });

  it("remaps ordinary import IDs on collision and updates tunnel/layout references", () => {
    const imported = prepareConnectionConfigImport(
      {
        connections: [conn("same", "Imported", { transport_layers: [{ type: "ssh", id: "layer", host: "", port: 22, user: "", profile_id: "tp" }] })],
        tunnelProfiles: [{ ...tunnel1, id: "tp" }],
        layout: { groups: [], order: [{ type: "connection", id: "same" }] },
      },
      ["same"],
      ["tp"],
      (() => {
        let n = 0;
        return () => `new-${++n}`;
      })(),
    );
    expect(imported.connections[0].id).toBe("new-1");
    expect(imported.connections[0].transport_layers?.[0].profile_id).toBe("new-2");
    expect(imported.tunnelProfiles?.[0].id).toBe("new-2");
    expect(imported.layout?.order[0]).toEqual({ type: "connection", id: "new-1" });
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
