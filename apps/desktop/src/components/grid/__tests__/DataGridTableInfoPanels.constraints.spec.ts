// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import DataGridTableInfoPanels from "../DataGridTableInfoPanels.vue";
import en from "@/i18n/locales/en";
import type { ConstraintInfo } from "@/types/database";

const mountedApps: ReturnType<typeof createApp>[] = [];

async function renderConstraints(constraints: ConstraintInfo[], constraintsError = "") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(DataGridTableInfoPanels, {
    activeTab: "constraints",
    searchQuery: "",
    tableName: "O01_CONSTRAINTS",
    tableSchema: "TESTER",
    database: "TESTER",
    tableOwner: null,
    overviewStats: null,
    overviewComment: null,
    overviewLoading: false,
    columns: [],
    columnsLoading: false,
    indexes: [],
    indexesLoading: false,
    indexesError: "",
    canManageMongoIndexes: false,
    foreignKeys: [],
    foreignKeysLoading: false,
    foreignKeysError: "",
    triggers: [],
    triggersLoading: false,
    triggersError: "",
    constraints,
    constraintsLoading: false,
    constraintsError,
    partitioning: null,
    partitionsLoading: false,
    partitionsError: "",
    isProtectedMongoIndex: () => false,
    formatColumnType: (value: string) => value,
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en } }));
  app.mount(container);
  mountedApps.push(app);
  await nextTick();
  return container;
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
});

describe("structured constraint information", () => {
  it("preserves composite column order and definition and distinguishes unknown states", async () => {
    const container = await renderConstraints([
      {
        name: "O01_UK",
        constraint_type: "UNIQUE",
        definition: 'UNIQUE ("B", "A")',
        columns: ["B", "A"],
        ref_columns: [],
        enabled: null,
        valid: null,
        deferrable: null,
        initially_deferred: null,
      },
    ]);

    expect(container.textContent).toContain("B, A");
    expect(container.textContent).toContain('UNIQUE ("B", "A")');
    expect(container.textContent).toContain("Enabled: Unknown");
    expect(container.textContent).toContain("Validation: Unknown");
    expect(container.textContent).not.toContain("Disabled");
    expect(container.textContent).not.toContain("Not validated");
    expect(container.querySelector("button, input, textarea")).toBeNull();
  });

  it.each([
    [true, true, "Enabled", "Validated"],
    [true, false, "Enabled", "Not validated"],
    [false, false, "Disabled", "Not validated"],
    [false, true, "Disabled", "Validated"],
    [undefined, undefined, "Enabled: Unknown", "Validation: Unknown"],
  ] as const)("shows enablement %s and validation %s independently", async (enabled, valid, enabledLabel, validLabel) => {
    const container = await renderConstraints([
      {
        name: "O01_CK",
        constraint_type: "CHECK",
        definition: 'CHECK ("AMOUNT" > 0)',
        columns: ["AMOUNT"],
        ref_columns: [],
        enabled,
        valid,
      },
    ]);
    expect(container.textContent).toContain(enabledLabel);
    expect(container.textContent).toContain(validLabel);
  });

  it("shows a metadata permission error instead of an empty result", async () => {
    const container = await renderConstraints([], "ORA-01031: insufficient privileges");
    expect(container.textContent).toContain("ORA-01031: insufficient privileges");
    expect(container.textContent).not.toContain(en.grid.tableInfoEmpty);
  });
});
