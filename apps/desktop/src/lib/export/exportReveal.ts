import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { revealExportedPath } from "@/lib/export/exportPath";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ToastAction } from "@/composables/useToast";

export function shouldAutoRevealExportedFile(): boolean {
  if (!isTauriRuntime()) return false;
  try {
    const settings = useSettingsStore().editorSettings;
    return Boolean(settings?.autoOpenExportFolder);
  } catch {
    return false;
  }
}

export async function revealExportedFile(filePath: string, onError?: (error: unknown) => void): Promise<boolean> {
  const trimmed = filePath?.trim();
  if (!trimmed || !isTauriRuntime()) return false;
  try {
    await revealExportedPath(trimmed);
    return true;
  } catch (error) {
    if (onError) {
      onError(error);
    } else {
      console.warn("Failed to reveal exported file in file manager:", error);
    }
    return false;
  }
}

export interface NotifyExportCompleteOptions {
  filePath?: string | null;
  message: string;
  openFolderLabel?: string;
  toast: (msg: string, duration?: number, action?: ToastAction) => void;
  duration?: number;
}

export function notifyExportComplete(options: NotifyExportCompleteOptions): void {
  const { filePath, message, openFolderLabel, toast } = options;
  const trimmed = filePath?.trim();
  const canReveal = Boolean(trimmed && isTauriRuntime());

  if (canReveal && trimmed && shouldAutoRevealExportedFile()) {
    void revealExportedFile(trimmed);
  }

  if (canReveal && trimmed && openFolderLabel) {
    const action: ToastAction = {
      label: openFolderLabel,
      onClick: () => {
        void revealExportedFile(trimmed);
      },
    };
    toast(message, options.duration ?? 4000, action);
  } else if (options.duration !== undefined) {
    toast(message, options.duration);
  } else {
    toast(message);
  }
}
