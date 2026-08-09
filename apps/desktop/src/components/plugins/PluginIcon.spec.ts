// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import PluginIcon from "./PluginIcon.vue";

const { readPluginAssetMock } = vi.hoisted(() => ({
  readPluginAssetMock: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  readPluginAsset: readPluginAssetMock,
}));

const mountedApps: App[] = [];

async function mountIcon(icon?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(PluginIcon, { pluginId: "example.plugin", icon });
  app.mount(container);
  mountedApps.push(app);
  await Promise.resolve();
  await nextTick();
  return container;
}

beforeEach(() => {
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
});
