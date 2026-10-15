import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { findWatchVariable } from "@/lib/debug/plDebugWatch";
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
  plDebugExecute,
  plDebugSetValue,
  plDebugStart,
  plDebugStepIn,
  plDebugStepOut,
  plDebugStepOver,
  type PlDebugBreakpoint,
  type PlDebugExecuteResult,
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
  /** Current value, or null while the name is not in the current scope. */
  value: string | null;
  /** Type reported by the server, or null when the name is out of scope. */
  type: string | null;
  /** Whether the current frame's variable list contains the name at all. */
  inScope: boolean;
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
  const debugId = ref<string | null>(null);
  const connectionId = ref<string | null>(null);
  const database = ref<string | null>(null);
  const target = ref<PlDebugSessionTarget | null>(null);
  const probe = ref<PlDebugProbeResult | null>(null);
  const probing = ref(false);

  const busy = ref(false);
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
  const variables = ref<Array<{ name: string; value: string; type?: string }>>([]);
  const backtrace = ref("");
  const output = ref("");
  const error = ref<string | null>(null);
  /** Stack frame the variables panel inspects; 0 is the innermost (stopped) frame. */
  const currentFrame = ref(0);
  const exceptionBreakpoint = ref(false);
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
  const traceRunning = ref(false);
  /** Set by stopTrace; the run checks it between steps, so it can never wedge the UI. */
  let traceStopRequested = false;
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

  /**
   * The watch window's rows: one per name, resolved against the current frame.
   *
   * `value === null` means the name is not in the current scope (program running,
   * target finished, or the variable belongs to another frame) — the panel renders
   * an explicit placeholder for it instead of an empty cell.
   */
  const watches = computed<PlDebugWatchRow[]>(() =>
    watchNames.value.map((name) => {
      const entry = findWatchVariable(name, variables.value);
      return {
        name,
        value: entry ? entry.value : null,
        type: entry ? (entry.type ?? "") : null,
        inScope: entry !== null,
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
      noteStop();
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
      if (applyStopRules && result.terminated !== true) {
        result = await skipAccordingToRules(label, action, result);
      } else if (result.terminated !== true) {
        // A step can land on a line whose breakpoint carries a message too; a resume
        // that ran the stop rules reports it from inside the rule engine instead, so
        // an auto-resumed hit does not print the message of a line it did not stop on.
        notifyBreakpointMessage(result);
      }
      // Banked only after the stop rules settled, so the panels refresh once for the
      // stop the user finally sees rather than for every auto-resumed hit.
      noteStop();
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
        const result = await plDebugStepOver(debugId.value);
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
      pushHistory(truncated ? "WARN" : "INFO", `trace: ${steps} step(s) over ${traceResult.value.lines.length} line(s) in ${traceResult.value.durationMs}ms` + (truncated ? ` (stopped at the ${limit}-step cap; the program has not finished)` : ""));
      // The trace moved the debuggee's stop position; the panels follow like after any
      // other stop (the trace itself updated `status` per step without banking stops).
      noteStop();
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
    // `*name*type*value` text) into a flat variables array, including the declared
    // type; the watch window renders that type next to the value.
    variables.value = (result.variables ?? []).map((entry) => ({
      name: entry.name,
      value: entry.value ?? "",
      type: entry.type ?? "",
    }));
  }

  /**
   * Adds a name to the watch window. Blank names and names already watched (case
   * insensitively — the same rule `findWatchVariable` matches by) are ignored, so a
   * double click on "Add to watch" cannot produce two identical rows.
   */
  function addWatch(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (watchNames.value.some((entry) => entry.toUpperCase() === trimmed.toUpperCase())) return;
    watchNames.value.push(trimmed);
    pushHistory("INFO", `watch +${trimmed}`);
  }

  /** Removes one row of the watch window. */
  function removeWatch(name: string) {
    const next = watchNames.value.filter((entry) => entry !== name);
    if (next.length === watchNames.value.length) return;
    watchNames.value = next;
    pushHistory("INFO", `watch -${name}`);
  }

  /**
   * Assigns a value through the existing SET_VALUE channel and re-reads the frame,
   * exactly like editing a variable row: the watch window is a second view on the
   * same primitive, not a second implementation of it.
   */
  async function setWatchValue(name: string, value: string, frame = currentFrame.value) {
    await setValue(name, frame, 0, value);
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

  /**
   * Runs one statement in the DEBUGGEE's session (DBMS_DEBUG.EXECUTE) and records the
   * answer. This is the debug console PL/SQL Developer has: the statement sees the
   * debuggee's uncommitted rows and its package state, which no other connection can
   * see while the program is parked. The server rejects the call when the debuggee is
   * not parked -- that answer is recorded as a warning, not thrown away.
   */
  async function executeInDebuggee(sql: string, maxRows = 0): Promise<PlDebugExecuteResult> {
    if (!debugId.value) throw new Error("no debug session");
    const statement = sql.trim();
    if (!statement) throw new Error("the statement is empty");
    busy.value = true;
    error.value = null;
    try {
      const result = await plDebugExecute(debugId.value, statement, maxRows);
      const rows = result.rows ?? [];
      pushHistory(result.ok === false ? "WARN" : "INFO", `debuggee SQL → ${result.ok === false ? "rejected" : `${result.count ?? rows.length} row(s)`}`);
      if (result.ok === false && result.error) pushHistory("WARN", `debuggee SQL: ${result.error}`);
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
  async function setValue(name: string, frame: number, index: number, value: string) {
    if (!debugId.value) throw new Error("no debug session");
    const targetFrame = Number.isFinite(frame) && frame >= 0 ? Math.trunc(frame) : currentFrame.value;
    busy.value = true;
    error.value = null;
    try {
      const response = await plDebugSetValue(debugId.value, name, targetFrame, index, value);
      pushHistory("INFO", `set ${name} := ${value} (frame ${targetFrame})`);
      // A stop at the routine entry (DBMS_DEBUG `reason_enter`, 6) happens while
      // the declaration section is still running, so an assignment accepted here
      // can be overwritten by the declarations' own initialization (`v_n NUMBER
      // := 0`) and silently never take effect (measured on Oracle 19c). The
      // assignment itself is not blocked or failed; the caveat is recorded so a
      // value that "does not stick" has an explanation on screen.
      //
      // The reason comes from the response's nested `snapshot`, not from the
      // envelope: SET_VALUE answers `{ok, result, message, assignmentSemicolon,
      // snapshot}` and its top level carries no stop position at all (measured on
      // 19c through the app's own call path).
      if (Number(response.snapshot?.reason) === REASON_ENTER) {
        pushHistory("WARN", `set ${name}: parked at the routine entry (reason 6), so the new value may be overwritten by the declaration section; if it does not take effect, step once and set the value again`);
      }
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
    // The backend always answers with an object; an empty answer is treated as "no output
    // yet" instead of a crash, so a caller that reads the log automatically (the
    // program-finished hook in continueWith) cannot turn a transport hiccup into a
    // TypeError.
    const result = (await plDebugGetLog(debugId.value)) ?? {};
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
    stopSeq,
    breakpoints,
    breakpointLocals,
    variables,
    backtrace,
    output,
    error,
    currentFrame,
    exceptionBreakpoint,
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
    start,
    applyBreakpoints,
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
    refreshVariables,
    refreshStack,
    refreshLog,
    setValue,
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
