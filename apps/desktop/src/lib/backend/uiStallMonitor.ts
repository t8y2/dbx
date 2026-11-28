// UI stall detection for the debug log.
//
// Chromium reports main-thread stalls through the Long Tasks API, but WebKit
// (WKWebView on macOS, WebKitGTK on Linux) does not implement it: the
// `longtask` entry type is missing from `PerformanceObserver.supportedEntryTypes`
// and `observe({ entryTypes: ["longtask"] })` is accepted without ever firing.
// On those engines a stall shows up as a timer that fires late, so the monitor
// measures that drift instead. It also keeps the last few input events, which
// is the only available hint for what the user was doing when the thread froze.

export const UI_STALL_CHECK_INTERVAL_MS = 100;
/** Idle poll that only notices when logging gets switched on. */
export const UI_STALL_IDLE_INTERVAL_MS = 2000;
/** Same threshold the Long Tasks logger uses. */
export const UI_STALL_THRESHOLD_MS = 250;
/** A larger gap is system sleep or timer throttling, not a frozen page. */
export const UI_STALL_SUSPEND_GAP_MS = 30_000;

const MAX_RECENT_INPUTS = 5;
const INPUT_WINDOW_SLACK_MS = 1000;
const MAX_TARGET_LENGTH = 120;
const MAX_TARGET_CLASSES = 2;
const MAX_ANCESTOR_DEPTH = 6;

export interface UiStallInput {
  type: string;
  /** How long before the late timer fired the input was handled. */
  msBeforeTick: number;
  target: string;
}

export interface UiStallReport {
  source: "timer-drift";
  lagMs: number;
  visibility: string;
  hasFocus: boolean;
  recentInputs: UiStallInput[];
}

/** True when the engine really delivers `longtask` entries. */
export function supportsLongTaskEntries(observer: { supportedEntryTypes?: readonly string[] } | undefined = typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver): boolean {
  return observer?.supportedEntryTypes?.includes("longtask") === true;
}

export interface UiStallDetectorOptions {
  thresholdMs: number;
  suspendGapMs: number;
  now: () => number;
  isVisible: () => boolean;
  onStall: (lagMs: number, tickAt: number) => void;
}

export interface UiStallDetector {
  /** Called by the timer loop; `expectedMs` is the delay it asked for. */
  tick: (expectedMs: number) => void;
  /** Forget the baseline, e.g. when the loop was not measuring. */
  reset: () => void;
  /** The page was hidden or shown: the next gap is not a stall. */
  markInterrupted: () => void;
}

export function createUiStallDetector(options: UiStallDetectorOptions): UiStallDetector {
  let last = options.now();
  let interrupted = false;
  return {
    tick(expectedMs) {
      const at = options.now();
      const lag = at - last - expectedMs;
      last = at;
      if (interrupted || !options.isVisible()) {
        // Hidden pages get throttled timers; skip until a full visible tick passed.
        interrupted = !options.isVisible();
        return;
      }
      if (lag >= options.thresholdMs && lag < options.suspendGapMs) options.onStall(lag, at);
    },
    reset() {
      last = options.now();
      interrupted = false;
    },
    markInterrupted() {
      interrupted = true;
    },
  };
}

interface RecordedInput {
  type: string;
  at: number;
  target: EventTarget | null;
}

/**
 * Compact, text-free description of an event target. It deliberately never reads
 * `textContent`: that is expensive on a large editor and could carry user data.
 */
export function describeInputTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "unknown";
  let element: Element | null = target;
  let hint: Element = target;
  for (let depth = 0; element && depth < MAX_ANCESTOR_DEPTH; depth++, element = element.parentElement) {
    if (element.getAttribute("data-debug-id") || element.getAttribute("data-testid") || element.getAttribute("role") || element.id || element.classList.contains("cm-editor")) {
      hint = element;
      break;
    }
  }
  const parts: string[] = [hint.tagName.toLowerCase()];
  if (hint.id) parts.push(`#${hint.id}`);
  for (const className of Array.from(hint.classList).slice(0, MAX_TARGET_CLASSES)) parts.push(`.${className}`);
  const role = hint.getAttribute("role");
  if (role) parts.push(`[role=${role}]`);
  const marker = hint.getAttribute("data-debug-id") || hint.getAttribute("data-testid");
  if (marker) parts.push(`[${hint.getAttribute("data-debug-id") ? "debug-id" : "testid"}=${marker}]`);
  if (hint !== target) parts.push(` (from ${target.tagName.toLowerCase()})`);
  const text = parts.join("");
  return text.length > MAX_TARGET_LENGTH ? `${text.slice(0, MAX_TARGET_LENGTH)}...` : text;
}

export interface UiStallMonitorDeps {
  isEnabled: () => boolean;
  onStall: (report: UiStallReport) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  doc?: Document;
}

/**
 * Starts the timer-drift monitor and returns a disposer. While logging is off
 * the loop only wakes every couple of seconds to see whether it was switched on.
 */
export function installUiStallMonitor(deps: UiStallMonitorDeps): () => void {
  const doc = deps.doc ?? (typeof document === "undefined" ? undefined : document);
  if (!doc) return () => {};
  const now = deps.now ?? (() => performance.now());
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const inputs: RecordedInput[] = [];

  const detector = createUiStallDetector({
    thresholdMs: UI_STALL_THRESHOLD_MS,
    suspendGapMs: UI_STALL_SUSPEND_GAP_MS,
    now,
    isVisible: () => doc.visibilityState !== "hidden",
    onStall(lagMs, tickAt) {
      const since = tickAt - lagMs - INPUT_WINDOW_SLACK_MS;
      deps.onStall({
        source: "timer-drift",
        lagMs: Math.round(lagMs),
        visibility: doc.visibilityState,
        hasFocus: typeof doc.hasFocus === "function" ? doc.hasFocus() : false,
        recentInputs: inputs.filter((input) => input.at >= since).map((input) => ({ type: input.type, msBeforeTick: Math.round(tickAt - input.at), target: describeInputTarget(input.target) })),
      });
    },
  });

  const record = (event: Event) => {
    inputs.push({ type: event.type, at: now(), target: event.target });
    if (inputs.length > MAX_RECENT_INPUTS) inputs.shift();
  };
  const inputEvents = ["pointerdown", "keydown", "wheel"] as const;
  for (const type of inputEvents) doc.addEventListener(type, record, { capture: true, passive: true });
  const interrupt = () => detector.markInterrupted();
  doc.addEventListener("visibilitychange", interrupt);

  let wasActive = false;
  let handle: unknown;
  const loop = () => {
    const active = deps.isEnabled();
    if (active && wasActive) detector.tick(UI_STALL_CHECK_INTERVAL_MS);
    else detector.reset();
    wasActive = active;
    handle = setTimer(loop, active ? UI_STALL_CHECK_INTERVAL_MS : UI_STALL_IDLE_INTERVAL_MS);
  };
  handle = setTimer(loop, UI_STALL_IDLE_INTERVAL_MS);

  return () => {
    clearTimer(handle);
    for (const type of inputEvents) doc.removeEventListener(type, record, { capture: true });
    doc.removeEventListener("visibilitychange", interrupt);
  };
}
