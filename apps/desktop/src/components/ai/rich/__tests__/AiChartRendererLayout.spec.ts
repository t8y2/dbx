import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(new URL("../AiChartRenderer.vue", import.meta.url), "utf8");

describe("AiChartRenderer layout", () => {
  it("establishes the chart height on the parent that vue-echarts fills", () => {
    expect(rendererSource).toContain("min-h-60 h-[clamp(15rem,35vw,20rem)]");
    expect(rendererSource).toContain('class="min-h-0 flex-1"');
    expect(rendererSource).toContain('class="h-full w-full p-2"');
    expect(rendererSource).not.toContain('class="h-80 w-full p-2"');
  });

  it("uses the native save dialog and binary writer for PNGs in Tauri", () => {
    expect(rendererSource).toContain('await import("@tauri-apps/plugin-dialog")');
    expect(rendererSource).toContain('await import("@tauri-apps/plugin-fs")');
    expect(rendererSource).toContain("await writeFile(path, new Uint8Array(await blob.arrayBuffer()))");
  });

  it("surfaces download failures through a localized toast instead of a hardcoded English tooltip", () => {
    expect(rendererSource).toContain("t('ai.chartDownloadPng')");
    expect(rendererSource).toContain('toast(t("ai.chartDownloadFailed"))');
    const savePath = rendererSource.slice(rendererSource.indexOf("await writeFile(path, new Uint8Array(await blob.arrayBuffer()))"));
    expect(savePath).toContain('} catch {\n    toast(t("ai.chartDownloadFailed"));\n  }');
    expect(rendererSource).not.toContain('title="Download PNG"');
    expect(rendererSource).not.toContain('aria-label="Download PNG"');
    expect(rendererSource).toContain('t("ai.chartData")');
  });
});
