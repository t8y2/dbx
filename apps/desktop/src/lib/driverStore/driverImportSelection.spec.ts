import { describe, expect, it } from "vitest";
import { isOfflineDriverPackage, webDriverImportAccept } from "./driverImportSelection";

describe("driver import selection", () => {
  it("recognizes ZIP and tar.zst packages case-insensitively", () => {
    expect(isOfflineDriverPackage("C:\\Downloads\\dbx-agent-h2-0.2.5.ZIP")).toBe(true);
    expect(isOfflineDriverPackage({ name: "dbx-agent-kingbase-0.1.34-macos-aarch64.zip" })).toBe(true);
    expect(isOfflineDriverPackage({ name: "dbx-agent-duckdb-0.1.0-macos-aarch64.TAR.ZST" })).toBe(true);
    expect(isOfflineDriverPackage({ name: "dbx-agent-h2-0.2.5.jar" })).toBe(false);
  });

  it("allows ZIP alongside the platform raw artifact", () => {
    expect(webDriverImportAccept(true, false)).toBe(".zip,.tar.zst,.jar");
    expect(webDriverImportAccept(false, true)).toBe(".zip,.tar.zst,.exe");
    expect(webDriverImportAccept(false, false)).toBe("");
  });
});
