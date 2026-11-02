<script setup lang="ts">
import { computed, ref } from "vue";
import { Package } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { EventTriggerInfo, TreeNode } from "@/types/database";

const { t } = useI18n();

const props = defineProps<{
  node: TreeNode;
}>();

const open = ref(false);

const trigger = computed<EventTriggerInfo>(() => {
  const meta = props.node.meta as EventTriggerInfo | undefined;
  return {
    name: meta?.name || props.node.label,
    event: meta?.event || "-",
    owner: meta?.owner || null,
    function: meta?.function || null,
    enabled: meta?.enabled || null,
    tags: meta?.tags || null,
    comment: meta?.comment || null,
    source: meta?.source || null,
  };
});

const enabledLabel = computed(() => {
  // PostgreSQL `evtenabled` 状态码映射为原生 DDL 术语（符合详情面板 value 不本地化的惯例）。
  switch (trigger.value.enabled) {
    case "O":
      return "Origin";
    case "A":
      return "Always";
    case "R":
      return "Replica";
    case "D":
      return "Disabled";
    default:
      return trigger.value.enabled || "-";
  }
});

// `evttags` 为空表示无 WHEN 限制、对所有命令标签触发，用 PG 原生术语 `ALL` 表示（value 不本地化）。
const tagsLabel = computed(() => (trigger.value.tags?.length ? trigger.value.tags.join(", ") : "ALL"));

// DDL source: prefer the server's `pg_get_eventtriggerdef` reconstruction;
// fall back to a field-driven rebuild when that function is unavailable
// (stripped PostgreSQL-compatible kernels hit the sourceless listing path
// and `source` comes back NULL, so the dialog would otherwise show no DDL).
const ddlSource = computed(() => {
  if (trigger.value.source) return trigger.value.source;
  // 触发器名加双引号，防需引用的标识符（大小写敏感/关键字/特殊字符）。
  const quotedName = `"${trigger.value.name}"`;
  let ddl = `CREATE EVENT TRIGGER ${quotedName} ON ${trigger.value.event}`;
  if (trigger.value.tags?.length) {
    ddl += `\n  WHEN TAG IN (${trigger.value.tags.map((tag) => `'${tag}'`).join(", ")})`;
  }
  if (trigger.value.function) {
    ddl += `\n  EXECUTE FUNCTION ${trigger.value.function}`;
  }
  ddl += ";";
  const enabled = trigger.value.enabled;
  if (enabled && enabled !== "O") {
    const alter = enabled === "D" ? "DISABLE" : enabled === "A" ? "ENABLE ALWAYS" : enabled === "R" ? "ENABLE REPLICA" : null;
    if (alter) ddl += `\n\nALTER EVENT TRIGGER ${quotedName} ${alter};`;
  }
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
          <Package class="h-4 w-4 shrink-0 text-violet-500" />
          <span class="truncate">{{ t("eventTrigger.detailsTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <dl class="overflow-hidden rounded-md border text-sm">
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.name") }}</dt>
          <dd class="min-w-0 break-words font-medium">{{ trigger.name }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.event") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ trigger.event }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.owner") }}</dt>
          <dd class="min-w-0 break-words">{{ trigger.owner || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.function") }}</dt>
          <dd class="min-w-0 break-words font-mono text-xs">{{ trigger.function || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.enabled") }}</dt>
          <dd class="min-w-0 break-words">{{ enabledLabel }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("eventTrigger.tags") }}</dt>
          <dd class="min-w-0 break-words">{{ tagsLabel }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("structureEditor.comment") }}</dt>
          <dd class="min-w-0 whitespace-pre-wrap break-words">{{ trigger.comment || "-" }}</dd>
        </div>
      </dl>

      <div v-if="ddlSource" class="mt-2">
        <div class="mb-1 text-xs text-muted-foreground">{{ t("eventTrigger.definition") }}</div>
        <pre class="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ ddlSource }}</code></pre>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
