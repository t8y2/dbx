import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import { createFlatTreeIndex, flattenTree } from "@/composables/useFlatTree";
import { insertSidebarTableSearchControls, isSidebarTableSearchControlNode } from "@/lib/sidebar/sidebarTableSearchControl";
import type { TreeNode, TreeNodeType } from "@/types/database";

const source = parse(readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["stickyContainerIndex", "stickyNode", "buildTableSearchScopeIndex", "tableSearchScopeByIndex", "stickyTableSearchScope", "stickyTableSearchNode", "stickyHeaderHeight", "stickyHeaderStyle"]);
const statements = script.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text ?? "");
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => names.has(declaration.name.getText(script)));
});
const compiled = ts.transpileModule(statements.map((statement) => statement.getText(script)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function node(id: string, type: TreeNodeType, children?: TreeNode[]): TreeNode {
  return { id, label: id, type, isExpanded: !!children, children };
}
function tables() {
  return Array.from({ length: 30 }, (_, index) => node(`table${index}`, "table"));
}
function fixture(tree: TreeNode[], grouped: boolean, rowHeight: number) {
  const flatNodes = ref(insertSidebarTableSearchControls(flattenTree(tree), { enabled: true, sidebarObjectDisplay: grouped ? "grouped" : "simple", activeQueries: {} }));
  const flatTreeIndex = computed(() =>
    createFlatTreeIndex(flatNodes.value, {
      isSelectable: (item) => !isSidebarTableSearchControlNode(item),
      isBoundary: (type) => type === "connection" || type === "connection-group",
      isDatabaseContainer: (type) => type === "database",
      isSchemaContainer: (type) => type === "schema",
    }),
  );
  const stickyScrollTop = ref(0);
  const bindings = { computed, flatNodes, flatTreeIndex, stickyScrollTop, sidebarTreeRowHeight: ref(rowHeight), isTreeSearchFiltering: ref(false), isSidebarTableSearchControlNode, SCHEMA_LEVEL_TYPES: new Set(["schema"]) };
  const state = new Function(...Object.keys(bindings), `${compiled}; return {stickyNode, stickyTableSearchNode, stickyHeaderStyle, stickyHeaderHeight};`)(...Object.values(bindings));
  return {
    state,
    scrollBefore(id: string, distance: number) {
      stickyScrollTop.value = flatNodes.value.findIndex((item) => item.id === id) * rowHeight - distance;
    },
  };
}

describe("sticky table search scope boundaries", () => {
  for (const rowHeight of [24, 28]) {
    it.each(["grouped", "schemas"])(`keeps the database title pinned across %s (row height=${rowHeight})`, (mode) => {
      const grouped = mode === "grouped";
      const first = node("first", grouped ? "group-tables" : "schema", tables());
      const second = node("second", grouped ? "group-views" : "schema", [node("view", "view")]);
      const { state, scrollBefore } = fixture([node("conn", "connection", [node("db", "database", [first, second])])], grouped, rowHeight);
      scrollBefore("second", 3 * rowHeight);
      expect(state.stickyTableSearchNode.value.node.tableSearchParentId).toBe("first");
      for (const distance of [2 * rowHeight, 1.5 * rowHeight, 0.5 * rowHeight, 0]) {
        scrollBefore("second", distance);
        expect(state.stickyNode.value.id).toBe("db");
        expect(state.stickyHeaderStyle.value.transform).toBeUndefined();
        if (distance > 0 || grouped) {
          expect(state.stickyTableSearchNode.value).toBeNull();
          expect(state.stickyHeaderHeight.value).toBe(rowHeight);
        }
      }
      if (!grouped) expect(state.stickyTableSearchNode.value.node.tableSearchParentId).toBe("second");
    });

    it.each(["database", "connection", "schema"])(`still pushes the entire overlay at a %s boundary (row height=${rowHeight})`, (boundary) => {
      const first = node("first", boundary === "schema" ? "schema" : "database", tables());
      const second = node("second", boundary as TreeNodeType, [node("view", "view")]);
      const tree = boundary === "connection" ? [node("conn", "connection", [first]), second] : [node("conn", "connection", [first, second])];
      const { state, scrollBefore } = fixture(tree, false, rowHeight);
      scrollBefore("second", rowHeight / 2);
      expect(state.stickyNode.value.id).toBe("first");
      expect(state.stickyTableSearchNode.value.node.tableSearchParentId).toBe("first");
      expect(state.stickyHeaderStyle.value.transform).toBe(`translateY(${-1.5 * rowHeight}px)`);
    });
  }
});
