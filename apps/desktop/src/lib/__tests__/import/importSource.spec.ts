import { describe, expect, it } from "vitest";
import { importPreviewInput, importSourceDisplayName, importTextDelimiterForName, uploadedImportSourceFromPreview } from "@/lib/import/importSource";

describe("importSource", () => {
  it("reuses an uploaded sourceRef and server path on later previews", () => {
    const file = new File(["id\n1"], "orders.csv");
    const first = importPreviewInput(null, file);
    expect(first).toEqual({ fileOrPath: file, sourceRef: null });

    const uploaded = uploadedImportSourceFromPreview({ sourceRef: "src-1", filePath: "/tmp/orders.csv" });
    expect(importPreviewInput(uploaded, file)).toEqual({ fileOrPath: "/tmp/orders.csv", sourceRef: "src-1" });
  });

  it("keeps a local path preview on desktop when nothing has been uploaded", () => {
    expect(importPreviewInput(null, "/data/orders.csv")).toEqual({ fileOrPath: "/data/orders.csv", sourceRef: null });
  });

  it("matches table-import TSV delimiter encoding and source labels", () => {
    expect(importTextDelimiterForName("orders.tsv")).toBe("\\t");
    expect(importTextDelimiterForName("orders.csv")).toBe(",");
    expect(importSourceDisplayName("/tmp/dir/orders.csv")).toBe("orders.csv");
    expect(importSourceDisplayName(new File(["x"], "people.json"))).toBe("people.json");
  });
});
