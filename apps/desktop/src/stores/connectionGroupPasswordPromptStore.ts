import { defineStore } from "pinia";
import { ref } from "vue";

interface PasswordRequest {
  groupId: string;
  groupName: string;
  verify: (password: string) => Promise<boolean>;
}

export const useConnectionGroupPasswordPromptStore = defineStore("connectionGroupPasswordPrompt", () => {
  const queue = ref<PasswordRequest[]>([]);
  const current = ref<PasswordRequest | null>(null);
  let resolveCurrent: ((result: boolean) => void) | null = null;

  function requestPassword(request: PasswordRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!current.value) {
        current.value = request;
        resolveCurrent = resolve;
      } else {
        queue.value.push(request);
        // Will be resolved when it becomes current
        const originalResolve = resolve;
        const checkInterval = setInterval(() => {
          if (current.value === request) {
            clearInterval(checkInterval);
            resolveCurrent = originalResolve;
          }
        }, 50);
        // Store the interval to clear it later
        (request as any)._interval = checkInterval;
      }
    });
  }

  function resolve(result: boolean) {
    if (resolveCurrent) {
      resolveCurrent(result);
      resolveCurrent = null;
    }
    current.value = null;
    const next = queue.value.shift();
    if (next) {
      current.value = next;
      // Find and clear the interval
      if ((next as any)._interval) {
        clearInterval((next as any)._interval);
      }
    }
  }

  return {
    queue,
    current,
    requestPassword,
    resolve,
  };
});
