import { computed, nextTick, onActivated, onDeactivated, onUnmounted, ref, shallowRef, watch } from "vue";

type ViewMode = "dom" | "canvas";

/** Times the grid's DOM update or synchronous Canvas draw, excluding screen paint. */
export function useResultViewUpdateTiming<T extends object>(result: () => T, enabled: () => boolean, mode: () => ViewMode) {
  const lastMeasurement = shallowRef<{ result: T; mode: ViewMode; elapsedMs: number } | null>(null);
  const active = ref(true);
  let generation = 0;
  let pending: { result: T; mode: ViewMode; startedAt: number; generation: number } | null = null;

  function finish(current: T, currentMode: ViewMode, expectedGeneration: number) {
    if (!active.value || !enabled() || result() !== current || mode() !== currentMode) return;
    if (!pending || pending.result !== current || pending.mode !== currentMode || pending.generation !== expectedGeneration) return;
    lastMeasurement.value = { result: current, mode: currentMode, elapsedMs: Math.max(0, Math.round(performance.now() - pending.startedAt)) };
    pending = null;
  }

  function start(current: T, currentMode: ViewMode, isEnabled: boolean) {
    const currentGeneration = ++generation;
    lastMeasurement.value = null;
    pending = active.value && isEnabled ? { result: current, mode: currentMode, startedAt: performance.now(), generation: currentGeneration } : null;
    if (pending && currentMode === "dom") void nextTick(() => finish(current, "dom", currentGeneration));
  }

  watch(
    () => [result(), mode(), enabled()] as const,
    ([current, currentMode, isEnabled]) => start(current, currentMode, isEnabled),
    { immediate: true },
  );

  onDeactivated(() => {
    active.value = false;
    generation++;
    pending = null;
    lastMeasurement.value = null;
  });
  onActivated(() => {
    if (!active.value) {
      active.value = true;
      start(result(), mode(), enabled());
    }
  });
  onUnmounted(() => {
    active.value = false;
    generation++;
    pending = null;
  });

  return {
    elapsedMs: computed(() => {
      const measured = lastMeasurement.value;
      return active.value && enabled() && measured?.result === result() && measured.mode === mode() ? measured.elapsedMs : undefined;
    }),
    canvasDrawCompleted: (drawnResult: T) => {
      if (pending?.mode === "canvas") finish(drawnResult, "canvas", pending.generation);
    },
  };
}
