// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  store: {
    connections: [] as ConnectionConfig[],
    transferSource: null,
    schemaDiffSource: null,
    dataCompareSource: null,
    sqlFileSource: null,
    diagramSource: null,
    docsSource: null,
    tableImportSource: null,
    tableDataGenerateSource: null,
    fieldLineageSource: null,
    databaseSearchSource: null,
    databaseExportSource: null,
    readImportFile: vi.fn(),
    parseConnectionsImport: vi.fn(),
    applyConnectionsImport: vi.fn(),
    applyDataGripKeychainPasswords: vi.fn(),
    lastDataGripFallbackUsernamesCount: 0,
    exportConnectionsToFile: vi.fn(),
  },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { useDialogSources } from "@/composables/useDialogSources";
import { clearRememberedExportPassphrase, getRememberedExportPassphrase } from "@/lib/backend/exportPassphraseSession";

const mountedApps: App[] = [];

beforeEach(() => {
  mocks.store.connections = [];
  mocks.store.exportConnectionsToFile.mockReset().mockResolvedValue("saved");
  clearRememberedExportPassphrase();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  vi.clearAllMocks();
});

function conn(id: string): ConnectionConfig {
  return { id, name: "Imported", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "secret" };
}

async function mountDialogs() {
  let dialogs!: ReturnType<typeof useDialogSources>;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        dialogs = useDialogSources();
        return () => h("div");
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return dialogs;
}

describe("useDialogSources", () => {
  it("runs the final import confirmation as a single flight", async () => {
    let resolveApply!: (value: { count: number }) => void;
    const applyPromise = new Promise<{ count: number }>((resolve) => {
      resolveApply = resolve;
    });
    mocks.store.readImportFile.mockResolvedValue({ content: "{}", encrypted: false });
    mocks.store.parseConnectionsImport.mockResolvedValue({ connections: [conn("imported")] });
    mocks.store.applyConnectionsImport.mockReturnValue(applyPromise);

    const dialogs = await mountDialogs();
    await dialogs.onImportClick("dbx");
    dialogs.onConfigConnectionSelectConfirm(["imported"]);
    dialogs.onConfigConnectionSelectConfirm(["imported"]);

    expect(mocks.store.applyConnectionsImport).toHaveBeenCalledTimes(1);

    resolveApply({ count: 1 });
    await applyPromise;
    await nextTick();
  });

  it("requires confirmation before an unencrypted export and preserves the flow when cancelled", async () => {
    mocks.store.connections = [conn("selected")];
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    expect(dialogs.showConfigPassphraseDialog.value).toBe(true);

    dialogs.onRequestUnencryptedExport();
    expect(dialogs.showConfigPassphraseDialog.value).toBe(false);
    expect(dialogs.showConfigUnencryptedExportConfirm.value).toBe(true);
    expect(mocks.store.exportConnectionsToFile).not.toHaveBeenCalled();

    dialogs.onConfigUnencryptedExportOpenChange(false);
    expect(dialogs.showConfigUnencryptedExportConfirm.value).toBe(false);
    expect(dialogs.showConfigPassphraseDialog.value).toBe(true);
    expect(mocks.store.exportConnectionsToFile).not.toHaveBeenCalled();

    dialogs.onRequestUnencryptedExport();
    await dialogs.onConfigUnencryptedExportConfirm();
    expect(mocks.store.exportConnectionsToFile).toHaveBeenCalledWith({ mode: "plaintext" }, ["selected"]);
  });

  it("keeps encrypted export state when the native save dialog is cancelled", async () => {
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockResolvedValueOnce("cancelled").mockResolvedValueOnce("saved");
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    await dialogs.onExportConfirm("passphrase");

    expect(dialogs.showConfigPassphraseDialog.value).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalled();

    await dialogs.onExportConfirm("passphrase");
    expect(mocks.store.exportConnectionsToFile.mock.calls).toEqual([
      [{ mode: "encrypted", passphrase: "passphrase" }, ["selected"]],
      [{ mode: "encrypted", passphrase: "passphrase" }, ["selected"]],
    ]);
    expect(dialogs.showConfigPassphraseDialog.value).toBe(false);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("keeps plaintext export state when the native save dialog is cancelled", async () => {
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockResolvedValueOnce("cancelled").mockResolvedValueOnce("saved");
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    dialogs.onRequestUnencryptedExport();
    await dialogs.onConfigUnencryptedExportConfirm();

    expect(dialogs.showConfigUnencryptedExportConfirm.value).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalled();

    await dialogs.onConfigUnencryptedExportConfirm();
    expect(mocks.store.exportConnectionsToFile.mock.calls).toEqual([
      [{ mode: "plaintext" }, ["selected"]],
      [{ mode: "plaintext" }, ["selected"]],
    ]);
    expect(dialogs.showConfigUnencryptedExportConfirm.value).toBe(false);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("prevents duplicate unencrypted exports while the file is being written", async () => {
    let resolveExport!: () => void;
    const exportPromise = new Promise<void>((resolve) => {
      resolveExport = resolve;
    });
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockReturnValue(exportPromise);
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    dialogs.onRequestUnencryptedExport();
    const first = dialogs.onConfigUnencryptedExportConfirm();
    const second = dialogs.onConfigUnencryptedExportConfirm();

    expect(dialogs.configExportBusy.value).toBe(true);
    expect(mocks.store.exportConnectionsToFile).toHaveBeenCalledTimes(1);
    resolveExport();
    await first;
    await second;
    expect(dialogs.configExportBusy.value).toBe(false);
  });

  it("keeps the passphrase dialog open and reports an error when writing the encrypted export fails", async () => {
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockRejectedValue(new Error("disk full"));
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    await dialogs.onExportConfirm("passphrase");

    expect(dialogs.showConfigPassphraseDialog.value).toBe(true);
    expect(dialogs.configPassphraseError.value).toBe("Failed to export connections");
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(getRememberedExportPassphrase()).toBe("");
  });

  it("reports an error instead of success when writing the plaintext export fails", async () => {
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockRejectedValue(new Error("disk full"));
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);
    dialogs.onRequestUnencryptedExport();
    await dialogs.onConfigUnencryptedExportConfirm();

    expect(dialogs.showConfigUnencryptedExportConfirm.value).toBe(false);
    expect(dialogs.showConfigPassphraseDialog.value).toBe(true);
    expect(dialogs.configPassphraseError.value).toBe("Failed to export connections");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("remembers the passphrase only after the export file is actually written", async () => {
    mocks.store.connections = [conn("selected")];
    mocks.store.exportConnectionsToFile.mockResolvedValueOnce("cancelled").mockResolvedValueOnce("saved");
    const dialogs = await mountDialogs();

    dialogs.onExportClick();
    dialogs.onConfigConnectionSelectConfirm(["selected"]);

    await dialogs.onExportConfirm("passphrase");
    expect(getRememberedExportPassphrase()).toBe("");

    await dialogs.onExportConfirm("passphrase");
    expect(getRememberedExportPassphrase()).toBe("passphrase");
  });

  it("previews Studio 3T connections and persists only after selection confirmation", async () => {
    mocks.store.readImportFile.mockResolvedValue({ content: "URI payload", encrypted: false });
    const preview = { connections: [conn("one"), conn("two")], importWarnings: ["Review the default database before connecting."] };
    mocks.store.parseConnectionsImport.mockResolvedValue(preview);
    mocks.store.applyConnectionsImport.mockResolvedValue({ count: 1 });
    const dialogs = await mountDialogs();

    await dialogs.onImportClick("studio3t");
    expect(dialogs.showConfigConnectionSelectDialog.value).toBe(true);
    expect(dialogs.configConnectionSelectNotice.value).toContain("Studio 3T exported connection names");
    expect(dialogs.configConnectionSelectNotice.value).toContain("Review the default database before connecting.");
    expect(mocks.store.applyConnectionsImport).not.toHaveBeenCalled();

    dialogs.onConfigConnectionSelectConfirm(["two"]);
    await nextTick();
    expect(mocks.store.applyConnectionsImport).toHaveBeenCalledWith(preview, ["two"]);
  });

  it("cancels a Studio 3T preview without saving any connections", async () => {
    mocks.store.readImportFile.mockResolvedValue({ content: "URI payload", encrypted: false });
    mocks.store.parseConnectionsImport.mockResolvedValue({ connections: [conn("one")] });
    const dialogs = await mountDialogs();
    await dialogs.onImportClick("studio3t");
    dialogs.onConfigConnectionSelectOpenChange(false);
    expect(mocks.store.applyConnectionsImport).not.toHaveBeenCalled();
    expect(dialogs.configConnectionSelectList.value).toEqual([]);
    expect(dialogs.configConnectionSelectNotice.value).toBe("");
  });
});
