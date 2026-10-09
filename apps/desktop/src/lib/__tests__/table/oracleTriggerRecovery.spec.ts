import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOracleTriggerRecovery, preserveOracleTriggerRecovery } from "@/lib/table/oracleTriggerRecovery";
import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/backend/browserAppStateStorage", () => ({
  loadBrowserAppState: vi.fn(async (key: string) => state.get(key) ?? null),
  saveBrowserAppState: vi.fn(async (key: string, value: unknown) => { state.set(key, structuredClone(value)); }),
}));
const scope = { connectionId: "ob", database: "APP", schema: "Mixed Owner", name: "Mixed Trigger" };
beforeEach(() => { state.clear(); vi.clearAllMocks(); });

describe("trigger recovery versions", () => {
  it("persists the verified table identity without substituting the trigger owner or rewriting source", async () => {
    const original = "CREATE TRIGGER T BEFORE INSERT ON DATA BEGIN NULL; END;";
    await preserveOracleTriggerRecovery({ ...scope, tableSchema: "Different Table Owner", tableName: "Data Table" }, original, false);
    expect((await loadOracleTriggerRecovery(scope))[0]).toMatchObject({ source: original, tableSchema: "Different Table Owner", tableName: "Data Table", enabled: false });
  });

  it("loads old records without inventing a target identity", async () => {
    await preserveOracleTriggerRecovery(scope, "old definition", true);
    const [entry] = await loadOracleTriggerRecovery(scope);
    expect(entry.tableSchema).toBeUndefined();
    expect(entry.tableName).toBeUndefined();
  });

  it("retains both concurrent attempts and their full definitions", async () => {
    const longSource = "BEGIN\n" + "-- original body\n".repeat(10000) + "END;";
    await Promise.all([preserveOracleTriggerRecovery(scope, longSource, false), preserveOracleTriggerRecovery(scope, "second definition", true)]);
    const entries = await loadOracleTriggerRecovery(scope);
    expect(entries.map((entry) => [entry.source, entry.enabled])).toEqual([[longSource, false], ["second definition", true]]);
    expect(entries[0].id).not.toBe(entries[1].id);
    expect(await loadOracleTriggerRecovery({ ...scope, schema: "MIXED OWNER" })).toEqual([]);
    expect(await loadOracleTriggerRecovery({ ...scope, connectionId: "other" })).toEqual([]);
  });

  it("propagates persistence failure and preserves earlier recovery versions", async () => {
    await preserveOracleTriggerRecovery(scope, "first", true);
    vi.mocked(saveBrowserAppState).mockRejectedValueOnce(new Error("quota"));
    await expect(preserveOracleTriggerRecovery(scope, "second", false)).rejects.toThrow("quota");
    expect((await loadOracleTriggerRecovery(scope)).map((entry) => entry.source)).toEqual(["first"]);
  });

  it("does not overwrite malformed stored recovery material", async () => {
    vi.mocked(loadBrowserAppState).mockResolvedValueOnce({ legacy: "retain this" });
    await expect(preserveOracleTriggerRecovery(scope, "new", true)).rejects.toThrow("existing recovery data was preserved");
    expect(saveBrowserAppState).not.toHaveBeenCalled();
  });
});
