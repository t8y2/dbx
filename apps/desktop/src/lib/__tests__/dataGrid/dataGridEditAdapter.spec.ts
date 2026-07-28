import { describe, expect, it } from "vitest";
import { dataGridEditAdapterKind } from "@/lib/dataGrid/dataGridEditAdapter";

describe("dataGridEditAdapter", () => {
  it("prioritizes custom save handlers", () => {
    expect(dataGridEditAdapterKind({ databaseType: "mongodb", custom: true, editable: true })).toBe("custom");
  });

  it("distinguishes document and relational editing", () => {
    expect(dataGridEditAdapterKind({ databaseType: "mongodb", custom: false, editable: true })).toBe("document");
    expect(dataGridEditAdapterKind({ databaseType: "postgresql", custom: false, editable: true })).toBe("relational");
  });

  it("keeps read-only and unknown contexts unsupported", () => {
    expect(dataGridEditAdapterKind({ databaseType: "postgresql", custom: false, editable: false })).toBe("unsupported");
    expect(dataGridEditAdapterKind({ custom: false, editable: true })).toBe("unsupported");
  });
});
