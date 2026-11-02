<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { PlugZap } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { resolvePluginIcon } from "@/lib/plugins/pluginIconResolver";

const props = defineProps<{
  pluginId: string;
  icon?: string;
  contributionId?: string;
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
  () => [props.pluginId, props.icon, props.contributionId] as const,
  async ([pluginId, icon, contributionId]) => {
    const sequence = ++requestSequence;
    clearObjectUrl();
    if (!pluginId) {
      failed.value = true;
      return;
    }
    failed.value = false;
    const resolvedIcon = icon || (await resolvePluginIcon(pluginId, contributionId).catch(() => undefined));
    if (sequence !== requestSequence || !resolvedIcon) {
      if (sequence === requestSequence) failed.value = true;
      return;
    }
    if (/^https?:\/\//i.test(resolvedIcon)) {
      objectUrl.value = resolvedIcon;
      return;
    }
    try {
      const asset = await api.readPluginAsset(pluginId, resolvedIcon);
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
