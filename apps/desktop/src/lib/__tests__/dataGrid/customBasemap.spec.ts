import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { escapeCustomBasemapAttribution, loadCustomBasemapConfig, loadSelectedBasemapId, normalizeCustomBasemapConfig, resolveSelectedBasemapId, saveCustomBasemapConfig, saveSelectedBasemapId } from "@/lib/dataGrid/customBasemap";

const layerPreviewSource = readFileSync(new URL("../../../components/grid/LayerPreviewDialog.vue", import.meta.url), "utf8");

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("custom basemap configuration", () => {
  it("keeps a saved custom basemap available after switching to a built-in basemap", () => {
    expect(layerPreviewSource).toMatch(/<option v-if="customBasemapConfig" value="custom">/);
    expect(layerPreviewSource).toMatch(/id === "custom" && customBasemapConfig\.value/);
    expect(layerPreviewSource).toMatch(/v-model="customBasemapName"/);
  });

  it("normalizes a valid XYZ configuration", () => {
    expect(
      normalizeCustomBasemapConfig({
        name: " Gaode streets ",
        url: " https://a.example/{z}/{x}/{y}.png ",
        overlayUrl: "https://b.example/{z}/{x}/{y}.png",
        attribution: " Example ",
        maxZoom: 30.2,
      }),
    ).toEqual({
      name: "Gaode streets",
      url: "https://a.example/{z}/{x}/{y}.png",
      overlayUrl: "https://b.example/{z}/{x}/{y}.png",
      attribution: "Example",
      maxZoom: 24,
    });
  });

  it("rejects invalid protocols and incomplete templates", () => {
    expect(normalizeCustomBasemapConfig({ name: "Unsafe", url: "javascript:alert(1)" })).toBeNull();
    expect(normalizeCustomBasemapConfig({ name: "Incomplete", url: "https://tiles.example/{z}/{x}.png" })).toBeNull();
    expect(normalizeCustomBasemapConfig({ name: "Overlay", url: "https://tiles.example/{z}/{x}/{y}.png", overlayUrl: "not a url" })).toBeNull();
    expect(normalizeCustomBasemapConfig({ name: "", url: "https://tiles.example/{z}/{x}/{y}.png" })).toBeNull();
  });

  it("round-trips through session storage", () => {
    const target = storage();
    const config = { name: "My tiles", url: "https://tiles.example/{z}/{x}/{y}.png", overlayUrl: "", attribution: "Tiles", maxZoom: 18 };
    expect(saveCustomBasemapConfig(target, config)).toBe(true);
    expect(loadCustomBasemapConfig(target)).toEqual(config);
  });

  it("treats custom attribution as plain text", () => {
    const malicious = `<img src=x onerror="alert(1)"><svg onload='alert(2)'><script>alert(3)</script>&`;
    const escaped = escapeCustomBasemapAttribution(malicious);

    expect(escaped).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;svg onload=&#39;alert(2)&#39;&gt;&lt;script&gt;alert(3)&lt;/script&gt;&amp;");
    expect(escaped).not.toMatch(/<(?:img|svg|script)\b/i);
    expect(layerPreviewSource).toMatch(/basemap\.custom \? escapeCustomBasemapAttribution\(basemap\.attribution\) : basemap\.attribution/);
  });

  it("persists the actual basemap selection separately from the custom configuration", () => {
    const target = storage();
    expect(saveSelectedBasemapId(target, "custom")).toBe(true);
    expect(loadSelectedBasemapId(target)).toBe("custom");

    expect(saveSelectedBasemapId(target, "osm")).toBe(true);
    expect(loadSelectedBasemapId(target)).toBe("osm");
    expect(layerPreviewSource).toMatch(/saveSelectedBasemapId\(basemapStorage, basemap\.id\)/);
  });

  it("does not enable a stored custom basemap unless it was selected", () => {
    const builtInIds = ["osm", "satellite"];
    expect(resolveSelectedBasemapId(null, builtInIds, true)).toBe("osm");
    expect(resolveSelectedBasemapId("osm", builtInIds, true)).toBe("osm");
    expect(resolveSelectedBasemapId("custom", builtInIds, true)).toBe("custom");
    expect(resolveSelectedBasemapId("custom", builtInIds, false)).toBe("osm");
  });

  it("restores legacy session data with a fallback name", () => {
    const target = storage();
    target.setItem("dbx-layer-preview-custom-basemap", JSON.stringify({ url: "https://tiles.example/{z}/{x}/{y}.png", overlayUrl: "", attribution: "Tiles", maxZoom: 18 }));
    expect(loadCustomBasemapConfig(target)?.name).toBe("Custom basemap");
  });
});
