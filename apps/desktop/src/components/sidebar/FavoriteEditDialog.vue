<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, X } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  open: boolean;
  /** `"note"` edits a favorite's free-form note. `"group"` creates or renames a group. */
  mode: "note" | "group";
  initialValue: string;
  /** When provided, group mode is interpreted as "rename existing". */
  title?: string;
  placeholder?: string;
  label?: string;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  submit: [string];
}>();

const { t } = useI18n();
const value = ref("");

watch(
  () => props.open,
  (next) => {
    if (next) value.value = props.initialValue;
  },
);

const isNote = computed(() => props.mode === "note");

function onSubmit() {
  emit("submit", value.value);
  emit("update:open", false);
}

function onCancel() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(next) => emit('update:open', next)">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>
          <span v-if="title">{{ title }}</span>
          <span v-else-if="isNote">{{ t("contextMenu.favoritesGroup.noteDialogTitle") }}</span>
          <span v-else>{{ t("contextMenu.favoritesGroup.groupDialogTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-2">
        <label v-if="label || isNote || mode === 'group'" class="text-xs font-medium text-muted-foreground">
          <span v-if="label">{{ label }}</span>
          <span v-else-if="isNote">{{ t("contextMenu.favoritesGroup.noteLabel") }}</span>
          <span v-else>{{ t("contextMenu.favoritesGroup.groupNameLabel") }}</span>
        </label>
        <textarea
          v-if="isNote"
          v-model="value"
          :placeholder="placeholder ?? t('contextMenu.favoritesGroup.notePlaceholder')"
          rows="4"
          class="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-[3px]"
        />
        <Input v-else v-model="value" :placeholder="placeholder ?? t('contextMenu.favoritesGroup.groupNamePlaceholder')" @keyup.enter="onSubmit" />
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="onCancel">
          <X />
          {{ t("common.cancel") }}
        </Button>
        <Button size="sm" @click="onSubmit">
          <Check />
          {{ t("common.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
