<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { CheckCircle2, XCircle, GitMerge } from "@lucide/vue";

const { t } = useI18n();

interface ConflictItem {
  objectName: string;
  conflictType: string;
  sourceValue: string;
  targetValue: string;
  autoResolvable: boolean;
}

const props = defineProps<{
  conflicts: ConflictItem[];
}>();

const emit = defineEmits<{
  resolveWithSource: [objectName: string];
  resolveWithTarget: [objectName: string];
}>();
</script>

<template>
  <div class="border rounded-md bg-card">
    <div class="flex items-center gap-2 px-3 py-2 border-b">
      <GitMerge class="w-4 h-4 text-primary" />
      <h3 class="text-sm font-medium">{{ t("conflictMatrix.title") }}</h3>
    </div>

    <div v-if="conflicts.length === 0" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
      {{ t("conflictMatrix.noConflicts") }}
    </div>

    <div v-else class="p-3">
      <div class="border rounded overflow-hidden">
        <table class="w-full text-xs">
          <thead>
            <tr class="bg-muted/30">
              <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("conflictMatrix.objectName") }}</th>
              <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("conflictMatrix.conflictType") }}</th>
              <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("conflictMatrix.sourceValue") }}</th>
              <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("conflictMatrix.targetValue") }}</th>
              <th class="text-center px-2 py-1.5 font-medium text-muted-foreground">{{ t("conflictMatrix.autoResolvable") }}</th>
              <th class="text-right px-2 py-1.5 font-medium text-muted-foreground">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in conflicts" :key="c.objectName" class="border-t" :class="c.autoResolvable ? 'bg-emerald-500/5' : 'bg-red-500/5'">
              <td class="px-2 py-1.5 font-mono">{{ c.objectName }}</td>
              <td class="px-2 py-1.5">{{ c.conflictType }}</td>
              <td class="px-2 py-1.5 font-mono max-w-[200px] truncate" :title="c.sourceValue">{{ c.sourceValue }}</td>
              <td class="px-2 py-1.5 font-mono max-w-[200px] truncate" :title="c.targetValue">{{ c.targetValue }}</td>
              <td class="px-2 py-1.5 text-center">
                <CheckCircle2 v-if="c.autoResolvable" class="w-4 h-4 text-green-500 inline-block" />
                <XCircle v-else class="w-4 h-4 text-red-500 inline-block" />
              </td>
              <td class="px-2 py-1.5 text-right">
                <div v-if="!c.autoResolvable" class="flex items-center justify-end gap-1">
                  <button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors" @click="emit('resolveWithSource', c.objectName)">
                    {{ t("conflictMatrix.resolveWithSource") }}
                  </button>
                  <button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted/40 text-muted-foreground hover:bg-muted/60 transition-colors" @click="emit('resolveWithTarget', c.objectName)">
                    {{ t("conflictMatrix.resolveWithTarget") }}
                  </button>
                </div>
                <span v-else class="text-[10px] text-green-600 dark:text-green-400 font-medium">
                  {{ t("conflictMatrix.resolved") }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped></style>
