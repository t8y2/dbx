import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";
import { nextTick, reactive, ref, shallowRef, watch } from "vue";
import { describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ja from "@/i18n/locales/ja";
import ko from "@/i18n/locales/ko";
import ptBR from "@/i18n/locales/pt-BR";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";
import { alignedSidebarCommentLabelWidths, isSidebarCommentAlignableNode, sidebarTreeNodeComment } from "@/lib/sidebar/sidebarTreeItemLayout";
import type { ColumnInfo, TreeNode } from "@/types/database";

const source = parse(readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);
const measureStatement = script.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "measureSidebarCommentLabelWidths")!.getText(script);
const watchStatement = script.statements
  .find((statement) => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(script) === "watch" && statement.expression.arguments[1]?.getText(script) === "scheduleSidebarCommentLabelMeasure")!
  .getText(script);
const messages = { en, es, it: itLocale, ja, ko, "pt-BR": ptBR, "zh-CN": zhCN, "zh-TW": zhTW };
type Locale = keyof typeof messages;

function execute(code: string, bindings: Record<string, unknown>) {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}

function textWidth(text: string, fontSize: number): number {
  return [...text].reduce((width, character) => width + (character.charCodeAt(0) > 127 ? fontSize : fontSize / 2), 0);
}

function column(label: string, nullable = true, comment?: string | null): TreeNode {
  const meta: ColumnInfo = { name: label, data_type: "int", is_nullable: nullable, column_default: null, is_primary_key: false, extra: null, comment };
  return { id: label, label, type: "column", meta };
}

function fixture(nodes: TreeNode[], initialLocale: Locale = "en", mode = "comment-aligned") {
  const locale = ref(initialLocale);
  const measurements: Array<{ text: string; font: string }> = [];
  const context = {
    font: "",
    measureText: vi.fn((text: string) => {
      measurements.push({ text, font: context.font });
      return { width: textWidth(text, Number(context.font.match(/([\d.]+)px/)![1])) };
    }),
  };
  const canvas = { getContext: vi.fn((): typeof context | null => context) };
  const scope = {
    locale,
    flatNodes: shallowRef(nodes.map((node) => ({ id: node.id, depth: 1, node }))),
    settingsStore: reactive({ editorSettings: { sidebarObjectInfoMode: mode, sidebarShowConnectionNotes: false, sidebarHiddenTablePrefixes: [], uiFontFamily: "sans-serif", uiScale: 1, sidebarFontSize: 14 } }),
    rootRef: { value: {} as object | undefined },
    sidebarCommentLabelWidths: shallowRef(new Map<string, number>()),
    sidebarCommentMeasureFrame: 0,
    document: { createElement: vi.fn(() => canvas) } as { createElement: () => typeof canvas } | undefined,
    window: { getComputedStyle: () => ({ font: "400 14px sans-serif", fontWeight: "400", fontSize: "14px", fontFamily: "sans-serif" }) },
    t: (key: string) => messages[locale.value].structureEditor[key === "structureEditor.nullable" ? "nullable" : "notNull"],
    sidebarCommentLabel: (node: TreeNode) => node.label,
    alignedSidebarCommentLabelWidths,
    isSidebarCommentAlignableNode,
    sidebarTreeNodeComment,
  };
  const measure = () => execute(`${measureStatement}\nmeasureSidebarCommentLabelWidths();`, scope);
  return { scope, measure, measurements, canvas };
}

describe("ConnectionTree comment alignment measurement", () => {
  for (const locale of Object.keys(messages) as Locale[]) {
    for (const nullable of [true, false]) {
      it.each(["id", "long_column_name_with_type (varchar(255))"])(`${locale}, nullable=${nullable}: preserves the complete %s label beside its badge`, (label) => {
        const { scope, measure, measurements } = fixture([column(label, nullable, "comment")], locale);
        measure();
        const badge = messages[locale].structureEditor[nullable ? "nullable" : "notNull"];
        expect(scope.sidebarCommentLabelWidths.value.get(label)).toBe(textWidth(label, 14) + textWidth(badge, 10) + 8 + 8);
        expect(measurements).toContainEqual({ text: label, font: "400 14px sans-serif" });
        expect(measurements).toContainEqual({ text: badge, font: "400 10px sans-serif" });
      });
    }
  }

  it("aligns mixed badges to the widest complete sibling without crossing parent groups", () => {
    const short = column("id", true, "short");
    const long = column("long_column_name", false, "long");
    const separate = column("other", false, "other");
    const { scope, measure } = fixture([], "zh-CN");
    scope.flatNodes.value = [
      { id: "first", depth: 0, node: { id: "first", label: "first", type: "group-columns" } },
      ...[short, long].map((node) => ({ id: node.id, depth: 1, node })),
      { id: "second", depth: 0, node: { id: "second", label: "second", type: "group-columns" } },
      { id: separate.id, depth: 1, node: separate },
    ];
    measure();
    const expected = textWidth(long.label, 14) + textWidth(zhCN.structureEditor.notNull, 10) + 16;
    expect(scope.sidebarCommentLabelWidths.value.get(short.id)).toBe(expected);
    expect(scope.sidebarCommentLabelWidths.value.get(long.id)).toBe(expected);
    expect(scope.sidebarCommentLabelWidths.value.get(separate.id)).toBe(textWidth(separate.label, 14) + textWidth(zhCN.structureEditor.notNull, 10) + 16);
  });

  it.each([undefined, null, ""])("keeps uncommented labels unconstrained for comment=%s while measuring sibling alignment", (comment) => {
    const plain = column("long_uncommented_column", false, comment);
    const commented = column("id", true, "comment");
    const { scope, measure } = fixture([plain, commented]);
    measure();
    expect(scope.sidebarCommentLabelWidths.value.has(plain.id)).toBe(false);
    expect(scope.sidebarCommentLabelWidths.value.get(commented.id)).toBe(textWidth(plain.label, 14) + textWidth(en.structureEditor.notNull, 10) + 16);
    scope.flatNodes.value = [{ id: plain.id, depth: 1, node: plain }];
    measure();
    expect(scope.sidebarCommentLabelWidths.value.size).toBe(0);
  });

  it.each(["column", "schema", "table", "view", "materialized_view"] as const)("does not reserve a hidden badge for %s", (type) => {
    const node: TreeNode = { id: "object", label: "object", type, comment: "comment" };
    if (type !== "column") node.meta = column("ignored").meta;
    const { scope, measure } = fixture([node]);
    measure();
    expect(scope.sidebarCommentLabelWidths.value.get(node.id)).toBe(textWidth(node.label, 14));
  });

  it("keeps connection notes opt-in", () => {
    const node: TreeNode = { id: "connection", label: "connection", type: "connection", comment: "note" };
    const { scope, measure } = fixture([node]);
    measure();
    expect(scope.sidebarCommentLabelWidths.value.size).toBe(0);
    scope.settingsStore.editorSettings.sidebarShowConnectionNotes = true;
    measure();
    expect(scope.sidebarCommentLabelWidths.value.get(node.id)).toBe(textWidth(node.label, 14));
  });

  it.each(["none", "size", "comment-inline", "comment-right"])("leaves %s layout unchanged and clears stale alignment", (mode) => {
    const { scope, measure, measurements } = fixture([column("id", true, "comment")]);
    measure();
    expect(scope.sidebarCommentLabelWidths.value.size).toBe(1);
    measurements.length = 0;
    scope.settingsStore.editorSettings.sidebarObjectInfoMode = mode;
    measure();
    expect(scope.sidebarCommentLabelWidths.value.size).toBe(0);
    expect(measurements).toEqual([]);
  });

  it.each(["document", "root", "canvas"])("preserves the unavailable %s measurement path", (missing) => {
    const { scope, measure, canvas } = fixture([column("id", true, "comment")]);
    scope.sidebarCommentLabelWidths.value.set("old", 40);
    if (missing === "document") scope.document = undefined;
    if (missing === "root") scope.rootRef.value = undefined;
    if (missing === "canvas") canvas.getContext.mockReturnValue(null);
    expect(measure).not.toThrow();
    expect([...scope.sidebarCommentLabelWidths.value]).toEqual(missing === "canvas" ? [["old", 40]] : []);
  });

  it("remeasures localized badges after a language change without a tree change", async () => {
    const { scope, measure } = fixture([column("id", true, "comment")], "zh-CN");
    const scheduleSidebarCommentLabelMeasure = vi.fn(measure);
    const stop = execute(`return ${watchStatement}`, { ...scope, watch, scheduleSidebarCommentLabelMeasure });
    try {
      expect(scheduleSidebarCommentLabelMeasure).toHaveBeenCalledTimes(1);
      const previous = scope.sidebarCommentLabelWidths.value.get("id")!;
      scope.locale.value = "es";
      await nextTick();
      expect(scheduleSidebarCommentLabelMeasure).toHaveBeenCalledTimes(2);
      expect(scope.sidebarCommentLabelWidths.value.get("id")).toBe(textWidth("id", 14) + textWidth(es.structureEditor.nullable, 10) + 16);
      expect(scope.sidebarCommentLabelWidths.value.get("id")).toBeGreaterThan(previous);
    } finally {
      stop();
    }
  });
});
