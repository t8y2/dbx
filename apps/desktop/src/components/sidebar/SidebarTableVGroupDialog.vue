<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { tableVGroupNodeId } from "@/lib/table/tableVGroup";
import { showTableVGroupDialog, tableVGroupName, tableVGroupDialogScope, tableVGroupDialogParentGroupId, tableVGroupDialogTableNames, showTableVGroupDeleteConfirm, tableVGroupDeleteTarget } from "./sidebarTreeDialogState";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const emit = defineEmits<{ created: [groupId: string] }>();

const deleteConfirmMessage = computed(() => t("tableVGroup.deleteGroupConfirmMessage", { name: tableVGroupDeleteTarget.value?.name ?? "" }));

function confirmCreate() {
  const scope = tableVGroupDialogScope.value;
  const name = tableVGroupName.value.trim();
  if (!scope || !name) return;
  const groupId = connectionStore.createTableVGroup(scope, name, tableVGroupDialogParentGroupId.value);
  if (groupId) {
    // scope 即右键的源行节点，其 type 就是这批待移入行的类别（多选保证同类型）。
    const rowType = scope.type;
    for (const tableName of tableVGroupDialogTableNames.value) {
      connectionStore.moveTableToVGroup(scope, tableName, groupId, rowType);
    }
    emit("created", tableVGroupNodeId(groupId));
  }
  showTableVGroupDialog.value = false;
  tableVGroupName.value = "";
}

function confirmDelete() {
  const target = tableVGroupDeleteTarget.value;
  showTableVGroupDeleteConfirm.value = false;
  tableVGroupDeleteTarget.value = null;
  if (!target) return;
  connectionStore.deleteTableVGroups(target.scope, [target.groupId]);
  toast(t("tableVGroup.groupDeleted"), 2000);
}
</script>

<template>
  <Dialog v-model:open="showTableVGroupDialog">
    <DialogContent class="max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ tableVGroupDialogTableNames.length ? t("tableVGroup.moveToNewGroup") : t("tableVGroup.newSubgroup") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="tableVGroupName" :placeholder="t('connectionGroup.groupNamePlaceholder')" @keydown.enter.prevent="confirmCreate" />
      <DialogFooter>
        <Button variant="outline" @click="showTableVGroupDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!tableVGroupName.trim()" @click="confirmCreate">{{ t("connectionGroup.createGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showTableVGroupDeleteConfirm">
    <DialogContent class="max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ t("tableVGroup.deleteGroupConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ deleteConfirmMessage }}</p>
      <DialogFooter>
        <Button variant="outline" @click="showTableVGroupDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDelete">{{ t("tableVGroup.deleteGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
