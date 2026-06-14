<script setup lang="ts">
import { ref } from "vue";
import { Eye, EyeOff } from "@lucide/vue";
import { Input } from "@/components/ui/input";

const model = defineModel<string>();

const props = defineProps<{
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  inputClass?: string;
}>();

const visible = ref(false);
</script>

<template>
  <div :class="props.class" class="relative">
    <Input v-model="model" :type="visible ? 'text' : 'password'" :placeholder="placeholder" :disabled="disabled" :class="props.inputClass" class="pr-8" v-bind="$attrs" />
    <button type="button" :disabled="disabled" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:pointer-events-none" tabindex="-1" @click="visible = !visible">
      <Eye v-if="!visible" class="size-3.5" />
      <EyeOff v-else class="size-3.5" />
    </button>
  </div>
</template>
