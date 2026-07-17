<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { List, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";

const { t } = useI18n();
const { toast } = useToast();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  selectedText: string;
}>();

const emit = defineEmits<{
  confirm: [result: string];
}>();

const STORAGE_KEY = "dbx:delimited-list-settings";

interface DelimitedListSettings {
  columnDelimiter: string;
  resultDelimiter: string;
  quoteChar: string;
  wrapColumn: number;
  prefixText: string;
  suffixText: string;
}

const DEFAULT_SETTINGS: DelimitedListSettings = {
  columnDelimiter: "\\n",
  resultDelimiter: ",",
  quoteChar: "'",
  wrapColumn: 80,
  prefixText: "",
  suffixText: "",
};

function loadSettings(): DelimitedListSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

const saved = loadSettings();
const columnDelimiter = ref(saved.columnDelimiter);
const resultDelimiter = ref(saved.resultDelimiter);
const quoteChar = ref(saved.quoteChar);
const wrapColumn = ref(saved.wrapColumn);
const prefixText = ref(saved.prefixText);
const suffixText = ref(saved.suffixText);

function saveSettings() {
  try {
    const settings: DelimitedListSettings = {
      columnDelimiter: columnDelimiter.value,
      resultDelimiter: resultDelimiter.value,
      quoteChar: quoteChar.value,
      wrapColumn: wrapColumn.value,
      prefixText: prefixText.value,
      suffixText: suffixText.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

// Persist settings whenever any value changes
watch([columnDelimiter, resultDelimiter, quoteChar, wrapColumn, prefixText, suffixText], saveSettings);

function unescapeDelimiter(raw: string): string {
  return raw.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

const preview = computed(() => {
  if (!props.selectedText.trim()) return "";
  return buildDelimitedList(props.selectedText);
});

function buildDelimitedList(text: string): string {
  const colDelim = unescapeDelimiter(columnDelimiter.value);
  const resDelim = resultDelimiter.value;
  const quote = quoteChar.value;
  const maxCol = wrapColumn.value;
  const prefix = prefixText.value;
  const suffix = suffixText.value;

  // Split the input text by column delimiter
  const items = text
    .split(colDelim)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (items.length === 0) return "";

  // Wrap each item with quote and prefix/suffix
  const wrapped = items.map((item) => `${quote}${prefix}${item}${suffix}${quote}`);

  // Build lines respecting wrapColumn limit
  const lines: string[] = [];
  let currentLine = "";

  for (let i = 0; i < wrapped.length; i++) {
    const piece = wrapped[i];
    const separator = i > 0 ? resDelim : "";

    if (i === 0) {
      currentLine = piece;
    } else if (currentLine.length + separator.length + piece.length > maxCol && currentLine.length > 0) {
      // Start a new line beginning with the result delimiter
      lines.push(currentLine + resDelim);
      currentLine = piece;
    } else {
      currentLine += separator + piece;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join("\n");
}

function confirm() {
  const result = buildDelimitedList(props.selectedText);
  open.value = false;
  emit("confirm", result);
}

async function copyPreview() {
  try {
    await copyToClipboard(preview.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[86vh] border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[620px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <List class="h-5 w-5 text-primary" />
          {{ t("editor.delimitedList.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.columnDelimiter") }}</Label>
            <Input v-model="columnDelimiter" class="h-8 font-mono text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.resultDelimiter") }}</Label>
            <Input v-model="resultDelimiter" class="h-8 font-mono text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.quoteChar") }}</Label>
            <Input v-model="quoteChar" class="h-8 font-mono text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.wrapColumn") }}</Label>
            <Input v-model.number="wrapColumn" type="number" class="h-8 font-mono text-xs" min="1" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.prefixText") }}</Label>
            <Input v-model="prefixText" class="h-8 font-mono text-xs" />
          </div>
          <div class="grid gap-1.5">
            <Label class="text-xs">{{ t("editor.delimitedList.suffixText") }}</Label>
            <Input v-model="suffixText" class="h-8 font-mono text-xs" />
          </div>
        </div>

        <div class="grid gap-1.5">
          <Label class="text-xs">{{ t("editor.delimitedList.preview") }}</Label>
          <pre class="max-h-48 min-w-0 overflow-auto rounded-md bg-muted px-3 py-2 text-xs font-mono whitespace-pre">{{ preview || t("editor.delimitedList.emptyPreview") }}</pre>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="outline" @click="copyPreview" :disabled="!preview">
          <Copy class="mr-1.5 h-4 w-4" />
          {{ t("grid.copy") }}
        </Button>
        <Button @click="confirm" :disabled="!preview">{{ t("editor.delimitedList.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
