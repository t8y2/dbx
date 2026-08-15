export interface SidebarSearchLoadingTracker {
  readonly isLoading: boolean;
  /** Marks a new search dispatch as in flight; returns a generation token for `end`. */
  begin(): number;
  /** Clears the loading state if `generation` is still the latest dispatch; returns whether it cleared. */
  end(generation: number): boolean;
  /** Immediately clears the loading state and invalidates any in-flight `end` calls (e.g. query cleared). */
  cancel(): void;
}

export function createSidebarSearchLoadingTracker(): SidebarSearchLoadingTracker {
  let generation = 0;
  let loading = false;

  return {
    get isLoading() {
      return loading;
    },
    begin() {
      generation += 1;
      loading = true;
      return generation;
    },
    end(calledGeneration: number) {
      if (calledGeneration !== generation) return false;
      loading = false;
      return true;
    },
    cancel() {
      generation += 1;
      loading = false;
    },
  };
}
