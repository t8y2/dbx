<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  contributionId: String,
  loadIcon: { type: Function, required: true },
  connected: { type: Boolean, default: undefined },
});
const source = ref("");
let generation = 0;
watch(
  () => [props.contributionId, props.loadIcon],
  async ([contributionId, loadIcon]) => {
    const current = ++generation;
    source.value = "";
    try {
      const asset = await loadIcon(contributionId);
      if (current === generation && /^image\/(svg\+xml|png|jpeg|gif|webp)$/.test(asset?.contentType) && typeof asset.dataBase64 === "string") {
        source.value = `data:${asset.contentType};base64,${asset.dataBase64}`;
      }
    } catch {
      if (current === generation) source.value = "";
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => generation++);
</script>

<template>
  <span class="relative inline-flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
    <img v-if="source" :src="source" alt="" class="size-full object-contain" @error="source = ''" />
    <slot v-else />
    <span v-if="source && connected !== undefined" :data-connected="connected" class="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-base-200" :class="connected ? 'bg-success' : 'bg-base-content/40'" />
  </span>
</template>
