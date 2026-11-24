<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronRight, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { EMPTY_INSERT_JSON_DOCUMENT, formatInsertJson, parseInsertJsonDocuments, type InsertJsonParseError } from "@/lib/dataGrid/insertJsonDocument";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{
  /** insert: Insert JSON Document (objects or an array); update: Document JSON Editor for one document. */
  mode: "insert" | "update";
  /** Text loaded when the dialog opens in update mode. */
  initialText?: string;
  breadcrumb?: string[];
  /** Writes the JSON text; a rejection keeps the dialog open and shows its message. */
  submit: (text: string) => Promise<void>;
}>();

const text = ref("");
const wordWrap = ref(false);
const submitting = ref(false);
const status = ref<{ tone: "error" | "success"; message: string } | null>(null);
const editorRef = ref<{ openSearch: () => boolean }>();

const startText = computed(() => (props.mode === "update" ? (props.initialText ?? "") : EMPTY_INSERT_JSON_DOCUMENT));

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    text.value = startText.value;
    status.value = null;
    submitting.value = false;
  },
  { immediate: true },
);

watch(text, () => {
  if (status.value?.tone === "success") status.value = null;
});

function parseErrorMessage(error: InsertJsonParseError): string {
  if (error.kind === "empty") return t("grid.insertJsonEmpty");
  if (error.kind === "empty-array") return t("grid.insertJsonEmptyArray");
  if (error.kind === "not-object") return t(props.mode === "update" ? "grid.editJsonNotObject" : "grid.insertJsonNotObject");
  if (error.line !== undefined) return t("grid.insertJsonSyntaxErrorAt", { line: error.line, column: error.column ?? 1, message: error.message });
  return t("grid.insertJsonSyntaxError", { message: error.message });
}

/** Returns the number of documents, or null after showing why the text is not valid. */
function validate(): number | null {
  const result = parseInsertJsonDocuments(text.value);
  if (result.ok && props.mode === "update" && text.value.trim().startsWith("[")) {
    status.value = { tone: "error", message: parseErrorMessage({ kind: "not-object" }) };
    return null;
  }
  if (!result.ok) {
    status.value = { tone: "error", message: parseErrorMessage(result.error) };
    return null;
  }
  return result.documents.length;
}

function onValidate() {
  const count = validate();
  if (count !== null) status.value = { tone: "success", message: t("grid.insertJsonValid", { count }) };
}

function onFormat() {
  const formatted = formatInsertJson(text.value);
  if (formatted === null) {
    validate();
    return;
  }
  text.value = formatted;
  status.value = null;
}

function onFind() {
  editorRef.value?.openSearch();
}

async function onSubmit(keepOpen: boolean) {
  if (submitting.value) return;
  const count = validate();
  if (count === null) return;
  submitting.value = true;
  try {
    await props.submit(text.value);
    if (keepOpen) {
      text.value = EMPTY_INSERT_JSON_DOCUMENT;
      status.value = { tone: "success", message: t("grid.insertJsonAdded", { count }) };
    } else {
      open.value = false;
    }
  } catch (error) {
    status.value = { tone: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(600px,85vh)] flex-col gap-3 sm:max-w-[760px]" data-grid-json-document-dialog :data-mode="mode">
      <DialogHeader>
        <DialogTitle>{{ mode === "update" ? t("grid.editJsonTitle") : t("grid.insertJsonTitle") }}</DialogTitle>
        <DialogDescription v-if="!breadcrumb?.length">{{ mode === "update" ? t("grid.editJsonDescription") : t("grid.insertJsonDescription") }}</DialogDescription>
        <nav v-else data-json-document-breadcrumb class="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground" :aria-label="t('mongo.breadcrumb')">
          <template v-for="(segment, index) in breadcrumb" :key="index">
            <ChevronRight v-if="index > 0" class="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
            <span class="min-w-0 truncate" :class="{ 'font-medium text-foreground': index === breadcrumb.length - 1 }" :title="segment">{{ segment }}</span>
          </template>
        </nav>
      </DialogHeader>
      <div class="flex items-center gap-1">
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="submitting" @click="onFind"><Search class="mr-1 h-3 w-3" />{{ t("grid.editJsonFindReplace") }}</Button>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden rounded border bg-background">
        <RedisJsonEditor ref="editorRef" v-model="text" class="h-full" autofocus :word-wrap="wordWrap" :read-only="submitting" :save-disabled="submitting" @save="onSubmit(false)" />
      </div>
      <p v-if="status" class="text-xs" :class="status.tone === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'" role="status">{{ status.message }}</p>
      <DialogFooter class="flex-wrap items-center gap-2 sm:justify-between">
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" :disabled="submitting" @click="onValidate">{{ t("grid.insertJsonValidate") }}</Button>
          <Button variant="outline" size="sm" :disabled="submitting" @click="onFormat">{{ t("grid.insertJsonFormat") }}</Button>
          <label class="flex items-center gap-1.5 text-xs">
            <input v-model="wordWrap" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
            {{ t("grid.insertJsonWordWrap") }}
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" :disabled="submitting" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button v-if="mode === 'insert'" variant="outline" size="sm" :disabled="submitting" @click="onSubmit(true)">{{ t("grid.insertJsonAddContinue") }}</Button>
          <Button size="sm" :disabled="submitting" @click="onSubmit(false)">{{ mode === "update" ? t("grid.editJsonUpdate") : t("grid.insertJsonAdd") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
