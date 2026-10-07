<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Minus, Square, Copy, X } from "@lucide/vue";
import { getPlatform } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

interface LinuxWindowControlIcons {
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
}

const props = defineProps<{
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  minimize: [];
  "toggle-maximize": [];
  close: [];
}>();

// GNOME headerbars use round, symbolic Adwaita-style buttons rather than the
// full-height rectangular Windows buttons.
const isLinux = getPlatform() === "linux";

// Glyphs from the active GTK icon theme, used as CSS masks so they take the text
// colour and cannot run script. Null until loaded or when the theme lacks them,
// in which case the bundled inline icons below are used.
const themeIcons = ref<Record<keyof LinuxWindowControlIcons, string> | null>(null);
const maximizeMask = computed(() => (props.isMaximized ? themeIcons.value?.restore : themeIcons.value?.maximize));

function svgMask(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

onMounted(async () => {
  if (!isLinux || !isTauriRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const icons = await invoke<LinuxWindowControlIcons | null>("get_linux_window_control_icons");
    if (icons) {
      themeIcons.value = { minimize: svgMask(icons.minimize), maximize: svgMask(icons.maximize), restore: svgMask(icons.restore), close: svgMask(icons.close) };
    }
  } catch {
    // keep the bundled icons
  }
});
</script>

<template>
  <div v-if="isLinux" class="flex items-center gap-[13px] ml-1 mr-1">
    <button type="button" class="dbx-gnome-window-button" @click="emit('minimize')">
      <span v-if="themeIcons" class="dbx-gnome-window-glyph" :style="{ maskImage: themeIcons.minimize, WebkitMaskImage: themeIcons.minimize }" />
      <svg v-else viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 11.5h8" /></svg>
    </button>
    <button type="button" class="dbx-gnome-window-button" @click="emit('toggle-maximize')">
      <span v-if="themeIcons" class="dbx-gnome-window-glyph" :style="{ maskImage: maximizeMask, WebkitMaskImage: maximizeMask }" />
      <svg v-else-if="isMaximized" viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
        <path d="M5.5 5.5V4.25a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 .75.75v5.5a.75.75 0 0 1-.75.75H10.5" />
        <rect x="3.5" y="5.5" width="7" height="7" rx=".75" />
      </svg>
      <svg v-else viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3.5" y="3.5" width="9" height="9" rx="1" /></svg>
    </button>
    <button type="button" class="dbx-gnome-window-button" @click="emit('close')">
      <span v-if="themeIcons" class="dbx-gnome-window-glyph" :style="{ maskImage: themeIcons.close, WebkitMaskImage: themeIcons.close }" />
      <svg v-else viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
    </button>
  </div>
  <div v-else class="flex items-stretch -mr-2 ml-1">
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-foreground/10 transition-colors" @click="emit('minimize')">
      <Minus class="h-4 w-4" />
    </button>
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-foreground/10 transition-colors" @click="emit('toggle-maximize')">
      <Copy v-if="isMaximized" class="h-3.5 w-3.5" />
      <Square v-else class="h-3.5 w-3.5" />
    </button>
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-red-500 hover:text-white transition-colors" @click="emit('close')">
      <X class="h-4 w-4" />
    </button>
  </div>
</template>

<style scoped>
.dbx-gnome-window-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  color: var(--foreground);
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  transition: background-color 0.12s;
}

.dbx-gnome-window-glyph {
  display: block;
  width: 16px;
  height: 16px;
  background-color: currentColor;
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  -webkit-mask-size: contain;
}

.dbx-gnome-window-button:hover {
  background: color-mix(in srgb, var(--foreground) 16%, transparent);
}

.dbx-gnome-window-button:active {
  background: color-mix(in srgb, var(--foreground) 24%, transparent);
}
</style>
