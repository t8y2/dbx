<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { MoreHorizontal } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { canEmptyDatabaseTables } from "@/composables/useDatabaseTableEmpty";
import { canDropDatabaseNode } from "@/lib/database/databaseBrowserActions";
import { openSidebarDangerDialog } from "@/lib/sidebar/sidebarDangerDialog";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig; database: string; catalog?: string }>();
const { t } = useI18n();
const runtime = ref<InstanceType<typeof SidebarTreeRuntimeHost> | null>(null);
const runtimeNode: TreeNode = { id: "__database-actions-runtime__", label: "", type: "connection-group" };
const items = ref<ContextMenuItem[]>([]);
const runtimeMounted = ref(false);
const target = computed<TreeNode>(() => ({
  id: `${props.connection.id}:${props.database}`,
  label: props.database,
  type: "database",
  connectionId: props.connection.id,
  database: props.database,
}));
// A catalog browser must not accidentally offer operations on the connection's database.
const available = computed(() => !props.catalog && (canEmptyDatabaseTables(target.value, props.connection) || canDropDatabaseNode(target.value, props.connection)));

async function onOpen(open: boolean) {
  if (!open) return;
  runtimeMounted.value = true;
  await nextTick();
  // Build only when opened: the runtime binds immutable targets to the actions.
  const menu = runtime.value?.buildContextMenu(target.value) ?? [];
  items.value = menu.find((item) => item.label === t("common.more"))?.children ?? [];
}
</script>

<template>
  <template v-if="available">
    <DropdownMenu @update:open="onOpen">
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="`${database} · ${t('common.more')}`" :aria-label="`${database} · ${t('common.more')}`">
          <MoreHorizontal class="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuLabel class="truncate" :title="database">{{ database }}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem v-for="item in items" :key="item.label" :disabled="typeof item.disabled === 'function' ? item.disabled() : item.disabled" variant="destructive" @select="item.action?.()">
          <component :is="item.icon" v-if="item.icon" class="h-3.5 w-3.5" />
          {{ item.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <SidebarTreeRuntimeHost v-if="runtimeMounted" ref="runtime" :node="runtimeNode" :depth="0" @open-danger-dialog="openSidebarDangerDialog" />
  </template>
</template>
