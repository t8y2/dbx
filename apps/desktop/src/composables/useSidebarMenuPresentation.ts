import { defineAsyncComponent, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { Blocks, ListTree } from "@lucide/vue";
import { useAuthStore } from "@/stores/authStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { buildSidebarMenuLayout, sidebarMenuScope, type SidebarMenuScope, type SidebarMenuTargetType } from "@/lib/sidebar/sidebarMenuLayout";

const SidebarMenuPreferencesDialog = defineAsyncComponent(() => import("@/components/sidebar/SidebarMenuPreferencesDialog.vue"));

/** Shared by the tree and database/object browsers; execution stays with each owner. */
export function useSidebarMenuPresentation() {
  const { t } = useI18n();
  const settings = useSettingsStore();
  const auth = useAuthStore();
  const { toast } = useToast();
  const sidebarMenuPreferencesOpen = ref(false);
  const menuLayoutSaving = ref(false);
  const sidebarMenuPreferences = shallowRef<{ scope: SidebarMenuScope; items: ContextMenuItem[] } | null>(null);

  // 侧边栏右键菜单的功能权限过滤（Web RBAC）：条目按 sidebarActionId 映射到
  // 角色功能权限，未授权整项隐藏（children 被清空的父项一并移除）。桌面
  // bypass（isAdmin）恒为 true，过滤为无操作；未映射的条目不参与过滤。
  const ACTION_PERMISSIONS: Record<string, string> = {
    "transfer.dataTransfer": "transfer",
    "sqlFile.title": "sqlfile.execute",
    "diff.title": "schema.compare",
    "dataCompare.title": "data.compare",
    "databaseBackup.title": "backup.restore",
    "contextMenu.backupSqliteDatabase": "backup.restore",
    "contextMenu.restoreSqliteDatabase": "backup.restore",
    "contextMenu.importData": "import.data",
    "contextMenu.exportData": "export.data",
    "contextMenu.exportDatabase": "export.data",
    "contextMenu.exportAllDatabases": "export.data",
    "editor.contextMenu.export": "export.data",
    "contextMenu.editConnection": "connection.manage",
    "contextMenu.duplicateConnection": "connection.manage",
    "contextMenu.deleteConnection": "connection.manage",
  };

  function filterMenuPermissions(items: readonly ContextMenuItem[]): ContextMenuItem[] {
    return items.flatMap((item) => {
      if (item.separator || item.visible === false) return [item];
      const permission = item.sidebarActionId ? ACTION_PERMISSIONS[item.sidebarActionId] : undefined;
      if (permission && !auth.hasPermission(permission)) return [];
      if (item.children?.length) {
        const children = filterMenuPermissions(item.children);
        if (!children.length) return [];
        return [{ ...item, children }];
      }
      return [item];
    });
  }

  function presentMenu(originalItems: ContextMenuItem[], type: SidebarMenuTargetType): ContextMenuItem[] {
    const allowedItems = filterMenuPermissions(originalItems);
    const scope = sidebarMenuScope(type);
    if (!scope) return allowedItems;
    const full = settings.editorSettings.sidebarMenuLayout === "full";
    const items = buildSidebarMenuLayout(allowedItems, scope, settings.editorSettings.sidebarMenuLayout, settings.editorSettings.sidebarMenuPinnedActions?.[scope] ?? [], t, {
      hiddenPrimaryIds: settings.editorSettings.sidebarMenuHiddenPrimaryActions?.[scope],
      order: settings.editorSettings.sidebarMenuOrder?.[scope],
    });
    items.push({ label: "", separator: true });
    if (!full)
      items.push({
        label: t("sidebarMenu.customize"),
        icon: Blocks,
        action: () => {
          sidebarMenuPreferences.value = { scope, items: allowedItems };
          sidebarMenuPreferencesOpen.value = true;
        },
      });
    items.push({
      sidebarActionId: "menu.layout",
      label: t("sidebarMenu.useFull"),
      icon: ListTree,
      checked: full,
      checkedStyle: "switch",
      disabled: () => menuLayoutSaving.value,
      closeOnSelect: false,
      refreshItems: () => presentMenu(allowedItems, type),
      action: () => {
        if (menuLayoutSaving.value) return;
        menuLayoutSaving.value = true;
        return settings
          .updateEditorSettingsAndPersist({ sidebarMenuLayout: full ? "grouped" : "full" })
          .catch((error) => toast(t("sidebarMenu.saveFailed", { message: String(error) }), 5000))
          .finally(() => {
            menuLayoutSaving.value = false;
          });
      },
    });
    return items;
  }

  return { presentMenu, SidebarMenuPreferencesDialog, sidebarMenuPreferencesOpen, sidebarMenuPreferences };
}
