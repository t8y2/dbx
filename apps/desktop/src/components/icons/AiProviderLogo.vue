<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Settings2 } from "@lucide/vue";
import type { AiProvider } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";

const props = defineProps<{
  provider: AiProvider;
  label: string;
  iconSlug?: string;
}>();

const failed = ref(false);
const { isDark } = useTheme();

watch(
  () => props.iconSlug,
  () => {
    failed.value = false;
  },
);

const usesWhiteDarkIcon = computed(
  () =>
    props.provider === "claude" ||
    props.provider === "ollama" ||
    props.provider === "openai" ||
    props.provider === "openai-compatible",
);
const localIconUrl = computed(() =>
  props.provider === "openai" || props.provider === "openai-compatible" ? "/icons/ai/openai.svg" : "",
);
const iconUrl = computed(
  () =>
    localIconUrl.value ||
    (props.iconSlug
      ? `https://cdn.simpleicons.org/${props.iconSlug}${isDark.value && usesWhiteDarkIcon.value ? "/f8fafc" : ""}`
      : ""),
);
const fallbackText = computed(() => {
  if (props.provider === "openai-compatible") return "OC";
  return props.label.slice(0, 1).toUpperCase();
});
</script>

<template>
  <span class="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-sm">
    <Settings2 v-if="provider === 'custom'" class="h-4 w-4 text-muted-foreground" />
    <img
      v-else-if="iconUrl && !failed"
      :src="iconUrl"
      :alt="label"
      class="h-4 w-4 object-contain"
      :class="{ 'dark:invert': localIconUrl }"
      loading="lazy"
      @error="failed = true"
    />
    <span v-else class="flex h-4 w-4 items-center justify-center rounded-sm bg-muted text-[8px] font-semibold">
      {{ fallbackText }}
    </span>
  </span>
</template>
