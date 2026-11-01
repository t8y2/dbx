import { createApp } from "vue";
import ExportExecutionModeDialog from "@/components/export/ExportExecutionModeDialog.vue";
import i18n from "@/i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { ManualExportMode } from "./manualExportQueue";

export function showExportExecutionModeDialog(): Promise<ManualExportMode | null> {
  if (!isTauriRuntime() || typeof document === "undefined") return Promise.resolve("immediate");
  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.append(container);
    let settled = false;
    let app: ReturnType<typeof createApp> | undefined;
    const finish = (mode: ManualExportMode | null) => {
      if (settled) return;
      settled = true;
      resolve(mode);
      app?.unmount();
      container.remove();
    };
    app = createApp(ExportExecutionModeDialog, {
      open: true,
      onConfirm: (mode: ManualExportMode) => finish(mode),
      onCancel: () => finish(null),
    });
    app.use(i18n);
    app.mount(container);
  });
}
