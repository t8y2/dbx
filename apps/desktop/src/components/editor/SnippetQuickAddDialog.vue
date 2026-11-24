<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ListPlus } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/composables/useToast";
import { uuid } from "@/lib/common/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SqlSnippet } from "@/types/database";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillBody: string;
}>();

const label = ref("");
const prefix = ref("");
const body = ref("");
const formRef = ref<HTMLFormElement | null>(null);

// Seeds the form each time the dialog opens. `immediate` covers a mount that
// already starts open (a remount while open would otherwise lose the prefill).
watch(
  open,
  (value) => {
    if (!value) return;
    label.value = "";
    prefix.value = "";
    // The editor selection at open time seeds the body; from then on it is a
    // plain draft (Settings → Snippets remains the full editor).
    body.value = props.prefillBody;
  },
  { immediate: true },
);

const trimmedPrefix = computed(() => prefix.value.trim());

// Live validation instead of save-time errors. The store's normalizer silently
// drops duplicate prefixes (normalizeSqlSnippets keeps the first), so a
// duplicate must be caught before it reaches updateEditorSettings.
const duplicatePrefix = computed(() => trimmedPrefix.value.length > 0 && settingsStore.editorSettings.snippets.some((snippet) => snippet.prefix === trimmedPrefix.value));

function focusPrefixInputOnOpen(event: Event) {
  // Reka focuses the first focusable control — the optional label input; the
  // prefix is the required field, so start typing there instead.
  event.preventDefault();
  formRef.value?.querySelector<HTMLInputElement>("#snippet-quick-add-prefix")?.focus();
}

function save() {
  if (!trimmedPrefix.value || duplicatePrefix.value) return;
  const snippet: SqlSnippet = {
    id: uuid(),
    label: label.value.trim() || trimmedPrefix.value,
    prefix: trimmedPrefix.value,
    body: body.value,
    enabled: true,
  };
  // Unlike the settings dialog's Apply-based draft list, this writes the new
  // snippet immediately — the same one-shot update toolbar toggles use.
  settingsStore.updateEditorSettings({ snippets: [...settingsStore.editorSettings.snippets, snippet] });
  open.value = false;
  toast(t("editor.snippetQuickAdd.saved", { label: snippet.label }));
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[500px]" @open-auto-focus="focusPrefixInputOnOpen">
      <!-- Form wrapper so Enter in any field submits (implicit submission → Save). -->
      <form ref="formRef" class="flex flex-col gap-2" @submit.prevent="save">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <ListPlus class="h-5 w-5 text-primary" />
            {{ t("settings.snippetsAddTitle") }}
          </DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4 py-2">
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-quick-add-label">{{ t("settings.snippetsLabel") }}</Label>
            <Input id="snippet-quick-add-label" v-model="label" :placeholder="t('settings.snippetsLabelPlaceholder')" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-quick-add-prefix">{{ t("settings.snippetsPrefix") }}</Label>
            <Input id="snippet-quick-add-prefix" v-model="prefix" :placeholder="t('settings.snippetsPrefixPlaceholder')" />
            <p v-if="duplicatePrefix" class="text-xs text-destructive">
              {{ t("editor.snippetQuickAdd.prefixUnique") }}
            </p>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-quick-add-body">{{ t("settings.snippetsBody") }}</Label>
            <textarea
              id="snippet-quick-add-body"
              v-model="body"
              :placeholder="t('settings.snippetsBodyPlaceholder')"
              rows="6"
              class="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">{{ t("settings.cancel") }}</Button>
          <Button type="submit" :disabled="!trimmedPrefix || duplicatePrefix">{{ t("settings.save") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
