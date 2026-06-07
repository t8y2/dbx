<script setup lang="ts">
import { computed } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";

const settingsStore = useSettingsStore();
const isBlackLogo = computed(() => settingsStore.desktopSettings.icon_theme === "black");
const logoSrc = computed(() => (isBlackLogo.value ? "/logo-black.png" : "/logo.png"));
</script>

<template>
  <img :src="logoSrc" alt="DBX" :class="isBlackLogo ? 'dark:invert' : ''" />
</template>
