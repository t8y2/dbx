<script setup lang="ts">
import { ref } from "vue";
import { Loader2, Package, Plus, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  changed: [];
}>();

const open = ref(false);
const available = ref<ExtensionInfo[]>([]);
const installed = ref<ExtensionInfo[]>([]);
const schemas = ref<string[]>([]);
const selectedSchema = ref<string>("__default__");
const loading = ref(false);
const installing = ref<string | null>(null);
const dropping = ref<string | null>(null);

function normalizeSchemaOptions(value: string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function preferredSchemaOption(options: string[]): string {
  if (options.includes("public")) return "public";
  return options[0] ?? "__default__";
}

function installedExtensionSummary(ext: ExtensionInfo): string {
  const parts = [ext.version];
  if (ext.schema) parts.push(`schema: ${ext.schema}`);
  if (ext.comment) parts.push(ext.comment);
  return parts.filter(Boolean).join(" - ");
}

function show() {
  open.value = true;
  void loadData();
}

async function loadData() {
  if (!props.node.connectionId || !props.node.database) return;
  loading.value = true;
  try {
    const [availResult, instResult, schemaResult] = await Promise.allSettled([
      api.listAvailableExtensions(props.node.connectionId, props.node.database),
      api.listExtensions(props.node.connectionId, props.node.database, props.node.schema),
      api.listSchemaInfos(props.node.connectionId, props.node.database),
    ]);

    available.value = availResult.status === "fulfilled" ? availResult.value : [];
    installed.value = instResult.status === "fulfilled" ? instResult.value : [];
    schemas.value = schemaResult.status === "fulfilled" ? normalizeSchemaOptions(schemaResult.value.map((schema) => schema.name)) : [];
    selectedSchema.value = props.node.schema && schemas.value.includes(props.node.schema) ? props.node.schema : selectedSchema.value !== "__default__" && schemas.value.includes(selectedSchema.value) ? selectedSchema.value : preferredSchemaOption(schemas.value);

    const firstError = [availResult, instResult, schemaResult].find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    if (firstError) {
      throw firstError;
    }
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
    const schema = selectedSchema.value === "__default__" ? null : selectedSchema.value;
    const sql = buildCreateExtensionSql(name, schema);
    const result = await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(props.node.connectionId),
      database: props.node.database,
      sql,
      source: t("production.sourceExtension"),
      execute: () => api.executeQuery(props.node.connectionId!, props.node.database!, sql, schema ?? undefined),
    });
    if (!result) return;
    await loadData();
    emit("changed");
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
    emit("changed");
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
    <DialogContent class="h-[min(760px,calc(var(--dbx-viewport-height)-2rem))] flex flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ t("extension.manageTitle") }}</DialogTitle>
      </DialogHeader>

      <div v-if="loading" class="flex items-center justify-center py-12">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
        <div class="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span class="font-medium text-foreground">{{ t("extension.available") }}</span>
            <span>{{ available.length }}</span>
            <span class="text-border">/</span>
            <span class="font-medium text-foreground">{{ t("extension.installed") }}</span>
            <span>{{ installed.length }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <div class="text-xs font-medium text-muted-foreground">Schema</div>
            <Select v-model="selectedSchema">
              <SelectTrigger class="h-8 w-32 justify-between">
                <SelectValue :placeholder="'Schema'" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{{ t("common.default") }}</SelectItem>
                <SelectItem v-for="schema in schemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
          <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
            <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/30 px-3">
              <Package class="h-4 w-4 text-muted-foreground" />
              <div class="text-sm font-semibold text-foreground">{{ t("extension.available") }}</div>
              <span class="ml-auto rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">{{ available.length }}</span>
            </div>
            <ScrollArea class="min-h-0 flex-1">
              <div v-if="available.length === 0" class="flex items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
                {{ t("extension.noAvailable") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="ext in available" :key="ext.name" class="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium text-foreground">{{ ext.name }}</div>
                    <div class="line-clamp-2 text-xs leading-4 text-muted-foreground">{{ ext.comment || ext.version }}</div>
                  </div>
                  <Button class="shrink-0" size="sm" variant="outline" :disabled="installing === ext.name" @click="installExtension(ext.name)">
                    <Loader2 v-if="installing === ext.name" class="mr-1 h-3 w-3 animate-spin" />
                    <Plus v-else class="mr-1 h-3 w-3" />
                    {{ t("extension.install") }}
                  </Button>
                </div>
              </div>
            </ScrollArea>
          </section>

          <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
            <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/30 px-3">
              <Package class="h-4 w-4 text-muted-foreground" />
              <div class="text-sm font-semibold text-foreground">{{ t("extension.installed") }}</div>
              <span class="ml-auto rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">{{ installed.length }}</span>
            </div>
            <ScrollArea class="min-h-0 flex-1">
              <div v-if="installed.length === 0" class="flex items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
                {{ t("extension.noInstalled") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="ext in installed" :key="ext.name" class="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium text-foreground">{{ ext.name }}</div>
                    <div class="line-clamp-2 text-xs leading-4 text-muted-foreground">{{ installedExtensionSummary(ext) }}</div>
                  </div>
                  <Button class="shrink-0" size="sm" variant="outline" :disabled="dropping === ext.name" @click="dropExtension(ext.name)">
                    <Loader2 v-if="dropping === ext.name" class="mr-1 h-3 w-3 animate-spin" />
                    <Trash2 v-else class="mr-1 h-3 w-3" />
                    {{ t("extension.drop") }}
                  </Button>
                </div>
              </div>
            </ScrollArea>
          </section>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
