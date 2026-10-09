// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, expect, it, vi } from "vitest";
import SchemaDiffRoutineList from "@/components/diff/SchemaDiffRoutineList.vue";
import { convertToSchemaDiffObjects } from "@/lib/schema/schemaDiff";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it("shows both routine owners and dependencies while blocked rows remain inspectable but unselectable", async () => {
  const source = { name: "P_SYNC", function_type: "PROCEDURE", data_type: "", arguments: "", definition: "BEGIN NULL; END;", schema: "SRC" };
  const target = { ...source, schema: "DST", definition: "BEGIN old_call; END;" };
  const objects = convertToSchemaDiffObjects([], [{ name: source.name, type: "modified", source, target }], [], [], [], undefined, [{ name: source.name, routineType: "PROCEDURE", operation: "modified", blockedReason: "Unsupported dependency SRC.PKG", dependencies: ["SRC.PKG"] }]);
  const toggle = vi.fn();
  const view = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffRoutineList, { objects, onToggleSelection: toggle, onViewDiff: view }) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { diff: { sourceObject: "Source", targetObject: "Target", routineDiffPoints: "Changes", noDifferences: "No differences", routineDiffStats: "{added}/{removed}/{modified}", routinePlanBlocked: "Blocked: {reason}", routineDependencies: "Dependencies: {dependencies}" } } } }));
  app.mount(host);
  await nextTick();
  expect(host.textContent).toContain("PROCEDURE SRC.P_SYNC");
  expect(host.textContent).toContain("PROCEDURE DST.P_SYNC");
  expect(host.textContent).toContain("Blocked: Unsupported dependency SRC.PKG");
  expect(host.textContent).toContain("Dependencies: SRC.PKG");
  const checkbox = host.querySelector("input")!;
  expect(checkbox.disabled).toBe(true);
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  expect(toggle).not.toHaveBeenCalled();
  (host.querySelector('[role="button"]') as HTMLElement).click();
  expect(view).toHaveBeenCalledWith(objects[0]);
});
