<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SidebarActivation } from "@/lib/sidebar/treeNodeClick";

defineProps<{ activation: SidebarActivation; columnAction: "structure" | "query" }>();
const emit = defineEmits<{ "update:activation": [value: SidebarActivation]; "update:columnAction": [value: "structure" | "query"] }>();
const { t } = useI18n();
</script>

<template>
  <div class="space-y-5">
    <div class="space-y-2">
      <Label>{{ t("settings.sidebarActivation") }}</Label>
      <div class="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="activation === 'single' ? 'dbx-choice-selected' : ''" @click="emit('update:activation', 'single')">
          <div class="text-left">
            <div class="text-sm font-medium">
              {{ t("settings.sidebarActivationSingle") }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ t("settings.sidebarActivationSingleDescription") }}
            </div>
          </div>
        </Button>
        <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="activation === 'double' ? 'dbx-choice-selected' : ''" @click="emit('update:activation', 'double')">
          <div class="text-left">
            <div class="text-sm font-medium">
              {{ t("settings.sidebarActivationDouble") }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ t("settings.sidebarActivationDoubleDescription") }}
            </div>
          </div>
        </Button>
      </div>
    </div>

    <div class="space-y-2">
      <Label for="sidebar-column-double-click-action">{{ t("settings.sidebarColumnDoubleClickAction") }}</Label>
      <Select :model-value="columnAction" @update:model-value="(value) => emit('update:columnAction', value === 'query' ? 'query' : 'structure')">
        <SelectTrigger id="sidebar-column-double-click-action"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="structure">{{ t("settings.sidebarColumnDoubleClickStructure") }}</SelectItem>
          <SelectItem value="query">{{ t("settings.sidebarColumnDoubleClickQuery") }}</SelectItem>
        </SelectContent>
      </Select>
      <p class="text-xs text-muted-foreground">{{ t("settings.sidebarColumnDoubleClickDescription") }}</p>
    </div>
  </div>
</template>
