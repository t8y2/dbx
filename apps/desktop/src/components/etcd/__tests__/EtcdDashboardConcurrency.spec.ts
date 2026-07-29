import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(new URL("../EtcdDashboard.vue", import.meta.url), "utf8");

describe("EtcdDashboard refresh concurrency", () => {
  it("skips overlapping refreshes for the same connection", () => {
    expect(dashboardSource).toContain("if (loading.value && loadingConnectionId === connectionId) return");
  });

  it("discards responses from an obsolete load generation", () => {
    expect(dashboardSource).toContain("const generation = ++loadGeneration");
    expect(dashboardSource).toContain("if (generation !== loadGeneration || props.connectionId !== connectionId) return");
  });
});
