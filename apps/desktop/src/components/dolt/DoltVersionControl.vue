<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRight, Check, ChevronRight, Clipboard, Database, FileDiff, Folder, FolderOpen, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, List, Loader2, Plus, RefreshCw, RotateCcw, Search, Table2, Tag, Trash2, TriangleAlert, Undo2 } from "@lucide/vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import DoltDiffPagination from "@/components/dolt/DoltDiffPagination.vue";
import DoltDiffTable from "@/components/dolt/DoltDiffTable.vue";
import DoltCellDiffDialog from "@/components/dolt/DoltCellDiffDialog.vue";
import DoltRevisionSelector from "@/components/dolt/DoltRevisionSelector.vue";
import DoltScrollArea from "@/components/dolt/DoltScrollArea.vue";
import * as api from "@/lib/backend/api";
import { filterDatabaseNamesForVisiblePicker } from "@/lib/database/visibleDatabases";
import type { QueryResult } from "@/types/database";
import {
  doltAddAllSql,
  doltCommitSql,
  doltCreateBranchSql,
  doltCreateTagSql,
  doltCheckoutBranchSql,
  doltDeleteBranchSql,
  doltDeleteTagSql,
  doltDiscardWorkingTreeSql,
  doltDiffSummarySql,
  doltClientSessionScope,
  doltGraphEdgePath,
  doltGraphEdgeRoute,
  doltHardResetSql,
  doltLogSql,
  doltMergeBranchSql,
  doltRevertCommitSql,
  doltRefColorIndexes,
  doltRefsByCommit,
  doltStatusSql,
  doltTableChangeFlags,
  doltTableChangeKind,
  doltTableChangeSymbol,
  doltTableDiffCountSql,
  doltTableDiffSql,
  layoutDoltCommitGraph,
  parseDoltBranches,
  parseDoltCommits,
  parseDoltRowDiff,
  parseDoltStatus,
  parseDoltTableChanges,
  parseDoltTags,
  type DoltCommit,
  type DoltDiffRow,
  type DoltGraphEdgeRoute,
  type DoltRef,
  type DoltTableChange,
  type DoltTableChangeFlag,
  type DoltWorkingChange,
  type DoltClientSessionScope,
} from "@/lib/dolt/doltVersionControl";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { doltCellCopyText, type DoltCellSide, type DoltDiffCellTarget } from "@/lib/dolt/doltCellDiff";

const props = defineProps<{
  connectionId: string;
  database: string;
  initialBranch?: string;
}>();

const { t, locale } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();
function baseDatabaseName(database: string): string {
  const slash = database.indexOf("/");
  return slash > 0 ? database.slice(0, slash) : database;
}
const loading = ref(false);
const graphLoading = ref(false);
const comparisonLoading = ref(false);
const tableDiffLoading = ref(false);
const error = ref("");
const comparisonError = ref("");
const tableDiffError = ref("");
const activeBranch = ref("");
const selectedDatabase = ref(baseDatabaseName(props.database));
const databaseOptions = ref<string[]>([]);
const databaseLoading = ref(false);
const databaseSwitching = ref(false);
const branchSwitchingTarget = ref("");
const branches = ref<DoltRef[]>([]);
const tags = ref<DoltRef[]>([]);
const commits = ref<DoltCommit[]>([]);
const workingChanges = ref<DoltWorkingChange[]>([]);
const selectedRef = ref("");
const selectedRevisionKeys = ref<string[]>([]);
const comparedFrom = ref("");
const comparedTo = ref("");
const changes = ref<DoltTableChange[]>([]);
const selectedTableName = ref("");
const tableDiff = shallowRef<QueryResult | null>(null);
const selectedDiffCell = ref<DoltDiffCellTarget | null>(null);
const diffCellContextTarget = ref<DoltDiffCellTarget | null>(null);
const diffCellDetailTarget = ref<DoltDiffCellTarget | null>(null);
const diffCellDetailOpen = ref(false);
const refFilter = ref("");
const refListTab = ref<"branches" | "tags">("branches");
const branchTreeView = ref(true);
const collapsedBranchPaths = ref<Set<string>>(new Set());
const branchDialog = ref<"create" | "merge" | "delete" | "create-tag" | "delete-tag" | null>(null);
const branchNameDraft = ref("");
const branchSourceRevision = ref("HEAD");
const branchActionTarget = ref("");
const mutationLoading = ref(false);
const mutationError = ref("");
const commitDialogOpen = ref(false);
const commitMessageDraft = ref("");
const commitError = ref("");
const commitHistoryOperation = ref<"revert" | "hard-reset" | null>(null);
const commitHistoryTarget = ref<DoltCommit | null>(null);
const commitHistoryError = ref("");
const discardWorkingTreeDialogOpen = ref(false);
const discardWorkingTreeError = ref("");
const activeDatabase = computed(() => selectedDatabase.value || baseDatabaseName(props.database));
const clientSessionId = computed(() => doltClientSessionScope(props.connectionId, activeDatabase.value).clientSessionId);
let loadGeneration = 0;
let comparisonGeneration = 0;
let tableDiffGeneration = 0;
let databaseSwitchGeneration = 0;
const COMMIT_ROW_HEIGHT = 30;
const DOLT_DIFF_DEFAULT_PAGE_SIZE = 100;
const DOLT_LEFT_PANE_DEFAULT_SIZE = 20;
const DOLT_LEFT_PANE_MIN_SIZE = 15;
const DOLT_LEFT_PANE_MAX_SIZE = 40;
const GRAPH_COLORS = ["#2f6fdb", "#1f8f55", "#b7791f", "#c2413a", "#7c3aed", "#0f766e", "#b45309", "#0891b2", "#be185d", "#4d7c0f", "#4338ca", "#a16207", "#0e7490", "#9f1239", "#166534", "#6d28d9", "#92400e", "#475569"];
const doltLeftPaneSize = ref(DOLT_LEFT_PANE_DEFAULT_SIZE);

const allRefs = computed(() => [...branches.value, ...tags.value]);
const normalizedRefFilter = computed(() => refFilter.value.trim().toLowerCase());
const visibleBranches = computed(() =>
  branches.value
    .filter((item) => item.active || !normalizedRefFilter.value || item.name.toLowerCase().includes(normalizedRefFilter.value))
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.name.localeCompare(right.name, locale.value, { sensitivity: "base" });
    }),
);
const visibleTags = computed(() => tags.value.filter((item) => !normalizedRefFilter.value || item.name.toLowerCase().includes(normalizedRefFilter.value)));

interface BranchTreeNode {
  path: string;
  label: string;
  branch?: DoltRef;
  children: Map<string, BranchTreeNode>;
}

interface BranchTreeRow {
  key: string;
  label: string;
  depth: number;
  branch?: DoltRef;
  folder: boolean;
  expanded: boolean;
}

const branchTreeRows = computed<BranchTreeRow[]>(() => {
  const roots = new Map<string, BranchTreeNode>();
  for (const branch of visibleBranches.value) {
    const parts = branch.name.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let level = roots;
    let parentPath = "";
    parts.forEach((part, index) => {
      const path = parentPath ? `${parentPath}/${part}` : part;
      const node = level.get(path) ?? { path, label: part, children: new Map<string, BranchTreeNode>() };
      if (index === parts.length - 1) node.branch = branch;
      level.set(path, node);
      parentPath = path;
      level = node.children;
    });
  }

  const rows: BranchTreeRow[] = [];
  const activeBranchName = branches.value.find((branch) => branch.active)?.name ?? "";
  const append = (nodes: Map<string, BranchTreeNode>, depth: number) => {
    [...nodes.values()]
      .sort((left, right) => {
        const leftContainsActive = !!activeBranchName && (left.path === activeBranchName || activeBranchName.startsWith(`${left.path}/`));
        const rightContainsActive = !!activeBranchName && (right.path === activeBranchName || activeBranchName.startsWith(`${right.path}/`));
        if (leftContainsActive !== rightContainsActive) return leftContainsActive ? -1 : 1;
        if (left.branch?.active !== right.branch?.active) return left.branch?.active ? -1 : 1;
        return left.label.localeCompare(right.label, locale.value, { sensitivity: "base" });
      })
      .forEach((node) => {
        const folder = node.children.size > 0;
        const expanded = folder && !collapsedBranchPaths.value.has(node.path);
        rows.push({ key: node.path, label: node.label, depth, branch: node.branch, folder, expanded });
        if (expanded) append(node.children, depth + 1);
      });
  };
  append(roots, 0);
  return rows;
});
const refsByCommit = computed(() => doltRefsByCommit(commits.value, allRefs.value));
const graphRefColorIndexes = computed(() =>
  doltRefColorIndexes(
    [...refsByCommit.value.values()].flat().map((refItem) => refItem.name),
    GRAPH_COLORS.length,
  ),
);
const graphLayout = computed(() => layoutDoltCommitGraph(commits.value, allRefs.value, activeBranch.value));
const workingTreeLane = computed(() => graphLayout.value.rows[0]?.lane ?? 0);
const workingTreeRef = computed(() => graphLayout.value.rows[0]?.nodeRef ?? activeBranch.value);
const graphWidth = computed(() => Math.max(72, graphLayout.value.laneCount * 18 + 30));
const showWorkingTree = computed(() => workingChanges.value.length > 0 && selectedRef.value === activeBranch.value);
const graphRowOffset = computed(() => (showWorkingTree.value ? 1 : 0));
const graphHeight = computed(() => (commits.value.length + graphRowOffset.value) * COMMIT_ROW_HEIGHT);
const stagedWorkingChangeCount = computed(() => workingChanges.value.filter((change) => change.staged).length);
const unstagedWorkingChangeCount = computed(() => workingChanges.value.length - stagedWorkingChangeCount.value);
const workingTreeTitle = computed(() => workingChanges.value.map((change) => `${change.tableName}: ${change.status || "modified"}`).join("\n"));
const selectedChange = computed(() => changes.value.find((change) => change.tableName === selectedTableName.value));
const parsedTableDiff = computed(() => (tableDiff.value ? parseDoltRowDiff(tableDiff.value, selectedChange.value?.schemaChange) : { columns: [], columnKinds: [], rows: [] as DoltDiffRow[] }));
const diffGridScopeKey = computed(() => [props.connectionId, activeDatabase.value, comparedFrom.value, comparedTo.value, selectedTableName.value].join(":"));
const diffColumnWidths = ref<number[]>([]);
const beforeDiffSide = ref<HTMLElement | null>(null);
const afterDiffSide = ref<HTMLElement | null>(null);
let diffColumnWidthReports: Partial<Record<"before" | "after", number[]>> = {};
const diffColumnWidthsReady = ref(false);
let detachDiffScrollSync: (() => void) | undefined;
let diffScrollSyncFrame = 0;
let diffScrollSyncRetry = 0;
let diffScrollSyncRetryTimer = 0;
let diffScrollSyncing = false;
const tableDiffPage = ref(1);
const tableDiffPageSize = ref(DOLT_DIFF_DEFAULT_PAGE_SIZE);
const tableDiffTotalRows = ref(0);
const tableDiffMaximumPage = computed(() => Math.max(1, Math.ceil(tableDiffTotalRows.value / tableDiffPageSize.value)));
const selectedRevisionKeySet = computed(() => new Set(selectedRevisionKeys.value));
const connectionReadOnly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only ?? false);
const createsNamedRef = computed(() => branchDialog.value === "create" || branchDialog.value === "create-tag");
const mutationDialogTitle = computed(() => {
  if (branchDialog.value === "create") return t("doltVersionControl.createBranch");
  if (branchDialog.value === "create-tag") return t("doltVersionControl.createTag");
  if (branchDialog.value === "merge") return t("doltVersionControl.mergeBranch");
  if (branchDialog.value === "delete-tag") return t("doltVersionControl.deleteTag");
  return t("doltVersionControl.deleteBranch");
});
const mutationDialogDescription = computed(() => {
  if (branchDialog.value === "create") return t("doltVersionControl.createBranchDescription");
  if (branchDialog.value === "create-tag") return t("doltVersionControl.createTagDescription");
  if (branchDialog.value === "merge") return t("doltVersionControl.mergeBranchDescription", { name: branchActionTarget.value });
  if (branchDialog.value === "delete-tag") return t("doltVersionControl.deleteTagDescription", { name: branchActionTarget.value });
  return t("doltVersionControl.deleteBranchDescription", { name: branchActionTarget.value });
});
const commitHistoryOperationTitle = computed(() => t(commitHistoryOperation.value === "hard-reset" ? "doltVersionControl.hardResetTitle" : "doltVersionControl.revertCommitTitle"));
const commitHistoryOperationDescription = computed(() => {
  const commit = commitHistoryTarget.value;
  if (!commit) return "";
  const params = { hash: shortHash(commit.hash), branch: activeBranch.value };
  return t(commitHistoryOperation.value === "hard-reset" ? "doltVersionControl.hardResetDescription" : "doltVersionControl.revertCommitDescription", params);
});
const commitHistoryOperationSql = computed(() => {
  const commit = commitHistoryTarget.value;
  if (!commit || !commitHistoryOperation.value) return "";
  return commitHistoryOperation.value === "hard-reset" ? doltHardResetSql(commit.hash) : doltRevertCommitSql(commit.hash);
});
const discardWorkingTreeSqlPreview = computed(() => doltDiscardWorkingTreeSql());

const graphEdges = computed(() => {
  const edges: Array<{ key: string; path: string; color: string; diagonal: boolean }> = [];
  const commitIndexes = new Map(commits.value.map((commit, index) => [commit.hash, index]));
  const targetIndexForHash = (hash: string) => commitIndexes.get(hash) ?? commits.value.findIndex((commit) => commit.hash.startsWith(hash) || hash.startsWith(commit.hash));
  graphLayout.value.rows.forEach((row, index) => {
    const commit = commits.value[index];
    commit?.parents.forEach((parentHash, parentIndex) => {
      const targetIndex = targetIndexForHash(parentHash);
      if (targetIndex <= index) return;
      const parentRow = graphLayout.value.rows[targetIndex];
      if (!parentRow) return;
      const diagonal = row.lane !== parentRow.lane;
      const route: DoltGraphEdgeRoute = doltGraphEdgeRoute(parentRow.lane, row.lane, targetIndex - index, commit.parents.length);
      edges.push({
        key: `${commit.hash}-${parentHash}-${parentIndex}`,
        path: doltGraphEdgePath(laneX(parentRow.lane), commitRowY(targetIndex), laneX(row.lane), commitRowY(index), route),
        color: graphColor(parentIndex === 0 ? row.lane : parentRow.lane, parentIndex === 0 ? row.nodeRef : parentRow.nodeRef),
        diagonal,
      });
    });
  });
  return edges.sort((left, right) => Number(left.diagonal) - Number(right.diagonal));
});

type RevisionSelection = {
  key: string;
  revision: string;
  label: string;
};

function refSelection(refItem: DoltRef): RevisionSelection {
  return { key: `${refItem.kind}:${refItem.name}`, revision: refItem.name, label: refItem.name };
}

function commitSelection(commit: DoltCommit): RevisionSelection {
  return { key: `commit:${commit.hash}`, revision: commit.hash, label: `${shortHash(commit.hash)} ${commit.message || t("doltVersionControl.noMessage")}` };
}

function workingTreeSelection(): RevisionSelection {
  return { key: "working", revision: "WORKING", label: t("doltVersionControl.workingTree") };
}

function selectionForKey(key: string): RevisionSelection | undefined {
  if (key === "working") return showWorkingTree.value ? workingTreeSelection() : undefined;
  if (key.startsWith("commit:")) {
    const hash = key.slice("commit:".length);
    const commit = commits.value.find((item) => item.hash === hash);
    return commit ? commitSelection(commit) : undefined;
  }
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const name = key.slice(separator + 1);
  const refItem = allRefs.value.find((item) => item.kind === kind && item.name === name);
  return refItem ? refSelection(refItem) : undefined;
}

const selectedRevisions = computed(() => selectedRevisionKeys.value.map(selectionForKey).filter((item): item is RevisionSelection => !!item));

function revisionLabel(revision: string): string {
  if (!revision) return t("doltVersionControl.noRevision");
  if (revision === "WORKING") return t("doltVersionControl.workingTree");
  const refItem = allRefs.value.find((item) => item.name === revision);
  if (refItem) return refItem.name;
  const commit = commits.value.find((item) => item.hash === revision || item.hash.startsWith(revision) || revision.startsWith(item.hash));
  return commit ? `${shortHash(commit.hash)} ${commit.message || t("doltVersionControl.noMessage")}` : shortHash(revision);
}

async function updateModifiedSelection(selection: RevisionSelection) {
  const next = [...selectedRevisionKeys.value];
  const existingIndex = next.indexOf(selection.key);
  if (existingIndex >= 0) next.splice(existingIndex, 1);
  else if (next.length >= 2) next.splice(0, 1, selection.key);
  else next.push(selection.key);
  selectedRevisionKeys.value = next;
  const selected = next.map(selectionForKey).filter((item): item is RevisionSelection => !!item);
  if (selected.length === 2) await loadComparison(selected[0].revision, selected[1].revision);
}

async function query(sql: string, maxRows = 1000): Promise<QueryResult> {
  return api.executeQuery(props.connectionId, activeDatabase.value, sql, undefined, undefined, { maxRows, timeoutSecs: 30, clientSessionId: clientSessionId.value });
}

function workspaceTab() {
  return queryStore.tabs.find((candidate) => candidate.id === queryStore.activeTabId && candidate.mode === "dolt-version-control" && candidate.connectionId === props.connectionId);
}

function syncWorkspaceBranch(branch: string) {
  const tab = workspaceTab();
  if (tab && tab.workspaceBranch !== branch) tab.workspaceBranch = branch || undefined;
}

function firstCell(result: QueryResult): string {
  return String(result.rows[0]?.[0] ?? "");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function refresh() {
  const generation = ++loadGeneration;
  comparisonGeneration += 1;
  tableDiffGeneration += 1;
  comparisonLoading.value = false;
  tableDiffLoading.value = false;
  loading.value = true;
  error.value = "";
  try {
    const activeResult = await query("SELECT ACTIVE_BRANCH()", 1);
    if (generation !== loadGeneration) return;
    activeBranch.value = firstCell(activeResult);
    syncWorkspaceBranch(activeBranch.value);
    const [branchResult, tagResult, statusResult] = await Promise.all([query("SELECT * FROM dolt_branches ORDER BY name", 1000), query("SELECT * FROM dolt_tags ORDER BY tag_name", 1000).catch(() => null), query(doltStatusSql(), 1000).catch(() => null)]);
    if (generation !== loadGeneration) return;
    branches.value = parseDoltBranches(branchResult, activeBranch.value);
    tags.value = tagResult ? parseDoltTags(tagResult) : [];
    workingChanges.value = statusResult ? parseDoltStatus(statusResult) : [];
    const availableRefs = new Set(allRefs.value.map((item) => item.name));
    selectedRef.value = availableRefs.has(selectedRef.value) ? selectedRef.value : activeBranch.value || branches.value[0]?.name || "--all";
    selectedRevisionKeys.value = [];
    await loadGraph(selectedRef.value, generation);
    if (generation === loadGeneration) await loadComparison("HEAD", "WORKING");
  } catch (value) {
    if (generation === loadGeneration) error.value = errorMessage(value);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function clearDatabaseContext() {
  loadGeneration += 1;
  comparisonGeneration += 1;
  tableDiffGeneration += 1;
  activeBranch.value = "";
  branches.value = [];
  tags.value = [];
  commits.value = [];
  workingChanges.value = [];
  selectedRef.value = "";
  selectedRevisionKeys.value = [];
  comparedFrom.value = "";
  comparedTo.value = "";
  changes.value = [];
  selectedTableName.value = "";
  tableDiff.value = null;
  comparisonError.value = "";
  tableDiffError.value = "";
  clearDiffCellInteraction();
}

async function loadDatabaseOptions() {
  databaseLoading.value = true;
  try {
    const names = [...new Set((await api.listDatabases(props.connectionId)).map((item) => baseDatabaseName(item.name)).filter((name) => name && !name.includes("/")))].sort((left, right) => left.localeCompare(right, locale.value, { sensitivity: "base" }));
    if (selectedDatabase.value && !names.includes(selectedDatabase.value)) names.unshift(selectedDatabase.value);
    databaseOptions.value = filterDatabaseNamesForVisiblePicker(names, connectionStore.getConfig(props.connectionId));
  } catch {
    databaseOptions.value = selectedDatabase.value ? [selectedDatabase.value] : [];
  } finally {
    databaseLoading.value = false;
  }
}

function refreshDatabaseOptionsOnOpen(open: boolean) {
  if (open && !databaseLoading.value && !databaseSwitching.value) void loadDatabaseOptions();
}

function switchDatabase(database: unknown) {
  if (typeof database !== "string" || !database || database === activeDatabase.value) return;
  const previousSession = doltClientSessionScope(props.connectionId, activeDatabase.value);
  databaseSwitching.value = true;
  clearDatabaseContext();
  selectedDatabase.value = database;
  const tab = workspaceTab();
  if (tab) {
    tab.workspaceBranch = undefined;
    queryStore.updateDatabase(tab.id, database);
  } else void reloadDatabaseContext(database, undefined, previousSession);
}

async function reloadDatabaseContext(database: string, requestedBranch = props.initialBranch, previousSession?: DoltClientSessionScope) {
  const generation = ++databaseSwitchGeneration;
  const targetDatabase = baseDatabaseName(database);
  const resetCurrentDatabaseSession = !requestedBranch && activeBranch.value && activeDatabase.value === targetDatabase;
  selectedDatabase.value = targetDatabase;
  try {
    if (previousSession) {
      await api.closeClientConnectionSession(previousSession.connectionId, previousSession.database, previousSession.clientSessionId).catch(() => undefined);
    } else if (resetCurrentDatabaseSession) {
      await api.closeClientConnectionSession(props.connectionId, targetDatabase, clientSessionId.value).catch(() => undefined);
    }
    await loadDatabaseOptions();
    const branch = requestedBranch?.trim();
    if (branch) {
      const currentBranch = firstCell(await query("SELECT ACTIVE_BRANCH()", 1));
      if (currentBranch !== branch) await query(doltCheckoutBranchSql(branch), 10);
      selectedRef.value = branch;
    }
    await refresh();
  } catch (value) {
    if (generation === databaseSwitchGeneration) {
      error.value = errorMessage(value);
      syncWorkspaceBranch(activeBranch.value);
    }
  } finally {
    if (generation === databaseSwitchGeneration) databaseSwitching.value = false;
  }
}

async function loadGraph(revision: string, parentGeneration = ++loadGeneration) {
  graphLoading.value = true;
  error.value = "";
  try {
    let result: QueryResult;
    try {
      result = await query(doltLogSql(revision || "--all"), 500);
    } catch (value) {
      if (!activeBranch.value || revision === activeBranch.value) throw value;
      result = await query(doltLogSql(activeBranch.value), 500);
    }
    if (parentGeneration !== loadGeneration) return;
    commits.value = parseDoltCommits(result);
  } catch (value) {
    if (parentGeneration === loadGeneration) error.value = errorMessage(value);
  } finally {
    if (parentGeneration === loadGeneration) graphLoading.value = false;
  }
}

async function selectRef(refItem: DoltRef, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    await updateModifiedSelection(refSelection(refItem));
    return;
  }
  selectedRevisionKeys.value = [refSelection(refItem).key];
  if (selectedRef.value === refItem.name && commits.value.length) return;
  selectedRef.value = refItem.name;
  const generation = ++loadGeneration;
  await loadGraph(refItem.name, generation);
}

function toggleBranchTreePath(path: string) {
  const next = new Set(collapsedBranchPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedBranchPaths.value = next;
}

function toggleBranchTreeView() {
  branchTreeView.value = !branchTreeView.value;
}

function selectBranchTreeRow(row: BranchTreeRow, event: MouseEvent) {
  if (row.branch) void selectRef(row.branch, event);
  else if (row.folder) toggleBranchTreePath(row.key);
}

function branchTreeRowContextMenuItems(row: BranchTreeRow): ContextMenuItem[] {
  return row.branch ? branchContextMenuItems(row.branch) : [];
}

function openBranchTreeRowContextMenu(event: MouseEvent, row: BranchTreeRow, openMenu: (event: MouseEvent) => void) {
  if (row.branch) openRefContextMenu(event, row.branch, openMenu);
}

async function selectCommit(commit: DoltCommit, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    await updateModifiedSelection(commitSelection(commit));
    return;
  }
  selectedRevisionKeys.value = [commitSelection(commit).key];
  const parent = commit.parents[0];
  if (!parent) {
    comparisonGeneration += 1;
    tableDiffGeneration += 1;
    comparisonLoading.value = false;
    tableDiffLoading.value = false;
    comparedFrom.value = "";
    comparedTo.value = commit.hash;
    changes.value = [];
    selectedTableName.value = "";
    tableDiff.value = null;
    return;
  }
  await loadComparison(parent, commit.hash);
}

async function selectWorkingTree(event: MouseEvent) {
  const selection = workingTreeSelection();
  if (event.ctrlKey || event.metaKey) {
    await updateModifiedSelection(selection);
    return;
  }
  selectedRevisionKeys.value = [selection.key];
  await loadComparison("HEAD", "WORKING");
}

function openRefContextMenu(event: MouseEvent, refItem: DoltRef, openMenu: (event: MouseEvent) => void) {
  selectedRevisionKeys.value = [refSelection(refItem).key];
  openMenu(event);
}

function openCommitContextMenu(event: MouseEvent, commit: DoltCommit, openMenu: (event: MouseEvent) => void) {
  selectedRevisionKeys.value = [commitSelection(commit).key];
  openMenu(event);
}

async function loadComparison(fromRevision: string, toRevision: string) {
  if (!fromRevision || !toRevision || fromRevision === toRevision) return;
  const generation = ++comparisonGeneration;
  comparisonLoading.value = true;
  comparisonError.value = "";
  tableDiffError.value = "";
  comparedFrom.value = fromRevision;
  comparedTo.value = toRevision;
  changes.value = [];
  selectedTableName.value = "";
  tableDiff.value = null;
  try {
    const result = await query(doltDiffSummarySql(fromRevision, toRevision), 1000);
    if (generation !== comparisonGeneration) return;
    changes.value = parseDoltTableChanges(result);
    const first = changes.value[0];
    if (first) await loadTableDiff(first, generation);
  } catch (value) {
    if (generation === comparisonGeneration) comparisonError.value = errorMessage(value);
  } finally {
    if (generation === comparisonGeneration) comparisonLoading.value = false;
  }
}

async function swapComparison() {
  if (!comparedFrom.value || !comparedTo.value || comparisonLoading.value) return;
  if (selectedRevisions.value.length === 2 && selectedRevisions.value[0].revision === comparedFrom.value && selectedRevisions.value[1].revision === comparedTo.value) {
    selectedRevisionKeys.value = [...selectedRevisionKeys.value].reverse();
  }
  await loadComparison(comparedTo.value, comparedFrom.value);
}

async function selectComparisonRevision(side: "from" | "to", revision: string) {
  const normalized = revision.trim();
  if (!normalized) return;
  const fromRevision = side === "from" ? normalized : comparedFrom.value;
  const toRevision = side === "to" ? normalized : comparedTo.value;
  if (fromRevision === comparedFrom.value && toRevision === comparedTo.value) return;
  if (!fromRevision || !toRevision || fromRevision === toRevision) {
    comparisonGeneration += 1;
    tableDiffGeneration += 1;
    comparedFrom.value = fromRevision;
    comparedTo.value = toRevision;
    changes.value = [];
    selectedTableName.value = "";
    tableDiff.value = null;
    comparisonError.value = "";
    return;
  }
  selectedRevisionKeys.value = [];
  await loadComparison(fromRevision, toRevision);
}

function openCreateBranch(sourceRevision?: string) {
  if (connectionReadOnly.value) return;
  mutationError.value = "";
  branchNameDraft.value = "";
  branchSourceRevision.value = sourceRevision || selectedRevisions.value[0]?.revision || activeBranch.value || "HEAD";
  branchActionTarget.value = "";
  branchDialog.value = "create";
}

function openCreateTag(sourceRevision?: string) {
  if (connectionReadOnly.value) return;
  mutationError.value = "";
  branchNameDraft.value = "";
  branchSourceRevision.value = sourceRevision || selectedRevisions.value[0]?.revision || activeBranch.value || "HEAD";
  branchActionTarget.value = "";
  branchDialog.value = "create-tag";
}

function openMergeBranch(branch: DoltRef) {
  if (connectionReadOnly.value || branch.active) return;
  mutationError.value = "";
  branchActionTarget.value = branch.name;
  branchDialog.value = "merge";
}

function openDeleteBranch(branch: DoltRef) {
  if (connectionReadOnly.value || branch.active) return;
  mutationError.value = "";
  branchActionTarget.value = branch.name;
  branchDialog.value = "delete";
}

function openDeleteTag(tag: DoltRef) {
  if (connectionReadOnly.value) return;
  mutationError.value = "";
  branchActionTarget.value = tag.name;
  branchDialog.value = "delete-tag";
}

async function runRefMutation(sql: string, successMessage: string, options: { selectedRefAfter?: string } = {}): Promise<boolean> {
  if (connectionReadOnly.value || mutationLoading.value) return false;
  mutationLoading.value = true;
  mutationError.value = "";
  try {
    await query(sql, 10);
    toast(successMessage, 3000);
    // Version-control mutations can change both visible metadata and active
    // branch decorations in the connection tree.
    await connectionStore.refreshDatabaseTreeNode(props.connectionId, activeDatabase.value).catch(() => undefined);
    if (options.selectedRefAfter) selectedRef.value = options.selectedRefAfter;
    await refresh();
    return true;
  } catch (value) {
    mutationError.value = errorMessage(value);
    toast(mutationError.value, 5000);
    return false;
  } finally {
    mutationLoading.value = false;
  }
}

function compareWithCurrent(refItem: DoltRef) {
  if (!activeBranch.value || refItem.active) return;
  void loadComparison(activeBranch.value, refItem.name);
}

async function checkoutBranch(branch: DoltRef) {
  if (branch.active || branchSwitchingTarget.value) return;
  branchSwitchingTarget.value = branch.name;
  try {
    await runRefMutation(doltCheckoutBranchSql(branch.name), t("doltVersionControl.branchCheckedOut", { name: branch.name }), { selectedRefAfter: branch.name });
  } finally {
    branchSwitchingTarget.value = "";
  }
}

function switchBranch(branchName: unknown) {
  if (typeof branchName !== "string" || !branchName || branchName === activeBranch.value) return;
  const branch = branches.value.find((item) => item.name === branchName);
  if (branch) void checkoutBranch(branch);
}

async function copyCommitHash(commit: DoltCommit) {
  try {
    await navigator.clipboard.writeText(commit.hash);
    toast(t("doltVersionControl.hashCopied"), 2000);
  } catch (value) {
    toast(errorMessage(value), 5000);
  }
}

async function stageWorkingTree() {
  await runRefMutation(doltAddAllSql(), t("doltVersionControl.changesStaged"));
}

function openCommitDialog() {
  if (connectionReadOnly.value || mutationLoading.value || workingChanges.value.length === 0) return;
  commitMessageDraft.value = "";
  commitError.value = "";
  commitDialogOpen.value = true;
}

function closeCommitDialog() {
  if (mutationLoading.value) return;
  commitDialogOpen.value = false;
  commitMessageDraft.value = "";
  commitError.value = "";
}

async function submitWorkingTreeCommit() {
  const message = commitMessageDraft.value.trim();
  if (!message) {
    commitError.value = t("doltVersionControl.commitMessageRequired");
    return;
  }
  if (connectionReadOnly.value || mutationLoading.value) return;
  mutationLoading.value = true;
  commitError.value = "";
  try {
    await query(doltAddAllSql(), 10);
    await query(doltCommitSql(message), 10);
    commitDialogOpen.value = false;
    commitMessageDraft.value = "";
    toast(t("doltVersionControl.workingTreeCommitted"), 3000);
    await connectionStore.refreshDatabaseTreeNode(props.connectionId, activeDatabase.value).catch(() => undefined);
    await refresh();
  } catch (value) {
    commitError.value = errorMessage(value);
  } finally {
    mutationLoading.value = false;
  }
}

function openDiscardWorkingTreeDialog() {
  if (connectionReadOnly.value || mutationLoading.value || workingChanges.value.length === 0) return;
  discardWorkingTreeError.value = "";
  discardWorkingTreeDialogOpen.value = true;
}

function closeDiscardWorkingTreeDialog() {
  if (mutationLoading.value) return;
  discardWorkingTreeDialogOpen.value = false;
  discardWorkingTreeError.value = "";
}

async function submitDiscardWorkingTree() {
  if (!discardWorkingTreeDialogOpen.value || mutationLoading.value || connectionReadOnly.value) return;
  const succeeded = await runRefMutation(doltDiscardWorkingTreeSql(), t("doltVersionControl.discardWorkingTreeComplete"), { selectedRefAfter: activeBranch.value });
  if (succeeded) closeDiscardWorkingTreeDialog();
  else {
    discardWorkingTreeError.value = mutationError.value;
    mutationError.value = "";
  }
}

function workingTreeContextMenuItems(): ContextMenuItem[] {
  return [
    { label: t("doltVersionControl.stageAllChanges"), icon: Check, disabled: connectionReadOnly.value || mutationLoading.value || unstagedWorkingChangeCount.value === 0, action: () => void stageWorkingTree() },
    { label: t("doltVersionControl.commitWorkingTree"), icon: GitCommitHorizontal, disabled: connectionReadOnly.value || mutationLoading.value || workingChanges.value.length === 0, action: openCommitDialog },
    { separator: true, label: "" },
    { label: t("doltVersionControl.discardWorkingTree"), icon: RotateCcw, variant: "destructive", disabled: connectionReadOnly.value || mutationLoading.value || workingChanges.value.length === 0, action: openDiscardWorkingTreeDialog },
  ];
}

function openWorkingTreeContextMenu(event: MouseEvent, openMenu: (event: MouseEvent) => void) {
  selectedRevisionKeys.value = [workingTreeSelection().key];
  openMenu(event);
}

function branchContextMenuItems(branch: DoltRef): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (branch.kind === "branch") {
    items.push(
      { label: t("doltVersionControl.compareCurrent"), icon: GitPullRequest, disabled: branch.active, action: () => compareWithCurrent(branch) },
      { label: t("doltVersionControl.checkoutBranch"), icon: GitBranch, disabled: connectionReadOnly.value || branch.active, action: () => void checkoutBranch(branch) },
    );
  }
  items.push(
    { separator: true, label: "" },
    { label: t("doltVersionControl.createBranch"), icon: Plus, disabled: connectionReadOnly.value, action: () => openCreateBranch(branch.name) },
    { label: t("doltVersionControl.createTag"), icon: Tag, disabled: connectionReadOnly.value, action: () => openCreateTag(branch.name) },
  );
  if (branch.kind === "branch") {
    items.push(
      { separator: true, label: "" },
      { label: t("doltVersionControl.mergeBranch"), icon: GitMerge, disabled: connectionReadOnly.value || branch.active, action: () => openMergeBranch(branch) },
      { label: t("doltVersionControl.deleteBranch"), icon: Trash2, variant: "destructive", disabled: connectionReadOnly.value || branch.active, action: () => openDeleteBranch(branch) },
    );
  } else {
    items.push({ label: t("doltVersionControl.deleteTag"), icon: Trash2, variant: "destructive", disabled: connectionReadOnly.value, action: () => openDeleteTag(branch) });
  }
  return items;
}

function refContextMenuItems(refItem: DoltRef): ContextMenuItem[] {
  return branchContextMenuItems(refItem);
}

function commitContextMenuItems(commit: DoltCommit): ContextMenuItem[] {
  const activeHead = branches.value.find((branch) => branch.active)?.hash;
  const isCurrentHead = !!activeHead && (activeHead === commit.hash || activeHead.startsWith(commit.hash) || commit.hash.startsWith(activeHead));
  return [
    { label: t("doltVersionControl.copyHash"), icon: Clipboard, action: () => void copyCommitHash(commit) },
    { separator: true, label: "" },
    { label: t("doltVersionControl.createBranch"), icon: Plus, disabled: connectionReadOnly.value, action: () => openCreateBranch(commit.hash) },
    { label: t("doltVersionControl.createTag"), icon: Tag, disabled: connectionReadOnly.value, action: () => openCreateTag(commit.hash) },
    { separator: true, label: "" },
    { label: t("doltVersionControl.revertCommit"), icon: Undo2, disabled: connectionReadOnly.value || mutationLoading.value, action: () => openCommitHistoryOperation("revert", commit) },
    { label: t("doltVersionControl.hardResetToCommit"), icon: RotateCcw, variant: "destructive", disabled: connectionReadOnly.value || mutationLoading.value || isCurrentHead, action: () => openCommitHistoryOperation("hard-reset", commit) },
  ];
}

function openCommitHistoryOperation(operation: "revert" | "hard-reset", commit: DoltCommit) {
  if (connectionReadOnly.value || mutationLoading.value) return;
  commitHistoryOperation.value = operation;
  commitHistoryTarget.value = commit;
  commitHistoryError.value = "";
  mutationError.value = "";
}

function closeCommitHistoryDialog() {
  if (mutationLoading.value) return;
  commitHistoryOperation.value = null;
  commitHistoryTarget.value = null;
  commitHistoryError.value = "";
}

async function submitCommitHistoryOperation() {
  const operation = commitHistoryOperation.value;
  const commit = commitHistoryTarget.value;
  if (!operation || !commit || mutationLoading.value || connectionReadOnly.value) return;
  const succeeded = await runRefMutation(operation === "hard-reset" ? doltHardResetSql(commit.hash) : doltRevertCommitSql(commit.hash), t(operation === "hard-reset" ? "doltVersionControl.hardResetComplete" : "doltVersionControl.revertCommitComplete", { hash: shortHash(commit.hash) }), {
    selectedRefAfter: activeBranch.value,
  });
  if (succeeded) closeCommitHistoryDialog();
  else {
    commitHistoryError.value = mutationError.value;
    mutationError.value = "";
  }
}

function closeBranchDialog() {
  if (mutationLoading.value) return;
  branchDialog.value = null;
  branchActionTarget.value = "";
  mutationError.value = "";
}

async function submitBranchOperation() {
  if (!branchDialog.value || mutationLoading.value || connectionReadOnly.value) return;
  const operation = branchDialog.value;
  const branchName = branchNameDraft.value.trim();
  const sourceBranch = branchActionTarget.value;
  if (createsNamedRef.value && !branchName) {
    mutationError.value = t(operation === "create-tag" ? "doltVersionControl.tagNameRequired" : "doltVersionControl.branchNameRequired");
    return;
  }
  if ((operation === "merge" || operation === "delete" || operation === "delete-tag") && !sourceBranch) return;
  mutationLoading.value = true;
  mutationError.value = "";
  try {
    const sql =
      operation === "create"
        ? doltCreateBranchSql(branchName, branchSourceRevision.value)
        : operation === "create-tag"
          ? doltCreateTagSql(branchName, branchSourceRevision.value)
          : operation === "merge"
            ? doltMergeBranchSql(sourceBranch)
            : operation === "delete-tag"
              ? doltDeleteTagSql(sourceBranch)
              : doltDeleteBranchSql(sourceBranch);
    await query(sql, 10);
    const message =
      operation === "create"
        ? t("doltVersionControl.branchCreated", { name: branchName })
        : operation === "create-tag"
          ? t("doltVersionControl.tagCreated", { name: branchName })
          : operation === "merge"
            ? t("doltVersionControl.branchMerged", { name: sourceBranch })
            : operation === "delete-tag"
              ? t("doltVersionControl.tagDeleted", { name: sourceBranch })
              : t("doltVersionControl.branchDeleted", { name: sourceBranch });
    branchDialog.value = null;
    branchActionTarget.value = "";
    toast(message, 3000);
    await refresh();
  } catch (value) {
    mutationError.value = errorMessage(value);
  } finally {
    mutationLoading.value = false;
  }
}

async function loadTableDiff(change: DoltTableChange, parentGeneration = comparisonGeneration, options: { page?: number; countTotal?: boolean } = {}) {
  const generation = ++tableDiffGeneration;
  const tableChanged = selectedTableName.value !== change.tableName || !tableDiff.value;
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const requestedPageSize = tableDiffPageSize.value;
  const requestedOffset = (requestedPage - 1) * requestedPageSize;
  const countTotal = options.countTotal ?? tableChanged;
  selectedTableName.value = change.tableName;
  tableDiffLoading.value = true;
  tableDiffError.value = "";
  if (tableChanged) {
    tableDiff.value = null;
    tableDiffPage.value = 1;
    tableDiffTotalRows.value = 0;
    diffColumnWidths.value = [];
    diffColumnWidthReports = {};
    diffColumnWidthsReady.value = false;
  }
  try {
    const resultRequest = query(doltTableDiffSql(comparedFrom.value, comparedTo.value, change.tableName, requestedPageSize, requestedOffset), requestedPageSize);
    const [result, countResult] = countTotal ? await Promise.all([resultRequest, query(doltTableDiffCountSql(comparedFrom.value, comparedTo.value, change.tableName), 1)]) : [await resultRequest, null];
    if (generation !== tableDiffGeneration || parentGeneration !== comparisonGeneration) return;
    tableDiff.value = result;
    tableDiffPage.value = requestedPage;
    if (countResult) {
      const count = Number(firstCell(countResult));
      tableDiffTotalRows.value = Number.isSafeInteger(count) && count >= 0 ? count : result.rows.length;
    }
  } catch (value) {
    if (generation === tableDiffGeneration && parentGeneration === comparisonGeneration) tableDiffError.value = errorMessage(value);
  } finally {
    if (generation === tableDiffGeneration) tableDiffLoading.value = false;
  }
}

function loadTableDiffPage(page: number) {
  const change = selectedChange.value;
  if (!change || tableDiffLoading.value) return;
  const normalizedPage = Math.min(tableDiffMaximumPage.value, Math.max(1, Math.floor(page)));
  if (normalizedPage === tableDiffPage.value) return;
  void loadTableDiff(change, comparisonGeneration, { page: normalizedPage, countTotal: false });
}

function changeTableDiffPageSize(value: unknown) {
  const parsed = Number(value);
  const size = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : tableDiffPageSize.value;
  if (size === tableDiffPageSize.value) return;
  tableDiffPageSize.value = size;
  const change = selectedChange.value;
  if (change) void loadTableDiff(change, comparisonGeneration, { page: 1, countTotal: false });
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

function formatDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale.value, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function laneX(lane: number): number {
  return 18 + lane * 18;
}

function rowY(row: number): number {
  return row * COMMIT_ROW_HEIGHT + COMMIT_ROW_HEIGHT / 2;
}

function commitRowY(commitIndex: number): number {
  return rowY(commitIndex + graphRowOffset.value);
}

function graphColor(lane: number, refName?: string | null): string {
  const colorIndex = refName ? graphRefColorIndexes.value.get(refName) : undefined;
  return GRAPH_COLORS[colorIndex ?? ((lane % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];
}

function refBadgeStyle(refItem: DoltRef): Record<string, string> {
  return { "--dolt-ref-color": graphColor(0, refItem.name) };
}

function changeKindClass(change: DoltTableChange): string {
  return `dolt-change-${doltTableChangeKind(change)}`;
}

function changeFlags(change: DoltTableChange): DoltTableChangeFlag[] {
  return doltTableChangeFlags(change);
}

function changeFlagSymbol(flag: DoltTableChangeFlag): string {
  if (flag === "data") return "D";
  if (flag === "schema") return "S";
  return "M";
}

function changeFlagTitle(flag: DoltTableChangeFlag, change: DoltTableChange): string {
  if (flag === "data") return t("history.kindShort.data_change");
  if (flag === "schema") return t("history.kindShort.schema_change");
  return change.diffType || t("doltVersionControl.changedTables");
}

function changeFlagsTitle(change: DoltTableChange): string {
  return changeFlags(change)
    .map((flag) => changeFlagTitle(flag, change))
    .join(" + ");
}

function clearDiffCellInteraction() {
  selectedDiffCell.value = null;
  diffCellContextTarget.value = null;
  diffCellDetailTarget.value = null;
  diffCellDetailOpen.value = false;
}

function selectDiffCell(target: DoltDiffCellTarget) {
  if (tableDiffLoading.value) return;
  selectedDiffCell.value = target;
}

function openDiffCellDetails(target: DoltDiffCellTarget) {
  if (tableDiffLoading.value) return;
  selectedDiffCell.value = target;
  diffCellDetailTarget.value = { ...target };
  diffCellDetailOpen.value = true;
}

function openDiffCellContextMenu(target: DoltDiffCellTarget, event: MouseEvent, openMenu: (event: MouseEvent) => void) {
  event.preventDefault();
  if (tableDiffLoading.value) return;
  selectedDiffCell.value = target;
  diffCellContextTarget.value = { ...target };
  openMenu(event);
}

async function copyDiffCellValue(side: DoltCellSide) {
  const target = diffCellContextTarget.value;
  if (!target) return;
  const value = doltCellCopyText(target, side);
  if (value === null) return;
  try {
    await copyToClipboard(value);
    toast(t("doltVersionControl.cellValueCopied"), 2000);
  } catch (error) {
    toast(errorMessage(error), 5000);
  }
}

function diffCellContextMenuItems(): ContextMenuItem[] {
  const target = diffCellContextTarget.value;
  if (!target) return [];
  return [
    { label: t("doltVersionControl.copyCurrentValue"), icon: Clipboard, disabled: doltCellCopyText(target, target.side) === null, action: () => void copyDiffCellValue(target.side) },
    { label: t("doltVersionControl.copyBeforeValue"), icon: Clipboard, disabled: doltCellCopyText(target, "before") === null, action: () => void copyDiffCellValue("before") },
    { label: t("doltVersionControl.copyAfterValue"), icon: Clipboard, disabled: doltCellCopyText(target, "after") === null, action: () => void copyDiffCellValue("after") },
    { label: "", separator: true },
    { label: t("doltVersionControl.viewCellDiff"), icon: FileDiff, action: () => openDiffCellDetails(target) },
  ];
}

function diffCellClass(side: "before" | "after", rowIndex: number, columnIndex: number): string | undefined {
  const row = parsedTableDiff.value.rows[rowIndex];
  const column = parsedTableDiff.value.columns[columnIndex];
  const columnKind = parsedTableDiff.value.columnKinds[columnIndex];
  if (!row || !column) return undefined;
  if (columnKind === "added") return side === "after" ? "dolt-grid-cell-added" : "dolt-grid-cell-structural-missing";
  if (columnKind === "removed") return side === "before" ? "dolt-grid-cell-removed" : "dolt-grid-cell-structural-missing";
  if (!row.changedColumns.includes(column)) return undefined;
  if (row.kind === "added") return "dolt-grid-cell-added";
  if (row.kind === "removed") return "dolt-grid-cell-removed";
  return "dolt-grid-cell-modified";
}

function diffHeaderClass(side: "before" | "after", columnIndex: number): string | undefined {
  const kind = parsedTableDiff.value.columnKinds[columnIndex];
  if (kind === "added") return side === "after" ? "dolt-grid-header-added" : "dolt-grid-header-added-missing";
  if (kind === "removed") return side === "before" ? "dolt-grid-header-removed" : "dolt-grid-header-removed-missing";
  return undefined;
}

function syncDiffColumnWidths(side: "before" | "after", widths: number[]) {
  if (widths.length !== parsedTableDiff.value.columns.length) return;
  if (!diffColumnWidthsReady.value) {
    diffColumnWidthReports[side] = [...widths];
    const before = diffColumnWidthReports.before;
    const after = diffColumnWidthReports.after;
    if (before && after) {
      diffColumnWidths.value = widths.map((_, index) => Math.max(before[index] ?? 0, after[index] ?? 0));
      diffColumnWidthsReady.value = true;
      return;
    }
  }
  if (diffColumnWidths.value.length === widths.length && widths.every((width, index) => Math.abs(width - (diffColumnWidths.value[index] ?? 0)) < 0.5)) return;
  diffColumnWidths.value = [...widths];
}

function bindDiffScrollSync() {
  detachDiffScrollSync?.();
  detachDiffScrollSync = undefined;
  if (!tableDiff.value) {
    diffScrollSyncRetry = 0;
    if (diffScrollSyncRetryTimer) window.clearTimeout(diffScrollSyncRetryTimer);
    diffScrollSyncRetryTimer = 0;
    return;
  }
  const beforeScroller = beforeDiffSide.value?.querySelector<HTMLElement>(".dolt-diff-table-scroller");
  const afterScroller = afterDiffSide.value?.querySelector<HTMLElement>(".dolt-diff-table-scroller");
  if (!beforeScroller || !afterScroller) {
    if (diffScrollSyncRetry < 5) {
      diffScrollSyncRetry += 1;
      diffScrollSyncRetryTimer = window.setTimeout(() => {
        diffScrollSyncRetryTimer = 0;
        scheduleDiffScrollSync();
      }, 50);
    }
    return;
  }
  diffScrollSyncRetry = 0;
  const sync = (source: HTMLElement, target: HTMLElement) => {
    if (diffScrollSyncing) return;
    const syncTop = Math.abs(target.scrollTop - source.scrollTop) >= 0.5;
    const syncLeft = Math.abs(target.scrollLeft - source.scrollLeft) >= 0.5;
    if (!syncTop && !syncLeft) return;
    diffScrollSyncing = true;
    if (syncTop) target.scrollTop = source.scrollTop;
    if (syncLeft) target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      diffScrollSyncing = false;
    });
  };
  const onBeforeScroll = () => sync(beforeScroller, afterScroller);
  const onAfterScroll = () => sync(afterScroller, beforeScroller);
  beforeScroller.addEventListener("scroll", onBeforeScroll, { passive: true });
  afterScroller.addEventListener("scroll", onAfterScroll, { passive: true });
  afterScroller.scrollTop = beforeScroller.scrollTop;
  afterScroller.scrollLeft = beforeScroller.scrollLeft;
  detachDiffScrollSync = () => {
    beforeScroller.removeEventListener("scroll", onBeforeScroll);
    afterScroller.removeEventListener("scroll", onAfterScroll);
  };
}

function scheduleDiffScrollSync() {
  if (diffScrollSyncFrame) cancelAnimationFrame(diffScrollSyncFrame);
  diffScrollSyncFrame = requestAnimationFrame(() => {
    diffScrollSyncFrame = 0;
    bindDiffScrollSync();
  });
}

watch(
  () => [props.connectionId, props.database, props.initialBranch] as const,
  ([connectionId, database, branch], [previousConnectionId, previousDatabase, previousBranch]) => {
    const databaseChanged = connectionId !== previousConnectionId || database !== previousDatabase;
    const branchTargetChanged = branch !== previousBranch && branch !== activeBranch.value;
    const previousSession = databaseChanged ? doltClientSessionScope(previousConnectionId, baseDatabaseName(previousDatabase)) : undefined;
    if (databaseChanged || branchTargetChanged) void reloadDatabaseContext(database, branch, previousSession);
  },
);

watch(
  () => [tableDiff.value, selectedTableName.value],
  () => scheduleDiffScrollSync(),
  { flush: "post" },
);

watch(
  () => [diffGridScopeKey.value, tableDiffPage.value],
  () => clearDiffCellInteraction(),
);

onMounted(() => {
  selectedDatabase.value = baseDatabaseName(props.database);
  const tab = workspaceTab();
  if (tab && tab.database !== selectedDatabase.value) queryStore.updateDatabase(tab.id, selectedDatabase.value);
  void reloadDatabaseContext(props.database, props.initialBranch);
  scheduleDiffScrollSync();
});

onUnmounted(() => {
  if (diffScrollSyncFrame) cancelAnimationFrame(diffScrollSyncFrame);
  if (diffScrollSyncRetryTimer) window.clearTimeout(diffScrollSyncRetryTimer);
  detachDiffScrollSync?.();
  void api.closeClientConnectionSession(props.connectionId, activeDatabase.value, clientSessionId.value).catch(() => undefined);
});
</script>

<template>
  <div class="dolt-workspace flex h-full min-h-0 flex-col bg-background text-foreground">
    <header class="flex h-10 shrink-0 items-center gap-2 border-b px-2">
      <div class="dolt-scope-selectors">
        <Select :model-value="activeDatabase" :disabled="databaseLoading || databaseSwitching || mutationLoading || databaseOptions.length < 2" @update:model-value="switchDatabase" @update:open="refreshDatabaseOptionsOnOpen">
          <SelectTrigger size="sm" class="dolt-scope-trigger dolt-scope-trigger-database" :title="activeDatabase" :aria-label="t('doltVersionControl.switchDatabase')">
            <Loader2 v-if="databaseLoading || databaseSwitching" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <Database v-else class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <SelectValue :placeholder="activeDatabase" />
          </SelectTrigger>
          <SelectContent class="max-h-72">
            <SelectItem v-for="databaseName in databaseOptions" :key="databaseName" :value="databaseName" class="text-xs">{{ databaseName }}</SelectItem>
          </SelectContent>
        </Select>
        <span class="shrink-0 text-xs text-muted-foreground/60">/</span>
        <Select :model-value="activeBranch" :disabled="loading || databaseSwitching || mutationLoading || connectionReadOnly || branches.length < 2" @update:model-value="switchBranch">
          <SelectTrigger size="sm" class="dolt-scope-trigger dolt-scope-trigger-branch" :title="activeBranch || t('doltVersionControl.unknownBranch')" :aria-label="t('doltVersionControl.switchBranch')">
            <Loader2 v-if="branchSwitchingTarget" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <GitBranch v-else class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            <SelectValue :placeholder="activeBranch || t('doltVersionControl.unknownBranch')" />
          </SelectTrigger>
          <SelectContent class="max-h-72">
            <SelectItem v-for="branch in branches" :key="branch.name" :value="branch.name" class="text-xs">{{ branch.name }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="ml-auto flex min-w-0 max-w-full items-center gap-1.5">
        <div class="dolt-comparison-controls" :title="t('doltVersionControl.comparison')">
          <DoltRevisionSelector :model-value="comparedFrom" :options="allRefs" :disabled="comparisonLoading" :placeholder="t('doltVersionControl.noRevision')" :input-label="t('doltVersionControl.comparison')" @commit="selectComparisonRevision('from', $event)" />
          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="comparisonLoading || !comparedFrom || !comparedTo" :title="t('doltVersionControl.swapComparison')" :aria-label="t('doltVersionControl.swapComparison')" @click="swapComparison">
            <ArrowRight class="h-3.5 w-3.5" />
          </Button>
          <DoltRevisionSelector :model-value="comparedTo" :options="allRefs" :disabled="comparisonLoading" :placeholder="t('doltVersionControl.noRevision')" :input-label="t('doltVersionControl.comparison')" @commit="selectComparisonRevision('to', $event)" />
        </div>
        <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="loading" :title="t('common.refresh')" :aria-label="t('common.refresh')" @click="refresh">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>

    <div v-if="error" class="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</div>

    <Splitpanes horizontal class="dolt-main-splitpanes min-h-0 flex-1">
      <Pane :size="64" :min-size="38">
        <Splitpanes class="dolt-diff-splitpanes h-full min-h-0">
          <Pane :size="doltLeftPaneSize" :min-size="DOLT_LEFT_PANE_MIN_SIZE" :max-size="DOLT_LEFT_PANE_MAX_SIZE">
            <section class="flex h-full min-h-0 flex-col">
              <div class="flex h-8 shrink-0 items-center gap-1.5 border-b px-2 text-xs font-medium">
                <FileDiff class="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span class="truncate">{{ t("doltVersionControl.changedTables") }}</span>
                <span v-if="changes.length" class="ml-auto text-[11px] text-muted-foreground">{{ changes.length }}</span>
              </div>
              <DoltScrollArea class="min-h-0 flex-1">
                <div v-if="comparisonLoading && changes.length === 0" class="flex h-24 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("doltVersionControl.loadingDiff") }}</div>
                <div v-else-if="comparisonError" class="p-3 text-xs text-destructive">{{ comparisonError }}</div>
                <div v-else-if="changes.length === 0" class="flex h-24 items-center justify-center px-3 text-center text-xs text-muted-foreground">{{ t("doltVersionControl.noChanges") }}</div>
                <button v-for="change in changes" :key="`${change.fromTableName}-${change.toTableName}`" type="button" class="dolt-change-row" :class="{ 'dolt-change-row-active': selectedTableName === change.tableName }" :title="changeFlagsTitle(change)" @click="loadTableDiff(change)">
                  <span class="dolt-change-symbol" :class="changeKindClass(change)" aria-hidden="true">{{ doltTableChangeSymbol(change) }}</span>
                  <Table2 class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span class="min-w-0 flex-1 truncate">{{ change.tableName }}</span>
                  <span v-if="changeFlags(change).length" class="dolt-change-flags" :aria-label="changeFlagsTitle(change)">
                    <span v-for="flag in changeFlags(change)" :key="flag" class="dolt-change-flag">{{ changeFlagSymbol(flag) }}</span>
                  </span>
                </button>
              </DoltScrollArea>
            </section>
          </Pane>

          <Pane :size="100 - doltLeftPaneSize" :min-size="100 - DOLT_LEFT_PANE_MAX_SIZE">
            <section class="flex h-full min-h-0 flex-col">
              <div class="flex h-8 shrink-0 items-center gap-1.5 border-b px-2 text-xs font-medium">
                <Table2 class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span class="truncate">{{ selectedChange?.tableName || t("doltVersionControl.rowDiff") }}</span>
                <Loader2 v-if="tableDiffLoading && tableDiff" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
              </div>
              <div v-if="tableDiffError && tableDiff" class="shrink-0 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{{ tableDiffError }}</div>
              <div class="min-h-0 flex-1 overflow-hidden">
                <div v-if="tableDiffLoading && !tableDiff" class="flex h-24 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("doltVersionControl.loadingRows") }}</div>
                <div v-else-if="tableDiffError && !tableDiff" class="p-3 text-xs text-destructive">{{ tableDiffError }}</div>
                <div v-else-if="!selectedChange" class="flex h-24 items-center justify-center text-xs text-muted-foreground">{{ t("doltVersionControl.selectTable") }}</div>
                <div v-else-if="!tableDiff || parsedTableDiff.columns.length === 0" class="flex h-24 items-center justify-center text-xs text-muted-foreground">{{ t("doltVersionControl.noRowChanges") }}</div>
                <div v-else class="dolt-diff-result">
                  <CustomContextMenu :items="diffCellContextMenuItems" v-slot="{ onContextMenu }">
                    <div class="dolt-diff-pair-grid">
                      <section ref="beforeDiffSide" class="dolt-diff-side">
                        <div class="dolt-diff-side-header">{{ revisionLabel(comparedFrom) }}</div>
                        <DoltDiffTable
                          :key="`before:${diffGridScopeKey}`"
                          :columns="parsedTableDiff.columns"
                          :column-kinds="parsedTableDiff.columnKinds"
                          :rows="parsedTableDiff.rows"
                          side="before"
                          :selected-cell="selectedDiffCell"
                          :column-widths="diffColumnWidthsReady ? diffColumnWidths : undefined"
                          :cell-class="(rowIndex: number, columnIndex: number) => diffCellClass('before', rowIndex, columnIndex)"
                          :header-class="(columnIndex: number) => diffHeaderClass('before', columnIndex)"
                          @column-widths-change="(widths: number[]) => syncDiffColumnWidths('before', widths)"
                          @cell-select="selectDiffCell"
                          @cell-context-menu="(target: DoltDiffCellTarget, event: MouseEvent) => openDiffCellContextMenu(target, event, onContextMenu)"
                          @cell-open-details="openDiffCellDetails"
                        />
                      </section>
                      <section ref="afterDiffSide" class="dolt-diff-side">
                        <div class="dolt-diff-side-header">{{ revisionLabel(comparedTo) }}</div>
                        <DoltDiffTable
                          :key="`after:${diffGridScopeKey}`"
                          :columns="parsedTableDiff.columns"
                          :column-kinds="parsedTableDiff.columnKinds"
                          :rows="parsedTableDiff.rows"
                          side="after"
                          :selected-cell="selectedDiffCell"
                          :column-widths="diffColumnWidthsReady ? diffColumnWidths : undefined"
                          :cell-class="(rowIndex: number, columnIndex: number) => diffCellClass('after', rowIndex, columnIndex)"
                          :header-class="(columnIndex: number) => diffHeaderClass('after', columnIndex)"
                          @column-widths-change="(widths: number[]) => syncDiffColumnWidths('after', widths)"
                          @cell-select="selectDiffCell"
                          @cell-context-menu="(target: DoltDiffCellTarget, event: MouseEvent) => openDiffCellContextMenu(target, event, onContextMenu)"
                          @cell-open-details="openDiffCellDetails"
                        />
                      </section>
                    </div>
                  </CustomContextMenu>
                  <DoltDiffPagination :current-page="tableDiffPage" :page-size="tableDiffPageSize" :total-rows="tableDiffTotalRows" :loading="tableDiffLoading" @page-change="loadTableDiffPage" @page-size-change="changeTableDiffPageSize" />
                </div>
              </div>
            </section>
          </Pane>
        </Splitpanes>
      </Pane>

      <Pane :size="36" :min-size="22">
        <Splitpanes class="dolt-history-splitpanes h-full min-h-0">
          <Pane :size="doltLeftPaneSize" :min-size="DOLT_LEFT_PANE_MIN_SIZE" :max-size="DOLT_LEFT_PANE_MAX_SIZE">
            <aside class="flex h-full min-h-0 flex-col bg-muted/10">
              <div class="flex items-center gap-1.5 border-b p-2">
                <div class="relative min-w-0 flex-1">
                  <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input v-model="refFilter" class="h-7 pl-7 text-xs" :placeholder="t('doltVersionControl.filterRefs')" />
                </div>
                <Button
                  v-if="refListTab === 'branches'"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7 shrink-0"
                  :title="t(branchTreeView ? 'doltVersionControl.branchFlatView' : 'doltVersionControl.branchTreeView')"
                  :aria-label="t(branchTreeView ? 'doltVersionControl.branchFlatView' : 'doltVersionControl.branchTreeView')"
                  @click="toggleBranchTreeView"
                >
                  <FolderOpen v-if="branchTreeView" class="h-3.5 w-3.5" />
                  <List v-else class="h-3.5 w-3.5" />
                </Button>
              </div>
              <Tabs v-model="refListTab" class="min-h-0 flex-1 gap-0">
                <div class="shrink-0 border-b px-2 pt-1">
                  <TabsList variant="line" class="h-7 w-full justify-start rounded-none bg-transparent p-0">
                    <TabsTrigger value="branches" class="h-7 gap-1 px-2 text-xs"
                      ><GitBranch class="h-3.5 w-3.5" />{{ t("doltVersionControl.branches") }}<span class="text-[10px] text-muted-foreground">{{ visibleBranches.length }}</span></TabsTrigger
                    >
                    <TabsTrigger value="tags" class="h-7 gap-1 px-2 text-xs"
                      ><Tag class="h-3.5 w-3.5" />{{ t("doltVersionControl.tags") }}<span class="text-[10px] text-muted-foreground">{{ visibleTags.length }}</span></TabsTrigger
                    >
                  </TabsList>
                </div>
                <TabsContent value="branches" class="m-0 min-h-0 flex-1 overflow-hidden">
                  <DoltScrollArea class="h-full min-h-0" scroller-class="py-1 text-xs">
                    <template v-if="branchTreeView">
                      <CustomContextMenu v-for="row in branchTreeRows" :key="`branch-tree-${row.key}`" :items="() => branchTreeRowContextMenuItems(row)" v-slot="{ onContextMenu, isOpen }">
                        <button
                          type="button"
                          class="dolt-ref-row"
                          :class="{ 'dolt-ref-row-active': isOpen || (!!row.branch && selectedRevisionKeySet.has(`branch:${row.branch.name}`)), 'dolt-ref-row-viewing': !!row.branch && selectedRef === row.branch.name }"
                          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
                          @click="selectBranchTreeRow(row, $event)"
                          @contextmenu="openBranchTreeRowContextMenu($event, row, onContextMenu)"
                        >
                          <span
                            class="dolt-branch-tree-toggle"
                            :class="{ 'dolt-branch-tree-toggle-empty': !row.folder }"
                            :title="row.folder ? t(row.expanded ? 'doltVersionControl.collapseBranch' : 'doltVersionControl.expandBranch') : undefined"
                            @click.stop="row.folder && toggleBranchTreePath(row.key)"
                          >
                            <ChevronRight v-if="row.folder" class="h-3 w-3 transition-transform" :class="{ 'rotate-90': row.expanded }" />
                          </span>
                          <FolderOpen v-if="row.folder && row.expanded" class="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          <Folder v-else-if="row.folder" class="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          <GitBranch v-else class="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          <span class="truncate">{{ row.label }}</span>
                          <Check v-if="row.branch && row.branch.active" class="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        </button>
                      </CustomContextMenu>
                    </template>
                    <template v-else>
                      <CustomContextMenu v-for="item in visibleBranches" :key="`branch-${item.name}`" :items="() => branchContextMenuItems(item)" v-slot="{ onContextMenu, isOpen }">
                        <button
                          type="button"
                          class="dolt-ref-row"
                          :class="{ 'dolt-ref-row-active': isOpen || selectedRevisionKeySet.has(`branch:${item.name}`), 'dolt-ref-row-viewing': selectedRef === item.name }"
                          @click="selectRef(item, $event)"
                          @contextmenu="openRefContextMenu($event, item, onContextMenu)"
                        >
                          <GitBranch class="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                          <span class="truncate">{{ item.name }}</span>
                          <Check v-if="item.active" class="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        </button>
                      </CustomContextMenu>
                    </template>
                    <div v-if="visibleBranches.length === 0" class="px-7 py-2 text-muted-foreground">{{ t("doltVersionControl.noBranches") }}</div>
                  </DoltScrollArea>
                </TabsContent>
                <TabsContent value="tags" class="m-0 min-h-0 flex-1 overflow-hidden">
                  <DoltScrollArea class="h-full min-h-0" scroller-class="py-1 text-xs">
                    <CustomContextMenu v-for="item in visibleTags" :key="`tag-${item.name}`" :items="() => refContextMenuItems(item)" v-slot="{ onContextMenu, isOpen }">
                      <button
                        type="button"
                        class="dolt-ref-row"
                        :class="{ 'dolt-ref-row-active': isOpen || selectedRevisionKeySet.has(`tag:${item.name}`), 'dolt-ref-row-viewing': selectedRef === item.name }"
                        @click="selectRef(item, $event)"
                        @contextmenu="openRefContextMenu($event, item, onContextMenu)"
                      >
                        <Tag class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span class="truncate">{{ item.name }}</span>
                      </button>
                    </CustomContextMenu>
                    <div v-if="visibleTags.length === 0" class="px-7 py-2 text-muted-foreground">{{ t("doltVersionControl.noTags") }}</div>
                  </DoltScrollArea>
                </TabsContent>
              </Tabs>
            </aside>
          </Pane>

          <Pane :size="100 - doltLeftPaneSize" :min-size="100 - DOLT_LEFT_PANE_MAX_SIZE">
            <DoltScrollArea class="relative h-full min-h-0">
              <div class="dolt-commit-header sticky top-0 z-20 grid h-7 items-center border-b bg-muted/80 text-[11px] font-medium text-muted-foreground backdrop-blur" :style="{ gridTemplateColumns: `${graphWidth}px minmax(240px, 1fr) 150px 155px` }">
                <span class="px-2">{{ t("doltVersionControl.graph") }}</span>
                <span class="px-2">{{ t("doltVersionControl.commit") }}</span>
                <span class="px-2">{{ t("doltVersionControl.author") }}</span>
                <span class="px-2">{{ t("doltVersionControl.date") }}</span>
              </div>
              <div v-if="graphLoading" class="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("doltVersionControl.loadingGraph") }}</div>
              <div v-else-if="commits.length === 0 && !showWorkingTree" class="flex h-32 items-center justify-center text-xs text-muted-foreground">{{ t("doltVersionControl.noCommits") }}</div>
              <div v-else class="relative min-w-max" :style="{ height: `${graphHeight}px` }">
                <svg class="pointer-events-none absolute left-0 top-0 z-10" :width="graphWidth" :height="graphHeight" aria-hidden="true">
                  <line v-if="showWorkingTree && commits.length" :x1="laneX(workingTreeLane)" :y1="rowY(0)" :x2="laneX(workingTreeLane)" :y2="commitRowY(0)" :stroke="graphColor(workingTreeLane, workingTreeRef)" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" />
                  <path v-for="edge in graphEdges" :key="edge.key" :d="edge.path" fill="none" :stroke="edge.color" stroke-width="2" stroke-linecap="round" />
                  <circle v-if="showWorkingTree" :cx="laneX(workingTreeLane)" :cy="rowY(0)" r="4.5" :fill="selectedRevisionKeySet.has('working') ? graphColor(workingTreeLane, workingTreeRef) : 'var(--background)'" :stroke="graphColor(workingTreeLane, workingTreeRef)" stroke-width="2" />
                  <circle
                    v-for="(row, index) in graphLayout.rows"
                    :key="`node-${commits[index]?.hash}`"
                    :cx="laneX(row.lane)"
                    :cy="commitRowY(index)"
                    r="4.5"
                    :fill="selectedRevisionKeySet.has(`commit:${commits[index]?.hash}`) ? graphColor(row.lane, row.nodeRef) : 'var(--background)'"
                    :stroke="graphColor(row.lane, row.nodeRef)"
                    stroke-width="2"
                  />
                </svg>
                <CustomContextMenu v-if="showWorkingTree" :items="workingTreeContextMenuItems" v-slot="{ onContextMenu, isOpen }">
                  <button
                    type="button"
                    class="dolt-commit-row dolt-working-tree-row absolute left-0 grid w-full min-w-[760px] items-center text-left text-xs"
                    :class="{ 'dolt-commit-row-active': isOpen || selectedRevisionKeySet.has('working') }"
                    :style="{ top: '0px', gridTemplateColumns: `${graphWidth}px minmax(240px, 1fr) 150px 155px` }"
                    :title="workingTreeTitle"
                    @click="selectWorkingTree"
                    @contextmenu="openWorkingTreeContextMenu($event, onContextMenu)"
                  >
                    <span aria-hidden="true"></span>
                    <span class="flex min-w-0 items-center gap-1.5 px-2">
                      <GitCommitHorizontal class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span class="truncate font-medium">{{ t("doltVersionControl.workingTree") }}</span>
                      <span v-if="stagedWorkingChangeCount" class="dolt-working-badge dolt-working-badge-staged">{{ t("doltVersionControl.stagedChanges", { count: stagedWorkingChangeCount }) }}</span>
                      <span v-if="unstagedWorkingChangeCount" class="dolt-working-badge dolt-working-badge-unstaged">{{ t("doltVersionControl.unstagedChanges", { count: unstagedWorkingChangeCount }) }}</span>
                    </span>
                    <span class="truncate px-2 text-muted-foreground">{{ activeBranch }}</span>
                    <span class="px-2 text-muted-foreground">{{ t("doltVersionControl.uncommitted") }}</span>
                  </button>
                </CustomContextMenu>
                <CustomContextMenu v-for="(commitItem, commitIndex) in commits" :key="commitItem.hash" :items="() => commitContextMenuItems(commitItem)" v-slot="{ onContextMenu, isOpen }">
                  <button
                    type="button"
                    class="dolt-commit-row absolute left-0 grid w-full min-w-[760px] items-center text-left text-xs"
                    :class="{ 'dolt-commit-row-active': isOpen || selectedRevisionKeySet.has(`commit:${commitItem.hash}`) }"
                    :style="{ top: `${(commitIndex + graphRowOffset) * COMMIT_ROW_HEIGHT}px`, gridTemplateColumns: `${graphWidth}px minmax(240px, 1fr) 150px 155px` }"
                    @click="selectCommit(commitItem, $event)"
                    @contextmenu="openCommitContextMenu($event, commitItem, onContextMenu)"
                  >
                    <span aria-hidden="true"></span>
                    <span class="flex min-w-0 items-center gap-1.5 px-2">
                      <GitCommitHorizontal class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span class="truncate">{{ commitItem.message || t("doltVersionControl.noMessage") }}</span>
                      <span v-for="refItem in refsByCommit.get(commitItem.hash)" :key="`${commitItem.hash}-${refItem.kind}-${refItem.name}`" class="dolt-ref-badge" :class="refItem.kind === 'branch' ? 'dolt-ref-badge-branch' : 'dolt-ref-badge-tag'" :style="refBadgeStyle(refItem)">{{
                        refItem.name
                      }}</span>
                      <span class="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{{ shortHash(commitItem.hash) }}</span>
                    </span>
                    <span class="truncate px-2 text-muted-foreground" :title="commitItem.email">{{ commitItem.committer }}</span>
                    <span class="truncate px-2 text-muted-foreground">{{ formatDate(commitItem.date) }}</span>
                  </button>
                </CustomContextMenu>
              </div>
            </DoltScrollArea>
          </Pane>
        </Splitpanes>
      </Pane>
    </Splitpanes>

    <DoltCellDiffDialog v-model:open="diffCellDetailOpen" :target="diffCellDetailTarget" :table-name="selectedChange?.tableName || selectedTableName" :from-revision="revisionLabel(comparedFrom)" :to-revision="revisionLabel(comparedTo)" />

    <Dialog :open="branchDialog !== null" @update:open="(open) => !open && closeBranchDialog()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ mutationDialogTitle }}</DialogTitle>
          <DialogDescription>{{ mutationDialogDescription }}</DialogDescription>
        </DialogHeader>
        <div v-if="createsNamedRef" class="space-y-3 py-2">
          <div class="space-y-1.5">
            <label class="text-xs font-medium">{{ branchDialog === "create-tag" ? t("doltVersionControl.tagName") : t("doltVersionControl.branchName") }}</label
            ><Input v-model="branchNameDraft" autofocus :placeholder="branchDialog === 'create-tag' ? t('doltVersionControl.tagNamePlaceholder') : t('doltVersionControl.branchNamePlaceholder')" @keydown.enter.prevent="submitBranchOperation" />
          </div>
          <div class="text-xs text-muted-foreground">{{ t("doltVersionControl.branchSource", { revision: revisionLabel(branchSourceRevision) }) }}</div>
        </div>
        <div v-if="mutationError" class="rounded border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{{ mutationError }}</div>
        <DialogFooter>
          <Button variant="ghost" :disabled="mutationLoading" @click="closeBranchDialog">{{ t("common.cancel") }}</Button>
          <Button :variant="branchDialog === 'delete' || branchDialog === 'delete-tag' ? 'destructive' : 'default'" :disabled="mutationLoading || (createsNamedRef && !branchNameDraft.trim())" @click="submitBranchOperation">
            <Loader2 v-if="mutationLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ mutationDialogTitle }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="commitDialogOpen" @update:open="(open) => !open && closeCommitDialog()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("doltVersionControl.commitWorkingTree") }}</DialogTitle>
          <DialogDescription>{{ t("doltVersionControl.commitWorkingTreeDescription") }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5 py-2">
          <label class="text-xs font-medium" for="dolt-commit-message">{{ t("doltVersionControl.commitMessage") }}</label>
          <Input id="dolt-commit-message" v-model="commitMessageDraft" autofocus :placeholder="t('doltVersionControl.commitMessagePlaceholder')" @keydown.enter.prevent="submitWorkingTreeCommit" />
        </div>
        <div v-if="commitError" class="rounded border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{{ commitError }}</div>
        <DialogFooter>
          <Button variant="ghost" :disabled="mutationLoading" @click="closeCommitDialog">{{ t("common.cancel") }}</Button>
          <Button :disabled="mutationLoading || !commitMessageDraft.trim()" @click="submitWorkingTreeCommit">
            <Loader2 v-if="mutationLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("doltVersionControl.commitWorkingTree") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="discardWorkingTreeDialogOpen" @update:open="(open) => !open && closeDiscardWorkingTreeDialog()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <div class="mb-1 flex h-9 w-9 items-center justify-center rounded-md bg-destructive/10 text-destructive"><TriangleAlert class="h-5 w-5" /></div>
          <DialogTitle>{{ t("doltVersionControl.discardWorkingTree") }}</DialogTitle>
          <DialogDescription>{{ t("doltVersionControl.discardWorkingTreeDescription") }}</DialogDescription>
        </DialogHeader>
        <div class="rounded border border-border/70 bg-muted/25 px-3 py-2 text-xs">
          <div class="mb-1 font-medium text-muted-foreground">{{ t("doltVersionControl.sqlPreview") }}</div>
          <pre class="dolt-sql-preview">{{ discardWorkingTreeSqlPreview }}</pre>
        </div>
        <div v-if="discardWorkingTreeError" class="rounded border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{{ discardWorkingTreeError }}</div>
        <DialogFooter>
          <Button variant="ghost" :disabled="mutationLoading" @click="closeDiscardWorkingTreeDialog">{{ t("common.cancel") }}</Button>
          <Button variant="destructive" :disabled="mutationLoading" @click="submitDiscardWorkingTree">
            <Loader2 v-if="mutationLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("doltVersionControl.discardWorkingTree") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="commitHistoryOperation !== null" @update:open="(open) => !open && closeCommitHistoryDialog()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <div class="mb-1 flex h-9 w-9 items-center justify-center rounded-md bg-destructive/10 text-destructive"><TriangleAlert class="h-5 w-5" /></div>
          <DialogTitle>{{ commitHistoryOperationTitle }}</DialogTitle>
          <DialogDescription>{{ commitHistoryOperationDescription }}</DialogDescription>
        </DialogHeader>
        <div v-if="commitHistoryTarget" class="space-y-2 rounded border border-border/70 bg-muted/25 px-3 py-2.5 text-xs">
          <div class="flex items-center gap-2">
            <span class="shrink-0 font-mono text-muted-foreground">{{ shortHash(commitHistoryTarget.hash) }}</span>
            <span class="min-w-0 truncate font-medium">{{ commitHistoryTarget.message || t("doltVersionControl.noMessage") }}</span>
          </div>
          <div class="text-destructive">{{ t("doltVersionControl.highRiskConfirmation") }}</div>
        </div>
        <div class="rounded border border-border/70 bg-muted/25 px-3 py-2 text-xs">
          <div class="mb-1 font-medium text-muted-foreground">{{ t("doltVersionControl.sqlPreview") }}</div>
          <pre class="dolt-sql-preview">{{ commitHistoryOperationSql }}</pre>
        </div>
        <div v-if="commitHistoryError" class="rounded border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">{{ commitHistoryError }}</div>
        <DialogFooter>
          <Button variant="ghost" :disabled="mutationLoading" @click="closeCommitHistoryDialog">{{ t("common.cancel") }}</Button>
          <Button variant="destructive" :disabled="mutationLoading" @click="submitCommitHistoryOperation">
            <Loader2 v-if="mutationLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ commitHistoryOperationTitle }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.dolt-scope-selectors {
  display: flex;
  min-width: 0;
  max-width: min(46vw, 480px);
  align-items: center;
  gap: 4px;
}

.dolt-scope-trigger {
  width: max-content;
  max-width: min(240px, 23vw);
  flex-shrink: 1;
  border-color: transparent;
  background: color-mix(in srgb, var(--muted) 28%, transparent);
  padding-right: 6px;
  padding-left: 7px;
  box-shadow: none;
}

.dolt-scope-trigger-database {
  min-width: min(128px, 23vw);
}

.dolt-scope-trigger-branch {
  min-width: min(112px, 23vw);
}

.dolt-scope-trigger:hover:not(:disabled) {
  border-color: var(--border);
  background: color-mix(in srgb, var(--muted) 48%, transparent);
}

.dolt-comparison-controls {
  display: flex;
  width: fit-content;
  max-width: min(50vw, 480px);
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.dolt-sql-preview {
  margin: 0;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  color: var(--foreground);
}

.dolt-main-splitpanes,
.dolt-diff-splitpanes,
.dolt-history-splitpanes {
  overflow: hidden;
}

.dolt-diff-result {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.dolt-diff-pair-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.dolt-diff-side {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--border);
}

.dolt-diff-side:last-child {
  border-right: 0;
}

.dolt-diff-side-header {
  display: flex;
  height: 28px;
  flex-shrink: 0;
  align-items: center;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--muted) 40%, transparent);
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
}

.dolt-workspace :deep(.splitpanes__pane) {
  min-width: 0;
  min-height: 0;
}

.dolt-workspace :deep(.splitpanes--vertical > .splitpanes__splitter) {
  position: relative;
  width: 1px;
  flex: 0 0 1px;
  border: 0;
  background: var(--border);
  cursor: col-resize;
}

.dolt-workspace :deep(.splitpanes--horizontal > .splitpanes__splitter) {
  position: relative;
  height: 1px;
  flex: 0 0 1px;
  border: 0;
  background: var(--border);
  cursor: row-resize;
}

.dolt-workspace :deep(.splitpanes--vertical > .splitpanes__splitter::before) {
  position: absolute;
  z-index: 2;
  top: 0;
  bottom: 0;
  left: -2px;
  width: 5px;
  content: "";
}

.dolt-workspace :deep(.splitpanes--horizontal > .splitpanes__splitter::before) {
  position: absolute;
  z-index: 2;
  top: -2px;
  right: 0;
  left: 0;
  height: 5px;
  content: "";
}

.dolt-workspace :deep(.splitpanes__splitter:hover) {
  background: var(--primary);
}

.dolt-ref-row,
.dolt-change-row {
  display: flex;
  width: 100%;
  min-height: 26px;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  text-align: left;
}

.dolt-ref-row,
.dolt-commit-row {
  user-select: none;
  -webkit-user-select: none;
}

.dolt-ref-row:hover,
.dolt-change-row:hover,
.dolt-commit-row:hover {
  background: color-mix(in srgb, var(--muted) 55%, transparent);
}

.dolt-ref-row-active,
.dolt-change-row-active,
.dolt-commit-row-active {
  background: var(--accent);
  color: var(--accent-foreground);
}

.dolt-ref-row-viewing {
  box-shadow: inset 2px 0 0 var(--primary);
}

.dolt-branch-tree-toggle {
  display: inline-flex;
  width: 14px;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
}

.dolt-branch-tree-toggle-empty {
  visibility: hidden;
}

.dolt-commit-row {
  height: 30px;
  display: grid;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}

.dolt-working-tree-row {
  border-bottom-style: dashed;
  border-bottom-color: color-mix(in srgb, rgb(217 119 6) 45%, var(--border));
}

.dolt-working-tree-row:not(.dolt-commit-row-active) {
  background: color-mix(in srgb, rgb(217 119 6) 7%, transparent);
}

.dolt-working-badge {
  flex-shrink: 0;
  border: 1px solid;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
}

.dolt-working-badge-staged {
  border-color: rgb(22 163 74 / 0.4);
  background: rgb(22 163 74 / 0.1);
  color: rgb(21 128 61);
}

.dolt-working-badge-unstaged {
  border-color: rgb(217 119 6 / 0.45);
  background: rgb(217 119 6 / 0.1);
  color: rgb(180 83 9);
}

.dolt-ref-badge,
.dolt-change-kind {
  max-width: 130px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 10px;
  line-height: 15px;
  color: var(--muted-foreground);
}

.dolt-change-symbol {
  display: inline-flex;
  width: 14px;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  line-height: 16px;
}

.dolt-change-flags {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  color: var(--muted-foreground);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
}

.dolt-change-flag {
  min-width: 14px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  border-radius: 3px;
  padding: 0 3px;
  text-align: center;
}

.dolt-ref-badge-branch {
  border-color: color-mix(in srgb, var(--dolt-ref-color) 45%, transparent);
  background: color-mix(in srgb, var(--dolt-ref-color) 9%, transparent);
  color: var(--dolt-ref-color);
}

.dolt-ref-badge-tag {
  border-color: color-mix(in srgb, var(--dolt-ref-color) 45%, transparent);
  border-style: dashed;
  background: color-mix(in srgb, var(--dolt-ref-color) 9%, transparent);
  color: var(--dolt-ref-color);
}

.dolt-change-added {
  border-color: rgb(22 163 74 / 0.35);
  color: rgb(21 128 61);
}

.dolt-change-removed {
  border-color: rgb(220 38 38 / 0.35);
  color: rgb(185 28 28);
}

.dolt-change-modified {
  border-color: rgb(47 111 219 / 0.35);
  color: rgb(47 111 219);
}

.dolt-change-schema {
  border-color: rgb(124 58 237 / 0.35);
  color: rgb(109 40 217);
}

.dolt-change-mixed {
  border-color: rgb(217 119 6 / 0.35);
  color: rgb(180 83 9);
}

.dolt-diff-side :deep(.dolt-grid-cell-added) {
  background-color: rgb(22 163 74 / 0.2) !important;
  box-shadow: inset 2px 0 0 rgb(22 163 74 / 0.75);
}

.dolt-diff-side :deep(.dolt-grid-cell-removed) {
  background-color: rgb(220 38 38 / 0.2) !important;
  box-shadow: inset 2px 0 0 rgb(220 38 38 / 0.75);
}

.dolt-diff-side :deep(.dolt-grid-cell-modified) {
  background-color: rgb(234 179 8 / 0.22) !important;
  box-shadow: inset 2px 0 0 rgb(202 138 4 / 0.8);
}

.dolt-diff-side :deep(.dolt-grid-cell-structural-missing) {
  background-color: color-mix(in srgb, var(--muted) 38%, transparent) !important;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent 5px, rgb(100 116 139 / 0.08) 5px, rgb(100 116 139 / 0.08) 7px);
}

.dolt-diff-side :deep(.dolt-grid-header-added),
.dolt-diff-side :deep(.dolt-grid-header-added-missing) {
  border-bottom: 2px solid rgb(22 163 74 / 0.8) !important;
  background-color: rgb(22 163 74 / 0.16) !important;
  color: rgb(21 128 61);
}

.dolt-diff-side :deep(.dolt-grid-header-removed),
.dolt-diff-side :deep(.dolt-grid-header-removed-missing) {
  border-bottom: 2px solid rgb(220 38 38 / 0.8) !important;
  background-color: rgb(220 38 38 / 0.16) !important;
  color: rgb(185 28 28);
}

.dolt-diff-side :deep(.dolt-grid-header-added-missing),
.dolt-diff-side :deep(.dolt-grid-header-removed-missing) {
  opacity: 0.58;
  background-image: repeating-linear-gradient(-45deg, transparent, transparent 5px, rgb(100 116 139 / 0.1) 5px, rgb(100 116 139 / 0.1) 7px);
}

.dolt-diff-side :deep([data-column-header-actions]) {
  display: none;
}
</style>
