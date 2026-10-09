<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { Switch } from "@/components/ui/switch";
import type { CustomTypeDropPreview, CustomTypeIdentity } from "@/types/database";

/**
 * Delete confirmation for a user-defined type.
 *
 * Wraps the shared danger dialog so the drop keeps the same visual language as
 * table drops, and adds the two things only this object needs: the dependent
 * object list, and an explicit CASCADE switch.
 */
const open = defineModel<boolean>("open", { default: false });
const cascade = defineModel<boolean>("cascade", { default: false });

const props = withDefaults(
  defineProps<{
    target: CustomTypeIdentity | null;
    preview: CustomTypeDropPreview | null;
    loading?: boolean;
    previewLoading?: boolean;
    error?: string | null;
  }>(),
  { loading: false, previewLoading: false, error: null },
);

const emit = defineEmits<{ confirm: []; "update:cascade": [value: boolean] }>();
const { t } = useI18n();

const dependencies = computed(() => props.preview?.dependencies ?? []);
const dependenciesComplete = computed(() => props.preview?.dependenciesComplete !== false);
const blocked = computed(() => props.preview?.blockedChanges ?? []);
const warnings = computed(() => props.preview?.warnings ?? []);
const qualified = computed(() => (props.target ? `${props.target.schema}.${props.target.name}` : ""));
</script>

<template>
  <DangerConfirmDialog
    v-model:open="open"
    :title="t('customType.delete.title')"
    :message="t('customType.delete.message', { name: qualified })"
    :details-text="qualified"
    :sql="preview?.statement ?? ''"
    :confirm-label="t('dangerDialog.deleteConfirm')"
    :loading="loading"
    :confirm-disabled="!preview || !!error || blocked.length > 0 || previewLoading"
    :close-on-confirm="false"
    @confirm="emit('confirm')"
  >
    <template #options>
      <div class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <Switch :disabled="loading" class="mt-0.5" :model-value="cascade" @update:model-value="emit('update:cascade', $event)" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("customType.delete.cascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("customType.delete.cascadeHint") }}</span>
        </span>
      </div>

      <div class="mb-3 rounded-md border">
        <div class="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
          <span class="text-xs font-medium">{{ t("customType.dependencies.title") }}</span>
          <span class="text-[11px] text-muted-foreground">{{ dependencies.length }}</span>
        </div>
        <div v-if="previewLoading" class="px-3 py-2 text-xs text-muted-foreground">{{ t("common.loading") }}</div>
        <div v-else-if="!dependenciesComplete" class="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">{{ t("customType.dependencies.unknown") }}</div>
        <div v-else-if="dependencies.length === 0" class="px-3 py-2 text-xs text-muted-foreground">{{ t("customType.dependencies.empty") }}</div>
        <ul v-else class="max-h-40 overflow-auto">
          <li v-for="dependency in dependencies" :key="dependency.catalogId ?? `${dependency.kind}-${dependency.description}`" class="flex items-center gap-2 border-b border-border/60 px-3 py-1 text-[11px] last:border-b-0">
            <span class="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">{{ dependency.kind }}</span>
            <span class="min-w-0 truncate font-mono" :title="dependency.description">{{ dependency.description }}</span>
          </li>
        </ul>
      </div>

      <div v-for="issue in blocked" :key="`blocked-${issue.code}`" class="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
        {{ issue.message }}
      </div>
      <div v-for="issue in warnings" :key="`warn-${issue.code}-${issue.message}`" class="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
        {{ issue.message }}
      </div>
      <div v-if="error" class="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{{ error }}</div>
    </template>
  </DangerConfirmDialog>
</template>
