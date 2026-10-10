import { onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { AuditWindow } from "@/lib/database/oceanbaseRuntimeDiagnostics";
import { createRuntimeDiagnostics, diagnosticErrorStatus, type DiagnosticContext, type DiagnosticStatus, type DiagnosticTarget, type RuntimeDiagnosticRecord } from "@/lib/database/runtimeDiagnostics";

async function waitForHistory<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Diagnostic cancelled");
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => rejectCancelled(new Error("Diagnostic cancelled"));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // History transport may still finish; cancellation only ends local waiting.
    return await Promise.race([action(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function useRuntimeDiagnostics(context: Readonly<Ref<DiagnosticContext | null>>, service = createRuntimeDiagnostics()) {
  const targets = shallowRef<DiagnosticTarget[]>([]);
  const records = shallowRef<RuntimeDiagnosticRecord[]>([]);
  const pending = ref(false);
  const error = ref<DiagnosticStatus | "save_failed" | null>(null);
  const unsavedRecord = shallowRef<RuntimeDiagnosticRecord | null>(null);
  let generation = 0;
  let controller: AbortController | null = null;
  const nextCursor = shallowRef<Awaited<ReturnType<typeof service.load>>["cursor"]>();
  function cancel() {
    controller?.abort();
  }
  watch(
    context,
    () => {
      generation++;
      cancel();
      pending.value = false;
      targets.value = [];
      records.value = [];
      nextCursor.value = undefined;
      unsavedRecord.value = null;
      error.value = null;
    },
    { flush: "sync" },
  );
  onScopeDispose(() => {
    generation++;
    cancel();
  });
  async function run(action: (snapshot: DiagnosticContext, signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (!context.value || pending.value) return;
    const snapshot = { ...context.value };
    const started = generation;
    const operation = new AbortController();
    controller = operation;
    pending.value = true;
    error.value = null;
    try {
      await action(snapshot, operation.signal, () => generation === started);
    } catch (cause) {
      if (generation === started) error.value = diagnosticErrorStatus(cause);
    } finally {
      if (generation === started) {
        pending.value = false;
        controller = null;
      }
    }
  }
  async function find(sqlId: string, window?: AuditWindow) {
    await run(async (snapshot, signal, current) => {
      const found = await service.findTargets(snapshot, sqlId.trim(), signal, window);
      if (current()) {
        targets.value = found;
        if (!found.length) error.value = "target_not_found";
      }
    });
  }
  async function collect(target: DiagnosticTarget) {
    await run(async (snapshot, signal, current) => {
      const record = await service.collect(snapshot, target, signal);
      if (!current()) return;
      unsavedRecord.value = record;
      try {
        await waitForHistory(() => service.save(record), signal);
        if (current()) {
          records.value = [record, ...records.value];
          unsavedRecord.value = null;
        }
      } catch (cause) {
        if (signal.aborted) throw cause;
        if (current()) error.value = "save_failed";
      }
    });
  }
  async function load(more = false) {
    await run(async (snapshot, signal, current) => {
      const page = await waitForHistory(() => service.load(snapshot, more ? nextCursor.value : undefined), signal);
      if (current()) {
        records.value = more ? [...records.value, ...page.records] : page.records;
        nextCursor.value = page.cursor;
      }
    });
  }
  return { targets, records, pending, error, unsavedRecord, nextCursor, find, collect, load, cancel };
}
