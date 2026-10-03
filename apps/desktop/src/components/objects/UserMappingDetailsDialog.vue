<script setup lang="ts">
import { computed, ref } from "vue";
import { Link } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserMappingInfo, TreeNode } from "@/types/database";

const { t } = useI18n();

const props = defineProps<{
  node: TreeNode;
}>();

const open = ref(false);

const um = computed<UserMappingInfo>(() => {
  const meta = props.node.meta as UserMappingInfo | undefined;
  return {
    oid: meta?.oid || "",
    userName: meta?.userName || "",
    serverName: meta?.serverName || "",
    options: meta?.options || [],
  };
});

function optionsLabel(opts: [string, string][]): string {
  if (!opts.length) return "-";
  return opts.map(([k, v]) => `${k}=${v}`).join(", ");
}

const ddlSource = computed(() => {
  let ddl = `CREATE USER MAPPING FOR ${um.value.userName || "CURRENT_USER"}\n  SERVER ${um.value.serverName}`;
  if (um.value.options.length) ddl += `\n  OPTIONS (${um.value.options.map(([k, v]) => `${k} '${v}'`).join(", ")})`;
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
          <Link class="h-4 w-4 shrink-0 text-blue-500" />
          <span class="truncate">{{ t("userMapping.detailsTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <dl class="overflow-hidden rounded-md border text-sm">
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("userMapping.userName") }}</dt>
          <dd class="min-w-0 break-words">{{ um.userName || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("userMapping.serverName") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ um.serverName || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[8rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("userMapping.options") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ optionsLabel(um.options) }}</dd>
        </div>
      </dl>

      <div class="mt-2">
        <div class="mb-1 text-xs text-muted-foreground">{{ t("userMapping.definition") }}</div>
        <pre class="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ ddlSource }}</code></pre>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
