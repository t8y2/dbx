import { describe, expect, it } from "vitest";
import { consulMeshWorkspaceVisible } from "@/lib/consul/meshVisibility";

describe("consulMeshWorkspaceVisible", () => {
  it("keeps the advanced workspace hidden unless explicitly enabled", () => {
    expect(consulMeshWorkspaceVisible({})).toBe(false);
    expect(consulMeshWorkspaceVisible(undefined)).toBe(false);
    expect(consulMeshWorkspaceVisible({ consulMeshVisible: false })).toBe(false);
  });

  it("shows the workspace when the connection explicitly enables it", () => {
    expect(consulMeshWorkspaceVisible({ consulMeshVisible: true })).toBe(true);
  });
});
