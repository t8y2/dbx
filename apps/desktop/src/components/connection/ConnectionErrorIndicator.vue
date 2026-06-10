<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, X } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useConnectionStore } from "@/stores/connectionStore";

const props = withDefaults(
  defineProps<{
    connectionId?: string | null;
    triggerClass?: string;
  }>(),
  {
    connectionId: null,
    triggerClass: "",
  },
);

const { t } = useI18n();
const connectionStore = useConnectionStore();

const errorMessage = computed(() => (props.connectionId ? connectionStore.connectionErrors[props.connectionId] : ""));

function clearError() {
  if (props.connectionId) connectionStore.clearConnectionError(props.connectionId);
}
</script>

<template>
  <Popover v-if="errorMessage">
    <PopoverTrigger as-child>
      <button type="button" class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-amber-500 hover:bg-amber-500/10 hover:text-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-500/40" :class="triggerClass" :title="t('connection.lastError')" @click.stop>
        <AlertTriangle class="h-3.5 w-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" class="w-72 gap-2 p-2 text-xs" @click.stop>
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="font-medium text-foreground">
            {{ t("connection.lastError") }}
          </div>
          <div class="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {{ errorMessage }}
          </div>
        </div>
        <button type="button" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('connection.clearError')" @click="clearError">
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
