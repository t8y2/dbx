import { defineStore } from "pinia";
import { ref } from "vue";

export interface ResetProtectionPasswordTarget {
  targetType: "group" | "folder";
  id: string;
  name: string;
}

/**
 * Drives the global "reset protection password" confirmation dialog (web
 * only). Recovery path for forgotten folder/group protection passwords
 * (#11907): the dialog re-verifies the app's login password before the
 * backend clears the stored verifier.
 */
export const useResetProtectionPasswordPromptStore = defineStore("resetProtectionPasswordPrompt", () => {
  const current = ref<ResetProtectionPasswordTarget | null>(null);

  function requestReset(target: ResetProtectionPasswordTarget) {
    current.value = target;
  }

  function close() {
    current.value = null;
  }

  return {
    current,
    requestReset,
    close,
  };
});
