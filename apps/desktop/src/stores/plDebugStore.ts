import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";
import * as backend from "@/lib/backend/api";
import { formatError, normalizeBackendError } from "@/lib/backend/errorUtils";
import type { PlDebugAction, PlDebugBootstrap, PlDebugCompileIntent, PlDebugCompileReceipt, PlDebugCompileRef, PlDebugInspectRequest, PlDebugReadRequest, PlDebugReceipt, PlDebugSessionRef, PlDebugSnapshot, PlDebugStartIntent, PlDebugValueContext, PlDebugVariable } from "@/lib/debug/plDebugProtocol";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useConnectionStore } from "@/stores/connectionStore";
import { uuid } from "@/lib/common/utils";
import {
  plDebugDeleteBreakpoints,
  plDebugSetBreakpointEnabled,
  plDebugSetBreakpoints,
  type PlDebugBreakpoint,
  type PlDebugExecuteResult,
  type PlDebugFrame,
  type PlDebugParam,
  type PlDebugProbeResult,
  type PlDebugStartRequest,
  type PlDebugStatus,
  type PlDebugSourceRef,
} from "@/lib/backend/pl-debug-tauri";

/**
 * The routine (or anonymous block) a session debugs.
 *
 * The editor gutter builds its breakpoints from this: `schema` is the owner,
 * `objectName` alone for a standalone routine and `packageName.objectName` for
 * a package member — which is exactly the program name DBMS_DEBUG reports.
 */
export interface PlDebugSessionTarget {
  schema: string | null;
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  objectType: string;
  objectName: string | null;
  packageName: string | null;
  /** Source of an anonymous block, which has no database-side definition to load. */
  source: string | null;
}

/** One entry of the session history that the debug console panel renders. */
export interface PlDebugHistoryEntry {
  level: "INFO" | "WARN" | "ERROR";
  /** Local time, `YYYY-MM-DD HH:mm:ss`. */
  time: string;
  message: string;
}

/**
 * Frontend-only properties of one breakpoint line.
 *
 * DBMS_DEBUG knows only program and line, so enablement, the ignore count, the
 * stop condition and the breakpoint's own message live in the store, keyed by
 * line, and are merged back onto the server's breakpoint list on every refresh.
 * They must never be sent to the agent as breakpoint fields.
 */
export interface PlDebugBreakpointLocals {
  /** false while the breakpoint was temporarily removed server-side. */
  enabled: boolean;
  /** Resume automatically until the line was hit at least this many times. */
  ignoreCount: number;
  /** Minimal `name operator literal` stop condition, evaluated in the frontend. */
  condition: string;
  /** Hits counted so far, driving the ignore-count rule. */
  hits: number;
  /**
   * Note the user attached to the line (PL/SQL Developer's breakpoint message).
   * Recorded in the debug console whenever a resume stops on this line, so a
   * breakpoint can say why it is there without a comment in the source.
   */
  message: string;
}

/** A server breakpoint carrying the optional frontend-only properties. */
export interface PlDebugLocalBreakpoint extends PlDebugBreakpoint {
  enabled?: boolean;
  ignoreCount?: number;
  condition?: string;
  hits?: number;
  message?: string;
}

/** One row of the watch window: a name resolved against the current frame. */
export interface PlDebugWatchRow {
  /** The name as the user spelled it (variable rows keep DBMS_DEBUG's spelling). */
  name: string;
  /** Native scalar text; null for SQL NULL and non-value states. */
  value: string | null;
  /** Declared type when reported by the server. */
  type: string | null;
  /** Whether the native single-value read confirmed an in-scope value. */
  inScope: boolean;
  state: PlDebugVariable["state"];
  message: string | null;
}

/**
 * A read-only view of another object's source, opened from one stack frame.
 *
 * The source is loaded by the caller (the stack panel), so the store never holds a
 * fetch of its own and the view can carry the backend's own error text when the
 * object could not be loaded -- an empty view would be exactly as bad as a blank
 * panel. `source` and `error` are mutually exclusive.
 */
export interface PlDebugFrameSourceView {
  /** Frame number in the stack listing (0 = innermost), for the banner. */
  frameIndex: number;
  /** The program identifier the frame reported, so the banner names the frame the user clicked. */
  program: string;
  /** 1-based line to highlight inside the object's source, when the frame reported one. */
  line: number | null;
  /** Owner the source was read from. */
  owner: string;
  /** Object name the source belongs to (the package name for a package member). */
  name: string;
  /** Source text; empty when `error` is set. */
  source: string;
  /** Backend error text shown in place of the source; null on success. */
  error: string | null;
}

/** One line of a collected trace run: the source line and how often it ran. */
export interface PlDebugTraceLine {
  line: number;
  hits: number;
}

/** Result of one trace run (the debugger's own answer to "which lines ran"). */
export interface PlDebugTraceResult {
  /** Distinct lines, ordered by line number. */
  lines: PlDebugTraceLine[];
  /** Continuation calls the run made. */
  steps: number;
  /** Wall-clock milliseconds the run took. */
  durationMs: number;
  /** True when the step cap ended the run before the program finished. */
  truncated: boolean;
}

/**
 * State of one live PL/SQL debugging session (Oracle; the OceanBase Oracle
 * agent lives on the feature/ob-oracle-pl-debug branch).
 *
 * The store is a thin coordinator over the Tauri APIs: it keeps the session
 * handle, mirrors the agent status snapshot and caches the debugger panels
 * (breakpoints / variables / backtrace / DBMS output). Continuation calls
 * (resume / step / abort) block server-side until the debuggee stops again —
 * `busy` drives the toolbar's pending state while they are in flight.
 */
export const usePlDebugStore = defineStore("plDebug", () => {
  const recovery = readDebugRecovery();
  const clientSessionId = ref(recovery?.clientSessionId ?? uuid());
  const sessionRef = ref<PlDebugSessionRef | null>(recovery?.reference ?? null);
  const pendingStart = ref<PlDebugPendingStart | null>(recovery?.pendingStart ?? null);
  const pendingClose = ref<{ operationId: string; reference: PlDebugSessionRef } | null>(recovery?.pendingClose ?? null);
  const pendingOperations = ref<Record<string, PlDebugPendingOperation>>(recovery?.pendingOperations ?? {});
  const compilationRef = ref<PlDebugCompileRef | null>(recovery?.compilationRef ?? null);
  const compilationReceipt = ref<PlDebugCompileReceipt | null>(null);
  const compilationBusy = ref(false);
  const compilationUnresolved = computed(() => !!compilationRef.value && (!compilationReceipt.value?.finished || compilationReceipt.value.releaseState !== "released" || compilationReceipt.value.ddlState === "unknown"));
  const lastReceipt = ref<PlDebugReceipt | null>(null);
  const publicSnapshot = ref<PlDebugSnapshot | null>(null);
  const startOperationId = ref<string | null>(recovery?.startOperationId ?? null);
  const recoveryRequired = ref(Boolean(recovery?.reference || recovery?.pendingStart || recovery?.pendingClose));
  const recoveryProjectionRequired = ref(recovery?.recoveryProjectionRequired ?? false);
  let discoverySerial = 0;
  let discoveredSessions = new Map<string, PlDebugSnapshot>();
  let bootstrap: PlDebugBootstrap | null = null;
  let bootstrapPending: Promise<PlDebugBootstrap> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let restoring: Promise<PlDebugSnapshot | null> | null = null;
  let recoverySerial = 0;
  const closeBusy = ref(false);
  let closingTask: Promise<void> | null = null;
  let disposed = false;
  let probeRequest = 0;
  let readSerial = 0;
  let stackReadSerial = 0;
  const debugId = ref<string | null>(null);
  const connectionId = ref<string | null>(null);
  const database = ref<string | null>(null);
  const target = ref<PlDebugSessionTarget | null>(null);
  const probe = ref<PlDebugProbeResult | null>(null);
  let preparedProbe: { connectionId: string; database: string; result: PlDebugProbeResult } | null = null;
  let ruleEventContext = "";
  let ruleEventSequence = 0;
  const probing = ref(false);

  const localBusy = ref(false);
  const busy = computed({
    get: () =>
      localBusy.value ||
      pendingStart.value !== null ||
      publicSnapshot.value?.state === "starting" ||
      publicSnapshot.value?.state === "running" ||
      publicSnapshot.value?.activeOperationId != null ||
      (!publicSnapshot.value?.runtimeExited && Object.values(pendingOperations.value).some((operation) => operation.reference.sessionId === sessionRef.value?.sessionId && pendingInGeneration(operation, publicSnapshot.value?.generation))),
    set: (value: boolean) => {
      localBusy.value = value;
    },
  });
  const canRestart = computed(() => {
    const current = publicSnapshot.value;
    return (
      !!sessionRef.value &&
      !busy.value &&
      !recoveryRequired.value &&
      !pendingClose.value &&
      !Object.values(pendingOperations.value).some((operation) => sameDebugReference(operation.reference, sessionRef.value!)) &&
      current?.executionStopped === true &&
      current.releaseState === "released" &&
      current.runtimeExited &&
      current.executionOutcome !== "unknown"
    );
  });
  const terminated = ref(false);
  const status = ref<PlDebugStatus | null>(null);
  /**
   * Monotonic stop counter: bumped once every time the debuggee lands somewhere new
   * (entry, breakpoint, step, exception) and read by the panels.
   *
   * Panels must not watch the `status` object itself: reading a panel (refreshVariables
   * / refreshStack) rewrites `status` with a fresh locator snapshot, so a watcher on the
   * object re-armed itself from inside its own response and turned every stop into an
   * endless refresh loop — measured in the running app on 2026-10-13 as 177
   * variable+stack round trips in a few seconds after a single step. Only the stop
   * paths bump this counter, so a panel can be edge-triggered on it.
   */
  const stopSeq = ref(0);
  const breakpoints = ref<PlDebugLocalBreakpoint[]>([]);
  /**
   * Local (frontend-only) breakpoint properties, keyed by line. The server
   * never stores them: disabling a breakpoint keeps its entry here for a later
   * re-enable — either on a breakpoint the server disabled in place, or on one
   * the fallback removed server-side.
   */
  const breakpointLocals = ref<Record<number, PlDebugBreakpointLocals>>({});
  const variables = ref<PlDebugVariable[]>([]);
  const variablesState = ref<"unread" | "loading" | "ready" | "error">("unread");
  const variableError = ref<string | null>(null);
  const watchValues = ref<Record<string, PlDebugVariable>>({});
  const backtrace = ref("");
  const stackError = ref<string | null>(null);
  const output = ref("");
  const outputStatus = ref<{ complete: boolean | null; truncated: boolean | null; error: unknown } | null>(null);
  const error = ref<string | null>(null);
  /** Stack frame the variables panel inspects; 0 is the innermost (stopped) frame. */
  const currentFrame = ref(0);
  const exceptionBreakpoint = ref(false);
  const exceptionBreakpointUnavailableReason = computed(() => {
    const capability = status.value?.capabilities?.exceptions;
    return capability?.canAttempt === false ? capability.message || capability.evidence || "Exception breakpoint support could not be confirmed" : "";
  });
  /**
   * Watch names, in the order the user added them.
   *
   * Deliberately session-independent like `history`: a name typed into the watch
   * box (or taken from a variable row) should not disappear when the session is
   * closed and the routine is debugged again. Values are never stored — each row
   * resolves its name against the current frame's variables on every render, so a
   * single step or resume keeps the list and refreshes the values in place.
   */
  const watchNames = ref<string[]>([]);
  /**
   * The other object's source currently on screen, or null while the editor shows
   * the debug target. Session state, not history: a new session starts on the
   * target (`reset` clears it), and it never outlives the stack it came from.
   */
  const frameSourceView = ref<PlDebugFrameSourceView | null>(null);
  const traceResult = ref<PlDebugTraceResult | null>(null);
  let traceReference: (PlDebugSessionRef & { generation: number }) | null = null;
  const traceRunning = ref(false);
  /** Set by stopTrace; the run checks it between steps, so it can never wedge the UI. */
  let traceStopRequested = false;
  /** Session history (start / continue / step / breakpoints / failures), oldest first. */
  const history = ref<PlDebugHistoryEntry[]>([]);

  function persistRecovery() {
    writeDebugRecovery({
      clientSessionId: clientSessionId.value,
      reference: sessionRef.value,
      pendingStart: pendingStart.value,
      pendingClose: pendingClose.value,
      pendingOperations: pendingOperations.value,
      startOperationId: startOperationId.value,
      recoveryProjectionRequired: recoveryProjectionRequired.value,
      compilationRef: compilationRef.value,
    });
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function getBootstrap(force = false): Promise<PlDebugBootstrap> {
    if (!force && bootstrap) return bootstrap;
    if (bootstrapPending) return bootstrapPending;
    bootstrapPending = backend
      .plDebugBootstrap()
      .then((result) => (bootstrap = result))
      .finally(() => {
        bootstrapPending = null;
      });
    return bootstrapPending;
  }

  function publishSnapshot(next: PlDebugSnapshot): boolean {
    const reference = sessionRef.value;
    if (!reference || next.serverEpoch !== reference.serverEpoch || next.sessionId !== reference.sessionId || next.connectionId !== reference.connectionId || next.clientSessionId !== reference.clientSessionId) return false;
    const previous = publicSnapshot.value;
    if (previous && (next.generation < previous.generation || (next.generation === previous.generation && next.revision < previous.revision))) return false;
    const newStop = next.state === "paused" && (previous?.state !== "paused" || previous.generation !== next.generation || previous.stopRevision !== next.stopRevision);
    const sameStop = previous?.state === "paused" && next.state === "paused" && Number.isSafeInteger(next.stopRevision) && next.stopRevision! > 0 && previous.stopRevision === next.stopRevision && previous.generation === next.generation && sameDebugReference(previous, next);
    const retainedFrames = sameStop && next.frames === undefined ? status.value?.frames : undefined;
    const retainedFrameMapping = retainedFrames !== undefined ? status.value?.frameMappingState : undefined;
    const nextFrames = Array.isArray(next.frames) ? (next.frames as PlDebugFrame[]) : undefined;
    if (next.frames !== undefined) invalidateFrameSource(status.value?.frames, nextFrames);
    if (previous?.sessionId !== next.sessionId || previous.generation !== next.generation) probe.value = preparedProbe?.connectionId === next.connectionId && preparedProbe.database === next.database ? preparedProbe.result : null;
    if (traceReference && (!sameDebugReference(traceReference, next) || traceReference.generation !== next.generation)) clearTrace();
    publicSnapshot.value = next;
    debugId.value = next.sessionId;
    connectionId.value = next.connectionId;
    database.value = next.database;
    target.value = {
      schema: typeof next.target.schema === "string" ? next.target.schema : null,
      objectType: String(next.target.objectType ?? "ANONYMOUS"),
      objectName: typeof next.target.objectName === "string" ? next.target.objectName : null,
      packageName: typeof next.target.packageName === "string" ? next.target.packageName : null,
      source: typeof next.target.source === "string" ? next.target.source : null,
    };
    status.value = { ...next, frames: nextFrames, debugId: next.sessionId, terminated: next.executionStopped === true, line: next.line == null ? null : String(next.line), program: typeof next.program === "string" ? next.program : null };
    if (retainedFrames !== undefined) status.value.frames = retainedFrames;
    if (retainedFrameMapping !== undefined && next.frameMappingState === undefined) status.value.frameMappingState = retainedFrameMapping;
    if (typeof next.exceptionBreakpoint === "boolean") exceptionBreakpoint.value = next.exceptionBreakpoint;
    else if (previous?.generation !== next.generation) exceptionBreakpoint.value = false;
    if (status.value.breakpointRulesOwner === "agent" && Array.isArray(status.value.breakpointRuleEvents)) {
      const context = `${next.serverEpoch}:${next.sessionId}:${next.generation}`;
      if (ruleEventContext !== context) {
        ruleEventContext = context;
        ruleEventSequence = 0;
      }
      const events = status.value.breakpointRuleEvents.filter((event) => Number.isSafeInteger(event.sequence) && event.sequence > ruleEventSequence);
      if (events[0] && events[0].sequence > ruleEventSequence + 1) pushHistory("WARN", "Earlier breakpoint messages have expired");
      for (const event of events) {
        if (typeof event.warning === "string" && event.warning) pushHistory("WARN", event.warning);
        if (typeof event.message === "string" && event.message) pushHistory("INFO", event.message);
        ruleEventSequence = event.sequence;
      }
    }
    terminated.value = next.executionStopped === true;
    startOperationId.value = next.startOperationId;
    if (next.state !== "paused" || newStop) {
      readSerial += 1;
      variables.value = [];
      variablesState.value = "unread";
      watchValues.value = {};
      backtrace.value = "";
      frameSourceView.value = null;
      currentFrame.value = 0;
    }
    if (newStop) noteStop();
    recoveryRequired.value = recoveryProjectionRequired.value;
    persistRecovery();
    return true;
  }

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (disposed || recoveryRequired.value || !sessionRef.value || !bootstrap || publicSnapshot.value?.runtimeExited) return;
    const reference = { ...sessionRef.value };
    const generation = publicSnapshot.value?.generation;
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = null;
      try {
        const next = await backend.plDebugHeartbeat(reference);
        if (!sameDebugReference(sessionRef.value, reference) || publicSnapshot.value?.generation !== generation) return;
        publishSnapshot(next);
        scheduleHeartbeat();
      } catch (caught) {
        if (!sameDebugReference(sessionRef.value, reference) || publicSnapshot.value?.generation !== generation) return;
        recoveryRequired.value = true;
        readSerial += 1;
        publicSnapshot.value = null;
        status.value = null;
        variables.value = [];
        variablesState.value = "unread";
        watchValues.value = {};
        backtrace.value = "";
        frameSourceView.value = null;
        error.value = String(caught);
      }
    }, bootstrap.heartbeatSeconds * 1000);
  }

  async function refreshPublicStatus(refresh = false, reference = sessionRef.value): Promise<PlDebugSnapshot> {
    if (!reference) throw new Error("The original debug session has not been found");
    const next = await backend.plDebugStatus({ ...reference }, refresh);
    if (!publishSnapshot(next)) {
      const current = publicSnapshot.value;
      if (
        next.serverEpoch === reference.serverEpoch &&
        next.sessionId === reference.sessionId &&
        next.connectionId === reference.connectionId &&
        next.clientSessionId === reference.clientSessionId &&
        current?.serverEpoch === reference.serverEpoch &&
        current.sessionId === reference.sessionId &&
        current.generation === next.generation
      )
        return current;
      throw new Error("A stale debug status was discarded");
    }
    scheduleHeartbeat();
    return next;
  }

  async function originalReceipt(reference: PlDebugSessionRef, operationId: string, generation?: number): Promise<PlDebugReceipt> {
    let receipt = await backend.plDebugOperation(reference, operationId);
    const verify = () => {
      if (receipt.serverEpoch !== reference.serverEpoch || receipt.sessionId !== reference.sessionId || receipt.operationId !== operationId || (generation !== undefined && receipt.generation !== generation)) {
        throw new Error("The operation receipt does not belong to the original debug request");
      }
    };
    verify();
    for (let attempt = 0; attempt < 40 && (receipt.state === "accepted" || receipt.state === "running"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      receipt = await backend.plDebugOperation(reference, operationId);
      verify();
    }
    return receipt;
  }

  async function runPublicOperation(action: PlDebugAction, params: Record<string, unknown> = {}, confirmationCurrent?: () => boolean): Promise<PlDebugReceipt> {
    const current = publicSnapshot.value;
    const reference = sessionRef.value ? { ...sessionRef.value } : null;
    if (!current || !reference || recoveryRequired.value) throw new Error("Restore the original debug state before operating");
    const interrupt = action === "abort";
    const outstanding = Object.values(pendingOperations.value).filter((operation) => sameDebugReference(operation.reference, reference) && (action === "restart" || pendingInGeneration(operation, current.generation)));
    if (pendingClose.value || (!interrupt && outstanding.length > 0) || (interrupt && outstanding.some((operation) => operation.action === "abort"))) {
      throw new Error("The original debug operation is unresolved; query its receipt before submitting another operation");
    }
    if (!interrupt && action !== "restart" && (current.state !== "paused" || current.activeOperationId)) throw new Error("This operation requires the current paused debug stop");
    if (action === "restart" && (current.executionStopped !== true || current.releaseState !== "released" || !current.runtimeExited || current.executionOutcome === "unknown")) {
      throw new Error("Confirm the previous execution stopped and its resources were released before restarting");
    }
    const frame = currentFrame.value;
    const frozen = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
    if (action !== "restart" && current.stopRevision != null) frozen.stopRevision = current.stopRevision;
    const receiptGeneration = current.generation + (action === "restart" ? 1 : 0);
    const mayWrite = ["resume", "step_over", "step_in", "step_out", "run_to_end", "restart", "set_value", "execute"].includes(action);
    let operationId: string | null = null;
    let admissionRejected = false;
    const dispatch = async () => {
      const pendingNow = Object.values(pendingOperations.value).filter((operation) => sameDebugReference(operation.reference, reference) && (action === "restart" || pendingInGeneration(operation, current.generation)));
      if ((!interrupt && pendingNow.length > 0) || (interrupt && pendingNow.some((operation) => operation.action === "abort")) || pendingClose.value) {
        throw new Error("The original debug operation is unresolved; query its receipt before submitting another operation");
      }
      const latest = publicSnapshot.value;
      if (
        sessionRef.value?.sessionId !== reference.sessionId ||
        sessionRef.value.serverEpoch !== reference.serverEpoch ||
        !latest ||
        latest.generation !== current.generation ||
        latest.revision !== current.revision ||
        currentFrame.value !== frame ||
        recoveryRequired.value ||
        confirmationCurrent?.() === false
      ) {
        throw new Error("The debug stop or selected frame changed during confirmation; submit a new operation");
      }
      operationId = uuid();
      pendingOperations.value[operationId] = { reference, generation: current.generation, action };
      persistRecovery();
      readSerial += 1;
      variables.value = [];
      variablesState.value = "unread";
      watchValues.value = {};
      backtrace.value = "";
      if (status.value) status.value.frames = undefined;
      frameSourceView.value = null;
      let accepted: PlDebugReceipt;
      try {
        accepted = await backend.plDebugOperate({ ...reference, operationId, generation: current.generation, expectedRevision: current.revision, action, params: frozen, productionConfirmed: mayWrite });
      } catch (caught) {
        const pending = pendingOperations.value[operationId];
        if (isAdmissionRejection(caught) && pending?.generation === current.generation && pending.action === action && sameDebugReference(pending.reference, reference)) {
          admissionRejected = true;
          delete pendingOperations.value[operationId];
          persistRecovery();
          if (sameDebugReference(sessionRef.value, reference) && publicSnapshot.value?.generation === current.generation) {
            try {
              await refreshPublicStatus(true);
            } catch {
              if (sameDebugReference(sessionRef.value, reference) && publicSnapshot.value?.generation === current.generation) {
                recoveryRequired.value = true;
                stopHeartbeat();
              }
            }
          }
        }
        throw caught;
      }
      if (accepted.serverEpoch !== reference.serverEpoch || accepted.sessionId !== reference.sessionId || accepted.operationId !== operationId || accepted.generation !== receiptGeneration) {
        throw new Error("The operation response does not belong to the original debug request");
      }
      const receipt = await originalReceipt(reference, operationId, receiptGeneration);
      if (!sameDebugReference(sessionRef.value, reference) || (publicSnapshot.value?.generation !== current.generation && publicSnapshot.value?.generation !== receiptGeneration)) {
        throw new Error("The original debug view changed; its operation receipt is retained on the server");
      }
      lastReceipt.value = receipt;
      if (receipt.state === "succeeded" || receipt.state === "failed") delete pendingOperations.value[operationId];
      persistRecovery();
      if (action !== "set_value") await refreshPublicStatus(true, reference);
      return receipt;
    };
    try {
      if (!mayWrite) return await dispatch();
      const connection = useConnectionStore().connections.find((candidate) => candidate.id === reference.connectionId);
      const result = await executeWithProductionContextGuard({ connection, database: current.database, reviewText: `PL/SQL DEBUG ${action}`, source: "PL/SQL debugger", execute: dispatch });
      if (!result) throw new Error("Debug operation was cancelled before dispatch");
      return result;
    } catch (caught) {
      if (operationId && !admissionRejected) {
        if (sameDebugReference(sessionRef.value, reference) && (publicSnapshot.value?.generation === current.generation || publicSnapshot.value?.generation === receiptGeneration)) {
          recoveryRequired.value = true;
          stopHeartbeat();
          variables.value = [];
          variablesState.value = "unread";
          watchValues.value = {};
          backtrace.value = "";
          if (status.value) status.value.frames = undefined;
          frameSourceView.value = null;
        }
        persistRecovery();
        if (lastReceipt.value?.operationId === operationId && lastReceipt.value.state === "succeeded") {
          throw new Error(`Command succeeded; status could not be refreshed: ${String(caught)}`);
        }
      }
      throw caught;
    }
  }

  async function publicControl(action: PlDebugAction): Promise<PlDebugStatus> {
    if (action === "abort" || action === "restart") await refreshPublicStatus(true);
    const receipt = await runPublicOperation(action);
    if (receipt.state !== "succeeded") {
      throw new Error(String(receipt.error?.message || `The original ${action} operation is ${receipt.state}; query its receipt without repeating it`));
    }
    if (action === "restart" && publicSnapshot.value?.startState !== "succeeded") {
      throw new Error(String(publicSnapshot.value?.startError || "The original restart has not confirmed program startup; restore its status without repeating it"));
    }
    return status.value!;
  }

  async function readPublic(kind: PlDebugReadRequest["kind"], params: Record<string, unknown> = {}) {
    const current = publicSnapshot.value;
    const reference = sessionRef.value ? { ...sessionRef.value } : null;
    if (!current || !reference || recoveryRequired.value) throw new Error("Restore the original debug session before reading");
    const needsStop = kind === "variables" || kind === "value" || kind === "stack";
    const pending = Object.values(pendingOperations.value).some((operation) => sameDebugReference(operation.reference, reference) && pendingInGeneration(operation, current.generation));
    if (needsStop && (current.state !== "paused" || current.stopRevision == null || current.activeOperationId || pending)) throw new Error("Read values from a confirmed paused debug stop");
    const serial = readSerial;
    const frame = currentFrame.value;
    if (needsStop && kind !== "stack" && params.frame !== undefined && params.frame !== frame) throw new Error("Select the requested frame before reading its values");
    const result = await backend.plDebugRead({ ...reference, generation: current.generation, ...(needsStop ? { stopRevision: current.stopRevision } : {}), kind, params });
    const latest = publicSnapshot.value;
    if (
      sessionRef.value?.sessionId !== reference.sessionId ||
      sessionRef.value.serverEpoch !== reference.serverEpoch ||
      latest?.generation !== current.generation ||
      serial !== readSerial ||
      (needsStop && (latest.state !== "paused" || latest.stopRevision !== current.stopRevision || currentFrame.value !== frame))
    ) {
      throw new Error("The read belongs to an old debug context and was discarded");
    }
    if (needsStop && (Array.isArray(result) || result.stopRevision !== current.stopRevision)) throw new Error("The read did not confirm the original debug stop");
    return result;
  }

  function cancelSessionDiscovery() {
    discoverySerial += 1;
    discoveredSessions.clear();
  }

  async function discoverSessions(targetConnectionId: string): Promise<PlDebugSnapshot[]> {
    const serial = ++discoverySerial;
    const workspace = recoverySerial;
    discoveredSessions.clear();
    const current = await getBootstrap(true);
    const candidates = await backend.plDebugList(current.serverEpoch, targetConnectionId);
    if (disposed || serial !== discoverySerial || workspace !== recoverySerial) throw new Error("The debug session list belongs to an old selection");
    if (candidates.some((candidate) => candidate.serverEpoch !== current.serverEpoch || candidate.connectionId !== targetConnectionId || !candidate.sessionId || !candidate.clientSessionId || !candidate.startOperationId)) throw new Error("The debugger returned an inconsistent recovery list");
    discoveredSessions = new Map(candidates.map((candidate) => [candidate.sessionId, JSON.parse(JSON.stringify(candidate)) as PlDebugSnapshot]));
    return candidates;
  }

  function restoreServerOperations(next: PlDebugSnapshot) {
    if (!recoveryProjectionRequired.value || next.recovery?.version !== 1 || !sessionRef.value || !sameDebugReference(sessionRef.value, next)) return;
    const reference = { ...sessionRef.value };
    const restored: Record<string, PlDebugPendingOperation> = {};
    for (const operation of next.recovery.operations) {
      if (!operation.operationId || !Number.isSafeInteger(operation.requestGeneration) || operation.requestGeneration < 1 || operation.receiptGeneration !== operation.requestGeneration + (operation.action === "restart" ? 1 : 0))
        throw new Error("The debugger recovery operation identity is incomplete");
      if (operation.action !== "close") restored[operation.operationId] = { reference, generation: operation.requestGeneration, action: operation.action };
    }
    pendingOperations.value = { ...pendingOperations.value, ...restored };
    if (next.recovery.closeOperationId) pendingClose.value = { operationId: next.recovery.closeOperationId, reference };
    recoveryProjectionRequired.value = false;
    persistRecovery();
  }

  async function adoptDiscoveredSession(sessionId: string): Promise<PlDebugSnapshot | null> {
    const selected = discoveredSessions.get(sessionId);
    if (!selected || disposed || selected.serverEpoch !== bootstrap?.serverEpoch) throw new Error("Refresh the owned debug session list before choosing a session");
    if (sameDebugReference(sessionRef.value, selected)) return recover();
    if (
      busy.value ||
      closeBusy.value ||
      restoring ||
      pendingStart.value ||
      pendingClose.value ||
      Object.keys(pendingOperations.value).length ||
      recoveryProjectionRequired.value ||
      (sessionRef.value && (publicSnapshot.value?.releaseState !== "released" || publicSnapshot.value.runtimeExited !== true || publicSnapshot.value.executionOutcome === "unknown"))
    )
      throw new Error("Restore or close the original debug workspace before selecting another session");
    if (sessionRef.value) reset();
    recoverySerial += 1;
    stopHeartbeat();
    clientSessionId.value = selected.clientSessionId;
    sessionRef.value = { serverEpoch: selected.serverEpoch, sessionId: selected.sessionId, connectionId: selected.connectionId, clientSessionId: selected.clientSessionId };
    startOperationId.value = selected.startOperationId;
    pendingStart.value = { serverEpoch: selected.serverEpoch, operationId: selected.startOperationId, connectionId: selected.connectionId, database: selected.database, clientSessionId: selected.clientSessionId };
    recoveryProjectionRequired.value = true;
    recoveryRequired.value = true;
    persistRecovery();
    restoreServerOperations(selected);
    publishSnapshot(selected);
    return recover();
  }

  async function recover(): Promise<PlDebugSnapshot | null> {
    if (restoring) return restoring;
    const serial = ++recoverySerial;
    let expectedReference = sessionRef.value ? { ...sessionRef.value } : null;
    const isCurrent = () => !disposed && serial === recoverySerial && (expectedReference ? sameDebugReference(sessionRef.value, expectedReference) : sessionRef.value === null);
    const checkCurrent = () => {
      if (!isCurrent()) throw new Error("The recovery belongs to an old debug workspace");
    };
    restoring = (async () => {
      stopHeartbeat();
      const current = await getBootstrap(true);
      checkCurrent();
      const retained = pendingStart.value;
      const epoch = sessionRef.value?.serverEpoch ?? retained?.serverEpoch;
      if (epoch && epoch !== current.serverEpoch) throw new Error("The debugger server restarted; the original execution result remains unknown");
      if (!sessionRef.value && retained) {
        const candidates = await backend.plDebugList(current.serverEpoch, retained.connectionId);
        checkCurrent();
        const matches = candidates.filter((candidate) => candidate.serverEpoch === retained.serverEpoch && candidate.connectionId === retained.connectionId && candidate.clientSessionId === retained.clientSessionId && candidate.startOperationId === retained.operationId);
        if (matches.length !== 1) throw new Error("The original start result has not been found; it will not be executed again");
        const found = matches[0];
        sessionRef.value = { serverEpoch: found.serverEpoch, sessionId: found.sessionId, connectionId: found.connectionId, clientSessionId: found.clientSessionId };
        expectedReference = { ...sessionRef.value };
        persistRecovery();
      }
      if (!sessionRef.value) return null;
      const reference = { ...sessionRef.value };
      const id = retained?.operationId ?? startOperationId.value;
      if (id) {
        const receipt = await originalReceipt(reference, id);
        checkCurrent();
        if (receipt.state !== "accepted" && receipt.state !== "running" && receipt.state !== "unknown") pendingStart.value = null;
      }
      for (const [operationId, operation] of Object.entries(pendingOperations.value)) {
        const receipt = await originalReceipt(operation.reference, operationId, operation.generation + (operation.action === "restart" ? 1 : 0));
        checkCurrent();
        lastReceipt.value = receipt;
        if (receipt.state === "succeeded" || receipt.state === "failed") delete pendingOperations.value[operationId];
      }
      persistRecovery();
      const closing = pendingClose.value ? { operationId: pendingClose.value.operationId, reference: { ...pendingClose.value.reference } } : null;
      const closed = closing ? await originalReceipt(closing.reference, closing.operationId) : null;
      checkCurrent();
      const next = await refreshPublicStatus(true);
      checkCurrent();
      restoreServerOperations(next);
      recoveryRequired.value = recoveryProjectionRequired.value;
      if (closed?.state === "succeeded" && closed.generation === next.generation && next.releaseState === "released" && next.runtimeExited && closing && pendingClose.value?.operationId === closing.operationId && sameDebugReference(pendingClose.value.reference, closing.reference)) {
        pendingClose.value = null;
        persistRecovery();
      }
      if (!recoveryRequired.value && !pendingStart.value && !pendingClose.value && !Object.keys(pendingOperations.value).length && next.startState === "succeeded" && next.executionOutcome !== "unknown") error.value = null;
      return next;
    })()
      .catch((caught) => {
        if (!isCurrent()) throw caught;
        recoveryRequired.value = true;
        publicSnapshot.value = null;
        status.value = null;
        variables.value = [];
        variablesState.value = "unread";
        watchValues.value = {};
        backtrace.value = "";
        frameSourceView.value = null;
        error.value = String(caught);
        throw caught;
      })
      .finally(() => {
        if (serial === recoverySerial) restoring = null;
      });
    return restoring;
  }

  onScopeDispose(() => {
    disposed = true;
    stopHeartbeat();
  });

  const supported = computed(() => probe.value?.supported === true);
  /** The line the debuggee is currently parked on, for the editor highlight. */
  const currentLine = computed(() => statusLine(status.value));
  const currentProgram = computed(() => status.value?.program ?? null);
  const hasSession = computed(() => debugId.value !== null && !terminated.value);
  /**
   * Lines of the debugged routine that currently carry a breakpoint, for the
   * editor gutter. Breakpoints set on another object of the same session are
   * filtered out by program name.
   */
  const breakpointLines = computed<number[]>(() => {
    const current = target.value;
    if (!current) return [];
    const lines = new Set<number>();
    for (const breakpoint of breakpoints.value) {
      if (!breakpointBelongsToTarget(breakpoint, current)) continue;
      const line = breakpointLine(breakpoint);
      if (line === null) continue;
      // A breakpoint the server disabled in place stays in the list (that is
      // what keeps its breakpoint number); the gutter draws it through
      // `disabledBreakpointLines` instead of the solid marker.
      if (breakpointLocals.value[line]?.enabled === false) continue;
      lines.add(line);
    }
    return [...lines].sort((left, right) => left - right);
  });
  /**
   * Lines whose breakpoint is currently disabled server-side but still carries
   * local properties (condition / ignore count), for the dimmed gutter marker.
   */
  const disabledBreakpointLines = computed<number[]>(() =>
    Object.keys(breakpointLocals.value)
      .map((line) => Number(line))
      .filter((line) => Number.isFinite(line) && breakpointLocals.value[line]?.enabled === false)
      .sort((left, right) => left - right),
  );

  /** One row per user name, resolved by GET_VALUE rather than enumeration. */
  const watches = computed<PlDebugWatchRow[]>(() =>
    watchNames.value.map((name) => {
      const entry = watchValues.value[name];
      return {
        name,
        value: entry ? entry.value : null,
        type: entry?.type ?? null,
        inScope: entry !== undefined && entry.state !== "out_of_scope" && entry.state !== "error" && entry.state !== "unknown",
        state: entry?.state ?? "unknown",
        message: entry?.message ?? null,
      };
    }),
  );

  /** Local properties of a line, with defaults for anything never configured. */
  function readLocals(line: number): PlDebugBreakpointLocals | null {
    const stored = breakpointLocals.value[line];
    if (!stored) return null;
    return {
      enabled: stored.enabled !== false,
      ignoreCount: normalizeIgnoreCount(stored.ignoreCount),
      condition: typeof stored.condition === "string" ? stored.condition : "",
      hits: Number.isFinite(stored.hits) ? stored.hits : 0,
      message: typeof stored.message === "string" ? stored.message : "",
    };
  }

  /** Local properties of a line, created with defaults when missing. */
  function ensureLocals(line: number): PlDebugBreakpointLocals {
    const stored = breakpointLocals.value[line];
    if (stored) return stored;
    const created = defaultLocals();
    breakpointLocals.value[line] = created;
    return created;
  }

  /**
   * Attaches the line's local properties to a breakpoint the server returned.
   * A line without local properties is returned untouched.
   */
  function withLocals(breakpoint: PlDebugBreakpoint): PlDebugLocalBreakpoint {
    const line = breakpointLine(breakpoint);
    const locals = line === null ? null : readLocals(line);
    if (!locals) return breakpoint;
    return { ...breakpoint, ...locals };
  }

  /**
   * Server breakpoint number of the breakpoint on one line of the debugged
   * object, or null when that line carries none. The line ↔ breakpointNumber
   * mapping is the breakpoint list itself: the agent assigns the number when the
   * breakpoint is created (`applyBreakpoints` keeps the created entry) and every
   * refresh re-reads it, so no parallel map can drift out of sync.
   */
  function serverBreakpointNumberForLine(current: PlDebugSessionTarget, lineNum: number): number | null {
    for (const breakpoint of breakpoints.value) {
      if (!breakpointBelongsToTarget(breakpoint, current) || breakpointLine(breakpoint) !== lineNum) continue;
      const number = breakpoint.breakpointNumber;
      if (typeof number === "number" && Number.isFinite(number) && number > 0) return number;
    }
    return null;
  }

  /** Appends one history entry, keeping only the newest `HISTORY_LIMIT` lines. */
  function pushHistory(level: PlDebugHistoryEntry["level"], message: string) {
    history.value.push({ level, time: historyTimestamp(), message });
    if (history.value.length > HISTORY_LIMIT) {
      history.value.splice(0, history.value.length - HISTORY_LIMIT);
    }
  }

  /** Banks one stop for the panels; every path that lands the debuggee calls this. */
  function noteStop() {
    stopSeq.value += 1;
  }

  /**
   * Forgets the last failure. A caller that recovered from a rejected operation by
   * retrying with another input (the object browser's entry breakpoint falls back
   * from the routine header line to the body's first statement) clears the stale
   * message here, so the toolbar cannot show an error for something that has since
   * succeeded -- the recovery itself is recorded in the history instead.
   */
  function clearError() {
    error.value = null;
  }

  async function inspectTarget(targetConnectionId: string, targetDatabase: string, target?: PlDebugInspectRequest["target"]) {
    const request = ++probeRequest;
    probing.value = true;
    try {
      await getBootstrap();
      const inspected = await backend.plDebugInspect({ connectionId: targetConnectionId, database: targetDatabase, clientSessionId: clientSessionId.value, ...(target ? { target } : {}) });
      const result = inspected.capabilities as unknown as PlDebugProbeResult;
      if (request === probeRequest) {
        preparedProbe = { connectionId: targetConnectionId, database: targetDatabase, result };
        if (!sessionRef.value || (sessionRef.value.connectionId === targetConnectionId && database.value === targetDatabase)) probe.value = result;
      }
      return inspected;
    } catch (caught) {
      if (request === probeRequest && (!sessionRef.value || (sessionRef.value.connectionId === targetConnectionId && database.value === targetDatabase))) probe.value = { supported: false, reason: String(caught) };
      throw caught;
    } finally {
      if (request === probeRequest) probing.value = false;
    }
  }

  async function runProbe(targetConnectionId: string, targetDatabase = ""): Promise<PlDebugProbeResult> {
    try {
      return (await inspectTarget(targetConnectionId, targetDatabase)).capabilities as unknown as PlDebugProbeResult;
    } catch (error) {
      return { supported: false, reason: String(error) };
    }
  }

  function publishCompilation(reference: PlDebugCompileRef, receipt: PlDebugCompileReceipt) {
    if (receipt.serverEpoch !== reference.serverEpoch || receipt.operationId !== reference.operationId || receipt.connectionId !== reference.connectionId || receipt.clientSessionId !== reference.clientSessionId) throw new Error("The compilation response does not belong to the original operation");
    if (compilationRef.value?.operationId === reference.operationId && compilationRef.value.serverEpoch === reference.serverEpoch) compilationReceipt.value = receipt;
    return receipt;
  }

  async function recoverCompilation() {
    const reference = compilationRef.value;
    if (!reference) return null;
    return publishCompilation(reference, await backend.plDebugCompileStatus({ ...reference }));
  }

  async function compileDebug(request: Omit<PlDebugCompileIntent, "serverEpoch" | "operationId" | "clientSessionId" | "productionConfirmed">, isCurrent: () => boolean) {
    if (compilationBusy.value || compilationUnresolved.value) throw new Error("Read the original compilation result before compiling again");
    if (!request.confirmed) throw new Error("Confirm the exact debug compilation preview before executing it");
    const frozen = JSON.parse(JSON.stringify(request)) as typeof request;
    compilationBusy.value = true;
    try {
      const current = await getBootstrap();
      const connection = useConnectionStore().connections.find((candidate) => candidate.id === frozen.connectionId);
      return await executeWithProductionContextGuard({
        connection,
        database: productionContextForDatabase(connection, frozen.database).active ? frozen.database : frozen.preview.schema,
        reviewText: frozen.preview.sql,
        source: "PL/SQL debugger",
        execute: async () => {
          if (!isCurrent()) throw new Error("The compilation preview changed; confirm the new preview");
          const reference: PlDebugCompileRef = { serverEpoch: current.serverEpoch, operationId: uuid(), connectionId: frozen.connectionId, clientSessionId: clientSessionId.value };
          compilationRef.value = reference;
          compilationReceipt.value = null;
          persistRecovery();
          try {
            return publishCompilation(reference, await backend.plDebugCompile({ ...frozen, ...reference, productionConfirmed: true }));
          } catch (caught) {
            if (isAdmissionRejection(caught)) {
              compilationRef.value = null;
              persistRecovery();
            }
            throw caught;
          }
        },
      });
    } finally {
      compilationBusy.value = false;
    }
  }

  async function start(targetConnectionId: string, targetDatabase: string, request: PlDebugStartRequest, confirmation?: { riskAccepted: boolean; expectedConnectionRevision: string; isCurrent?: () => boolean }) {
    if (
      busy.value ||
      pendingStart.value ||
      pendingClose.value ||
      recoveryRequired.value ||
      recoveryProjectionRequired.value ||
      (compilationRef.value?.connectionId === targetConnectionId && (compilationBusy.value || compilationUnresolved.value)) ||
      (sessionRef.value && (publicSnapshot.value?.releaseState !== "released" || publicSnapshot.value.runtimeExited !== true || publicSnapshot.value.executionOutcome === "unknown"))
    ) {
      throw new Error("Restore or close the original debug session before starting another target");
    }
    if (!confirmation?.riskAccepted) throw new Error("Confirm the debugger execution risks before starting");
    recoverySerial += 1;
    restoring = null;
    cancelSessionDiscovery();
    const frozen = JSON.parse(JSON.stringify(request)) as PlDebugStartRequest;
    busy.value = true;
    error.value = null;
    try {
      const current = await getBootstrap();
      const connection = useConnectionStore().connections.find((candidate) => candidate.id === targetConnectionId);
      const result = await executeWithProductionContextGuard({
        connection,
        database: targetDatabase,
        reviewText: `PL/SQL DEBUG ${describeTarget(frozen)}`,
        source: "PL/SQL debugger",
        execute: async () => {
          if (confirmation.isCurrent?.() === false) throw new Error("The debug target or parameters changed; confirm the new preview");
          const operationId = uuid();
          const intent: PlDebugStartIntent = {
            serverEpoch: current.serverEpoch,
            operationId,
            connectionId: targetConnectionId,
            database: targetDatabase,
            clientSessionId: clientSessionId.value,
            target: frozen as unknown as Record<string, unknown>,
            riskAccepted: confirmation.riskAccepted,
            productionConfirmed: true,
            expectedConnectionRevision: confirmation.expectedConnectionRevision,
          };
          stopHeartbeat();
          sessionRef.value = null;
          publicSnapshot.value = null;
          readSerial += 1;
          debugId.value = null;
          status.value = null;
          variables.value = [];
          variablesState.value = "unread";
          watchValues.value = {};
          backtrace.value = "";
          frameSourceView.value = null;
          currentFrame.value = 0;
          pendingStart.value = { serverEpoch: current.serverEpoch, operationId, connectionId: targetConnectionId, database: targetDatabase, clientSessionId: clientSessionId.value };
          startOperationId.value = operationId;
          persistRecovery();
          let accepted: PlDebugReceipt;
          try {
            accepted = await backend.plDebugStart(intent);
          } catch (caught) {
            const pending = pendingStart.value;
            if (isAdmissionRejection(caught) && pending?.operationId === operationId && pending.serverEpoch === intent.serverEpoch && pending.connectionId === intent.connectionId && pending.clientSessionId === intent.clientSessionId) {
              pendingStart.value = null;
              if (startOperationId.value === operationId) startOperationId.value = null;
              persistRecovery();
            }
            throw caught;
          }
          if (accepted.operationId !== operationId || accepted.serverEpoch !== current.serverEpoch) throw new Error("The start response does not belong to the original request");
          const reference: PlDebugSessionRef = { serverEpoch: accepted.serverEpoch, sessionId: accepted.sessionId, connectionId: targetConnectionId, clientSessionId: clientSessionId.value };
          sessionRef.value = reference;
          persistRecovery();
          const receipt = await originalReceipt(reference, operationId);
          const next = await refreshPublicStatus(true);
          if (receipt.state === "failed" || next.startState === "failed") {
            pendingStart.value = null;
            persistRecovery();
            throw new Error(String(next.startError || receipt.error?.message || "The original debug start failed"));
          }
          if (receipt.state !== "succeeded" || next.startState !== "succeeded") throw new Error("The original debug start is not confirmed; restore its status without starting it again");
          pendingStart.value = null;
          persistRecovery();
          breakpoints.value = [];
          output.value = "";
          pushHistory("INFO", `start ${describeTarget(frozen)}`);
          return status.value!;
        },
      });
      if (!result) throw new Error("Debug start was cancelled before dispatch");
      return result;
    } catch (caught) {
      if (pendingStart.value && !publicSnapshot.value) {
        recoveryRequired.value = true;
        stopHeartbeat();
      }
      error.value = String(caught);
      pushHistory("ERROR", `start failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  const currentSourceRef = computed<PlDebugSourceRef | null>(() => {
    const frame = status.value?.frames?.[currentFrame.value];
    const source = frame?.sourceRef ?? (currentFrame.value === 0 ? status.value?.sourceRef : null);
    if (!source || !source.id || source.sourceRevision <= 0 || source.stopRevision !== publicSnapshot.value?.stopRevision || (frame ? frame.sourceState !== "resolved" || frame.nativeFrameId !== source.nativeFrameId : status.value?.sourceMappingState !== "verified")) return null;
    return source;
  });
  const canChangeNativeBreakpoints = computed(() => hasSession.value && !busy.value && !recoveryRequired.value && publicSnapshot.value?.state === "paused" && currentSourceRef.value !== null && (currentSourceRef.value.objectType !== "ANONYMOUS" || currentFrame.value === 0));
  const nativeBreakpointLines = computed(() =>
    breakpoints.value
      .filter((breakpoint) => breakpoint.owned === true && breakpoint.sourceRefId === currentSourceRef.value?.id && breakpoint.sourceRevision === currentSourceRef.value?.sourceRevision && breakpoint.localActive !== false)
      .map(breakpointLine)
      .filter((line): line is number => line !== null),
  );

  async function changeNativeBreakpoint(action: "set_breakpoints" | "delete_breakpoints" | "set_breakpoint_enabled", params: Record<string, unknown>, isCurrent: () => boolean) {
    if (!hasSession.value || busy.value || recoveryRequired.value || publicSnapshot.value?.state !== "paused" || !isCurrent()) throw new Error("Read the current owned breakpoint context before changing it");
    busy.value = true;
    try {
      const receipt = await runPublicOperation(action, params, isCurrent);
      if (receipt.state !== "succeeded") {
        if (receipt.state !== "failed") {
          recoveryRequired.value = true;
          stopHeartbeat();
          persistRecovery();
        }
        throw new Error(
          receipt.error ? formatError(receipt.error.detail ?? receipt.error) : String((receipt.result as { message?: string } | null)?.message || `The original breakpoint operation is ${receipt.state}; native result=${(receipt.result as { result?: unknown } | null)?.result ?? "unknown"}`),
        );
      }
      pushHistory("INFO", `${action} succeeded`);
      try {
        await refreshBreakpoints();
      } catch (caught) {
        throw new Error(`Breakpoint command succeeded; inventory could not be refreshed: ${String(caught)}`);
      }
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", String(caught));
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function toggleSourceBreakpoint(line: number) {
    const source = currentSourceRef.value;
    if (!canChangeNativeBreakpoints.value || !source || !Number.isInteger(line) || line < 1) throw new Error("Read the current native source before changing its breakpoint");
    const existing = breakpoints.value.find((breakpoint) => breakpoint.owned === true && breakpoint.sourceRefId === source.id && breakpoint.sourceRevision === source.sourceRevision && breakpoint.line === line);
    if (existing) return deleteOwnedBreakpoint(existing);
    return changeNativeBreakpoint("set_breakpoints", { sourceRefId: source.id, sourceRevision: source.sourceRevision, nativeFrameId: source.nativeFrameId, line }, () => {
      const current = currentSourceRef.value;
      return current?.id === source.id && current.sourceRevision === source.sourceRevision && current.stopRevision === source.stopRevision && current.nativeFrameId === source.nativeFrameId;
    });
  }

  function ownedBreakpointContext(breakpoint: PlDebugBreakpoint) {
    const number = breakpoint.breakpointNumber;
    const registration = breakpoint.registrationId;
    const sourceRefId = breakpoint.sourceRefId;
    const sourceRevision = breakpoint.sourceRevision;
    if (breakpoint.owned !== true || typeof number !== "number" || !registration) throw new Error("This breakpoint has no original owner registration");
    return {
      params: { breakpointNumber: number, registrationId: registration },
      isCurrent: () => breakpoints.value.some((current) => current.owned === true && current.breakpointNumber === number && current.registrationId === registration && current.sourceRefId === sourceRefId && current.sourceRevision === sourceRevision),
    };
  }

  async function deleteOwnedBreakpoint(breakpoint: PlDebugBreakpoint) {
    const context = ownedBreakpointContext(breakpoint);
    return changeNativeBreakpoint("delete_breakpoints", context.params, context.isCurrent);
  }

  async function setOwnedBreakpointEnabled(breakpoint: PlDebugBreakpoint, enabled: boolean) {
    const context = ownedBreakpointContext(breakpoint);
    return changeNativeBreakpoint("set_breakpoint_enabled", { ...context.params, enabled }, context.isCurrent);
  }

  async function updateOwnedBreakpointRules(breakpoint: PlDebugBreakpoint, patch: Partial<{ ignoreCount: number; condition: string; message: string }>) {
    if (status.value?.breakpointRulesOwner !== "agent") throw new Error("The original Agent has not confirmed ownership of breakpoint rules");
    const current = breakpoints.value.find((entry) => entry.breakpointNumber === breakpoint.breakpointNumber && entry.registrationId === breakpoint.registrationId);
    if (!current) throw new Error("Read the original breakpoint registration before editing its rules");
    const rules = { ignoreCount: current.ignoreCount ?? 0, condition: current.condition ?? "", message: current.message ?? "", ...patch };
    if (!Number.isSafeInteger(rules.ignoreCount) || rules.ignoreCount < 0) throw new Error("Ignore count must be a nonnegative safe integer");
    const context = ownedBreakpointContext(breakpoint);
    return changeNativeBreakpoint("set_breakpoints", { ...context.params, rules }, context.isCurrent);
  }

  /** Sets the full breakpoint set: server-side diffs against the stored list. */
  async function applyBreakpoints(next: PlDebugBreakpoint[]) {
    if (!debugId.value) throw new Error("no debug session");
    busy.value = true;
    try {
      const toAdd = next.filter((candidate) => !breakpoints.value.some((stored) => sameBreakpoint(stored, candidate)));
      const toRemove = breakpoints.value.filter((stored) => !next.some((candidate) => sameBreakpoint(stored, candidate)));
      if (toAdd.length > 0) {
        const created = await plDebugSetBreakpoints(debugId.value, toAdd);
        // The server assigns breakpoint numbers and knows nothing about the
        // local properties, so merge them back by line: a breakpoint that is
        // re-set (enable, session re-open) keeps its condition and ignore count.
        for (const breakpoint of created) {
          const merged = withLocals(breakpoint);
          const index = breakpoints.value.findIndex((stored) => sameBreakpoint(stored, merged));
          if (index >= 0) breakpoints.value[index] = merged;
          else breakpoints.value.push(merged);
        }
        pushHistory("INFO", `breakpoints +${describeBreakpoints(toAdd)}`);
        // A breakpoint the server did not create never stops the debuggee, while
        // the editor gutter still shows its marker: the request is reported as a
        // success without this warning and the user sees nothing happen. The
        // measured typical case is an anonymous block on Oracle 19c, where no
        // breakpoint can be armed at all (the block can only be run, have its
        // output collected, or stop on an exception breakpoint).
        if (created.length < toAdd.length) {
          const refused = toAdd.length - created.length;
          pushHistory("WARN", `${refused} of ${toAdd.length} breakpoints were not accepted by the server and are not in effect (typical case: Oracle 19c cannot set breakpoints in an anonymous block; run the block, collect its output, or stop on an exception breakpoint instead)`);
        }
      }
      if (toRemove.length > 0) {
        await plDebugDeleteBreakpoints(debugId.value, toRemove);
        breakpoints.value = breakpoints.value.filter((stored) => !toRemove.some((candidate) => sameBreakpoint(stored, candidate)));
        pushHistory("INFO", `breakpoints -${describeBreakpoints(toRemove)}`);
      }
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `breakpoints failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  /**
   * Toggles the gutter breakpoint on one line of the debugged object. Both
   * directions go through `applyBreakpoints` so add and remove share the same
   * server-side diffing path.
   */
  async function toggleBreakpoint(lineNum: number) {
    const current = target.value;
    if (!current) return;
    if (!hasSession.value) {
      // The gutter stays clickable after the program finishes, so a click here used to
      // do nothing at all (reported from use, 2026-10-13). Say what is wrong and what to
      // do instead: the toolbar's Restart re-opens the launch dialog for this routine.
      pushHistory("WARN", `breakpoint line ${lineNum}: no live debug session (${terminated.value ? "the program has finished" : "the session is gone"}) — restart the debugger and set it again`);
      return;
    }
    const isSet = breakpoints.value.some((breakpoint) => breakpointBelongsToTarget(breakpoint, current) && breakpointLine(breakpoint) === lineNum);
    if (!isSet) {
      await applyBreakpoints([...breakpoints.value, breakpointForLine(current, lineNum)]);
      return;
    }
    // An explicit gutter removal forgets the line's local rules; use
    // `setBreakpointEnabled(line, false)` to keep them for a later re-enable.
    delete breakpointLocals.value[lineNum];
    await applyBreakpoints(breakpoints.value.filter((breakpoint) => !(breakpointBelongsToTarget(breakpoint, current) && breakpointLine(breakpoint) === lineNum)));
  }

  /**
   * Enables or disables the breakpoint on one line.
   *
   * The server-side primitive (`pl_debug_set_breakpoint_enabled`) toggles an
   * existing breakpoint in place, so the server keeps its breakpoint number and
   * the local condition / ignore count stay attached. Two situations cannot use
   * it and keep the client-side fallback (delete server-side + re-set later,
   * which hands out a new breakpoint number): a server without the
   * enable/disable primitive (`serverSupported = false`, which is a capability
   * report and not an error) and a line that carries no live breakpoint number.
   *
   * A refusal — `ok = false` while `serverSupported = true`, typically
   * `error_no_such_breakpt` — is recorded in the session history and surfaced in
   * `error` instead of being swallowed, and the previous local state is kept.
   */
  async function setBreakpointEnabled(lineNum: number, enabled: boolean) {
    const current = target.value;
    if (!current) return;
    if (!hasSession.value) {
      pushHistory("WARN", `breakpoint line ${lineNum}: no live debug session — restart the debugger and change it again`);
      return;
    }
    const locals = ensureLocals(lineNum);
    const wasEnabled = locals.enabled !== false;
    locals.enabled = enabled;
    const stored = breakpoints.value.filter((breakpoint) => breakpointBelongsToTarget(breakpoint, current) && breakpointLine(breakpoint) === lineNum);
    // Already in the requested state and still known to the server: nothing to do.
    if (wasEnabled === enabled && stored.length > 0) return;
    const sessionId = debugId.value;
    const breakpointNumber = sessionId === null ? null : serverBreakpointNumberForLine(current, lineNum);
    if (sessionId !== null && breakpointNumber !== null) {
      const label = enabled ? "enable" : "disable";
      try {
        const result = await plDebugSetBreakpointEnabled(sessionId, breakpointNumber, enabled);
        if (result.serverSupported === true) {
          if (result.ok === true) {
            // The breakpoint stays exactly where it is; only its local
            // enablement changed, so re-attach the properties in place.
            breakpoints.value = breakpoints.value.map((breakpoint) => (breakpointBelongsToTarget(breakpoint, current) && breakpointLine(breakpoint) === lineNum ? withLocals(breakpoint) : breakpoint));
            pushHistory("INFO", `breakpoint line ${lineNum} ${enabled ? "enabled" : "disabled"} (server, breakpoint ${breakpointNumber})`);
            return;
          }
          const detail = result.message ?? `result=${result.result}`;
          error.value = detail;
          locals.enabled = wasEnabled;
          pushHistory("ERROR", `breakpoint line ${lineNum} ${label} failed (breakpoint ${breakpointNumber}): ${detail}`);
          return;
        }
        // `serverSupported = false`: expected on servers without the primitive,
        // so the fallback below stays exactly the old behaviour and records
        // nothing extra (the fallback logs its own INFO line).
      } catch (caught) {
        // A backend that does not know the command rejects the invoke; degrade
        // to the fallback instead of losing the toggle, but say so.
        pushHistory("WARN", `breakpoint line ${lineNum} ${label}: server-side toggle unavailable (${String(caught)}); using the client-side fallback`);
      }
    }
    if (!enabled) {
      if (stored.length === 0) return;
      await applyBreakpoints(breakpoints.value.filter((breakpoint) => !stored.some((candidate) => sameBreakpoint(candidate, breakpoint))));
      pushHistory("INFO", `breakpoint line ${lineNum} disabled (condition and ignore count kept)`);
      return;
    }
    if (stored.length > 0) {
      breakpoints.value = breakpoints.value.map((breakpoint) => (stored.some((candidate) => sameBreakpoint(candidate, breakpoint)) ? withLocals(breakpoint) : breakpoint));
      return;
    }
    // `applyBreakpoints` merges the kept local properties back onto the
    // breakpoint the server creates for this line.
    await applyBreakpoints([...breakpoints.value, breakpointForLine(current, lineNum)]);
  }

  /** Sets the minimal stop condition of the breakpoint on `lineNum` (frontend-only). */
  function setBreakpointCondition(lineNum: number, condition: string) {
    ensureLocals(lineNum).condition = typeof condition === "string" ? condition : "";
    pushHistory("INFO", `breakpoint line ${lineNum} condition: ${condition ? condition : "(none)"}`);
  }

  /**
   * Sets the note the breakpoint on `lineNum` carries (frontend-only). It is shown in
   * the debug console whenever a resume stops there -- PL/SQL Developer's breakpoint
   * message, which is what makes a breakpoint self-explanatory without editing the
   * source.
   */
  function setBreakpointMessage(lineNum: number, message: string) {
    ensureLocals(lineNum).message = typeof message === "string" ? message : "";
    pushHistory("INFO", `breakpoint line ${lineNum} message: ${message ? message : "(none)"}`);
  }

  /** Sets how many hits the breakpoint on `lineNum` ignores before stopping (frontend-only). */
  function setBreakpointIgnoreCount(lineNum: number, ignoreCount: number) {
    const locals = ensureLocals(lineNum);
    locals.ignoreCount = normalizeIgnoreCount(ignoreCount);
    locals.hits = 0;
  }

  async function refreshBreakpoints() {
    if (!debugId.value) return;
    const result = await readPublic("breakpoints");
    const entries = Array.isArray(result) ? result : result.breakpoints;
    if (!Array.isArray(entries)) throw new Error("The breakpoint response has no confirmed list");
    breakpoints.value = entries.map((entry) => (entry.owned !== undefined ? { ...entry, enabled: entry.localActive !== false } : withLocals(entry)));
  }

  /** Shared body of the blocking continuation calls; `label` names it in the history. */
  async function continueWith(action: (debugId: string) => Promise<PlDebugStatus>, label: string, applyStopRules = false) {
    if (!debugId.value) throw new Error("no debug session");
    busy.value = true;
    error.value = null;
    try {
      let result = await action(debugId.value);
      status.value = result;
      terminated.value = result.terminated === true;
      pushHistory("INFO", `${label} → ${result.terminated === true ? "terminated" : `line ${result.line ?? "?"}`}`);
      // The exception-breakpoint loop is capped so it cannot poll forever; when it
      // hits the cap the agent says so in `message` and the session stops. Record it
      // as a warning — the state label alone would look like an ordinary breakpoint.
      if (result.exceptionResumeTruncated === true) {
        pushHistory("WARN", `exception breakpoint: ${result.message ?? "resume stopped without an exception"}`);
      }
      // The agent explains a `step_in` that did not actually enter a subprogram:
      // the line may simply have no call to step into (a normal outcome) or the
      // callee may lack debug information. The stop position alone cannot tell
      // the two apart, so the backend authors the text and it is recorded as-is.
      if (typeof result.stepHint === "string" && result.stepHint !== "") {
        pushHistory("WARN", result.stepHint);
      }
      // `resumeIgnoreBreakpoints` could not run the program to completion (a
      // breakpoint refused to be disabled, or the continuation cap was hit):
      // the debuggee is stopped, not finished, and `message` says why.
      if (result.runToEndIncomplete === true) {
        pushHistory("WARN", `run to end: ${result.message ?? "stopped before the program finished"}`);
      }
      if (result.terminated === true) {
        // DBMS_OUTPUT is only readable once the debuggee's program is done (while it is
        // parked the buffer is held by the interpreter: measured 0-1 ms when finished,
        // always empty while parked). Reading it here is what makes the output tab fill
        // by itself instead of waiting for a manual refresh that users miss.
        try {
          await refreshLog();
        } catch (caught) {
          pushHistory("WARN", `DBMS_OUTPUT could not be read after the program finished: ${String(caught)}`);
        }
      }
      if (result.breakpointRulesOwner !== "agent" && applyStopRules && result.terminated !== true) {
        result = await skipAccordingToRules(label, action, result);
      } else if (result.breakpointRulesOwner !== "agent" && result.terminated !== true) {
        // A step can land on a line whose breakpoint carries a message too; a resume
        // that ran the stop rules reports it from inside the rule engine instead, so
        // an auto-resumed hit does not print the message of a line it did not stop on.
        notifyBreakpointMessage(result);
      }
      return result;
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `${label} failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  /** One automatic resume of the stop-rule engine; every step is recorded. */
  async function autoResume(action: (debugId: string) => Promise<PlDebugStatus>, label: string, reason: string): Promise<PlDebugStatus> {
    if (!debugId.value) throw new Error("no debug session");
    let result: PlDebugStatus;
    try {
      result = await action(debugId.value);
    } catch (caught) {
      pushHistory("ERROR", `${label}: ${reason}; auto resume failed: ${String(caught)}`);
      throw caught;
    }
    status.value = result;
    terminated.value = result.terminated === true;
    pushHistory("INFO", `${label}: ${reason}; auto resume → ${result.terminated === true ? "terminated" : `line ${statusLine(result) ?? "?"}`}`);
    return result;
  }

  /**
   * Frontend hit-count / condition handling for a stop the server reported.
   *
   * The debuggee is parked on a line whose local properties decide whether it
   * should keep running: an unreached ignore count or a false condition resumes
   * again. Conditions are evaluated against the current frame's variables and
   * deliberately stay minimal — anything unparseable stops the session and
   * records a WARN instead of guessing. Automatic resumes are capped by
   * `AUTO_CONTINUE_LIMIT`, so a wrong rule cannot loop forever.
   */
  async function skipAccordingToRules(label: string, action: (debugId: string) => Promise<PlDebugStatus>, first: PlDebugStatus): Promise<PlDebugStatus> {
    let result = first;
    let automatic = 0;
    while (result.terminated !== true) {
      const line = statusLine(result);
      const locals = line === null ? null : readLocals(line);
      if (line === null || !locals) break;
      if (locals.ignoreCount > 0 && locals.hits < locals.ignoreCount) {
        const stored = ensureLocals(line);
        stored.hits += 1;
        if (stored.hits < locals.ignoreCount) {
          if (automatic >= AUTO_CONTINUE_LIMIT) {
            pushHistory("ERROR", `${label}: auto continue limit (${AUTO_CONTINUE_LIMIT}) reached at line ${line}; stopped`);
            break;
          }
          automatic += 1;
          result = await autoResume(action, label, `breakpoint line ${line} hit ${stored.hits}/${locals.ignoreCount}`);
          continue;
        }
        pushHistory("INFO", `breakpoint line ${line}: ignore count ${locals.ignoreCount} reached, evaluating stop`);
      }
      const condition = locals.condition.trim();
      if (condition) {
        const verdict = await evaluateConditionAgainstFrame(condition);
        if (verdict.kind === "unparseable") {
          pushHistory("WARN", `breakpoint line ${line}: condition "${condition}" not evaluated (${verdict.reason}); stopped`);
          break;
        }
        if (verdict.kind === "false") {
          if (automatic >= AUTO_CONTINUE_LIMIT) {
            pushHistory("ERROR", `${label}: auto continue limit (${AUTO_CONTINUE_LIMIT}) reached at line ${line}; stopped`);
            break;
          }
          automatic += 1;
          result = await autoResume(action, label, `breakpoint line ${line} condition "${condition}" is false`);
          continue;
        }
      }
      break;
    }
    // The loop left with a stop rather than a resume: this is the hit the user sees,
    // so it is also where the breakpoint's own message is printed (not on the hits the
    // ignore count or a false condition resumed past).
    notifyBreakpointMessage(result);
    return result;
  }

  /** Reads the current frame and evaluates one minimal condition against it. */
  async function evaluateConditionAgainstFrame(expression: string): Promise<PlDebugConditionVerdict> {
    try {
      await refreshVariables();
    } catch (caught) {
      return { kind: "unparseable", reason: `variables unavailable: ${String(caught)}` };
    }
    return evaluateCondition(expression, variables.value);
  }

  /**
   * Prints the breakpoint's own message when a stop landed on its line.
   *
   * Only breakpoint stops qualify (`reason` 3): a step that happens to pass the line
   * is not a breakpoint hit, and a stop on a line without a breakpoint has no locals.
   * The check runs on the stop the user finally sees, so an auto-resumed hit (ignore
   * count, false condition) does not print the message of a line it did not stop on.
   */
  function notifyBreakpointMessage(result: PlDebugStatus) {
    if (Number(result.reason) !== REASON_BREAKPOINT) return;
    const line = statusLine(result);
    if (line === null) return;
    const message = readLocals(line)?.message?.trim();
    if (!message) return;
    pushHistory("INFO", `breakpoint line ${line}: ${message}`);
  }

  /**
   * Runs the parked program to its end with bounded single stepping and records which
   * lines ran, how often. This is the debugger's own answer to "which lines ran" --
   * PL/SQL Developer's trace window reaches the same ground through DBMS_TRACE, which
   * this server cannot serve: on 19c EE `DBMS_TRACE` exposes only SET_PLSQL_TRACE
   * (events go to server trace files, not to tables) and `DBMS_PROFILER` fails with
   * ORA-06528 because its tables are absent (ledger §2 #35, evidence
   * e2e-verify/probe_execute_trace*.out). Stepping costs about one round trip per
   * line, so the run is capped and can be stopped between steps.
   */
  async function startTrace(stepLimit = TRACE_STEP_LIMIT) {
    if (!debugId.value) throw new Error("no debug session");
    if (terminated.value) throw new Error("debuggee has finished");
    const reference = publicSnapshot.value;
    const limit = Number.isFinite(stepLimit) && stepLimit > 0 ? Math.trunc(stepLimit) : TRACE_STEP_LIMIT;
    traceRunning.value = true;
    traceStopRequested = false;
    const hits = new Map<number, number>();
    const began = Date.now();
    let steps = 0;
    let truncated = false;
    try {
      pushHistory("INFO", `trace: stepping up to ${limit} lines from line ${currentLine.value ?? "?"}`);
      // The step count is incremented as soon as a step returns, so a run that ends by
      // breaking out of the loop (finished program, stop request) still reports the
      // step it just made.
      while (steps < limit && debugId.value !== null) {
        const result = await publicControl("step_over");
        steps += 1;
        status.value = result;
        terminated.value = result.terminated === true;
        const line = statusLine(result);
        if (line !== null) hits.set(line, (hits.get(line) ?? 0) + 1);
        if (result.terminated === true || traceStopRequested) break;
      }
      truncated = steps >= limit && terminated.value !== true;
      traceResult.value = {
        lines: [...hits.entries()].map(([line, count]) => ({ line, hits: count })).sort((left, right) => left.line - right.line),
        steps,
        durationMs: Date.now() - began,
        truncated,
      };
      traceReference = reference;
      pushHistory(truncated ? "WARN" : "INFO", `trace: ${steps} step(s) over ${traceResult.value.lines.length} line(s) in ${traceResult.value.durationMs}ms` + (truncated ? ` (stopped at the ${limit}-step cap; the program has not finished)` : ""));
      return traceResult.value;
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `trace failed: ${String(caught)}`);
      throw caught;
    } finally {
      traceRunning.value = false;
    }
  }

  /** Asks the running trace to stop after the current step. */
  function stopTrace() {
    if (!traceRunning.value) return;
    traceStopRequested = true;
    pushHistory("INFO", "trace: stop requested (finishes the current step)");
  }

  /** Forgets the last trace run (a new session or a restart starts clean). */
  function clearTrace() {
    traceResult.value = null;
    traceReference = null;
  }

  const resume = () => continueWith(() => publicControl("resume"), "resume", true);
  /** Runs the debuggee to completion, ignoring every remaining breakpoint. */
  const resumeIgnoreBreakpoints = () => continueWith(() => publicControl("run_to_end"), "resume (ignore breakpoints)", true);
  const stepOver = () => continueWith(() => publicControl("step_over"), "step over");
  const stepIn = () => continueWith(() => publicControl("step_in"), "step in");
  const stepOut = () => continueWith(() => publicControl("step_out"), "step out");
  const abort = () => continueWith(() => publicControl("abort"), "abort");
  const restart = () => continueWith(() => publicControl("restart"), "restart");

  async function refreshVariables(frame = currentFrame.value) {
    if (!debugId.value) return;
    const serial = readSerial;
    if (frame === currentFrame.value) variablesState.value = "loading";
    try {
      const result = await readPublic("variables", { frame });
      if (Array.isArray(result) || !Array.isArray(result.variables)) throw new Error("The variable response has no confirmed variable list");
      const decoded = result.variables.map(decodeVariable);
      variables.value = decoded.filter((entry): entry is PlDebugVariable => entry !== null);
      const incomplete = result.variablesComplete === false || decoded.some((entry) => entry === null);
      variablesState.value = incomplete ? "error" : "ready";
      variableError.value = typeof result.variablesError === "string" && result.variablesError ? result.variablesError : incomplete ? "Some variable entries could not be read" : null;
    } catch (caught) {
      if (serial === readSerial && frame === currentFrame.value) {
        variableError.value = String(caught);
        variablesState.value = "error";
      }
      throw caught;
    } finally {
      if (serial === readSerial && frame === currentFrame.value) await refreshWatches(frame);
    }
  }

  function addWatch(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = (entry: string) => (entry.includes('"') ? entry : entry.toUpperCase());
    if (watchNames.value.some((entry) => key(entry) === key(trimmed))) return;
    watchNames.value.push(trimmed);
    pushHistory("INFO", `watch +${trimmed}`);
  }

  async function refreshWatches(frame = currentFrame.value) {
    const serial = readSerial;
    for (const name of watchNames.value.slice()) {
      if (serial !== readSerial || frame !== currentFrame.value) return;
      try {
        const result = await readPublic("value", { name, frame });
        const variable = decodeVariable(Array.isArray(result) ? null : result.variable);
        if (!variable) throw new Error("The watch response has no readable variable");
        if (watchNames.value.includes(name)) watchValues.value[name] = variable;
      } catch (caught) {
        if (serial !== readSerial || frame !== currentFrame.value) return;
        if (watchNames.value.includes(name)) watchValues.value[name] = { name, state: "error", value: null, message: String(caught) };
      }
    }
  }

  /** Removes one row of the watch window. */
  function removeWatch(name: string) {
    const next = watchNames.value.filter((entry) => entry !== name);
    if (next.length === watchNames.value.length) return;
    watchNames.value = next;
    delete watchValues.value[name];
    pushHistory("INFO", `watch -${name}`);
  }

  /**
   * Assigns a value through the existing SET_VALUE channel and re-reads the frame,
   * exactly like editing a variable row: the watch window is a second view on the
   * same primitive, not a second implementation of it.
   */
  async function setWatchValue(name: string, value: string, frame = currentFrame.value, context?: PlDebugValueContext) {
    return setValue(name, frame, 0, value, context);
  }

  /**
   * Shows another object's source in the debug source editor (cross-object step-in).
   * The caller has already loaded it; `error` carries the backend's text when it
   * could not be loaded, so the editor can show that instead of an empty document.
   */
  function showFrameSource(view: PlDebugFrameSourceView) {
    frameSourceView.value = view;
    pushHistory("INFO", `frame ${view.frameIndex} source: ${view.owner}.${view.name}${view.error ? ` (${view.error})` : ""}`);
  }

  /** Returns the source editor to the debug target. */
  function clearFrameSourceView() {
    frameSourceView.value = null;
  }

  async function refreshStack() {
    if (!debugId.value) return;
    const serial = readSerial;
    const request = ++stackReadSerial;
    try {
      const result = await readPublic("stack");
      if (request !== stackReadSerial) return;
      if (Array.isArray(result) || !Array.isArray(result.frames) || result.frames.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("The stack response has no confirmed frame list");
      invalidateFrameSource(status.value?.frames, result.frames as PlDebugFrame[]);
      if (status.value) status.value = { ...status.value, frames: result.frames as PlDebugFrame[], ...(typeof result.frameMappingState === "string" ? { frameMappingState: result.frameMappingState } : {}) };
      backtrace.value = typeof result.backtrace === "string" ? result.backtrace : "";
      stackError.value =
        [result.structuredBacktraceError, result.textBacktraceError, result.sourceError]
          .map((error) => {
            if (typeof error === "string") return error;
            if (!error || typeof error !== "object" || Array.isArray(error)) return null;
            const detail = error as Record<string, unknown>;
            return [detail.message, detail.sqlState, detail.vendorCode].filter((value) => typeof value === "string" || typeof value === "number").join(" · ") || null;
          })
          .filter(Boolean)
          .join("\n") || null;
    } catch (caught) {
      if (serial === readSerial && request === stackReadSerial) {
        if (status.value) status.value = { ...status.value, frames: undefined };
        backtrace.value = "";
        frameSourceView.value = null;
        stackError.value = String(caught);
      }
      throw caught;
    }
  }

  function invalidateFrameSource(previous: PlDebugFrame[] | undefined, next: PlDebugFrame[] | undefined) {
    const view = frameSourceView.value;
    if (!view) return;
    const before = previous?.[view.frameIndex];
    const after = next?.[view.frameIndex];
    if (!before || !after || before.nativeFrameId !== after.nativeFrameId || before.sourceRef?.id !== after.sourceRef?.id || before.sourceRef?.sourceRevision !== after.sourceRef?.sourceRevision || before.sourceRef?.source !== after.sourceRef?.source || after.sourceState !== "resolved")
      frameSourceView.value = null;
  }

  /** Selects the inspected stack frame (0 = innermost) and reloads its variables. */
  async function selectFrame(frame: number) {
    readSerial += 1;
    variables.value = [];
    variablesState.value = "unread";
    variableError.value = null;
    watchValues.value = {};
    frameSourceView.value = null;
    currentFrame.value = Number.isFinite(frame) && frame >= 0 ? Math.trunc(frame) : 0;
    await refreshVariables(currentFrame.value);
  }

  /**
   * Runs one statement in the DEBUGGEE's session (DBMS_DEBUG.EXECUTE) and records the
   * answer. This is the debug console PL/SQL Developer has: the statement sees the
   * debuggee's uncommitted rows and its package state, which no other connection can
   * see while the program is parked. The server rejects the call when the debuggee is
   * not parked -- that answer is recorded as a warning, not thrown away.
   */
  async function executeInDebuggee(sql: string, maxRows = 0): Promise<PlDebugExecuteResult> {
    if (!debugId.value) throw new Error("no debug session");
    if (!sql.trim()) throw new Error("the statement is empty");
    busy.value = true;
    error.value = null;
    try {
      const receipt = await runPublicOperation("execute", { sql, maxRows });
      const result = receipt.result && typeof receipt.result === "object" && !Array.isArray(receipt.result) ? (receipt.result as PlDebugExecuteResult) : null;
      if (receipt.state !== "succeeded" && !(receipt.state === "failed" && result?.ok === false && Array.isArray(result.rows))) throw new Error(String(receipt.error?.message || `The original SQL operation is ${receipt.state}; query its receipt without repeating it`));
      if (!result) throw new Error("SQL completed but its result could not be read; do not repeat the statement");
      const rows = result.rows ?? [];
      pushHistory(result.ok === false ? "WARN" : "INFO", `debuggee SQL → ${result.ok === false ? "rejected" : `${result.count ?? rows.length} row(s)`}`);
      if (result.ok === false && result.error) pushHistory("WARN", `debuggee SQL: ${result.error}`);
      if (result.resultError) pushHistory("WARN", `debuggee SQL results: ${result.resultError}`);
      return result;
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `debuggee SQL failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  /** DBMS_DEBUG.SET_VALUE: assigns a value, then re-reads the frame it belongs to. */
  function captureValueContext(): PlDebugValueContext {
    const current = publicSnapshot.value;
    if (!sessionRef.value || !current || current.state !== "paused" || current.stopRevision == null || recoveryRequired.value || busy.value) throw new Error("Read values from a confirmed paused debug stop before editing");
    return { ...sessionRef.value, generation: current.generation, stopRevision: current.stopRevision, frame: currentFrame.value, viewSerial: readSerial };
  }

  function valueContextMatches(context: PlDebugValueContext): boolean {
    return (
      sameDebugReference(sessionRef.value, context) &&
      publicSnapshot.value?.generation === context.generation &&
      publicSnapshot.value.stopRevision === context.stopRevision &&
      publicSnapshot.value.state === "paused" &&
      currentFrame.value === context.frame &&
      readSerial === context.viewSerial &&
      !recoveryRequired.value
    );
  }

  async function setValue(name: string, frame: number, index: number, value: string, context?: PlDebugValueContext) {
    if (!debugId.value) throw new Error("no debug session");
    if (context && !valueContextMatches(context)) throw new Error("The edit context changed; preserve the draft and read the current value before editing again");
    const reference = sessionRef.value ? { ...sessionRef.value } : null;
    const generation = publicSnapshot.value?.generation;
    const targetFrame = Number.isFinite(frame) && frame >= 0 ? Math.trunc(frame) : currentFrame.value;
    busy.value = true;
    error.value = null;
    try {
      if (targetFrame !== currentFrame.value) throw new Error("Select the requested frame before changing its value");
      const receipt = await runPublicOperation("set_value", { name, frame: targetFrame, index, value }, context ? () => valueContextMatches(context) : undefined);
      if (receipt.state !== "succeeded" && receipt.state !== "failed") throw new Error(`The original assignment is ${receipt.state}; query its receipt without repeating it`);
      if (receipt.state === "succeeded") pushHistory("INFO", `set ${name} := ${value} (frame ${targetFrame})`);
      // A stop at the routine entry (DBMS_DEBUG `reason_enter`, 6) happens while
      // the declaration section is still running, so an assignment accepted here
      // can be overwritten by the declarations' own initialization (`v_n NUMBER
      // := 0`) and silently never take effect (measured on Oracle 19c). The
      // assignment itself is not blocked or failed; the caveat is recorded so a
      // value that "does not stick" has an explanation on screen.
      //
      if (receipt.state === "succeeded" && Number(status.value?.reason) === REASON_ENTER) {
        pushHistory("WARN", `set ${name}: parked at the routine entry (reason 6), so the new value may be overwritten by the declaration section; if it does not take effect, step once and set the value again`);
      }
      let readError: string | null = null;
      const originalView = () => !!reference && sameDebugReference(sessionRef.value, reference) && publicSnapshot.value?.generation === generation;
      try {
        if (!reference || !originalView()) throw new Error("The original debug view changed; its assignment receipt is retained");
        try {
          await refreshPublicStatus(true, reference);
        } catch (caught) {
          if (originalView()) {
            recoveryRequired.value = true;
            stopHeartbeat();
          }
          throw caught;
        }
        if (!originalView()) throw new Error("The original debug view changed; its assignment receipt is retained");
        const result = await readPublic("value", { name, frame: targetFrame, index });
        const variable = decodeVariable(Array.isArray(result) ? null : result.variable);
        if (!variable) throw new Error("The assignment readback has no readable variable");
        variables.value = [...variables.value.filter((entry) => entry.name !== variable.name), variable];
        if (watchNames.value.includes(name)) watchValues.value[name] = variable;
        if (variable.state === "error" || variable.state === "unknown") throw new Error(variable.message || "The current value is unavailable");
      } catch (caught) {
        readError = String(caught);
        pushHistory("WARN", `${receipt.state === "succeeded" ? "Assignment succeeded" : "Assignment failed"}; value could not be refreshed: ${readError}`);
      }
      if (receipt.state === "failed") {
        const result = receipt.result && typeof receipt.result === "object" ? (receipt.result as Record<string, unknown>) : null;
        throw new Error(String(receipt.error?.message || result?.message || "The native assignment failed; inspect the current value before submitting another operation"));
      }
      return { receipt, readError };
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `set ${name} failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
  }

  async function setExceptionBreakpoint(enabled: boolean) {
    if (!debugId.value) throw new Error("no debug session");
    const reference = sessionRef.value ? { ...sessionRef.value } : null;
    const generation = publicSnapshot.value?.generation;
    const originalView = () => !!reference && sameDebugReference(sessionRef.value, reference) && publicSnapshot.value?.generation === generation;
    busy.value = true;
    error.value = null;
    try {
      if (enabled && exceptionBreakpointUnavailableReason.value) throw new Error(exceptionBreakpointUnavailableReason.value);
      const receipt = await runPublicOperation("set_exception_breakpoint", { enabled });
      if (receipt.state !== "succeeded") throw new Error(String(receipt.error?.message || `The original exception breakpoint operation is ${receipt.state}; query its receipt without repeating it`));
      if (!originalView() || typeof status.value?.exceptionBreakpoint !== "boolean") throw new Error("The exception breakpoint state could not be confirmed; restore the original session without repeating the operation");
      pushHistory("INFO", `exception breakpoints ${exceptionBreakpoint.value ? "on" : "off"}`);
    } catch (caught) {
      if (originalView()) {
        error.value = formatError(caught);
        pushHistory("ERROR", `exception breakpoints failed: ${formatError(caught)}`);
      }
      throw caught;
    } finally {
      if (originalView()) busy.value = false;
    }
  }

  async function refreshLog() {
    if (!sessionRef.value) return;
    const result = await readPublic("log");
    if (Array.isArray(result) || typeof result.output !== "string") throw new Error("The DBMS_OUTPUT response did not contain a valid output buffer");
    output.value = result.output;
    outputStatus.value = { complete: typeof result.outputComplete === "boolean" ? result.outputComplete : null, truncated: typeof result.outputTruncated === "boolean" ? result.outputTruncated : null, error: result.outputError ?? null };
  }

  function close(): Promise<void> {
    if (closingTask) return closingTask;
    closeBusy.value = true;
    const task = Promise.resolve()
      .then(closeOriginal)
      .finally(() => {
        if (closingTask === task) {
          closingTask = null;
          closeBusy.value = false;
        }
      });
    closingTask = task;
    return task;
  }

  async function closeOriginal() {
    if (!sessionRef.value && pendingStart.value) await recover();
    if (!sessionRef.value) return;
    const reference = { ...sessionRef.value };
    const snapshot = await refreshPublicStatus(true);
    const retained = pendingClose.value;
    let operationId = retained?.operationId ?? uuid();
    const currentContext = () => sameDebugReference(sessionRef.value, reference) && publicSnapshot.value?.generation === snapshot.generation;
    const ownsPending = () => pendingClose.value?.operationId === operationId && sameDebugReference(pendingClose.value.reference, reference) && currentContext();
    try {
      if (!retained) {
        readSerial += 1;
        variables.value = [];
        variablesState.value = "unread";
        watchValues.value = {};
        backtrace.value = "";
        frameSourceView.value = null;
        pendingClose.value = { operationId, reference };
        if (status.value) status.value.frames = undefined;
        persistRecovery();
        let accepted: PlDebugReceipt;
        try {
          accepted = await backend.plDebugOperate({ ...reference, operationId, generation: snapshot.generation, expectedRevision: snapshot.revision, action: "close" });
        } catch (caught) {
          if (isAdmissionRejection(caught) && ownsPending()) {
            pendingClose.value = null;
            persistRecovery();
          }
          throw caught;
        }
        if (accepted.serverEpoch !== reference.serverEpoch || accepted.sessionId !== reference.sessionId || accepted.generation !== snapshot.generation || typeof accepted.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(accepted.operationId) || !ownsPending())
          throw new Error("The close response does not belong to the original request");
        if (accepted.operationId !== operationId) {
          operationId = accepted.operationId;
          pendingClose.value = { operationId, reference };
          persistRecovery();
        }
      }
      const receipt = await originalReceipt(reference, operationId);
      if (receipt.generation !== snapshot.generation || !ownsPending()) throw new Error("The close receipt belongs to an old debug context");
      const next = await refreshPublicStatus(true);
      if (!ownsPending()) throw new Error("The close status belongs to an old debug context");
      if (receipt.state === "failed" && !receipt.dispatched) {
        pendingClose.value = null;
        persistRecovery();
        throw new Error(String(receipt.error?.message || "Close was rejected before dispatch"));
      }
      if (receipt.state !== "succeeded" || next.releaseState !== "released" || !next.runtimeExited) throw new Error("The original debug session has not confirmed resource release");
      pendingStart.value = null;
      pendingClose.value = null;
      recoveryRequired.value = next.executionOutcome === "unknown";
      persistRecovery();
      stopHeartbeat();
      error.value = null;
      pushHistory("INFO", `close ${reference.sessionId}`);
    } catch (caught) {
      if (currentContext()) {
        error.value = String(caught);
        pushHistory("WARN", `close result not confirmed: ${String(caught)}`);
      }
      persistRecovery();
      throw caught;
    }
  }

  function reset() {
    if (
      recoveryProjectionRequired.value ||
      pendingStart.value ||
      pendingClose.value ||
      Object.keys(pendingOperations.value).length > 0 ||
      (sessionRef.value && (publicSnapshot.value?.releaseState !== "released" || publicSnapshot.value.runtimeExited !== true || publicSnapshot.value.executionOutcome === "unknown"))
    ) {
      throw new Error("The unresolved debug session must be retained for recovery");
    }
    stopHeartbeat();
    recoverySerial += 1;
    restoring = null;
    cancelSessionDiscovery();
    sessionRef.value = null;
    publicSnapshot.value = null;
    startOperationId.value = null;
    recoveryRequired.value = false;
    persistRecovery();
    debugId.value = null;
    connectionId.value = null;
    database.value = null;
    target.value = null;
    terminated.value = false;
    status.value = null;
    breakpoints.value = [];
    // The local breakpoint properties die with the session that owned them.
    breakpointLocals.value = {};
    variables.value = [];
    variablesState.value = "unread";
    watchValues.value = {};
    backtrace.value = "";
    output.value = "";
    outputStatus.value = null;
    error.value = null;
    currentFrame.value = 0;
    exceptionBreakpoint.value = false;
    // A frame-source view belongs to the stack it came from: a new session starts
    // on its own target.
    frameSourceView.value = null;
    // A collected trace belongs to the run it was taken from.
    traceResult.value = null;
    traceRunning.value = false;
    traceStopRequested = false;
    // `history` and `watchNames` deliberately survive a reset: they are the record
    // of the session and the names the user typed, and neither should be lost when
    // the same routine is debugged again.
  }

  persistRecovery();

  return {
    clientSessionId,
    sessionRef,
    publicSnapshot,
    pendingStart,
    pendingClose,
    compilationRef,
    compilationReceipt,
    compilationBusy,
    compilationUnresolved,
    compileDebug,
    recoverCompilation,
    closeBusy,
    discoverSessions,
    cancelSessionDiscovery,
    adoptDiscoveredSession,
    pendingOperations,
    lastReceipt,
    recoveryRequired,
    recover,
    debugId,
    connectionId,
    database,
    target,
    probe,
    probing,
    busy,
    canRestart,
    terminated,
    status,
    stopSeq,
    breakpoints,
    breakpointLocals,
    variables,
    backtrace,
    output,
    outputStatus,
    error,
    currentFrame,
    exceptionBreakpoint,
    exceptionBreakpointUnavailableReason,
    watchNames,
    frameSourceView,
    history,
    supported,
    currentLine,
    currentProgram,
    hasSession,
    breakpointLines,
    disabledBreakpointLines,
    watches,
    runProbe,
    inspectTarget,
    start,
    applyBreakpoints,
    currentSourceRef,
    canChangeNativeBreakpoints,
    nativeBreakpointLines,
    toggleSourceBreakpoint,
    deleteOwnedBreakpoint,
    setOwnedBreakpointEnabled,
    updateOwnedBreakpointRules,
    toggleBreakpoint,
    setBreakpointEnabled,
    setBreakpointCondition,
    setBreakpointMessage,
    executeInDebuggee,
    traceResult,
    traceRunning,
    startTrace,
    stopTrace,
    clearTrace,
    setBreakpointIgnoreCount,
    refreshBreakpoints,
    resume,
    resumeIgnoreBreakpoints,
    stepOver,
    stepIn,
    stepOut,
    abort,
    restart,
    refreshVariables,
    variablesState,
    variableError,
    refreshWatches,
    stackError,
    refreshStack,
    refreshLog,
    setValue,
    captureValueContext,
    valueContextMatches,
    selectFrame,
    setExceptionBreakpoint,
    addWatch,
    removeWatch,
    setWatchValue,
    showFrameSource,
    clearFrameSourceView,
    pushHistory,
    clearError,
    close,
    reset,
  };
});

/** Upper bound on retained history entries, so a long session cannot grow forever. */
const HISTORY_LIMIT = 500;

/**
 * Upper bound on automatic resumes for one user-visible continue. A wrong
 * condition (or a breakpoint the debuggee keeps re-entering) must never trap
 * the session in an endless resume loop.
 */
const AUTO_CONTINUE_LIMIT = 200;

/**
 * Step cap of one trace run. Every step is a server round trip (measured on 19c EE:
 * about 120ms per line when the run-to-the-end loop used it), so an unbounded trace
 * over a loop could run for minutes with the toolbar busy. 1000 steps is several
 * minutes of budget at that cost and the run can be stopped between steps.
 */
const TRACE_STEP_LIMIT = 1000;

/**
 * DBMS_DEBUG `reason_breakpoint` (3): the debuggee is parked because an armed
 * breakpoint was hit. It is the trigger for a breakpoint's own message.
 */
const REASON_BREAKPOINT = 3;

/**
 * DBMS_DEBUG `reason_enter` (6): the debuggee is parked while entering a
 * program, before its declaration section ran. Assignments made at that stop
 * can be overwritten by the declarations' own initialization, so `setValue`
 * records a caveat when the response carries this reason.
 */
const REASON_ENTER = 6;

/** Verdict of one minimal breakpoint condition. */
type PlDebugConditionVerdict = { kind: "true" } | { kind: "false" } | { kind: "unparseable"; reason: string };

/** Literal on the right-hand side of a minimal condition. */
type PlDebugConditionLiteral = { kind: "number"; value: number } | { kind: "string"; value: string } | { kind: "null" };

const LOCALS_DEFAULT_IGNORE_COUNT = 0;
const LOCALS_DEFAULT_CONDITION = "";
const LOCALS_DEFAULT_MESSAGE = "";

function defaultLocals(): PlDebugBreakpointLocals {
  return {
    enabled: true,
    ignoreCount: LOCALS_DEFAULT_IGNORE_COUNT,
    condition: LOCALS_DEFAULT_CONDITION,
    message: LOCALS_DEFAULT_MESSAGE,
    hits: 0,
  };
}

/** Coerces a stored ignore count to a non-negative integer (default 0). */
function normalizeIgnoreCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : LOCALS_DEFAULT_IGNORE_COUNT;
}

/** The stop line of a status, or null when the agent reported none. */
function statusLine(result: PlDebugStatus | null): number | null {
  const raw = result?.line;
  const parsed = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Evaluates the minimal condition syntax `variable operator literal`
 * (`== != > < >= <=`, literal = number / single-quoted string / NULL).
 *
 * Deliberately narrow: no parentheses, no boolean operators, no function
 * calls. Anything the evaluator does not fully understand is reported as
 * `unparseable`, and the caller stops with a warning rather than guessing.
 */
function evaluateCondition(expression: string, entries: PlDebugVariable[]): PlDebugConditionVerdict {
  const match = /^([A-Za-z_][\w$#]*(?:\.[\w$#]+)?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expression.trim());
  if (!match) return { kind: "unparseable", reason: "expected `variable operator literal`" };
  const [, rawName, operator, rawLiteral] = match;
  const literal = parseConditionLiteral(rawLiteral.trim());
  if (!literal) return { kind: "unparseable", reason: `unsupported literal ${rawLiteral.trim()}` };
  const wanted = rawName.toUpperCase();
  const entry = entries.find((candidate) => candidate.name.toUpperCase() === wanted) ?? entries.find((candidate) => (candidate.name.split(".").pop() ?? "").toUpperCase() === (wanted.split(".").pop() ?? ""));
  if (!entry) return { kind: "unparseable", reason: `variable ${rawName} is not visible in the current frame` };
  if (entry.state !== "value" && entry.state !== "empty" && entry.state !== "null") return { kind: "unparseable", reason: `variable ${rawName} could not be read` };
  const actual = entry.value ?? "";
  if (literal.kind === "null") {
    if (operator === "==") return entry.state === "null" ? { kind: "true" } : { kind: "false" };
    if (operator === "!=") return entry.state === "null" ? { kind: "false" } : { kind: "true" };
    return { kind: "unparseable", reason: `NULL cannot be compared with ${operator}` };
  }
  if (entry.state === "null") return { kind: "unparseable", reason: `variable ${rawName} is NULL` };
  if (literal.kind === "number") {
    const actualNumber = Number(actual);
    if (!Number.isFinite(actualNumber) || actual === "") return { kind: "unparseable", reason: `variable ${rawName} is not numeric` };
    if (!Number.isSafeInteger(actualNumber) || !Number.isSafeInteger(literal.value)) return { kind: "unparseable", reason: "numeric condition requires exact server-side comparison" };
    switch (operator) {
      case "==":
        return actualNumber === literal.value ? { kind: "true" } : { kind: "false" };
      case "!=":
        return actualNumber !== literal.value ? { kind: "true" } : { kind: "false" };
      case ">":
        return actualNumber > literal.value ? { kind: "true" } : { kind: "false" };
      case "<":
        return actualNumber < literal.value ? { kind: "true" } : { kind: "false" };
      case ">=":
        return actualNumber >= literal.value ? { kind: "true" } : { kind: "false" };
      default:
        return actualNumber <= literal.value ? { kind: "true" } : { kind: "false" };
    }
  }
  if (operator === "==") return actual === literal.value ? { kind: "true" } : { kind: "false" };
  if (operator === "!=") return actual !== literal.value ? { kind: "true" } : { kind: "false" };
  return { kind: "unparseable", reason: `operator ${operator} is not supported for a string literal` };
}

/** Parses the literal side: number, `'single quoted'` (with `''` escape) or NULL. */
function parseConditionLiteral(raw: string): PlDebugConditionLiteral | null {
  if (/^null$/i.test(raw)) return { kind: "null" };
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return { kind: "number", value: Number(raw) };
  if (/^'(?:[^']|'')*'$/.test(raw)) return { kind: "string", value: raw.slice(1, -1).replace(/''/g, "'") };
  return null;
}

function decodeVariable(input: unknown): PlDebugVariable | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entry = input as Record<string, unknown>;
  if (typeof entry.name !== "string" || !entry.name) return null;
  const states: PlDebugVariable["state"][] = ["value", "empty", "null", "out_of_scope", "error", "unknown"];
  let state = states.includes(entry.state as PlDebugVariable["state"]) ? (entry.state as PlDebugVariable["state"]) : "unknown";
  if ((state === "value" || state === "empty") && (typeof entry.value !== "string" || (state === "empty" && entry.value !== ""))) state = "unknown";
  return {
    name: entry.name,
    state,
    value: (state === "value" || state === "empty") && typeof entry.value === "string" ? entry.value : null,
    ...(typeof entry.type === "string" || entry.type === null ? { type: entry.type } : {}),
    ...(typeof entry.rawValue === "string" || entry.rawValue === null ? { rawValue: entry.rawValue } : {}),
    ...(typeof entry.nativeResult === "number" || entry.nativeResult === null ? { nativeResult: entry.nativeResult } : {}),
    ...(typeof entry.message === "string" || entry.message === null ? { message: entry.message } : {}),
  };
}

/** Local wall-clock stamp for history entries: `YYYY-MM-DD HH:mm:ss`. */
function historyTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `owner.package.routine` for a start request, or just the object type. */
function describeTarget(request: PlDebugStartRequest): string {
  const name = [request.schema, request.packageName, request.objectName].filter(Boolean).join(".");
  return name ? `${request.objectType} ${name}` : request.objectType;
}

function describeBreakpoints(breakpoints: PlDebugBreakpoint[]): string {
  return breakpoints.map((breakpoint) => `${breakpoint.name ?? "?"}:${breakpoint.line ?? "?"}`).join(", ");
}

function sameBreakpoint(left: PlDebugBreakpoint, right: PlDebugBreakpoint): boolean {
  const leftNumber = left.breakpointNumber;
  const rightNumber = right.breakpointNumber;
  if (leftNumber != null && rightNumber != null) {
    return leftNumber === rightNumber;
  }
  return (left.name ?? "").toUpperCase() === (right.name ?? "").toUpperCase() && left.line === right.line;
}

/**
 * The program name DBMS_DEBUG uses for the debugged object: package members are
 * addressed as `PKG.ROUTINE`, standalone routines by their own name, and an
 * anonymous block has none.
 */
function targetProgramName(target: PlDebugSessionTarget): string {
  if (target.packageName && target.objectName) return `${target.packageName}.${target.objectName}`;
  return target.objectName ?? "";
}

function breakpointLine(breakpoint: PlDebugBreakpoint): number | null {
  const line = breakpoint.line;
  return typeof line === "number" && Number.isFinite(line) && line > 0 ? line : null;
}

/** Whether a stored breakpoint was set on the object the session debugs. */
function breakpointBelongsToTarget(breakpoint: PlDebugBreakpoint, target: PlDebugSessionTarget): boolean {
  const kind = (breakpoint.kind ?? "").toUpperCase();
  if (kind === "ANONYMOUS" || target.objectType.toUpperCase() === "ANONYMOUS") {
    return kind === target.objectType.toUpperCase();
  }
  return (breakpoint.name ?? "").toUpperCase() === targetProgramName(target).toUpperCase();
}

function breakpointForLine(target: PlDebugSessionTarget, lineNum: number): PlDebugBreakpoint {
  return {
    owner: target.schema,
    name: targetProgramName(target) || null,
    line: lineNum,
    kind: target.objectType,
  };
}

export type { PlDebugBreakpoint, PlDebugParam, PlDebugStartRequest };

interface PlDebugPendingStart {
  serverEpoch: string;
  operationId: string;
  connectionId: string;
  database: string;
  clientSessionId: string;
}

interface PlDebugRecovery {
  clientSessionId: string;
  reference: PlDebugSessionRef | null;
  pendingStart: PlDebugPendingStart | null;
  pendingClose: { operationId: string; reference: PlDebugSessionRef } | null;
  startOperationId: string | null;
  pendingOperations?: Record<string, PlDebugPendingOperation>;
  recoveryProjectionRequired?: boolean;
  compilationRef?: PlDebugCompileRef | null;
}

interface PlDebugPendingOperation {
  reference: PlDebugSessionRef;
  generation: number;
  action: PlDebugAction;
}

function pendingInGeneration(operation: PlDebugPendingOperation, generation: number | undefined): boolean {
  return operation.generation === generation || (operation.action === "restart" && operation.generation + 1 === generation);
}

const RECOVERY_KEY = "dbx:pl-debug:recovery:v1";

function isAdmissionRejection(error: unknown): boolean {
  const envelope = normalizeBackendError(error);
  return envelope?.code === "DBX-PLDEBUG-1001" && envelope.operationOutcome === "not_started";
}

function sameDebugReference(left: PlDebugSessionRef | null, right: PlDebugSessionRef): boolean {
  return !!left && left.serverEpoch === right.serverEpoch && left.sessionId === right.sessionId && left.connectionId === right.connectionId && left.clientSessionId === right.clientSessionId;
}

function readDebugRecovery(): PlDebugRecovery | null {
  if (typeof sessionStorage === "undefined") return null;
  const saved = sessionStorage.getItem(RECOVERY_KEY);
  if (!saved) return null;
  const record = JSON.parse(saved) as PlDebugRecovery;
  if (!record || typeof record.clientSessionId !== "string" || !record.clientSessionId) {
    throw new Error("The saved debug recovery identity is invalid; preserve it before starting another execution");
  }
  return record;
}

function writeDebugRecovery(record: PlDebugRecovery) {
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(record));
}
