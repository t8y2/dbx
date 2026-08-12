import { ref } from "vue";
import { defineStore } from "pinia";

export interface ConnectionPasswordPromptRequest {
  connectionId: string;
  connectionName: string;
}

interface QueuedPasswordPrompt {
  request: ConnectionPasswordPromptRequest;
  resolve: (password: string | null) => void;
}

/**
 * Coordinates the single "enter password for a connection that is set to not
 * save it locally" dialog shared by every connect surface. Mirrors the
 * production-safety confirmation store: a request is transient, never
 * persisted, and concurrent connects are queued so each prompt is shown and
 * answered exactly once. A `null` resolution means the user cancelled.
 */
export const useConnectionPasswordPromptStore = defineStore("connectionPasswordPrompt", () => {
  const pending = ref<ConnectionPasswordPromptRequest>();
  const queue: QueuedPasswordPrompt[] = [];
  let resolvePending: ((password: string | null) => void) | undefined;

  function requestPassword(request: ConnectionPasswordPromptRequest): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (pending.value) {
        queue.push({ request, resolve });
        return;
      }
      beginRequest(request, resolve);
    });
  }

  function beginRequest(request: ConnectionPasswordPromptRequest, resolve: (password: string | null) => void) {
    pending.value = request;
    resolvePending = resolve;
  }

  function settle(password: string | null) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(password);

    const next = queue.shift();
    if (next) beginRequest(next.request, next.resolve);
  }

  function submit(password: string) {
    settle(password);
  }

  function cancel() {
    settle(null);
  }

  return { pending, requestPassword, submit, cancel };
});
