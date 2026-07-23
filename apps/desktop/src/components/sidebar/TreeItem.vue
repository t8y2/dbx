<script setup lang="ts">
import { ref, computed, inject, shallowRef, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  Database,
  Table,
  Columns3,
  Eye,
  ChevronRight,
  ChevronDown,
  Loader2,
  FolderOpen,
  FolderClosed,
  TableProperties,
  Key,
  Link,
  Zap,
  ListTree,
  FileCode,
  Network,
  Server,
  Pin,
  Search,
  Plus,
  ScrollText,
  Braces,
  Package,
  Check,
  UsersRound,
  CalendarClock,
  Lock,
  Archive,
  Square,
  X,
} from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionErrorIndicator from "@/components/connection/ConnectionErrorIndicator.vue";
import ProductionContextBadge from "@/components/common/ProductionContextBadge.vue";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import type { ColumnInfo, ConnectionConfig, DatabaseType, TreeNode, TreeNodeType } from "@/types/database";
import { canTreeNodeShowExpander, sidebarTreeNodeComment, trailingCommentAvailableWidth, trailingCommentGapPx, treeItemPaddingLeft, treeLabelWidthClass, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";
import { clearActiveTableReferencePayload, createTableReferencePayload, createTableReferenceDropEvent, setActiveTableReferencePayload, type QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";
import { formatSidebarObjectStorage } from "@/lib/sidebar/sidebarDatabaseStorage";
import { dataTabOpenModeFromTreeClick } from "@/lib/sidebar/dataTabOpenPolicy";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { hexToRgba } from "@/lib/common/color";
import { sidebarDisplayTableName } from "@/lib/sidebar/sidebarTableNameDisplay";
import { shouldMeasureSidebarLabelOverflow } from "@/lib/sidebar/sidebarLabelTooltip";
import { treeSelectionRangeIdsByIndex, treeSelectionRangeIds } from "@/lib/sidebar/sidebarTreeSelection";
import { isSidebarDatabaseOpened } from "@/lib/sidebar/sidebarDatabaseOpenState";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { isWindows } from "@/lib/backend/platform";
import { flattenTree } from "@/composables/useFlatTree";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { focusSidebarRenameInput } from "@/lib/sidebar/sidebarRenameFocus";
// --- Drag and Drop ---
import { useDragSort } from "@/composables/useDragSort";
import { sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";

const { t } = useI18n();

const labelRef = ref<HTMLElement>();

const rowRef = ref<HTMLElement>();

const trailingCommentLayoutRef = ref<HTMLElement>();

const trailingCommentLeadingRef = ref<HTMLElement>();

const trailingCommentMaxWidth = ref(0);

const labelOverflowing = ref(false);

let labelResizeObserver: ResizeObserver | null = null;

let trailingCommentResizeObserver: ResizeObserver | null = null;

let labelMeasureFrame = 0;

let trailingCommentMeasureFrame = 0;

function cancelLabelOverflowMeasure() {
  if (!labelMeasureFrame) return;
  window.cancelAnimationFrame(labelMeasureFrame);
  labelMeasureFrame = 0;
}

function measureLabelOverflow(): boolean {
  const el = labelRef.value;
  if (!el || !shouldMeasureLabelOverflow()) return false;
  const style = window.getComputedStyle(el);
  if (style.overflowX === "visible" || style.textOverflow !== "ellipsis") return false;
  return el.scrollWidth - el.clientWidth > 2;
}

function updateLabelOverflow() {
  labelOverflowing.value = measureLabelOverflow();
}

function scheduleLabelOverflowMeasure() {
  if (typeof window === "undefined") {
    updateLabelOverflow();
    return;
  }
  cancelLabelOverflowMeasure();
  // Keep synchronous layout reads out of the hover path; they are expensive in
  // large virtualized sidebar trees, especially on Linux WebKitGTK without GPU help.
  labelMeasureFrame = window.requestAnimationFrame(() => {
    labelMeasureFrame = 0;
    updateLabelOverflow();
  });
}

function handleMouseEnter() {
  if (!shouldMeasureLabelOverflow()) {
    labelOverflowing.value = false;
    return;
  }
  updateLabelOverflow();
  if (typeof ResizeObserver !== "undefined" && labelRef.value && !labelResizeObserver) {
    labelResizeObserver = new ResizeObserver(scheduleLabelOverflowMeasure);
    labelResizeObserver.observe(labelRef.value);
  }
}

function handleMouseLeave() {
  labelResizeObserver?.disconnect();
  labelResizeObserver = null;
  cancelLabelOverflowMeasure();
}

const connectionStore = useConnectionStore();

const queryStore = useQueryStore();

const settingsStore = useSettingsStore();

const { toast } = useToast();

const useWindowsSidebarCommentFont = isWindows();

const props = defineProps<{
  node: TreeNode;
  depth: number;
  dragDisabled?: boolean;
  pendingRename?: boolean;
  highlighted?: boolean;
  commentLabelWidth?: number;
}>();

const emit = defineEmits<{
  "rename-started": [];
  "group-created": [groupId: string];
  "context-menu": [event: MouseEvent, node: TreeNode];
}>();

const sidebarTreeRuntime = inject(sidebarTreeRuntimeKey);
if (!sidebarTreeRuntime) throw new Error("TreeItem must be rendered inside ConnectionTree");
const treeRuntime = sidebarTreeRuntime;
const sidebarTreeContext = inject(sidebarTreeContextKey, null);

const stopPasteHandlerRegistration = watch(
  () => props.node.id,
  (nodeId, _previousNodeId, onCleanup) => {
    const unregister = sidebarTreeContext?.registerPasteHandler?.(nodeId, () => treeRuntime.requestPaste(props.node));
    if (unregister) onCleanup(unregister);
  },
  { immediate: true },
);

const activeNode = shallowRef<TreeNode>(props.node);

const showProductionBadge = computed(() => {
  const connectionId = activeNode.value.connectionId;
  const context = productionContextForDatabase(connectionId ? connectionStore.getConfig(connectionId) : undefined, activeNode.value.database);
  return context.active && ["connection", "database", "redis-db", "mongo-db"].includes(activeNode.value.type);
});

function currentDatabaseType(): DatabaseType | undefined {
  return activeNode.value.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(activeNode.value.connectionId)) : undefined;
}

function getIconInfo(node: TreeNode): { icon: any; colorClass: string } | null {
  switch (node.type) {
    case "connection":
      return null;
    case "connection-group":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-amber-500" };
    case "database":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "linked-server-root":
      return { icon: Network, colorClass: "text-blue-500" };
    case "linked-server":
      return { icon: Server, colorClass: "text-blue-400" };
    case "linked-server-catalog":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "linked-server-schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "materialized_view":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "column":
      if ((node.meta as ColumnInfo).is_primary_key) {
        return { icon: Columns3, colorClass: "text-orange-400" };
      } else {
        return { icon: Columns3, colorClass: "text-muted-foreground" };
      }
    case "group-columns":
      return { icon: ListTree, colorClass: "text-green-400" };
    case "group-indexes":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-fkeys":
      return { icon: Link, colorClass: "text-blue-400" };
    case "group-triggers":
      return { icon: Zap, colorClass: "text-orange-400" };
    case "object-browser":
      return { icon: TableProperties, colorClass: "text-primary" };
    case "user-admin":
      return { icon: UsersRound, colorClass: "text-primary" };
    case "dameng-job-admin":
      return { icon: CalendarClock, colorClass: "text-primary" };
    case "index":
      return { icon: Key, colorClass: "text-amber-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "mq-tenant":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "nacos-namespace":
      return { icon: FolderOpen, colorClass: "text-sky-500" };
    case "etcd-root":
      return { icon: Database, colorClass: "text-sky-500" };
    case "zookeeper-root":
      return { icon: Database, colorClass: "text-blue-500" };
    case "mongo-db":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "mongo-gridfs":
    case "mongo-buckets":
      return { icon: Archive, colorClass: "text-cyan-500" };
    case "mongo-bucket":
      return { icon: Archive, colorClass: "text-cyan-400" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    case "vector-collection":
      return { icon: TableProperties, colorClass: "text-cyan-400" };
    case "elasticsearch-index":
      return { icon: Table, colorClass: "text-emerald-400" };
    case "procedure":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "function":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "sequence":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "package":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "package-body":
      return { icon: FileCode, colorClass: "text-cyan-400" };
    case "type":
      return { icon: Braces, colorClass: "text-violet-500" };
    case "type-body":
      return { icon: FileCode, colorClass: "text-violet-400" };
    case "group-tables":
      return { icon: Table, colorClass: "text-green-500" };
    case "group-views":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "group-materialized-views":
      return { icon: Eye, colorClass: "text-indigo-500" };
    case "group-procedures":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "group-functions":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "group-sequences":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "group-packages":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "group-types":
      return { icon: Braces, colorClass: "text-violet-500" };
    case "group-partitions":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-green-400" };
    case "group-extensions":
      return { icon: Package, colorClass: "text-violet-500" };
    case "extension":
      return { icon: Package, colorClass: "text-violet-400" };
    case "load-more":
      return { icon: Plus, colorClass: "text-primary" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}

const groupTypes: Set<TreeNodeType> = new Set([
  "group-columns",
  "group-indexes",
  "group-fkeys",
  "group-triggers",
  "group-tables",
  "group-views",
  "group-materialized-views",
  "group-procedures",
  "group-functions",
  "group-sequences",
  "group-packages",
  "group-types",
  "group-partitions",
  "group-extensions",
]);

function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

function displayLabel(node: TreeNode): string {
  if (node.type === "load-more") return t(node.label);
  if (node.type === "object-browser") return t(node.label, { count: node.objectCount ?? 0 });
  if (node.type === "user-admin" || node.type === "dameng-job-admin") return t(node.label);
  if (node.type === "linked-server-root") return t(node.label);
  if (node.label === "tree.defaultDatabase") return t(node.label);
  return isGroupLabel(node) ? t(node.label) : node.label;
}

function visibleLabel(node: TreeNode): string {
  const withValidity = (label: string) => (node.valid === false ? `${label} · INVALID` : label);
  if (node.type === "table" || node.type === "view" || node.type === "materialized_view" || node.type === "mongo-collection" || node.type === "vector-collection" || node.type === "elasticsearch-index") {
    return withValidity(sidebarDisplayTableName(node.label, settingsStore.editorSettings.sidebarHiddenTablePrefixes));
  }
  return withValidity(displayLabel(node));
}

type DetailTooltipRow = {
  label: string;
  value: string;
  multiline?: boolean;
};

function cleanTooltipValue(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function isLocalFileConnection(config: Pick<ConnectionConfig, "db_type" | "port">): boolean {
  return config.db_type === "sqlite" || config.db_type === "duckdb" || config.db_type === "access" || (config.db_type === "h2" && config.port === 0);
}

function redactedConnectionString(value: string): string {
  return value.replace(/(:\/\/[^/\s:@?#;]+):([^@\s/?#;]+)@/g, "$1:***@").replace(/([?&;](?:password|pwd|pass|token|secret|key)=)[^&;]*/gi, "$1***");
}

function connectionTooltipScheme(config: Pick<ConnectionConfig, "db_type" | "ssl">): string {
  switch (config.db_type) {
    case "postgres":
    case "gaussdb":
    case "kwdb":
    case "yashandb":
    case "redshift":
    case "questdb":
      return "postgresql";
    case "sqlserver":
      return "mssql";
    case "elasticsearch":
    case "qdrant":
    case "milvus":
    case "weaviate":
    case "chromadb":
    case "rqlite":
    case "turso":
    case "mq":
      return config.ssl ? "https" : "http";
    case "cloudflare-d1":
      return "https";
    case "dameng":
      return "dm";
    default:
      return config.db_type;
  }
}

function hostForDisplay(host: string): string {
  if (!host.includes(":") || host.startsWith("[") || host.includes("://")) return host;
  return `[${host}]`;
}

function connectionTooltipUrl(config: ConnectionConfig): string {
  const explicit = cleanTooltipValue(config.connection_string);
  if (explicit) return redactedConnectionString(explicit);

  const host = cleanTooltipValue(config.host);
  if (!host) return "";
  if (host.includes("://")) return redactedConnectionString(host);

  if (isLocalFileConnection(config)) {
    if (config.db_type === "access") return `jdbc:ucanaccess://${host}`;
    return `${config.db_type}://${host}`;
  }

  const scheme = connectionTooltipScheme(config);
  const port = Number(config.port) > 0 ? `:${config.port}` : "";
  const user = cleanTooltipValue(config.username);
  const userInfo = user ? `${encodeURIComponent(user)}@` : "";
  const database = cleanTooltipValue(config.database);
  const path = database ? `/${encodeURIComponent(database)}` : "";
  const params = cleanTooltipValue(config.url_params);
  const query = params ? (params.startsWith("?") ? params : `?${params}`) : "";
  return redactedConnectionString(`${scheme}://${userInfo}${hostForDisplay(host)}${port}${path}${query}`);
}

const detailTooltip = computed(() => {
  const node = activeNode.value;
  if (node.type === "connection" && node.connectionId) {
    const config = connectionStore.getConfig(node.connectionId);
    if (!config) return null;
    const hostLabel = isLocalFileConnection(config) ? t("connection.filePath") : t("connection.host");
    const rows: DetailTooltipRow[] = [
      { label: t("connection.name"), value: cleanTooltipValue(config.name) },
      { label: "URL", value: connectionTooltipUrl(config), multiline: true },
      { label: hostLabel, value: cleanTooltipValue(config.host), multiline: isLocalFileConnection(config) },
      { label: "Port", value: Number(config.port) > 0 ? String(config.port) : "" },
      { label: t("connection.database"), value: cleanTooltipValue(config.database) },
      { label: t("connection.user"), value: cleanTooltipValue(config.username) },
      { label: t("connection.type"), value: config.driver_label || config.driver_profile || config.db_type },
      { label: t("connection.databaseInfo.productVersion"), value: cleanTooltipValue(config.database_info?.productVersion) },
    ].filter((row) => row.value);
    return { rows };
  }
  const comment = node.type === "column" && node.meta && "comment" in node.meta ? (node.meta as ColumnInfo).comment : node.comment;
  if (!comment || (node.type !== "schema" && node.type !== "table" && node.type !== "view" && node.type !== "column")) return null;
  const rows: DetailTooltipRow[] = [
    { label: t("connection.name"), value: visibleLabel(node) },
    { label: t("structureEditor.comment"), value: cleanTooltipValue(comment), multiline: true },
  ].filter((row) => row.value);
  return { rows };
});

function isTooltipDisabled(): boolean {
  if (detailTooltip.value?.rows.length) return isRenamingGroup.value;
  return isRenamingGroup.value || !labelOverflowing.value;
}

function visibleTreeNodes(): TreeNode[] {
  if (sidebarTreeContext) return sidebarTreeContext.getVisibleNodes();
  return flattenTree(connectionStore.treeNodes).map((item) => item.node);
}

function selectSingleTreeNode(node: TreeNode) {
  // Re-clicking the selected row should not replace the selection array and
  // force visible tree rows to recompute.
  if (!connectionStore.connectionMultiSelectActive && connectionStore.selectedTreeNodeId === node.id && connectionStore.treeSelectionAnchorId === node.id && connectionStore.selectedTreeNodeIds.length === 1 && connectionStore.selectedTreeNodeIds[0] === node.id) {
    return;
  }
  connectionStore.connectionMultiSelectActive = false;
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.selectedTreeNodeIds = [node.id];
  connectionStore.treeSelectionAnchorId = node.id;
}

function toggleTreeNodeSelection(node: TreeNode) {
  connectionStore.connectionMultiSelectActive = false;
  const ids = new Set(connectionStore.selectedTreeNodeIds);
  if (ids.has(node.id)) ids.delete(node.id);
  else ids.add(node.id);
  connectionStore.selectedTreeNodeIds = ids.size ? [...ids] : [node.id];
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.treeSelectionAnchorId = node.id;
}

function selectTreeNodeRange(node: TreeNode) {
  connectionStore.connectionMultiSelectActive = false;
  const visible = visibleTreeNodes();
  const anchorId = connectionStore.treeSelectionAnchorId || connectionStore.selectedTreeNodeId || node.id;
  const currentIndex = sidebarTreeContext ? sidebarTreeContext.getVisibleNodeIndex(node.id) : -1;
  const anchorIndex = sidebarTreeContext ? sidebarTreeContext.getVisibleNodeIndex(anchorId) : -1;

  if (sidebarTreeContext && currentIndex >= 0 && anchorIndex >= 0) {
    connectionStore.selectedTreeNodeIds = treeSelectionRangeIdsByIndex(visible, currentIndex, anchorIndex, node.id);
    connectionStore.selectedTreeNodeId = node.id;
    return;
  }

  if (!visible.some((item) => item.id === anchorId) || !visible.some((item) => item.id === node.id)) {
    selectSingleTreeNode(node);
    return;
  }

  const rangeIds = treeSelectionRangeIds(visible, node.id, anchorId, connectionStore.selectedTreeNodeId);
  connectionStore.selectedTreeNodeIds = rangeIds;
  connectionStore.selectedTreeNodeId = node.id;
}

function selectedConnectionIdsForAction(): string[] {
  const connectionIds = new Set(connectionStore.connections.map((connection) => connection.id));
  return connectionStore.selectedTreeNodeIds.filter((id) => connectionIds.has(id));
}

const isConnectionSelectionChecked = computed(() => {
  if (!connectionStore.connectionMultiSelectActive || activeNode.value.type !== "connection" || !activeNode.value.connectionId) return false;
  return connectionStore.selectedTreeNodeIds.includes(activeNode.value.connectionId);
});

function toggleConnectionMultiSelection(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return;

  // Keep connection-id normalization off the row render path; this handler only
  // runs when the checkbox is clicked, while the checked state updates often.
  const next = new Set(connectionStore.connectionMultiSelectActive ? selectedConnectionIdsForAction() : []);
  if (next.has(activeNode.value.connectionId)) next.delete(activeNode.value.connectionId);
  else next.add(activeNode.value.connectionId);

  const ids = [...next];
  connectionStore.selectedTreeNodeIds = ids;
  connectionStore.selectedTreeNodeId = ids.includes(activeNode.value.connectionId) ? activeNode.value.connectionId : (ids[0] ?? null);
  connectionStore.treeSelectionAnchorId = activeNode.value.connectionId;
  connectionStore.connectionMultiSelectActive = ids.length > 0;
  rowRef.value?.focus({ preventScroll: true });
}

async function cancelConnectionAttempt() {
  if (!activeNode.value.connectionId) return;
  try {
    const cancelled = await connectionStore.cancelConnecting(activeNode.value.connectionId);
    if (cancelled) toast(t("connection.connectCancelled"), 2000);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

const canExpand = computed(() =>
  canTreeNodeShowExpander({
    type: activeNode.value.type,
    childCount: activeNode.value.children?.length ?? 0,
  }),
);

const isPinned = computed(() => activeNode.value.pinned || connectionStore.isTreeNodePinned(activeNode.value));

const isNodeDefaultDatabase = computed(
  () => (activeNode.value.type === "database" || activeNode.value.type === "redis-db" || activeNode.value.type === "mongo-db") && !!activeNode.value.connectionId && !!activeNode.value.database && connectionStore.isDefaultDatabase(activeNode.value.connectionId, activeNode.value.database),
);

const trailingComment = computed(() => {
  if (!settingsStore.editorSettings.sidebarObjectInfoMode.startsWith("comment-")) return null;
  return sidebarTreeNodeComment(activeNode.value);
});

function isRightAlignedComment(): boolean {
  return settingsStore.editorSettings.sidebarObjectInfoMode === "comment-right" && !!trailingComment.value;
}

function cancelTrailingCommentMeasure() {
  if (!trailingCommentMeasureFrame) return;
  window.cancelAnimationFrame(trailingCommentMeasureFrame);
  trailingCommentMeasureFrame = 0;
}

function measureTrailingCommentLayout() {
  const container = trailingCommentLayoutRef.value;
  const leading = trailingCommentLeadingRef.value;
  if (!isRightAlignedComment() || !container || !leading) {
    trailingCommentMaxWidth.value = 0;
    return;
  }
  trailingCommentMaxWidth.value = trailingCommentAvailableWidth(container.clientWidth, leading.scrollWidth);
}

function scheduleTrailingCommentMeasure() {
  if (typeof window === "undefined") {
    measureTrailingCommentLayout();
    return;
  }
  cancelTrailingCommentMeasure();
  trailingCommentMeasureFrame = window.requestAnimationFrame(() => {
    trailingCommentMeasureFrame = 0;
    measureTrailingCommentLayout();
  });
}

function refreshTrailingCommentMeasurement() {
  trailingCommentResizeObserver?.disconnect();
  trailingCommentResizeObserver = null;

  const container = trailingCommentLayoutRef.value;
  const leading = trailingCommentLeadingRef.value;
  if (!isRightAlignedComment() || !container || !leading) {
    trailingCommentMaxWidth.value = 0;
    return;
  }

  scheduleTrailingCommentMeasure();
  if (typeof ResizeObserver !== "undefined") {
    trailingCommentResizeObserver = new ResizeObserver(scheduleTrailingCommentMeasure);
    trailingCommentResizeObserver.observe(container);
    trailingCommentResizeObserver.observe(leading);
  }
}

function formattedObjectStorage(): string {
  if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" || (activeNode.value.type !== "database" && activeNode.value.type !== "table" && activeNode.value.type !== "materialized_view")) return "";
  return formatSidebarObjectStorage(activeNode.value.sizeBytes);
}

const alignedCommentLabelWidth = computed(() => (settingsStore.editorSettings.sidebarObjectInfoMode === "comment-aligned" ? props.commentLabelWidth : undefined));

function hasTrailingMetadata(): boolean {
  return !!trailingComment.value || !!formattedObjectStorage();
}

const usesFullWidthLabel = computed(() => usesFullWidthTreeLabel(activeNode.value.type, settingsStore.editorSettings.sidebarAllowHorizontalScroll, hasTrailingMetadata()));

const rowWidthClass = computed(() => (usesFullWidthLabel.value ? "w-max min-w-full" : "w-full min-w-0"));

const labelWidthClass = computed(() => treeLabelWidthClass({ fullWidth: usesFullWidthLabel.value, hasTrailingComment: hasTrailingMetadata() }));

watch(() => [isRightAlignedComment(), visibleLabel(activeNode.value), trailingComment.value, trailingCommentLayoutRef.value, trailingCommentLeadingRef.value], refreshTrailingCommentMeasurement, { flush: "post", immediate: true });

const paddingLeft = computed(() => treeItemPaddingLeft(props.depth));

const tableSearchParentId = computed(() => activeNode.value.tableSearchParentId || "");

const tableSearchValue = computed(() => {
  const parentId = tableSearchParentId.value;
  return parentId ? connectionStore.sidebarTableSearchQueries[parentId] || "" : "";
});

const isConnecting = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && connectionStore.connectingIds.has(activeNode.value.connectionId));

const isConnectionReadonly = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && (connectionStore.getConfig(activeNode.value.connectionId)?.read_only ?? false));

const databaseOpenVisual = computed(() => {
  const opened = isSidebarDatabaseOpened(activeNode.value, connectionStore.isTreeNodeChildrenLoaded);
  const showsIndicator = activeNode.value.type === "database" && (opened || (!!activeNode.value.connectionId && activeNode.value.database != null && queryStore.openDatabaseKeys.has(`${activeNode.value.connectionId}\x00${activeNode.value.database}`)));
  const infoClass = getIconInfo(activeNode.value)?.colorClass;
  return {
    iconClass: activeNode.value.type !== "database" || opened ? infoClass : "text-muted-foreground/65",
    showsIndicator,
  };
});

function connectionIconType(connectionId?: string) {
  const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
  return config?.driver_profile || config?.db_type || "postgres";
}

const connectionColor = computed(() => {
  const connectionId = activeNode.value.connectionId;
  return connectionId ? connectionStore.getConfig(connectionId)?.color || "" : "";
});

const isActiveConnectionScope = computed(() => !!activeNode.value.connectionId && connectionStore.activeConnectionId === activeNode.value.connectionId);

const selectionVisual = computed(() => {
  const selected = connectionStore.selectedTreeNodeId === activeNode.value.id;
  const multiSelected = connectionStore.selectedTreeNodeIdsSet.has(activeNode.value.id);
  return {
    selected,
    multiSelected,
    rowSelected: selected || multiSelected,
    usesSelectionSetHighlight: connectionStore.connectionMultiSelectActive || connectionStore.selectedTreeNodeIds.length > 1,
  };
});

const rowStyle = computed(() => {
  const color = connectionColor.value;
  const backgroundColor = hexToRgba(color, isActiveConnectionScope.value ? 0.14 : 0.08);
  return {
    paddingLeft: paddingLeft.value,
    paddingRight: trailingComment.value ? "12px" : undefined,
    "--tree-connection-row-bg": backgroundColor,
    "--tree-connection-row-hover-bg": hexToRgba(color, isActiveConnectionScope.value ? 0.18 : 0.12),
    "--tree-connection-active-bg": hexToRgba(color, 0.18),
    "--tree-connection-active-focus-bg": hexToRgba(color, 0.22),
  };
});

const tableSearchStyle = computed(() => {
  const color = connectionColor.value;
  const rowBackgroundColor = color ? hexToRgba(color, isActiveConnectionScope.value ? 0.14 : 0.08) : "transparent";
  return {
    paddingLeft: paddingLeft.value,
    "--tree-table-search-row-bg": rowBackgroundColor,
    "--tree-table-search-input-bg": color ? hexToRgba(color, isActiveConnectionScope.value ? 0.05 : 0.03) : "hsl(var(--background) / 0.56)",
    "--tree-table-search-border": color ? hexToRgba(color, isActiveConnectionScope.value ? 0.12 : 0.08) : "hsl(var(--border) / 0.36)",
  };
});

function updateTableSearchQuery(value: string | number) {
  const parentId = tableSearchParentId.value;
  if (!parentId) return;
  const query = String(value);
  if (sidebarTreeContext?.setTableSearchQuery) {
    sidebarTreeContext.setTableSearchQuery(parentId, query);
    return;
  }
  connectionStore.setSidebarTableSearchQuery(parentId, query);
  void connectionStore.refreshSidebarTableSearch(parentId);
}

function clearTableSearchQuery() {
  updateTableSearchQuery("");
}

// --- Connection Group Management ---
const isRenamingGroup = ref(false);

const renameInput = ref("");

const renameInputRef = ref<HTMLInputElement>();

function startRenameGroup() {
  renameInput.value = activeNode.value.label;
  isRenamingGroup.value = true;
  emit("rename-started");
  focusSidebarRenameInput(() => (isRenamingGroup.value ? renameInputRef.value : undefined));
}

watch(
  () => props.pendingRename,
  (pending) => {
    if (pending && activeNode.value.type === "connection-group") startRenameGroup();
  },
  { immediate: true },
);

function shouldMeasureLabelOverflow(): boolean {
  return shouldMeasureSidebarLabelOverflow({
    hasDetailTooltip: !!detailTooltip.value?.rows.length,
    isRenaming: isRenamingGroup.value,
    usesFullWidthLabel: usesFullWidthLabel.value,
  });
}

function finishRenameGroup() {
  // Guard against double invocation: pressing Enter sets isRenamingGroup=false
  // and unmounts the input, which then fires @blur -> finishRenameGroup again.
  // The first call can rebuild the tree and recycle activeNode.value onto a different
  // group, so a second run would act on the wrong group and cascade across
  // groups (issue #681).
  if (!isRenamingGroup.value) return;
  isRenamingGroup.value = false;
  const trimmed = renameInput.value.trim();
  // An empty name cancels the rename and keeps the group as-is — never delete
  // here. Deleting a group is done explicitly via the context menu (issue #681).
  if (!trimmed || trimmed === activeNode.value.label) return;
  connectionStore.renameConnectionGroup(activeNode.value.id, trimmed);
}

const {
  state: dragState,
  startDrag,
  updateTarget,
  clearTarget,
} = useDragSort((draggedId, targetId, position) => {
  // If the grabbed row is part of a multi-selection, move all selected rows
  // together; otherwise just the grabbed one (issue #681).
  const selected = connectionStore.selectedTreeNodeIds;
  const draggedIds = selected.length > 1 && selected.includes(draggedId) ? [...selected] : [draggedId];
  connectionStore.reorderSidebarEntries(draggedIds, targetId, position);
});

const isDraggable = computed(() => {
  if (props.dragDisabled) return false;
  return activeNode.value.type === "connection" || activeNode.value.type === "connection-group";
});

const dragVisual = computed(() => ({
  isDropTarget: activeNode.value.type === "connection" || activeNode.value.type === "connection-group",
  showBefore: dragState.active && dragState.targetId === activeNode.value.id && dragState.dropPosition === "before",
  showAfter: dragState.active && dragState.targetId === activeNode.value.id && dragState.dropPosition === "after",
  showInside: dragState.active && dragState.targetId === activeNode.value.id && dragState.dropPosition === "inside",
  dragging: dragState.active && dragState.draggedId === activeNode.value.id,
}));

const TABLE_REFERENCE_DRAG_THRESHOLD = 5;

const TABLE_REFERENCE_DRAGGING_CLASS = "dbx-table-reference-dragging";

const canDragTableReference = computed(() => {
  if (props.dragDisabled || !activeNode.value.connectionId) return false;
  if (activeNode.value.type === "database") return typeof activeNode.value.database === "string" && activeNode.value.database.trim().length > 0;
  if (activeNode.value.database == null) return false;
  if (activeNode.value.type === "table" || activeNode.value.type === "view" || activeNode.value.type === "materialized_view") return true;
  return activeNode.value.type === "column" && !!activeNode.value.tableName;
});

let pendingTableReferenceDrag: {
  payload: QueryEditorTableReferencePayload;
  startX: number;
  startY: number;
} | null = null;

let draggingTableReferencePayload: QueryEditorTableReferencePayload | null = null;

let suppressNextTableReferenceClick = false;

function tableReferenceDragPayload(): QueryEditorTableReferencePayload | null {
  if (!canDragTableReference.value) return null;
  if (activeNode.value.type === "database") {
    return createTableReferencePayload({
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database,
      referenceType: "database",
      databaseType: currentDatabaseType(),
    });
  }
  if (activeNode.value.type === "column") {
    const columnName = columnNameForDrag(activeNode.value);
    if (!activeNode.value.tableName || !columnName) return null;
    return createTableReferencePayload({
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database,
      schema: activeNode.value.schema,
      tableName: activeNode.value.tableName,
      columnName,
      databaseType: currentDatabaseType(),
    });
  }
  const payload = createTableReferencePayload({
    connectionId: activeNode.value.connectionId,
    database: activeNode.value.database,
    schema: activeNode.value.schema,
    tableName: activeNode.value.label,
    databaseType: currentDatabaseType(),
  });
  return payload;
}

function columnNameForDrag(node: TreeNode): string {
  const column = node.meta as Partial<ColumnInfo> | undefined;
  if (typeof column?.name === "string" && column.name) return column.name;
  return node.label.replace(/\s+\([^()]*\)$/, "");
}

function startTableReferenceDrag(payload: QueryEditorTableReferencePayload) {
  draggingTableReferencePayload = payload;
  setActiveTableReferencePayload(payload);
  document.getSelection()?.removeAllRanges();
  document.body.style.cursor = "copy";
}

function finishTableReferenceDrag() {
  clearActiveTableReferencePayload(draggingTableReferencePayload);
  pendingTableReferenceDrag = null;
  draggingTableReferencePayload = null;
  document.body.classList.remove(TABLE_REFERENCE_DRAGGING_CLASS);
  document.body.style.cursor = "";
  document.removeEventListener("mousemove", onTableReferenceMouseMove, true);
  document.removeEventListener("mouseup", onTableReferenceMouseUp, true);
}

function onTableReferenceMouseMove(event: MouseEvent) {
  if (!pendingTableReferenceDrag && !draggingTableReferencePayload) return;
  if (pendingTableReferenceDrag && !draggingTableReferencePayload) {
    const dx = event.clientX - pendingTableReferenceDrag.startX;
    const dy = event.clientY - pendingTableReferenceDrag.startY;
    if (Math.abs(dx) < TABLE_REFERENCE_DRAG_THRESHOLD && Math.abs(dy) < TABLE_REFERENCE_DRAG_THRESHOLD) return;
    startTableReferenceDrag(pendingTableReferenceDrag.payload);
  }
  if (draggingTableReferencePayload) {
    event.preventDefault();
    document.getSelection()?.removeAllRanges();
  }
}

function onTableReferenceMouseUp(event: MouseEvent) {
  const payload = draggingTableReferencePayload;
  if (payload) {
    suppressNextTableReferenceClick = true;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target instanceof Element && target.closest("[data-query-editor-root]")) {
      window.dispatchEvent(
        createTableReferenceDropEvent({
          payload,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    }
  }
  finishTableReferenceDrag();
}

function startTableReferenceMouseDrag(event: MouseEvent) {
  if (event.button !== 0) return;
  const payload = tableReferenceDragPayload();
  if (!payload) return;
  event.preventDefault();
  document.getSelection()?.removeAllRanges();
  document.body.classList.add(TABLE_REFERENCE_DRAGGING_CLASS);
  pendingTableReferenceDrag = { payload, startX: event.clientX, startY: event.clientY };
  document.addEventListener("mousemove", onTableReferenceMouseMove, true);
  document.addEventListener("mouseup", onTableReferenceMouseUp, true);
}

function onRowMouseDown(event: MouseEvent) {
  if (isDraggable.value) {
    startDrag(event, activeNode.value.id, activeNode.value.type);
  } else if (canDragTableReference.value) {
    startTableReferenceMouseDrag(event);
  }
}

watch(
  () => props.node,
  (node, previousNode) => {
    activeNode.value = node;
    if (node.id === previousNode.id) return;
    // Virtual rows are recycled; transient DOM and pointer state must not leak
    // from the previously rendered node into the new row.
    isRenamingGroup.value = false;
    renameInput.value = "";
    labelOverflowing.value = false;
    suppressNextTableReferenceClick = false;
    handleMouseLeave();
    finishTableReferenceDrag();
  },
  { flush: "sync" },
);

onBeforeUnmount(() => {
  stopPasteHandlerRegistration();
  handleMouseLeave();
  trailingCommentResizeObserver?.disconnect();
  cancelTrailingCommentMeasure();
  finishTableReferenceDrag();
});

function onToggleClick() {
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
  treeRuntime.toggleNode(props.node);
}

function onToggleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
}

function onClick(event: MouseEvent) {
  if (suppressNextTableReferenceClick) {
    suppressNextTableReferenceClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  // The tree container clears selection on blank-area clicks, so row clicks
  // must remain isolated while the tree-level runtime performs the action.
  event.stopPropagation();
  const openMode = dataTabOpenModeFromTreeClick(props.node.type, event, settingsStore.editorSettings.shortcuts.openDataInNewTab);
  if (openMode === "new-tab") {
    event.preventDefault();
    if (event.detail > 1) return;
    selectSingleTreeNode(props.node);
    rowRef.value?.focus({ preventScroll: true });
    treeRuntime.openDataInNewTab(props.node);
    return;
  }
  if (event.shiftKey) {
    selectTreeNodeRange(props.node);
    rowRef.value?.focus({ preventScroll: true });
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    toggleTreeNodeSelection(props.node);
    rowRef.value?.focus({ preventScroll: true });
    return;
  }
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
  if (settingsStore.editorSettings.sidebarActivation === "double") return;
  treeRuntime.handleRowClick(props.node, event.detail);
}

function onDoubleClick(event: MouseEvent) {
  treeRuntime.handleRowDoubleClick(props.node, event);
}

function onTreeItemContextMenu(event: MouseEvent) {
  if (!connectionStore.selectedTreeNodeIds.includes(props.node.id)) selectSingleTreeNode(props.node);
  else connectionStore.selectedTreeNodeId = props.node.id;
  rowRef.value?.focus({ preventScroll: true });
  emit("context-menu", event, props.node);
}

function onKeydown(event: KeyboardEvent) {
  treeRuntime.handleRowKeydown(props.node, event);
}
</script>

<template>
  <div v-if="node.type === 'table-search-control'" class="tree-table-search-control flex h-7 items-center py-0.5 pr-2" :style="tableSearchStyle" @click.stop @dblclick.stop @mousedown.stop @keydown.stop>
    <div class="relative w-full min-w-0">
      <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        :model-value="tableSearchValue"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="h-6 w-full rounded border pl-7 pr-6 text-xs shadow-none focus-visible:ring-1"
        :style="{ backgroundColor: 'var(--tree-table-search-input-bg)', borderColor: 'var(--tree-table-search-border)' }"
        :placeholder="t(node.label)"
        :aria-label="t(node.label)"
        :data-sidebar-table-search-parent-id="tableSearchParentId"
        @update:model-value="updateTableSearchQuery"
      />
      <button v-if="tableSearchValue" type="button" class="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="t('sidebar.clearTableSearch')" @click.stop="clearTableSearchQuery">
        <X class="h-3 w-3" />
      </button>
    </div>
  </div>

  <div v-else @contextmenu="onTreeItemContextMenu">
    <LightTooltip :text="displayLabel(node)" :disabled="isTooltipDisabled()" side="right" :side-offset="8" :delay="0" :close-delay="0" :surface="detailTooltip ? 'popover' : 'foreground'">
      <div
        ref="rowRef"
        class="group flex items-center gap-2 py-1 px-2 cursor-pointer relative outline-none"
        style="contain: layout style"
        :class="[
          rowWidthClass,
          {
            'group/sidebar-row': true,
            'ring-1 ring-primary/50 bg-primary/5': dragVisual.showInside,
            'opacity-50': dragVisual.dragging,
            'tree-item-connection-tint': connectionColor,
            'hover:bg-accent': node.type !== 'connection',
            'hover:bg-secondary/60': node.type === 'connection',
            rounded: !selectionVisual.rowSelected,
            'tree-item-active': selectionVisual.rowSelected,
            'tree-item-active--selection-set': selectionVisual.usesSelectionSetHighlight && selectionVisual.rowSelected,
            'tree-item-highlight': highlighted,
          },
        ]"
        :tabindex="selectionVisual.selected || selectionVisual.multiSelected ? 0 : -1"
        :style="rowStyle"
        @click="onClick"
        @dblclick="onDoubleClick"
        @keydown="onKeydown"
        @mousedown="onRowMouseDown"
        @mousemove="dragVisual.isDropTarget ? updateTarget($event, node.id, node.type) : undefined"
        @mouseenter="handleMouseEnter"
        @mouseleave="
          clearTarget(node.id);
          handleMouseLeave();
        "
      >
        <div v-if="dragVisual.showBefore" class="absolute right-2 top-0 h-0.5 bg-primary rounded-full pointer-events-none" :style="{ left: paddingLeft }" />
        <div v-if="dragVisual.showAfter" class="absolute right-2 bottom-0 h-0.5 bg-primary rounded-full pointer-events-none" :style="{ left: paddingLeft }" />
        <template v-if="canExpand">
          <button type="button" class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" @mousedown.stop="onToggleMouseDown" @click.stop="onToggleClick">
            <Loader2 v-if="node.isLoading" class="w-3.5 h-3.5 animate-spin" />
            <ChevronDown v-else-if="node.isExpanded" class="w-3.5 h-3.5" />
            <ChevronRight v-else class="w-3.5 h-3.5" />
          </button>
        </template>
        <span v-else class="w-3.5 h-3.5 shrink-0" />
        <DatabaseIcon v-if="node.type === 'connection'" :db-type="connectionIconType(node.connectionId)" class="h-3.5 w-3.5 shrink-0" />
        <Loader2 v-else-if="node.type === 'load-more' && node.isLoading" class="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
        <component v-else :is="getIconInfo(node)?.icon || Database" class="w-3.5 h-3.5 shrink-0" :class="databaseOpenVisual.iconClass" />
        <div ref="trailingCommentLayoutRef" :class="hasTrailingMetadata() ? 'flex flex-1 min-w-0 items-center' : 'contents'">
          <div
            ref="trailingCommentLeadingRef"
            :class="trailingComment ? 'flex max-w-full min-w-0 shrink-0 items-center gap-2' : formattedObjectStorage() ? 'flex min-w-0 flex-1 items-center gap-2' : 'contents'"
            :style="alignedCommentLabelWidth ? { width: `${alignedCommentLabelWidth}px` } : undefined"
          >
            <input
              v-if="isRenamingGroup"
              ref="renameInputRef"
              v-model="renameInput"
              class="min-w-0 flex-1 truncate bg-transparent border border-primary/50 rounded px-1 outline-none"
              @blur="finishRenameGroup"
              @keydown.enter.prevent="finishRenameGroup"
              @keydown.escape.prevent="isRenamingGroup = false"
              @click.stop
            />
            <span v-else ref="labelRef" :class="labelWidthClass">{{ visibleLabel(node) }}</span>
            <ProductionContextBadge v-if="showProductionBadge" compact />
            <span
              v-if="
                (node.type === 'group-tables' || node.type === 'group-views' || node.type === 'group-materialized-views' || node.type === 'group-procedures' || node.type === 'group-functions' || node.type === 'group-sequences' || node.type === 'group-packages' || node.type === 'group-partitions') &&
                node.objectCount != null
              "
              class="text-muted-foreground text-[10px] shrink-0"
              >{{ node.objectCount }}</span
            >
            <Badge v-if="isNodeDefaultDatabase" variant="secondary" class="h-4 px-1.5 text-[10px]">
              {{ t("editor.defaultDatabase") }}
            </Badge>
          </div>
          <span v-if="trailingComment && !isRightAlignedComment()" class="sidebar-object-comment ml-2 min-w-0 flex-1 truncate text-left" :class="{ 'sidebar-object-comment--windows': useWindowsSidebarCommentFont }">{{ trailingComment }}</span>
          <span v-if="isRightAlignedComment() && trailingCommentMaxWidth > 0" class="min-w-0 flex-1" aria-hidden="true" />
          <span
            v-if="isRightAlignedComment() && trailingCommentMaxWidth > 0"
            class="sidebar-object-comment sidebar-object-comment--right min-w-0 shrink-0 truncate text-left"
            :class="{ 'sidebar-object-comment--windows': useWindowsSidebarCommentFont }"
            :style="{ marginLeft: `${trailingCommentGapPx}px`, maxWidth: `${trailingCommentMaxWidth}px` }"
            >{{ trailingComment }}</span
          >
        </div>
        <span v-if="node.type === 'connection' && node.connectionId && connectionStore.connectedIds.has(node.connectionId)" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
        <span v-if="databaseOpenVisual.showsIndicator" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
        <Badge v-if="isConnectionReadonly" variant="secondary" class="h-4 px-1.5 text-[10px] gap-0.5"><Lock class="w-2.5 h-2.5" />{{ t("connection.readOnlyBadge") }}</Badge>
        <ConnectionErrorIndicator v-if="node.type === 'connection'" :connection-id="node.connectionId" trigger-class="h-4 w-4" />
        <Pin v-if="isPinned" class="w-3 h-3 shrink-0 text-primary fill-current" aria-hidden="true" />
        <span v-if="formattedObjectStorage()" class="ml-auto shrink-0 text-right text-xs tabular-nums text-muted-foreground">{{ formattedObjectStorage() }}</span>
        <button
          v-if="isConnecting"
          type="button"
          class="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('connection.cancelConnecting')"
          :title="t('connection.cancelConnecting')"
          @mousedown.stop
          @click.stop="cancelConnectionAttempt"
        >
          <X class="h-3 w-3" />
        </button>
        <button
          v-if="node.type === 'connection'"
          type="button"
          class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/55 opacity-0 transition-colors transition-opacity hover:bg-secondary/45 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/sidebar-row:opacity-100"
          :class="[{ 'opacity-100': isConnectionSelectionChecked || connectionStore.connectionMultiSelectActive }, isConnecting ? '' : 'ml-auto']"
          :aria-label="isConnectionSelectionChecked ? t('connectionGroup.deselectConnection') : t('connectionGroup.selectConnection')"
          @mousedown.stop
          @click="toggleConnectionMultiSelection"
        >
          <Check v-if="isConnectionSelectionChecked" class="h-3 w-3 text-primary" />
          <Square v-else class="h-3 w-3 stroke-[1.7]" />
        </button>
      </div>
      <template v-if="detailTooltip" #content>
        <div class="w-max min-w-40 max-w-[min(28rem,calc(100vw-24px))] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
          <div class="space-y-1">
            <div v-for="row in detailTooltip.rows" :key="row.label" class="grid grid-cols-[max-content_minmax(0,1fr)] gap-2 text-xs leading-5">
              <span class="text-muted-foreground">{{ row.label }}</span>
              <span v-if="row.multiline" class="max-h-20 overflow-hidden whitespace-pre-wrap break-words text-foreground/90">
                {{ row.value }}
              </span>
              <span v-else class="truncate font-mono text-foreground/90" :title="row.value">{{ row.value }}</span>
            </div>
          </div>
        </div>
      </template>
    </LightTooltip>
  </div>
</template>

<style>
.sidebar-object-comment {
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1rem;
  opacity: 0.6;
  /* Sidebar rows repaint on hover; avoid heavier font shaping and fallback here. */
  text-rendering: auto;
}

.sidebar-object-comment--right {
  width: max-content;
  max-width: 100%;
  flex-shrink: 999;
}

.sidebar-object-comment--windows {
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  font-weight: 500;
  opacity: 1;
}

.tree-item-connection-tint {
  isolation: isolate;
  background-color: transparent !important;
}

.tree-item-connection-tint::before {
  content: "";
  position: absolute;
  inset: 0 -9999px;
  z-index: 0;
  background-color: var(--tree-connection-row-bg);
  border-radius: inherit;
  pointer-events: none;
}

.tree-item-connection-tint > * {
  position: relative;
  z-index: 1;
}

.tree-item-connection-tint:hover,
.tree-item-connection-tint.tree-item-active,
.tree-item-connection-tint.tree-item-active:focus {
  background-color: transparent !important;
}

.tree-item-connection-tint:hover::before {
  background-color: var(--tree-connection-row-hover-bg, var(--tree-connection-row-bg));
}

.tree-item-connection-tint.tree-item-active::before {
  background-color: var(--tree-connection-active-bg, var(--tree-connection-row-bg));
}

.tree-item-connection-tint.tree-item-active:focus::before {
  background-color: var(--tree-connection-active-focus-bg, var(--tree-connection-active-bg));
}

.tree-item-connection-tint.tree-item-active--selection-set:focus::before {
  background-color: var(--tree-connection-active-bg, var(--tree-connection-row-bg));
}

.tree-table-search-control {
  position: relative;
  isolation: isolate;
  background-color: transparent;
}

.tree-table-search-control::before {
  content: "";
  position: absolute;
  inset: 0 -9999px;
  z-index: 0;
  background-color: var(--tree-table-search-row-bg);
  pointer-events: none;
}

.tree-table-search-control > * {
  position: relative;
  z-index: 1;
}

/* Unfocused: subtle gray */
.tree-item-active {
  background-color: var(--tree-connection-active-bg, rgb(235 235 235)) !important;
}
:root.dark .tree-item-active {
  background-color: var(--tree-connection-active-bg, rgb(36 36 36)) !important;
}

/* Focused: soft blue */
.tree-item-active:focus {
  background-color: var(--tree-connection-active-focus-bg, rgb(211 227 245)) !important;
}
:root.dark .tree-item-active:focus {
  background-color: var(--tree-connection-active-focus-bg, rgb(33 60 89)) !important;
}

/* Multi-selection treats every selected row as equal; keep focus neutral. */
.tree-item-active--selection-set:focus {
  background-color: var(--tree-connection-active-bg, rgb(235 235 235)) !important;
  box-shadow: inset 0 0 0 1px hsl(var(--foreground) / 0.14);
}
:root.dark .tree-item-active--selection-set:focus {
  background-color: var(--tree-connection-active-bg, rgb(36 36 36)) !important;
  box-shadow: inset 0 0 0 1px hsl(var(--foreground) / 0.18);
}

/* Locate highlight: instant amber, then fade on removal */
.tree-item-highlight {
  background-color: rgb(253 225 167) !important;
  background-color: oklch(0.92 0.08 85) !important;
  transition: background-color 0.28s ease-out;
}

:root.dark .tree-item-highlight {
  background-color: rgb(110 67 0) !important;
  background-color: oklch(0.42 0.12 80) !important;
  transition: background-color 0.28s ease-out;
}

.tree-item-connection-tint.tree-item-highlight::before {
  background-color: rgb(253 225 167) !important;
  background-color: oklch(0.92 0.08 85) !important;
}

:root.dark .tree-item-connection-tint.tree-item-highlight::before {
  background-color: rgb(110 67 0) !important;
  background-color: oklch(0.42 0.12 80) !important;
}
</style>
