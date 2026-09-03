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
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const label = detachedWindowLabel(tabId);
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return { opened: true };
    }

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

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result: DetachedWindowOpenResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      void child.once("tauri://created", async () => {
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
        }
      });
      void child.once("tauri://error", (event) => {
        const error = errorMessage(event?.payload);
        console.error("[DBX][detached-tab:create:error]", error);
        finish({ opened: false, error });
      });
      setTimeout(() => finish({ opened: false, error: "Timed out while creating the detached window." }), 10_000);
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("[DBX][detached-tab:create:error]", error);
    return { opened: false, error: message };
  }
}
