// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import PluginIcon from "./PluginIcon.vue";
import { clearPluginIconCache } from "@/lib/plugins/pluginIconResolver";

const { listPluginsMock, readPluginAssetMock } = vi.hoisted(() => ({
  listPluginsMock: vi.fn(),
  readPluginAssetMock: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listPlugins: listPluginsMock,
  readPluginAsset: readPluginAssetMock,
}));

const mountedApps: App[] = [];

async function mountIcon(icon?: string, contributionId?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(PluginIcon, { pluginId: "example.plugin", icon, contributionId });
  app.mount(container);
  mountedApps.push(app);
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return container;
}

beforeEach(() => {
  clearPluginIconCache();
  listPluginsMock.mockResolvedValue([]);
  readPluginAssetMock.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:plugin-icon"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("PluginIcon", () => {
  it("renders a developer-provided image asset", async () => {
    readPluginAssetMock.mockResolvedValue({ contentType: "image/svg+xml", dataBase64: "PHN2Zy8+", etag: "icon" });

    const container = await mountIcon("assets/icon.svg");

    expect(readPluginAssetMock).toHaveBeenCalledWith("example.plugin", "assets/icon.svg");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:plugin-icon");
  });

  it("falls back when the asset cannot be loaded", async () => {
    readPluginAssetMock.mockRejectedValue(new Error("missing"));

    const container = await mountIcon("assets/missing.svg");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("uses the fallback without reading an undeclared asset", async () => {
    const container = await mountIcon();

    expect(readPluginAssetMock).not.toHaveBeenCalled();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders marketplace icon URLs without reading installed assets", async () => {
    const container = await mountIcon("https://plugins.example.com/icon.svg");

    expect(readPluginAssetMock).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://plugins.example.com/icon.svg");
  });

  it("resolves a contribution icon when the caller does not provide a path", async () => {
    listPluginsMock.mockResolvedValue([
      {
        manifest: {
          id: "example.plugin",
          icon: "assets/plugin.svg",
          contributions: [{ type: "workbench", id: "example.workbench", label: "Example", icon: "assets/workbench.svg" }],
        },
      },
    ]);
    readPluginAssetMock.mockResolvedValue({ contentType: "image/svg+xml", dataBase64: "PHN2Zy8+", etag: "icon" });

    const container = await mountIcon(undefined, "example.workbench");

    expect(readPluginAssetMock).toHaveBeenCalledWith("example.plugin", "assets/workbench.svg");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:plugin-icon");
  });

  it("resolves a filesystem provider icon", async () => {
    listPluginsMock.mockResolvedValue([
      {
        manifest: {
          id: "example.plugin",
          icon: "assets/plugin.svg",
          contributions: [{ type: "filesystem-provider", id: "example.files", label: "Example files", schemes: ["example"], icon: "assets/files.svg" }],
        },
      },
    ]);
    readPluginAssetMock.mockResolvedValue({ contentType: "image/svg+xml", dataBase64: "PHN2Zy8+", etag: "icon" });

    const container = await mountIcon(undefined, "example.files");

    expect(readPluginAssetMock).toHaveBeenCalledWith("example.plugin", "assets/files.svg");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:plugin-icon");
  });
});
