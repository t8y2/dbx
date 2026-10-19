import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));

describe("workspace window context", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it.each([
    ["", { kind: "main", windowLabel: "main" }],
    ["?dbxWorkspace=abc-123", { kind: "workspace", windowLabel: "dbx-tab-abc-123" }],
    ["?dbxDetachedTab=tab-1", { kind: "detached-tab", windowLabel: "detached-tab-tab-1", tabId: "tab-1" }],
    ["?dbxWorkspace=invalid%2Fid", { kind: "main", windowLabel: "main" }],
  ])("resolves %s without assigning main ownership", async (search, expected) => {
    vi.stubGlobal("window", { location: { search } });
    const { resolveWindowContext, isWorkspaceWindow } = await import("../windowContext");
    expect(resolveWindowContext()).toEqual(expected);
    expect(isWorkspaceWindow()).toBe(expected.kind === "workspace");
  });
});
