<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@lucide/vue";

const props = defineProps<{
  lastReloadedAt: string | null;
  reloadCount: number;
  reloading: boolean;
}>();

const emit = defineEmits<{
  apply: [];
  dismiss: [];
}>();

const { t } = useI18n();

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
</script>

<template>
  <div v-if="lastReloadedAt || reloadCount > 0" class="fixed bottom-4 right-4 z-50">
    <Tooltip>
      <TooltipTrigger as-child>
        <div class="flex items-center gap-2 rounded-lg border bg-card p-3 shadow-lg">
          <Loader2 v-if="reloading" class="h-4 w-4 animate-spin text-muted-foreground" />
          <span class="text-xs font-medium">{{ t("toolbar.configChanged") }}</span>
          <Button size="sm" variant="default" class="h-6 text-xs px-2" @click="emit('apply')">
            {{ t("toolbar.applyConfig") }}
          </Button>
          <Button size="sm" variant="ghost" class="h-6 text-xs px-2" @click="emit('dismiss')">
            {{ t("toolbar.dismiss") }}
          </Button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" class="text-xs">
        {{ lastReloadedAt ? formatTimestamp(lastReloadedAt) : "" }}
      </TooltipContent>
    </Tooltip>
  </div>
</template>
