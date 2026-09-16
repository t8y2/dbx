import { readFileSync } from "node:fs";

const IMPORT_STATEMENT = '@import "./tokens.css";';

/**
 * Reads the desktop stylesheet the way the browser assembles it: globals.css
 * with its `@import "./tokens.css"` replaced, in place, by the imported file.
 *
 * Design tokens live in tokens.css so the standalone documentation export can
 * reuse them without pulling in the app shell. Assertions about declaration
 * order are assertions about the cascade, so a spec that reads only globals.css
 * sees half the stylesheet and draws the wrong conclusion.
 */
export function readCascadeCss(): string {
  const globals = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
  if (!globals.includes(IMPORT_STATEMENT)) {
    // Failing loudly beats returning globals.css alone: a silent half-stylesheet
    // would resurface as an unrelated-looking assertion failure somewhere else.
    throw new Error(`globals.css no longer pulls in tokens.css with \`${IMPORT_STATEMENT}\``);
  }
  return globals.replace(IMPORT_STATEMENT, tokens);
}
