<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useFavoritesStore } from "@/stores/favoritesStore";
import FavoriteDialog from "./FavoriteDialog.vue";

const props = defineProps<{ active: boolean }>();
const store = useFavoritesStore();
watch(
  () => props.active,
  (active) => {
    if (!active) store.reset();
    else void store.refresh();
  },
  { immediate: true },
);
function refreshOnFocus() {
  if (props.active && store.initialized) void store.refresh();
}
onMounted(() => window.addEventListener("focus", refreshOnFocus));
onBeforeUnmount(() => {
  window.removeEventListener("focus", refreshOnFocus);
  store.reset();
});
</script>
<template><FavoriteDialog v-if="active" /></template>
