<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2, TextWrap } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";

const { t } = useI18n();
const { highlight } = useSqlHighlighter();

const open = defineModel<boolean>("open", { default: false });
const suppressFuturePrompts = defineModel<boolean>("suppressFuturePrompts", { default: false });
const wrap = ref(false);

const props = withDefaults(
  defineProps<{
    sql?: string;
    title?: string;
    message?: string;
    details?: string;
    detailsText?: string;
    confirmLabel?: string;
    showSuppressToggle?: boolean;
    suppressToggleLabel?: string;
    loading?: boolean;
    closeOnConfirm?: boolean;
  }>(),
  {
    sql: "",
    title: "",
    message: "",
    details: "",
    detailsText: "",
    confirmLabel: "",
    showSuppressToggle: false,
    suppressToggleLabel: "",
    loading: false,
    closeOnConfirm: true,
  },
);

const emit = defineEmits<{
  confirm: [];
}>();

const code = computed(() => props.details || props.sql);
const highlightedCode = computed(() => highlight(code.value));
const dialogOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (props.loading && !value) return;
    open.value = value;
  },
});

function onConfirm() {
  if (props.loading) return;
  if (props.closeOnConfirm) open.value = false;
  emit("confirm");
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-destructive">
          <AlertTriangle class="h-5 w-5" />
          {{ title || t("dangerDialog.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="py-4 min-w-0">
        <p class="text-sm text-muted-foreground mb-3">{{ message || t("dangerDialog.message") }}</p>
        <p v-if="detailsText" class="text-xs text-muted-foreground mb-3 whitespace-pre-line">{{ detailsText }}</p>
        <div v-if="code" class="relative">
          <Button variant="ghost" size="icon-xs" class="absolute top-1 right-1 z-10 h-6 w-6" :class="wrap ? 'text-foreground bg-accent' : 'text-muted-foreground'" :title="t('dangerDialog.wrapLines')" @click="wrap = !wrap">
            <TextWrap class="h-3.5 w-3.5" />
          </Button>
          <pre class="text-xs bg-muted px-3 pt-3 pb-3 pr-7 rounded overflow-auto max-h-40 min-w-0 font-mono" :class="wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'" v-html="highlightedCode" />
        </div>
        <div v-if="showSuppressToggle" class="mt-3 flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
          <Label for="danger-confirm-suppress" class="text-sm leading-5">{{ suppressToggleLabel || t("dangerDialog.suppressFuturePrompts") }}</Label>
          <Switch id="danger-confirm-suppress" v-model="suppressFuturePrompts" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" class="gap-1.5" :disabled="loading" @click="onConfirm">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          {{ confirmLabel || t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
