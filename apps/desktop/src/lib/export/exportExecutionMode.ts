import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ManualExportMode } from "./manualExportQueue";

export function getDefaultExportExecutionMode(): ManualExportMode {
  return isTauriRuntime() ? useSettingsStore().editorSettings.defaultExportMode : "immediate";
}
