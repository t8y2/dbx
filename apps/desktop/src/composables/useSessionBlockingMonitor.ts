import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import { createSessionBlockingMonitor, monitorError, type MonitorContext, type MonitorError, type SessionSnapshot } from "@/lib/database/sessionBlockingMonitor";

export function useSessionBlockingMonitor(context: Readonly<Ref<MonitorContext | null>>, service = createSessionBlockingMonitor()) {
  const snapshot = shallowRef<SessionSnapshot | null>(null);
  const error = ref<MonitorError | null>(null);
  const pending = ref(false);
  const autoRefresh = ref(false);
  const now = ref(Date.now());
  const lastAttempt = ref(-Infinity);
  let generation = 0;
  let controller: AbortController | null = null;
  const stale = computed(() => !!snapshot.value && (now.value - Date.parse(snapshot.value.startedAt) >= 15_000 || error.value !== null));
  const canRefresh = computed(() => !!context.value && !pending.value && now.value - lastAttempt.value >= 5_000);
  function cancel() {
    autoRefresh.value = false;
    controller?.abort();
  }
  async function refresh() {
    now.value = Date.now();
    if (!canRefresh.value || !context.value) return;
    const target = { ...context.value };
    const current = generation;
    const operation = new AbortController();
    controller = operation;
    pending.value = true;
    error.value = null;
    lastAttempt.value = now.value;
    try {
      const result = await service.collect(target, operation.signal);
      if (current === generation && !operation.signal.aborted) snapshot.value = result;
      else if (current === generation) error.value = "cancelled";
    } catch (cause) {
      if (current === generation) error.value = monitorError(cause);
    } finally {
      if (current === generation) {
        pending.value = false;
        controller = null;
      }
    }
  }
  watch(
    context,
    () => {
      generation++;
      cancel();
      controller = null;
      snapshot.value = null;
      pending.value = false;
      error.value = null;
      autoRefresh.value = false;
      lastAttempt.value = -Infinity;
    },
    { flush: "sync" },
  );
  const timer = setInterval(() => {
    now.value = Date.now();
    if (autoRefresh.value && now.value - lastAttempt.value >= 10_000) void refresh();
  }, 1_000);
  onScopeDispose(() => {
    generation++;
    cancel();
    clearInterval(timer);
  });
  return { snapshot, error, pending, stale, autoRefresh, canRefresh, refresh, cancel };
}
