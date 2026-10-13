// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn().mockResolvedValue({ size: 100 }),
  saveConnections: vi.fn().mockResolvedValue(undefined),
  connectDb: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile, stat: mocks.stat }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ rebindDetachedTabs: () => 0 }) }));
vi.mock("@/lib/backend/api", () => ({
  saveConnections: mocks.saveConnections,
  connectDb: mocks.connectDb,
  saveAppSettings: mocks.saveSettings,
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  loadTunnelProfiles: vi.fn().mockResolvedValue([]),
}));

import { useConnectionStore } from "@/stores/connectionStore";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  localStorage.clear();
  mocks.stat.mockResolvedValue({ size: 100 });
});
afterEach(() => vi.useRealTimers());

describe("Studio 3T native import flow", () => {
  it("reads only explicitly selected URI files and preserves URI options when saving a selection", async () => {
    mocks.open.mockResolvedValue(["D:\\exports\\First.uri", "D:\\exports\\Second.uri"]);
    mocks.readFile.mockImplementation(async (path: string) => new TextEncoder().encode(path.endsWith("First.uri") ? "mongodb://a,b/app?replicaSet=rs&authSource=admin" : "mongodb+srv://cluster.example.com/?tls=false"));
    const store = useConnectionStore();

    const file = await store.readImportFile("studio3t");
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, filters: [{ name: "Studio 3T MongoDB URI", extensions: ["uri"] }] }));
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual(["D:\\exports\\First.uri", "D:\\exports\\Second.uri"]);
    const preview = await store.parseConnectionsImport(file!.content, null);
    expect(preview.connections).toHaveLength(2);
    expect(mocks.saveConnections).not.toHaveBeenCalled();
    expect(mocks.connectDb).not.toHaveBeenCalled();

    const result = await store.applyConnectionsImport(preview, [preview.connections[1].id]);
    expect(result.count).toBe(1);
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0]).toMatchObject({ name: "Second", connection_string: "mongodb+srv://cluster.example.com/?tls=false", ssl: false });
    expect(mocks.saveConnections).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "Second" })]));
    expect(mocks.connectDb).not.toHaveBeenCalled();
  });

  it("returns cancelled from the native picker without reading or saving", async () => {
    mocks.open.mockResolvedValue(null);
    const store = useConnectionStore();
    expect(await store.readImportFile("studio3t")).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.saveConnections).not.toHaveBeenCalled();
  });

  it("previews exported names, SSH settings and invalid database warnings before saving selected connections", async () => {
    mocks.open.mockResolvedValue(["D:\\exports\\Studio3T.uri"]);
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        "// Studio 3T Export\n// SSH fixture\nmongodb://u:p@localhost/?authSource=admin&3t.uriVersion=3&3t.connection.name=SSH+fixture&3t.ssh=true&3t.sshAddress=jump.example.test&3t.sshPort=22&3t.sshAuthMode=privateKey&3t.sshUser=fixture&3t.sshPKPath=D%3A%5Ckeys%5Cid_ed25519&3t.sshUsePKPassphrase=false\n\n" +
          "// Review fixture\nmongodb://u:p@localhost/%24invalid?authSource=admin&3t.uriVersion=3&3t.connection.name=Review+fixture",
      ),
    );
    const store = useConnectionStore();
    const file = await store.readImportFile("studio3t");
    const preview = await store.parseConnectionsImport(file!.content, null);
    expect(preview.connections.map((connection) => connection.name)).toEqual(["SSH fixture", "Review fixture"]);
    expect(preview.importWarnings).toHaveLength(1);
    expect(preview.connections[0].transport_layers?.[0]).toMatchObject({ type: "ssh", host: "jump.example.test", key_path: "D:\\keys\\id_ed25519" });
    expect(preview.connections[1]).toMatchObject({ database: undefined, connection_string: "mongodb://u:p@localhost/?authSource=admin" });
    expect(mocks.saveConnections).not.toHaveBeenCalled();
    expect(mocks.connectDb).not.toHaveBeenCalled();
    await store.applyConnectionsImport(preview, [preview.connections[0].id]);
    expect(store.connections).toHaveLength(1);
    expect(store.connections[0].transport_layers?.[0]).toMatchObject({ enabled: true, auth_method: "key", host: "jump.example.test" });
    expect(mocks.connectDb).not.toHaveBeenCalled();
  });

  it("rejects an oversized selected file before reading it into memory", async () => {
    mocks.open.mockResolvedValue(["D:\\exports\\large.uri"]);
    mocks.stat.mockResolvedValue({ size: 10 * 1024 * 1024 + 1 });
    await expect(useConnectionStore().readImportFile("studio3t")).rejects.toThrow(/10 MiB/);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.saveConnections).not.toHaveBeenCalled();
  });

  it("localizes malformed or unsupported files without exposing secrets", async () => {
    const store = useConnectionStore();
    for (const content of ["mongodb://u:secret@host/?sshHost=secret", '{"password":"secret"}']) {
      const payload = JSON.stringify({ format: "studio3t-uri-import", files: [{ name: "Example.uri", content }] });
      await expect(store.parseConnectionsImport(payload, null)).rejects.toThrow(/Studio 3T/);
      await expect(store.parseConnectionsImport(payload, null)).rejects.not.toThrow("secret");
    }
    expect(mocks.saveConnections).not.toHaveBeenCalled();
  });
});
