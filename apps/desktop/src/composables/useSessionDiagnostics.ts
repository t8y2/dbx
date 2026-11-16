import { onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { ConnectionConfig } from "@/types/database";
import type { ProcessRow } from "@/lib/database/processListDrivers";
import { captureOceanbaseDiagnosticTarget, collectOceanbaseSessionDiagnostics, type OceanbaseDiagnosticTarget } from "@/lib/database/oceanbaseSessionDiagnostics";
import { captureOracleDiagnosticTarget, collectOracleSessionDiagnostics, type OracleDiagnosticTarget } from "@/lib/database/oracleSessionDiagnostics";
import { createSessionDiagnosticReader, DiagnosticReadStopped, type SessionDiagnosticReader } from "@/lib/database/sessionDiagnosticReader";
import { DIAGNOSTIC_SECTIONS, diagnosticFailure, emptySessionDiagnostics, mergeSessionDiagnostics, type DiagnosticEngine, type DiagnosticSelection, type SessionDiagnosticsSnapshot } from "@/lib/database/sessionDiagnostics";

export interface SessionDiagnosticsContext {
  connection: ConnectionConfig;
  engine: DiagnosticEngine;
  row: ProcessRow;
  database: string;
  versionMajor?: number;
}

export function useSessionDiagnostics(context: Readonly<Ref<SessionDiagnosticsContext>>) {
  const snapshot = shallowRef(emptySessionDiagnostics(context.value.engine));
  const busy = ref(false);
  const error = ref("");
  const cleanupFailed = ref(false);
  const selection = shallowRef<DiagnosticSelection>({});
  let target: OracleDiagnosticTarget | OceanbaseDiagnosticTarget | undefined;
  let activeReader: SessionDiagnosticReader | undefined;
  let generation = 0;
  let disposed = false;

  function stop() {
    generation++;
    activeReader?.stop();
    activeReader = undefined;
    busy.value = false;
    const patch: Partial<SessionDiagnosticsSnapshot> = { finishedAt: new Date().toISOString(), interrupted: "cancelled" };
    for (const section of DIAGNOSTIC_SECTIONS) {
      if (snapshot.value[section].state === "loading") Object.assign(patch, { [section]: { ...snapshot.value[section], state: "cancelled" } });
    }
    snapshot.value = mergeSessionDiagnostics(snapshot.value, patch);
  }

  async function refresh(nextSelection?: DiagnosticSelection) {
    if (disposed || busy.value) return;
    const frozen = context.value;
    const contextKey = JSON.stringify(frozen);
    const attempt = ++generation;
    const current = () => !disposed && generation === attempt && JSON.stringify(context.value) === contextKey;
    if (nextSelection && JSON.stringify(nextSelection) !== JSON.stringify(selection.value)) {
      selection.value = { ...nextSelection };
      snapshot.value = emptySessionDiagnostics(frozen.engine);
    }
    busy.value = true;
    error.value = "";
    const loading: Partial<SessionDiagnosticsSnapshot> = { startedAt: new Date().toISOString(), finishedAt: undefined, interrupted: undefined };
    for (const section of DIAGNOSTIC_SECTIONS) Object.assign(loading, { [section]: { ...snapshot.value[section], state: "loading" } });
    snapshot.value = mergeSessionDiagnostics(snapshot.value, loading);
    const reader = createSessionDiagnosticReader({ connectionId: frozen.connection.id, database: frozen.database });
    activeReader = reader;
    const publish = (patch: Partial<SessionDiagnosticsSnapshot>) => {
      if (current()) snapshot.value = mergeSessionDiagnostics(snapshot.value, patch);
    };
    try {
      if (!target) {
        const captured = frozen.engine === "oracle" ? await captureOracleDiagnosticTarget({ ...frozen.row }, frozen.versionMajor, reader) : await captureOceanbaseDiagnosticTarget({ ...frozen.row }, reader);
        if (!current()) return;
        target = captured;
      }
      if (!current()) return;
      if (target.engine === "oracle") await collectOracleSessionDiagnostics(target, reader, publish);
      else await collectOceanbaseSessionDiagnostics(target, reader, publish, selection.value);
    } catch (cause) {
      if (!current()) return;
      const patch: Partial<SessionDiagnosticsSnapshot> = {};
      if (cause instanceof DiagnosticReadStopped) {
        patch.interrupted = cause.reason;
        for (const section of DIAGNOSTIC_SECTIONS) if (snapshot.value[section].state === "loading") Object.assign(patch, { [section]: { ...snapshot.value[section], state: cause.reason } });
      } else {
        error.value = cause instanceof Error ? cause.message : String(cause);
        for (const section of DIAGNOSTIC_SECTIONS) if (snapshot.value[section].state === "loading") Object.assign(patch, { [section]: diagnosticFailure(snapshot.value[section].source, cause) });
      }
      publish(patch);
    } finally {
      reader.close();
      void reader.closed.catch(() => {
        if (!disposed && JSON.stringify(context.value) === contextKey) cleanupFailed.value = true;
      });
      if (current()) {
        busy.value = false;
        activeReader = undefined;
        publish({ finishedAt: new Date().toISOString() });
      }
    }
  }

  watch(
    () => JSON.stringify(context.value),
    (_key, previousKey) => {
      stop();
      target = undefined;
      selection.value = {};
      snapshot.value = emptySessionDiagnostics(context.value.engine);
      cleanupFailed.value = false;
      error.value = "";
      if (previousKey === undefined) void refresh();
    },
    { immediate: true, flush: "sync" },
  );

  onScopeDispose(() => {
    disposed = true;
    stop();
  });
  return { snapshot, busy, error, cleanupFailed, selection, refresh, stop };
}
