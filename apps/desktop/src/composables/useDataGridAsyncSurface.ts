import { ref, toValue, watch, type MaybeRefOrGetter } from "vue";

export function useDataGridAsyncSurface(open: MaybeRefOrGetter<boolean>) {
  const mounted = ref(false);

  watch(
    () => toValue(open),
    (value) => {
      // Preserve the existing dialog instance after its chunk loads so closing it does not reset local UI state.
      if (value) mounted.value = true;
    },
    { immediate: true },
  );

  return mounted;
}
