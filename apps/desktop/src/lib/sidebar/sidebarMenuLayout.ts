import { ArrowRightLeft, Clipboard, Code2, FolderTree, ListTree, Settings2, TriangleAlert, Wrench } from "@lucide/vue";
import type { ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import type { TreeNodeType } from "@/types/database";
import { SIDEBAR_MENU_SCOPES, type SidebarMenuLayout, type SidebarMenuScope } from "./sidebarMenuPreferences";

export { normalizeSidebarMenuPinnedActions, normalizeSidebarMenuOrder } from "./sidebarMenuPreferences";
export type { SidebarMenuLayout, SidebarMenuScope, SidebarMenuPinnedActions, SidebarMenuOrder } from "./sidebarMenuPreferences";
export type SidebarMenuTargetType = TreeNodeType | "sql-editor";
export interface SidebarMenuLayoutOptions {
  hiddenPrimaryIds?: readonly string[];
  order?: readonly string[];
}
type MenuGroup = "data" | "sql" | "structure" | "copy" | "selection" | "organize" | "manage" | "other" | "danger";
type Translate = (key: string) => string;

const scopes = new Set<SidebarMenuScope>(SIDEBAR_MENU_SCOPES);

export function sidebarMenuScope(type: SidebarMenuTargetType): SidebarMenuScope | null {
  if (type === "materialized_view") return "view";
  return scopes.has(type as SidebarMenuScope) ? (type as SidebarMenuScope) : null;
}

const primaryActions: Record<SidebarMenuScope, readonly string[]> = {
  connection: ["connection.cancelConnecting", "contextMenu.openConnection", "contextMenu.disconnectConnection", "contextMenu.newQuery", "contextMenu.openDatabaseBrowser", "contextMenu.editConnection", "contextMenu.refreshChildren"],
  database: ["contextMenu.openObjectBrowser", "contextMenu.newQuery", "contextMenu.createTable", "contextMenu.refreshChildren"],
  schema: ["contextMenu.openObjectBrowser", "contextMenu.newQuery", "contextMenu.createTable", "contextMenu.refreshChildren"],
  table: ["contextMenu.viewData", "contextMenu.openInNewDataTab", "contextMenu.editStructure", "contextMenu.newQuery", "contextMenu.refreshChildren"],
  view: ["contextMenu.viewData", "contextMenu.openInNewDataTab", "contextMenu.editView", "contextMenu.newQuery", "contextMenu.refreshChildren"],
  "sql-editor": ["editor.execute", "editor.format", "editor.contextMenu.copySelection", "editor.contextMenu.cutSelection", "editor.contextMenu.pasteFromClipboard", "editor.contextMenu.findReplace"],
};

const recommendedPrimaryActions: Partial<Record<SidebarMenuScope, readonly string[]>> = {
  connection: ["contextMenu.serverDashboard", "contextMenu.processList", "contextMenu.sqlServerTrace", "contextMenu.instanceInfo", "contextMenu.damengJobAdmin", "contextMenu.configureVisibleObjects", "visibleSchemas.title"],
  database: ["sidebar.togglePinnedObject", "visibleSchemas.title"],
  schema: ["sidebar.togglePinnedObject"],
  table: ["sidebar.togglePinnedObject"],
  view: ["sidebar.togglePinnedObject"],
  "sql-editor": ["toolbar.explainPlan", "editor.contextMenu.uppercaseSelection", "editor.contextMenu.lowercaseSelection", "editor.contextMenu.screenshotSelection"],
};

export function sidebarMenuRecommendedPrimaryActionIds(scope: SidebarMenuScope): readonly string[] {
  return recommendedPrimaryActions[scope] ?? [];
}

/** Connection status changes should not move the user's connect/disconnect entry. */
export function sidebarMenuEntryKey(item: ContextMenuItem): string | undefined {
  if (item.sidebarActionId && primaryActions.connection.slice(0, 3).includes(item.sidebarActionId)) return "action.connectionState";
  return item.sidebarActionId;
}

export function sortSidebarMenuEntries(items: readonly ContextMenuItem[], order: readonly string[]): ContextMenuItem[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(sidebarMenuEntryKey(a.item) ?? "") ?? order.length) - (rank.get(sidebarMenuEntryKey(b.item) ?? "") ?? order.length) || a.index - b.index)
    .map(({ item }) => item);
}

/** Replace only the visible subsequence, retaining positions of unavailable entries. */
export function reorderSidebarMenuEntries(savedOrder: readonly string[], visibleIds: readonly string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= visibleIds.length || to >= visibleIds.length || from === to) return [...savedOrder];
  const reordered = [...visibleIds];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);
  const visible = new Set(visibleIds);
  let index = 0;
  const result = savedOrder.map((id) => (visible.has(id) ? reordered[index++]! : id));
  result.push(...reordered.slice(index));
  return result;
}

const groupActions: Partial<Record<MenuGroup, readonly string[]>> = {
  data: ["contextMenu.importData", "contextMenu.exportData", "contextMenu.exportDatabase", "contextMenu.exportAllDatabases", "transfer.dataTransfer", "dataCompare.title", "contextMenu.backupSqliteDatabase", "contextMenu.restoreSqliteDatabase", "databaseBackup.title", "databaseSearch.open"],
  sql: ["contextMenu.generateSql", "contextMenu.sqlHistory", "contextMenu.addToAi", "modelGeneration.title", "sqlFile.title"],
  structure: ["contextMenu.viewDdl", "contextMenu.viewSource", "contextMenu.viewDependencies", "contextMenu.exportStructure", "contextMenu.duplicateStructure", "contextMenu.renameObject", "contextMenu.compileObject", "diagram.open", "docs.title", "diff.title", "dataDictionary.title"],
  copy: ["contextMenu.copyName", "contextMenu.copyConnectionInfo", "contextMenu.copyStructureAs", "contextMenu.copyFinalProxyPort", "contextMenu.copyTable", "contextMenu.pasteTable"],
  organize: [
    "contextMenu.setDefaultDatabase",
    "contextMenu.clearDefaultDatabase",
    "contextMenu.setDefaultSchema",
    "contextMenu.clearDefaultSchema",
    "contextMenu.editDatabaseProperties",
    "contextMenu.renameDatabase",
    "contextMenu.createSchema",
    "contextMenu.editSchemaComment",
    "contextMenu.configureVisibleObjects",
    "visibleSchemas.title",
    "connectionGroup.moveToGroup",
    "connectionGroup.moveToNewGroup",
    "contextMenu.duplicateConnection",
    "connection.disconnectAndForgetPassword",
    "contextMenu.closeDatabaseConnection",
    "contextMenu.revealDatabaseFile",
    "contextMenu.changeOpenMode",
    "tableVGroup.moveToGroup",
    "tableVGroup.removeFromGroup",
    "tableVGroup.moveToNewGroup",
    "sidebar.togglePinnedObject",
  ],
  manage: [
    "contextMenu.createDatabase",
    "contextMenu.userAdmin",
    "contextMenu.processList",
    "contextMenu.sqlServerTrace",
    "contextMenu.serverDashboard",
    "contextMenu.instanceInfo",
    "contextMenu.damengUsers",
    "contextMenu.damengRoles",
    "contextMenu.damengJobAdmin",
    "contextMenu.vacuumTable",
    "contextMenu.mysqlAutoIncrement",
  ],
};

const groupIcons = { data: ArrowRightLeft, sql: Code2, structure: FolderTree, copy: Clipboard, selection: ListTree, organize: Settings2, manage: Wrench, other: ListTree, danger: TriangleAlert };
const groupOrder: MenuGroup[] = ["structure", "copy", "data", "sql", "selection", "organize", "manage", "other", "danger"];

export function sidebarMenuActionGroup(item: ContextMenuItem): MenuGroup {
  const id = item.sidebarActionId;
  if (id?.startsWith("editor.object.") || id === "editor.contextMenu.expandSelectStar") return "structure";
  if (id === "settings.shortcutExecuteSqlInNewResultTab" || id === "toolbar.explainPlan" || id === "editor.previewChanges" || id === "editor.contextMenu.export") return "data";
  if (id === "editor.contextMenu.copySelectionAsRichText" || id === "editor.contextMenu.screenshotSelection" || id === "editor.contextMenu.pasteRestoringSourceSql") return "copy";
  if (id === "editor.contextMenu.folding" || id === "editor.contextMenu.addNextSelectionOccurrence" || id === "editor.contextMenu.selectAllSelectionOccurrences" || id === "editor.contextMenu.selectCurrentStatement" || id === "editor.contextMenu.selectAll") return "selection";
  if (id?.startsWith("editor.contextMenu.")) return "sql";
  for (const [group, ids] of Object.entries(groupActions)) if (id && ids.includes(id)) return group as MenuGroup;
  return item.variant === "destructive" ? "danger" : "other";
}

/** The old More wrapper contains independent actions, including maintenance. */
export function sidebarMenuActions(items: readonly ContextMenuItem[]): ContextMenuItem[] {
  return items.flatMap((item) => {
    if (item.separator || item.visible === false) return [];
    return item.sidebarActionId === "common.more" && item.children ? sidebarMenuActions(item.children) : [item];
  });
}

export function sidebarMenuPrimaryActionIds(scope: SidebarMenuScope): readonly string[] {
  return primaryActions[scope];
}

/** Keep existing callbacks, state and guards, while avoiding a third menu level. */
function flattenMenuItem(item: ContextMenuItem, prefix = ""): ContextMenuItem[] {
  if (item.separator || item.visible === false) return [];
  const label = prefix ? `${prefix} · ${item.label}` : item.label;
  if (!item.children?.length) return [{ ...item, label }];
  return item.children.flatMap((child) =>
    flattenMenuItem(
      {
        ...child,
        variant: child.variant ?? item.variant,
        disabled: () => (typeof item.disabled === "function" ? item.disabled() : !!item.disabled) || (typeof child.disabled === "function" ? child.disabled() : !!child.disabled),
      },
      label,
    ),
  );
}

export function buildSidebarMenuLayout(items: readonly ContextMenuItem[], scope: SidebarMenuScope, layout: SidebarMenuLayout, pinnedIds: readonly string[], t: Translate, options: SidebarMenuLayoutOptions = {}): ContextMenuItem[] {
  if (layout === "full") return [...items];
  const actions = sidebarMenuActions(items);
  const primary: ContextMenuItem[] = [];
  const groups = new Map<MenuGroup, ContextMenuItem[]>();
  const builtInIds = new Set(primaryActions[scope]);
  const recommendedIds = new Set(sidebarMenuRecommendedPrimaryActionIds(scope));
  const hiddenIds = new Set(options.hiddenPrimaryIds ?? []);
  const pinned = new Set(pinnedIds);
  const extensions: ContextMenuItem[] = [];
  for (const item of actions) {
    // Untagged engine/plugin menus retain their existing structure and callbacks.
    if (!item.sidebarActionId) {
      extensions.push(item);
      continue;
    }
    const actionGroup = sidebarMenuActionGroup(item);
    const group: MenuGroup = scope === "connection" && ["data", "sql", "structure"].includes(actionGroup) ? "manage" : (scope === "table" || scope === "view") && actionGroup === "manage" ? "structure" : actionGroup;
    if (group !== "danger" && (builtInIds.has(item.sidebarActionId) || pinned.has(item.sidebarActionId) || (recommendedIds.has(item.sidebarActionId) && !hiddenIds.has(item.sidebarActionId)))) {
      primary.push(item);
      continue;
    }
    const children = groups.get(group) ?? [];
    children.push(...flattenMenuItem(item));
    groups.set(group, children);
  }
  primary.sort((a, b) => {
    const rank = (item: ContextMenuItem) => {
      const base = primaryActions[scope].indexOf(item.sidebarActionId!);
      const recommended = sidebarMenuRecommendedPrimaryActionIds(scope).indexOf(item.sidebarActionId!);
      return base >= 0 ? base : primaryActions[scope].length + (recommended >= 0 ? recommended : recommendedIds.size + pinnedIds.indexOf(item.sidebarActionId!));
    };
    return rank(a) - rank(b);
  });
  const result = sortSidebarMenuEntries(primary, options.order ?? []);
  if (primary.length && (groups.size || extensions.length)) result.push({ label: "", separator: true });
  const groupItems: ContextMenuItem[] = [];
  let dangerItem: ContextMenuItem | undefined;
  for (const group of groupOrder) {
    const children = groups.get(group);
    if (!children?.length) continue;
    const labelKey =
      group === "organize"
        ? scope === "connection"
          ? "connectionSettings"
          : scope === "database"
            ? "databaseSettings"
            : scope === "schema"
              ? "schemaSettings"
              : scope === "table"
                ? "tableSettings"
                : scope === "view"
                  ? "viewSettings"
                  : "organize"
        : scope === "connection" && group === "manage"
          ? "connectionTools"
          : scope === "sql-editor" && group === "data"
            ? "execution"
            : scope === "sql-editor" && group === "sql"
              ? "sqlEditor"
              : group;
    const item: ContextMenuItem = { sidebarActionId: `group.${group}`, label: t(`sidebarMenu.groups.${labelKey}`), icon: groupIcons[group], children, variant: group === "danger" ? "destructive" : "default" };
    if (group === "danger") dangerItem = item;
    else groupItems.push(item);
  }
  result.push(...sortSidebarMenuEntries(groupItems, options.order ?? []));
  if (extensions.length) result.push({ label: "", separator: true }, ...extensions);
  if (dangerItem) {
    if (result.length && !result[result.length - 1]?.separator) result.push({ label: "", separator: true });
    result.push(dangerItem);
  }
  return result;
}
