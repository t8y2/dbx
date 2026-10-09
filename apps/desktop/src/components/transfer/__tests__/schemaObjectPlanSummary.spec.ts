import { describe, expect, it } from "vitest";
import { describeTransferSchemaObjects } from "../schemaObjectPlanSummary";

describe("schema object plan review", () => {
  it("keeps object identity, dependency availability and blocking diagnostics visible", () => {
    const lines = describeTransferSchemaObjects({ canExecute: false, items: [{ objectType: "PACKAGE_BODY", name: "Case P", sourceSchema: "SOURCE", targetSchema: "TARGET", action: "blocked", ddl: "", dependencies: [{ owner: "TARGET", name: "Case P", objectType: "PACKAGE", available: false }], warnings: ["Grants are not migrated"], errors: ["Missing specification"] }] }, (key) => key);
    expect(lines).toEqual(["PACKAGE_BODY SOURCE.Case P → TARGET.Case P: transfer.objectActionBlocked", "transfer.objectDependencies: PACKAGE TARGET.Case P — transfer.objectDependencyMissing", "Grants are not migrated", "Missing specification"]);
  });
});
