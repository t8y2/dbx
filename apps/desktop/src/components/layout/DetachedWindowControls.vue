<script setup lang="ts">
// 分离子窗口（无边框）的最小化/最大化按钮，紧凑尺寸匹配面板 h-9 header。
// 关闭按钮沿用各面板自身的 close 逻辑（DetachedPanelApp 关闭当前窗口），这里不重复。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Copy, Minus, Square } from "@lucide/vue";
import { Button } from "@/components/ui/button";

const isMaximized = ref(false);

let unlisten: (() => void) | null = null;

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function minimize() {
  try {
    await (await currentWindow()).minimize();
  } catch (error) {
    console.error("[detached-panel] minimize failed", error);
  }
}

async function toggleMaximize() {
  try {
    const win = await currentWindow();
    await win.toggleMaximize();
    isMaximized.value = await win.isMaximized();
  } catch (error) {
    console.error("[detached-panel] toggle maximize failed", error);
  }
}

onMounted(async () => {
  try {
    const win = await currentWindow();
    isMaximized.value = await win.isMaximized();
    unlisten = await win.onResized(() => {
      void win
        .isMaximized()
        .then((value) => (isMaximized.value = value))
        .catch(() => {});
    });
  } catch (error) {
    console.error("[detached-panel] init window controls failed", error);
  }
});

onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});
</script>

<template>
  <Button variant="ghost" size="icon" class="h-5 w-5" @click="minimize">
    <Minus class="h-3 w-3" />
  </Button>
  <Button variant="ghost" size="icon" class="h-5 w-5" @click="toggleMaximize">
    <Copy v-if="isMaximized" class="h-2.5 w-2.5" />
    <Square v-else class="h-2.5 w-2.5" />
  </Button>
</template>
