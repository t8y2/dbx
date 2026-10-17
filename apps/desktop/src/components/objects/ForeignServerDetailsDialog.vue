<script setup lang="ts">
import { computed, ref } from "vue";
import { Server } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ForeignServerInfo, TreeNode } from "@/types/database";

const { t } = useI18n();

const props = defineProps<{
  node: TreeNode;
}>();

const open = ref(false);

const srv = computed<ForeignServerInfo>(() => {
  const meta = props.node.meta as ForeignServerInfo | undefined;
  return {
    name: meta?.name || props.node.label,
    owner: meta?.owner || null,
    foreignDataWrapper: meta?.foreignDataWrapper || "-",
    serverType: meta?.serverType || null,
    serverVersion: meta?.serverVersion || null,
    options: meta?.options || [],
    comment: meta?.comment || null,
  };
});

function optionsLabel(opts: [string, string][]): string {
  if (!opts.length) return "-";
  return opts.map(([k, v]) => `${k}=${v}`).join(", ");
}

const ddlSource = computed(() => {
  const q = `"${srv.value.name}"`;
  let ddl = `CREATE SERVER ${q}`;
  if (srv.value.serverType) ddl += `\n  TYPE '${srv.value.serverType}'`;
  if (srv.value.serverVersion) ddl += `\n  VERSION '${srv.value.serverVersion}'`;
  ddl += `\n  FOREIGN DATA WRAPPER ${srv.value.foreignDataWrapper}`;
  if (srv.value.options.length) ddl += `\n  OPTIONS (${srv.value.options.map(([k, v]) => `${k} '${v}'`).join(", ")})`;
  ddl += ";";
  return ddl;
});

function show() {
  open.value = true;
}

defineExpose({ show });
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex min-w-0 items-center gap-2 pr-8">
          <Server class="h-4 w-4 shrink-0 text-blue-500" />
          <span class="truncate">{{ t("foreignServer.detailsTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <dl class="overflow-hidden rounded-md border text-sm">
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.name") }}</dt>
          <dd class="min-w-0 break-words font-medium">{{ srv.name }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.owner") }}</dt>
          <dd class="min-w-0 break-words">{{ srv.owner || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.foreignDataWrapper") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ srv.foreignDataWrapper }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.type") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ srv.serverType || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.version") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ srv.serverVersion || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignServer.options") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ optionsLabel(srv.options) }}</dd>
        </div>
        <div class="grid grid-cols-[9rem_minmax(0,1fr)] px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("structureEditor.comment") }}</dt>
          <dd class="min-w-0 whitespace-pre-wrap break-words">{{ srv.comment || "-" }}</dd>
        </div>
      </dl>

      <div class="mt-2">
        <div class="mb-1 text-xs text-muted-foreground">{{ t("foreignServer.definition") }}</div>
        <pre class="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ ddlSource }}</code></pre>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
