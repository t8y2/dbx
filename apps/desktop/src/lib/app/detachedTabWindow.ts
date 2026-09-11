import { assertUpdateAllowsInteraction, beginUpdateSensitiveOperation } from "@/lib/app/updatePreparation";
import { detachedWindowLabel, detachedWindowUrl } from "@/lib/app/windowContext";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export interface DetachedWindowOpenPosition {
  x: number;
  y: number;
}

export interface DetachedWindowOpenResult {
  opened: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error || "Unknown window creation error");
}

export async function openDetachedTabWindow(tabId: string, title: string, position?: DetachedWindowOpenPosition): Promise<DetachedWindowOpenResult> {
  if (!isTauriRuntime()) return { opened: false, error: "Detached windows are only available in the desktop app." };
  let finishOperation: (() => void) | undefined;
  try {
    finishOperation = beginUpdateSensitiveOperation();
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = detachedWindowLabel(tabId);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return { opened: true };
    }

    assertUpdateAllowsInteraction();
    const child = new WebviewWindow(label, {
      url: detachedWindowUrl(tabId),
      title,
      width: 1100,
      height: 720,
      minWidth: 760,
      minHeight: 600,
      resizable: true,
      visible: false,
      decorations: false,
      center: false,
    });

    // A caller timeout does not prove native window creation has stopped.
    // Keep this second reservation until a native terminal event arrives.
    const finishNativeCreation = beginUpdateSensitiveOperation();
    return await new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: DetachedWindowOpenResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      void child.once("tauri://created", async () => {
        if (timedOut) {
          try {
            // The caller already restored its tab; never surface a duplicate.
            await child.destroy();
            finishNativeCreation();
          } catch (error) {
            // Keep the reservation if removal is uncertain, rather than
            // allowing restart to race a still-initializing webview.
            console.error("[DBX][detached-tab:late-create:close-error]", error);
          }
          return;
        }
        try {
          if (position) {
            const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
            await child.setPosition(new PhysicalPosition(Math.round(position.x - 120), Math.round(position.y - 20)));
          }
          await child.show();
          await child.setFocus();
          finish({ opened: true });
        } catch (error) {
          finish({ opened: false, error: errorMessage(error) });
        } finally {
          finishNativeCreation();
        }
      });
      void child.once("tauri://error", (event) => {
        const error = errorMessage(event?.payload);
        console.error("[DBX][detached-tab:create:error]", error);
        finish({ opened: false, error });
        finishNativeCreation();
      });
      timeout = setTimeout(() => {
        timedOut = true;
        finish({ opened: false, error: "Timed out while creating the detached window." });
      }, 10_000);
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("[DBX][detached-tab:create:error]", error);
    return { opened: false, error: message };
  } finally {
    finishOperation?.();
  }
}
