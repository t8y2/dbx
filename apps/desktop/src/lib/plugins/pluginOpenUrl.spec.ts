// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { permittedPluginUrl, pluginOpenUrlOrigins } from "./pluginOpenUrl";
import { PluginHostBridge } from "./pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

describe("plugin external URL permissions", () => {
  const permissions = ["host.openUrl:https://docs.example.com", "host.openUrl:http://localhost:8080", "host.openUrl:https://[::1]:8443"];
  it("matches only exact canonical HTTP(S) origins, independently of networking", () => {
    expect(permittedPluginUrl("https://docs.example.com/guide?q=one#usage", permissions)).toBe("https://docs.example.com/guide?q=one#usage");
    expect(permittedPluginUrl("http://localhost:8080/path", permissions)).toBe("http://localhost:8080/path");
    expect(permittedPluginUrl("https://[::1]:8443/path", permissions)).toBe("https://[::1]:8443/path");
    expect(pluginOpenUrlOrigins(["host.network:https://docs.example.com", "host.openUrl", "host.openUrl:*", "host.openUrl:https://docs.example.com/", "host.openUrl:https://docs.example.com:443", "host.openUrl:https://user@docs.example.com", "host.openUrl:https://*.example.com"])).toEqual([]);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "mailto:user@example.com",
    "https://docs.example.com.evil.test",
    "https://evil.test/docs.example.com",
    "http://docs.example.com",
    "https://docs.example.com:8443",
    "https://user:pass@docs.example.com/",
    "//docs.example.com",
    "https://docs.example.com/\nhttps://evil.test",
    "https://docs.example.com\\@evil.test",
    "https://docs.example.com/" + "a".repeat(4096),
    null,
    42,
  ])("rejects disallowed input %s", (value) => expect(() => permittedPluginUrl(value, permissions)).toThrow());
  it("bounds declaration lists and ignores malformed origins", () => {
    expect(pluginOpenUrlOrigins(Array.from({ length: 10 }, (_, index) => `host.openUrl:https://site${index}.test`))).toHaveLength(8);
  });
  it("gates bridge calls, trusts neither message-supplied plugin IDs nor alien frames, and returns consent decisions", async () => {
    const responses: any[] = [];
    const target = { postMessage: (message: unknown) => responses.push(message) } as unknown as Window;
    const openUrl = vi.fn().mockResolvedValueOnce({ opened: false }).mockResolvedValueOnce({ opened: true });
    const plugin = { manifest: { id: "bookmarks", name: "Bookmarks", version: "1.0.0", permissions, drivers: [], contributions: [] }, compatibility: { compatible: true } } as InstalledPlugin;
    const bridge = new PluginHostBridge(plugin, { type: "workbench", id: "bookmarks.main", label: "Bookmarks" } as PluginWorkbenchContribution, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn(), openUrl });
    const send = (url: string, id: string, source = target) => bridge.handleWindowMessage({ source, data: { source: "dbx-plugin", version: 1, type: "request", id, method: "host.openUrl", params: { url, pluginId: "different-plugin" } } } as MessageEvent);
    send("https://evil.test", "1");
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(openUrl).not.toHaveBeenCalled();
    expect(responses[0].error).toContain("not declared");
    send("https://docs.example.com/guide", "2", {} as Window);
    await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
    send("https://docs.example.com/guide", "3");
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(responses[1].result).toEqual({ opened: false });
    send("https://docs.example.com/guide", "4");
    await vi.waitFor(() => expect(responses).toHaveLength(3));
    expect(responses[2].result).toEqual({ opened: true });
    expect(openUrl).toHaveBeenLastCalledWith("https://docs.example.com/guide");
    bridge.dispose();
  });
});
