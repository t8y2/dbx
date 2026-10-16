// @vitest-environment happy-dom

import { createApp, h, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { clearDataCompareInitialState, openDataCompareDialogWithState, useDialogSources } from "@/composables/useDialogSources";
import type { DataCompareTabState } from "@/types/database";

function makeState(label: string): DataCompareTabState {
  return {
    config: {
      sourceConnectionId: "conn-src",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      sourceDatabases: ["srcdb"],
      sourceSchemas: ["public"],
      sourceTables: ["users"],
      selectedSourceTables: ["users"],
      targetConnectionId: "conn-tgt",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      targetDatabases: ["tgtdb"],
      targetSchemas: ["public"],
      targetTables: ["users"],
      targetTable: "users",
      keyColumnsByTable: {},
      label,
    },
  };
}

// useDialogSources registers its store watchers once per module (module-level
// guard), and unmounting stops them. Keep a single mounted app for the whole
// spec so the singleton state machine stays observable across phases.
let dialogs!: ReturnType<typeof useDialogSources>;
const mountedApps: App[] = [];

function mountDialogSourcesOnce() {
  if (dialogs) return dialogs;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    setup() {
      dialogs = useDialogSources();
      return () => h("div");
    },
  });
  mountedApps.push(app);
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  return dialogs;
}

afterEach(() => {
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("useDialogSources data-compare conversion state", () => {
  it("injects a snapshot on conversion, consumes it once, and discards it when the dialog closes", async () => {
    mountDialogSourcesOnce();

    // Inject: snapshot wins over session/prefill inputs.
    dialogs.dataCompareSessionId.value = "old-session";
    dialogs.dataComparePrefillConnectionId.value = "old-conn";
    const state = makeState("src -> tgt");
    openDataCompareDialogWithState(state);
    expect(dialogs.showDataCompareDialog.value).toBe(true);
    expect(dialogs.dataCompareInitialState.value).toStrictEqual(state);
    expect(dialogs.dataCompareSessionId.value).toBeNull();
    expect(dialogs.dataComparePrefillConnectionId.value).toBe("");

    // Consume once.
    clearDataCompareInitialState();
    expect(dialogs.dataCompareInitialState.value).toBeUndefined();

    // Closing the dialog discards an unconsumed snapshot.
    openDataCompareDialogWithState(makeState("second -> pair"));
    expect(dialogs.dataCompareInitialState.value).toBeDefined();
    dialogs.showDataCompareDialog.value = false;
    await vi.waitFor(() => {
      expect(dialogs.showDataCompareDialog.value).toBe(false);
      expect(dialogs.dataCompareInitialState.value).toBeUndefined();
    });
    expect(dialogs.dataCompareSessionId.value).toBeNull();
  });
});
