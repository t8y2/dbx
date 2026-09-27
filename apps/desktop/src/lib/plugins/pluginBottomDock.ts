// PR-A4/P2 global bottom dock (HOST_PLUGIN_UI_SPEC §8.3) — VS Code-style
// terminal panel: N docked terminal entries (local shells + SSH connection
// sessions of plugin-backed connections), switchable from the tab strip,
// alive across pages. Each entry owns a host-generated workbenchId (= entry
// id) that stays stable for the entry's lifetime, so switching tabs keeps
// sessions alive and reopening never leaks PTYs. The reuse key includes the
// presentation: dock (panel) instances and tab instances coexist.
import { ref } from "vue";
import { uuid } from "@/lib/common/utils";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const DOCK_HEIGHT_PX = 320;
export const DOCK_MIN_HEIGHT_PX = 140;
/** One bound for the drag ceiling and the maximize height: a dragged dock must never shrink when the maximize button is pressed. */
export const DOCK_MAX_VIEWPORT_RATIO = 0.8;
const DOCK_HEIGHT_STORAGE_KEY = "dbx-plugin-dock-height";

export interface PluginDockEntry {
  /** Host-generated stable instance id; doubles as the entry workbench's workbenchId. */
  id: string;
  pluginId: string;
  workbenchContributionId: string;
  kind: "command" | "connection";
  /** Source command short id (present for kind=command), replayed by the generic "+". */
  commandId?: string;
  /** §4.1 instance_key of the source command; groups the entry into the command's singleton reuse key. */
  instanceKey?: string;
  title: string;
  icon?: string;
  /** Host-authored context: workbenchId=id, restored=false, surface="panel". */
  context: Record<string, unknown>;
}

const dockEntries = ref<PluginDockEntry[]>([]);
const activeEntryId = ref<string | null>(null);
const dockVisible = ref(false);
const dockMaximized = ref(false);

export interface AddPluginDockEntryPayload {
  pluginId: string;
  workbenchContributionId: string;
  kind: PluginDockEntry["kind"];
  commandId?: string;
  /** §4.1 instance_key of the source command. */
  instanceKey?: string;
  title: string;
  icon?: string;
  commandContext?: Record<string, unknown>;
}

/** Creates (and activates) a dock terminal entry; returns its stable id. */
export function addPluginDockEntry(payload: AddPluginDockEntryPayload): string {
  const id = uuid();
  // A sequence suffix is only added on a title collision within the same
  // command family ("Local terminal", "Local terminal 2", ...). Distinct
  // titles — e.g. named SSH connections — keep their name verbatim. Numbers
  // pick the lowest free slot, so a closed entry's number is reused instead
  // of climbing forever (titles stay unique among live entries, which is all
  // the tab strip needs to keep panels distinguishable).
  const siblings = dockEntries.value.filter((entry) => entry.pluginId === payload.pluginId && entry.commandId === payload.commandId);
  const taken = new Set(siblings.map((entry) => entry.title));
  let title = payload.title;
  if (taken.has(title)) {
    let suffix = 2;
    while (taken.has(`${payload.title} ${suffix}`)) suffix += 1;
    title = `${payload.title} ${suffix}`;
  }
  dockEntries.value.push({
    id,
    pluginId: payload.pluginId,
    workbenchContributionId: payload.workbenchContributionId,
    kind: payload.kind,
    commandId: payload.commandId,
    instanceKey: payload.instanceKey,
    title,
    icon: payload.icon,
    context: {
      ...(payload.commandContext ?? {}),
      workbenchId: id,
      restored: false,
      surface: "panel",
    },
  });
  activeEntryId.value = id;
  dockVisible.value = true;
  return id;
}

/**
 * Singleton reuse lookup for command executions (§4.1): the reuse key is
 * pluginId + commandId + presentation + instance_key, and the presentation is
 * fixed to "panel" here — dock entries and workbench tabs never reuse across
 * surfaces. Dock "+"-menu entries (kind "connection") are deliberate
 * multi-open instances and are never reuse candidates.
 */
export function findReusableDockEntry(pluginId: string, commandId: string, instanceKey?: string): PluginDockEntry | undefined {
  return dockEntries.value.find((entry) => entry.kind === "command" && entry.pluginId === pluginId && entry.commandId === commandId && (entry.instanceKey ?? undefined) === (instanceKey ?? undefined));
}

export function activatePluginDockEntry(id: string): void {
  if (dockEntries.value.some((entry) => entry.id === id)) {
    activeEntryId.value = id;
    dockVisible.value = true;
  }
}

/** Removes one terminal entry (its scope is reclaimed with the host bridge teardown). */
export function closePluginDockEntry(id: string): void {
  const index = dockEntries.value.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  dockEntries.value.splice(index, 1);
  if (activeEntryId.value === id) {
    const neighbor = dockEntries.value[index - 1] ?? dockEntries.value[index] ?? null;
    activeEntryId.value = neighbor?.id ?? null;
  }
  if (!dockEntries.value.length) dockVisible.value = false;
}

/** Drag & drop reorder: moves the entry to the target index (clamped). */
export function movePluginDockEntry(id: string, toIndex: number): void {
  const from = dockEntries.value.findIndex((entry) => entry.id === id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(toIndex, dockEntries.value.length - 1));
  if (to === from) return;
  const [entry] = dockEntries.value.splice(from, 1);
  dockEntries.value.splice(to, 0, entry);
}

/** Tab rename (double-click): blank titles keep the current one (stable titles). */
export function renamePluginDockEntry(id: string, title: string): void {
  const entry = dockEntries.value.find((candidate) => candidate.id === id);
  const next = title.trim();
  if (!entry || !next) return;
  entry.title = next;
}

/** Hides/shows the panel without killing the terminal sessions. */
export function setDockVisible(visible: boolean): void {
  if (visible && !dockEntries.value.length) return;
  dockVisible.value = visible;
}

export function setDockMaximized(maximized: boolean): void {
  dockMaximized.value = maximized;
}

export function usePluginBottomDock() {
  return { entries: dockEntries, activeEntryId, visible: dockVisible, maximized: dockMaximized };
}

/**
 * UI-chrome persistence only: the dragged dock height survives restarts. Dock
 * entries themselves are never persisted or restored (§8.4 restore:"none" —
 * no shell may come back with the app). The stored height is clamped to the
 * current viewport, so a smaller window cannot inherit an oversized dock.
 */
export function restoreDockHeight(viewportHeight: number): number {
  const stored = Number(safeLocalStorageGet(DOCK_HEIGHT_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return DOCK_HEIGHT_PX;
  const max = Math.max(DOCK_MIN_HEIGHT_PX, Math.floor(viewportHeight * DOCK_MAX_VIEWPORT_RATIO));
  return Math.min(Math.max(stored, DOCK_MIN_HEIGHT_PX), max);
}

export function persistDockHeight(height: number): void {
  safeLocalStorageSet(DOCK_HEIGHT_STORAGE_KEY, String(Math.round(height)));
}
