import { Star, Link, Trash2 } from "@lucide/vue";
import { useFavoritesStore } from "@/stores/favoritesStore";
import { favoriteTargetFromNode, favoriteTargetKey } from "./target";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

export function tableFavoriteMenuItems(node: TreeNode, config: ConnectionConfig | undefined, t: (key: string, params?: Record<string, string>) => string): ContextMenuItem[] {
  const target = favoriteTargetFromNode(node, config);
  if (!target) return [];
  const store = useFavoritesStore();
  const existing = store.byTarget.get(favoriteTargetKey(target));
  const items: ContextMenuItem[] = [
    {
      label: t(existing ? "favorites.edit" : "favorites.add"),
      icon: Star,
      action: () => {
        void store.addTarget(target);
      },
    },
  ];
  if (store.relinking) {
    const item = { ...store.relinking };
    items.unshift({
      label: t("favorites.linkHere", { name: item.name }),
      icon: Link,
      action: () => {
        store.dialog = { mode: "relink", item, target };
      },
    });
  }
  // Removal is available in the edit dialog too, keeping failures visible there.
  if (existing)
    items.push({
      label: t("favorites.remove"),
      icon: Trash2,
      action: () => {
        store.dialog = { mode: "edit", item: { ...existing }, remove: true };
      },
    });
  return items;
}
