import { ref, watch, type Ref } from "vue";

/**
 * Turns true the first time `source` is true and stays true afterwards.
 *
 * Heavy dialogs are async components that Vue resolves as soon as they are rendered, even with
 * `open` false, which pulls their whole dependency tree into WebView memory at app startup.
 * Rendering them with `v-if="mounted"` defers that cost to the first open, while keeping the
 * instance (and its form state) alive afterwards so closing and reopening behaves as before.
 * The consuming component must initialise from `open` on mount (`watch(..., { immediate: true })`),
 * because it is created with `open` already true.
 */
export function useMountedOnce(source: () => boolean): Ref<boolean> {
  const mounted = ref(source());
  if (!mounted.value) {
    const stop = watch(source, (value) => {
      if (!value) return;
      mounted.value = true;
      stop();
    });
  }
  return mounted;
}
