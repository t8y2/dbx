import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";

const source = parse(readFileSync("apps/desktop/src/components/sidebar/ConnectionTree.vue", "utf8")).descriptor.scriptSetup!.content;
const script = ts.createSourceFile("ConnectionTree.ts", source, ts.ScriptTarget.Latest, true);

export function compileConnectionTreeTestScript(names: readonly string[]): string {
  const statements = script.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) return names.includes(statement.name?.text ?? "");
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) ? names.includes(declaration.name.text) : ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.some((element) => ts.isIdentifier(element.name) && names.includes(element.name.text)),
      )
    );
  });
  return ts.transpileModule(statements.map((statement) => statement.getText(script)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
