import { computed, ref } from "vue";

const previewedUiFontFamily = ref<string | null>(null);

export function useUiFontFamilyPreview() {
  const uiFontFamilyPreview = computed(() => previewedUiFontFamily.value);

  function previewUiFontFamily(fontFamily: string) {
    const next = fontFamily.trim();
    if (!next) return;
    previewedUiFontFamily.value = next;
  }

  function clearUiFontFamilyPreview() {
    previewedUiFontFamily.value = null;
  }

  return { uiFontFamilyPreview, previewUiFontFamily, clearUiFontFamilyPreview };
}
