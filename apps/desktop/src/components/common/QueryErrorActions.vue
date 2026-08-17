<script setup lang="ts">
import { computed } from "vue";
import { Bot, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import type { BackendError } from "@/lib/backend/errorUtils";
import { isConnectionTimeoutErrorMessage, isQueryTimeoutErrorMessage } from "@/lib/sql/queryError";

const props = defineProps<{
  errorMessage: string;
  backendError?: BackendError;
  connectionId?: string;
}>();

const emit = defineEmits<{
  changeConnectionTimeout: [];
  changeQueryTimeout: [];
  fixWithAi: [errorMessage: string];
}>();

const { t } = useI18n();
const showConnectionTimeout = computed(() => !!props.connectionId && isConnectionTimeoutErrorMessage(props.errorMessage, props.backendError));
const showQueryTimeout = computed(() => !!props.connectionId && !showConnectionTimeout.value && isQueryTimeoutErrorMessage(props.errorMessage, props.backendError));
</script>

<template>
  <Button v-if="showConnectionTimeout" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('changeConnectionTimeout')">
    <Wrench class="h-3.5 w-3.5" />
    {{ t("editor.changeConnectionTimeout") }}
  </Button>
  <Button v-if="showQueryTimeout" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('changeQueryTimeout')">
    <Wrench class="h-3.5 w-3.5" />
    {{ t("editor.changeQueryTimeout") }}
  </Button>
  <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="emit('fixWithAi', errorMessage)">
    <Bot class="h-3.5 w-3.5" />
    {{ t("ai.fixWithAi") }}
  </Button>
</template>
