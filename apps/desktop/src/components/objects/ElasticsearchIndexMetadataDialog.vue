<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import type { ElasticsearchIndexMetadataKind } from "@/lib/backend/tauri";

const props = defineProps<{
  open: boolean;
  connectionId: string;
  index: string;
  kind: ElasticsearchIndexMetadataKind;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();

const content = ref("");
const loading = ref(false);
const error = ref("");

const titleKey: Record<ElasticsearchIndexMetadataKind, string> = {
  mapping: "contextMenu.elasticsearchViewMapping",
  settings: "contextMenu.elasticsearchViewSettings",
  stats: "contextMenu.elasticsearchViewStats",
};

const dialogTitle = computed(() => `${t(titleKey[props.kind])} - ${props.index}`);

async function load() {
  error.value = "";
  loading.value = true;
  try {
    const metadata = await api.elasticsearchGetIndexMetadata(props.connectionId, props.index, props.kind);
    content.value = JSON.stringify(metadata, null, 2);
  } catch (e: any) {
    content.value = "";
    error.value = translateBackendError(t, e);
  } finally {
    loading.value = false;
  }
}

// Reload on open, and when the menu reopens the dialog for a different endpoint
// of the same index (mapping → settings) without an intervening close.
watch(
  () => [props.open, props.connectionId, props.index, props.kind] as const,
  ([open]) => {
    if (!open) return;
    content.value = "";
    void load();
  },
  { immediate: true },
);

async function copyContent() {
  if (!content.value) return;
  try {
    await copyToClipboard(content.value);
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function onClose() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onClose">
    <DialogContent class="sm:max-w-190">
      <DialogHeader>
        <!-- Index names can be long enough to truncate; the title attribute keeps the full name reachable. -->
        <DialogTitle class="truncate" :title="dialogTitle">{{ dialogTitle }}</DialogTitle>
      </DialogHeader>
      <!--
        The frame keeps a definite height on purpose. The editor chain below it
        is sized in percentages, and a percentage height against a min-height-only
        parent collapses to auto — CodeMirror would then grow past the frame and
        a long mapping would be clipped with no scrollbar.
      -->
      <div class="flex h-[60vh] min-h-80 flex-col overflow-hidden rounded border">
        <div v-if="loading" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("common.loading") }}</span>
        </div>
        <div v-else-if="error" class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm">
          <p class="text-center break-all text-destructive">{{ error }}</p>
          <Button variant="outline" size="sm" @click="load">
            <RefreshCw />
            {{ t("common.retry") }}
          </Button>
        </div>
        <RedisJsonEditor v-else :model-value="content" read-only word-wrap :line-numbers="false" presentation="viewer" class="min-h-0 flex-1" />
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onClose">{{ t("common.close") }}</Button>
        <Button variant="outline" :disabled="loading" @click="load">
          <RefreshCw class="h-4 w-4" />
          {{ t("grid.refresh") }}
        </Button>
        <Button variant="outline" :disabled="!content" @click="copyContent">
          <Clipboard class="h-4 w-4" />
          {{ t("common.copy") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
