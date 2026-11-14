import { defineAsyncComponent, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { Blocks, ListTree, MoreHorizontal } from "@lucide/vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { buildSidebarMenuLayout, sidebarMenuScope, type SidebarMenuScope, type SidebarMenuTargetType } from "@/lib/sidebar/sidebarMenuLayout";

const SidebarMenuPreferencesDialog = defineAsyncComponent(() => import("@/components/sidebar/SidebarMenuPreferencesDialog.vue"));

function collapseSqlEditorMenuGroups(items: ContextMenuItem[], t: (key: string) => string): ContextMenuItem[] {
  const secondary: ContextMenuItem[] = [];
  const more: ContextMenuItem = { sidebarActionId: "common.more", label: t("common.more"), icon: MoreHorizontal, children: secondary };
  const result: ContextMenuItem[] = [];
  for (const item of items) {
    if (!item.sidebarActionId?.startsWith("group.") || item.variant === "destructive" || !item.children?.length) {
      result.push(item);
      continue;
    }
    if (!secondary.length) result.push(more);
    else secondary.push({ label: "", separator: true });
    secondary.push(...item.children);
  }
  return result;
}

/** Shared by the tree and database/object browsers; execution stays with each owner. */
export function useSidebarMenuPresentation() {
  const { t } = useI18n();
  const settings = useSettingsStore();
  const { toast } = useToast();
  const sidebarMenuPreferencesOpen = ref(false);
  const menuLayoutSaving = ref(false);
  const sidebarMenuPreferences = shallowRef<{ scope: SidebarMenuScope; items: ContextMenuItem[] } | null>(null);

  function presentMenu(originalItems: ContextMenuItem[], type: SidebarMenuTargetType): ContextMenuItem[] {
    const scope = sidebarMenuScope(type);
    if (!scope) return originalItems;
    const full = settings.editorSettings.sidebarMenuLayout === "full";
    let items = buildSidebarMenuLayout(originalItems, scope, settings.editorSettings.sidebarMenuLayout, settings.editorSettings.sidebarMenuPinnedActions?.[scope] ?? [], t, {
      hiddenPrimaryIds: settings.editorSettings.sidebarMenuHiddenPrimaryActions?.[scope],
      order: settings.editorSettings.sidebarMenuOrder?.[scope],
    });
    if (scope === "sql-editor" && !full) items = collapseSqlEditorMenuGroups(items, t);
    items.push({ label: "", separator: true });
    if (!full)
      items.push({
        label: t("sidebarMenu.customize"),
        icon: Blocks,
        action: () => {
          sidebarMenuPreferences.value = { scope, items: originalItems };
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
      refreshItems: () => presentMenu(originalItems, type),
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
