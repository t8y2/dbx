import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const parsedDialog = parse(dialogSource, { filename: "ConnectionDialog.vue" });

function findFunction(name: string): ts.FunctionDeclaration {
  const script = parsedDialog.descriptor.scriptSetup;
  expect(parsedDialog.errors).toEqual([]);
  expect(script).toBeDefined();

  const source = ts.createSourceFile("ConnectionDialog.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(declaration).toBeDefined();
  return declaration!;
}

describe("JDBCX connection dialog", () => {
  it("preserves the connection-level high-privilege extension opt-in on submit", () => {
    const submitConfig = findFunction("connectionConfigForSubmit").getText();

    expect(submitConfig).toContain('config.db_type === "jdbc" && config.driver_profile === JDBCX_DRIVER_PROFILE');
    expect(submitConfig).toContain("config.agent_java_options = undefined");
  });
});
