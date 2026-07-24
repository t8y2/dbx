import type { TableInfoTab } from "@/types/database";

export function tableInfoTabForDrawerToggle(drawerOpen: boolean, activeTab: TableInfoTab, preferredTab: TableInfoTab, requestedTab?: TableInfoTab): TableInfoTab {
  if (requestedTab) return requestedTab;
  return drawerOpen ? activeTab : preferredTab;
}
