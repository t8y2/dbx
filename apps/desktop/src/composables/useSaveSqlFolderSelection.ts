import { readonly, ref } from "vue";

export function useSaveSqlFolderSelection(initialSelection: string) {
  const selection = ref(initialSelection);
  const pending = ref(false);
  const isCreating = ref(false);
  const newFolderName = ref("");
  let generation = 0;

  function reset(value: string) {
    generation++;
    pending.value = false;
    isCreating.value = false;
    newFolderName.value = "";
    selection.value = value;
  }

  function invalidate() {
    generation++;
    pending.value = false;
    isCreating.value = false;
    newFolderName.value = "";
  }

  function startCreating() {
    if (pending.value) return;
    isCreating.value = true;
    newFolderName.value = "";
  }

  function cancelCreating() {
    isCreating.value = false;
    newFolderName.value = "";
  }

  async function select(value: string, create?: () => Promise<string>, onError?: (error: unknown) => void): Promise<boolean> {
    if (pending.value) return false;
    if (!create) {
      selection.value = value;
      return true;
    }

    const previousSelection = selection.value;
    const requestGeneration = generation;
    pending.value = true;
    try {
      const createdSelection = await create();
      // A closed or reopened dialog owns a newer selection session.
      if (requestGeneration !== generation) return false;
      selection.value = createdSelection;
      return true;
    } catch (error) {
      if (requestGeneration !== generation) return false;
      selection.value = previousSelection;
      onError?.(error);
      return false;
    } finally {
      if (requestGeneration === generation) pending.value = false;
    }
  }

  async function confirmCreating(create: (name: string) => Promise<string>, onError?: (error: unknown) => void): Promise<boolean> {
    const name = newFolderName.value.trim();
    if (!name || pending.value) return false;

    const previousSelection = selection.value;
    const requestGeneration = generation;
    pending.value = true;
    try {
      const createdSelection = await create(name);
      if (requestGeneration !== generation) return false;
      selection.value = createdSelection;
      isCreating.value = false;
      newFolderName.value = "";
      return true;
    } catch (error) {
      if (requestGeneration !== generation) return false;
      selection.value = previousSelection;
      onError?.(error);
      return false;
    } finally {
      if (requestGeneration === generation) pending.value = false;
    }
  }

  return {
    selection,
    pending: readonly(pending),
    isCreating,
    newFolderName,
    startCreating,
    cancelCreating,
    confirmCreating,
    reset,
    invalidate,
    select,
  };
}
