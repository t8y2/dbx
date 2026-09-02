import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../ContentArea.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const structureEditorSource = readFileSync(new URL("../../structure/TableStructureEditor.vue", import.meta.url), "utf8");

describe("ContentArea split-pane forced read-only", () => {
  it("declares the forcedReadOnly prop and applies it before every editing entry point", () => {
    expect(contentAreaSource).toContain("forcedReadOnly?: boolean;");
    expect(contentAreaSource).toContain(':editable="!forcedReadOnly && (!!activeTab.queryAnalysis || !!mongoQueryResultSaveHandler)"');
    expect(contentAreaSource).toContain(':editable="!forcedReadOnly && !activeTab.tableMetaPending');
    expect(contentAreaSource.match(/forcedReadOnly \|\| connectionIsEffectivelyReadOnly\(activeConnection\)/g)).toHaveLength(3);
  });

  it("forces read-only on the split reference pane instead of relying on the connection clone", () => {
    const splitIndex = appSource.indexOf(':key="`split-${splitPaneTab.id}`"');
    expect(splitIndex).toBeGreaterThan(-1);
    const splitBlock = appSource.slice(splitIndex, splitIndex + 2200);
    expect(splitBlock).toContain("view-only");
    expect(splitBlock).toContain("forced-read-only");
    // Format/compress signals are main-pane scoped: never share them with the reference pane.
    expect(splitBlock).toContain(':format-sql-request="null"');
    expect(splitBlock).toContain(':compress-sql-request="null"');
  });

  it("wires the reference pane's cancel and dead controls explicitly", () => {
    const splitIndex = appSource.indexOf(':key="`split-${splitPaneTab.id}`"');
    const splitBlock = appSource.slice(splitIndex, splitIndex + 4000);
    expect(splitBlock).toContain('@cancel="splitPaneTab.isExecuting && queryStore.cancelTabExecution(splitPaneTab.id)"');
    expect(splitBlock).toContain('@structure-editor-close="queryStore.closeSplitPane()"');
    expect(splitBlock).toContain('@click-table="onClickTable"');
    expect(splitBlock).toContain('@view-table-data="onViewTableData"');
  });

  it("renders the structure editor without mutation actions in the reference pane", () => {
    expect(contentAreaSource).toContain(':read-only="viewOnly"');
    expect(structureEditorSource).toContain("/** Reference-pane presentation: hide mutation actions and reject saves. */");
    expect(structureEditorSource).toContain("if (props.readOnly) return false;");
    expect(structureEditorSource).toContain('<div v-if="!readOnly" class="flex shrink-0 items-center justify-end gap-2">');
  });
});
