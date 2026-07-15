import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { buildConnectionGroupPathMap } from "@/lib/sidebar/sidebarLayout";
import { useConnectionStore } from "@/stores/connectionStore";

/** Resolves the sidebar group path label for connection dropdown options. */
export function useConnectionGroupLabel() {
  const connectionStore = useConnectionStore();
  const { t } = useI18n();
  const connectionGroupPaths = computed(() => buildConnectionGroupPathMap(connectionStore.sidebarLayout));

  function connectionGroupLabel(connectionId: string): string {
    return connectionGroupPaths.value.get(connectionId)?.join(" / ") || t("connectionGroup.ungroupedLabel");
  }

  return { connectionGroupPaths, connectionGroupLabel };
}
