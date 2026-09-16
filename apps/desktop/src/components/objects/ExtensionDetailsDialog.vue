<script setup lang="ts">
import { computed, ref } from "vue";
import { Package } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ExtensionInfo, TreeNode } from "@/types/database";

const { t } = useI18n();

const props = defineProps<{
  node: TreeNode;
}>();

const open = ref(false);
const extension = computed<ExtensionInfo>(() => {
  const meta = props.node.meta as ExtensionInfo | undefined;
  return {
    name: meta?.name || props.node.label,
    version: meta?.version || "-",
    schema: meta?.schema || props.node.schema || null,
    comment: meta?.comment || null,
  };
});

function show() {
  open.value = true;
}

defineExpose({ show });
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex min-w-0 items-center gap-2 pr-8">
          <Package class="h-4 w-4 shrink-0 text-violet-500" />
          <span class="truncate">{{ t("extension.detailsTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <dl class="overflow-hidden rounded-md border text-sm">
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("extension.name") }}</dt>
          <dd class="min-w-0 break-words font-medium">{{ extension.name }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("connection.version") }}</dt>
          <dd class="min-w-0 break-words">{{ extension.version }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] border-b px-3 py-2.5">
          <dt class="text-muted-foreground">Schema</dt>
          <dd class="min-w-0 break-words">{{ extension.schema || "-" }}</dd>
        </div>
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] px-3 py-2.5">
          <dt class="text-muted-foreground">{{ t("structureEditor.comment") }}</dt>
          <dd class="min-w-0 whitespace-pre-wrap break-words">{{ extension.comment || "-" }}</dd>
        </div>
      </dl>

      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
