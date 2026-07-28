import { readonly, ref } from "vue";

export function useSaveSqlFolderSelection(initialSelection: string) {
  const selection = ref(initialSelection);
  const pending = ref(false);
  let generation = 0;

  function reset(value: string) {
    generation++;
    pending.value = false;
    selection.value = value;
  }

  function invalidate() {
    generation++;
    pending.value = false;
  }

  async function select(value: string, create?: () => Promise<string>, onError?: (error: unknown) => void) {
    if (pending.value) return;
    if (!create) {
      selection.value = value;
      return;
    }

    const previousSelection = selection.value;
    const requestGeneration = generation;
    pending.value = true;
    try {
      const createdSelection = await create();
      // A closed or reopened dialog owns a newer selection session.
      if (requestGeneration !== generation) return;
      selection.value = createdSelection;
    } catch (error) {
      if (requestGeneration !== generation) return;
      selection.value = previousSelection;
      onError?.(error);
    } finally {
      if (requestGeneration === generation) pending.value = false;
    }
  }

  return {
    selection,
    pending: readonly(pending),
    reset,
    invalidate,
    select,
  };
}
