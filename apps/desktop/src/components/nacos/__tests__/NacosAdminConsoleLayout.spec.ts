import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../NacosAdminConsole.vue", import.meta.url), "utf8");

describe("NacosAdminConsole config workbench layout", () => {
  it("keeps the editor as the final and primary workbench surface", () => {
    const contextBar = source.indexOf('class="nacos-config-context-bar');
    const inspector = source.indexOf('class="nacos-config-inspector');
    const toolbar = source.indexOf('class="nacos-editor-toolbar');
    const editor = source.indexOf('ref="configEditorHost"');

    expect(contextBar).toBeGreaterThan(0);
    expect(inspector).toBeGreaterThan(contextBar);
    expect(toolbar).toBeGreaterThan(inspector);
    expect(editor).toBeGreaterThan(toolbar);
  });

  it("uses split-pane container queries instead of viewport breakpoints", () => {
    expect(source).toContain(".nacos-config-workbench {\n  container-type: inline-size;");
    expect(source).toContain("@container (min-width: 960px)");
    expect(source).toContain("@container (max-width: 480px)");
    expect(source.indexOf('class="nacos-editor-actions-secondary')).toBeLessThan(source.indexOf('class="nacos-editor-actions-primary'));
    expect(source).toContain("grid-template-columns: minmax(0, 1fr) auto;");
  });

  it("tracks format and metadata changes as unsaved configuration state", () => {
    expect(source).toContain("configType.value !== originalConfigType.value");
    expect(source).toContain('(selectedConfig.value.appName || "") !== originalConfigMetadata.value.appName');
    expect(source).toContain('(selectedConfig.value.desc || "") !== originalConfigMetadata.value.desc');
    expect(source).toContain('(selectedConfig.value.tags || "") !== originalConfigMetadata.value.tags');
  });

  it("returns a stale batch apply to preview instead of retrying an expired plan", () => {
    const staleBranch = source.indexOf('isNacosErrorCode(error, "stalePreview")');

    expect(staleBranch).toBeGreaterThan(0);
    expect(source.indexOf("batchPreview.value = null;", staleBranch)).toBeGreaterThan(staleBranch);
    expect(source.indexOf("batchTransferRequest.value = null;", staleBranch)).toBeGreaterThan(staleBranch);
    expect(source.indexOf('batchError.value = t("nacos.previewExpired");', staleBranch)).toBeGreaterThan(staleBranch);
  });

  it("keeps service detail and instance loading as independent guarded requests", () => {
    expect(source).toContain("const serviceDetailRequestGuard = createNacosLatestRequestGuard();");
    expect(source).toContain("const instancesRequestGuard = createNacosLatestRequestGuard();");
    expect(source).toContain("await Promise.all([loadServiceDetail(), loadInstances()]);");
  });

  it("keeps configuration list responses scoped to the latest filters", () => {
    expect(source).toContain("const configListRequestGuard = createNacosLatestRequestGuard();");
    expect(source).toContain("const requestId = configListRequestGuard.begin();");
    expect(source).toContain("if (!isCurrentRequest()) return false;");
    expect(source).toContain("if (configListRequestGuard.isCurrent(requestId)) configLoading.value = false;");
    expect(source).toContain("const current = await loadConfigs(page);");
    expect(source).toContain("if (!current || !isConnectionNotFoundError(configError.value)");
    expect(source.match(/configListRequestGuard\.invalidate\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps instance weight edits as drafts until the explicit save action", () => {
    expect(source).toContain("instanceWeightDrafts.value[instanceIdentity(instance)] = String(value);");
    expect(source).toContain('@click="requestInstanceWeightUpdate(instance)"');
    expect(source).not.toContain('@change="requestInstanceWeightUpdate(instance)"');
  });

  it("tracks instance operations by token so stale requests cannot lock a row forever", () => {
    expect(source).toContain("const updatingInstanceKeys = ref<Record<string, number>>({});");
    expect(source).toContain("const operationToken = beginInstanceOperation(key);");
    expect(source).toContain("clearInstanceOperation(key, operationToken);");
    expect(source).not.toContain('if (updateId === instanceUpdateSequence) updatingInstanceKey.value = "";');
  });

  it("prevents service-management dialogs from closing through outside clicks or Escape", () => {
    expect(source.match(/@pointer-down-outside\.prevent/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/@interact-outside\.prevent/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/@escape-key-down\.prevent/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("renders service details before the independently scrollable instance cards", () => {
    const detail = source.indexOf("nacos.serviceDetails");
    const instanceCards = source.indexOf('v-for="instance in instances"');
    expect(detail).toBeGreaterThan(0);
    expect(instanceCards).toBeGreaterThan(detail);
  });

  it("keeps verbose service details collapsed until the user expands them", () => {
    expect(source).toContain("const serviceDetailExpanded = ref(false);");
  });

  it("reserves the cluster-clear action space so entering a filter cannot reflow the toolbar", () => {
    expect(source).toContain('class="min-w-0 flex-1"');
    expect(source).toContain('class="flex shrink-0 items-center gap-1"');
    expect(source).toContain(':class="{ invisible: !serviceCluster }"');
    expect(source).toContain(':disabled="instancesLoading || !serviceCluster"');
    expect(source).not.toContain('v-if="serviceCluster"\n                  size="sm"');
  });

  it("adds icon-only clear controls to populated configuration and service filters", () => {
    for (const [filter, clear] of [
      ["configDataId", "clearConfigFilter('dataId')"],
      ["configGroup", "clearConfigFilter('group')"],
      ["configAppName", "clearConfigFilter('appName')"],
      ["serviceName", "clearServiceFilter('name')"],
      ["serviceGroup", "clearServiceFilter('group')"],
    ]) {
      expect(source).toContain(`v-if="${filter}"`);
      expect(source).toContain(`@click="${clear}"`);
    }
    expect(source).toContain("void loadConfigsWithRetry(1);");
    expect(source).toContain("void loadServicesWithRetry(1);");
    expect(source.match(/groupContains: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/:aria-label="t\('nacos\.clear'\)"/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("uses green outlined styling for healthy instances and red styling for unhealthy instances", () => {
    expect(source).toContain("instance.healthy === false ? 'border-destructive/50 text-destructive' : 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300'");
  });

  it("keeps the configuration editor zoom behavior aligned with the SQL editor", () => {
    expect(source).toContain("createEditorZoomCommitScheduler");
    expect(source).toContain("EditorView.domEventHandlers");
    expect(source).toContain("fontSizeFromWheelDelta(configEditorFontSize.value, event.deltaY)");
    expect(source).toContain("if (!event.metaKey && !event.ctrlKey) return false;");
    expect(source).toContain("configEditorZoomCommitScheduler.dispose()");
  });

  it("allows optional configuration columns to be hidden without hiding the data ID", () => {
    const configListHeader = source.indexOf('class="sticky top-0 z-20 grid border-b bg-muted');
    const columnVisibility = source.indexOf("nacos.visibleColumns");

    expect(configListHeader).toBeGreaterThan(0);
    expect(columnVisibility).toBeGreaterThan(configListHeader);
    expect(source).toContain("configListToggleableColumns");
    expect(source).toContain("DropdownMenuCheckboxItem");
    expect(source).toContain("nacos.visibleColumns");
    expect(source).toContain('v-for="(column, columnIndex) in configListColumns"');
    expect(source).toContain("column === 'dataId'");
  });

  it("marks the selected configuration without giving its row the header background", () => {
    expect(source).toContain("function isSelectedConfigListItem");
    expect(source).toContain(":class=\"{ 'border-l-2 border-l-primary': isSelectedConfigListItem(item) }\"");
  });

  it("adds a guarded batch delete action for selected configurations", () => {
    const toolbar = source.indexOf('class="flex min-w-0 flex-wrap items-center justify-end gap-2"');
    const batchDeleteButton = source.indexOf("v-if=\"activeTab === 'configs' && selectedConfigCount > 0\"");

    expect(toolbar).toBeGreaterThan(0);
    expect(batchDeleteButton).toBeGreaterThan(toolbar);
    expect(source).toContain('class="border-l border-current/30 pl-1.5 text-xs font-semibold tabular-nums"');
    expect(source).not.toContain('<Badge variant="outline" class="h-5 min-w-5 border-current px-1.5 text-current">{{ selectedConfigCount }}</Badge>');
    expect(source).toContain("const pendingBatchDelete = ref<NacosBatchDeleteSnapshot | null>(null);");
    expect(source).toContain("const canRequestBatchDeleteConfigs = computed(");
    expect(source).toContain("function requestBatchDeleteConfigs()");
    expect(source).toContain("async function deleteSelectedConfigs()");
    expect(source).toContain('await confirmNacosMutation(t("nacos.batchDelete"), snapshot.connectionId, snapshot.namespace)');
    expect(source).toContain("for (const key of snapshot.keys)");
    expect(source).toContain("await api.nacosDeleteConfig(snapshot.connectionId, key);");
    expect(source).toContain("function reconcileDeletedConfigSelection(deletedKeys: ReadonlySet<string>)");
    expect(source).toContain("reconcileDeletedConfigSelection(deletedKeys);");
    expect(source).toContain("nacos.batchDeletePartial");
    expect(source).toContain("nacos.batchDeleteInterrupted");
  });

  it("allows the Nacos configuration page size to be changed within the supported range", () => {
    expect(source).toContain("const NACOS_CONFIG_PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500] as const;");
    expect(source).toContain('const NACOS_CONFIG_PAGE_SIZE_STORAGE_KEY = "dbx-nacos-config-page-size";');
    expect(source).toContain("function setConfigPageSize(value: string)");
    expect(source).toContain("safeLocalStorageSet(NACOS_CONFIG_PAGE_SIZE_STORAGE_KEY, String(nextPageSize));");
    expect(source).toContain('t("nacos.configPageSize")');
    expect(source).toContain('v-for="size in NACOS_CONFIG_PAGE_SIZE_OPTIONS"');
    expect(source).toContain('@update:model-value="setConfigPageSize(String($event))"');
    expect(source).toContain(":aria-label=\"t('nacos.configPageSize')\"");
    expect(source).toContain('class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground"');
    expect(source).not.toContain('class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-3 py-2 text-xs text-muted-foreground"');
    const footerStart = source.indexOf('class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground"');
    const footerEnd = source.indexOf("</div>\n        </div>\n      </Pane>", footerStart);
    expect(source.slice(footerStart, footerEnd)).not.toContain('t("nacos.selectedCount", { count: selectedConfigCount })');
    expect(source).toContain('<ChevronLeft class="h-3.5 w-3.5" />');
    expect(source).toContain('<ChevronRight class="h-3.5 w-3.5" />');
  });

  it("uses semantic coloring for instance enable and disable actions", () => {
    expect(source).toContain("border-emerald-500/50 text-emerald-700");
    expect(source).toContain("border-destructive/50 text-destructive hover:bg-destructive/10");
  });

  it("separates the service header, filtering controls, and management actions", () => {
    expect(source).toContain('<header class="shrink-0 border-b bg-background">');
    expect(source).toContain('class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-2"');
    expect(source).toContain('t("nacos.serviceSettings")');
    expect(source).toContain('t("nacos.registerInstance")');
  });

  it("gates every Nacos mutation behind the shared production confirmation", () => {
    expect(source).toContain('import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";');
    expect(source).toContain("async function confirmNacosMutation");
    expect(source).toContain('<ProductionContextBadge v-if="nacosProductionContext.active" compact />');
    expect(source.match(/await confirmNacosMutation\(/g)?.length).toBeGreaterThanOrEqual(9);
    for (const apiCall of ["nacosApplyConfigImport", "nacosApplyConfigTransfer", "nacosRollbackConfig", "nacosPublishConfig", "nacosDeleteConfig", "nacosUpdateInstance", "nacosCreateService", "nacosDeleteService", "nacosRegisterInstance", "nacosDeregisterInstance"]) {
      expect(source).toContain(apiCall);
    }
  });
});
