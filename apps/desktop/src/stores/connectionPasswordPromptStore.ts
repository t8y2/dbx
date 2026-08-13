import { ref } from "vue";
import { defineStore } from "pinia";

export interface ConnectionPasswordPromptRequest {
  connectionId: string;
  connectionName: string;
}

export interface ConnectionPasswordPromptResult {
  password: string;
  rememberPassword: boolean;
}

interface QueuedPasswordPrompt {
  request: ConnectionPasswordPromptRequest;
  resolve: (result: ConnectionPasswordPromptResult | null) => void;
}

/**
 * Coordinates the shared password dialog. The store only returns the password
 * and the user's remember preference; the connection flow decides whether to
 * persist it after authentication succeeds. Concurrent requests are queued so
 * each prompt is shown and answered exactly once. A `null` result means the
 * user cancelled.
 */
export const useConnectionPasswordPromptStore = defineStore("connectionPasswordPrompt", () => {
  const pending = ref<ConnectionPasswordPromptRequest>();
  const queue: QueuedPasswordPrompt[] = [];
  let resolvePending: ((result: ConnectionPasswordPromptResult | null) => void) | undefined;

  function requestPassword(request: ConnectionPasswordPromptRequest): Promise<ConnectionPasswordPromptResult | null> {
    return new Promise<ConnectionPasswordPromptResult | null>((resolve) => {
      if (pending.value) {
        queue.push({ request, resolve });
        return;
      }
      beginRequest(request, resolve);
    });
  }

  function beginRequest(request: ConnectionPasswordPromptRequest, resolve: (result: ConnectionPasswordPromptResult | null) => void) {
    pending.value = request;
    resolvePending = resolve;
  }

  function settle(result: ConnectionPasswordPromptResult | null) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(result);

    const next = queue.shift();
    if (next) beginRequest(next.request, next.resolve);
  }

  function submit(password: string, rememberPassword: boolean) {
    settle({ password, rememberPassword });
  }

  function cancel() {
    settle(null);
  }

  return { pending, requestPassword, submit, cancel };
});
