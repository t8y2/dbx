<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Eye, EyeOff } from "@lucide/vue";
import { Input } from "@/components/ui/input";

const model = defineModel<string>();

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    inputClass?: string;
    showToggle?: boolean;
    showLabel?: string;
    hideLabel?: string;
  }>(),
  {
    showToggle: true,
  },
);

const visible = ref(false);
const { t } = useI18n();
const toggleLabel = computed(() => (visible.value ? props.hideLabel || t("common.hidePassword") : props.showLabel || t("common.showPassword")));
</script>

<template>
  <div :class="props.class" class="relative">
    <Input v-model="model" :type="visible ? 'text' : 'password'" :placeholder="placeholder" :disabled="disabled" :class="[props.inputClass, props.showToggle ? 'pr-8' : undefined]" v-bind="$attrs" />
    <button v-if="props.showToggle" type="button" :disabled="disabled" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50" :aria-label="toggleLabel" :title="toggleLabel" @click="visible = !visible">
      <Eye v-if="!visible" class="size-3.5" />
      <EyeOff v-else class="size-3.5" />
    </button>
  </div>
</template>

<style scoped>
:deep(input[type="password"]::-ms-reveal),
:deep(input[type="password"]::-ms-clear) {
  display: none;
}

:deep(input[type="password"]::-webkit-credentials-auto-fill-button),
:deep(input[type="password"]::-webkit-caps-lock-indicator),
:deep(input[type="password"]::-webkit-contacts-auto-fill-button) {
  display: none !important;
  visibility: hidden;
  pointer-events: none;
}
</style>
