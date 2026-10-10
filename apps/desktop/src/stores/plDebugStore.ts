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
  plDebugResumeIgnoreBreakpoints,
  plDebugSetBreakpointEnabled,
  plDebugSetBreakpoints,
  plDebugSetExceptionBreakpoint,
  plDebugSetValue,
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
 * DBMS_DEBUG knows only program and line, so enablement, the ignore count and
 * the stop condition live in the store, keyed by line, and are merged back onto
 * the server's breakpoint list on every refresh. They must never be sent to the
 * agent as breakpoint fields.
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
}

/** A server breakpoint carrying the optional frontend-only properties. */
export interface PlDebugLocalBreakpoint extends PlDebugBreakpoint {
  enabled?: boolean;
  ignoreCount?: number;
  condition?: string;
  hits?: number;
}

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
  const target = ref<PlDebugSessionTarget | null>(null);
  const probe = ref<PlDebugProbeResult | null>(null);
  const probing = ref(false);

  const busy = ref(false);
  const terminated = ref(false);
  const status = ref<PlDebugStatus | null>(null);
  const breakpoints = ref<PlDebugLocalBreakpoint[]>([]);
  /**
   * Local (frontend-only) breakpoint properties, keyed by line. The server
   * never stores them: disabling a breakpoint keeps its entry here for a later
   * re-enable — either on a breakpoint the server disabled in place, or on one
   * the fallback removed server-side.
   */
  const breakpointLocals = ref<Record<number, PlDebugBreakpointLocals>>({});
  const variables = ref<Array<{ name: string; value: string }>>([]);
  const backtrace = ref("");
  const output = ref("");
  const error = ref<string | null>(null);
  /** Stack frame the variables panel inspects; 0 is the innermost (stopped) frame. */
  const currentFrame = ref(0);
  const exceptionBreakpoint = ref(false);
  /** Session history (start / continue / step / breakpoints / failures), oldest first. */
  const history = ref<PlDebugHistoryEntry[]>([]);

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

  /** Local properties of a line, with defaults for anything never configured. */
  function readLocals(line: number): PlDebugBreakpointLocals | null {
    const stored = breakpointLocals.value[line];
    if (!stored) return null;
    return {
      enabled: stored.enabled !== false,
      ignoreCount: normalizeIgnoreCount(stored.ignoreCount),
      condition: typeof stored.condition === "string" ? stored.condition : "",
      hits: Number.isFinite(stored.hits) ? stored.hits : 0,
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

  /**
   * Merges a response's stop position into `status`.
   *
   * The position arrives with both the variables and the stack response, so a
   * wholesale replace or a partial write both leave the editor highlight one
   * stop behind the panels. Response wins, a missing field keeps the old value:
   * the current line and the status always advance in the same frame.
   */
  function mergeStatusLocator(result: PlDebugStatus) {
    const previous = status.value;
    status.value = {
      ...previous,
      ...result,
      line: result.line ?? previous?.line ?? null,
      program: result.program ?? previous?.program ?? null,
    };
    if (result.terminated === true) terminated.value = true;
  }

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
      target.value = {
        schema: request.schema ?? null,
        objectType: request.objectType,
        objectName: request.objectName ?? null,
        packageName: request.packageName ?? null,
        source: request.source ?? null,
      };
      terminated.value = result.terminated === true;
      status.value = result;
      breakpoints.value = [];
      variables.value = [];
      backtrace.value = "";
      output.value = "";
      currentFrame.value = 0;
      pushHistory("INFO", `start ${describeTarget(request)}`);
      return result;
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `start failed: ${String(caught)}`);
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
    if (!current || !hasSession.value) return;
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
    if (!current || !hasSession.value) return;
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

  /** Sets how many hits the breakpoint on `lineNum` ignores before stopping (frontend-only). */
  function setBreakpointIgnoreCount(lineNum: number, ignoreCount: number) {
    const locals = ensureLocals(lineNum);
    locals.ignoreCount = normalizeIgnoreCount(ignoreCount);
    locals.hits = 0;
  }

  async function refreshBreakpoints() {
    if (!debugId.value) return;
    breakpoints.value = (await plDebugListBreakpoints(debugId.value)).map(withLocals);
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
      if (applyStopRules && result.terminated !== true) {
        result = await skipAccordingToRules(label, action, result);
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

  const resume = () => continueWith(plDebugResume, "resume", true);
  /** Runs the debuggee to completion, ignoring every remaining breakpoint. */
  const resumeIgnoreBreakpoints = () => continueWith(plDebugResumeIgnoreBreakpoints, "resume (ignore breakpoints)", true);
  const stepOver = () => continueWith(plDebugStepOver, "step over");
  const stepIn = () => continueWith(plDebugStepIn, "step in");
  const stepOut = () => continueWith(plDebugStepOut, "step out");
  const abort = () => continueWith(plDebugAbort, "abort");

  async function refreshVariables(frame = currentFrame.value) {
    if (!debugId.value) return;
    const result = await plDebugGetVariables(debugId.value, frame);
    mergeStatusLocator(result);
    // The backend normalizes both GET_VALUES shapes (OceanBase JSON, Oracle
    // `*name*type*value` text) into a flat variables array.
    variables.value = (result.variables ?? []).map((entry) => ({
      name: entry.name,
      value: entry.value ?? "",
    }));
  }

  /**
   * Refreshes the backtrace and, with it, the current stop position.
   *
   * `pl_debug_get_stack` answers with `line` / `program` as well: the agent
   * parses the backtrace listing into its own position before snapshotting
   * (`applyBacktraceListing` then `snapshot`). Ignoring those two fields is
   * what left the editor highlight a stop behind the panels.
   */
  async function refreshStack() {
    if (!debugId.value) return;
    const result = await plDebugGetStack(debugId.value);
    backtrace.value = result.backtrace ?? "";
    mergeStatusLocator(result);
  }

  /** Selects the inspected stack frame (0 = innermost) and reloads its variables. */
  async function selectFrame(frame: number) {
    currentFrame.value = Number.isFinite(frame) && frame >= 0 ? Math.trunc(frame) : 0;
    await refreshVariables(currentFrame.value);
  }

  /** DBMS_DEBUG.SET_VALUE: assigns a value, then re-reads the frame it belongs to. */
  async function setValue(name: string, frame: number, index: number, value: string) {
    if (!debugId.value) throw new Error("no debug session");
    const targetFrame = Number.isFinite(frame) && frame >= 0 ? Math.trunc(frame) : currentFrame.value;
    busy.value = true;
    error.value = null;
    try {
      await plDebugSetValue(debugId.value, name, targetFrame, index, value);
      pushHistory("INFO", `set ${name} := ${value} (frame ${targetFrame})`);
      await refreshVariables(targetFrame);
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
    busy.value = true;
    error.value = null;
    try {
      await plDebugSetExceptionBreakpoint(debugId.value, enabled);
      exceptionBreakpoint.value = enabled;
      pushHistory("INFO", `exception breakpoints ${enabled ? "on" : "off"}`);
    } catch (caught) {
      error.value = String(caught);
      pushHistory("ERROR", `exception breakpoints failed: ${String(caught)}`);
      throw caught;
    } finally {
      busy.value = false;
    }
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
      pushHistory("INFO", `close ${closingId}`);
    } catch (caught) {
      // Close is best effort: the agent also reaps expired sessions.
      pushHistory("WARN", `close failed (agent reaps expired sessions): ${String(caught)}`);
    } finally {
      reset();
    }
  }

  function reset() {
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
    backtrace.value = "";
    output.value = "";
    error.value = null;
    currentFrame.value = 0;
    exceptionBreakpoint.value = false;
    // `history` deliberately survives a reset: it is the record of the session.
  }

  return {
    debugId,
    connectionId,
    database,
    target,
    probe,
    probing,
    busy,
    terminated,
    status,
    breakpoints,
    breakpointLocals,
    variables,
    backtrace,
    output,
    error,
    currentFrame,
    exceptionBreakpoint,
    history,
    supported,
    currentLine,
    currentProgram,
    hasSession,
    breakpointLines,
    disabledBreakpointLines,
    runProbe,
    start,
    applyBreakpoints,
    toggleBreakpoint,
    setBreakpointEnabled,
    setBreakpointCondition,
    setBreakpointIgnoreCount,
    refreshBreakpoints,
    resume,
    resumeIgnoreBreakpoints,
    stepOver,
    stepIn,
    stepOut,
    abort,
    refreshVariables,
    refreshStack,
    refreshLog,
    setValue,
    selectFrame,
    setExceptionBreakpoint,
    pushHistory,
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

/** Verdict of one minimal breakpoint condition. */
type PlDebugConditionVerdict = { kind: "true" } | { kind: "false" } | { kind: "unparseable"; reason: string };

/** Literal on the right-hand side of a minimal condition. */
type PlDebugConditionLiteral = { kind: "number"; value: number } | { kind: "string"; value: string } | { kind: "null" };

const LOCALS_DEFAULT_IGNORE_COUNT = 0;
const LOCALS_DEFAULT_CONDITION = "";

function defaultLocals(): PlDebugBreakpointLocals {
  return { enabled: true, ignoreCount: LOCALS_DEFAULT_IGNORE_COUNT, condition: LOCALS_DEFAULT_CONDITION, hits: 0 };
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
function evaluateCondition(expression: string, entries: Array<{ name: string; value: string }>): PlDebugConditionVerdict {
  const match = /^([A-Za-z_][\w$#]*(?:\.[\w$#]+)?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expression.trim());
  if (!match) return { kind: "unparseable", reason: "expected `variable operator literal`" };
  const [, rawName, operator, rawLiteral] = match;
  const literal = parseConditionLiteral(rawLiteral.trim());
  if (!literal) return { kind: "unparseable", reason: `unsupported literal ${rawLiteral.trim()}` };
  const wanted = rawName.toUpperCase();
  const entry = entries.find((candidate) => candidate.name.toUpperCase() === wanted) ?? entries.find((candidate) => (candidate.name.split(".").pop() ?? "").toUpperCase() === (wanted.split(".").pop() ?? ""));
  if (!entry) return { kind: "unparseable", reason: `variable ${rawName} is not visible in the current frame` };
  const actual = unquote((entry.value ?? "").trim());
  if (literal.kind === "null") {
    if (operator === "==") return isNullText(actual) ? { kind: "true" } : { kind: "false" };
    if (operator === "!=") return isNullText(actual) ? { kind: "false" } : { kind: "true" };
    return { kind: "unparseable", reason: `NULL cannot be compared with ${operator}` };
  }
  if (isNullText(entry.value ?? "")) return { kind: "unparseable", reason: `variable ${rawName} is NULL` };
  if (literal.kind === "number") {
    const actualNumber = Number(actual);
    if (!Number.isFinite(actualNumber) || actual === "") return { kind: "unparseable", reason: `variable ${rawName} is not numeric` };
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

/** Strips one layer of surrounding single quotes from a reported value. */
function unquote(value: string): string {
  return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/** Whether a reported variable value stands for SQL NULL. */
function isNullText(value: string): boolean {
  const trimmed = unquote(value.trim());
  return trimmed === "" || /^null$/i.test(trimmed);
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
