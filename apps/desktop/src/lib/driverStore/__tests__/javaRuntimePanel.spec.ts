import { describe, expect, it } from "vitest";
import { showsInstalledJreRows } from "@/lib/driverStore/javaRuntimePanel";

describe("showsInstalledJreRows (#13815)", () => {
  it("lists the managed runtimes while Dbx manages the JDK", () => {
    expect(showsInstalledJreRows("managed", 1)).toBe(true);
    expect(showsInstalledJreRows(undefined, 1)).toBe(true);
  });

  it("hides them once a custom JRE or the system Java is selected", () => {
    expect(showsInstalledJreRows("custom", 1)).toBe(false);
    expect(showsInstalledJreRows("system", 1)).toBe(false);
  });

  it("stays hidden when nothing is installed", () => {
    expect(showsInstalledJreRows("managed", 0)).toBe(false);
  });
});
