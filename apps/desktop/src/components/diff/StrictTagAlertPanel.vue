<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { AlertTriangle, ShieldAlert } from "@lucide/vue";

const { t } = useI18n();

interface TagViolation {
  fileName: string;
  lineNumber: number;
  tagName: string;
  suggestion: string;
}

const props = defineProps<{
  violations: TagViolation[];
  blocking: boolean;
}>();

const emit = defineEmits<{
  registerTag: [tagName: string];
  removeTag: [tagName: string];
  ignore: [tagName: string];
}>();
</script>

<template>
  <div class="border rounded-md bg-card">
    <div class="flex items-center gap-2 px-3 py-2 border-b">
      <ShieldAlert class="w-4 h-4 text-amber-500" />
      <h3 class="text-sm font-medium">{{ t("strictTag.title") }}</h3>
    </div>

    <div v-if="blocking" class="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-900/30">
      <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
      <span>{{ t("strictTag.blockingExecution") }}</span>
    </div>

    <div v-if="violations.length === 0" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
      {{ t("strictTag.noViolations") }}
    </div>

    <template v-else>
      <div class="px-3 pt-3 pb-1 text-xs text-muted-foreground">
        {{ t("strictTag.violationsFound", { count: violations.length }) }}
      </div>

      <div class="p-3">
        <div class="border rounded overflow-hidden">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-muted/30">
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("strictTag.fileName") }}</th>
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("strictTag.lineNumber") }}</th>
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("strictTag.tagName") }}</th>
                <th class="text-left px-2 py-1.5 font-medium text-muted-foreground">{{ t("strictTag.suggestion") }}</th>
                <th class="text-right px-2 py-1.5 font-medium text-muted-foreground">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in violations" :key="`${v.fileName}:${v.lineNumber}:${v.tagName}`" class="border-t">
                <td class="px-2 py-1.5 font-mono">{{ v.fileName }}</td>
                <td class="px-2 py-1.5">{{ v.lineNumber }}</td>
                <td class="px-2 py-1.5 font-mono">{{ v.tagName }}</td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ v.suggestion }}</td>
                <td class="px-2 py-1.5 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors" @click="emit('registerTag', v.tagName)">
                      {{ t("strictTag.registerTag") }}
                    </button>
                    <button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors" @click="emit('removeTag', v.tagName)">
                      {{ t("strictTag.removeTag") }}
                    </button>
                    <button class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted/40 text-muted-foreground hover:bg-muted/60 transition-colors" @click="emit('ignore', v.tagName)">
                      {{ t("strictTag.ignore") }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped></style>
