<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { PlugZap } from "@lucide/vue";
import * as api from "@/lib/backend/api";

const props = defineProps<{
  pluginId: string;
  icon?: string;
}>();

const objectUrl = ref("");
const failed = ref(false);
let ownsObjectUrl = false;
let requestSequence = 0;

function clearObjectUrl() {
  if (!objectUrl.value) return;
  if (ownsObjectUrl) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
  ownsObjectUrl = false;
}

function showFallback() {
  clearObjectUrl();
  failed.value = true;
}

watch(
  () => [props.pluginId, props.icon] as const,
  async ([pluginId, icon]) => {
    const sequence = ++requestSequence;
    clearObjectUrl();
    if (!pluginId || !icon) {
      failed.value = true;
      return;
    }
    failed.value = false;
    if (/^https?:\/\//i.test(icon)) {
      objectUrl.value = icon;
      return;
    }
    try {
      const asset = await api.readPluginAsset(pluginId, icon);
      if (!asset.contentType.startsWith("image/")) throw new Error("Plugin icon is not an image");
      const binary = atob(asset.dataBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: asset.contentType }));
      if (sequence !== requestSequence) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrl.value = url;
      ownsObjectUrl = true;
    } catch {
      if (sequence === requestSequence) failed.value = true;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  requestSequence += 1;
  clearObjectUrl();
});
</script>

<template>
  <span class="inline-flex shrink-0 items-center justify-center">
    <img v-if="objectUrl && !failed" :src="objectUrl" alt="" class="size-full object-contain" @error="showFallback" />
    <PlugZap v-else aria-hidden="true" class="size-full text-violet-500" />
  </span>
</template>
