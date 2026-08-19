import { describe, expect, it, vi } from "vitest";
import { CODE_SNAPSHOT_CSS, renderCodeSnapshotHtml } from "@/lib/codeSnapshot/codeSnapshot";

vi.mock("@/lib/ai/aiCodeHighlighter", () => ({
  createAiShikiCodeHighlighter: vi.fn().mockResolvedValue((content: string, _lang: string) => `<span class="line">${content}</span>`),
}));

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
});
