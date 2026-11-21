// Floating plugin windows — the `window` surface of the plugin UI spec (§8.3
// surface vocabulary): a frameless, always-on-top desktop window that hosts one
// plugin workbench outside the main shell, so a plugin can keep a small widget
// (player capsule, session badge, quick picker) visible while the user works in
// other applications.
//
// The window is an ordinary DBX webview: it boots the same bundle and renders
// PluginFloatingWindow.vue instead of the workbench shell (see main.ts). All
// geometry stays host-owned — a plugin drives its own window through the bridge
// (`dbxPlugin.floating`) and never receives a window handle, so it cannot move,
// resize, or close anything but the window that hosts it.
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { floatingWindowLabel, floatingWindowUrl, isFloatingPluginWindow, isFloatingWindowLabel, resolveWindowContext } from "@/lib/app/windowContext";

/** Logical (CSS pixel) bounds for a floating window. */
export const FLOATING_MIN_WIDTH_PX = 64;
export const FLOATING_MIN_HEIGHT_PX = 40;
export const FLOATING_MAX_WIDTH_PX = 4096;
export const FLOATING_MAX_HEIGHT_PX = 4096;
/** Logical size used when a plugin does not ask for one. */
export const FLOATING_DEFAULT_WIDTH_PX = 320;
export const FLOATING_DEFAULT_HEIGHT_PX = 200;
/** Gap kept between a snapped window and the work-area edge, in logical pixels. */
export const FLOATING_EDGE_MARGIN_PX = 16;
/** Distance from a work-area edge (logical pixels) that pulls the window onto it when a drag ends. A release past the edge always snaps, so this only widens the band on the inner side. */
export const FLOATING_SNAP_THRESHOLD_PX = 28;
/** Width of the strip an edge-docked widget leaves on screen, in logical pixels. */
export const FLOATING_DOCK_SLIVER_PX = 14;
/**
 * How long a docked widget stays a fully visible capsule before it tucks away:
 * measured from the last moment the cursor was over it, so aiming the widget is
 * never interrupted, and a reopened widget gets this much time to be read.
 */
const FLOATING_DOCK_IDLE_MS = 2_500;
const FLOATING_DOCK_POLL_MS = 150;
/** Extra hit area around the dock strip, in physical pixels. */
const FLOATING_DOCK_HOVER_PAD_PX = 8;
/** A drag nobody ends (the webview lost the pointerup) must not keep the window glued to the cursor. */
const FLOATING_DRAG_TIMEOUT_MS = 30_000;
/**
 * Cursor quiet period after which a drag counts as released. The plugin's
 * pointerup is the normal end and arrives reliably, so this only has to catch a
 * webview that lost the pointer — long enough that aiming the widget with a
 * deliberate mid-drag pause does not drop the gesture.
 */
const FLOATING_DRAG_IDLE_MS = 1_500;
const FLOATING_CREATE_TIMEOUT_MS = 10_000;
const FLOATING_POSITION_STORAGE_PREFIX = "dbx-plugin-floating-window:";

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One connected monitor: its work area (screen minus taskbar/dock) in physical pixels, plus the DPI scale. */
export interface FloatingMonitor {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

/** Where the user last left a plugin's floating window: a physical point and the DPI scale it was captured at. */
export interface FloatingPosition {
  x: number;
  y: number;
  scaleFactor: number;
  /** Set when the position is an edge-docked (mostly off-screen) home. */
  edge?: FloatingDockEdge;
}

export interface OpenFloatingWindowRequest {
  pluginId: string;
  contributionId: string;
  /** Window title (taskbar/tooltips); the plugin's own UI stays chrome-less. */
  title?: string;
  /** Logical size, clamped to the floating bounds. */
  width?: number;
  height?: number;
  /** Physical screen position. Omitted restores where the user last left the window. */
  x?: number;
  y?: number;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
  /** Host-forwarded plugin context, delivered as `dbxPlugin.context` (bounded, see windowContext). */
  context?: Record<string, unknown>;
}

export interface OpenFloatingWindowResult {
  /** Opaque window id (the deterministic host label). */
  windowId: string;
  reused: boolean;
}

export interface SnapFloatingResult {
  rect: FloatingRect;
  /** Work-area edges the window was pulled onto. */
  edges: Array<"left" | "right" | "top" | "bottom">;
}

/**
 * Pulls a physical rect onto the work-area edges it landed near or past, then
 * clamps it fully inside, so a released widget is never half off-screen.
 * `margin` and `threshold` are logical pixels and are scaled by the monitor DPI
 * here. Pure: no window access, so the geometry rules are unit-testable.
 */
export function snapRectToWorkArea(rect: FloatingRect, monitor: FloatingMonitor, options?: { margin?: number; threshold?: number }): SnapFloatingResult {
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const margin = Math.max(0, Math.round((options?.margin ?? 0) * scale));
  const threshold = Math.max(0, Math.round((options?.threshold ?? 0) * scale));
  const edges: SnapFloatingResult["edges"] = [];
  const x = snapAxis(rect.x, monitor.x + margin, monitor.x + monitor.width - margin - rect.width, threshold, "left", "right", edges);
  const y = snapAxis(rect.y, monitor.y + margin, monitor.y + monitor.height - margin - rect.height, threshold, "top", "bottom", edges);
  return { rect: { x, y, width: rect.width, height: rect.height }, edges };
}

function snapAxis(value: number, min: number, max: number, threshold: number, minEdge: "left" | "top", maxEdge: "right" | "bottom", edges: SnapFloatingResult["edges"]): number {
  // A window wider/taller than the work area has no edge to snap to; keep it
  // reachable by clamping into the (inverted) range instead.
  if (max < min) return Math.min(Math.max(value, max), min);
  let next = value;
  // At or past the edge always snaps: a drag tracks the cursor without a lower
  // bound, so shoving the widget against a border lands it well outside any
  // threshold band — and that overshoot is the intent to dock, not a miss.
  if (value <= min + threshold) {
    next = min;
    edges.push(minEdge);
  } else if (value >= max - threshold) {
    next = max;
    edges.push(maxEdge);
  }
  return Math.min(Math.max(next, min), max);
}

export type FloatingDockEdge = "left" | "right" | "top" | "bottom";

export interface FloatingDockRects {
  /** Flush against the edge, fully on screen: the hover-revealed position. */
  revealed: { x: number; y: number };
  /** Slid out past the edge until only `sliver` pixels stay visible. */
  tucked: { x: number; y: number };
  /** The on-screen strip of the tucked window — the hover target. */
  sliver: FloatingRect;
}

/**
 * Geometry of an edge-docked widget: where it sits revealed (flush to the edge),
 * where it hides (all but a sliver off-screen), and the strip that stays
 * clickable while hidden. Pure, in physical pixels, so the rules are testable.
 */
export function dockRectsForEdge(rect: FloatingRect, monitor: FloatingMonitor, edge: FloatingDockEdge, sliverLogical: number): FloatingDockRects {
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const sliver = Math.max(1, Math.round(sliverLogical * scale));
  const clampX = (x: number) => Math.min(Math.max(x, monitor.x), monitor.x + Math.max(0, monitor.width - rect.width));
  const clampY = (y: number) => Math.min(Math.max(y, monitor.y), monitor.y + Math.max(0, monitor.height - rect.height));
  if (edge === "left" || edge === "right") {
    const revealedX = edge === "left" ? monitor.x : monitor.x + monitor.width - rect.width;
    const y = clampY(rect.y);
    const tuckedX = edge === "left" ? revealedX - rect.width + sliver : revealedX + rect.width - sliver;
    const sliverX = edge === "left" ? tuckedX + rect.width - sliver : tuckedX;
    return { revealed: { x: revealedX, y }, tucked: { x: tuckedX, y }, sliver: { x: sliverX, y, width: sliver, height: rect.height } };
  }
  const revealedY = edge === "top" ? monitor.y : monitor.y + monitor.height - rect.height;
  const x = clampX(rect.x);
  const tuckedY = edge === "top" ? revealedY - rect.height + sliver : revealedY + rect.height - sliver;
  const sliverY = edge === "top" ? tuckedY + rect.height - sliver : tuckedY;
  return { revealed: { x, y: revealedY }, tucked: { x, y: tuckedY }, sliver: { x, y: sliverY, width: rect.width, height: sliver } };
}

function pointInRect(point: { x: number; y: number }, rect: FloatingRect, pad: number): boolean {
  return point.x >= rect.x - pad && point.x <= rect.x + rect.width + pad && point.y >= rect.y - pad && point.y <= rect.y + rect.height + pad;
}

/** Clamps a requested logical size into the floating bounds; non-finite input falls back to the minimum. */
export function clampFloatingSize(width: number, height: number): { width: number; height: number } {
  const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min);
  return {
    width: clamp(width, FLOATING_MIN_WIDTH_PX, FLOATING_MAX_WIDTH_PX),
    height: clamp(height, FLOATING_MIN_HEIGHT_PX, FLOATING_MAX_HEIGHT_PX),
  };
}

/** Default placement: the bottom-right corner of the work area, clear of the edge. `size` is logical. */
export function defaultFloatingPosition(monitor: FloatingMonitor, size: { width: number; height: number }, margin: number): { x: number; y: number } {
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const gap = Math.round(margin * scale);
  return {
    x: Math.round(monitor.x + Math.max(gap, monitor.width - gap - Math.round(size.width * scale))),
    y: Math.round(monitor.y + Math.max(gap, monitor.height - gap - Math.round(size.height * scale))),
  };
}

/** True when the point lies inside the work area; used to reject positions stored for a monitor that is gone. */
export function pointInsideWorkArea(point: { x: number; y: number }, monitor: FloatingMonitor): boolean {
  return point.x >= monitor.x && point.x <= monitor.x + monitor.width && point.y >= monitor.y && point.y <= monitor.y + monitor.height;
}

/** The monitor containing the point, else the first one, else null. */
export function pickMonitorForPoint(point: { x: number; y: number }, monitors: readonly FloatingMonitor[]): FloatingMonitor | null {
  return monitors.find((monitor) => pointInsideWorkArea(point, monitor)) ?? monitors[0] ?? null;
}

export function floatingPositionStorageKey(pluginId: string, contributionId: string): string {
  return `${FLOATING_POSITION_STORAGE_PREFIX}${pluginId}:${contributionId}`;
}

/** Parses a stored position; anything malformed is treated as absent. */
export function parseFloatingPosition(raw: string | null): FloatingPosition | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<FloatingPosition>;
    if (typeof value?.x !== "number" || typeof value?.y !== "number" || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    const scaleFactor = typeof value.scaleFactor === "number" && Number.isFinite(value.scaleFactor) && value.scaleFactor > 0 ? value.scaleFactor : 1;
    const edge = value.edge === "left" || value.edge === "right" || value.edge === "top" || value.edge === "bottom" ? value.edge : undefined;
    return { x: value.x, y: value.y, scaleFactor, ...(edge ? { edge } : {}) };
  } catch {
    return null;
  }
}

/**
 * Resolves where a floating window should appear: the stored position when it
 * still lands on a connected monitor (pulled inside the work area, since the
 * taskbar or the monitor layout may have changed), otherwise the work-area
 * default on `fallback` (the monitor the caller is on, so the widget opens where
 * the user is looking). `size` is logical. Docked windows store their revealed
 * (flush-to-edge, fully on-screen) point, so the same rules cover them; the
 * window comes up as a readable capsule and tucks once the cursor has left it
 * (resumeFloatingDock).
 */
export function resolveFloatingPlacement(stored: FloatingPosition | null, monitors: readonly FloatingMonitor[], size: { width: number; height: number }, fallback?: FloatingMonitor): { x: number; y: number; restored: boolean } {
  if (stored) {
    const monitor = pickMonitorForPoint(stored, monitors);
    if (monitor && pointInsideWorkArea(stored, monitor)) {
      // Clamp the stored point, not a rect: the window's real size is only known
      // once its plugin has laid itself out, so assuming the requested size here
      // would shift restored positions by the difference. Keeping the point a
      // margin away from every edge is enough to keep the window reachable.
      const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
      const gap = Math.round(FLOATING_EDGE_MARGIN_PX * scale);
      return {
        x: Math.min(Math.max(stored.x, monitor.x + gap), monitor.x + monitor.width - gap),
        y: Math.min(Math.max(stored.y, monitor.y + gap), monitor.y + monitor.height - gap),
        restored: true,
      };
    }
  }
  const monitor = fallback ?? monitors[0];
  if (!monitor) return { x: 0, y: 0, restored: false };
  return { ...defaultFloatingPosition(monitor, size, FLOATING_EDGE_MARGIN_PX), restored: false };
}

export function persistFloatingPosition(pluginId: string, contributionId: string, position: FloatingPosition): void {
  safeLocalStorageSet(floatingPositionStorageKey(pluginId, contributionId), JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y), scaleFactor: position.scaleFactor, ...(position.edge ? { edge: position.edge } : {}) }));
}

/**
 * Validates one `host.openFloating` payload. The plugin id always comes from
 * the bridge (never from the payload), so a plugin can only open windows for
 * its own contributions.
 */
export function parseFloatingWindowRequest(pluginId: string, input: Record<string, unknown>): OpenFloatingWindowRequest {
  const contributionId = input.contributionId;
  if (typeof contributionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(contributionId)) throw new Error("host.openFloating requires a valid contributionId");
  const readNumber = (value: unknown, label: string): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
    return value;
  };
  const readBoolean = (value: unknown, label: string): boolean | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
    return value;
  };
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : undefined;
  const context = input.context;
  if (context !== undefined && context !== null && (typeof context !== "object" || Array.isArray(context))) throw new Error("context must be an object");
  const width = readNumber(input.width, "width");
  const height = readNumber(input.height, "height");
  const x = readNumber(input.x, "x");
  const y = readNumber(input.y, "y");
  const alwaysOnTop = readBoolean(input.alwaysOnTop, "alwaysOnTop");
  const skipTaskbar = readBoolean(input.skipTaskbar, "skipTaskbar");
  const resizable = readBoolean(input.resizable, "resizable");
  return {
    pluginId,
    contributionId,
    ...(title === undefined ? {} : { title }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(alwaysOnTop === undefined ? {} : { alwaysOnTop }),
    ...(skipTaskbar === undefined ? {} : { skipTaskbar }),
    ...(resizable === undefined ? {} : { resizable }),
    ...(context === undefined || context === null ? {} : { context: context as Record<string, unknown> }),
  };
}

interface DragSession {
  /** Native cursor reading at drag start; cursorPosition() reports physical pixels. */
  anchorX: number;
  anchorY: number;
  /** Window outer position at drag start, in physical pixels. */
  windowX: number;
  windowY: number;
  startedAt: number;
  lastCursorX: number;
  lastCursorY: number;
  lastMoveAt: number;
  timer?: ReturnType<typeof setInterval>;
}

const dragSessions = new Map<string, DragSession>();

/** The calling window, when it is a floating plugin window; anything else is a misuse. */
async function ownFloatingWindow() {
  if (!isTauriRuntime()) throw new Error("Floating plugin windows require the desktop app");
  if (!isFloatingPluginWindow()) throw new Error("This call is only available inside a floating plugin window");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function listMonitors(): Promise<FloatingMonitor[]> {
  const { availableMonitors } = await import("@tauri-apps/api/window");
  const monitors = await availableMonitors().catch(() => []);
  return monitors.map((monitor) => {
    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
    return { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height, scaleFactor: monitor.scaleFactor > 0 ? monitor.scaleFactor : 1 };
  });
}

/** The monitor the calling window is on, so a new widget lands where the user is looking. */
async function currentMonitorArea(monitors: readonly FloatingMonitor[]): Promise<FloatingMonitor | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const current = await currentMonitor().catch(() => null);
  if (!current) return null;
  const area = current.workArea ?? { position: current.position, size: current.size };
  const match = monitors.find((monitor) => monitor.x === area.position.x && monitor.y === area.position.y && monitor.width === area.size.width && monitor.height === area.size.height);
  return match ?? { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height, scaleFactor: current.scaleFactor > 0 ? current.scaleFactor : 1 };
}

/** The floating window's document reports through this event that it mounted (i.e. its webview is alive). */
export const FLOATING_WEBVIEW_READY_EVENT = "dbx:plugin-floating-webview-ready";
/** The creator asks an already-open floating window to re-report liveness. */
export const FLOATING_WEBVIEW_HELLO_EVENT = "dbx:plugin-floating-hello";
/**
 * How long the creator waits for the floating window's document to report that
 * it mounted. Production bundles mount in well under a second; the dev server
 * transforms this chunk's dependency graph (workbench host + stores) on first
 * request after an edit, which can take several seconds — a timeout below that
 * would retire perfectly healthy windows.
 */
const FLOATING_WEBVIEW_READY_TIMEOUT_MS = 6_000;
/**
 * Creation attempts. WebView2 intermittently drops the initial navigation of a
 * freshly created webview (the window sits at about:blank and never mounts), so
 * a dead attempt is retired and retried instead of surfacing as a silent no-op.
 */
const FLOATING_OPEN_ATTEMPTS = 4;

/**
 * True when the floating window's own document mounts within the timeout. A
 * floating window is created hidden, so a webview that dies during boot leaves
 * no visible trace at all — without this handshake a failed open would look like
 * "minimize did nothing" while a dead window sits in the registry and shadows
 * every later open.
 */
async function pingFloatingWebview(label: string, from: string): Promise<boolean> {
  const { listen, emitTo } = await import("@tauri-apps/api/event");
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(() => settle(false), FLOATING_WEBVIEW_READY_TIMEOUT_MS);
    function settle(value: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve(value);
    }
    void listen<{ label?: unknown }>(FLOATING_WEBVIEW_READY_EVENT, (message) => {
      if (message.payload && message.payload.label === label) settle(true);
    }).then((fn) => {
      unlisten = fn;
    });
    // A window that mounted before this listener existed answers the hello; a
    // window still booting reports on its own once it mounts.
    void emitTo(label, FLOATING_WEBVIEW_HELLO_EVENT, { from });
  });
}

async function createFloatingChild(label: string, request: OpenFloatingWindowRequest, creatorLabel: string, placement: { x: number; y: number }, size: { width: number; height: number }): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // Loaded lazily: the module pulls the i18n singleton in, which this window-only
  // path has no other use for.
  const { assertUpdateAllowsInteraction, beginUpdateSensitiveOperation } = await import("@/lib/app/updatePreparation");
  assertUpdateAllowsInteraction();
  let finishOperation: (() => void) | undefined;
  try {
    finishOperation = beginUpdateSensitiveOperation();
    // Deliberately the same creation shape as the proven detached-tab windows:
    // url/size/position/decorations/visibility only, with the widget chrome
    // applied afterwards through setters. This is the shape verified to receive
    // real OS mouse input (the drag acceptance presses and moves the widget with
    // native input); richer creation-time option sets were not.
    const child = new WebviewWindow(label, {
      url: floatingWindowUrl(request.pluginId, request.contributionId, request.context, creatorLabel),
      title: request.title ?? "DBX",
      width: size.width,
      height: size.height,
      minWidth: FLOATING_MIN_WIDTH_PX,
      minHeight: FLOATING_MIN_HEIGHT_PX,
      x: placement.x,
      y: placement.y,
      resizable: request.resizable === true,
      visible: false,
      decorations: false,
      center: false,
    });

    // A caller timeout does not prove native window creation has stopped, so the
    // reservation is held until a native terminal event arrives (same reasoning
    // as the detached-tab creator).
    const finishNativeCreation = beginUpdateSensitiveOperation();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        finishNativeCreation();
        finish();
      };
      void child.once("tauri://created", () => settle(resolve));
      void child.once("tauri://error", (event) => {
        const message = typeof event?.payload === "string" ? event.payload : "Floating window creation failed";
        console.error("[DBX][plugin-floating:create:error]", message);
        settle(() => reject(new Error(message)));
      });
      timeout = setTimeout(() => settle(() => reject(new Error("Timed out while creating the floating plugin window"))), FLOATING_CREATE_TIMEOUT_MS);
    });
    // Widget chrome after creation: a floating widget owns no taskbar button and
    // stays above other applications. Each is best-effort — failing degrades to a
    // taskbar entry or a coverable window, never to a lost widget.
    if (request.alwaysOnTop !== false) await child.setAlwaysOnTop(true).catch(() => undefined);
    if (request.skipTaskbar !== false) await child.setSkipTaskbar(true).catch((error: unknown) => console.error("[DBX][plugin-floating:skip-taskbar]", error));
    await child.show().catch((error: unknown) => console.error("[DBX][plugin-floating:show]", error));
    // setPosition speaks the same (outer) coordinate space as the position we
    // persist on drag end; the creation-time x/y do not, once a shadow frame is
    // in play, and restoring through them drifts by the frame thickness.
    const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
    await child.setPosition(new PhysicalPosition(Math.round(placement.x), Math.round(placement.y))).catch(() => undefined);
  } finally {
    finishOperation?.();
  }
}

/**
 * Opens (or focuses) the floating window for one plugin workbench contribution.
 * The window is opaque and the plugin paints its own card. Creation is retried
 * because WebView2 intermittently drops a fresh webview's initial navigation,
 * and a window whose document never mounts would otherwise sit in the registry
 * shadowing every later open.
 */
export async function openFloatingWindow(request: OpenFloatingWindowRequest): Promise<OpenFloatingWindowResult> {
  if (!isTauriRuntime()) throw new Error("Floating plugin windows require the desktop app");
  const label = floatingWindowLabel(request.pluginId, request.contributionId);
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const creatorLabel = getCurrentWindow().label;
  const size = clampFloatingSize(request.width ?? FLOATING_DEFAULT_WIDTH_PX, request.height ?? FLOATING_DEFAULT_HEIGHT_PX);
  const monitors = await listMonitors();
  const target = (await currentMonitorArea(monitors)) ?? monitors[0] ?? { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 };
  const stored = parseFloatingPosition(safeLocalStorageGet(floatingPositionStorageKey(request.pluginId, request.contributionId)));
  const placement = request.x !== undefined && request.y !== undefined ? { x: Math.round(request.x), y: Math.round(request.y) } : resolveFloatingPlacement(stored, monitors, size, target);
  for (let attempt = 0; ; attempt += 1) {
    const existing = await WebviewWindow.getByLabel(label);
    if (!existing) await createFloatingChild(label, request, creatorLabel, placement, size);
    const child = existing ?? (await WebviewWindow.getByLabel(label));
    if (!child) throw new Error("Floating window creation failed");
    if (await pingFloatingWebview(label, creatorLabel)) {
      if (existing) {
        await child.show();
        await child.setFocus();
      }
      return { windowId: label, reused: Boolean(existing) };
    }
    // A window whose document never mounted is dead weight, and on the reuse
    // path it would shadow every later open — retire it and retry; only after
    // the last attempt does the failure reach the plugin, which then falls back
    // to an in-shell surface.
    console.error("[DBX][plugin-floating:webview-dead]", label, attempt);
    await child.destroy().catch(() => undefined);
    if (attempt >= FLOATING_OPEN_ATTEMPTS - 1) throw new Error("The floating plugin window did not come up");
  }
}

/**
 * Closes floating windows by host label. Labels are derived by the caller from
 * its own manifest, so a plugin can only ever close its own windows.
 */
export async function closeFloatingWindows(labels: readonly string[]): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  for (const label of labels) {
    // Never let a caller address the main shell or a detached tab through this path.
    if (!isFloatingWindowLabel(label)) continue;
    const target = await WebviewWindow.getByLabel(label);
    if (!target) continue;
    const session = dragSessions.get(label);
    if (session?.timer) clearInterval(session.timer);
    dragSessions.delete(label);
    undockFloatingWindow(label);
    await target.destroy().catch(async () => {
      await target.close().catch((error: unknown) => console.error("[DBX][plugin-floating:close]", label, error));
    });
  }
}

/**
 * Starts a window drag. The plugin only reports that its grip passed the drag
 * threshold; from here the host polls the NATIVE cursor position and moves the
 * window itself. Per-move messages from the plugin would work too, but a host
 * poll keeps the widget glued to the cursor even if the webview stops seeing
 * pointer events (a drag that outruns the window, a cancelled capture).
 * `startDragging()` is not an option: the OS move loop only starts from a
 * synchronous mousedown handler, and a bridge call is always async.
 *
 * Both readings are physical pixels — `cursorPosition()` resolves to a
 * PhysicalPosition and so does `outerPosition()` — so the delta needs no DPI
 * conversion. Dividing it by the scale factor makes the window trail the
 * cursor by that factor.
 */
export async function beginFloatingWindowDrag(): Promise<void> {
  const window = await ownFloatingWindow();
  const label = window.label;
  if (dragSessions.has(label)) return;
  const { cursorPosition } = await import("@tauri-apps/api/window");
  const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
  const [cursor, position] = await Promise.all([cursorPosition(), window.outerPosition()]);
  const session: DragSession = {
    anchorX: cursor.x,
    anchorY: cursor.y,
    windowX: position.x,
    windowY: position.y,
    startedAt: Date.now(),
    lastCursorX: cursor.x,
    lastCursorY: cursor.y,
    lastMoveAt: Date.now(),
  };
  dragSessions.set(label, session);
  session.timer = setInterval(() => {
    const active = dragSessions.get(label);
    if (!active) return;
    void cursorPosition()
      .then((cursor) => {
        const current = dragSessions.get(label);
        if (!current) return;
        if (cursor.x !== current.lastCursorX || cursor.y !== current.lastCursorY) {
          current.lastCursorX = cursor.x;
          current.lastCursorY = cursor.y;
          current.lastMoveAt = Date.now();
        }
        const dx = Math.round(cursor.x - current.anchorX);
        const dy = Math.round(cursor.y - current.anchorY);
        void window.setPosition(new PhysicalPosition(current.windowX + dx, current.windowY + dy)).catch(() => undefined);
        // The plugin's pointerup is the normal end, but a webview that lost the
        // pointer never sends one, so a quiet cursor is the release of last resort.
        if (Date.now() - current.lastMoveAt > FLOATING_DRAG_IDLE_MS || Date.now() - current.startedAt > FLOATING_DRAG_TIMEOUT_MS) {
          void endFloatingWindowDrag(true);
        }
      })
      .catch(() => undefined);
  }, 16);
}

/**
 * Ends a drag: snaps the window onto the work-area edges it landed near, clamps
 * it inside, and persists the position so the widget reopens where the user
 * left it. Returns the final physical rect, or null when geometry is unreadable.
 */
export async function endFloatingWindowDrag(snap = true): Promise<FloatingRect | null> {
  const window = await ownFloatingWindow();
  const session = dragSessions.get(window.label);
  if (session?.timer) clearInterval(session.timer);
  dragSessions.delete(window.label);
  const scaleFactor = (await window.scaleFactor().catch(() => 1)) || 1;
  const rect = await currentWindowRect(window);
  if (!rect) return null;
  let final = rect;
  if (snap) {
    const monitors = await listMonitors();
    const monitor = pickMonitorForPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, monitors);
    if (monitor) {
      const snapped = snapRectToWorkArea(rect, monitor, { margin: FLOATING_EDGE_MARGIN_PX, threshold: FLOATING_SNAP_THRESHOLD_PX });
      final = snapped.rect;
      const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
      await window.setPosition(new PhysicalPosition(Math.round(final.x), Math.round(final.y)));
      if (snapped.edges.length) {
        // Released against an edge: dock it. The cursor is still over the widget,
        // so start revealed and let the dock poll tuck it once the user leaves.
        await dockFloatingWindow(window, snapped.edges[0], monitor, final, false);
        const tucked = dockSessions.get(window.label)?.rects.tucked;
        if (tucked) final = { ...final, x: tucked.x, y: tucked.y };
      } else {
        undockFloatingWindow(window.label);
      }
    }
  } else {
    undockFloatingWindow(window.label);
  }
  const docked = dockSessions.get(window.label);
  // Store the revealed (on-screen) home plus the edge: the tucked point hangs
  // off-screen and would fail every monitor/clamp check on the next open.
  persistOwnPosition(docked ? docked.rects.revealed : final, scaleFactor, docked?.edge);
  return final;
}

type DockableWindow = Awaited<ReturnType<typeof ownFloatingWindow>>;

interface DockSession {
  edge: FloatingDockEdge;
  monitor: FloatingMonitor;
  rects: FloatingDockRects;
  size: { width: number; height: number };
  hidden: boolean;
  lastHoverAt: number;
  timer?: ReturnType<typeof setInterval>;
}

const dockSessions = new Map<string, DockSession>();

function stopDockPoll(label: string): void {
  const session = dockSessions.get(label);
  if (session?.timer) clearInterval(session.timer);
}

/** Drops a window's dock state and its hover poll. */
export function undockFloatingWindow(label: string): void {
  stopDockPoll(label);
  dockSessions.delete(label);
}

async function setWindowPosition(window: DockableWindow, to: { x: number; y: number }): Promise<void> {
  const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
  await window.setPosition(new PhysicalPosition(Math.round(to.x), Math.round(to.y))).catch(() => undefined);
}

/**
 * Docks a floating window onto a work-area edge: it tucks off-screen until only
 * a sliver stays visible, slides out flush to the edge while the cursor is over
 * that sliver, and tucks again once the cursor has been away for a moment. The
 * poll lives in the floating window's own context (like the drag poll), so it
 * survives a main-window reload.
 */
export async function dockFloatingWindow(window: DockableWindow, edge: FloatingDockEdge, monitor: FloatingMonitor, rect: FloatingRect, hidden: boolean): Promise<void> {
  stopDockPoll(window.label);
  const rects = dockRectsForEdge(rect, monitor, edge, FLOATING_DOCK_SLIVER_PX);
  const session: DockSession = { edge, monitor, rects, size: { width: rect.width, height: rect.height }, hidden, lastHoverAt: Date.now() };
  dockSessions.set(window.label, session);
  await setWindowPosition(window, hidden ? rects.tucked : rects.revealed);
  session.timer = setInterval(() => {
    const live = dockSessions.get(window.label);
    if (!live) return;
    // A drag owns the window; re-arm the idle clock so it never tucks mid-drag.
    if (dragSessions.has(window.label)) {
      live.lastHoverAt = Date.now();
      return;
    }
    void import("@tauri-apps/api/window")
      .then(({ cursorPosition }) => cursorPosition())
      .then((cursor) => {
        const current = dockSessions.get(window.label);
        if (!current) return;
        const revealedRect: FloatingRect = { x: current.rects.revealed.x, y: current.rects.revealed.y, width: current.size.width, height: current.size.height };
        const overSliver = pointInRect(cursor, current.rects.sliver, FLOATING_DOCK_HOVER_PAD_PX);
        const overWidget = pointInRect(cursor, revealedRect, FLOATING_DOCK_HOVER_PAD_PX);
        if (current.hidden) {
          if (overSliver) {
            current.hidden = false;
            current.lastHoverAt = Date.now();
            void setWindowPosition(window, current.rects.revealed);
          }
        } else if (overWidget || overSliver) {
          current.lastHoverAt = Date.now();
        } else if (Date.now() - current.lastHoverAt > FLOATING_DOCK_IDLE_MS) {
          current.hidden = true;
          void setWindowPosition(window, current.rects.tucked);
        }
      })
      .catch(() => undefined);
  }, FLOATING_DOCK_POLL_MS);
}

/** Re-derives a docked window's tuck/reveal geometry after its size changed. */
async function refreshFloatingDock(window: DockableWindow): Promise<void> {
  const session = dockSessions.get(window.label);
  if (!session) return;
  const rect = await currentWindowRect(window);
  if (!rect) return;
  session.size = { width: rect.width, height: rect.height };
  session.rects = dockRectsForEdge(rect, session.monitor, session.edge, FLOATING_DOCK_SLIVER_PX);
  await setWindowPosition(window, session.hidden ? session.rects.tucked : session.rects.revealed);
}

/**
 * Re-arms the dock for a freshly opened floating window whose stored position
 * carries an edge — the user had left it parked on that edge. It opens as a full,
 * readable capsule and only tucks once the cursor has been away for a moment: a
 * widget the user just summoned should not greet them as a sliver. A window with
 * no docked home (a fresh minimize) gets no dock at all and simply stays a capsule,
 * even though the default placement sits against the edge.
 */
export async function resumeFloatingDock(): Promise<void> {
  if (!isTauriRuntime() || !isFloatingPluginWindow()) return;
  const context = resolveWindowContext();
  if (context.kind !== "plugin-window") return;
  const stored = parseFloatingPosition(safeLocalStorageGet(floatingPositionStorageKey(context.pluginId, context.contributionId)));
  if (!stored?.edge) return;
  const window = await ownFloatingWindow();
  if (dockSessions.has(window.label)) return;
  const [rect, monitors] = await Promise.all([currentWindowRect(window), listMonitors()]);
  const monitor = pickMonitorForPoint(stored, monitors) ?? monitors[0];
  if (!rect || !monitor) return;
  await dockFloatingWindow(window, stored.edge, monitor, rect, false);
}

/** Resizes the calling floating window (logical pixels). */
export async function setFloatingWindowSize(width: number, height: number): Promise<void> {
  const window = await ownFloatingWindow();
  const size = clampFloatingSize(width, height);
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  await window.setSize(new LogicalSize(size.width, size.height));
  // A resized window hangs over the edge it was docked to with the old geometry;
  // re-derive tuck/reveal before persisting anything.
  await refreshFloatingDock(window);
  // Keep the stored position honest so the next open lands where this one sits.
  const scaleFactor = (await window.scaleFactor().catch(() => 1)) || 1;
  const docked = dockSessions.get(window.label);
  const position = docked ? docked.rects.revealed : await window.outerPosition().catch(() => null);
  if (position) persistOwnPosition(position, scaleFactor, docked?.edge);
}

const FLOATING_REAPER_INTERVAL_MS = 8_000;
const FLOATING_REAPER_REPLY_MS = 4_000;
const FLOATING_REAPER_MISSES = 2;
/** A window gets this long to finish booting before silence counts against it. */
const FLOATING_REAPER_GRACE_MS = 15_000;
const reaperLastSeen = new Map<string, number>();
const reaperMisses = new Map<string, number>();
const reaperFirstSeen = new Map<string, number>();

/**
 * Reaps floating windows whose webview stopped answering. A renderer that dies
 * mid-session leaves an opaque rectangle on the desktop with no capsule and no
 * buttons — nothing inside it can dismiss it, and a frameless window gives the
 * user no close affordance — so the main window has to. Floating shells answer
 * FLOATING_WEBVIEW_HELLO with FLOATING_WEBVIEW_READY (the same handshake that
 * proves a freshly created window mounted), so two silent cycles mean dead.
 */
export function startFloatingWindowReaper(): () => void {
  if (!isTauriRuntime()) return () => undefined;
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ label?: unknown }>(FLOATING_WEBVIEW_READY_EVENT, (message) => {
        const label = message.payload && typeof message.payload.label === "string" ? message.payload.label : "";
        if (label) {
          reaperLastSeen.set(label, Date.now());
          reaperMisses.delete(label);
        }
      }),
    )
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    });
  const timer = setInterval(() => {
    void (async () => {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const { emitTo } = await import("@tauri-apps/api/event");
      const labels = (await WebviewWindow.getAll()).map((window) => window.label).filter(isFloatingWindowLabel);
      // A label that disappeared (closed normally) must not carry its miss count
      // into the next window that reuses the same deterministic label.
      for (const label of [...reaperMisses.keys(), ...reaperFirstSeen.keys()]) {
        if (!labels.includes(label)) {
          reaperMisses.delete(label);
          reaperFirstSeen.delete(label);
        }
      }
      if (!labels.length) return;
      const cycle = Date.now();
      for (const label of labels) if (!reaperFirstSeen.has(label)) reaperFirstSeen.set(label, cycle);
      for (const label of labels) void emitTo(label, FLOATING_WEBVIEW_HELLO_EVENT, { from: "main" }).catch(() => undefined);
      setTimeout(() => {
        if (stopped) return;
        for (const label of labels) {
          if ((reaperLastSeen.get(label) ?? 0) >= cycle) {
            reaperMisses.delete(label);
            continue;
          }
          // Fresh windows are still booting (cold transforms can take a while);
          // silence only counts once the grace period is over.
          if (cycle - (reaperFirstSeen.get(label) ?? cycle) < FLOATING_REAPER_GRACE_MS) continue;
          const misses = (reaperMisses.get(label) ?? 0) + 1;
          reaperMisses.set(label, misses);
          if (misses >= FLOATING_REAPER_MISSES) {
            console.error("[DBX][plugin-floating:reap]", label, misses);
            reaperMisses.delete(label);
            reaperFirstSeen.delete(label);
            void closeFloatingWindows([label]);
          }
        }
      }, FLOATING_REAPER_REPLY_MS);
    })();
  }, FLOATING_REAPER_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    unlisten?.();
  };
}

/** Reveals the window once its plugin content has painted. */
export async function revealFloatingWindow(): Promise<void> {
  if (!isTauriRuntime() || !isFloatingPluginWindow()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  await window.show().catch((error: unknown) => console.error("[DBX][plugin-floating:show]", error));
  await window.setFocus().catch(() => undefined);
}

/**
 * Shell-bound navigation from a floating window: it has no tab strip, dock, or
 * panels of its own, so opening a workbench or a filesystem tab is forwarded to
 * the main window (which raises itself and creates the tab).
 */
export const FLOATING_OPEN_WORKBENCH_EVENT = "dbx:plugin-floating-open-workbench";
export const FLOATING_OPEN_FILESYSTEM_EVENT = "dbx:plugin-floating-open-filesystem";

export interface FloatingOpenWorkbenchPayload {
  pluginId: string;
  contributionId: string;
  title?: string;
  context?: Record<string, unknown>;
  forceNew?: boolean;
}

export interface FloatingOpenFilesystemPayload {
  pluginId: string;
  providerId: string;
  title?: string;
  rootUri?: string;
  context?: Record<string, unknown>;
}

export async function forwardFloatingToMainWindow(event: string, payload: unknown): Promise<void> {
  if (!isTauriRuntime()) throw new Error("Floating plugin windows require the desktop app");
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("main", event, payload);
}

interface WindowLike {
  label: string;
  outerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
}

async function currentWindowRect(window: WindowLike): Promise<FloatingRect | null> {
  try {
    const [position, size] = await Promise.all([window.outerPosition(), window.outerSize()]);
    if (!position || !size) return null;
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  } catch (error) {
    console.error("[DBX][plugin-floating:geometry]", error);
    return null;
  }
}

/** Stores a position under this window's own plugin identity (parsed from its URL). */
function persistOwnPosition(position: { x: number; y: number }, scaleFactor: number, edge?: FloatingDockEdge): void {
  const context = resolveWindowContext();
  if (context.kind !== "plugin-window") return;
  persistFloatingPosition(context.pluginId, context.contributionId, { x: position.x, y: position.y, scaleFactor, ...(edge ? { edge } : {}) });
}
