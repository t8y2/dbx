// @vitest-environment happy-dom

import { createApp } from "vue";
import { expect, it, vi } from "vitest";
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";
import SchemaDiffRoutineList from "../SchemaDiffRoutineList.vue";
import SchemaDiffObjectTree from "../SchemaDiffObjectTree.vue";
import { groupDiffObjects } from "@/lib/schema/schemaDiff";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it("distinguishes same-name package kinds without changing overload labels or selection identity", () => {
  const objects = ["PACKAGE", "PACKAGE_BODY", "FUNCTION"].map((routineType, index) => ({
    id: String(index),
    name: "P",
    sourceName: "P",
    targetName: "P",
    objectKind: "function",
    routineType,
    arguments: routineType === "FUNCTION" ? "integer" : "",
    operationType: "modify",
    selected: true,
  })) as SchemaDiffObject[];
  const selections: SchemaDiffObject[] = [];
  const host = document.createElement("div");
  const app = createApp(SchemaDiffRoutineList, { objects, selectable: true, onToggleSelection: (object: SchemaDiffObject) => selections.push(object) });
  app.mount(host);
  try {
    const checkboxes = Array.from(host.querySelectorAll("input"));
    expect(checkboxes.map((input) => input.getAttribute("aria-label"))).toEqual(["PACKAGE P", "PACKAGE BODY P", "P(integer)"]);
    expect(host.textContent).toContain("PACKAGE BODY P");
    for (const input of checkboxes) input.dispatchEvent(new Event("change"));
    expect(selections).toEqual(objects);
  } finally {
    app.unmount();
  }
  const tree = createApp(SchemaDiffObjectTree, { groups: groupDiffObjects(objects) });
  tree.mount(host);
  try {
    expect(host.textContent).toContain("PACKAGE P");
    expect(host.textContent).toContain("PACKAGE BODY P");
  } finally {
    tree.unmount();
  }
});
