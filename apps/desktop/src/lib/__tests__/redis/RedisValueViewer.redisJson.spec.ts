import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { formatRedisMemberDetail, normalizeRedisJsonDraft } from "@/lib/redis/redisValuePresentation";

const viewerSource = readFileSync(new URL("../../../components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
const parsedViewer = parse(viewerSource, { filename: "RedisValueViewer.vue" });

/** Owner-review fixture: compact save must not drop the second "role" member. */
const DUPLICATE_MEMBER_COMPACT = '{"role":"reader","role":"writer"}';
const DUPLICATE_MEMBER_PRETTY = `{
  "role": "reader",
  "role": "writer"
}`;

type TemplateElement = {
  type: number;
  tag: string;
  children?: TemplateNode[];
  props: Array<{
    type: number;
    name?: string;
    arg?: { content?: string };
    exp?: { content?: string };
  }>;
};

type TemplateNode = {
  type: number;
  children?: TemplateNode[];
};

function directiveExpression(element: TemplateElement, name: string, arg?: string): string | undefined {
  return element.props.find((prop) => prop.type === 7 && prop.name === name && (arg == null || prop.arg?.content === arg))?.exp?.content;
}

function templateElements(node: TemplateNode): TemplateElement[] {
  const children = (node.children ?? []).flatMap(templateElements);
  return node.type === 1 ? [node as TemplateElement, ...children] : children;
}

function findTemplateElement(predicate: (element: TemplateElement) => boolean): TemplateElement {
  const template = parsedViewer.descriptor.template;
  expect(parsedViewer.errors).toEqual([]);
  expect(template).toBeDefined();

  const element = templateElements(template!.ast as unknown as TemplateElement).find(predicate);
  expect(element).toBeDefined();
  return element!;
}

function findFunction(name: string): ts.FunctionDeclaration {
  const script = parsedViewer.descriptor.scriptSetup;
  expect(script).toBeDefined();

  const source = ts.createSourceFile("RedisValueViewer.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(declaration).toBeDefined();
  return declaration!;
}

function findVariableInitializer(name: string): ts.Expression {
  const script = parsedViewer.descriptor.scriptSetup;
  expect(script).toBeDefined();

  const source = ts.createSourceFile("RedisValueViewer.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
    if (declaration?.initializer) return declaration.initializer;
  }

  throw new Error(`Expected ${name} to have an initializer`);
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) calls.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function assignmentsIn(node: ts.Node): ts.BinaryExpression[] {
  const assignments: ts.BinaryExpression[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return assignments;
}

function calledName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return `${call.expression.expression.getText()}.${call.expression.name.text}`;
  return undefined;
}

describe("native RedisJSON editor", () => {
  it("uses the same foldable source editor as JSON strings and hash fields", () => {
    const stringEditor = findTemplateElement((element) => element.tag === "RedisJsonEditor" && directiveExpression(element, "if") === "stringValueView === 'json' && stringValueDetail.json");
    const nativeJsonBranch = findTemplateElement((element) => directiveExpression(element, "else-if") === "redisKind === 'json'");
    const hashEditor = findTemplateElement((element) => element.tag === "RedisJsonEditor" && directiveExpression(element, "if") === "isEditingHashJson");
    const nativeJsonEditors = templateElements(nativeJsonBranch).filter((element) => element.tag === "RedisJsonEditor");

    expect(stringEditor.tag).toBe("RedisJsonEditor");
    expect(hashEditor.tag).toBe("RedisJsonEditor");
    expect(nativeJsonEditors).toHaveLength(1);

    const [nativeJsonEditor] = nativeJsonEditors;
    expect(directiveExpression(nativeJsonEditor, "model")).toBe("editValue");
    expect(directiveExpression(nativeJsonEditor, "bind", "save-disabled")).toBe("savingJson || !redisJsonValueChanged");
    expect(directiveExpression(nativeJsonEditor, "bind", "read-only")).toBe("savingJson");
    expect(directiveExpression(nativeJsonEditor, "bind", "word-wrap")).toBe("redisJsonWordWrap");
    expect(directiveExpression(nativeJsonEditor, "on", "save")).toBe("saveJson");
  });

  it("does not leave a native RedisJSON tree or textarea rendering branch behind", () => {
    const nativeJsonBranch = findTemplateElement((element) => directiveExpression(element, "else-if") === "redisKind === 'json'");
    const nativeJsonTags = templateElements(nativeJsonBranch).map((element) => element.tag);

    expect(nativeJsonTags).not.toContain("JsonTree");
    expect(nativeJsonTags).not.toContain("textarea");
  });

  it("validates and compacts native RedisJSON before retaining JSON.SET save semantics", () => {
    const saveJson = findFunction("saveJson");
    const calls = callsIn(saveJson);
    const normalizeCall = calls.find((call) => calledName(call) === "normalizeRedisJsonDraft");
    const redisJsonSetCall = calls.find((call) => calledName(call) === "api.redisJsonSet");

    expect(normalizeCall?.arguments.map((argument) => argument.getText())).toEqual(["editValue.value"]);
    expect(redisJsonSetCall?.arguments.map((argument) => argument.getText())).toEqual(["props.connectionId", "props.db", "props.keyRaw", "normalized.compactText"]);
  });

  it("routes string and hash JSON saves through the same source-preserving normalize helper", () => {
    const saveString = findFunction("saveString");
    const saveMemberEdit = findFunction("saveMemberEdit");
    const saveStringText = saveString.getText();
    const saveMemberText = saveMemberEdit.getText();
    const saveStringCalls = callsIn(saveString).map(calledName);
    const saveMemberCalls = callsIn(saveMemberEdit).map(calledName);

    // String JSON draft (current tab or retained draft format) compact-writes via SET.
    expect(saveStringText).toContain('stringValueView.value === "json" || stringDraftFormat.value === "json"');
    expect(saveStringCalls).toContain("normalizeRedisJsonDraft");
    expect(saveStringText).toContain("value = normalized.compactText");
    expect(saveStringCalls).toContain("api.redisSetString");
    expect(saveStringText).toMatch(/redisSetString\([\s\S]*\bvalue\b/);

    // Hash JSON draft (editor open or retained after leaving JSON tab) compact-writes via HSET.
    expect(saveMemberText).toContain("savingHashJson");
    expect(saveMemberText).toContain('memberDraftFormat.value === "json"');
    expect(saveMemberCalls).toContain("normalizeRedisJsonDraft");
    expect(saveMemberText).toContain("writeValue = normalized.compactText");
    expect(saveMemberCalls).toContain("api.redisHashSet");
    expect(saveMemberText).toMatch(/redisHashSet\([\s\S]*\bwriteValue\b/);

    // Editor pretty baseline also uses the source-preserving formatter.
    expect(findFunction("formatJsonText").getText()).toContain("formatJsonSource");
  });

  it("string JSON editor open+save keeps duplicate members end-to-end", () => {
    // Open: string JSON view pretty baseline comes from formatRedisMemberDetail.
    const opened = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(opened.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Save: saveString always compact-writes through normalizeRedisJsonDraft.
    const saved = normalizeRedisJsonDraft(opened.json!.formattedText);
    expect(saved).toEqual({ ok: true, compactText: DUPLICATE_MEMBER_COMPACT });

    // Wiring: that compact text is what redisSetString receives.
    const saveString = findFunction("saveString");
    expect(saveString.getText()).toContain("value = normalized.compactText");
    expect(callsIn(saveString).map(calledName)).toEqual(expect.arrayContaining(["normalizeRedisJsonDraft", "api.redisSetString"]));
  });

  it("hash JSON editor open+save keeps duplicate members end-to-end", () => {
    // Open: hash field JSON view uses the same detail pretty baseline.
    const opened = formatRedisMemberDetail(DUPLICATE_MEMBER_COMPACT, { allowJsonText: true });
    expect(opened.json?.formattedText).toBe(DUPLICATE_MEMBER_PRETTY);

    // Save: saveMemberEdit compact-writes hash JSON drafts through the same helper.
    const saved = normalizeRedisJsonDraft(opened.json!.formattedText);
    expect(saved).toEqual({ ok: true, compactText: DUPLICATE_MEMBER_COMPACT });

    // Wiring: hash path only normalizes when savingHashJson, then HSETs writeValue.
    const saveMemberEdit = findFunction("saveMemberEdit");
    const text = saveMemberEdit.getText();
    expect(text).toContain("if (savingHashJson)");
    expect(text).toContain("writeValue = normalized.compactText");
    expect(callsIn(saveMemberEdit).map(calledName)).toEqual(expect.arrayContaining(["normalizeRedisJsonDraft", "api.redisHashSet"]));
  });

  it("keeps the native editor and export paths on the RedisJSON value-text contract", () => {
    const load = findFunction("load");
    const discard = findFunction("discardRedisJsonEdit");
    const exportStatements = findFunction("generateInsertStatements");
    const valueTextCalls = (node: ts.Node) => callsIn(node).filter((call) => calledName(call) === "redisJsonValueText");

    expect(valueTextCalls(load).map((call) => call.arguments.map((argument) => argument.getText()))).toContainEqual(["loadedValue.data"]);
    expect(valueTextCalls(exportStatements).map((call) => call.arguments.map((argument) => argument.getText()))).toContainEqual(["data.value.data"]);
    expect(assignmentsIn(load).some((assignment) => assignment.left.getText() === "redisJsonDraftBaseline.value" && assignment.right.getText() === "jsonDraftForEditor(redisJsonValueText(loadedValue.data))")).toBe(true);
    expect(assignmentsIn(discard).some((assignment) => assignment.left.getText() === "editValue.value" && assignment.right.getText() === "redisJsonDraftBaseline.value")).toBe(true);

    for (const node of [load, discard, exportStatements]) {
      expect(callsIn(node).map(calledName)).not.toContain("JSON.stringify");
    }
    expect(viewerSource).not.toContain("isRedisJsonDraftDirty");
  });

  it("keeps retained drafts out of background refresh and exposes word wrap for every JSON editor", () => {
    const autoRefresh = findFunction("startAutoRefresh");
    const hashSearch = findFunction("onHashSearch");
    const viewMember = findFunction("viewMember");
    const setMemberValueFormat = findFunction("setMemberValueFormat");
    const unsavedDraft = findVariableInitializer("hasUnsavedRedisDraft");
    const textFormat = findFunction("isTextRedisFormat");
    const labels = templateElements(parsedViewer.descriptor.template!.ast as unknown as TemplateElement);
    const stringTextarea = findTemplateElement((element) => element.tag === "textarea" && directiveExpression(element, "model") === "editValue");
    const memberTextarea = findTemplateElement((element) => element.tag === "textarea" && directiveExpression(element, "model") === "memberEditValue");
    const refreshButton = findTemplateElement((element) => element.tag === "Button" && directiveExpression(element, "on", "click") === "load");

    expect(autoRefresh.getText()).toContain("if (hasUnsavedRedisDraft.value) return;");
    expect(autoRefresh.getText()).toContain("load({ preserveDraft: true })");
    expect(hashSearch.getText()).toContain("if (!hasRetainedMemberDraft.value) clearSelectedMember();");
    expect(viewMember.getText()).toContain("hasRetainedMemberDraft.value");
    // Clean JSON → other format must clear memberDraftFormat so rawText is not compared to the pretty baseline.
    expect(setMemberValueFormat.getText()).toContain("memberDraftFormat.value = null");
    expect(setMemberValueFormat.getText()).toContain('memberDraftFormat.value = "utf8"');
    expect(unsavedDraft.getText()).toContain("hasRetainedStringDraft.value");
    expect(unsavedDraft.getText()).toContain("hasRetainedMemberDraft.value");
    expect(textFormat.getText()).toContain('format === "json"');
    expect(labels.some((element) => element.tag === "label" && directiveExpression(element, "if") === "isTextRedisFormat(stringValueView)")).toBe(true);
    expect(labels.some((element) => element.tag === "label" && directiveExpression(element, "if") === "isTextRedisFormat(memberValueView)")).toBe(true);
    expect(directiveExpression(stringTextarea, "bind", "readonly")).toBe("!canEditCurrentStringFormat || savingString");
    expect(directiveExpression(memberTextarea, "bind", "readonly")).toBe("savingMember");
    expect(directiveExpression(refreshButton, "bind", "disabled")).toBe("hasUnsavedRedisDraft");
  });
});
