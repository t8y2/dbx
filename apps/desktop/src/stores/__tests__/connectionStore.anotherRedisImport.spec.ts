// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "@/stores/connectionStore";

const mocks = vi.hoisted(() => ({ open: vi.fn(), readFile: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: mocks.readFile }));

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  mocks.open.mockReset();
  mocks.readFile.mockReset();
});

describe("Another Redis native file import pipeline", () => {
  it("filters .ano files and parses them before any connections are saved", async () => {
    mocks.open.mockResolvedValue("C:/fixtures/connections.ano");
    const data = Buffer.from(JSON.stringify([{ host: "localhost", name: "开发", auth: "test-password" }])).toString("base64");
    mocks.readFile.mockResolvedValue(new TextEncoder().encode(data));
    const store = useConnectionStore();
    const file = await store.readImportFile("another-redis");
    expect(mocks.open).toHaveBeenCalledWith({ filters: [{ name: "Another Redis Desktop Manager", extensions: ["ano"] }], multiple: false });
    expect(mocks.readFile).toHaveBeenCalledWith("C:/fixtures/connections.ano");
    expect(file?.encrypted).toBe(false);
    const preview = await store.parseConnectionsImport(file!.content, null);
    expect(preview.connections[0]).toMatchObject({ host: "localhost", name: "开发", password: "test-password" });
    expect(store.connections).toHaveLength(0);
  });
  it("treats cancelling the file picker as a no-op", async () => {
    mocks.open.mockResolvedValue(null);
    expect(await useConnectionStore().readImportFile("another-redis")).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
