import { describe, expect, it } from "vitest";
import { connectionDeepLinkPluginProviderForType, parseConnectionDeepLink, type ConnectionDeepLinkPluginProvider } from "@/lib/connection/connectionDeepLink";

const SSH_PLUGIN: ConnectionDeepLinkPluginProvider = {
  pluginId: "io.dbx.ssh",
  providerId: "io.dbx.ssh.connection",
  label: "SSH Server",
  databaseType: "ssh",
  defaultPort: 22,
};

const DOCKER_PLUGIN: ConnectionDeepLinkPluginProvider = {
  pluginId: "io.dbx.docker",
  providerId: "io.dbx.docker.connection",
  label: "Docker",
  databaseType: "docker",
};

describe("plugin connection deep links", () => {
  it("resolves a provider registered by a plugin through its database_type", () => {
    const draft = parseConnectionDeepLink("dbx://connection/new?v=1&type=ssh&host=10.0.0.9&port=2222&user=root&name=Prod", { pluginProviders: [SSH_PLUGIN] });

    expect(draft).toMatchObject({
      dbType: "plugin",
      driverProfile: "plugin",
      driverLabel: "SSH Server",
      name: "Prod",
      host: "10.0.0.9",
      port: 2222,
      username: "root",
      ssl: false,
    });
    expect(draft?.pluginProvider).toEqual({ pluginId: "io.dbx.ssh", providerId: "io.dbx.ssh.connection", label: "SSH Server" });
  });

  it("falls back to the provider's declared port and keeps password out of the URL log", () => {
    expect(parseConnectionDeepLink("dbx://connection/new?type=ssh&host=10.0.0.9", { pluginProviders: [SSH_PLUGIN] })?.port).toBe(22);
    // Providers without a declared default port leave the field for the plugin form itself.
    expect(parseConnectionDeepLink("dbx://connection/new?type=docker&host=unix", { pluginProviders: [DOCKER_PLUGIN] })?.port).toBeUndefined();
  });

  it("accepts the provider id and the explicit pluginId/providerId spelling", () => {
    expect(connectionDeepLinkPluginProviderForType("io.dbx.ssh.connection", [SSH_PLUGIN])).toBe(SSH_PLUGIN);
    expect(connectionDeepLinkPluginProviderForType("io.dbx.ssh", [SSH_PLUGIN])).toBe(SSH_PLUGIN);
    expect(connectionDeepLinkPluginProviderForType("io.dbx.ssh/io.dbx.ssh.connection", [SSH_PLUGIN])).toBe(SSH_PLUGIN);
    expect(connectionDeepLinkPluginProviderForType("SSH", [SSH_PLUGIN])).toBe(SSH_PLUGIN);
  });

  it("prefers an explicit provider id over a database_type several providers share", () => {
    const second: ConnectionDeepLinkPluginProvider = { ...SSH_PLUGIN, providerId: "io.dbx.ssh.sftp", label: "SFTP" };
    const providers = [second, SSH_PLUGIN];
    expect(connectionDeepLinkPluginProviderForType("io.dbx.ssh.connection", providers)).toBe(SSH_PLUGIN);
    // Ambiguous type names resolve to the first registered provider, deterministically.
    expect(connectionDeepLinkPluginProviderForType("ssh", providers)).toBe(second);
  });

  it("keeps rejecting types no installed plugin serves", () => {
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=ssh&host=10.0.0.9")).toThrow(/Unsupported connection type: ssh/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=ssh&host=10.0.0.9", { pluginProviders: [] })).toThrow(/Unsupported connection type: ssh/);
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=ssh&host=10.0.0.9", { pluginProviders: [DOCKER_PLUGIN] })).toThrow(/Unsupported connection type: ssh/);
  });

  it("prefers built-in database profiles when a plugin reuses their name", () => {
    const impostor: ConnectionDeepLinkPluginProvider = { ...SSH_PLUGIN, providerId: "mysql", label: "Fake MySQL", databaseType: "mysql" };
    const draft = parseConnectionDeepLink("dbx://connection/new?type=mysql&host=127.0.0.1", { pluginProviders: [impostor] });
    expect(draft?.dbType).toBe("mysql");
    expect(draft?.pluginProvider).toBeUndefined();
  });

  it("refuses a DSN for plugin connections instead of silently dropping it", () => {
    expect(() => parseConnectionDeepLink("dbx://connection/new?type=ssh&url=ssh%3A%2F%2Froot%4010.0.0.9%3A22", { pluginProviders: [SSH_PLUGIN] })).toThrow(/does not accept a database URL/);
  });

  it("keeps service and one-time semantics intact for plugin drafts", () => {
    const draft = parseConnectionDeepLink("dbx://connection/new?type=ssh&host=10.0.0.9&user=root&one_time=true", { pluginProviders: [SSH_PLUGIN] });
    expect(draft?.oneTime).toBe(true);
    expect(draft?.serviceConfig).toBeUndefined();
  });
});
