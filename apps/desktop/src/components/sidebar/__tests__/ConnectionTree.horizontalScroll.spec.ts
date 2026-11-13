// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { sidebarHorizontalWheelDelta } from "@/lib/sidebar/sidebarScrollbar";
import { alignedSidebarCommentLabelWidths, isSidebarCommentAlignableNode, canTreeNodePin, sidebarPinnedActionSlotWidthPx, sidebarTreeNaturalContentWidth, sidebarTreeNodeComment, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";
import { sidebarTreeSecondaryValue } from "@/lib/sidebar/sidebarTreeLabel";
import { showSidebarRowProductionBadge, isSidebarProductionContainer } from "@/lib/sidebar/sidebarProductionBadge";
import { formatSidebarObjectStorage } from "@/lib/sidebar/sidebarDatabaseStorage";
import type { TreeNode } from "@/types/database";

const source = parse(readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
function statement(name: string) {
  return script.statements.find((item) => (ts.isFunctionDeclaration(item) && item.name?.text === name) || (ts.isVariableStatement(item) && item.declarationList.declarations.some((declaration) => declaration.name.getText(script) === name)))!.getText(script);
}
function execute(code: string, bindings: Record<string, unknown>) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}

function wheel(options: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { cancelable: true });
  // happy-dom does not initialize all WheelEvent modifier/delta properties.
  for (const [key, value] of Object.entries(options)) Object.defineProperty(event, key, { value, configurable: true });
  return event;
}

function measure(nodes: TreeNode[], mode: string, alignedWidths = new Map<string, number>()) {
  const width = ref(0);
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 7 }) };
  execute(`${statement("sidebarTreeLeadingWidthItems")}\n${statement("measureSidebarTreeLeadingWidth")}\n${statement("sidebarTreeNaturalWidthItems")}\n${statement("measureSidebarTreeContentWidth")}\nmeasureSidebarTreeContentWidth();`, {
    computed,
    flatNodes: ref(nodes.map((node) => ({ node, depth: 3 }))),
    settingsStore: { editorSettings: { sidebarAllowHorizontalScroll: true, sidebarObjectInfoMode: mode, sidebarIndent: 16, sidebarShowConnectionNotes: true } },
    store: { getConfig: () => undefined, isTreeNodePinned: () => false, isDefaultDatabase: () => false, isDefaultSchema: () => false },
    t: (key: string) => key,
    sidebarCommentLabel: (node: TreeNode) => node.label,
    sidebarTreeSecondaryValue,
    showSidebarRowProductionBadge,
    isSidebarProductionContainer,
    sidebarTreeNodeComment,
    usesFullWidthTreeLabel,
    canTreeNodePin,
    sidebarPinnedActionSlotWidthPx,
    sidebarCommentLabelWidths: ref(alignedWidths),
    sidebarStorageDisplayTypes: new Set(["database", "table", "materialized_view"]),
    formatSidebarObjectStorage,
    sidebarTreeContentMeasureFrame: 0,
    rootRef: ref({}),
    sidebarTreeContentWidth: width,
    document: { createElement: () => ({ getContext: () => context }) },
    window: { getComputedStyle: () => ({ font: "400 14px sans-serif" }) },
    sidebarTreeNaturalContentWidth,
    nextTick: () => Promise.resolve(),
    scheduleSidebarScrollMetricsUpdate: vi.fn(),
    syncStickyRowHorizontalPosition: vi.fn(),
  });
  return width.value;
}

describe("ConnectionTree horizontal scrolling", () => {
  it("measures long database and column rows outside the mounted window, including badges and comments", () => {
    const short: TreeNode = { id: "short", type: "table", label: "short" };
    const long: TreeNode = { id: "long", type: "column", label: "long_field_name".repeat(20), meta: { is_nullable: false, comment: "field comment" } as never };
    const shortWidth = measure([short], "comment-inline");
    const all = [short, ...Array.from({ length: 400 }, (_, i) => ({ ...short, id: String(i) })), long];
    expect(measure(all, "comment-inline")).toBeGreaterThan(shortWidth + 1000);
    expect(measure(all, "comment-inline")).toBeGreaterThan(measure(all, "hidden"));
    expect(measure([{ id: "db", type: "database", label: "long_db".repeat(50) }], "hidden")).toBeGreaterThan(2000);
  });

  it("includes an aligned sibling column and bounds right comments", () => {
    const node: TreeNode = { id: "table", type: "table", label: "id", comment: "comment", sizeBytes: 1024 };
    expect(measure([node], "comment-aligned", new Map([[node.id, 600]]))).toBeGreaterThan(measure([node], "comment-inline") + 400);
    expect(measure([{ ...node, comment: "c".repeat(1000) }], "comment-right")).toBe(measure([{ ...node, comment: "c".repeat(2000) }], "comment-right"));
    expect(measure([node], "comment-and-size")).toBeGreaterThan(measure([node], "comment-inline"));
  });

  it("reserves default-schema badges and secondary values before aligned comments, including after settings change", () => {
    const widths = ref(new Map<string, number>());
    const settingsStore = { editorSettings: { sidebarAllowHorizontalScroll: true, sidebarObjectInfoMode: "comment-aligned", sidebarShowConnectionNotes: true } };
    const defaultSchema = ref(true);
    const schema: TreeNode = { id: "schema", type: "schema", label: "application_schema", schema: "application_schema", connectionId: "conn", comment: "schema comment" };
    const index: TreeNode = { id: "index", type: "elasticsearch-index", label: "logs", searchAliases: ["long_search_alias"], comment: "index comment" };
    const run = execute(`${statement("sidebarTreeLeadingWidthItems")}\n${statement("measureSidebarTreeLeadingWidth")}\n${statement("measureSidebarCommentLabelWidths")}\nreturn measureSidebarCommentLabelWidths;`, {
      computed,
      flatNodes: ref([
        { id: schema.id, depth: 0, node: schema },
        { id: index.id, depth: 1, node: index },
      ]),
      settingsStore,
      store: { getConfig: () => undefined, isDefaultDatabase: () => false, isDefaultSchema: () => defaultSchema.value },
      t: (key: string) => key,
      sidebarCommentLabel: (node: TreeNode) => node.label,
      sidebarTreeSecondaryValue,
      showSidebarRowProductionBadge,
      isSidebarProductionContainer,
      sidebarTreeNodeComment,
      isSidebarCommentAlignableNode,
      alignedSidebarCommentLabelWidths,
      sidebarCommentLabelWidths: widths,
      sidebarCommentMeasureFrame: 0,
      rootRef: ref({}),
      document: { createElement: () => ({ getContext: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 7 }) }) }) },
      window: { getComputedStyle: () => ({ font: "400 14px sans-serif" }) },
    });
    run();
    const fullSchemaWidth = schema.label.length * 7 + "editor.defaultSchema".length * 7 + 24;
    expect(widths.value.get(schema.id)).toBe(fullSchemaWidth);
    expect(widths.value.get(index.id)).toBe(index.label.length * 7 + "long_search_alias".length * 7 + 24);
    defaultSchema.value = false;
    run();
    expect(widths.value.get(schema.id)).toBe(schema.label.length * 7);
    defaultSchema.value = true;
    settingsStore.editorSettings.sidebarAllowHorizontalScroll = false;
    run();
    expect(widths.value.get(schema.id)).toBe(schema.label.length * 7);
    settingsStore.editorSettings.sidebarAllowHorizontalScroll = true;
    run();
    expect(widths.value.get(schema.id)).toBe(fullSchemaWidth);
  });

  function wheelFixture(max = 400) {
    let offset = 0;
    const scroller = {
      clientWidth: 200,
      scrollWidth: max + 200,
      get scrollLeft() {
        return offset;
      },
      set scrollLeft(value: number) {
        offset = Math.max(0, Math.min(max, value));
      },
    };
    const run = (event: WheelEvent) =>
      execute(`${statement("onTreeWheel")}\nonTreeWheel(event);`, {
        event,
        Element,
        currentTreeScroller: () => scroller,
        settingsStore: { editorSettings: { sidebarAllowHorizontalScroll: true } },
        sidebarHorizontalWheelDelta,
        sidebarTreeRowHeight: ref(28),
        scheduleSidebarScrollMetricsUpdate: vi.fn(),
        syncStickyRowHorizontalPosition: vi.fn(),
      });
    return { scroller, run };
  }

  it("consumes Shift wheel only after real scrolling and leaves normal/boundary gestures alone", () => {
    const { scroller, run } = wheelFixture();
    const first = wheel({ shiftKey: true, deltaY: 2, deltaMode: 1, cancelable: true });
    run(first);
    expect(scroller.scrollLeft).toBe(56);
    expect(first.defaultPrevented).toBe(true);
    const normal = wheel({ deltaY: 50, cancelable: true });
    run(normal);
    expect(scroller.scrollLeft).toBe(56);
    expect(normal.defaultPrevented).toBe(false);
    scroller.scrollLeft = 400;
    const boundary = wheel({ shiftKey: true, deltaY: 20, cancelable: true });
    run(boundary);
    expect(boundary.defaultPrevented).toBe(false);
  });

  it("leaves input gestures and non-overflowing trees untouched", () => {
    const { scroller, run } = wheelFixture();
    const event = wheel({ shiftKey: true, deltaY: 50, cancelable: true });
    Object.defineProperty(event, "target", { value: document.createElement("input") });
    run(event);
    expect(scroller.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    const noOverflow = wheelFixture(0);
    const other = wheel({ shiftKey: true, deltaY: 50, cancelable: true });
    noOverflow.run(other);
    expect(other.defaultPrevented).toBe(false);
  });
});
