import { inject, type InjectionKey } from "vue";

/** Acquire a cache retention lease; release it after publishing mutation results. */
export const RETAIN_TAB_SURFACE: InjectionKey<() => () => void> = Symbol("retain-tab-surface");

export function useRetainTabSurface(): () => () => void {
  return inject(RETAIN_TAB_SURFACE, () => () => {});
}
