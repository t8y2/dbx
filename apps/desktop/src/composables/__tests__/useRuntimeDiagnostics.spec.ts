import { effectScope, nextTick, shallowRef } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useRuntimeDiagnostics } from "../useRuntimeDiagnostics";
import type { DiagnosticContext, OracleDiagnosticTarget, RuntimeDiagnosticRecord } from "@/lib/database/runtimeDiagnostics";
vi.mock("@/lib/backend/api", () => ({}));

describe("diagnostic view lifetime", () => {
  it("ends cancelled history loading without applying a late page to a new operation", async () => {
    const context = shallowRef<DiagnosticContext | null>({ connectionId: "one", connectionName: "one", database: "pdb", engine: "oracle" });
    let resolve!: (value: { records: RuntimeDiagnosticRecord[]; cursor: undefined }) => void;
    const service = {
      findTargets: vi.fn(),
      collect: vi.fn(),
      save: vi.fn(),
      load: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        )
        .mockResolvedValue({ records: [], cursor: undefined }),
    };
    const scope = effectScope();
    const state = scope.run(() => useRuntimeDiagnostics(context, service))!;
    const loading = state.load();
    state.cancel();
    await new Promise((done) => setTimeout(done, 0));
    expect(state.pending.value).toBe(false);
    expect(state.error.value).toBe("cancelled");
    await loading;
    await state.load();
    resolve({ records: [{ id: "late" } as RuntimeDiagnosticRecord], cursor: undefined });
    await nextTick();
    expect(state.records.value).toEqual([]);
    scope.stop();
  });

  it("ends cancelled saving and retains the unsaved record when a late save completes", async () => {
    const context = shallowRef<DiagnosticContext | null>({ connectionId: "one", connectionName: "one", database: "pdb", engine: "oracle" });
    const record = { id: "unsaved" } as RuntimeDiagnosticRecord;
    let resolve!: () => void;
    const service = {
      findTargets: vi.fn(),
      collect: vi.fn().mockResolvedValue(record),
      load: vi.fn(),
      save: vi.fn().mockImplementation(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    };
    const scope = effectScope();
    const state = scope.run(() => useRuntimeDiagnostics(context, service))!;
    const collecting = state.collect({} as OracleDiagnosticTarget);
    await nextTick();
    expect(service.save).toHaveBeenCalled();
    state.cancel();
    await new Promise((done) => setTimeout(done, 0));
    expect(state.pending.value).toBe(false);
    expect(state.error.value).toBe("cancelled");
    await collecting;
    resolve();
    await nextTick();
    expect(state.records.value).toEqual([]);
    expect(state.unsavedRecord.value).toEqual(record);
    scope.stop();
  });

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
