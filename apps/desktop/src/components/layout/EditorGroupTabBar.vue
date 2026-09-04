<script lang="ts">
import { reactive } from "vue";

/**
 * Drag session state lives at module scope, shared by every group's tab bar
 * instance: the source bar starts the drag, but the insertion indicator must
 * render on the targeted pill — which may belong to another group's bar.
 */
const groupTabDrag = reactive({
  active: false,
  tabId: null as string | null,
  sourceGroupId: null as string | null,
  payload: "",
  startX: 0,
  startY: 0,
  targetGroupId: null as string | null,
  targetTabId: null as string | null,
  position: null as "before" | "after" | null,
  pointerId: null as number | null,
});

let groupTabDragGhost: HTMLElement | null = null;
let groupTabDragSourceEl: HTMLElement | null = null;

/** Horizontal distance (px) required before a press becomes a tab drag; absorbs click jitter. */
const TAB_DRAG_HORIZONTAL_THRESHOLD = 24;
</script>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowRight,
  CalendarClock,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Copy,
  Database,
  Gauge,
  KeyRound,
  ListFilter,
  Maximize2,
  Minimize2,
  Network,
  PanelTop,
  Pencil,
  PencilRuler,
  Pin,
  RotateCcw,
  RotateCw,
  Search,
  ShieldCheck,
  Table2,
  TableProperties,
  X,
  Activity,
} from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import TabExecutionStatus from "@/components/layout/TabExecutionStatus.vue";
import ReadOnlySessionControl from "@/components/connection/ReadOnlySessionControl.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { EditorSettings } from "@/stores/settingsStore";
import { useTabScroll } from "@/composables/useTabScroll";
import { useToast } from "@/composables/useToast";
import { hexToRgba } from "@/lib/common/color";
import { copyToClipboard } from "@/lib/common/clipboard";
import { parseTabDragPayload, serializeTabDragPayload } from "@/lib/tabs/tabDrag";
import { createCloseAllTabMenuItem, createCloseLeftTabMenuItem, createCloseOtherTabMenuItem, createCloseRightTabMenuItem, createCloseTabMenuItem, createLocateTabMenuItem, createPinTabMenuItem, createRenameDuplicateTabItems } from "@/lib/tabs/tabMenu";
import { connectionColor, dirtyTabTitleStyle, tabColorStyle as sharedTabColorStyle, tabDatabaseIconType, tabDisplayTitle, tabIconClass, tabTooltipLines } from "@/lib/tabs/tabPresentation";
import { activeTabSidebarTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import "./appTabBar.css";
import type { QueryTab } from "@/types/database";

const props = defineProps<{
  groupId: string;
  tabs: QueryTab[];
  activeTabId: string | null;
  /** Shared vertical-strip width/collapse state owned by App (usePanelResize). */
  tabBarWidth?: number;
  tabBarCollapsed?: boolean;
  /** Detaching tabs into their own window is a desktop-only capability. */
  canDetachTabs?: boolean;
  /** A detached tab is being dragged over this bar — highlight it as the drop target. */
  detachedDropTarget?: boolean;
}>();

const emit = defineEmits<{
  "activate-tab": [tabId: string];
  "locate-tab": [tab: QueryTab];
  "toggle-zen-mode": [];
  "start-resize": [event: MouseEvent];
  "toggle-collapse": [];
  "detach-tab": [tab: QueryTab];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const tabsContainerRef = ref<HTMLElement | null>(null);
const { hasTabOverflow, scrollThumbLeftPercent, scrollThumbWidthPercent, isScrollbarDragging, updateScrollButtons, onTabsWheel, startScrollbarDrag } = useTabScroll(tabsContainerRef);
const editingTabId = ref<string | null>(null);
const editingTitle = ref("");
// Drag suppression must survive pointerup: the browser fires click *after*
// pointerup, so the flag is consumed by the click instead of being cleared
// with the drag state. A fresh pointerdown always resets it.
const suppressNextTabClick = ref(false);
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
const isVerticalLayout = computed(() => settingsStore.editorSettings.tabPlacement === "left" || settingsStore.editorSettings.tabPlacement === "right");
const isWrapLayout = computed(() => !isVerticalLayout.value && settingsStore.editorSettings.tabLayout === "wrap");
// The icon-only collapse only exists in the vertical toolbar; horizontal
// placements must ignore the persisted collapse state entirely.
const isTabBarCollapsed = computed(() => isVerticalLayout.value && !!props.tabBarCollapsed);
const tabBarStyle = computed<CSSProperties | undefined>(() => {
  if (!isVerticalLayout.value) return undefined;
  if (props.tabBarCollapsed) return { width: "3.5rem", flex: "0 0 3.5rem" };
  const width = props.tabBarWidth ?? 240;
  return { width: `${width}px`, flex: `0 0 ${width}px` };
});
const tabBarCollapseIcon = computed(() => {
  const isLeft = settingsStore.editorSettings.tabPlacement === "left";
  if (props.tabBarCollapsed) return isLeft ? ChevronsRight : ChevronsLeft;
  return isLeft ? ChevronsLeft : ChevronsRight;
});
const tabBarCollapseLabel = computed(() => t(props.tabBarCollapsed ? "tabs.expandTabBar" : "tabs.collapseTabBar"));
const verticalTabToolbarButtonClass = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const groupCapacityReached = computed(() => queryStore.groups.length >= 4);
const splitUnavailable = computed(() => groupCapacityReached.value || queryStore.tabs.length <= 1);
const canChangeOrientation = computed(() => queryStore.groups.length >= 2);
const isSecondaryGroup = computed(() => queryStore.groups[0]?.id !== props.groupId);
const compactTabTitle = computed({
  get: () => settingsStore.editorSettings.compactTabTitle,
  set: (checked: boolean | "indeterminate") => {
    settingsStore.updateEditorSettings({ compactTabTitle: checked === true });
  },
});

function toggleCompactTabTitle() {
  compactTabTitle.value = !compactTabTitle.value;
}

const tabBarClass = computed(() => [
  isVerticalLayout.value
    ? `vertical-tab-layout h-full w-60 flex-col bg-background ${settingsStore.editorSettings.tabPlacement === "right" ? "border-l" : "border-r"}`
    : isClassicLayout.value
      ? "bg-muted"
      : `bg-background ${settingsStore.editorSettings.tabPlacement === "bottom" ? "border-t" : "border-b"}`,
  isVerticalLayout.value && props.tabBarCollapsed ? "vertical-tab-layout--collapsed" : "",
]);
const tabsContainerStyle = computed<CSSProperties>(() => ({
  msOverflowStyle: "none",
  scrollbarWidth: "none",
  WebkitOverflowScrolling: "touch",
}));
const tabScrollbarThumbStyle = computed<CSSProperties>(() => ({
  insetInlineStart: `${scrollThumbLeftPercent.value}%`,
  width: `${scrollThumbWidthPercent.value}%`,
}));

// Overflow search lists this group's tabs (mirrors the legacy AppTabBar
// overflow popover, scoped to the group that owns the strip).
const tabOverflowOpen = ref(false);
const tabSearchQuery = ref("");
const filteredGroupTabs = computed(() => {
  const query = tabSearchQuery.value.trim().toLocaleLowerCase();
  if (!query) {
    return props.tabs;
  }
  return props.tabs.filter((tab) => tabDisplayTitle(tab, t).toLocaleLowerCase().includes(query) || tab.title.toLocaleLowerCase().includes(query));
});

watch(tabOverflowOpen, (open) => {
  tabSearchQuery.value = "";
  if (open) {
    nextTick(() => document.querySelector<HTMLInputElement>("[data-group-tab-search-input]")?.focus());
  }
});

const showOverflowControl = computed(() => props.tabs.length > 0 && hasTabOverflow.value && !isWrapLayout.value && !isVerticalLayout.value);
const tabTailDragRegionClass = computed(() => (showOverflowControl.value || isWrapLayout.value || isVerticalLayout.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));

watch(
  () => props.tabBarCollapsed,
  (collapsed) => {
    if (collapsed) tabSearchQuery.value = "";
  },
);

/**
 * Semantic tab groups (pills) are a render-time clustering of the tabs this
 * pane's strip displays, keyed by the global tabGroupMode. Names/colors live
 * in the global tabGroupCustomizations profile store, so every pane renders
 * the same pill identity for the same key. Profile actions — rename, recolor,
 * reset — act on that global profile and therefore reach every pane. Closing
 * a cluster is the one destructive action and stays bar-local: it removes
 * only this pane's tabs of the key (see tabsInSemanticGroup).
 */
const tabGroupItems = computed(() => [
  { value: "none", label: t("settings.tabGroupNone") },
  { value: "database-type", label: t("settings.tabGroupDatabaseType") },
  { value: "connection", label: t("settings.tabGroupConnection") },
]);
const tabSortItems = computed(() => [
  { value: "manual", label: t("settings.tabSortManual") },
  { value: "created-asc", label: t("settings.tabSortCreated") },
  { value: "title-asc", label: t("settings.tabSortTitle") },
]);
const tabPlacementItems = computed(() => [
  { value: "top", label: t("settings.tabPlacementTop") },
  { value: "bottom", label: t("settings.tabPlacementBottom") },
  { value: "left", label: t("settings.tabPlacementLeft") },
  { value: "right", label: t("settings.tabPlacementRight") },
]);

type TabPreferencePatch = Partial<Pick<EditorSettings, "tabPlacement" | "tabGroupMode" | "tabSortMode" | "tabGroupCustomizations">>;

async function persistTabPreferences(partial: TabPreferencePatch) {
  try {
    await settingsStore.updateEditorSettingsAndPersist(partial);
  } catch (error) {
    toast(t("tabs.settingsSaveFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}

function updateTabGroupMode(value: string) {
  if (value === "none" || value === "database-type" || value === "connection") void persistTabPreferences({ tabGroupMode: value });
}

function updateTabSortMode(value: string) {
  if (value === "manual" || value === "created-asc" || value === "title-asc") void persistTabPreferences({ tabSortMode: value });
}

function updateTabPlacement(value: string) {
  if (value === "top" || value === "bottom" || value === "left" || value === "right") void persistTabPreferences({ tabPlacement: value });
}

function tabGroupKey(tab: QueryTab) {
  const connection = connectionStore.getConfig(tab.connectionId);
  if (settingsStore.editorSettings.tabGroupMode === "connection") return tab.connectionId;
  return connection?.driver_profile || connection?.db_type || tab.connectionId || "unknown";
}

function tabTitleText(tab: QueryTab) {
  return tabDisplayTitle(tab, t);
}

/**
 * Sorts a section of this pane's tabs for display. With a group mode active,
 * tabs cluster by group key first; within a cluster (and entirely under
 * manual mode) the stored per-pane order wins unless another sort mode is set.
 */
function sortDisplayedTabs(tabs: QueryTab[]) {
  const sortMode = settingsStore.editorSettings.tabSortMode;
  const groupMode = settingsStore.editorSettings.tabGroupMode;
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((left, right) => {
      if (groupMode !== "none") {
        const group = tabGroupKey(left.tab).localeCompare(tabGroupKey(right.tab), undefined, { sensitivity: "base", numeric: true });
        if (group) return group;
      }
      if (sortMode === "manual") return left.index - right.index;
      if (sortMode === "created-asc") {
        const created = (left.tab.createdAt ?? left.index) - (right.tab.createdAt ?? right.index);
        if (created) return created;
      } else {
        const title = tabTitleText(left.tab).localeCompare(tabTitleText(right.tab), undefined, { sensitivity: "base", numeric: true });
        if (title) return title;
      }
      return left.index - right.index;
    })
    .map(({ tab }) => tab);
}

const sortedPinnedTabs = computed(() => sortDisplayedTabs(props.tabs.filter((tab) => tab.pinned)));
const sortedRegularTabs = computed(() => sortDisplayedTabs(props.tabs.filter((tab) => !tab.pinned)));

const collapsedTabGroups = ref<Set<string>>(new Set());
const tabGroupPalette = ["#2563eb", "#d97706", "#7c3aed", "#059669", "#dc2626", "#0891b2", "#db2777", "#475569"];
const tabGroupEditorOpen = ref(false);
const editingTabGroupKey = ref("");
const editingTabGroupDefaultLabel = ref("");
const editingTabGroupName = ref("");
const editingTabGroupColor = ref("");
const editingTabGroupFallbackColor = ref(tabGroupPalette[0]!);

function tabGroupDefaultLabel(tab: QueryTab) {
  const connection = connectionStore.getConfig(tab.connectionId);
  if (settingsStore.editorSettings.tabGroupMode === "connection") return connection?.name || tab.connectionId;
  return connection?.driver_label || connection?.driver_profile || connection?.db_type || tab.connectionId;
}

function tabGroupCustomizationKey(tab: QueryTab) {
  return `${settingsStore.editorSettings.tabGroupMode}:${tabGroupKey(tab)}`;
}

function tabGroupCustomization(tab: QueryTab) {
  return settingsStore.editorSettings.tabGroupCustomizations[tabGroupCustomizationKey(tab)];
}

function tabGroupLabel(tab: QueryTab) {
  return tabGroupCustomization(tab)?.name || tabGroupDefaultLabel(tab);
}

// Pinned and regular tabs form separate clusters even under the same key.
function tabGroupId(tab: QueryTab) {
  return `${tab.pinned ? "fixed" : "regular"}:${tabGroupKey(tab)}`;
}

function isTabGroupCollapsed(tab: QueryTab) {
  if (settingsStore.editorSettings.tabGroupMode === "none") return false;
  return collapsedTabGroups.value.has(tabGroupId(tab));
}

function isTabGroupActive(tab: QueryTab) {
  const section = tab.pinned ? sortedPinnedTabs.value : sortedRegularTabs.value;
  const groupKey = tabGroupKey(tab);
  return section.some((item) => tabGroupKey(item) === groupKey && item.id === props.activeTabId);
}

function toggleTabGroup(tab: QueryTab) {
  const groupId = tabGroupId(tab);
  const next = new Set(collapsedTabGroups.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  collapsedTabGroups.value = next;
  nextTick(updateScrollButtons);
}

function expandTabGroupForTab(tabId: string | null) {
  if (!tabId || settingsStore.editorSettings.tabGroupMode === "none") return;
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  const groupId = tabGroupId(tab);
  if (!collapsedTabGroups.value.has(groupId)) return;
  const next = new Set(collapsedTabGroups.value);
  next.delete(groupId);
  collapsedTabGroups.value = next;
}

function defaultTabGroupColor(tab: QueryTab) {
  const connectionGroupColor = settingsStore.editorSettings.tabGroupMode === "connection" ? connectionColor(tab.connectionId) : undefined;
  let hash = 0;
  for (const character of tabGroupKey(tab)) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return connectionGroupColor || tabGroupPalette[Math.abs(hash) % tabGroupPalette.length]!;
}

function resolvedTabGroupColor(tab: QueryTab) {
  return tabGroupCustomization(tab)?.color || defaultTabGroupColor(tab);
}

function groupColorStyle(color: string): CSSProperties {
  return {
    "--tab-group-color": color,
    "--tab-group-soft": hexToRgba(color, 0.12),
    "--tab-group-rail": hexToRgba(color, 0.3),
  } as CSSProperties;
}

function tabGroupStyle(tab: QueryTab): CSSProperties {
  return groupColorStyle(resolvedTabGroupColor(tab));
}

const tabGroupEditorPreviewStyle = computed(() => groupColorStyle(editingTabGroupColor.value || editingTabGroupFallbackColor.value));
const editingTabGroupHasCustomization = computed(() => {
  const customization = settingsStore.editorSettings.tabGroupCustomizations[editingTabGroupKey.value];
  return !!(customization?.name || customization?.color);
});

function openTabGroupEditor(tab: QueryTab) {
  const customization = tabGroupCustomization(tab);
  editingTabGroupKey.value = tabGroupCustomizationKey(tab);
  editingTabGroupDefaultLabel.value = tabGroupDefaultLabel(tab);
  editingTabGroupName.value = customization?.name || "";
  editingTabGroupColor.value = customization?.color || "";
  editingTabGroupFallbackColor.value = defaultTabGroupColor(tab);
  tabGroupEditorOpen.value = true;
  nextTick(() => document.querySelector<HTMLInputElement>("[data-tab-group-name-input]")?.focus());
}

async function persistTabGroupCustomization(name: string, color: string) {
  if (!editingTabGroupKey.value) return false;
  const customizations = { ...settingsStore.editorSettings.tabGroupCustomizations };
  const normalizedName = name.trim();
  if (normalizedName || color) customizations[editingTabGroupKey.value] = { ...(normalizedName ? { name: normalizedName } : {}), ...(color ? { color } : {}) };
  else delete customizations[editingTabGroupKey.value];
  try {
    await settingsStore.updateEditorSettingsAndPersist({ tabGroupCustomizations: customizations });
    return true;
  } catch (error) {
    toast(t("tabs.settingsSaveFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
    return false;
  }
}

async function saveTabGroupCustomization() {
  if (await persistTabGroupCustomization(editingTabGroupName.value, editingTabGroupColor.value)) tabGroupEditorOpen.value = false;
}

function updateCustomTabGroupColor(event: Event) {
  editingTabGroupColor.value = (event.target as HTMLInputElement).value;
}

async function resetTabGroupCustomization(tab?: QueryTab) {
  if (tab) editingTabGroupKey.value = tabGroupCustomizationKey(tab);
  if ((await persistTabGroupCustomization("", "")) && !tab) tabGroupEditorOpen.value = false;
}

/**
 * The semantic cluster as displayed in THIS pane's strip: same group key,
 * same pinned section. Closing a cluster is a destructive, bar-local action —
 * the same-key cluster in another pane is left untouched, while profile edits
 * (rename/color/reset) keep their global reach.
 */
function tabsInSemanticGroup(tab: QueryTab) {
  if (settingsStore.editorSettings.tabGroupMode === "none") return [];
  const groupKey = tabGroupKey(tab);
  return props.tabs.filter((item) => item.pinned === tab.pinned && tabGroupKey(item) === groupKey);
}

/**
 * Closes this pane's cluster of the semantic group. The store's batch close
 * prunes the pane if the removal empties it, so the pane invariant (panes
 * never die with their tabs inside) is preserved.
 */
function closeTabGroup(tab: QueryTab) {
  const tabsToClose = tabsInSemanticGroup(tab).map((item) => item.id);
  if (tabsToClose.length === 0) return;
  const finalActiveTabId = queryStore.activeTabId && !tabsToClose.includes(queryStore.activeTabId) ? queryStore.activeTabId : (queryStore.tabs.find((item) => !tabsToClose.includes(item.id))?.id ?? null);
  queryStore.closeTabsByIds(tabsToClose, finalActiveTabId);
}

function getTabPreferenceMenuItems(): ContextMenuItem[] {
  return [
    {
      label: t("settings.tabPlacement"),
      icon: PanelTop,
      children: tabPlacementItems.value.map((item) => ({
        label: item.label,
        checked: item.value === settingsStore.editorSettings.tabPlacement,
        action: () => updateTabPlacement(item.value),
      })),
    },
    {
      label: t("settings.tabGroup"),
      icon: ListFilter,
      children: tabGroupItems.value.map((item) => ({
        label: item.label,
        checked: item.value === settingsStore.editorSettings.tabGroupMode,
        action: () => updateTabGroupMode(item.value),
      })),
    },
    {
      label: t("settings.tabSort"),
      icon: ArrowDownUp,
      children: tabSortItems.value.map((item) => ({
        label: item.label,
        checked: item.value === settingsStore.editorSettings.tabSortMode,
        action: () => updateTabSortMode(item.value),
      })),
    },
  ];
}

function getTabGroupMenuItems(tab: QueryTab): ContextMenuItem[] {
  const customization = tabGroupCustomization(tab);
  return [
    {
      label: t("contextMenu.editTabGroup"),
      action: () => openTabGroupEditor(tab),
      icon: Pencil,
    },
    {
      label: t("contextMenu.resetTabGroup"),
      action: () => resetTabGroupCustomization(tab),
      icon: RotateCcw,
      visible: !!(customization?.name || customization?.color),
    },
    { label: "", separator: true },
    ...getTabPreferenceMenuItems(),
    { label: "", separator: true },
    {
      label: t("contextMenu.closeTabGroup"),
      action: () => closeTabGroup(tab),
      icon: X,
      variant: "destructive",
    },
  ];
}

function openTabGroupContextMenu(event: MouseEvent, open: (event: MouseEvent) => void) {
  event.preventDefault();
  document.getSelection()?.removeAllRanges();
  open(event);
}

type StripEntry = { kind: "header"; key: string; tab: QueryTab; pinned: boolean; count: number } | { kind: "tab"; key: string; tab: QueryTab; groupFirst: boolean; groupLast: boolean; grouping: boolean };

/**
 * Flattens the strip's two sections (pinned, then regular) into render
 * entries: a group header before each semantic cluster, then that cluster's
 * pills. Collapsed clusters contribute no tab entries, only their header.
 */
function tabMatchesSearch(tab: QueryTab, query: string) {
  const title = tabDisplayTitle(tab, t).toLocaleLowerCase();
  return title.includes(query) || tab.title.toLocaleLowerCase().includes(query);
}

/**
 * The strips apply the search box (overflow popover and vertical toolbar
 * share it): sections filter by title before clustering.
 */
const filteredPinnedTabs = computed(() => {
  const query = tabSearchQuery.value.trim().toLocaleLowerCase();
  return query ? sortedPinnedTabs.value.filter((tab) => tabMatchesSearch(tab, query)) : sortedPinnedTabs.value;
});
const filteredRegularTabs = computed(() => {
  const query = tabSearchQuery.value.trim().toLocaleLowerCase();
  return query ? sortedRegularTabs.value.filter((tab) => tabMatchesSearch(tab, query)) : sortedRegularTabs.value;
});

const stripEntries = computed<StripEntry[]>(() => {
  const entries: StripEntry[] = [];
  const grouping = settingsStore.editorSettings.tabGroupMode !== "none";
  for (const [section, pinned] of [
    [filteredPinnedTabs.value, true],
    [filteredRegularTabs.value, false],
  ] as const) {
    section.forEach((tab, index) => {
      const first = grouping && (index === 0 || tabGroupKey(section[index - 1]!) !== tabGroupKey(tab));
      const last = grouping && (index === section.length - 1 || tabGroupKey(section[index + 1]!) !== tabGroupKey(tab));
      if (first) {
        const groupKey = tabGroupKey(tab);
        entries.push({ kind: "header", key: `header:${tab.id}`, tab, pinned, count: section.filter((item) => tabGroupKey(item) === groupKey).length });
      }
      // Searching must reveal collapsed clusters, matching the upstream bar.
      if (grouping && !tabSearchQuery.value.trim() && isTabGroupCollapsed(tab)) {
        return;
      }
      entries.push({ kind: "tab", key: tab.id, tab, groupFirst: first, groupLast: last, grouping });
    });
  }
  return entries;
});

function tabColorStyle(tab: QueryTab): CSSProperties | undefined {
  // Sidebar tabs carry their group/connection color as a soft active wash;
  // the active indicator itself comes from the vertical CSS rules.
  if (isVerticalLayout.value) {
    if (tab.id !== props.activeTabId) {
      return undefined;
    }
    const color = connectionColor(tab.connectionId);
    return { "--app-tab-background": color ? hexToRgba(color, 0.12) : "var(--accent)" } as CSSProperties;
  }
  return sharedTabColorStyle(tab, tab.id === props.activeTabId, isClassicLayout.value);
}

const tabTooltipSide = computed(() => {
  if (!isVerticalLayout.value) return "bottom" as const;
  return settingsStore.editorSettings.tabPlacement === "left" ? ("right" as const) : ("left" as const);
});

/**
 * Drag visuals for a pill, ported from the legacy tab bar's tabDropStyle: the
 * dragged pill dims, and the hovered pill shows an inset ring line marking
 * whether the drop lands before or after it.
 */
function tabDropStyle(tab: QueryTab): CSSProperties | undefined {
  if (!groupTabDrag.active) {
    return undefined;
  }
  if (groupTabDrag.tabId === tab.id) {
    return { opacity: 0.4 };
  }
  if (groupTabDrag.targetTabId !== tab.id) {
    return undefined;
  }
  if (groupTabDrag.position === "before") {
    return { boxShadow: "inset 3px 0 0 0 var(--ring)" };
  }
  return { boxShadow: "inset -3px 0 0 0 var(--ring)" };
}

function createTabDragGhost(sourceEl: HTMLElement, x: number, y: number) {
  const ghost = document.createElement("div");
  const textNode = sourceEl.querySelector(".truncate");
  ghost.textContent = textNode?.textContent || "";
  ghost.style.cssText = `position: fixed; pointer-events: none; z-index: 9999; opacity: 0.9; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border-radius: var(--dbx-radius-fixed-6); background: var(--background, #fff); border: 1px solid var(--border, #e5e7eb); max-width: 200px; height: 28px; padding: 0 12px; font-size: 12px; line-height: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; left: ${x + 12}px; top: ${y - 14}px;`;
  document.body.appendChild(ghost);
  return ghost;
}

function moveTabDragGhost(x: number, y: number) {
  if (groupTabDragGhost) {
    groupTabDragGhost.style.left = `${x + 8}px`;
    groupTabDragGhost.style.top = `${y - 14}px`;
  }
}

function removeTabDragGhost() {
  groupTabDragGhost?.remove();
  groupTabDragGhost = null;
}

function isDirtyTab(tab: QueryTab) {
  return queryStore.isTabDirty(tab);
}

function tabTitleStyle(tab: QueryTab): CSSProperties | undefined {
  return dirtyTabTitleStyle(isDirtyTab(tab));
}

function dispatchBeforeTabSwitch(tabId: string) {
  if (tabId === props.activeTabId) {
    return;
  }
  window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { tabId, fromTabId: props.activeTabId } }));
}

function activateTab(tabId: string) {
  emit("activate-tab", tabId);
}

function handleTabPointerDown(event: PointerEvent, tab: QueryTab) {
  if (event.button !== 0) {
    return;
  }
  // A drag session is already in progress (second pointer device): ignore.
  if (groupTabDrag.active) {
    return;
  }
  suppressNextTabClick.value = false;
  if (event.target instanceof Element && event.target.closest("button, input, [role='button']")) {
    return;
  }
  // Match the legacy tab bar: flush pending grid edits before the visible tab changes.
  dispatchBeforeTabSwitch(tab.id);
  if (event.pointerType === "touch") {
    // Touch does not arm the drag; the strip's native scroll owns the gesture.
    return;
  }
  // macOS reports a trackpad tap as a mouse pointer with button=0, but
  // buttons=0. It is a click gesture, not a held primary-button drag.
  if ((event.buttons & 1) !== 1) {
    return;
  }
  groupTabDragSourceEl = event.currentTarget as HTMLElement | null;
  groupTabDrag.active = false;
  groupTabDrag.tabId = tab.id;
  groupTabDrag.sourceGroupId = props.groupId;
  groupTabDrag.payload = serializeTabDragPayload({ tabId: tab.id, sourceGroupId: props.groupId });
  groupTabDrag.startX = event.clientX;
  groupTabDrag.startY = event.clientY;
  groupTabDrag.targetGroupId = null;
  groupTabDrag.targetTabId = null;
  groupTabDrag.position = null;
  groupTabDrag.pointerId = event.pointerId;
  window.addEventListener("pointermove", handleTabPointerMove);
  window.addEventListener("pointerup", handleTabPointerUp);
  window.addEventListener("pointercancel", cleanupTabDrag);
  window.addEventListener("blur", cleanupTabDrag);
}

function canRenameTab(tab: QueryTab) {
  return tab.mode === "query";
}

function isDetachableTab(tab: QueryTab) {
  return tab.mode === "query" || tab.mode === "data";
}

function startRenameTab(tab: QueryTab) {
  if (!canRenameTab(tab)) {
    return;
  }
  editingTabId.value = tab.id;
  editingTitle.value = tab.title;
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-tab-title-input="${tab.id}"]`);
    if (input) {
      input.focus();
      const dotIndex = input.value.lastIndexOf(".");
      const selectEnd = dotIndex > 0 ? dotIndex : input.value.length;
      input.setSelectionRange(0, selectEnd);
    }
  });
}

function commitRenameTab(tab: QueryTab) {
  if (editingTabId.value !== tab.id) {
    return;
  }
  const title = editingTitle.value.trim();
  if (title) {
    queryStore.renameTab(tab.id, title);
  }
  editingTabId.value = null;
}

function cancelRenameTab() {
  editingTabId.value = null;
}

function closeTab(tab: QueryTab) {
  queryStore.closeTab(tab.id);
}

/**
 * Close-left/right operate on this pane's *display* order within the tab's
 * pinned/regular section, so the menu closes exactly the pills shown on that
 * side even when a non-manual sort mode reorders the strip.
 */
function tabsToLeftInDisplayOrder(tab: QueryTab) {
  const section = tab.pinned ? sortedPinnedTabs.value : sortedRegularTabs.value;
  const targetIndex = section.findIndex((item) => item.id === tab.id);
  return targetIndex < 0 ? [] : section.slice(0, targetIndex);
}

function tabsToRightInDisplayOrder(tab: QueryTab) {
  const section = tab.pinned ? sortedPinnedTabs.value : sortedRegularTabs.value;
  const targetIndex = section.findIndex((item) => item.id === tab.id);
  return targetIndex < 0 ? [] : section.slice(targetIndex + 1);
}

function hasTabsToRight(tab: QueryTab) {
  return tabsToRightInDisplayOrder(tab).length > 0;
}

function hasTabsToLeft(tab: QueryTab) {
  return tabsToLeftInDisplayOrder(tab).length > 0;
}

function getTabMenuItems(tab: QueryTab): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: compactTabTitle.value ? t("contextMenu.fullTabTitle") : t("contextMenu.compactTabTitle"),
      action: toggleCompactTabTitle,
      icon: compactTabTitle.value ? Maximize2 : Minimize2,
    },
    ...createRenameDuplicateTabItems({
      tab,
      t,
      canRename: canRenameTab(tab),
      onRename: () => startRenameTab(tab),
      onDuplicate: () => queryStore.duplicateTab(tab.id),
    }),
    {
      label: t("contextMenu.copyName"),
      action: async () => {
        try {
          await copyToClipboard(tabDisplayTitle(tab, t));
          toast(t("connection.copied"), 2000);
        } catch (e: any) {
          toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
        }
      },
      icon: Copy,
    },
    {
      label: t("tabs.openInNewWindow"),
      action: () => emit("detach-tab", tab),
      icon: Maximize2,
      visible: !!props.canDetachTabs && isDetachableTab(tab),
    },
    createLocateTabMenuItem({
      t,
      visible: !!activeTabSidebarTarget(tab),
      onLocate: () => emit("locate-tab", tab),
    }),
    { label: "", separator: true },
    ...getTabPreferenceMenuItems(),
    { label: "", separator: true },
    createPinTabMenuItem({
      label: tab.pinned ? t("contextMenu.unpinTab") : t("contextMenu.pinTab"),
      onToggle: () => queryStore.togglePinnedTab(tab.id),
    }),
    // Split actions stay visible but render disabled when they cannot produce
    // a new layout — at the four-group cap, or with a single open tab (the
    // store rejects with the same rules). Every tab type can split: groups
    // host non-query tabs via ContentArea, same as moving them between groups.
    {
      label: t("contextMenu.splitRight"),
      action: () => queryStore.splitTabRight(tab.id),
      disabled: splitUnavailable.value,
      icon: ArrowRight,
    },
    {
      label: t("contextMenu.splitDown"),
      action: () => queryStore.splitTabDown(tab.id),
      disabled: splitUnavailable.value,
      icon: ArrowDown,
    },
    ...(canChangeOrientation.value
      ? [
          {
            label: t("contextMenu.changeOrientation"),
            action: () => queryStore.setOrientation(queryStore.orientation === "vertical" ? "horizontal" : "vertical"),
            icon: RotateCw,
          },
        ]
      : []),
    ...(isSecondaryGroup.value
      ? [
          {
            label: t("contextMenu.unsplit"),
            action: () => queryStore.unsplitTab(tab.id),
            icon: ArrowRight,
            visible: true,
          },
        ]
      : []),
    createCloseOtherTabMenuItem({
      label: t("contextMenu.closeOtherTabs"),
      onClose: () => queryStore.closeOtherTabsInGroup(props.groupId, tab.id),
    }),
    createCloseLeftTabMenuItem({
      label: t("contextMenu.closeLeftTabs"),
      disabled: !hasTabsToLeft(tab),
      onClose: () => {
        const tabsToClose = tabsToLeftInDisplayOrder(tab).map((item) => item.id);
        const finalActiveTabId = queryStore.activeTabId && !tabsToClose.includes(queryStore.activeTabId) ? queryStore.activeTabId : tab.id;
        queryStore.closeTabsByIds(tabsToClose, finalActiveTabId);
      },
    }),
    createCloseRightTabMenuItem({
      label: t("contextMenu.closeRightTabs"),
      disabled: !hasTabsToRight(tab),
      onClose: () => {
        const tabsToClose = tabsToRightInDisplayOrder(tab).map((item) => item.id);
        const finalActiveTabId = queryStore.activeTabId && !tabsToClose.includes(queryStore.activeTabId) ? queryStore.activeTabId : tab.id;
        queryStore.closeTabsByIds(tabsToClose, finalActiveTabId);
      },
    }),
    createCloseAllTabMenuItem({
      label: t("contextMenu.closeAllTabs"),
      onClose: () => queryStore.closeAllTabsInGroup(props.groupId, tab.id),
    }),
    {
      label: t("contextMenu.closeTabGroup"),
      action: () => closeTabGroup(tab),
      visible: settingsStore.editorSettings.tabGroupMode !== "none",
      icon: X,
    },
    createCloseTabMenuItem({
      label: t("contextMenu.closeTab"),
      onClose: () => closeTab(tab),
    }),
  ];
  return items;
}

function handleTabDoubleClick(tab: QueryTab, event: MouseEvent) {
  event.stopPropagation();
  if (event.target instanceof Element && event.target.closest("button, input, [role='button']")) {
    return;
  }
  if (tab.mode === "data") {
    if (tab.id !== props.activeTabId) {
      activateTab(tab.id);
    }
    emit("toggle-zen-mode");
    return;
  }
  startRenameTab(tab);
}

function handleTabClick(tab: QueryTab) {
  if (suppressNextTabClick.value) {
    suppressNextTabClick.value = false;
    return;
  }
  activateTab(tab.id);
}

function cleanupTabDrag(event?: Event) {
  const trackedPointerId = groupTabDrag.pointerId;
  if (event && "pointerId" in event && trackedPointerId !== null && (event as PointerEvent).pointerId !== trackedPointerId) {
    return;
  }
  window.removeEventListener("pointermove", handleTabPointerMove);
  window.removeEventListener("pointerup", handleTabPointerUp);
  window.removeEventListener("pointercancel", cleanupTabDrag);
  window.removeEventListener("blur", cleanupTabDrag);
  // The shared drag session belongs to the bar that started it: another
  // group's tab bar unmounting mid-drag must not kill the source's drag.
  if (groupTabDrag.sourceGroupId === props.groupId) {
    groupTabDrag.active = false;
    groupTabDrag.tabId = null;
    groupTabDrag.sourceGroupId = null;
    groupTabDrag.payload = "";
    groupTabDrag.targetGroupId = null;
    groupTabDrag.targetTabId = null;
    groupTabDrag.position = null;
    groupTabDrag.pointerId = null;
    groupTabDragSourceEl = null;
    removeTabDragGhost();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
}

function handleTabPointerMove(event: PointerEvent) {
  const drag = groupTabDrag;
  if (!drag.tabId) {
    return;
  }
  if (drag.pointerId !== null && event.pointerId !== drag.pointerId) {
    return;
  }
  // macOS reports a trackpad tap as a mouse pointer with button=0, but
  // buttons=0. It is a click gesture, not a held primary-button drag.
  if ((event.buttons & 1) !== 1) {
    cleanupTabDrag();
    return;
  }
  if (!drag.active) {
    // Horizontal-only threshold, matching the legacy tab bar: absorbs click
    // jitter and touch tap drift (touch never arms the drag at all).
    if (Math.abs(event.clientX - drag.startX) < TAB_DRAG_HORIZONTAL_THRESHOLD) {
      return;
    }
    drag.active = true;
    suppressNextTabClick.value = true;
    if (groupTabDragSourceEl) {
      groupTabDragGhost = createTabDragGhost(groupTabDragSourceEl, event.clientX, event.clientY);
    }
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }
  event.preventDefault();
  moveTabDragGhost(event.clientX, event.clientY);

  const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  const tabElement = element?.closest<HTMLElement>("[data-tab-id]");
  const groupElement = element?.closest<HTMLElement>("[data-group-id]");
  drag.targetGroupId = groupElement?.dataset.groupId ?? null;
  drag.targetTabId = null;
  drag.position = null;
  if (tabElement && groupElement) {
    drag.targetTabId = tabElement.dataset.tabId ?? null;
    const rect = tabElement.getBoundingClientRect();
    drag.position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  }
}

function handleTabPointerUp(event: PointerEvent) {
  if (groupTabDrag.pointerId !== null && event.pointerId !== groupTabDrag.pointerId) {
    return;
  }
  const drag = {
    active: groupTabDrag.active,
    tabId: groupTabDrag.tabId,
    payload: groupTabDrag.payload,
    targetGroupId: groupTabDrag.targetGroupId,
    targetTabId: groupTabDrag.targetTabId,
    position: groupTabDrag.position,
  };
  cleanupTabDrag();
  if (!drag.active) {
    return;
  }
  event.preventDefault();

  const payload = parseTabDragPayload(drag.payload);
  if (!payload) {
    return;
  }
  const targetGroupId = drag.targetGroupId;
  if (!targetGroupId) {
    return;
  }
  // Validate the payload against live store state: both groups must exist and
  // the tab's *current* owner must still be the payload's source group.
  const sourceGroupExists = queryStore.groups.some((group) => group.id === payload.sourceGroupId);
  const targetGroupExists = queryStore.groups.some((group) => group.id === targetGroupId);
  if (!sourceGroupExists || !targetGroupExists) {
    return;
  }
  const currentOwner = queryStore.groups.find((group) => group.tabIds.includes(payload.tabId));
  if (!currentOwner || currentOwner.id !== payload.sourceGroupId) {
    return;
  }
  let index: number | undefined;
  if (drag.targetTabId) {
    const targetGroup = queryStore.groups.find((group) => group.id === targetGroupId);
    const targetTabs = targetGroup ? targetGroup.tabIds.map((id) => queryStore.tabs.find((tab) => tab.id === id)).filter((tab): tab is QueryTab => !!tab) : [];
    const targetIndex = targetTabs.findIndex((tab) => tab.id === drag.targetTabId);
    if (targetIndex >= 0) {
      index = drag.position === "before" ? targetIndex : targetIndex + 1;
    }
  }
  queryStore.moveTabToGroup(payload.tabId, targetGroupId, index);
}

onUnmounted(cleanupTabDrag);

const tabScrollBehavior = ref<ScrollBehavior>("smooth");

watch(
  () => props.activeTabId,
  (tabId) => {
    // A tab that just became active must be visible: reveal its group if collapsed.
    expandTabGroupForTab(tabId);
    nextTick(() => {
      if (!isWrapLayout.value) {
        const container = tabsContainerRef.value;
        if (container) {
          const activeEl = container.querySelector('[data-active-tab="true"]');
          if (activeEl) {
            activeEl.scrollIntoView({ behavior: tabScrollBehavior.value, block: "nearest", inline: "center" });
          }
        }
      }
      updateScrollButtons();
      tabScrollBehavior.value = "smooth";
    });
  },
);

watch(
  () => props.tabs.map((tab) => `${tab.id}:${tab.pinned ? "1" : "0"}`).join("|"),
  () => {
    nextTick(updateScrollButtons);
  },
);
</script>

<template>
  <!-- data-main-tab-bar is the drag-back hit-test anchor: dropping a detached window over ANY pane's strip returns the tab. -->
  <div class="app-tab-bar group-tabbar relative flex w-full min-w-0 shrink-0 overflow-hidden" :class="[tabBarClass, { 'ring-2 ring-primary ring-inset': detachedDropTarget }]" :style="tabBarStyle" data-main-tab-bar :data-group-id="groupId" :data-placement="settingsStore.editorSettings.tabPlacement">
    <!-- Compact vertical toolbar: search, grouping preference, collapse. -->
    <div v-if="isVerticalLayout" class="flex shrink-0 items-center gap-0.5 border-b p-1.5" :class="isTabBarCollapsed ? 'justify-center' : ''">
      <div v-if="!isTabBarCollapsed" class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="tabSearchQuery" type="search" :placeholder="t('tabs.searchOpenTabs')" class="h-8 w-full pl-7 text-sm" />
      </div>
      <div v-if="!isTabBarCollapsed" class="flex shrink-0 items-center gap-0">
        <LightDropdown
          :model-value="settingsStore.editorSettings.tabGroupMode"
          :items="tabGroupItems"
          :aria-label="t('settings.tabGroup')"
          :trigger-title="t('settings.tabGroup')"
          :trigger-icon="ListFilter"
          :trigger-class="verticalTabToolbarButtonClass"
          :show-trigger-label="false"
          :show-chevron="false"
          check-position="right"
          :match-trigger-width="false"
          align="end"
          @update:model-value="updateTabGroupMode"
        />
      </div>
      <button type="button" :class="verticalTabToolbarButtonClass" :title="tabBarCollapseLabel" :aria-label="tabBarCollapseLabel" :aria-expanded="!isTabBarCollapsed" @click="emit('toggle-collapse')">
        <component :is="tabBarCollapseIcon" class="h-4 w-4" />
      </button>
    </div>
    <div class="flex w-full min-w-0 shrink-0 overflow-hidden" :class="isVerticalLayout ? ['min-h-0 flex-1 flex-col items-stretch'] : isClassicLayout ? 'h-9 items-stretch' : 'h-10 items-center px-2'">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div v-if="showOverflowControl" class="app-tab-scrollbar" :class="{ 'app-tab-scrollbar--dragging': isScrollbarDragging }" @pointerdown="startScrollbarDrag">
          <div class="app-tab-scrollbar__thumb" :style="tabScrollbarThumbStyle" />
        </div>
        <div
          ref="tabsContainerRef"
          class="app-tab-scroll flex w-full min-w-0 flex-1"
          :class="[
            isVerticalLayout ? 'flex-col items-stretch overflow-y-auto overflow-x-hidden py-1' : isClassicLayout ? 'h-full items-center overflow-x-auto' : 'h-full items-center gap-1.5 overflow-x-auto py-1.5',
            isWrapLayout ? 'wrap-mode' : '',
            isWrapLayout && isClassicLayout ? 'classic-wrap' : '',
          ]"
          :style="tabsContainerStyle"
          @scroll="!isVerticalLayout && updateScrollButtons()"
          @wheel="!isVerticalLayout && onTabsWheel($event)"
        >
          <template v-for="entry in stripEntries" :key="entry.key">
            <CustomContextMenu v-if="entry.kind === 'header'" :items="() => getTabGroupMenuItems(entry.tab)" v-slot="{ onContextMenu }">
              <button
                type="button"
                class="tab-group-header"
                :class="{ 'tab-group-header--collapsed': isTabGroupCollapsed(entry.tab), 'tab-group-header--active': isTabGroupActive(entry.tab) }"
                :style="tabGroupStyle(entry.tab)"
                :aria-expanded="!isTabGroupCollapsed(entry.tab)"
                :title="tabGroupLabel(entry.tab)"
                @click="toggleTabGroup(entry.tab)"
                @contextmenu="openTabGroupContextMenu($event, onContextMenu)"
              >
                <span class="tab-group-header-content">
                  <span class="tab-group-marker" aria-hidden="true" />
                  <Pin v-if="entry.pinned" class="tab-group-pin" aria-hidden="true" />
                  <ChevronDown class="tab-group-chevron" :class="isTabGroupCollapsed(entry.tab) ? '-rotate-90' : ''" aria-hidden="true" />
                  <span class="tab-group-label">{{ tabGroupLabel(entry.tab) }}</span>
                  <span v-if="isTabGroupCollapsed(entry.tab)" class="tab-group-count">{{ entry.count }}</span>
                </span>
              </button>
            </CustomContextMenu>
            <CustomContextMenu v-else :items="getTabMenuItems(entry.tab)" v-slot="{ onContextMenu }">
              <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="onContextMenu">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <div
                      class="app-tab-pill group flex cursor-default items-center gap-1 px-2 text-xs transition-colors whitespace-nowrap select-none"
                      :class="[
                        isClassicLayout
                          ? ['h-full border-r border-border/80 font-medium dark:border-border/45', entry.tab.id === activeTabId ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                          : ['h-7 rounded-md border', entry.tab.id === activeTabId ? 'text-foreground font-medium' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90'],
                        {
                          'tab-group-tab': entry.grouping,
                          'tab-group-tab--first': entry.grouping && entry.groupFirst,
                          'tab-group-tab--last': entry.grouping && entry.groupLast,
                        },
                      ]"
                      :style="[tabColorStyle(entry.tab), entry.grouping ? tabGroupStyle(entry.tab) : undefined, tabDropStyle(entry.tab)]"
                      :data-active-tab="entry.tab.id === activeTabId"
                      :data-tab-id="entry.tab.id"
                      @pointerdown="handleTabPointerDown($event, entry.tab)"
                      @click="handleTabClick(entry.tab)"
                      @dblclick="handleTabDoubleClick(entry.tab, $event)"
                      @mousedown.middle.prevent="closeTab(entry.tab)"
                    >
                      <TabExecutionStatus :tab="entry.tab">
                        <span class="shrink-0" :class="tabIconClass(entry.tab)">
                          <AlertTriangle v-if="entry.tab.externalSqlFileMissing" class="h-3.5 w-3.5" />
                          <Table2 v-else-if="entry.tab.mode === 'data' || entry.tab.mode === 'mongo' || entry.tab.mode === 'redis' || entry.tab.mode === 'hbase'" class="h-3.5 w-3.5" />
                          <DatabaseIcon v-else-if="entry.tab.mode === 'mq'" :db-type="tabDatabaseIconType(entry.tab)" class="h-3.5 w-3.5" />
                          <TableProperties v-else-if="entry.tab.mode === 'vector'" class="h-3.5 w-3.5" />
                          <KeyRound v-else-if="entry.tab.mode === 'etcd' || entry.tab.mode === 'zookeeper' || entry.tab.mode === 'consul'" class="h-3.5 w-3.5" />
                          <Gauge v-else-if="entry.tab.mode === 'consul-overview' || entry.tab.mode === 'etcd-dashboard' || entry.tab.mode === 'mysql-dashboard' || entry.tab.mode === 'postgres-dashboard' || entry.tab.mode === 'nacos-dashboard'" class="h-3.5 w-3.5" />
                          <ShieldCheck v-else-if="entry.tab.mode === 'etcd-access-control'" class="h-3.5 w-3.5" />
                          <Network v-else-if="entry.tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                          <Database v-else-if="entry.tab.mode === 'databases'" class="h-3.5 w-3.5" />
                          <TableProperties v-else-if="entry.tab.mode === 'objects'" class="h-3.5 w-3.5" />
                          <PencilRuler v-else-if="entry.tab.mode === 'structure'" class="h-3.5 w-3.5" />
                          <CalendarClock v-else-if="entry.tab.mode === 'dameng-jobs'" class="h-3.5 w-3.5" />
                          <Activity v-else-if="entry.tab.mode === 'processlist' || entry.tab.mode === 'sqlserver-trace'" class="h-3.5 w-3.5" />
                          <Gauge v-else-if="entry.tab.mode === 'dolt-version-control'" class="h-3.5 w-3.5" />
                          <Code2 v-else class="h-3.5 w-3.5" />
                        </span>
                      </TabExecutionStatus>
                      <span v-if="isTabBarCollapsed && isDirtyTab(entry.tab)" class="compact-dirty-tab-marker" aria-hidden="true" />
                      <input
                        v-if="editingTabId === entry.tab.id && !isTabBarCollapsed"
                        v-model="editingTitle"
                        :data-tab-title-input="entry.tab.id"
                        :aria-label="t('contextMenu.renameTab')"
                        class="h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-xs font-normal text-foreground outline-none"
                        @click.stop
                        @mousedown.stop
                        @keydown.enter.prevent="commitRenameTab(entry.tab)"
                        @keydown.escape.prevent="cancelRenameTab"
                        @blur="commitRenameTab(entry.tab)"
                      />
                      <span v-else-if="!isTabBarCollapsed" class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-foreground">
                        <span v-if="isDirtyTab(entry.tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                        <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(entry.tab)">{{ tabDisplayTitle(entry.tab, t) }}</span>
                      </span>
                      <ReadOnlySessionControl v-if="!isTabBarCollapsed" :connection-id="entry.tab.connectionId" compact />
                      <button v-if="entry.tab.pinned && !isTabBarCollapsed" class="rounded p-0.5 text-primary hover:bg-muted-foreground/20 shrink-0" :aria-label="t('contextMenu.unpinTab')" :title="t('contextMenu.unpinTab')" @pointerdown.stop @click.stop="queryStore.togglePinnedTab(entry.tab.id)">
                        <Pin class="h-3 w-3 fill-current" aria-hidden="true" />
                      </button>
                      <button v-if="!isTabBarCollapsed" class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" :aria-label="t('contextMenu.closeTab')" :title="t('contextMenu.closeTab')" @pointerdown.stop @click.stop="closeTab(entry.tab)">
                        <X class="h-3 w-3" />
                      </button>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent :side="tabTooltipSide" class="text-xs grid grid-cols-[auto_1fr] gap-x-2">
                    <template v-for="line in tabTooltipLines(entry.tab, t)" :key="line.label">
                      <span class="text-muted-foreground">{{ line.label }}</span>
                      <span>{{ line.value }}</span>
                    </template>
                  </TooltipContent>
                </Tooltip>
              </div>
            </CustomContextMenu>
          </template>
          <div :class="tabTailDragRegionClass" data-tauri-drag-region />
        </div>
      </div>
      <div v-if="showOverflowControl" class="relative z-30 flex shrink-0 items-center">
        <Popover v-model:open="tabOverflowOpen">
          <PopoverTrigger as-child>
            <button type="button" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-foreground/70 hover:border-border hover:text-foreground" :aria-label="t('tabs.openTabs')" :title="t('tabs.openTabs')">
              <ChevronDown class="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-auto min-w-56 max-w-80 gap-0 rounded-[6px] p-1" @click.stop @keydown.stop>
            <div class="relative border-b px-1 pb-1">
              <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="tabSearchQuery" data-group-tab-search-input type="search" :placeholder="t('tabs.searchOpenTabs')" class="h-8 pl-7 text-sm" />
            </div>
            <div class="max-h-[min(70vh,28rem)] overflow-y-auto pt-1">
              <CustomContextMenu v-for="tab in filteredGroupTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
                <div
                  class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  :class="tab.id === activeTabId ? 'bg-accent/70 text-accent-foreground' : ''"
                  :title="tabDisplayTitle(tab, t)"
                  role="menuitem"
                  tabindex="0"
                  @click="
                    activateTab(tab.id);
                    tabOverflowOpen = false;
                  "
                  @contextmenu="onContextMenu"
                  @keydown.enter.prevent="
                    activateTab(tab.id);
                    tabOverflowOpen = false;
                  "
                >
                  <TabExecutionStatus :tab="tab">
                    <DatabaseIcon v-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" class="h-3.5 w-3.5 shrink-0" />
                    <AlertTriangle v-else-if="tab.externalSqlFileMissing" class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <component :is="Code2" v-else-if="tab.mode === 'query'" class="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                    <component :is="Table2" v-else class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  </TabExecutionStatus>
                  <span class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                    <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                    <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabDisplayTitle(tab, t) }}</span>
                  </span>
                  <ReadOnlySessionControl :connection-id="tab.connectionId" compact />
                  <Pin v-if="tab.pinned" class="h-3 w-3 shrink-0 fill-current text-primary" />
                  <span class="w-5 shrink-0">
                    <button
                      type="button"
                      class="inline-flex rounded p-1 text-muted-foreground opacity-70 hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100"
                      :aria-label="t('contextMenu.closeTab')"
                      :title="t('contextMenu.closeTab')"
                      @click.stop.prevent="queryStore.closeTab(tab.id)"
                      @mousedown.stop
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </span>
                </div>
              </CustomContextMenu>
              <p v-if="filteredGroupTabs.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">{{ t("tabs.noMatchingTabs") }}</p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
    <!-- Dragging any pane's handle resizes the shared vertical width; every pane follows. -->
    <div v-if="isVerticalLayout && !isTabBarCollapsed" class="panel-resize-handle" :class="settingsStore.editorSettings.tabPlacement === 'right' ? 'panel-resize-handle--left' : 'panel-resize-handle--right'" @mousedown="emit('start-resize', $event)" />
    <Dialog v-model:open="tabGroupEditorOpen">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle class="flex min-w-0 items-center gap-2">
            <span class="h-4 w-1 shrink-0 rounded-full" :style="{ background: editingTabGroupColor || editingTabGroupFallbackColor }" />
            <span class="truncate">{{ t("tabs.editGroupTitle", { name: editingTabGroupDefaultLabel }) }}</span>
          </DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <label class="grid gap-1.5 text-sm">
            <span class="font-medium">{{ t("tabs.groupName") }}</span>
            <Input v-model="editingTabGroupName" data-tab-group-name-input maxlength="80" :placeholder="editingTabGroupDefaultLabel" class="h-9" @keydown.enter.prevent="saveTabGroupCustomization" />
          </label>
          <fieldset class="grid gap-2">
            <legend class="text-sm font-medium">{{ t("tabs.groupColor") }}</legend>
            <div class="flex flex-wrap items-center gap-2" :style="tabGroupEditorPreviewStyle">
              <button type="button" class="tab-group-color-option tab-group-color-option--auto" :class="{ 'tab-group-color-option--selected': editingTabGroupColor === '' }" :aria-label="t('tabs.groupColorAuto')" :title="t('tabs.groupColorAuto')" @click="editingTabGroupColor = ''">
                <RotateCcw class="h-3.5 w-3.5" />
              </button>
              <button
                v-for="color in tabGroupPalette"
                :key="color"
                type="button"
                class="tab-group-color-option"
                :class="{ 'tab-group-color-option--selected': editingTabGroupColor === color }"
                :style="{ '--tab-group-option-color': color }"
                :aria-label="color"
                :title="color"
                @click="editingTabGroupColor = color"
              />
              <label
                class="tab-group-custom-color"
                :class="{ 'tab-group-color-option--selected': editingTabGroupColor !== '' && !tabGroupPalette.includes(editingTabGroupColor) }"
                :style="{ '--tab-group-option-color': editingTabGroupColor || editingTabGroupFallbackColor }"
                :title="t('tabs.groupColorCustom')"
              >
                <input type="color" :value="editingTabGroupColor || editingTabGroupFallbackColor" :aria-label="t('tabs.groupColorCustom')" @input="updateCustomTabGroupColor" />
              </label>
            </div>
          </fieldset>
        </div>
        <DialogFooter class="sm:justify-between">
          <Button v-if="editingTabGroupHasCustomization" variant="ghost" class="mr-auto" @click="resetTabGroupCustomization()">{{ t("tabs.resetGroup") }}</Button>
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="tabGroupEditorOpen = false">{{ t("common.cancel") }}</Button>
            <Button @click="saveTabGroupCustomization">{{ t("common.save") }}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
