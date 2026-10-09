import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const viewerSource = readFileSync(new URL("../../../components/redis/RedisValueViewer.vue", import.meta.url), "utf8");
const parsedViewer = parse(viewerSource, { filename: "RedisValueViewer.vue" });

/**
 * Issue #10922 wiring: detected JSON containers open pretty-printed, detected
 * structured codecs open decoded, and both surfaces carry a representation
 * badge — unless the user pinned an explicit format or codec.
 */
describe("Redis value detection (issue 10922)", () => {
  function findFunction(name: string): ts.FunctionDeclaration {
    const script = parsedViewer.descriptor.scriptSetup;
    expect(script).toBeDefined();

    const source = ts.createSourceFile("RedisValueViewer.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    expect(declaration).toBeDefined();
    return declaration!;
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

  function calledName(call: ts.CallExpression): string | undefined {
    if (ts.isIdentifier(call.expression)) return call.expression.text;
    if (ts.isPropertyAccessExpression(call.expression)) return `${call.expression.expression.getText()}.${call.expression.name.text}`;
    return undefined;
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

  it("opens detected JSON containers pretty-printed and detected codecs decoded on load", () => {
    const load = findFunction("load");
    const formatAssignments = assignmentsIn(load).filter((assignment) => assignment.left.getText() === "stringValueView.value");
    const codecCalls = callsIn(load).filter((call) => calledName(call) === "applyDetectedStringCodec");

    expect(formatAssignments).toHaveLength(1);
    expect(formatAssignments[0].right.getText()).toBe("autoRedisValueFormat(detail, readStoredRedisValueFormat())");
    expect(codecCalls.map((call) => call.arguments.map((argument) => argument.getText()))).toContainEqual(["detail"]);
  });

  it("applies the same detection to selected member details", () => {
    const selectMember = findFunction("selectMember");
    const formatAssignments = assignmentsIn(selectMember).filter((assignment) => assignment.left.getText() === "memberValueView.value");
    const codecCalls = callsIn(selectMember).filter((call) => calledName(call) === "applyDetectedMemberCodec");

    expect(formatAssignments).toHaveLength(1);
    expect(formatAssignments[0].right.getText()).toBe("autoRedisValueFormat(detail, readStoredRedisValueFormat())");
    expect(codecCalls.map((call) => call.arguments.map((argument) => argument.getText()))).toContainEqual(["detail"]);
  });

  it("detection yields to a pinned codec and clears itself for undetected payloads", () => {
    const applyString = findFunction("applyDetectedStringCodec").getText();
    const applyMember = findFunction("applyDetectedMemberCodec").getText();

    for (const text of [applyString, applyMember]) {
      expect(text).toContain("readStoredRedisValueCodec() != null");
      expect(text).toContain('detectedRedisStructuredCodec(detail) ?? "none"');
    }
    expect(applyString).toContain("isStringValueTruncated.value");
  });

  it("treats a missing stored preference as the auto-detection signal", () => {
    const readFormat = findFunction("readStoredRedisValueFormat").getText();
    const readCodec = findFunction("readStoredRedisValueCodec").getText();

    // Legacy stored values keep their mapping; anything unpinned returns null
    // (auto), never the old "utf8"/"none" defaults.
    expect(readFormat).toContain('if (stored === "raw") return "utf8";');
    expect(readFormat).toContain(": null;");
    expect(readFormat).not.toContain(': "utf8";');
    expect(readCodec).toContain("isRedisValueCodec(stored) ? stored : null");

    const stringViewInit = findVariableInitializer("stringValueView").getText();
    const stringCodecInit = findVariableInitializer("stringValueCodec").getText();
    expect(stringViewInit).toContain('readStoredRedisValueFormat() ?? "utf8"');
    expect(stringCodecInit).toContain('readStoredRedisValueCodec() ?? "none"');
  });

  it("labels the detected representation next to the value on both surfaces", () => {
    const template = parsedViewer.descriptor.template;
    expect(parsedViewer.errors).toEqual([]);
    expect(template).toBeDefined();

    expect(viewerSource).toContain('v-if="stringValueDetectionLabel"');
    expect(viewerSource).toContain('v-if="memberDetectionLabel"');
    expect(viewerSource.match(/t\('redis\.detectedBadgeTitle'\)/g)).toHaveLength(4);
    expect(findFunction("redisDetectionBadgeLabel").getText()).toContain('t("redis.detectedJavaSerialized")');
    expect(findFunction("redisDetectionBadgeLabel").getText()).toContain("isRedisJsonContainerValue(detail.json?.value)");
  });
});
