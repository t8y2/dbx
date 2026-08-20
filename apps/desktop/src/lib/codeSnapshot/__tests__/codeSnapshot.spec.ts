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
    expect(html).toContain(".dbx-code-snapshot *");
    expect(html).toContain("border: 0");
    expect(html).toContain("outline: 0");
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
      await snapshotElementToPng({ offsetWidth: 320, offsetHeight: 160, scrollWidth: 640, scrollHeight: 240 } as HTMLElement);

      expect(toPng).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          width: 640,
          height: 240,
          scale: 2,
          style: {
            width: "640px",
            height: "240px",
          },
        }),
      );

      vi.stubGlobal("window", { devicePixelRatio: 0 });
      await snapshotElementToPng({ offsetWidth: 320, offsetHeight: 160, scrollWidth: 320, scrollHeight: 160 } as HTMLElement);
      expect(toPng).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scale: 1 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reduces the export scale when a wide snapshot reaches the canvas edge limit", async () => {
    toPng.mockResolvedValue("data:image/png;base64,test");
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    try {
      await snapshotElementToPng({ offsetWidth: 10_000, offsetHeight: 100, scrollWidth: 10_000, scrollHeight: 100 } as HTMLElement);

      expect(toPng).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scale: 16_384 / 10_000 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reduces the export scale when a tall snapshot reaches the canvas edge limit", async () => {
    toPng.mockResolvedValue("data:image/png;base64,test");
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    try {
      await snapshotElementToPng({ offsetWidth: 100, offsetHeight: 10_000, scrollWidth: 100, scrollHeight: 10_000 } as HTMLElement);

      expect(toPng).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scale: 16_384 / 10_000 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reduces the export scale when a dense snapshot reaches the total pixel limit", async () => {
    toPng.mockResolvedValue("data:image/png;base64,test");
    vi.stubGlobal("window", { devicePixelRatio: 2 });
    try {
      await snapshotElementToPng({ offsetWidth: 6_000, offsetHeight: 6_000, scrollWidth: 6_000, scrollHeight: 6_000 } as HTMLElement);

      expect(toPng).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scale: Math.sqrt((64 * 1024 * 1024) / (6_000 * 6_000)) }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects snapshots that exceed the safe rendering budget at 1x", async () => {
    toPng.mockClear();

    await expect(snapshotElementToPng({ offsetWidth: 20_000, offsetHeight: 100, scrollWidth: 20_000, scrollHeight: 100 } as HTMLElement)).rejects.toThrow("Snapshot is too large to export safely (20000 × 100px)");
    expect(toPng).not.toHaveBeenCalled();
  });

  it("propagates a failed native save instead of reporting a browser download", async () => {
    isTauriRuntime.mockReturnValue(true);
    save.mockResolvedValue("C:\\Users\\example\\snapshot.png");
    writeFile.mockRejectedValue(new Error("disk full"));

    await expect(savePngDataUrlToFile("data:image/png;base64,AA==", "snapshot.png")).rejects.toThrow("disk full");
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
