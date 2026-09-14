import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../SchemaDiffDialog.vue", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../../composables/useSchemaDiffSession.ts", import.meta.url), "utf8");
const configStepSource = readFileSync(new URL("../SchemaDiffConfigStep.vue", import.meta.url), "utf8");

describe("SchemaDiffDialog fullscreen layout", () => {
  it("fits the dialog to its portal instead of the viewport width", () => {
    expect(dialogSource).toContain('width: "100%"');
    expect(dialogSource).toContain('height: "100%"');
    expect(dialogSource).not.toContain('width: "100vw"');
    expect(dialogSource).not.toContain('height: "100vh"');
  });

  it("removes the normal dialog gutter and minimum width while maximized", () => {
    expect(dialogSource).toContain(":portal-class=\"isMaximized ? 'p-0' : undefined\"");
    expect(dialogSource).toContain("isMaximized ? 'min-w-0' : 'min-w-[800px] resize'");
  });

  it("closes the options panel before allowing Escape to dismiss the dialog", () => {
    expect(dialogSource).toContain('@escape-key-down="handleDialogEscape"');
    expect(dialogSource).toContain("if (!showOptionsPanel.value) return;");
    expect(dialogSource).toContain("event.preventDefault();");
    expect(dialogSource).toContain("showOptionsPanel.value = false;");
  });

  it("lets the deploy confirm dialog body shrink so a long destructive statement can't push the footer buttons off-screen", () => {
    expect(dialogSource).toContain('<div class="py-2 space-y-3 min-w-0">');
  });

  it("lets the config step scroll vertically so the Compare button stays reachable when 'compare specific tables' is enabled", () => {
    // Regression for #6627: the "compare specific tables" feature (#6533/#6540) grows the
    // config step (table multi-select + same-name match). Under a fixed-height dialog that
    // step used to be clipped (`overflow-hidden`), pushing the Compare button below the
    // visible area with no way to scroll to it. The container must scroll on all steps
    // except the result step, which relies on splitpanes to manage its own height.
    expect(dialogSource).toContain("step === 'result' ? 'overflow-hidden' : 'overflow-y-auto'");
    // The config step must not be flex-shrunk (which would swallow its height and suppress
    // the scrollbar); only then does the taller-than-dialog content actually overflow and
    // become reachable via scrolling.
    expect(dialogSource).toMatch(/<SchemaDiffConfigStep\n[\s\S]*?class="shrink-0"/);
  });

  it("clears stale result and progress state whenever a new dialog session opens", () => {
    expect(dialogSource).toContain("function resetComparisonResultState() {");
    expect(dialogSource).toMatch(/if \(!isOpen\) return;[\s\S]*?resetComparisonResultState\(\);/);
    expect(dialogSource).toContain("diffObjects.value = [];");
    expect(dialogSource).toContain("lastDiffResult.value = null;");
    expect(dialogSource).toContain("schemaDiffProgress.value = null;");
  });

  it("shows real metadata progress and indeterminate comparison phases without fabricated percentages", () => {
    expect(sessionSource).toContain('phase: "loading-table-lists"');
    expect(sessionSource).toContain('phase: "loading-source-details"');
    expect(sessionSource).toContain('phase: "loading-target-details"');
    expect(sessionSource).toContain('phase: "loading-extra-objects"');
    expect(sessionSource).toContain('phase: "comparing"');
    expect(sessionSource).toContain('phase: "generating"');
    expect(sessionSource).toContain("onProgress: (progress) =>");
    expect(dialogSource).toContain("schemaDiffProgressCount");
    expect(dialogSource).toContain('role="progressbar"');
    expect(dialogSource).toContain("schema-diff-progress-indeterminate");
    expect(dialogSource).not.toMatch(/\b(?:20|40|60|80)%/);
  });

  it("renders a localized next-step label alongside the current progress state", () => {
    expect(dialogSource).toContain("getSchemaDiffNextProgressStep");
    expect(dialogSource).toContain("schemaDiffNextProgressLabel");
    expect(dialogSource).toContain('t("diff.progress.next"');
    expect(dialogSource).toContain('v-if="schemaDiffNextProgressLabel"');
    expect(dialogSource).toContain("shouldLoadSchemaDiffExtraObjectPhase");
  });

  it("clears progress before preserving the existing comparison error flow", () => {
    expect(sessionSource).toContain("session.error = message;");
    expect(sessionSource).toContain('session.status = "failed";');
    expect(dialogSource).toContain("toast(session.error, 5000);");
    expect(dialogSource).toContain('step.value = "config";');
  });

  it("keeps an active comparison running after the dialog unmounts", () => {
    expect(dialogSource).toContain("const session = startSchemaDiffSession(");
    expect(dialogSource).toContain("onBeforeUnmount(() => {");
    expect(dialogSource).toContain("componentUnmounted = true;");
    expect(dialogSource).not.toContain("comparisonRequestId");
  });

  it("does not restore persisted table matches before source and target identities are ready", () => {
    expect(configStepSource).toContain('if (!isTableIdentityReady("source")) {');
    expect(configStepSource).toContain("clearUnavailableTableSelection();");
    expect(configStepSource).toContain('v-if="restrictTables && canConfigureTableSelection"');
    expect(configStepSource).toContain("restrictTables && localSelectedTables.length && canConfigureTableSelection && isTableIdentityReady('target')");
  });

  it("resets stale target schema and object selection when the target identity changes", () => {
    expect(dialogSource).toContain("suppressTargetIdentityReset");
    expect(dialogSource).toContain("clearCompareObjectSelection");
    expect(dialogSource).toContain("runWithoutTargetIdentityReset");
    expect(dialogSource).toContain("watch(targetConnectionId,");
    expect(dialogSource).toContain("watch(targetDatabase,");
    expect(dialogSource).toContain("watch(targetDbType,");
    expect(dialogSource).toContain('targetDatabase.value = ""');
    expect(dialogSource).toContain('targetSchema.value = ""');
    expect(dialogSource).toContain("isSchemaAware(dbType as DatabaseType)");
    expect(dialogSource).toContain("selectedTables: undefined");
    expect(dialogSource).toContain("selectedRoutines: undefined");
  });

  it("gates config table-list loading on the tables compare switch", () => {
    expect(configStepSource).toContain("tablesCompareEnabled.value && shouldLoadSchemaDiffTableList");
  });

  it("keeps explicit table selection in a shared scope below both sides", () => {
    const comparisonScope = configStepSource.indexOf("<!-- Comparison Scope -->");
    const targetInfo = configStepSource.indexOf("<!-- Target Info -->");
    const options = configStepSource.indexOf("<!-- Options -->");
    const tableSelectors = configStepSource.match(/<TableMultiSelect\b/g) ?? [];
    const tableSelector = configStepSource.indexOf("<TableMultiSelect", comparisonScope);
    const targetMatch = configStepSource.indexOf("<!-- Target Same-Name Match -->", comparisonScope);

    expect(comparisonScope).toBeGreaterThan(targetInfo);
    expect(comparisonScope).toBeLessThan(options);
    expect(tableSelectors).toHaveLength(2);
    expect(tableSelector).toBeGreaterThan(comparisonScope);
    expect(tableSelector).toBeLessThan(options);
    expect(targetMatch).toBeGreaterThan(comparisonScope);
    expect(targetMatch).toBeLessThan(options);
  });

  it("wires source-to-target table mappings through the selector and compare request", () => {
    expect(configStepSource).toContain('@update:model-value="(value: string) => handleTableMappingUpdate(match.sourceTable, value)"');
    expect(configStepSource).toContain("tableMatchStatus.${match.kind}");
    expect(dialogSource).toContain('@update:table-mappings="handleTableMappingsUpdate"');
    expect(sessionSource).toContain("tableMappings: sessionOptions.selectedTables === undefined ? undefined : sessionOptions.tableMappings");
    expect(sessionSource).toContain("ignoreTableNameCase: sessionOptions.ignoreTableNameCase");
    expect(sessionSource).toContain("ignoreColumnNameCase: sessionOptions.ignoreColumnNameCase");
    expect(dialogSource).toContain("const swappedMappings = swapSchemaDiffTableMappings(currentOptions.tableMappings ?? []);");
    expect(dialogSource).toContain('value="routines"');
    expect(configStepSource).toContain("handleUpdateSelectedRoutines");
  });

  it("exposes table and routine compare switches on the config step", () => {
    expect(configStepSource).toContain('import { Switch } from "@/components/ui/switch"');
    expect(configStepSource).toContain("update:compareScope");
    expect(configStepSource).toContain("handleTablesCompareEnabled");
    expect(configStepSource).toContain("handleRoutinesCompareEnabled");
    expect(configStepSource).toContain("effectiveRoutinesEnabled");
    expect(configStepSource).toContain("const routinesEnabled = effectiveRoutinesEnabled.value");
    expect(configStepSource).toContain("if (!tablesEnabled && !routinesEnabled) return false");
    expect(configStepSource).toContain("unrestrictedRoutineLoadTooLarge");
    expect(configStepSource).toContain("SCHEMA_DIFF_UNRESTRICTED_ROUTINE_LIMIT");
    expect(configStepSource).toContain('t("diff.routineSelectionTooLarge"');
    expect(configStepSource).toContain('t("diff.tableCompareDisabled")');
    expect(configStepSource).toContain('t("diff.routineCompareDisabled")');
    expect(configStepSource).toContain("schemaDiffRoutineObjectTypesIntersection");
    expect(configStepSource).toContain('t("diff.routineSameNameMatchingOnly")');
    expect(dialogSource).toContain('@update:compare-scope="handleCompareScopeUpdate"');
    expect(dialogSource).toContain("function handleCompareScopeUpdate");
    expect(dialogSource).toContain("const routinesCompareEnabled = computed(() => !!schemaDiffPanelOptions.value.functions)");
    expect(dialogSource).toContain("effectiveRoutinesEnabled");
    expect(dialogSource).not.toContain("functions: value === undefined ? activeConfig.value.options.functions : true");
    expect(sessionSource).toContain("shouldLoadSchemaDiffRoutines");
    expect(sessionSource).toContain("shouldLoadSchemaDiffExtraObjectPhase");
    expect(sessionSource).toContain("const loadTableMetadata = !!(sessionOptions.tables || sessionOptions.views)");
    expect(sessionSource).not.toContain("options.selectedRoutines !== undefined");
    expect(sessionSource).not.toContain("wantRoutines");
  });

  it("shows result tabs only for enabled compare scopes", () => {
    expect(dialogSource).toContain("showTableResultTab");
    expect(dialogSource).toContain("showRoutineResultTab");
    expect(dialogSource).toContain("showResultTabList");
    expect(dialogSource).toContain("tablesCompareEnabled");
    expect(dialogSource).toContain("routinesCompareEnabled");
    expect(dialogSource).toContain("effectiveRoutinesEnabled");
    expect(dialogSource).toContain("showNoDifferences");
    expect(dialogSource).not.toContain("showRoutinesNotCompared");
    expect(dialogSource).toContain("showRoutineNoDifferences");
    expect(dialogSource).toContain('t("diff.resultTabTables"');
    expect(dialogSource).toContain('t("diff.resultTabRoutines"');
    expect(dialogSource).toContain('t("diff.noDifferences")');
    expect(dialogSource).toContain("schemaDiffRoutineObjectTypesIntersection");
    expect(dialogSource).toContain('v-if="showResultTabList"');
    expect(dialogSource).toContain('v-if="showTableResultTab"');
    expect(dialogSource).toContain("data-[state=inactive]:hidden");
    expect(dialogSource).toContain("if (!showTableResultTab.value && showRoutineResultTab.value)");
    expect(dialogSource).toContain("loadObjectSourceWithRoutineFallback");
  });

  it("defers routine deploy except for postgres-family targets", () => {
    expect(dialogSource).toContain("showRoutineDeployDeferredHint");
    expect(dialogSource).toContain("canDeployRoutines");
    expect(dialogSource).toContain("isSchemaDiffPostgresLike");
    expect(dialogSource).toContain('t("diff.routineSyncDeferredHint")');
    expect(dialogSource).toContain('if (resultTab.value === "routines" && !canDeployRoutines.value) return false');
    expect(dialogSource).toContain("nextStepDeployRoutines");
    expect(dialogSource).toContain('t("diff.nextStepDeploy")');
    expect(dialogSource).toContain(':selectable="canDeployRoutines"');
    expect(configStepSource).toContain("api.listObjects");
    expect(configStepSource).not.toContain("api.listFunctions");
  });

  it("uses the object tree for tables and a dedicated list plus text diff for routines", () => {
    expect(dialogSource).toContain('import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue"');
    expect(dialogSource).toContain('import SchemaDiffRoutineList from "@/components/diff/SchemaDiffRoutineList.vue"');
    expect(dialogSource).toContain('import SideBySideTextDiff, { type TextDiffSide } from "@/components/common/SideBySideTextDiff.vue"');
    expect(dialogSource).toContain('<SchemaDiffObjectTree :groups="tableDiffGroups"');
    expect(dialogSource).toContain("<SchemaDiffDdlPanel");
    expect(dialogSource).toContain("<SchemaDiffRoutineList");
    expect(dialogSource).toContain(':objects="routineDiffObjects"');
    expect(dialogSource).toContain("handleViewRoutineDiff");
    expect(dialogSource).toContain("<SideBySideTextDiff");
    expect(dialogSource).toContain('t("diff.selectRoutineToCompare")');
    expect(dialogSource).not.toContain(':groups="routineDiffGroups"');
  });

  it("keeps focused and selected deployment SQL projections separate", () => {
    expect(dialogSource).toContain('const focusedDeploySql = ref("");');
    expect(dialogSource).toContain('const selectedDeploySql = ref("");');
    expect(dialogSource).toContain("const input = selectSchemaDiffInputForObject(result, diffObjects.value, objectId);");
    expect(dialogSource).toContain(':deploy-sql="focusedDeploySql"');
    expect(dialogSource).toContain(':deploy-sql-all="selectedDeploySql"');
    expect(dialogSource).not.toContain("deploySqlAll.value = result.syncSql");
  });

  it("executes the selected SQL rather than the focused preview", () => {
    expect(dialogSource).toContain("sql: selectedDeploySql.value");
    expect(dialogSource).toContain("[selectedDeploySql.value]");
    expect(dialogSource).toContain("selectedObjectId.value !== objectId");
    expect(dialogSource).toContain('selectedDeploySql.value = "";');
    expect(dialogSource).toContain("const sql = selectedDeploySql.value.trim();");
  });
});
