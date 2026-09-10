import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

it("maps inline projected columns into local completion results", () => {
  expect(queryEditorSource).toMatch(/if \(refTable\.columns\?\.length\) \{[\s\S]*?columnsByTable\.set\([\s\S]*?refTable\.columns\.map/);
});
