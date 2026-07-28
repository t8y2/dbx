<script setup lang="ts">
import { Bot, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { isQueryTimeoutErrorMessage } from "@/lib/sql/queryError";

const props = defineProps<{
  errorMessage: string;
  connectionId?: string;
}>();

const emit = defineEmits<{
  changeQueryTimeout: [];
  fixWithAi: [errorMessage: string];
}>();

const { t } = useI18n();
</script>

<template>
  <Button v-if="connectionId && isQueryTimeoutErrorMessage(errorMessage)" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('changeQueryTimeout')">
    <Wrench class="h-3.5 w-3.5" />
    {{ t("editor.changeQueryTimeout") }}
  </Button>
  <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('fixWithAi', errorMessage)">
    <Bot class="h-3.5 w-3.5" />
    {{ t("ai.fixWithAi") }}
  </Button>
</template>
