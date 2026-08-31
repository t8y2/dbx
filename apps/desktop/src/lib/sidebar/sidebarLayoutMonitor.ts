/**
 * Sidebar layout monitor — diagnostic instrumentation for the "tree expands and
 * the sidebar scroll viewport gets stuck" class of layout bugs. A typical
 * report from the field: after expanding a Dameng connection the viewport
 * height freezes near 50% of the window and scrolling cannot reach the
 * connections listed below the Dameng subtree.
 *
 * The monitor does not fix anything. It:
 *  - continuously samples the scroll shell geometry (shell/scroller/rows),
 *  - records tree-change and expand/collapse events,
 *  - detects anomaly signatures with hysteresis (3 consecutive samples),
 *  - and produces serializable reports (sample ring + event ring + DOM
 *    ancestor chain) written to the console — which also lands in the
 *    user-facing debug logs whenever debug logging is enabled.
 *
 * Enabling:
 *  - `pnpm dev` builds sample by default.
 *  - Production builds: `window.__dbxSidebarLayoutMonitor.enable()` or set
 *    localStorage["dbx-sidebar-layout-monitor"] = "1" before the sidebar
 *    mounts. Enabling the in-app "debug logs" setting also arms the monitor.
 */

import { isDebugLoggingEnabled } from "@/lib/backend/debugLog";

export const SIDEBAR_LAYOUT_MONITOR_STORAGE_KEY = "dbx-sidebar-layout-monitor";
export const SIDEBAR_LAYOUT_MONITOR_LABEL = "[DBX][sidebar-layout-monitor]";

export const SIDEBAR_LAYOUT_MONITOR_MAX_SAMPLES = 240;
export const SIDEBAR_LAYOUT_MONITOR_MAX_EVENTS = 200;
export const SIDEBAR_LAYOUT_MONITOR_ANOMALY_STREAK = 3;
const SIDEBAR_LAYOUT_MONITOR_SAMPLE_INTERVAL_MS = 1000;
// A gap larger than this between consecutive samples invalidates anomaly
// streaks: the samples are no longer "consecutive" in time.
const SIDEBAR_LAYOUT_MONITOR_STREAK_GAP_MS = 3000;
// Reports embed trimmed history: the full rings stay available on the window
// handle (recentSamples/recentEvents), while snapshots stay copy-paste sized.
export const SIDEBAR_LAYOUT_MONITOR_REPORT_SAMPLES = 60;
export const SIDEBAR_LAYOUT_MONITOR_REPORT_EVENTS = 60;

export type SidebarLayoutAnomalyFlag =
  | "half-height-shell" // shell stuck near ~50% of the window while content overflows
  | "under-scroll" // virtual tree: scrollHeight far below expected itemSize x count -> bottom rows unreachable
  | "rows-clipped" // plain tree: DOM content extends beyond scrollHeight
  | "blank-viewport" // rendered pool ends far above the viewport bottom while more content exists below
  | "bottom-unreachable"; // even at max scrollTop the last rows stay out of view

export interface SidebarExpandedConnectionInfo {
  id: string;
  label: string;
  type: string;
  descendantCount: number;
}

export interface SidebarLayoutMonitorContext {
  flatNodeCount: number;
  useVirtualTree: boolean;
  virtualItemSize: number;
  scrollerEl: HTMLElement | null;
  shellEl: HTMLElement | null;
  rootEl: HTMLElement | null;
  virtualScroller: Record<string, unknown> | null;
  expandedConnections: SidebarExpandedConnectionInfo[];
}

export interface SidebarLayoutSampleScroller {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  computedHeight: string;
  overflowY: string;
  position: string;
}

export interface SidebarLayoutSampleRows {
  renderedRows: number;
  firstTop: number;
  firstBottom: number;
  lastTop: number;
  lastBottom: number;
}

export interface SidebarLayoutSample {
  t: number;
  windowHeight: number;
  rootHeight: number;
  shellHeight: number;
  shellRatioOfRoot: number | null;
  shellRatioOfWindow: number | null;
  flatNodeCount: number;
  scroller: SidebarLayoutSampleScroller;
  virtual: {
    itemSize: number;
    expectedScrollHeight: number;
    renderedRows: number;
    visiblePoolSize: number | null;
    spacers: { start: number; end: number } | null;
    /** Live viewport window reported by the scroller (getScroll()). */
    scrollWindow: { start: number; end: number } | null;
    /** Height of the .connection-tree-content wrapper element. */
    listHeight: number | null;
  } | null;
  rows: SidebarLayoutSampleRows | null;
  sticky: { active: boolean; top: number; height: number; transform: string } | null;
}

export interface SidebarLayoutTreeChangeEvent {
  type: "tree-change";
  t: number;
  prevCount: number;
  count: number;
  expandedConnections: SidebarExpandedConnectionInfo[];
  /** Diagnostics: types/labels of the nodes added since the previous sample (capped). */
  added?: Array<{ type: string; label: string }>;
  /** Diagnostics: schema nodes currently expanded. A schema expanding without a
   * preceding expand-toggle event means the expansion was programmatic. */
  expandedSchemas?: Array<{ id: string; label: string }>;
}

export interface SidebarLayoutExpandToggleEvent {
  type: "expand-toggle";
  t: number;
  nodeId: string;
  label: string;
  nodeType: string;
  expanded: boolean;
}

export type SidebarLayoutMonitorEvent =
  | SidebarLayoutTreeChangeEvent
  | SidebarLayoutExpandToggleEvent
  | { type: "anomaly"; t: number; flags: SidebarLayoutAnomalyFlag[]; sample: SidebarLayoutSample; digest: string }
  | { type: "settle"; t: number; flags: SidebarLayoutAnomalyFlag[] }
  | { type: "scroll-bottom"; t: number; atBottom: boolean; scrollTop: number; maxScrollTop: number };

export type SidebarLayoutMonitorEventInput = Omit<SidebarLayoutTreeChangeEvent, "t"> | Omit<SidebarLayoutExpandToggleEvent, "t">;

export interface SidebarLayoutAncestorInfo {
  tag: string;
  className: string;
  id: string;
  height: number;
  computed: {
    height: string;
    minHeight: string;
    flexGrow: string;
    flexShrink: string;
    flexBasis: string;
    overflowY: string;
    position: string;
    display: string;
    paddingTop: string;
    paddingBottom: string;
    borderTop: string;
    borderBottom: string;
  };
}

export interface SidebarLayoutReport {
  id: string;
  t: number;
  flags: SidebarLayoutAnomalyFlag[];
  sample: SidebarLayoutSample;
  transition: {
    shellHeightBefore: number | null;
    shellHeightAfter: number;
    rootHeightBefore: number | null;
    rootHeightAfter: number;
    treeCountBefore: number | null;
    treeCountAfter: number;
    changedWithinSamples: number;
  } | null;
  ancestors: SidebarLayoutAncestorInfo[];
  content: {
    list: { height: number; scrollHeight: number; rectHeight: number; overflowY: string; position: string; display: string } | null;
    sticky: { active: boolean; top: number; height: number; rectHeight: number; transform: string } | null;
  } | null;
  internals: {
    visiblePoolSize: number | null;
    startSpacerSize: number | null;
    endSpacerSize: number | null;
    scrollWindow: unknown;
  } | null;
  expandedConnections: SidebarExpandedConnectionInfo[];
  sampleHistory: SidebarLayoutSample[];
  events: SidebarLayoutMonitorEvent[];
  digest: string;
}

export interface SidebarLayoutMonitorState {
  enabled: boolean;
  startedAt: number | null;
  sampleCount: number;
  activeFlags: SidebarLayoutAnomalyFlag[];
  activations: Partial<Record<SidebarLayoutAnomalyFlag, number>>;
  lastReport: SidebarLayoutReport | null;
  lastSample: SidebarLayoutSample | null;
}

export interface SidebarLayoutMonitorOptions {
  readContext: () => SidebarLayoutMonitorContext;
  /** Logs every sample and event at console.debug level. */
  verbose?: boolean;
  intervalMs?: number;
}

export interface SidebarLayoutMonitor {
  start(): void;
  stop(): void;
  dispose(): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  recordEvent(event: SidebarLayoutMonitorEventInput): void;
  snapshotNow(): SidebarLayoutReport;
  getState(): SidebarLayoutMonitorState;
}

export interface SidebarLayoutMonitorDebugHandle {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  setVerbose(verbose: boolean): void;
  snapshot(): SidebarLayoutReport;
  state(): SidebarLayoutMonitorState;
  recentSamples(count?: number): SidebarLayoutSample[];
  recentEvents(count?: number): SidebarLayoutMonitorEvent[];
}

export function isSidebarLayoutMonitorRequested(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem(SIDEBAR_LAYOUT_MONITOR_STORAGE_KEY) === "1" || isDebugLoggingEnabled();
  } catch {
    return false;
  }
}

export function ringPush<T>(ring: readonly T[], entry: T, maxSize: number): T[] {
  const next = ring.length >= maxSize ? ring.slice(ring.length - maxSize + 1) : [...ring];
  next.push(entry);
  return next;
}

function ratioOrNull(value: number, total: number): number | null {
  return total > 0 ? value / total : null;
}

function rounded(value: number): number {
  return Math.round(value);
}

function elementGeometry(element: HTMLElement | null): { height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { height: rounded(rect.height) };
}

function scrollerMetrics(element: HTMLElement | null): SidebarLayoutSampleScroller {
  if (!element) {
    return { clientHeight: 0, scrollHeight: 0, scrollTop: 0, computedHeight: "n/a", overflowY: "n/a", position: "n/a" };
  }
  const style = window.getComputedStyle(element);
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    computedHeight: style.height,
    overflowY: style.overflowY,
    position: style.position,
  };
}

function captureRows(scrollerEl: HTMLElement | null, virtual: boolean): SidebarLayoutSampleRows | null {
  if (!scrollerEl) return null;
  const selector = virtual ? ".vue-recycle-scroller__item-view" : ".connection-tree-content > *";
  const elements = Array.from(scrollerEl.querySelectorAll<HTMLElement>(selector));
  if (elements.length === 0) return null;

  if (!virtual) {
    // Plain tree: rows are in normal flow, so offsetTop is relative to the
    // content wrapper and reflects the true scroll position.
    const visible = elements.filter((element) => element.offsetHeight > 0);
    if (visible.length === 0) return null;
    const first = visible[0];
    const last = visible[visible.length - 1];
    return {
      renderedRows: visible.length,
      firstTop: first.offsetTop,
      firstBottom: first.offsetTop + first.offsetHeight,
      lastTop: last.offsetTop,
      lastBottom: last.offsetTop + last.offsetHeight,
    };
  }

  // Virtual (transform) tree: item-views are absolutely positioned with
  // translateY, so offsetTop is always 0 and ignores the scroll position.
  // Measure via getBoundingClientRect (transform-aware) relative to the
  // scroller viewport, and skip the recycled views parked far above
  // (hiddenPosition = -999999). Rows are viewport-relative here.
  const scrollerRect = scrollerEl.getBoundingClientRect();
  const scrollerTop = scrollerRect.top;
  const scrollerHeight = scrollerRect.height;
  let renderedRows = 0;
  let firstTop = Number.POSITIVE_INFINITY;
  let firstBottom = 0;
  let lastTop = 0;
  let lastBottom = 0;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const top = rect.top - scrollerTop;
    if (top < -scrollerHeight) continue;
    renderedRows += 1;
    const bottom = top + rect.height;
    if (top < firstTop) {
      firstTop = top;
      firstBottom = bottom;
    }
    if (bottom > lastBottom) {
      lastTop = top;
      lastBottom = bottom;
    }
  }
  if (renderedRows === 0) return null;
  return { renderedRows, firstTop: Math.round(firstTop), firstBottom: Math.round(firstBottom), lastTop: Math.round(lastTop), lastBottom: Math.round(lastBottom) };
}

function captureSticky(scrollerEl: HTMLElement | null): SidebarLayoutSample["sticky"] {
  const header = scrollerEl?.querySelector<HTMLElement>(".sticky-database-header") ?? null;
  if (!header || header.clientHeight === 0) return null;
  const style = window.getComputedStyle(header);
  return {
    active: true,
    top: rounded(header.getBoundingClientRect().top),
    height: header.clientHeight,
    transform: style.transform,
  };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function captureVirtualInternals(virtualScroller: Record<string, unknown> | null) {
  if (!virtualScroller) return null;
  const visiblePool = virtualScroller["visiblePool"];
  let scrollWindow: unknown = null;
  const getScroll = virtualScroller["getScroll"];
  if (typeof getScroll === "function") {
    try {
      const result = (getScroll as () => unknown)();
      if (typeof result === "object" && result !== null) scrollWindow = result;
    } catch {
      // Reading scroller internals must never break the app.
    }
  }
  const scrollWindowNumbers = (() => {
    if (typeof scrollWindow !== "object" || scrollWindow === null) return null;
    const candidate = scrollWindow as Record<string, unknown>;
    return asFiniteNumber(candidate["start"]) != null && asFiniteNumber(candidate["end"]) != null ? { start: asFiniteNumber(candidate["start"]) as number, end: asFiniteNumber(candidate["end"]) as number } : null;
  })();
  return {
    visiblePoolSize: Array.isArray(visiblePool) ? visiblePool.length : null,
    startSpacerSize: asFiniteNumber(virtualScroller["startSpacerSize"]),
    endSpacerSize: asFiniteNumber(virtualScroller["endSpacerSize"]),
    scrollWindow: scrollWindowNumbers,
  };
}

/**
 * Reads the DOM geometry. Every value is a plain number/string so samples can
 * be stored, serialized and compared without retaining element references.
 */
export function captureSidebarLayoutSample(context: SidebarLayoutMonitorContext): SidebarLayoutSample {
  const now = Date.now();
  if (typeof document === "undefined") {
    return {
      t: now,
      windowHeight: 0,
      rootHeight: 0,
      shellHeight: 0,
      shellRatioOfRoot: null,
      shellRatioOfWindow: null,
      flatNodeCount: context.flatNodeCount,
      scroller: { clientHeight: 0, scrollHeight: 0, scrollTop: 0, computedHeight: "n/a", overflowY: "n/a", position: "n/a" },
      virtual: null,
      rows: null,
      sticky: null,
    };
  }

  const root = elementGeometry(context.rootEl);
  const shell = elementGeometry(context.shellEl);
  const windowHeight = window.innerHeight;
  const rowGeometry = captureRows(context.scrollerEl, context.useVirtualTree);
  const internals = captureVirtualInternals(context.virtualScroller);
  const listElement = context.scrollerEl?.querySelector<HTMLElement>(".connection-tree-content") ?? null;

  return {
    t: now,
    windowHeight,
    rootHeight: root?.height ?? 0,
    shellHeight: shell?.height ?? 0,
    shellRatioOfRoot: shell ? ratioOrNull(shell.height, root?.height ?? 0) : null,
    shellRatioOfWindow: shell ? ratioOrNull(shell.height, windowHeight) : null,
    flatNodeCount: context.flatNodeCount,
    scroller: scrollerMetrics(context.scrollerEl),
    virtual: context.useVirtualTree
      ? {
          itemSize: context.virtualItemSize,
          expectedScrollHeight: context.flatNodeCount * context.virtualItemSize,
          renderedRows: rowGeometry?.renderedRows ?? 0,
          visiblePoolSize: internals?.visiblePoolSize ?? null,
          spacers: internals?.startSpacerSize != null || internals?.endSpacerSize != null ? { start: internals.startSpacerSize ?? 0, end: internals.endSpacerSize ?? 0 } : null,
          scrollWindow: internals?.scrollWindow ?? null,
          listHeight: listElement ? listElement.offsetHeight : null,
        }
      : null,
    rows: rowGeometry,
    sticky: captureSticky(context.scrollerEl),
  };
}

export function unreachableRowCount(sample: SidebarLayoutSample): number {
  const virtual = sample.virtual;
  if (!virtual || virtual.itemSize <= 0 || sample.flatNodeCount <= 0) return 0;
  const reachable = Math.floor(sample.scroller.scrollHeight / virtual.itemSize);
  return Math.max(0, sample.flatNodeCount - reachable);
}

function maxOf(values: number[]): number {
  return values.length > 0 ? Math.max(...values) : 0;
}

function minOf(values: number[]): number {
  return values.length > 0 ? Math.min(...values) : 0;
}

/**
 * Pure anomaly detection over a sample history. Only the last sample is
 * classified; the earlier entries provide the stability context (hysteresis).
 * Callers feed consecutive samples so streaks build up naturally.
 */
export function detectLayoutAnomalies(samples: readonly SidebarLayoutSample[]): SidebarLayoutAnomalyFlag[] {
  const sample = samples[samples.length - 1];
  if (!sample) return [];
  const flags: SidebarLayoutAnomalyFlag[] = [];
  const streakWindow = samples.slice(Math.max(0, samples.length - SIDEBAR_LAYOUT_MONITOR_ANOMALY_STREAK));
  const halfInBand = (value: number | null) => value !== null && value >= 0.4 && value <= 0.6;

  if (
    sample.shellHeight >= 120 &&
    sample.scroller.clientHeight > 0 &&
    sample.scroller.scrollHeight > sample.shellHeight + 4 &&
    streakWindow.length >= SIDEBAR_LAYOUT_MONITOR_ANOMALY_STREAK &&
    streakWindow.every((entry) => entry.shellHeight >= 120 && halfInBand(entry.shellRatioOfWindow)) &&
    maxOf(streakWindow.map((entry) => entry.shellHeight)) - minOf(streakWindow.map((entry) => entry.shellHeight)) <= 3
  ) {
    flags.push("half-height-shell");
  }

  const virtual = sample.virtual;
  if (virtual) {
    if (virtual.itemSize > 0 && sample.flatNodeCount > 8 && virtual.expectedScrollHeight - sample.scroller.scrollHeight >= 2 * virtual.itemSize) {
      flags.push("under-scroll");
    }
    if (sample.flatNodeCount > 0 && sample.rows) {
      // Rows in virtual mode are measured relative to the scroller viewport
      // (rect-based), so the gap is against clientHeight — not content
      // coordinates. A blank band means the last materialized row ends well
      // above the viewport bottom while more content exists below it.
      const gap = sample.scroller.clientHeight - sample.rows.lastBottom;
      const contentBelowViewport = sample.scroller.scrollHeight > sample.scroller.scrollTop + sample.scroller.clientHeight + 2 * virtual.itemSize;
      if ((gap > 2 * virtual.itemSize && contentBelowViewport) || sample.rows.lastBottom < 0) {
        flags.push("blank-viewport");
      }
    }
    if (unreachableRowCount(sample) > 0 && sample.scroller.scrollTop >= sample.scroller.scrollHeight - sample.scroller.clientHeight - 2) {
      flags.push("bottom-unreachable");
    }
  } else if (sample.rows && sample.rows.lastBottom > sample.scroller.scrollHeight + 2) {
    flags.push("rows-clipped");
  }

  return flags;
}

function captureAncestors(shellEl: HTMLElement | null): SidebarLayoutAncestorInfo[] {
  if (typeof window === "undefined" || !shellEl) return [];
  const result: SidebarLayoutAncestorInfo[] = [];
  let element: HTMLElement | null = shellEl;
  while (element && result.length < 14) {
    const style = window.getComputedStyle(element);
    result.push({
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === "string" ? element.className : "",
      id: element.id,
      height: rounded(element.getBoundingClientRect().height),
      computed: {
        height: style.height,
        minHeight: style.minHeight,
        flexGrow: style.flexGrow,
        flexShrink: style.flexShrink,
        flexBasis: style.flexBasis,
        overflowY: style.overflowY,
        position: style.position,
        display: style.display,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        borderTop: style.borderTopWidth,
        borderBottom: style.borderBottomWidth,
      },
    });
    element = element.parentElement;
  }
  return result;
}

function captureContentInfo(scrollerEl: HTMLElement | null): SidebarLayoutReport["content"] {
  if (typeof window === "undefined" || !scrollerEl) return null;
  const list = scrollerEl.querySelector<HTMLElement>(".connection-tree-content") ?? null;
  const sticky = scrollerEl.querySelector<HTMLElement>(".sticky-database-header") ?? null;
  return {
    list: list
      ? {
          height: list.offsetHeight,
          scrollHeight: list.scrollHeight,
          rectHeight: rounded(list.getBoundingClientRect().height),
          overflowY: getComputedStyle(list).overflowY,
          position: getComputedStyle(list).position,
          display: getComputedStyle(list).display,
        }
      : null,
    sticky: sticky
      ? {
          active: true,
          top: rounded(sticky.getBoundingClientRect().top),
          height: sticky.clientHeight,
          rectHeight: rounded(sticky.getBoundingClientRect().height),
          transform: getComputedStyle(sticky).transform,
        }
      : null,
  };
}

function findShellHeightTransition(samples: readonly SidebarLayoutSample[]): SidebarLayoutReport["transition"] {
  if (samples.length < 2) return null;
  const recent = samples.slice(-12);
  let largestDelta = 0;
  let index = -1;
  for (let i = 1; i < recent.length; i += 1) {
    const delta = Math.abs(recent[i].shellHeight - recent[i - 1].shellHeight);
    if (delta > largestDelta) {
      largestDelta = delta;
      index = i;
    }
  }
  if (index < 0) return null;
  const before = recent[index - 1];
  const after = recent[index];
  return {
    shellHeightBefore: before.shellHeight,
    shellHeightAfter: after.shellHeight,
    rootHeightBefore: before.rootHeight,
    rootHeightAfter: after.rootHeight,
    treeCountBefore: before.flatNodeCount,
    treeCountAfter: after.flatNodeCount,
    changedWithinSamples: recent.length - index,
  };
}

function formatConnections(connections: SidebarExpandedConnectionInfo[]): string {
  if (connections.length === 0) return "none";
  return connections.map((entry) => `${entry.label} (id=${entry.id.slice(0, 8)}, type=${entry.type}, desc=${entry.descendantCount})`).join(", ");
}

export function buildAnomalyDigest(report: SidebarLayoutReport): string {
  const sample = report.sample;
  const virtual = sample.virtual;
  const windowRatio = sample.shellRatioOfWindow == null ? "?" : `${Math.round(sample.shellRatioOfWindow * 100)}%`;
  const rootRatio = sample.shellRatioOfRoot == null ? "?" : `${Math.round(sample.shellRatioOfRoot * 100)}%`;
  const lines = [
    `${SIDEBAR_LAYOUT_MONITOR_LABEL} anomaly detected (${report.id}): ${report.flags.join(", ") || "none"}`,
    `  geometry: window=${sample.windowHeight} root=${sample.rootHeight} shell=${sample.shellHeight} (window ${windowRatio}, root ${rootRatio}) | scroller client=${sample.scroller.clientHeight} scroll=${sample.scroller.scrollHeight} top=${sample.scroller.scrollTop} max-scroll=${sample.scroller.scrollHeight - sample.scroller.clientHeight} computed-height=${sample.scroller.computedHeight} overflow-y=${sample.scroller.overflowY}`,
  ];
  if (virtual) {
    const viewport = virtual.scrollWindow ? `${virtual.scrollWindow.start}..${virtual.scrollWindow.end}` : "?";
    lines.push(
      `  virtual: ${sample.flatNodeCount} rows x ${virtual.itemSize}px -> expected ${virtual.expectedScrollHeight}px, actual ${sample.scroller.scrollHeight}px, unreachable ${unreachableRowCount(sample)} rows | pool=${virtual.visiblePoolSize ?? "?"} spacers=${virtual.spacers ? `${virtual.spacers.start}/${virtual.spacers.end}` : "?"} rendered=${virtual.renderedRows} viewport=${viewport} list=${virtual.listHeight ?? "?"}`,
    );
  }
  if (sample.rows) {
    lines.push(`  rows: rendered=${sample.rows.renderedRows} first=${sample.rows.firstTop}..${sample.rows.firstBottom} last=${sample.rows.lastTop}..${sample.rows.lastBottom}`);
  }
  if (sample.sticky) {
    lines.push(`  sticky: active top=${sample.sticky.top} height=${sample.sticky.height} transform=${sample.sticky.transform}`);
  }
  if (report.transition) {
    const transition = report.transition;
    const shellBefore = transition.shellHeightBefore;
    const delta = shellBefore == null ? "?" : transition.shellHeightAfter - shellBefore;
    lines.push(`  transition: shell ${shellBefore ?? "?"} -> ${transition.shellHeightAfter} px (delta ${delta}) within ${transition.changedWithinSamples} samples; tree count ${transition.treeCountBefore ?? "?"} -> ${transition.treeCountAfter}`);
  }
  const expansions = report.events.filter((event): event is SidebarLayoutExpandToggleEvent => event.type === "expand-toggle").slice(-3);
  for (const event of expansions) {
    lines.push(`  expand-toggle: ${event.expanded ? "expanded" : "collapsed"} ${event.label} (${event.nodeType}, id=${event.nodeId.slice(0, 8)})`);
  }
  lines.push(`  expanded connections: ${formatConnections(report.expandedConnections)}`);
  lines.push(`  full report: window.__dbxSidebarLayoutMonitor.snapshot()`);
  return lines.join("\n");
}

export function buildSidebarLayoutReport(
  sample: SidebarLayoutSample,
  options: {
    sampleHistory: readonly SidebarLayoutSample[];
    events: readonly SidebarLayoutMonitorEvent[];
    context: SidebarLayoutMonitorContext;
    flags: SidebarLayoutAnomalyFlag[];
  },
): SidebarLayoutReport {
  const report: SidebarLayoutReport = {
    id: `sidebar-layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    t: sample.t,
    flags: options.flags,
    sample,
    transition: findShellHeightTransition(options.sampleHistory),
    ancestors: captureAncestors(options.context.shellEl),
    content: captureContentInfo(options.context.scrollerEl),
    internals: captureVirtualInternals(options.context.virtualScroller),
    expandedConnections: options.context.expandedConnections,
    sampleHistory: [...options.sampleHistory].slice(-SIDEBAR_LAYOUT_MONITOR_REPORT_SAMPLES),
    events: [...options.events].slice(-SIDEBAR_LAYOUT_MONITOR_REPORT_EVENTS),
    digest: "",
  };
  report.digest = buildAnomalyDigest(report);
  return report;
}

export function createSidebarLayoutMonitor(options: SidebarLayoutMonitorOptions): SidebarLayoutMonitor {
  const readContext = options.readContext;
  const intervalMs = options.intervalMs ?? SIDEBAR_LAYOUT_MONITOR_SAMPLE_INTERVAL_MS;
  let verbose = options.verbose ?? false;
  let enabled = isSidebarLayoutMonitorRequested();
  let started = false;
  let active = false;
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let observedScroller: HTMLElement | null = null;
  let observedShell: HTMLElement | null = null;
  let sampleCount = 0;
  let samples: SidebarLayoutSample[] = [];
  let events: SidebarLayoutMonitorEvent[] = [];
  let streaks = new Map<SidebarLayoutAnomalyFlag, number>();
  let activeFlags: SidebarLayoutAnomalyFlag[] = [];
  let activations: Partial<Record<SidebarLayoutAnomalyFlag, number>> = {};
  let lastReport: SidebarLayoutReport | null = null;
  let handle: SidebarLayoutMonitorDebugHandle | null = null;
  let scrollListenerElement: HTMLElement | null = null;
  let lastScrollCaptureAt = 0;
  let lastScrollAtBottom: boolean | null = null;
  let lastSampleT = 0;
  // An explicit enable()/disable() from the debug handle wins over the
  // auto-arming rules (DEV default, localStorage flag, debug-logs setting),
  // so the user can actually turn the monitor off in a DEV session.
  let userOverride: boolean | null = null;

  function onTreeScroll() {
    // Throttle scroll-driven captures so continuous scrolling cannot flood
    // the sample ring with near-identical entries.
    const now = Date.now();
    if (now - lastScrollCaptureAt < 200) return;
    lastScrollCaptureAt = now;
    const context = readContext();
    const scroller = context.scrollerEl;
    if (scroller) {
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atBottom = scroller.scrollTop >= maxScrollTop - 4;
      if (atBottom !== lastScrollAtBottom) {
        lastScrollAtBottom = atBottom;
        events = ringPush(events, { type: "scroll-bottom", t: now, atBottom, scrollTop: Math.round(scroller.scrollTop), maxScrollTop }, SIDEBAR_LAYOUT_MONITOR_MAX_EVENTS);
      }
    }
    captureSample(context);
  }

  function attachScrollerListeners(context: SidebarLayoutMonitorContext) {
    const scroller = context.scrollerEl;
    if (scroller === scrollListenerElement) return;
    if (scrollListenerElement) scrollListenerElement.removeEventListener("scroll", onTreeScroll);
    scrollListenerElement = null;
    if (scroller) {
      scroller.addEventListener("scroll", onTreeScroll, { passive: true });
      scrollListenerElement = scroller;
    }
  }

  function detachScrollerListeners() {
    if (scrollListenerElement) scrollListenerElement.removeEventListener("scroll", onTreeScroll);
    scrollListenerElement = null;
  }

  function keepResizeObservation(context: SidebarLayoutMonitorContext) {
    if (typeof ResizeObserver === "undefined") return;
    if (context.scrollerEl === observedScroller && context.shellEl === observedShell) return;
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedScroller = null;
    observedShell = null;
    const targets = [context.scrollerEl, context.shellEl].filter((element): element is HTMLElement => !!element);
    if (targets.length === 0) return;
    resizeObserver = new ResizeObserver(() => captureSample());
    for (const target of targets) resizeObserver.observe(target);
    observedScroller = context.scrollerEl;
    observedShell = context.shellEl;
  }

  function persistEnabled() {
    try {
      if (enabled) localStorage.setItem(SIDEBAR_LAYOUT_MONITOR_STORAGE_KEY, "1");
      else localStorage.removeItem(SIDEBAR_LAYOUT_MONITOR_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; the in-memory flag still applies.
    }
  }

  function setEnabled(next: boolean, fromUser = true) {
    if (enabled === next) return;
    enabled = next;
    if (fromUser) userOverride = next;
    persistEnabled();
    active = next;
    if (next) {
      console.info(SIDEBAR_LAYOUT_MONITOR_LABEL, "enabled", new Date().toISOString());
      captureSample();
    } else {
      console.info(SIDEBAR_LAYOUT_MONITOR_LABEL, "disabled");
    }
  }

  function captureSample(prefetchedContext?: SidebarLayoutMonitorContext) {
    if (!started || !active) return;
    const context = prefetchedContext ?? readContext();
    if (!context.scrollerEl || !context.shellEl) return;
    attachScrollerListeners(context);
    keepResizeObservation(context);
    const sample = captureSidebarLayoutSample(context);
    samples = ringPush(samples, sample, SIDEBAR_LAYOUT_MONITOR_MAX_SAMPLES);
    sampleCount += 1;

    // Streaks are built from consecutive samples; a long gap (tab hidden,
    // tree emptied, renderer switch) means the previous streak is stale.
    if (lastSampleT > 0 && sample.t - lastSampleT > SIDEBAR_LAYOUT_MONITOR_STREAK_GAP_MS) {
      streaks.clear();
    }
    lastSampleT = sample.t;

    const detected = detectLayoutAnomalies(samples);
    const flagSet = new Set(detected);
    for (const flag of detected) streaks.set(flag, (streaks.get(flag) ?? 0) + 1);
    const newlyActivated: SidebarLayoutAnomalyFlag[] = [];
    for (const [flag, streak] of streaks) {
      if (!flagSet.has(flag)) {
        streaks.delete(flag);
      } else if (streak >= SIDEBAR_LAYOUT_MONITOR_ANOMALY_STREAK && !activeFlags.includes(flag)) {
        activeFlags = [...activeFlags, flag];
        activations[flag] = (activations[flag] ?? 0) + 1;
        newlyActivated.push(flag);
      }
    }
    if (newlyActivated.length > 0) {
      // Anomaly events carry the activating sample + digest so that
      // recentEvents() alone tells the full geometry story.
      const report = buildSidebarLayoutReport(sample, { sampleHistory: samples, events, context, flags: [...activeFlags] });
      lastReport = report;
      events = ringPush(events, { type: "anomaly", t: sample.t, flags: newlyActivated, sample: report.sample, digest: report.digest }, SIDEBAR_LAYOUT_MONITOR_MAX_EVENTS);
    }
    const settledFlags = activeFlags.filter((flag) => !flagSet.has(flag));
    if (settledFlags.length > 0) {
      activeFlags = activeFlags.filter((flag) => flagSet.has(flag));
      events = ringPush(events, { type: "settle", t: sample.t, flags: settledFlags }, SIDEBAR_LAYOUT_MONITOR_MAX_EVENTS);
      console.info(SIDEBAR_LAYOUT_MONITOR_LABEL, "anomaly settled", settledFlags.join(","));
    }
    if (activeFlags.length > 0) {
      const report = buildSidebarLayoutReport(sample, { sampleHistory: samples, events, context, flags: [...activeFlags] });
      lastReport = report;
      if (newlyActivated.length > 0 || sampleCount % 4 === 0) {
        console.warn(report.digest);
      }
    }
    if (verbose) {
      console.debug(SIDEBAR_LAYOUT_MONITOR_LABEL, "sample", JSON.stringify({ t: sample.t, shell: sample.shellHeight, ratio: sample.shellRatioOfWindow, scroller: sample.scroller, count: sample.flatNodeCount, rows: sample.rows?.renderedRows ?? 0 }));
    }
  }

  function recordEvent(event: SidebarLayoutMonitorEventInput) {
    const stamped = { ...event, t: Date.now() } as SidebarLayoutMonitorEvent;
    events = ringPush(events, stamped, SIDEBAR_LAYOUT_MONITOR_MAX_EVENTS);
    if (event.type === "tree-change") {
      scheduleBurst();
    }
    if (verbose) {
      console.debug(SIDEBAR_LAYOUT_MONITOR_LABEL, "event", JSON.stringify(stamped));
    }
  }

  // Streaming tree changes (e.g. a Dameng subtree loading in batches) fire many
  // tree-change events back to back; merge the post-change captures into a
  // single pending sample instead of stacking one timer per event.
  function scheduleBurst() {
    if (burstTimer) return;
    burstTimer = setTimeout(() => {
      burstTimer = null;
      captureSample();
    }, 150);
  }

  function snapshotNow(): SidebarLayoutReport {
    const context = readContext();
    const sample = captureSidebarLayoutSample(context);
    const history = [...samples, sample];
    const flags = detectLayoutAnomalies(history);
    const report = buildSidebarLayoutReport(sample, { sampleHistory: history, events, context, flags });
    lastReport = report;
    return report;
  }

  function installWindowHandle() {
    if (typeof window === "undefined") return;
    const nextHandle: SidebarLayoutMonitorDebugHandle = {
      enable: () => setEnabled(true),
      disable: () => setEnabled(false),
      isEnabled: () => enabled,
      setVerbose: (nextVerbose) => {
        verbose = nextVerbose;
      },
      snapshot: () => snapshotNow(),
      state: () => getState(),
      recentSamples: (count = 40) => samples.slice(-count),
      recentEvents: (count = 30) => events.slice(-count),
    };
    handle = nextHandle;
    window.__dbxSidebarLayoutMonitor = nextHandle;
  }

  function uninstallWindowHandle() {
    if (typeof window === "undefined") return;
    if (window.__dbxSidebarLayoutMonitor === handle) {
      delete window.__dbxSidebarLayoutMonitor;
    }
    handle = null;
  }

  function getState(): SidebarLayoutMonitorState {
    return {
      enabled,
      startedAt,
      sampleCount,
      activeFlags: [...activeFlags],
      activations: { ...activations },
      lastReport,
      lastSample: samples[samples.length - 1] ?? null,
    };
  }

  function stop() {
    if (!started) return;
    started = false;
    active = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedScroller = null;
    observedShell = null;
    detachScrollerListeners();
  }

  function dispose() {
    stop();
    uninstallWindowHandle();
  }

  function start() {
    if (started) return;
    started = true;
    startedAt = Date.now();
    active = enabled;
    installWindowHandle();
    console.info(SIDEBAR_LAYOUT_MONITOR_LABEL, `started (${enabled ? "armed" : "idle — call window.__dbxSidebarLayoutMonitor.enable() or enable the debug-logs setting to arm"})`, "interval", intervalMs);
    // The interval always runs so the monitor can arm itself when the
    // debug-logs setting or the localStorage flag is turned on later.
    timer = setInterval(tick, intervalMs);
    if (enabled) captureSample();
  }

  function tick() {
    if (userOverride !== null) {
      if (enabled) captureSample();
      return;
    }
    const requested = isSidebarLayoutMonitorRequested();
    if (requested !== enabled) {
      setEnabled(requested, false);
      return;
    }
    if (enabled) captureSample();
  }

  return {
    start,
    stop,
    dispose,
    setEnabled,
    isEnabled: () => enabled,
    recordEvent,
    snapshotNow,
    getState,
  };
}

declare global {
  interface Window {
    __dbxSidebarLayoutMonitor?: SidebarLayoutMonitorDebugHandle;
  }
}
