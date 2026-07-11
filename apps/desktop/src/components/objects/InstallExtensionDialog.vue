<script setup lang="ts">
import { ref } from "vue";
import { Loader2, Package, Plus, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildCreateExtensionSql, buildDropExtensionSql } from "@/lib/database/dbAdminSql";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import type { ExtensionInfo, TreeNode } from "@/types/database";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const props = defineProps<{
  node: TreeNode;
}>();

const emit = defineEmits<{
  close: [];
}>();

const open = ref(false);
const available = ref<ExtensionInfo[]>([]);
const installed = ref<ExtensionInfo[]>([]);
const loading = ref(false);
const installing = ref<string | null>(null);
const dropping = ref<string | null>(null);

function show() {
  open.value = true;
  void loadData();
}

async function loadData() {
  if (!props.node.connectionId || !props.node.database) return;
  loading.value = true;
  try {
    const [avail, inst] = await Promise.all([api.listAvailableExtensions(props.node.connectionId, props.node.database).catch(() => [] as ExtensionInfo[]), api.listExtensions(props.node.connectionId, props.node.database, props.node.schema || "public").catch(() => [] as ExtensionInfo[])]);
    available.value = avail;
    installed.value = inst;
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    loading.value = false;
  }
}

async function installExtension(name: string) {
  if (!props.node.connectionId || !props.node.database) return;
  installing.value = name;
  try {
    const sql = buildCreateExtensionSql(name, props.node.schema ?? null);
    const result = await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(props.node.connectionId),
      database: props.node.database,
      sql,
      source: t("production.sourceExtension"),
      execute: () => api.executeQuery(props.node.connectionId!, props.node.database!, sql, props.node.schema ?? undefined),
    });
    if (!result) return;
    await loadData();
    emit("close");
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    installing.value = null;
  }
}

async function dropExtension(name: string) {
  if (!props.node.connectionId || !props.node.database) return;
  dropping.value = name;
  try {
    const sql = buildDropExtensionSql(name, false);
    const result = await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(props.node.connectionId),
      database: props.node.database,
      sql,
      source: t("production.sourceExtension"),
      execute: () => api.executeQuery(props.node.connectionId!, props.node.database!, sql, props.node.schema ?? undefined),
    });
    if (!result) return;
    await loadData();
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    dropping.value = null;
  }
}

defineExpose({ show });
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="h-[min(760px,calc(100dvh-2rem))] flex flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ t("extension.manageTitle") }}</DialogTitle>
      </DialogHeader>

      <div v-if="loading" class="flex items-center justify-center py-12">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      <div v-else class="grid flex-1 min-h-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <!-- Left: Available -->
        <div class="flex min-h-0 flex-col">
          <div class="flex items-center gap-1.5 mb-2 text-sm font-medium text-muted-foreground">
            <Package class="h-4 w-4" />
            {{ t("extension.available") }}
            <span class="ml-auto text-xs">({{ available.length }})</span>
          </div>
          <ScrollArea class="min-h-0 flex-1 rounded-md border">
            <div v-if="available.length === 0" class="flex items-center justify-center py-12 text-sm text-muted-foreground">
              {{ t("extension.noAvailable") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="ext in available" :key="ext.name" class="flex items-center justify-between gap-2 px-3 py-2">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">{{ ext.name }}</div>
                  <div class="text-xs text-muted-foreground">{{ ext.comment || ext.version }}</div>
                </div>
                <Button size="sm" variant="outline" :disabled="installing === ext.name" @click="installExtension(ext.name)">
                  <Loader2 v-if="installing === ext.name" class="mr-1 h-3 w-3 animate-spin" />
                  <Plus v-else class="mr-1 h-3 w-3" />
                  {{ t("extension.install") }}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>

        <!-- Right: Installed -->
        <div class="flex min-h-0 flex-col">
          <div class="flex items-center gap-1.5 mb-2 text-sm font-medium text-muted-foreground">
            <Package class="h-4 w-4" />
            {{ t("extension.installed") }}
            <span class="ml-auto text-xs">({{ installed.length }})</span>
          </div>
          <ScrollArea class="min-h-0 flex-1 rounded-md border">
            <div v-if="installed.length === 0" class="flex items-center justify-center py-12 text-sm text-muted-foreground">
              {{ t("extension.noInstalled") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="ext in installed" :key="ext.name" class="flex items-center justify-between gap-2 px-3 py-2">
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">{{ ext.name }}</div>
                  <div class="text-xs text-muted-foreground">{{ ext.version }}{{ ext.comment ? ` — ${ext.comment}` : "" }}</div>
                </div>
                <Button size="sm" variant="outline" :disabled="dropping === ext.name" @click="dropExtension(ext.name)">
                  <Loader2 v-if="dropping === ext.name" class="mr-1 h-3 w-3 animate-spin" />
                  <Trash2 v-else class="mr-1 h-3 w-3" />
                  {{ t("extension.drop") }}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
