import { describe, expect, it } from "vitest";
import { shouldStartSidebarLayoutAutoSync } from "@/lib/sidebar/sidebarLayoutAutoSync";

describe("shouldStartSidebarLayoutAutoSync", () => {
  it("enables polling on desktop outside tests", () => {
    expect(shouldStartSidebarLayoutAutoSync(true, "production")).toBe(true);
    expect(shouldStartSidebarLayoutAutoSync(true, "development")).toBe(true);
  });

  it("disables polling on web so shared Docker layouts do not cross-overwrite", () => {
    expect(shouldStartSidebarLayoutAutoSync(false, "production")).toBe(false);
    expect(shouldStartSidebarLayoutAutoSync(false, "development")).toBe(false);
  });

  it("disables polling in unit tests even on desktop", () => {
    expect(shouldStartSidebarLayoutAutoSync(true, "test")).toBe(false);
    expect(shouldStartSidebarLayoutAutoSync(false, "test")).toBe(false);
  });
});
