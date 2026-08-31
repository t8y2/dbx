import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const parsedDialog = parse(dialogSource, { filename: "ConnectionDialog.vue" });

function connectionConfigForSubmitSource(): string {
  const script = parsedDialog.descriptor.scriptSetup;
  expect(parsedDialog.errors).toEqual([]);
  expect(script).toBeDefined();

  const source = ts.createSourceFile("ConnectionDialog.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "connectionConfigForSubmit");
  expect(declaration).toBeDefined();
  return declaration!.getText();
}

describe("ConnectionDialog driver profile configuration", () => {
  it("preserves GaussDB routing and Dolt external configuration on submit", () => {
    const submitConfig = connectionConfigForSubmitSource();

    expect(submitConfig).toContain("setGaussdbTargetServerType(config, targetServerType)");
    expect(submitConfig).toContain("else if (!isDoltDriverProfile(config.driver_profile))");
  });
});
