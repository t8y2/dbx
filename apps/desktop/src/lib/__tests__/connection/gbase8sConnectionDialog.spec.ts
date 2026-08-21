import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const parsedDialog = parse(dialogSource, { filename: "ConnectionDialog.vue" });

function selectedProfileHarness(selectedTypeValue: string, driverProfile: string) {
  const script = parsedDialog.descriptor.scriptSetup;
  expect(parsedDialog.errors).toEqual([]);
  expect(script).toBeDefined();
  const source = ts.createSourceFile("ConnectionDialog.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "selectedProfile");
  expect(declaration).toBeDefined();
  const javascript = ts.transpileModule(declaration!.getText(), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const selectedProfile = new Function("driverProfiles", "selectedType", "form", `${javascript}\nreturn selectedProfile;`)(
    {
      mysql: { label: "MySQL" },
      gbase: { label: "南大通用 GBase 8a" },
      gbase8a: { label: "南大通用 GBase 8a" },
      gbase8s: { label: "南大通用 GBase 8s" },
    },
    { value: selectedTypeValue },
    { value: { driver_profile: driverProfile } },
  ) as () => { label: string };
  return selectedProfile();
}

describe("GBase 8s connection dialog", () => {
  it("hydrates DBSERVERNAME when editing a saved connection", () => {
    expect(dialogSource).toContain('gbase_server: config.gbase_server || ""');
  });

  it.each([
    ["gbase8a", "南大通用 GBase 8a"],
    ["gbase8s", "南大通用 GBase 8s"],
  ])("shows the active %s profile in the merged GBase type field", (profile, label) => {
    expect(selectedProfileHarness("gbase", profile).label).toBe(label);
  });

  it("keeps non-GBase type labels based on the selected picker type", () => {
    expect(selectedProfileHarness("mysql", "gbase8s").label).toBe("MySQL");
  });
});
