import { readonly, ref } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/**
 * Runtime UI tuning knobs, loaded once from `~/.dbx/ui-tuning.json` at
 * startup (desktop runtime only; web builds keep the defaults).
 *
 * These are power-user performance dials, deliberately not part of the
 * settings UI: edit the JSON file and restart the app to apply.
 */
export interface UiTuning {
  /**
   * While a panel divider is dragged, expensive subtrees (CodeMirror editor
   * box, DataGrid canvas) are pinned to an explicit pixel size and only
   * re-measured every N animation frames. 1 = update on every frame (full
   * tracking), 5 ≈ 12fps stepping, 10 ≈ 6fps. Clamped to 1..10.
   */
  panelResizeTrackEveryFrames: number;
}

export const DEFAULT_UI_TUNING: UiTuning = {
  panelResizeTrackEveryFrames: 5,
};

const MAX_TRACK_EVERY_FRAMES = 10;

const state = ref<UiTuning>({ ...DEFAULT_UI_TUNING });
export const uiTuning = readonly(state);

function sanitizeFrames(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_UI_TUNING.panelResizeTrackEveryFrames;
  return Math.min(MAX_TRACK_EVERY_FRAMES, Math.max(1, Math.round(parsed)));
}

let loading: Promise<void> | null = null;

/** Reads `~/.dbx/ui-tuning.json` once; safe to call repeatedly. */
export function loadUiTuning(): Promise<void> {
  loading ??= (async () => {
    if (!isTauriRuntime()) return;
    try {
      const { homeDir, join } = await import("@tauri-apps/api/path");
      const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
      const file = await join(await homeDir(), ".dbx", "ui-tuning.json");
      if (!(await exists(file))) return;
      const parsed = JSON.parse(await readTextFile(file)) as Partial<UiTuning>;
      state.value = {
        panelResizeTrackEveryFrames: sanitizeFrames(parsed.panelResizeTrackEveryFrames),
      };
      console.info("[ui-tuning] loaded", file, state.value);
    } catch (error) {
      console.info("[ui-tuning] using defaults (could not read ~/.dbx/ui-tuning.json)", error);
    }
  })();
  return loading;
}
