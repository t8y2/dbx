<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Eye, EyeOff } from "@lucide/vue";
import { isSavedCredential, passwordViewerEnabled } from "@/lib/security/passwordViewer";

defineOptions({ inheritAttrs: false });
const model = defineModel<string>();
const savedCredential = computed(() => isSavedCredential(model.value));
const inputValue = computed({
  get: () => (savedCredential.value ? "" : model.value),
  set: (value: string) => {
    model.value = value;
  },
});
const visible = ref(false);
const { t } = useI18n();
const toggleLabel = computed(() => t(visible.value ? "common.hidePassword" : "common.showPassword"));
</script>

<template>
  <div class="relative">
    <textarea
      v-model="inputValue"
      :placeholder="savedCredential ? '••••••••' : undefined"
      v-bind="$attrs"
      :class="{ 'secret-masked': !visible || !passwordViewerEnabled }"
      class="min-h-20 w-full resize-y rounded-md border border-input bg-transparent py-2 pl-2.5 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      autocomplete="off"
      autocapitalize="off"
      :spellcheck="false"
    />
    <button v-if="passwordViewerEnabled && !savedCredential" type="button" class="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground" :aria-label="toggleLabel" :title="toggleLabel" :aria-pressed="visible" @click="visible = !visible">
      <Eye v-if="!visible" class="size-3.5" />
      <EyeOff v-else class="size-3.5" />
    </button>
  </div>
</template>

<style scoped>
.secret-masked {
  -webkit-text-security: disc;
}
</style>
