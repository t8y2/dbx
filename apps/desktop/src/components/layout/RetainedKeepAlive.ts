import { defineComponent, h, KeepAlive, nextTick, provide, shallowRef, watch, type PropType } from "vue";
import { RETAIN_TAB_SURFACE } from "@/lib/tabs/retainTabSurface";

// Separate KeepAlive boundaries let us evict an idle entry without destroying a
// pending mutation. Inactive children still receive Vue's deactivation hooks.
const CacheEntry = defineComponent({
  props: {
    active: Boolean,
    retain: { type: Function as PropType<() => () => void>, required: true },
  },
  setup(props, { slots }) {
    provide(RETAIN_TAB_SURFACE, () => props.retain());
    return () => h(KeepAlive, null, { default: () => (props.active ? slots.default?.() : []) });
  },
});

/** LRU cache with temporary leases for operations owned by mounted surfaces. */
export default defineComponent({
  props: {
    cacheKey: { type: String, required: true },
    max: { type: Number, required: true },
  },
  setup(props, { slots }) {
    const keys = shallowRef<string[]>([]);
    const leases = new Map<string, number>();

    function prune() {
      const next = [...keys.value];
      while (next.length > props.max) {
        const index = next.findIndex((key) => key !== props.cacheKey && !leases.has(key));
        if (index < 0) break;
        next.splice(index, 1);
      }
      if (next.length !== keys.value.length) keys.value = next;
    }

    function retain(key: string) {
      leases.set(key, (leases.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (leases.get(key) ?? 1) - 1;
        if (remaining) leases.set(key, remaining);
        else leases.delete(key);
        // Flush session/dirty watchers before a completed surface can be evicted.
        void nextTick(prune);
      };
    }

    watch(
      () => props.cacheKey,
      (key) => {
        keys.value = [...keys.value.filter((entry) => entry !== key), key];
        prune();
      },
      { immediate: true, flush: "sync" },
    );
    watch(() => props.max, prune);

    return () =>
      keys.value.map((key) =>
        h(
          CacheEntry,
          {
            key,
            active: key === props.cacheKey,
            retain: () => retain(key),
          },
          { default: slots.default },
        ),
      );
  },
});
