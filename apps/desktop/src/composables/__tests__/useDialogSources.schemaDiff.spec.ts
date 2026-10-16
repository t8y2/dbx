// @vitest-environment happy-dom

import { createApp, h, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { clearSchemaDiffInitialState, openSchemaDiffDialogWithState, useDialogSources } from "@/composables/useDialogSources";
import type { SchemaDiffTabState } from "@/types/database";

function makeState(label: string): SchemaDiffTabState {
  return {
    config: {
      sourceConnectionId: "conn-src",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      targetConnectionId: "conn-tgt",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      label,
    },
    sessionId: "session-1",
    step: "deploy-review",
    deploySql: "CREATE TABLE t (id int);",
  };
}

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

describe("useDialogSources schema-diff conversion state", () => {
  it("injects a snapshot on conversion, consumes it once, and discards it when the dialog closes", async () => {
    mountDialogSourcesOnce();

    // Stale session/prefill state must not survive the injection.
    dialogs.schemaDiffPrefillConnectionId.value = "old-conn";
    dialogs.schemaDiffInitialState.value = makeState("stale");
    const state = makeState("src -> tgt");
    openSchemaDiffDialogWithState(state);
    expect(dialogs.showSchemaDiffDialog.value).toBe(true);
    expect(dialogs.schemaDiffInitialState.value).toStrictEqual(state);
    expect(dialogs.schemaDiffSessionId.value).toBeNull();
    expect(dialogs.schemaDiffPrefillConnectionId.value).toBe("");

    clearSchemaDiffInitialState();
    expect(dialogs.schemaDiffInitialState.value).toBeUndefined();

    openSchemaDiffDialogWithState(makeState("second -> pair"));
    expect(dialogs.schemaDiffInitialState.value).toBeDefined();
    dialogs.showSchemaDiffDialog.value = false;
    await vi.waitFor(() => {
      expect(dialogs.showSchemaDiffDialog.value).toBe(false);
      expect(dialogs.schemaDiffInitialState.value).toBeUndefined();
    });
    expect(dialogs.schemaDiffSessionId.value).toBeNull();
  });
});
