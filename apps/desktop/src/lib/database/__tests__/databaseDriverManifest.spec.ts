import { describe, expect, it } from "vitest";
import { databaseRuntimeMode, usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("marks S3 as a native object-storage runtime", () => {
    expect(databaseRuntimeMode("s3")).toBe("native");
    expect(usesAgentCursorForQuery("s3")).toBe(false);
  });
});
