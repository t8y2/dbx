<script setup lang="ts">
import { X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { message, visible, action, persistentMessages, dismissToast } = useToast();
const newestFirst = computed(() => [...persistentMessages.value].reverse());
</script>

<template>
  <div class="pointer-events-none fixed bottom-6 inset-x-0 z-99999 mx-auto flex w-[90vw] max-w-3xl flex-col items-center gap-2">
    <div v-if="persistentMessages.length" class="pointer-events-auto flex max-h-[50vh] w-full flex-col gap-2 overflow-y-auto">
      <div v-for="entry in newestFirst" :key="entry.id" role="alert" class="flex w-full shrink-0 items-start gap-3 rounded-lg bg-foreground px-4 py-2 text-sm text-background-solid shadow-lg">
        <div class="min-w-0 flex-1">
          <div class="max-h-[30vh] overflow-y-auto select-text whitespace-pre-wrap break-words">{{ entry.message }}</div>
          <button v-if="entry.action" type="button" class="mt-2 rounded border border-background/40 bg-background/10 px-2 py-0.5 text-xs font-medium hover:bg-background/20" @click="entry.action.onClick()">
            {{ entry.action.label }}
          </button>
        </div>
        <button type="button" :aria-label="t('common.close')" :title="t('common.close')" class="shrink-0 rounded p-1 hover:bg-background/20 focus-visible:outline-2 focus-visible:outline-offset-2" @click="dismissToast(entry.id)">
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
    <Transition name="toast">
      <div v-if="visible" role="status" class="pointer-events-auto w-max max-w-full rounded-lg bg-foreground px-4 py-2 text-sm text-background-solid shadow-lg select-text whitespace-pre-wrap break-words">
        <span>{{ message }}</span>
        <button v-if="action" type="button" class="ml-3 shrink-0 rounded border border-background/40 bg-background/10 px-2 py-0.5 text-xs font-medium hover:bg-background/20" @click="action.onClick()">
          {{ action.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: 0.25s ease;
  transition-property: transform, opacity;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(100%) scale(0.95);
}
</style>
