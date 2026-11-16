<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { plDebugRead } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { PlDebugResultReference } from "@/lib/backend/pl-debug-tauri";
import type { PlDebugSessionRef } from "@/lib/debug/plDebugProtocol";
import { copyToClipboard } from "@/lib/common/clipboard";
import { downloadBinaryCellPayload } from "@/lib/dataGrid/binaryCellDownload";
import { sanitizeExportBaseName } from "@/lib/export/saveTextFile";

const props = defineProps<{ result: PlDebugResultReference; session: PlDebugSessionRef; generation: number; name: string }>();
const { t } = useI18n();
interface Page {
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
}
const identity = computed(() => JSON.stringify([props.session, props.generation, props.result]));
const pages = ref<Record<number, Page>>({});
const positions = ref([0]);
const position = ref(0);
const expanded = ref(false);
const busy = ref(false);
const exporting = ref(false);
const exportCancelled = ref(false);
const error = ref<string | null>(null);
const copied = ref(false);
let revision = 0;
watch(identity, () => {
  revision++;
  pages.value = {};
  positions.value = [0];
  position.value = 0;
  expanded.value = false;
  busy.value = false;
  exporting.value = false;
  exportCancelled.value = false;
  error.value = null;
  copied.value = false;
});
onBeforeUnmount(() => revision++);
const current = computed(() => pages.value[positions.value[position.value]!]);
const unit = computed(() => (props.result.encoding === "base64" ? "B" : "UTF-16"));

async function readPage(offset: number, version: number): Promise<Page> {
  if (pages.value[offset]) return pages.value[offset];
  const result = props.result;
  const response = await plDebugRead({ ...props.session, generation: props.generation, kind: "result_page", params: { generation: result.generation, resultId: result.resultId, offset, limit: 32000 } });
  if (version !== revision) throw new Error("The result view changed");
  if (
    Array.isArray(response) ||
    response.generation !== result.generation ||
    response.resultId !== result.resultId ||
    response.encoding !== result.encoding ||
    response.length !== result.length ||
    response.lengthUnit !== result.lengthUnit ||
    response.complete !== result.complete ||
    response.truncated !== result.truncated ||
    response.state !== result.state ||
    response.offset !== offset ||
    typeof response.data !== "string" ||
    !Number.isSafeInteger(response.nextOffset) ||
    Number(response.nextOffset) < offset ||
    Number(response.nextOffset) > result.length ||
    Number(response.nextOffset) - offset > 32000 ||
    response.eof !== (response.nextOffset === result.length) ||
    (response.nextOffset === offset && offset < result.length)
  )
    throw new Error("The result page did not confirm its original identity and bounds");
  const count = result.encoding === "base64" ? atob(response.data).length : response.data.length;
  if (count !== Number(response.nextOffset) - offset) throw new Error("The result page length did not match its cursor");
  const page: Page = { offset, nextOffset: Number(response.nextOffset), eof: response.eof === true, data: response.data };
  pages.value = { ...pages.value, [offset]: page };
  return page;
}

async function show(next = false) {
  if (busy.value) return;
  const version = revision;
  const offset = next ? current.value?.nextOffset : positions.value[position.value];
  if (offset === undefined) return;
  busy.value = true;
  exportCancelled.value = false;
  error.value = null;
  expanded.value = true;
  copied.value = false;
  try {
    await readPage(offset, version);
    if (version !== revision) return;
    if (next) {
      positions.value = [...positions.value.slice(0, position.value + 1), offset];
      position.value++;
    }
  } catch (caught) {
    if (version === revision) error.value = formatError(caught);
  } finally {
    if (version === revision) busy.value = false;
  }
}

async function copyPage() {
  if (!current.value) return;
  const version = revision;
  try {
    await copyToClipboard(current.value.data);
    if (version === revision) copied.value = true;
  } catch (caught) {
    if (version === revision) error.value = formatError(caught);
  }
}

async function save() {
  if (busy.value) return;
  const version = revision;
  const result = props.result;
  const name = sanitizeExportBaseName(props.name) || "result";
  busy.value = true;
  exporting.value = true;
  exportCancelled.value = false;
  error.value = null;
  try {
    if (!Number.isSafeInteger(result.length) || result.length < 0 || result.length > 16 * 1024 * 1024) throw new Error("The result exceeds its verified export budget");
    const chunks: string[] = [];
    let offset = 0;
    do {
      const page = await readPage(offset, version);
      if (version !== revision || exportCancelled.value) return;
      chunks.push(page.data);
      offset = page.nextOffset;
      if (page.eof) break;
    } while (offset < result.length);
    let data: string | Uint8Array;
    if (result.encoding === "base64") {
      const bytes = chunks.map((chunk) => Uint8Array.from(atob(chunk), (character) => character.charCodeAt(0)));
      const combined = new Uint8Array(result.length);
      let index = 0;
      for (const chunk of bytes) {
        combined.set(chunk, index);
        index += chunk.length;
      }
      if (index !== result.length) throw new Error("The cached binary result is incomplete");
      data = combined;
    } else {
      data = chunks.join("");
      if (data.length !== result.length) throw new Error("The cached text result is incomplete");
    }
    const extension = result.encoding === "base64" ? "bin" : "txt";
    await downloadBinaryCellPayload({ data, extension, mimeType: result.encoding === "base64" ? "application/octet-stream" : "text/plain;charset=utf-8" }, `${name}${result.complete ? "" : ".partial"}.${extension}`);
  } catch (caught) {
    if (version === revision) error.value = formatError(caught);
  } finally {
    if (version === revision) {
      busy.value = false;
      exporting.value = false;
    }
  }
}
</script>

<template>
  <div class="min-w-48 space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-muted-foreground">{{ result.length.toLocaleString() }} {{ unit }}</span>
      <span v-if="!result.complete" class="text-amber-600 dark:text-amber-400">{{ t("plDebug.results.partial") }}</span>
      <Button v-if="!expanded" size="sm" variant="outline" :disabled="busy" @click="show()">{{ t("plDebug.results.open") }}</Button>
      <Button size="sm" variant="outline" :disabled="busy" @click="save">{{ t(result.complete ? "plDebug.results.save" : "plDebug.results.savePrefix") }}</Button>
      <Button v-if="exporting && !exportCancelled" size="sm" variant="ghost" @click="exportCancelled = true">{{ t("common.cancel") }}</Button>
      <span v-if="busy" role="status">{{ t(exportCancelled ? "common.stopping" : "common.loading") }}</span>
    </div>
    <template v-if="expanded">
      <pre v-if="current" class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 font-mono text-xs" :aria-label="name">{{ current.data }}</pre>
      <div class="flex flex-wrap items-center gap-2">
        <span v-if="current" class="text-muted-foreground">{{ t("plDebug.results.range", { from: result.length === 0 ? 0 : current.offset + 1, to: current.nextOffset, total: result.length, unit }) }}<span v-if="result.encoding === 'base64'"> · Base64</span></span>
        <Button
          v-if="position > 0"
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="
            position--;
            copied = false;
            error = null;
          "
          >{{ t("plDebug.results.previous") }}</Button
        >
        <Button v-if="current && !current.eof" size="sm" variant="outline" :disabled="busy" @click="show(true)">{{ t("plDebug.results.next") }}</Button>
        <Button v-if="current" size="sm" variant="ghost" :disabled="busy" @click="copyPage">{{ copied ? t("plDebug.variables.copied") : t("plDebug.results.copyPage") }}</Button>
        <Button v-if="error && !current" size="sm" variant="outline" :disabled="busy" @click="show()">{{ t("common.retry") }}</Button>
      </div>
    </template>
    <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
  </div>
</template>
