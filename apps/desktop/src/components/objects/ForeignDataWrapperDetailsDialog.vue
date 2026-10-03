<script setup lang="ts">
import { computed, ref } from "vue";
import { Network } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ForeignDataWrapperInfo, TreeNode } from "@/types/database";

const { t } = useI18n();

const props = defineProps<{
  node: TreeNode;
}>();

const open = ref(false);

const fdw = computed<ForeignDataWrapperInfo>(() => {
  const meta = props.node.meta as ForeignDataWrapperInfo | undefined;
  return {
    name: meta?.name || props.node.label,
    owner: meta?.owner || null,
    handler: meta?.handler || null,
    validator: meta?.validator || null,
    options: meta?.options || [],
    comment: meta?.comment || null,
  };
});

function optionsLabel(opts: [string, string][]): string {
  if (!opts.length) return "-";
  return opts.map(([k, v]) => `${k}=${v}`).join(", ");
}

const ddlSource = computed(() => {
  const q = `"${fdw.value.name}"`;
  let ddl = `CREATE FOREIGN DATA WRAPPER ${q}`;
  if (fdw.value.handler) ddl += `\n  HANDLER ${fdw.value.handler}`;
  if (fdw.value.validator) ddl += `\n  VALIDATOR ${fdw.value.validator}`;
  if (fdw.value.options.length) ddl += `\n  OPTIONS (${fdw.value.options.map(([k, v]) => `${k} '${v}'`).join(", ")})`;
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
          <Network class="h-4 w-4 shrink-0 text-blue-500" />
          <span class="truncate">{{ t("foreignDataWrapper.detailsTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <dl class="overflow-hidden rounded-md border text-sm">
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignDataWrapper.name") }}</dt>
          <dd class="min-w-0 break-words font-medium">{{ fdw.name }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignDataWrapper.owner") }}</dt>
          <dd class="min-w-0 break-words">{{ fdw.owner || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignDataWrapper.handler") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ fdw.handler || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignDataWrapper.validator") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ fdw.validator || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("foreignDataWrapper.options") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ optionsLabel(fdw.options) }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("structureEditor.comment") }}</dt>
          <dd class="min-w-0 whitespace-pre-wrap break-words">{{ fdw.comment || "-" }}</dd>
        </div>
      </dl>

      <div class="mt-2">
        <div class="mb-1 text-xs text-muted-foreground">{{ t("foreignDataWrapper.definition") }}</div>
        <pre class="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ ddlSource }}</code></pre>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
