<script setup lang="ts">
import { toRefs, watch } from "vue";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const props = defineProps<{ controller: Record<string, any> }>();
const emit = defineEmits<{ closed: [] }>();
const {
  node,
  t,
  showMongoIndexManagerDialog,
  mongoIndexManagerRows,
  mongoIndexManagerLoading,
  mongoIndexManagerError,
  mongoIndexManagerSelectedName,
  mongoIndexManagerMode,
  mongoIndexManagerSelected,
  mongoIndexManagerCollectionName,
  loadMongoIndexManagerRows,
  selectMongoIndexRow,
  startCreateMongoIndexDraft,
  startEditMongoIndexDraft,
  cancelMongoIndexDraft,
  dropSelectedMongoIndexRow,
  canDropSelectedMongoIndexRow,
  canEditSelectedMongoIndexRow,
  confirmEditMongoIndex,
  mongoCreateIndexForm,
  mongoCreateIndexFieldOptions,
  mongoCreateIndexError,
  mongoCreateIndexLoading,
  mongoIndexKeyTypes,
  mongoCreateIndexCanSubmit,
  mongoCreateIndexCanAddField,
  addMongoCreateIndexField,
  removeMongoCreateIndexField,
  confirmCreateMongoIndex,
} = toRefs(props.controller);

/** Render the transport values (1 / -1) with their human-readable direction. */
function mongoIndexTypeLabel(type: string): string {
  if (type === "1") return t.value("contextMenu.mongoIndexAscending");
  if (type === "-1") return t.value("contextMenu.mongoIndexDescending");
  return type;
}

watch(showMongoIndexManagerDialog, (open) => {
  if (!open) emit("closed");
});
</script>

<template>
  <Dialog v-model:open="showMongoIndexManagerDialog">
    <DialogContent class="flex min-w-0 flex-col gap-0 p-0 sm:max-w-[760px]">
      <DialogHeader class="border-b px-5 py-4">
        <DialogTitle>{{ t("contextMenu.manageMongoIndexesTitle", { collection: mongoIndexManagerCollectionName }) }}</DialogTitle>
        <p class="font-mono text-xs text-muted-foreground">{{ node.database }} / {{ mongoIndexManagerCollectionName }}</p>
      </DialogHeader>

      <div class="flex items-center gap-2 border-b px-5 py-2">
        <Button type="button" variant="outline" size="sm" :disabled="mongoIndexManagerLoading || mongoCreateIndexLoading || mongoIndexManagerMode === 'create' || mongoIndexManagerMode === 'edit'" @click="startCreateMongoIndexDraft">
          <Plus class="mr-1 h-4 w-4" />
          {{ t("contextMenu.createMongoIndex") }}
        </Button>
        <Button type="button" variant="outline" size="sm" :disabled="mongoIndexManagerLoading || mongoCreateIndexLoading || !canEditSelectedMongoIndexRow" @click="startEditMongoIndexDraft">
          <Pencil class="mr-1 h-4 w-4" />
          {{ t("contextMenu.editMongoIndex") }}
        </Button>
        <Button type="button" variant="outline" size="sm" class="text-destructive hover:text-destructive" :disabled="mongoIndexManagerLoading || mongoCreateIndexLoading || !canDropSelectedMongoIndexRow" @click="dropSelectedMongoIndexRow">
          <Trash2 class="mr-1 h-4 w-4" />
          {{ t("contextMenu.dropIndex") }}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="ml-auto"
          :disabled="mongoIndexManagerLoading || mongoCreateIndexLoading || mongoIndexManagerMode === 'create' || mongoIndexManagerMode === 'edit'"
          :title="t('contextMenu.refreshChildren')"
          :aria-label="t('contextMenu.refreshChildren')"
          @click="loadMongoIndexManagerRows"
        >
          <RefreshCw class="h-4 w-4" :class="mongoIndexManagerLoading ? 'animate-spin' : ''" />
        </Button>
      </div>

      <section class="min-w-0">
        <div class="flex min-w-0 gap-2 border-b bg-muted/40 px-5 py-1.5 text-xs text-muted-foreground">
          <span class="min-w-0 flex-1">{{ t("structureEditor.indexName") }}</span>
          <span class="min-w-0 flex-1">{{ t("contextMenu.mongoIndexKeys") }}</span>
        </div>
        <div class="h-[200px] min-w-0 overflow-auto">
          <div v-if="mongoIndexManagerLoading" class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t("common.loading") }}
          </div>
          <p v-else-if="mongoIndexManagerError" class="min-w-0 whitespace-pre-wrap break-all px-5 py-6 text-sm text-destructive">{{ mongoIndexManagerError }}</p>
          <p v-else-if="mongoIndexManagerRows.length === 0" class="px-5 py-10 text-center text-sm text-muted-foreground">{{ t("contextMenu.mongoIndexEmpty") }}</p>
          <button
            v-for="row in mongoIndexManagerRows"
            v-else
            :key="row.name"
            type="button"
            class="flex w-full min-w-0 gap-2 px-5 py-1.5 text-left text-sm hover:bg-muted/60"
            :class="row.name === mongoIndexManagerSelectedName ? 'bg-primary/10' : ''"
            :disabled="mongoIndexManagerMode === 'create' || mongoIndexManagerMode === 'edit'"
            @click="selectMongoIndexRow(row.name)"
          >
            <span class="min-w-0 flex-1 truncate font-mono">{{ row.name }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{{ row.keys }}</span>
          </button>
        </div>
      </section>

      <section class="min-w-0 border-t bg-muted/20 px-5 py-4">
        <div v-if="mongoIndexManagerMode === 'create' || mongoIndexManagerMode === 'edit'" class="grid min-w-0 gap-4">
          <div class="grid min-w-0 gap-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm font-medium">{{ t("contextMenu.createMongoIndexFields") }}</span>
              <Button type="button" variant="outline" size="sm" :disabled="mongoCreateIndexLoading || !mongoCreateIndexCanAddField" @click="addMongoCreateIndexField">
                <Plus class="mr-1 h-4 w-4" />
                {{ t("mongo.addField") }}
              </Button>
            </div>
            <div v-for="field in mongoCreateIndexForm.fields" :key="field.id" class="flex min-w-0 items-center gap-2">
              <Input v-model="field.path" :list="`mongo-index-manager-fields-${field.id}`" :disabled="mongoCreateIndexLoading" :placeholder="t('mongo.fieldPlaceholder')" :aria-label="t('mongo.field')" class="h-8 min-w-0 flex-1" autocomplete="off" />
              <datalist :id="`mongo-index-manager-fields-${field.id}`">
                <option v-for="option in mongoCreateIndexFieldOptions" :key="option" :value="option"></option>
              </datalist>
              <Select v-model="field.type" :disabled="mongoCreateIndexLoading">
                <SelectTrigger class="h-8 w-36 shrink-0" :aria-label="t('structureEditor.indexType')">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="type in mongoIndexKeyTypes" :key="type" :value="type">{{ mongoIndexTypeLabel(type) }}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="icon" class="h-8 w-8" :disabled="mongoCreateIndexLoading || mongoCreateIndexForm.fields.length === 1" :title="t('structureEditor.remove')" :aria-label="t('structureEditor.remove')" @click="removeMongoCreateIndexField(field.id)">
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>
          <label class="grid min-w-0 gap-1.5 text-sm font-medium">
            {{ t("structureEditor.indexName") }}
            <Input v-model="mongoCreateIndexForm.name" :disabled="mongoCreateIndexLoading" :placeholder="t('contextMenu.createMongoIndexNamePlaceholder')" :aria-label="t('structureEditor.indexName')" class="h-8" />
          </label>

          <div class="grid min-w-0 gap-2.5">
            <label class="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <Switch v-model="mongoCreateIndexForm.unique" :disabled="mongoCreateIndexLoading" :aria-label="t('structureEditor.unique')" />
              {{ t("structureEditor.unique") }}
            </label>
            <label class="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <Switch v-model="mongoCreateIndexForm.sparse" :disabled="mongoCreateIndexLoading" :aria-label="t('contextMenu.createMongoIndexSparse')" />
              {{ t("contextMenu.createMongoIndexSparse") }}
            </label>
            <label v-if="mongoIndexManagerMode === 'edit' || mongoCreateIndexForm.hidden" class="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <Switch v-model="mongoCreateIndexForm.hidden" :disabled="mongoCreateIndexLoading" :aria-label="t('mongo.indexHidden')" />
              {{ t("mongo.indexHidden") }}
            </label>
            <label class="grid min-w-0 gap-1.5 text-sm">
              {{ t("mongo.indexExpireAfterSeconds") }}
              <Input v-model="mongoCreateIndexForm.expireAfterSeconds" :disabled="mongoCreateIndexLoading" inputmode="numeric" :placeholder="t('mongo.indexExpireAfterSecondsPlaceholder')" :aria-label="t('mongo.indexExpireAfterSeconds')" class="h-8 max-w-[260px]" />
              <span class="text-xs text-muted-foreground">{{ t("mongo.indexExpireAfterSecondsHint") }}</span>
            </label>
            <label class="grid min-w-0 gap-1.5 text-sm">
              {{ t("mongo.indexPartialFilter") }}
              <Input v-model="mongoCreateIndexForm.partialFilterExpression" :disabled="mongoCreateIndexLoading" placeholder='{ "status": "active" }' :aria-label="t('mongo.indexPartialFilter')" class="h-8 font-mono" />
            </label>
          </div>

          <details class="min-w-0 rounded-md border bg-background px-3 py-2">
            <summary class="cursor-pointer text-sm font-medium">{{ t("mongo.indexLegacyOptions") }}</summary>
            <div class="grid min-w-0 gap-2.5 pt-3">
              <p class="text-xs text-muted-foreground">{{ t("mongo.indexLegacyOptionsHint") }}</p>
              <label class="flex w-fit cursor-pointer items-center gap-2 text-sm">
                <Switch v-model="mongoCreateIndexForm.background" :disabled="mongoCreateIndexLoading" :aria-label="t('mongo.indexBackground')" />
                {{ t("mongo.indexBackground") }}
              </label>
              <label class="grid min-w-0 gap-1.5 text-sm">
                {{ t("mongo.indexBucketSize") }}
                <Input v-model="mongoCreateIndexForm.bucketSize" :disabled="mongoCreateIndexLoading" inputmode="numeric" :aria-label="t('mongo.indexBucketSize')" class="h-8 max-w-[260px]" />
              </label>
            </div>
          </details>

          <p v-if="mongoIndexManagerMode === 'edit' && mongoIndexManagerSelected?.extraOptions" class="text-xs text-muted-foreground">{{ t("contextMenu.mongoIndexExtraOptionsPreserved") }}</p>
          <p v-if="mongoIndexManagerMode === 'edit'" class="text-xs text-muted-foreground">{{ t("contextMenu.mongoIndexRebuildHint") }}</p>
          <p v-if="mongoCreateIndexError" class="min-w-0 max-w-full whitespace-pre-wrap break-all text-sm text-destructive">{{ mongoCreateIndexError }}</p>

          <div class="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" :disabled="mongoCreateIndexLoading" @click="cancelMongoIndexDraft">{{ t("dangerDialog.cancel") }}</Button>
            <Button size="sm" :disabled="mongoCreateIndexLoading || !mongoCreateIndexCanSubmit" @click="mongoIndexManagerMode === 'edit' ? confirmEditMongoIndex() : confirmCreateMongoIndex()">
              <Loader2 v-if="mongoCreateIndexLoading" class="mr-2 h-4 w-4 animate-spin" />
              {{ mongoIndexManagerMode === "edit" ? t("contextMenu.saveMongoIndex") : t("contextMenu.createMongoIndex") }}
            </Button>
          </div>
        </div>
        <div v-else class="grid min-w-0 gap-3">
          <p v-if="!mongoIndexManagerSelected" class="text-sm text-muted-foreground">{{ t("contextMenu.mongoIndexSelectHint") }}</p>
          <template v-else>
            <div class="grid min-w-0 gap-1.5">
              <span class="text-xs text-muted-foreground">{{ t("structureEditor.indexName") }}</span>
              <span class="min-w-0 break-all font-mono text-sm">{{ mongoIndexManagerSelected.name }}</span>
            </div>
            <div class="grid min-w-0 gap-1.5">
              <span class="text-xs text-muted-foreground">{{ t("contextMenu.mongoIndexKeys") }}</span>
              <span class="min-w-0 break-all font-mono text-sm">{{ mongoIndexManagerSelected.keys }}</span>
            </div>
            <!-- MongoDB has no ALTER INDEX, so existing properties stay read-only. -->
            <div v-if="mongoIndexManagerMode !== 'edit'" class="flex min-w-0 flex-wrap gap-x-6 gap-y-2">
              <label class="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                <Switch :model-value="mongoIndexManagerSelected.isUnique" disabled :aria-label="t('structureEditor.unique')" />
                {{ t("structureEditor.unique") }}
              </label>
              <template v-if="mongoIndexManagerSelected.propertiesComplete">
                <label class="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                  <Switch :model-value="mongoIndexManagerSelected.isSparse" disabled :aria-label="t('mongo.indexSparse')" />
                  {{ t("mongo.indexSparse") }}
                </label>
                <label class="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                  <Switch :model-value="mongoIndexManagerSelected.background" disabled :aria-label="t('mongo.indexBackground')" />
                  {{ t("mongo.indexBackground") }}
                </label>
                <label v-if="mongoIndexManagerSelected.hidden" class="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                  <Switch :model-value="true" disabled :aria-label="t('mongo.indexHidden')" />
                  {{ t("mongo.indexHidden") }}
                </label>
              </template>
            </div>
            <template v-if="mongoIndexManagerSelected.propertiesComplete">
              <div class="grid min-w-0 gap-1.5">
                <span class="text-xs text-muted-foreground">{{ t("mongo.indexExpireAfterSeconds") }}</span>
                <span class="min-w-0 break-all font-mono text-sm">{{ mongoIndexManagerSelected.expireAfterSeconds ?? t("mongo.indexNoExpiry") }}</span>
              </div>
              <div v-if="mongoIndexManagerSelected.bucketSize !== undefined" class="grid min-w-0 gap-1.5">
                <span class="text-xs text-muted-foreground">{{ t("mongo.indexBucketSize") }}</span>
                <span class="min-w-0 break-all font-mono text-sm">{{ mongoIndexManagerSelected.bucketSize }}</span>
              </div>
            </template>
            <div v-if="mongoIndexManagerSelected.partialFilterExpression" class="grid min-w-0 gap-1.5">
              <span class="text-xs text-muted-foreground">{{ t("mongo.indexPartialFilter") }}</span>
              <span class="min-w-0 whitespace-pre-wrap break-all font-mono text-xs">{{ mongoIndexManagerSelected.partialFilterExpression }}</span>
            </div>
            <div v-if="mongoIndexManagerSelected.extraOptions" class="grid min-w-0 gap-1.5">
              <span class="text-xs text-muted-foreground">{{ t("mongo.indexOtherOptions") }}</span>
              <span class="min-w-0 whitespace-pre-wrap break-all font-mono text-xs">{{ mongoIndexManagerSelected.extraOptions }}</span>
            </div>
            <!-- The Legacy driver cannot report sparse/TTL/background, so say so
                 instead of rendering the defaults as if the server had sent them. -->
            <p v-if="!mongoIndexManagerSelected.propertiesComplete" class="text-xs text-muted-foreground">{{ t("mongo.indexPropertiesUnavailable") }}</p>
            <p v-if="mongoIndexManagerMode !== 'edit'" class="text-xs text-muted-foreground">{{ t("contextMenu.mongoIndexReadOnlyHint") }}</p>
          </template>
        </div>
      </section>
    </DialogContent>
  </Dialog>
</template>
