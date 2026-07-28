<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Clock, Layers, SkipForward } from "@lucide/vue";

interface ConflictItem {
  objectName: string;
  conflictType: string;
  sourceValue: string;
  targetValue: string;
  autoResolvable: boolean;
}

interface RebaseInfo {
  id: string;
  baselineId: string;
  totalObjects: number;
  autoResolvedCount: number;
  conflictCount: number;
  conflicts: ConflictItem[];
  createdAt: string;
}

const props = defineProps<{
  rebaseInfo: RebaseInfo | null;
}>();

const emit = defineEmits<{
  overwriteBaseline: [];
  skipObject: [objectName: string];
}>();

const { t } = useI18n();

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
</script>

<template>
  <div class="rounded-md border bg-card">
    <div class="border-b px-4 py-3">
      <h3 class="text-sm font-medium">{{ t("rebase.title") }}</h3>
    </div>

    <div v-if="!rebaseInfo" class="flex items-center justify-center px-4 py-12 text-xs text-muted-foreground">
      {{ t("rebase.notes") }}
    </div>

    <template v-else>
      <div class="grid grid-cols-4 gap-4 border-b px-4 py-3">
        <div class="space-y-1">
          <div class="text-xs text-muted-foreground">{{ t("rebase.objectCount") }}</div>
          <div class="text-sm font-medium">{{ rebaseInfo.totalObjects }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-xs text-muted-foreground">{{ t("rebase.autoResolved") }}</div>
          <div class="text-sm font-medium text-green-600 dark:text-green-400">{{ rebaseInfo.autoResolvedCount }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-xs text-muted-foreground">{{ t("rebase.conflictCount") }}</div>
          <div class="text-sm font-medium" :class="rebaseInfo.conflictCount > 0 ? 'text-destructive' : ''">{{ rebaseInfo.conflictCount }}</div>
        </div>
        <div class="space-y-1">
          <div class="text-xs text-muted-foreground">{{ t("rebase.notes") }}</div>
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock class="h-3 w-3" />
            {{ formatDate(rebaseInfo.createdAt) }}
          </div>
        </div>
      </div>

      <div class="border-b px-4 py-3">
        <div class="mb-2 flex items-center gap-2">
          <Layers class="h-4 w-4 text-muted-foreground" />
          <span class="text-xs font-medium text-muted-foreground">{{ t("rebase.driftReport") }}</span>
        </div>
        <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">{{ t("rebase.currentBaseline") }}</span>
            <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ rebaseInfo.baselineId }}</code>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">{{ t("rebase.newBaseline") }}</span>
            <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ rebaseInfo.id }}</code>
          </div>
        </div>
      </div>

      <div v-if="rebaseInfo.conflicts.length > 0" class="border-b px-4 py-3">
        <div class="mb-2 flex items-center gap-2">
          <AlertTriangle class="h-4 w-4 text-amber-500" />
          <span class="text-xs font-medium text-muted-foreground">{{ t("rebase.conflicts") }}</span>
          <Badge variant="destructive" class="ml-auto text-xs">{{ rebaseInfo.conflictCount }}</Badge>
        </div>
        <div class="space-y-2">
          <div v-for="(conflict, index) in rebaseInfo.conflicts" :key="conflict.objectName" class="rounded-md border px-3 py-2 text-xs">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium" :class="conflict.autoResolvable ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'">
                  {{ index + 1 }}
                </div>
                <span class="font-medium">{{ conflict.objectName }}</span>
                <Badge variant="outline" class="text-[10px]">{{ conflict.conflictType }}</Badge>
                <Badge v-if="conflict.autoResolvable" variant="secondary" class="text-[10px]"> auto </Badge>
              </div>
              <Button size="sm" variant="ghost" class="h-7 gap-1 text-xs" @click="emit('skipObject', conflict.objectName)">
                <SkipForward class="h-3 w-3" />
                {{ t("rebase.skipObject") }}
              </Button>
            </div>
            <div class="mt-1.5 grid grid-cols-2 gap-3">
              <div>
                <div class="text-[10px] text-muted-foreground">Source</div>
                <code class="mt-0.5 block truncate rounded bg-muted/50 px-1 py-0.5 font-mono">{{ conflict.sourceValue }}</code>
              </div>
              <div>
                <div class="text-[10px] text-muted-foreground">Target</div>
                <code class="mt-0.5 block truncate rounded bg-muted/50 px-1 py-0.5 font-mono">{{ conflict.targetValue }}</code>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 px-4 py-3">
        <Button size="sm" class="gap-1.5 text-xs" @click="emit('overwriteBaseline')">
          <Check class="h-3.5 w-3.5" />
          {{ t("rebase.overwriteBaseline") }}
        </Button>
      </div>
    </template>
  </div>
</template>

<style scoped></style>
