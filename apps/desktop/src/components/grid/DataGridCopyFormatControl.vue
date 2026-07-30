<script setup lang="ts">
import { Check, ChevronDown, Copy, Settings2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { DataGridToolbarMenuItem } from "@/lib/dataGrid/dataGridToolbar";

defineProps<{
  currentLabel: string;
  currentValue: string;
  items: readonly DataGridToolbarMenuItem[];
}>();

const emit = defineEmits<{
  configure: [];
  select: [value: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
    <span class="flex min-w-0 items-center gap-2 font-medium">
      <Copy class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span>{{ t("grid.copyExtractorDefaultFormat") }}</span>
    </span>
    <div class="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="h-6 max-w-52 min-w-0 gap-1 px-2 text-xs">
            <span class="truncate">{{ currentLabel }}</span>
            <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-52">
          <template v-for="item in items" :key="item.value">
            <DropdownMenuSeparator v-if="item.separatorBefore" />
            <DropdownMenuItem class="gap-2" :disabled="item.disabled" @select="emit('select', item.value)">
              <span class="flex-1">{{ item.label }}</span>
              <Check v-if="currentValue === item.value" class="h-3.5 w-3.5 shrink-0 text-primary" />
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('grid.copyExtractorConfigure')" :aria-label="t('grid.copyExtractorConfigure')" @click="emit('configure')">
        <Settings2 class="h-3.5 w-3.5" />
      </Button>
    </div>
  </div>
</template>
