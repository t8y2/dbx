import { describe, expect, it } from "vitest";
import { isOfflineDriverPackage, webDriverImportAccept } from "./driverImportSelection";

describe("driver import selection", () => {
  it("recognizes ZIP paths and uploaded files case-insensitively", () => {
    expect(isOfflineDriverPackage("C:\\Downloads\\dbx-agent-h2-0.2.5.ZIP")).toBe(true);
    expect(isOfflineDriverPackage({ name: "dbx-agent-kingbase-0.1.34-macos-aarch64.zip" })).toBe(true);
    expect(isOfflineDriverPackage({ name: "dbx-agent-h2-0.2.5.jar" })).toBe(false);
  });

  it("allows ZIP alongside the platform raw artifact", () => {
    expect(webDriverImportAccept(true, false)).toBe(".zip,.jar");
    expect(webDriverImportAccept(false, true)).toBe(".zip,.exe");
    expect(webDriverImportAccept(false, false)).toBe("");
  });
});
