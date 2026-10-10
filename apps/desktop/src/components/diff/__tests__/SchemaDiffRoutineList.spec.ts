// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, expect, it, vi } from "vitest";
import SchemaDiffRoutineList from "@/components/diff/SchemaDiffRoutineList.vue";
import { convertToSchemaDiffObjects, type FunctionDiff } from "@/lib/schema/schemaDiff";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it("renders distinct package parts and trigger state, dependencies, and affected callers", async () => {
  const base = { name: "SAME", data_type: "", arguments: "", definition: "BEGIN NULL; END;", schema: "SRC" };
  const trigger = { tableOwner: "SRC", tableName: "Orders", timing: "BEFORE EACH ROW", event: "UPDATE", status: "DISABLED", baseObjectType: "TABLE" };
  const diffs: FunctionDiff[] = [
    { name: "SAME", type: "added", source: { ...base, function_type: "PACKAGE" } },
    { name: "SAME", type: "added", source: { ...base, function_type: "PACKAGE BODY" } },
    { name: "SAME", type: "added", source: { ...base, function_type: "TRIGGER", trigger } },
  ];
  const objects = convertToSchemaDiffObjects([], diffs, [], [], [], undefined, [
    { name: "SAME", routineType: "PACKAGE", operation: "added", compatibilityWarnings: ["Future edition capability is not preserved"], dependencies: [], incomingDependencies: [{ owner: "DST", name: "CALLER", objectType: "PROCEDURE" }] },
    { name: "SAME", routineType: "PACKAGE BODY", operation: "added", dependencies: ["DST.SAME PACKAGE"], blockedReason: "Specification unavailable" },
    { name: "SAME", routineType: "TRIGGER", operation: "added", sourceSchema: "SRC", targetSchema: "DST", trigger: { ...trigger, tableOwner: "DST" }, dependencies: ["DST.Orders TABLE"] },
  ]);
  const toggle = vi.fn();
  const view = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffRoutineList, { objects, selectable: true, onToggleSelection: toggle, onViewDiff: view }) });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          diff: { sourceObject: "Source", targetObject: "Target", routineDiffPoints: "Changes", routineDiffStats: "{added}/{removed}/{modified}", routinePlanBlocked: "Blocked: {reason}", routineDependencies: "Dependencies: {dependencies}", routineIncomingDependencies: "Affected: {dependencies}" },
        },
      },
    }),
  );
  app.mount(host);
  await nextTick();
  expect(host.textContent).toContain("PACKAGE SRC.SAME");
  expect(host.textContent).toContain("PACKAGE BODY SRC.SAME");
  expect(host.textContent).toContain("TRIGGER SRC.SAME · SRC.Orders");
  expect(host.textContent).toContain("BEFORE EACH ROW · UPDATE · DISABLED");
  expect(host.textContent).toContain("Affected: PROCEDURE DST.CALLER");
  expect(host.textContent).toContain("Future edition capability is not preserved");
  expect(host.textContent).toContain("Blocked: Specification unavailable");
  const checkboxes = host.querySelectorAll("input");
  expect(checkboxes[1]!.disabled).toBe(true);
  checkboxes[2]!.checked = false;
  checkboxes[2]!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(toggle).toHaveBeenCalledWith(objects[2], false);
  (host.querySelectorAll('[role="button"]')[1] as HTMLElement).click();
  expect(view).toHaveBeenCalledWith(objects[1]);
});

it("shows type table-column impact and unreadable metadata while keeping blocked bodies inspectable", async () => {
  const typeInfo = { pairingState: "available", dependencyState: "empty", incomingState: "denied", referencedColumns: [{ owner: "DST", tableName: "Orders", columnName: "payload" }], metadataMessage: "ALL_DEPENDENCIES permission denied" } as const;
  const source = { name: "Order.Type", function_type: "TYPE", data_type: "", arguments: "", definition: "CREATE TYPE OrderType AS OBJECT (id NUMBER);", schema: "SRC" };
  const objects = convertToSchemaDiffObjects(
    [],
    [
      { name: source.name, type: "modified", source, target: { ...source, schema: "DST", pairedObjectPresent: true, typeInfo: { ...typeInfo, referencedColumns: [...typeInfo.referencedColumns] } } },
      { name: source.name, type: "added", source: { ...source, function_type: "TYPE BODY" } },
    ],
    [],
    [],
    [],
    undefined,
    [
      { name: source.name, routineType: "TYPE", operation: "modified", dependencies: [], blockedReason: "Dependent table columns exist", incomingDependencies: [{ owner: "DST", name: "ReadOrders", objectType: "FUNCTION" }] },
      { name: source.name, routineType: "TYPE BODY", operation: "added", dependencies: ["DST.Order.Type TYPE"] },
    ],
  );
  const toggle = vi.fn();
  const view = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffRoutineList, { objects, selectable: true, onToggleSelection: toggle, onViewDiff: view }) });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          diff: {
            sourceObject: "Source",
            targetObject: "Target",
            routineDiffPoints: "Changes",
            routineDiffStats: "{added}/{removed}/{modified}",
            routinePlanBlocked: "Blocked: {reason}",
            routineDependencies: "Dependencies: {dependencies}",
            routineIncomingDependencies: "Affected: {dependencies}",
            typeReferencedColumns: "Columns: {columns}",
            typeMetadataState: "Pair: {pairing}; outgoing: {outgoing}; incoming: {incoming}",
            typeReadState: { available: "Available", empty: "No visible rows", denied: "Permission denied" },
          },
        },
      },
    }),
  );
  app.mount(host);
  await nextTick();
  expect(host.textContent).toContain("TYPE SRC.Order.Type");
  expect(host.textContent).toContain("TYPE BODY SRC.Order.Type");
  expect(host.textContent).toContain("Columns: DST.Orders.payload");
  expect(host.textContent).toContain("Pair: TYPE BODY DST.Order.Type");
  expect(host.textContent).toContain("Affected: FUNCTION DST.ReadOrders");
  expect(host.textContent).toContain("incoming: Permission denied");
  expect(host.textContent).toContain("ALL_DEPENDENCIES permission denied");
  expect(host.querySelectorAll("input")[0]!.disabled).toBe(true);
  (host.querySelectorAll('[role="button"]')[0] as HTMLElement).click();
  expect(view).toHaveBeenCalledWith(objects[0]);
  const bodyCheckbox = host.querySelectorAll("input")[1]!;
  bodyCheckbox.checked = false;
  bodyCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
  expect(toggle).toHaveBeenCalledWith(objects[1], false);
});

it("shows both routine owners and dependencies while blocked rows remain inspectable but unselectable", async () => {
  const source = { name: "P_SYNC", function_type: "PROCEDURE", data_type: "", arguments: "", definition: "BEGIN NULL; END;", schema: "SRC" };
  const target = { ...source, schema: "DST", definition: "BEGIN old_call; END;" };
  const objects = convertToSchemaDiffObjects([], [{ name: source.name, type: "modified", source, target }], [], [], [], undefined, [{ name: source.name, routineType: "PROCEDURE", operation: "modified", blockedReason: "Unsupported dependency SRC.PKG", dependencies: ["SRC.PKG"] }]);
  const toggle = vi.fn();
  const view = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(SchemaDiffRoutineList, { objects, selectable: true, onToggleSelection: toggle, onViewDiff: view }) });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { diff: { sourceObject: "Source", targetObject: "Target", routineDiffPoints: "Changes", noDifferences: "No differences", routineDiffStats: "{added}/{removed}/{modified}", routinePlanBlocked: "Blocked: {reason}", routineDependencies: "Dependencies: {dependencies}" } } },
    }),
  );
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
