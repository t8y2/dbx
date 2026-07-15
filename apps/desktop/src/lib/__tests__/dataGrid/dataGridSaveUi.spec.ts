import { describe, expect, it } from "vitest";
import { dataGridPreviewLabelKey } from "@/lib/dataGrid/dataGridSaveUi";

describe("dataGridPreviewLabelKey", () => {
  it("offers a query preview for document databases that never emit SQL", () => {
    expect(dataGridPreviewLabelKey("mongodb")).toBe("toolbar.previewQuery");
    expect(dataGridPreviewLabelKey("elasticsearch")).toBe("toolbar.previewQuery");
  });

  it("keeps the SQL wording for SQL databases", () => {
    expect(dataGridPreviewLabelKey("mysql")).toBe("toolbar.previewSql");
    expect(dataGridPreviewLabelKey("postgres")).toBe("toolbar.previewSql");
    expect(dataGridPreviewLabelKey("sqlite")).toBe("toolbar.previewSql");
  });

  it("falls back to the SQL wording when the database type is unknown", () => {
    expect(dataGridPreviewLabelKey(undefined)).toBe("toolbar.previewSql");
  });
});
