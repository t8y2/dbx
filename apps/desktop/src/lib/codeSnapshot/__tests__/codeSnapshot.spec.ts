import { describe, expect, it, vi } from "vitest";
import { CODE_SNAPSHOT_CSS, renderCodeSnapshotHtml, savePngDataUrlToFile, snapshotElementToPng } from "@/lib/codeSnapshot/codeSnapshot";

const { toPng, isTauriRuntime, save, writeFile } = vi.hoisted(() => ({
  toPng: vi.fn(),
  isTauriRuntime: vi.fn(),
  save: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/lib/ai/aiCodeHighlighter", () => ({
  createAiShikiCodeHighlighter: vi.fn().mockResolvedValue((content: string, _lang: string) => `<span class="line">${content}</span>`),
}));

vi.mock("dom-to-image-more", () => ({
  default: { toPng },
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile }));

describe("renderCodeSnapshotHtml", () => {
  it("renders a self-contained snapshot with embedded styles", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "dark" });

    expect(html).toContain("<style>");
    expect(html).toContain(CODE_SNAPSHOT_CSS);
    expect(html).toContain('class="dbx-code-snapshot"');
    expect(html).toContain('data-snapshot-appearance="dark"');
    expect(html).toContain('class="dbx-code-snapshot__pre dbx-code-snapshot__pre--numbered"');
  });

  it("renders macOS traffic lights and an optional title by default", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql", title: "Query example" }, { appearance: "dark" });

    expect(html).toContain('class="dbx-code-snapshot__bar"');
    expect(html).toContain("#ff5f57");
    expect(html).toContain("#febc2e");
    expect(html).toContain("#28c840");
    expect(html).toContain("Query example");
  });

  it("hides the bar when traffic lights are disabled and no title is set", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "light", showTrafficLights: false });

    expect(html).not.toContain('class="dbx-code-snapshot__bar"');
  });

  it("keeps the title bar but hides traffic lights when window controls are disabled", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql", title: "Query example" }, { appearance: "dark", showTrafficLights: false });

    expect(html).toContain('class="dbx-code-snapshot__bar"');
    expect(html).toContain("Query example");
    expect(html).not.toContain('class="dbx-code-snapshot__dot"');
  });

  it("hides line numbers when disabled", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "light", showLineNumbers: false });

    expect(html).toContain('class="dbx-code-snapshot__pre"');
    expect(html).not.toContain('class="dbx-code-snapshot__pre dbx-code-snapshot__pre--numbered"');
  });

  it("escapes the snapshot title", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql", title: `<script>alert(1)</script>` }, { appearance: "dark" });

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("applies the appearance-specific background and line-number color", async () => {
    const dark = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "dark" });
    const light = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "light" });

    expect(dark).toContain("background:#0d1117");
    expect(dark).toContain("--dbx-snapshot-line-number:#484f58");
    expect(light).toContain("background:#ffffff");
    expect(light).toContain("--dbx-snapshot-line-number:#d0d7de");
  });

  it("applies custom padding and font size", async () => {
    const html = await renderCodeSnapshotHtml({ code: "SELECT 1", lang: "sql" }, { appearance: "dark", padding: 24, fontSize: 15 });

    expect(html).toContain("font-size:15px");
    expect(html).toContain("padding:0 24px 24px");
  });

  it("exports at a capped device-pixel ratio for crisp high-DPI snapshots", async () => {
    toPng.mockResolvedValue("data:image/png;base64,test");
    vi.stubGlobal("window", { devicePixelRatio: 3 });
    try {
      await snapshotElementToPng({ offsetWidth: 320, offsetHeight: 160 } as HTMLElement);

      expect(toPng).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          width: 320,
          height: 160,
          pixelRatio: 2,
        }),
      );

      vi.stubGlobal("window", { devicePixelRatio: 0 });
      await snapshotElementToPng({ offsetWidth: 320, offsetHeight: 160 } as HTMLElement);
      expect(toPng).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ pixelRatio: 1 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates a failed native save instead of reporting a browser download", async () => {
    isTauriRuntime.mockReturnValue(true);
    save.mockResolvedValue("C:\\Users\\example\\snapshot.png");
    writeFile.mockRejectedValue(new Error("disk full"));

    await expect(savePngDataUrlToFile("data:image/png;base64,AA==", "snapshot.png")).rejects.toThrow("disk full");
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
