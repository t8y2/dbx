import { defineStore } from "pinia";
import { ref } from "vue";

interface SavedSqlFolderPasswordRequest {
  folderId: string;
  folderName: string;
  verify: (password: string) => Promise<boolean>;
}

export const useSavedSqlFolderPasswordPromptStore = defineStore("savedSqlFolderPasswordPrompt", () => {
  const current = ref<SavedSqlFolderPasswordRequest | null>(null);
  let resolveCurrent: ((result: boolean) => void) | null = null;

  function requestPassword(request: SavedSqlFolderPasswordRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (current.value) {
        // Only one prompt at a time; reject new requests while one is open.
        resolve(false);
        return;
      }
      current.value = request;
      resolveCurrent = resolve;
    });
  }

  function resolve(result: boolean) {
    if (resolveCurrent) {
      resolveCurrent(result);
      resolveCurrent = null;
    }
    current.value = null;
  }

  return {
    current,
    requestPassword,
    resolve,
  };
});
