import { effectScope, nextTick, shallowRef } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useRuntimeDiagnostics } from "../useRuntimeDiagnostics";
import type { DiagnosticContext, OracleDiagnosticTarget } from "@/lib/database/runtimeDiagnostics";
vi.mock("@/lib/backend/api", () => ({}));

describe("diagnostic view lifetime", () => {
  it("discards old cursor responses after switching connection and aborts the old request", async () => {
    const context = shallowRef<DiagnosticContext | null>({ connectionId: "one", connectionName: "one", database: "pdb", engine: "oracle" });
    let resolve!: (value: OracleDiagnosticTarget[]) => void;
    const service = {
      findTargets: vi.fn().mockImplementation(
        () =>
          new Promise<OracleDiagnosticTarget[]>((done) => {
            resolve = done;
          }),
      ),
      collect: vi.fn(),
      save: vi.fn(),
      load: vi.fn(),
    };
    const scope = effectScope();
    const state = scope.run(() => useRuntimeDiagnostics(context, service))!;
    const pending = state.find("0123456789abc");
    const signal = service.findTargets.mock.calls[0][2] as AbortSignal;
    context.value = { ...context.value!, connectionId: "two" };
    await nextTick();
    resolve([{} as OracleDiagnosticTarget]);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(state.targets.value).toEqual([]);
    expect(state.pending.value).toBe(false);
    expect(service.save).not.toHaveBeenCalled();
    scope.stop();
  });
});
