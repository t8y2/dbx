import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  plDebugAbort,
  plDebugClose,
  plDebugDeleteBreakpoints,
  plDebugGetLog,
  plDebugGetStack,
  plDebugGetVariables,
  plDebugListBreakpoints,
  plDebugProbe,
  plDebugResume,
  plDebugSetBreakpoints,
  plDebugStart,
  plDebugStepIn,
  plDebugStepOut,
  plDebugStepOver,
  type PlDebugBreakpoint,
  type PlDebugParam,
  type PlDebugProbeResult,
  type PlDebugStartRequest,
  type PlDebugStatus,
} from "@/lib/backend/pl-debug-tauri";

/**
 * State of one live PL/SQL debugging session (OceanBase Oracle).
 *
 * The store is a thin coordinator over the Tauri APIs: it keeps the session
 * handle, mirrors the agent status snapshot and caches the debugger panels
 * (breakpoints / variables / backtrace / DBMS output). Continuation calls
 * (resume / step / abort) block server-side until the debuggee stops again —
 * `busy` drives the toolbar's pending state while they are in flight.
 */
export const usePlDebugStore = defineStore("plDebug", () => {
  const debugId = ref<string | null>(null);
  const connectionId = ref<string | null>(null);
  const database = ref<string | null>(null);
  const probe = ref<PlDebugProbeResult | null>(null);
  const probing = ref(false);

  const busy = ref(false);
  const terminated = ref(false);
  const status = ref<PlDebugStatus | null>(null);
  const breakpoints = ref<PlDebugBreakpoint[]>([]);
  const variables = ref<Array<{ name: string; value: string }>>([]);
  const backtrace = ref("");
  const output = ref("");
  const error = ref<string | null>(null);

  const supported = computed(() => probe.value?.supported === true);
  /** The line the debuggee is currently parked on, for the editor highlight. */
  const currentLine = computed(() => {
    const raw = status.value?.line;
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  });
  const currentProgram = computed(() => status.value?.program ?? null);
  const hasSession = computed(() => debugId.value !== null && !terminated.value);

  async function runProbe(targetConnectionId: string): Promise<PlDebugProbeResult> {
    probing.value = true;
    try {
      const result = await plDebugProbe(targetConnectionId);
      probe.value = result;
      return result;
    } catch (error) {
      probe.value = { supported: false, reason: String(error) };
      return probe.value;
    } finally {
      probing.value = false;
    }
  }

  async function start(targetConnectionId: string, targetDatabase: string, request: PlDebugStartRequest) {
    busy.value = true;
    error.value = null;
    try {
      const result = await plDebugStart(targetConnectionId, targetDatabase, request);
      debugId.value = result.debugId ?? null;
      connectionId.value = targetConnectionId;
      database.value = targetDatabase;
      terminated.value = result.terminated === true;
      status.value = result;
      breakpoints.value = [];
      variables.value = [];
      backtrace.value = "";
      output.value = "";
      return result;
    } catch (caught) {
      error.value = String(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  /** Sets the full breakpoint set: server-side diffs against the stored list. */
  async function applyBreakpoints(next: PlDebugBreakpoint[]) {
    if (!debugId.value) throw new Error("no debug session");
    busy.value = true;
    try {
      const toAdd = next.filter((candidate) => !breakpoints.value.some((stored) => sameBreakpoint(stored, candidate)));
      const toRemove = breakpoints.value.filter((stored) => !next.some((candidate) => sameBreakpoint(stored, candidate)));
      if (toAdd.length > 0) {
        const result = await plDebugSetBreakpoints(debugId.value, toAdd);
        for (const created of result.breakpoints ?? []) {
          if (!breakpoints.value.some((stored) => sameBreakpoint(stored, created))) {
            breakpoints.value.push(created);
          }
        }
      }
      if (toRemove.length > 0) {
        await plDebugDeleteBreakpoints(debugId.value, toRemove);
        breakpoints.value = breakpoints.value.filter((stored) => !toRemove.some((candidate) => sameBreakpoint(stored, candidate)));
      }
    } catch (caught) {
      error.value = String(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function refreshBreakpoints() {
    if (!debugId.value) return;
    breakpoints.value = await plDebugListBreakpoints(debugId.value);
  }

  /** Shared body of the blocking continuation calls. */
  async function continueWith(action: (debugId: string) => Promise<PlDebugStatus>) {
    if (!debugId.value) throw new Error("no debug session");
    busy.value = true;
    error.value = null;
    try {
      const result = await action(debugId.value);
      status.value = result;
      terminated.value = result.terminated === true;
      return result;
    } catch (caught) {
      error.value = String(caught);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  const resume = () => continueWith(plDebugResume);
  const stepOver = () => continueWith(plDebugStepOver);
  const stepIn = () => continueWith(plDebugStepIn);
  const stepOut = () => continueWith(plDebugStepOut);
  const abort = () => continueWith(plDebugAbort);

  async function refreshVariables() {
    if (!debugId.value) return;
    const result = await plDebugGetVariables(debugId.value);
    status.value = result;
    // The backend normalizes both GET_VALUES shapes (OceanBase JSON, Oracle
    // `*name*type*value` text) into a flat variables array.
    variables.value = (result.variables ?? []).map((entry) => ({
      name: entry.name,
      value: entry.value ?? "",
    }));
  }

  async function refreshStack() {
    if (!debugId.value) return;
    const result = await plDebugGetStack(debugId.value);
    backtrace.value = result.backtrace ?? "";
  }

  async function refreshLog() {
    if (!debugId.value) return;
    const result = await plDebugGetLog(debugId.value);
    output.value = result.output ?? "";
  }

  async function close() {
    if (!debugId.value) return;
    const closingId = debugId.value;
    try {
      await plDebugClose(closingId);
    } catch (ignored) {
      // Close is best effort: the agent also reaps expired sessions.
    } finally {
      reset();
    }
  }

  function reset() {
    debugId.value = null;
    connectionId.value = null;
    database.value = null;
    terminated.value = false;
    status.value = null;
    breakpoints.value = [];
    variables.value = [];
    backtrace.value = "";
    output.value = "";
    error.value = null;
  }

  return {
    debugId,
    connectionId,
    database,
    probe,
    probing,
    busy,
    terminated,
    status,
    breakpoints,
    variables,
    backtrace,
    output,
    error,
    supported,
    currentLine,
    currentProgram,
    hasSession,
    runProbe,
    start,
    applyBreakpoints,
    refreshBreakpoints,
    resume,
    stepOver,
    stepIn,
    stepOut,
    abort,
    refreshVariables,
    refreshStack,
    refreshLog,
    close,
    reset,
  };
});

function sameBreakpoint(left: PlDebugBreakpoint, right: PlDebugBreakpoint): boolean {
  const leftNumber = left.breakpointNumber;
  const rightNumber = right.breakpointNumber;
  if (leftNumber != null && rightNumber != null) {
    return leftNumber === rightNumber;
  }
  return (left.name ?? "").toUpperCase() === (right.name ?? "").toUpperCase() && left.line === right.line;
}

export type { PlDebugBreakpoint, PlDebugParam, PlDebugStartRequest };
