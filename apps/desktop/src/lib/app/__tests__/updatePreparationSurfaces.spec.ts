// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import i18n, { loadLocaleMessages } from "@/i18n";
import { UPDATE_BLOCKING_CONFIG_SURFACES, describeConfigUpdateBlock, type UpdateBlockingConfigState } from "../updatePreparationSurfaces";

const closedState: UpdateBlockingConfigState = {
  pendingAppClose: false,
  connectionDialog: false,
  saveSqlDialog: false,
  ddlDialog: false,
  objectSourceDialog: false,
  sqlParameterDialog: false,
  dangerDialog: false,
  multiDbExecuteDialog: false,
  transferDialog: false,
  sqlFileDialog: false,
  tableImportDialog: false,
  mongoImportDialog: false,
  dataGenerateDialog: false,
  databaseExportDialog: false,
  schemaDiffDialog: false,
  dataCompareDialog: false,
  configPassphraseDialog: false,
  configPassphraseExportMode: false,
  configConnectionSelectDialog: false,
  configConnectionSelectExportMode: false,
  configUnencryptedExportConfirm: false,
  importLayoutConfirm: false,
  configExportBusy: false,
  importApplying: false,
};

const translate = (key: string, named?: Record<string, unknown>) => (named?.surface ? `${key}[${String(named.surface)}]` : key);

function stateFor(surfaceId: (typeof UPDATE_BLOCKING_CONFIG_SURFACES)[number]["id"]): UpdateBlockingConfigState {
  switch (surfaceId) {
    case "configPassphraseExport":
      return { ...closedState, configPassphraseDialog: true, configPassphraseExportMode: true };
    case "configPassphraseImport":
      return { ...closedState, configPassphraseDialog: true };
    case "configConnectionSelectExport":
      return { ...closedState, configConnectionSelectDialog: true, configConnectionSelectExportMode: true };
    case "configConnectionSelectImport":
      return { ...closedState, configConnectionSelectDialog: true };
    default:
      return { ...closedState, [surfaceId]: true };
  }
}

describe("update config blocking surfaces", () => {
  it("reports nothing when every dialog is closed", () => {
    expect(describeConfigUpdateBlock(closedState, translate)).toBeNull();
  });

  it("names the dialog that holds the update back", () => {
    for (const surface of UPDATE_BLOCKING_CONFIG_SURFACES) {
      const state = stateFor(surface.id);
      const expectedLabel = surface.label(state, translate);
      expect(describeConfigUpdateBlock(state, translate)).toEqual({ code: "config", message: `updates.preparationConfigDetail[${expectedLabel}]` });
    }
  });

  it("keeps surface ids and labels unique so the message is unambiguous", () => {
    const ids = UPDATE_BLOCKING_CONFIG_SURFACES.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = UPDATE_BLOCKING_CONFIG_SURFACES.map((surface) => surface.label(stateFor(surface.id), translate));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("tells the user to wait when a config export or import is still running", () => {
    expect(describeConfigUpdateBlock({ ...closedState, configExportBusy: true }, translate)).toEqual({ code: "config_busy", message: "updates.preparationConfigBusy" });
    expect(describeConfigUpdateBlock({ ...closedState, importApplying: true }, translate)).toEqual({ code: "config_busy", message: "updates.preparationConfigBusy" });
  });

  it("reports a busy transfer before an open dialog, because the transfer cannot be closed yet", () => {
    expect(describeConfigUpdateBlock({ ...closedState, transferDialog: true, configExportBusy: true }, translate)?.code).toBe("config_busy");
  });

  it("resolves every surface label from the message catalogs instead of leaking a key path", async () => {
    await loadLocaleMessages("zh-CN");
    for (const locale of ["en", "zh-CN"]) {
      i18n.global.locale.value = locale;
      const t = (key: string, named?: Record<string, unknown>) => (named ? i18n.global.t(key, named) : i18n.global.t(key));
      for (const surface of UPDATE_BLOCKING_CONFIG_SURFACES) {
        const state = stateFor(surface.id);
        const label = surface.label(state, t);
        expect(label).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z]/);
        expect(label).not.toContain("{");
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });

  it("renders the reason with the dialog name in every shipped locale", async () => {
    const locales = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "it", "pt-BR", "tr", "az"];
    const previous = i18n.global.locale.value;
    try {
      for (const locale of locales) {
        await loadLocaleMessages(locale);
        i18n.global.locale.value = locale;
        const t = (key: string, named?: Record<string, unknown>) => (named ? i18n.global.t(key, named) : i18n.global.t(key));
        const block = describeConfigUpdateBlock({ ...closedState, transferDialog: true }, t);
        expect(block?.code).toBe("config");
        expect(block?.message).toContain(i18n.global.t("transfer.title"));
        expect(block?.message).not.toContain("{surface}");
      }
    } finally {
      i18n.global.locale.value = previous;
    }
    // Loading ten locale bundles is slow when the whole suite runs in parallel.
  }, 60000);
});
