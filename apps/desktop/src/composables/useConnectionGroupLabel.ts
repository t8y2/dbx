import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";

/** Resolves the sidebar group path label for connection dropdown options. */
export function useConnectionGroupLabel() {
  const connectionStore = useConnectionStore();
  const { connectionGroupPaths } = storeToRefs(connectionStore);
  const { t } = useI18n();

  function connectionGroupLabel(connectionId: string): string {
    return connectionGroupPaths.value.get(connectionId)?.join(" / ") || t("connectionGroup.ungroupedLabel");
  }

  return { connectionGroupPaths, connectionGroupLabel };
}
