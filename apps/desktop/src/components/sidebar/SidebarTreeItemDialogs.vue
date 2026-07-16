<script setup lang="ts">
import { toRefs, watch } from "vue";
import { Loader2, Clipboard, Upload } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";

const props = defineProps<{ controller: Record<string, any> }>();
const emit = defineEmits<{ closed: [] }>();
const {
  node,
  t,
  highlight,
  showDeleteConfirm,
  connectionDeleteConfirmMessage,
  confirmDelete,
  connectionDeleteMenuLabel,
  showMoveToNewGroupDialog,
  moveToNewGroupName,
  confirmMoveToNewGroup,
  showDeleteGroupConfirm,
  confirmDeleteGroup,
  showRenameObjectDialog,
  renameObjectName,
  renameObjectPreviewSql,
  renameObjectError,
  confirmRenameObject,
  showStructurePreviewDialog,
  structurePreviewTitle,
  isLoadingStructurePreview,
  structurePreviewError,
  structurePreviewSql,
  copyStructurePreview,
  saveStructurePreview,
  showStructureDocCopyDialog,
  structureDocCopyTitle,
  structureDocCopyText,
  selectTextareaContent,
  copyStructureDocText,
  showDuplicateDialog,
  duplicateTableName,
  confirmDuplicateStructure,
  showPasteDialog,
  pasteTableEntries,
  pasteTableMode,
  pasteTableDataCopySupported,
  confirmPasteTable,
  showCreateDatabaseDialog,
  createDatabaseName,
  createDatabaseCharset,
  createDatabaseCharsetOptions,
  createDatabaseCharsetLoading,
  normalizeCreateDatabaseCharset,
  createDatabaseCollation,
  createDatabaseCollationOptionsForCharset,
  createDatabaseCollationsByCharset,
  confirmCreateDatabase,
  showEditDatabasePropertiesDialog,
  editDatabasePropertiesLoading,
  editDatabaseCharset,
  editDatabaseCollation,
  canEditDatabaseComment,
  editDatabaseCommentText,
  editDatabasePropertiesPreviewSql,
  confirmEditDatabaseProperties,
  showCreateNacosNamespaceDialog,
  createNacosNamespaceId,
  createNacosNamespaceName,
  createNacosNamespaceDesc,
  createNacosNamespaceLoading,
  confirmCreateNacosNamespace,
  showEditNacosNamespaceDialog,
  editNacosNamespaceName,
  editNacosNamespaceDesc,
  editNacosNamespaceLoading,
  confirmEditNacosNamespace,
  showCreateSchemaDialog,
  createSchemaName,
  confirmCreateSchema,
  showEditSchemaCommentDialog,
  schemaCommentText,
  schemaCommentLoading,
  schemaCommentPreviewSql,
  confirmEditSchemaComment,
  canSetCreateDatabaseCharset,
  updateCreateDatabaseCharset,
  canEditDatabaseCharsetCollation,
  updateEditDatabaseCharset,
} = toRefs(props.controller);

function pasteTargetsMissing(entries: Array<{ targetName: string }>): boolean {
  return entries.every((entry) => !entry.targetName.trim());
}

watch(
  [
    showDeleteConfirm,
    showMoveToNewGroupDialog,
    showDeleteGroupConfirm,
    showRenameObjectDialog,
    showStructurePreviewDialog,
    showStructureDocCopyDialog,
    showDuplicateDialog,
    showPasteDialog,
    showCreateDatabaseDialog,
    showEditDatabasePropertiesDialog,
    showCreateNacosNamespaceDialog,
    showEditNacosNamespaceDialog,
    showCreateSchemaDialog,
    showEditSchemaCommentDialog,
  ],
  (open) => {
    if (open.every((value) => !value)) emit("closed");
  },
);
</script>

<template>
  <Dialog v-model:open="showDeleteConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.confirmDeleteTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ connectionDeleteConfirmMessage() }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button
          variant="destructive"
          @click="
            showDeleteConfirm = false;
            confirmDelete();
          "
          >{{ connectionDeleteMenuLabel() }}</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showMoveToNewGroupDialog">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t("connectionGroup.createGroup") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="moveToNewGroupName" :placeholder="t('connectionGroup.groupNamePlaceholder')" @keydown.enter.prevent="confirmMoveToNewGroup" />
      <DialogFooter>
        <Button variant="outline" @click="showMoveToNewGroupDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!moveToNewGroupName.trim()" @click="confirmMoveToNewGroup">{{ t("connectionGroup.createGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showDeleteGroupConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("connectionGroup.deleteGroupConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ t("connectionGroup.deleteGroupConfirmMessage", { name: node.label }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteGroupConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteGroup">{{ t("connectionGroup.deleteGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showRenameObjectDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.renameObjectTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <Input v-model="renameObjectName" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" @keydown.enter.prevent="confirmRenameObject" />
        <pre v-if="renameObjectPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(renameObjectPreviewSql)"></pre>
        <p v-if="renameObjectError" class="text-sm text-destructive">{{ renameObjectError }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showRenameObjectDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!renameObjectName.trim() || renameObjectName.trim() === node.label" @click="confirmRenameObject">
          {{ t("contextMenu.renameObject") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStructurePreviewDialog">
    <DialogContent class="sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle>{{ structurePreviewTitle || t("contextMenu.exportStructure") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div v-if="isLoadingStructurePreview" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("contextMenu.exportStructureLoading") }}</span>
        </div>
        <p v-else-if="structurePreviewError" class="text-sm text-destructive">{{ structurePreviewError }}</p>
        <pre v-else class="max-h-[56vh] min-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(structurePreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showStructurePreviewDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="outline" :disabled="isLoadingStructurePreview || !structurePreviewSql" @click="copyStructurePreview">
          <Clipboard class="h-4 w-4" />
          {{ t("contextMenu.copyStructure") }}
        </Button>
        <Button :disabled="isLoadingStructurePreview || !structurePreviewSql" @click="saveStructurePreview">
          <Upload class="h-4 w-4" />
          {{ t("contextMenu.saveStructure") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStructureDocCopyDialog">
    <DialogContent class="sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle>{{ structureDocCopyTitle || t("contextMenu.copyStructureAs") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <p class="text-sm text-muted-foreground">{{ t("contextMenu.structureDocCopyFallbackHint") }}</p>
        <textarea readonly class="max-h-[56vh] min-h-64 resize-y overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre" :value="structureDocCopyText" @focus="selectTextareaContent"></textarea>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showStructureDocCopyDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!structureDocCopyText" @click="copyStructureDocText">
          <Clipboard class="h-4 w-4" />
          {{ t("contextMenu.copyStructure") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showDuplicateDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.duplicateNameTitle") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="duplicateTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" @keydown.enter.prevent="confirmDuplicateStructure" />
      <DialogFooter>
        <Button variant="outline" @click="showDuplicateDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!duplicateTableName.trim()" @click="confirmDuplicateStructure">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showPasteDialog">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ pasteTableEntries.length > 1 ? t("contextMenu.batchPasteTitle") : t("contextMenu.pasteTableConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4">
        <div class="flex gap-2">
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="structure-and-data" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionStructureAndData") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input v-model="pasteTableMode" type="radio" value="structure-only" class="accent-primary" />
            {{ t("contextMenu.pasteOptionStructureOnly") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="data-only" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionDataOnly") }}
          </label>
        </div>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          <div v-for="(entry, idx) in pasteTableEntries" :key="idx" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground truncate min-w-0 flex-shrink basis-1/3" :title="entry.sourceName">{{ entry.sourceName }}</span>
            <span class="text-xs text-muted-foreground flex-shrink-0">&rarr;</span>
            <Input v-model="entry.targetName" class="flex-1 h-8 text-sm" :placeholder="t('contextMenu.duplicateNamePlaceholder')" />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showPasteDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="pasteTargetsMissing(pasteTableEntries)" @click="confirmPasteTable">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateDatabaseDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createDatabase") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="createDatabaseName" :placeholder="t('contextMenu.createDatabaseNamePlaceholder')" @keydown.enter.prevent="confirmCreateDatabase" />
      <div v-if="canSetCreateDatabaseCharset" class="grid gap-2">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCharset") }}</label>
          <SearchableSelect
            :model-value="createDatabaseCharset"
            :options="createDatabaseCharsetOptions"
            :placeholder="t('contextMenu.createDatabaseCharsetPlaceholder')"
            :search-placeholder="t('contextMenu.createDatabaseCharsetSearchPlaceholder')"
            :empty-text="t('contextMenu.createDatabaseCharsetEmpty')"
            :loading-text="t('contextMenu.createDatabaseCharsetLoading')"
            :loading="createDatabaseCharsetLoading"
            :normalize-custom="normalizeCreateDatabaseCharset"
            allow-custom
            trigger-variant="outline"
            trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
            content-class="w-[var(--reka-popover-trigger-width)]"
            @update:model-value="updateCreateDatabaseCharset"
          >
            <template #custom-option-label="{ value }">
              <span class="truncate">{{ t("contextMenu.createDatabaseCharsetCustomOption", { value }) }}</span>
            </template>
          </SearchableSelect>
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCollation") }}</label>
          <SearchableSelect
            v-model="createDatabaseCollation"
            :options="createDatabaseCollationOptionsForCharset(createDatabaseCharset, createDatabaseCollationsByCharset)"
            :placeholder="t('contextMenu.createDatabaseCollationPlaceholder')"
            :search-placeholder="t('contextMenu.createDatabaseCollationSearchPlaceholder')"
            :empty-text="t('contextMenu.createDatabaseCollationEmpty')"
            :loading-text="t('contextMenu.createDatabaseCollationLoading')"
            :loading="createDatabaseCharsetLoading"
            :normalize-custom="normalizeCreateDatabaseCharset"
            allow-custom
            trigger-variant="outline"
            trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
            content-class="w-[var(--reka-popover-trigger-width)]"
          >
            <template #custom-option-label="{ value }">
              <span class="truncate">{{ t("contextMenu.createDatabaseCollationCustomOption", { value }) }}</span>
            </template>
          </SearchableSelect>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showCreateDatabaseDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createDatabaseName.trim()" @click="confirmCreateDatabase">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showEditDatabasePropertiesDialog">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.editDatabasePropertiesTitle", { name: node.label }) }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div v-if="canEditDatabaseCharsetCollation" class="grid gap-3">
          <div class="grid gap-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCharset") }}</label>
            <SearchableSelect
              :model-value="editDatabaseCharset"
              :options="createDatabaseCharsetOptions"
              :placeholder="t('contextMenu.createDatabaseCharsetPlaceholder')"
              :search-placeholder="t('contextMenu.createDatabaseCharsetSearchPlaceholder')"
              :empty-text="t('contextMenu.createDatabaseCharsetEmpty')"
              :loading-text="t('contextMenu.createDatabaseCharsetLoading')"
              :loading="createDatabaseCharsetLoading"
              :normalize-custom="normalizeCreateDatabaseCharset"
              allow-custom
              trigger-variant="outline"
              trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
              content-class="w-[var(--reka-popover-trigger-width)]"
              @update:model-value="updateEditDatabaseCharset"
            >
              <template #custom-option-label="{ value }">
                <span class="truncate">{{ t("contextMenu.createDatabaseCharsetCustomOption", { value }) }}</span>
              </template>
            </SearchableSelect>
          </div>
          <div class="grid gap-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCollation") }}</label>
            <SearchableSelect
              v-model="editDatabaseCollation"
              :options="createDatabaseCollationOptionsForCharset(editDatabaseCharset, createDatabaseCollationsByCharset)"
              :placeholder="t('contextMenu.createDatabaseCollationPlaceholder')"
              :search-placeholder="t('contextMenu.createDatabaseCollationSearchPlaceholder')"
              :empty-text="t('contextMenu.createDatabaseCollationEmpty')"
              :loading-text="t('contextMenu.createDatabaseCollationLoading')"
              :loading="createDatabaseCharsetLoading"
              :normalize-custom="normalizeCreateDatabaseCharset"
              allow-custom
              trigger-variant="outline"
              trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
              content-class="w-[var(--reka-popover-trigger-width)]"
            >
              <template #custom-option-label="{ value }">
                <span class="truncate">{{ t("contextMenu.createDatabaseCollationCustomOption", { value }) }}</span>
              </template>
            </SearchableSelect>
          </div>
        </div>
        <div v-if="canEditDatabaseComment" class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.editDatabaseComment") }}</label>
          <textarea
            v-model="editDatabaseCommentText"
            class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
            :placeholder="t('contextMenu.editDatabaseCommentPlaceholder')"
            :disabled="editDatabasePropertiesLoading"
            @keydown.meta.enter.prevent="confirmEditDatabaseProperties"
            @keydown.ctrl.enter.prevent="confirmEditDatabaseProperties"
          ></textarea>
        </div>
        <pre v-if="editDatabasePropertiesPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(editDatabasePropertiesPreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="editDatabasePropertiesLoading" @click="showEditDatabasePropertiesDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="editDatabasePropertiesLoading" @click="confirmEditDatabaseProperties">
          {{ editDatabasePropertiesLoading ? t("contextMenu.editDatabasePropertiesSaving") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateNacosNamespaceDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.createNamespace") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceId") }}</label>
          <Input v-model="createNacosNamespaceId" :placeholder="t('nacos.namespaceIdPlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceName") }}</label>
          <Input v-model="createNacosNamespaceName" :placeholder="t('nacos.namespaceNamePlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceDesc") }}</label>
          <Input v-model="createNacosNamespaceDesc" :placeholder="t('nacos.namespaceDescPlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="createNacosNamespaceLoading" @click="showCreateNacosNamespaceDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createNacosNamespaceName.trim() || createNacosNamespaceLoading" @click="confirmCreateNacosNamespace">
          {{ createNacosNamespaceLoading ? t("nacos.creatingNamespace") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showEditNacosNamespaceDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.editNamespace") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceName") }}</label>
          <Input v-model="editNacosNamespaceName" :placeholder="t('nacos.namespaceNamePlaceholder')" @keydown.enter.prevent="confirmEditNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceDesc") }}</label>
          <Input v-model="editNacosNamespaceDesc" :placeholder="t('nacos.namespaceDescPlaceholder')" @keydown.enter.prevent="confirmEditNacosNamespace" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="editNacosNamespaceLoading" @click="showEditNacosNamespaceDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!editNacosNamespaceName.trim() || editNacosNamespaceLoading" @click="confirmEditNacosNamespace">
          {{ editNacosNamespaceLoading ? t("nacos.updatingNamespace") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateSchemaDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createSchema") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="createSchemaName" :placeholder="t('contextMenu.createSchemaNamePlaceholder')" @keydown.enter.prevent="confirmCreateSchema" />
      <DialogFooter>
        <Button variant="outline" @click="showCreateSchemaDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createSchemaName.trim()" @click="confirmCreateSchema">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showEditSchemaCommentDialog">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.editSchemaCommentTitle", { name: node.label }) }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <textarea
          v-model="schemaCommentText"
          class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
          :placeholder="t('contextMenu.schemaCommentPlaceholder')"
          :disabled="schemaCommentLoading"
          @keydown.meta.enter.prevent="confirmEditSchemaComment"
          @keydown.ctrl.enter.prevent="confirmEditSchemaComment"
        ></textarea>
        <pre v-if="schemaCommentPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(schemaCommentPreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="schemaCommentLoading" @click="showEditSchemaCommentDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="schemaCommentLoading" @click="confirmEditSchemaComment">
          {{ schemaCommentLoading ? t("contextMenu.schemaCommentSaving") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
