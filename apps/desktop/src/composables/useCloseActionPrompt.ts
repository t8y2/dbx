import { ref } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { invoke } from "@tauri-apps/api/core";

export type AppCloseAction = "quit" | "hide";
type AppCloseRequestTarget = "settings" | "quit";

export interface AppCloseRequestOptions {
  requireCloseActionChoice?: boolean;
}

interface AppCloseRequestPayload {
  payload?: AppCloseRequestTarget;
}

export function useCloseActionPrompt(options: { requestClose: (action: AppCloseAction, requestOptions?: AppCloseRequestOptions) => void }) {
  const settingsStore = useSettingsStore();
  const showCloseActionPrompt = ref(false);
  const unlistenHandles: Array<() => void> = [];

  function actionForRequest(target: AppCloseRequestTarget): AppCloseAction {
    if (target === "quit") return "quit";
    return settingsStore.desktopSettings.quit_on_close ? "quit" : "hide";
  }

  async function performCloseAction(action: AppCloseAction) {
    if (!isTauriRuntime()) return;
    await api.completeAppClose(action);
  }

  function handleCloseRequest(target: AppCloseRequestTarget = "settings") {
    const action = actionForRequest(target);
    options.requestClose(action, {
      requireCloseActionChoice: target === "settings" && !settingsStore.desktopSettings.close_action_prompted,
    });
  }

  async function applyCloseChoice(action: AppCloseAction) {
    showCloseActionPrompt.value = false;
    await settingsStore.updateDesktopSettings({
      quit_on_close: action === "quit",
      close_action_prompted: true,
    });
    options.requestClose(action, { requireCloseActionChoice: false });
  }

  function chooseQuit() {
    void applyCloseChoice("quit");
  }

  function chooseMinimize() {
    void applyCloseChoice("hide");
  }

  function cancelCloseActionPrompt() {
    showCloseActionPrompt.value = false;
  }

  function setupCloseActionPromptListener() {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      listen<AppCloseRequestTarget>("dbx-app-close-requested", (event: AppCloseRequestPayload) => {
        handleCloseRequest(event.payload === "quit" ? "quit" : "settings");
      }).then((unlisten) => {
        unlistenHandles.push(unlisten);
        // Rust falls back to native Quit until this listener is installed, so a
        // failed WebView2 startup cannot leave the tray request waiting forever.
        void invoke("mark_frontend_ready");
      });
    });
  }

  function cleanupCloseActionPromptListener() {
    unlistenHandles.forEach((unlisten) => unlisten());
    unlistenHandles.length = 0;
  }

  return {
    showCloseActionPrompt,
    chooseQuit,
    chooseMinimize,
    cancelCloseActionPrompt,
    performCloseAction,
    setupCloseActionPromptListener,
    cleanupCloseActionPromptListener,
  };
}
