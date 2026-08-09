<script setup lang="ts">
import { computed } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { webPath } from "@/lib/common/webPath";

const settingsStore = useSettingsStore();
const isBlackLogo = computed(() => settingsStore.desktopSettings.icon_theme === "black");
const logoSrc = computed(() => webPath(isBlackLogo.value ? "/logo-black.png" : "/logo.png"));
</script>

<template>
  <img :src="logoSrc" alt="DBX" :class="isBlackLogo ? 'dark:invert' : ''" />
</template>
