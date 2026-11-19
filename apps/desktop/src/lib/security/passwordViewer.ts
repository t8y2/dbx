import { ref } from "vue";
import * as api from "@/lib/backend/api";

/** Whether the current backend allows the UI to reveal stored connection secrets. */
export const passwordViewerEnabled = ref(true);

let initialization: Promise<boolean> | null = null;

export function initializePasswordViewerCapability(): Promise<boolean> {
  if (!initialization) {
    initialization = api
      .loadWebCapabilities()
      .then((capabilities) => {
        passwordViewerEnabled.value = capabilities.passwordViewerEnabled !== false;
        return passwordViewerEnabled.value;
      })
      .catch(() => {
        passwordViewerEnabled.value = false;
        initialization = null;
        return false;
      });
  }
  return initialization;
}

export function isSavedCredential(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("__DBX_SAVED_CREDENTIAL__:");
}
