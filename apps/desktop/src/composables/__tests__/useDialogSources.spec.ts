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
import { prepareConnectionConfigImport, type ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";

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
  it.each(["dbx", "rdm", "another-redis"] as const)("runs the final %s import confirmation as a single flight", async (source) => {
    let resolveApply!: (value: { count: number }) => void;
    const applyPromise = new Promise<{ count: number }>((resolve) => {
      resolveApply = resolve;
    });
    mocks.store.readImportFile.mockResolvedValue({ content: "{}", encrypted: false });
    mocks.store.parseConnectionsImport.mockResolvedValue({ connections: [conn("imported")] });
    mocks.store.applyConnectionsImport.mockReturnValue(applyPromise);

    const dialogs = await mountDialogs();
    await dialogs.onImportClick(source);
    expect(mocks.store.readImportFile).toHaveBeenCalledWith(source);
    expect(mocks.store.applyConnectionsImport).not.toHaveBeenCalled();
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

  describe("installed-app DataGrip Keychain targeting", () => {
    const content = JSON.stringify({ format: "datagrip-import", dataSources: "<project/>" });
    const datagripGroup = (connections: ConnectionConfig[]) => ({ source: "datagrip" as const, label: "DataGrip", path: "/datagrip/dataSources.xml", content, preview: { connections } });
    const dbeaverGroup = (connections: ConnectionConfig[]) => ({ source: "dbeaver" as const, label: "DBeaver", path: "/dbeaver/data-sources.json", content: "{}", preview: { connections } });

    beforeEach(() => {
      // Run the real deduplication so the test covers which rows are actually created.
      mocks.store.applyConnectionsImport.mockImplementation(async (preview: ConnectionConfigBundle) => {
        let n = 0;
        const imported = prepareConnectionConfigImport(preview, mocks.store.connections, [], () => `created-${++n}`);
        mocks.store.connections = [...mocks.store.connections, ...imported.connections];
        return { count: imported.connections.length, layout: imported.layout, createdIds: imported.createdIds };
      });
    });

    it("limits the lookup to the selected rows and the connections created from them", async () => {
      const alpha = { ...conn("dg-alpha"), name: "Alpha", host: "alpha.example" };
      const beta = { ...conn("dg-beta"), name: "Beta", host: "beta.example" };
      mocks.store.connections = [conn("existing")];
      const dialogs = await mountDialogs();

      await dialogs.onInstalledConnectionsSelected([{ group: datagripGroup([alpha, beta]), connectionIds: ["dg-alpha"] }]);

      expect(mocks.store.applyConnectionsImport.mock.calls[0][0].connections.map((connection: ConnectionConfig) => connection.name)).toEqual(["Alpha"]);
      expect(mocks.store.applyDataGripKeychainPasswords).toHaveBeenCalledTimes(1);
      expect(mocks.store.applyDataGripKeychainPasswords).toHaveBeenCalledWith({ payload: JSON.parse(content), targets: [{ source: alpha, connectionId: "created-1" }] });
      expect(mocks.store.parseConnectionsImport).not.toHaveBeenCalled();
    });

    it("targets only the DataGrip row's own connection when another app has the same endpoint with a different account", async () => {
      const endpoint = { name: "Shared", host: "db.example", port: 5432, database: "app" };
      const fromDbeaver = { ...conn("dbeaver-row"), ...endpoint, username: "dbeaver-user", password: "dbeaver-secret" };
      const fromDatagrip = { ...conn("datagrip-row"), ...endpoint, username: "datagrip-user", password: "" };
      const dialogs = await mountDialogs();

      await dialogs.onInstalledConnectionsSelected([
        { group: dbeaverGroup([fromDbeaver]), connectionIds: ["dbeaver-row"] },
        { group: datagripGroup([fromDatagrip]), connectionIds: ["datagrip-row"] },
      ]);

      // Both accounts are imported instead of the DataGrip row being dropped as a duplicate.
      expect(mocks.store.connections.map((connection) => [connection.id, connection.username, connection.password])).toEqual([
        ["created-1", "dbeaver-user", "dbeaver-secret"],
        ["created-2", "datagrip-user", ""],
      ]);
      expect(mocks.store.applyDataGripKeychainPasswords).toHaveBeenCalledWith({ payload: JSON.parse(content), targets: [{ source: fromDatagrip, connectionId: "created-2" }] });
    });

    it("skips the lookup when the DataGrip row is deduplicated against another app's identical connection", async () => {
      const shared = { name: "Shared", host: "db.example", port: 5432, database: "app", username: "app" };
      const dialogs = await mountDialogs();

      await dialogs.onInstalledConnectionsSelected([
        { group: dbeaverGroup([{ ...conn("dbeaver-row"), ...shared, password: "dbeaver-secret" }]), connectionIds: ["dbeaver-row"] },
        { group: datagripGroup([{ ...conn("datagrip-row"), ...shared, password: "" }]), connectionIds: ["datagrip-row"] },
      ]);

      expect(mocks.store.connections.map((connection) => [connection.id, connection.password])).toEqual([["created-1", "dbeaver-secret"]]);
      expect(mocks.store.applyDataGripKeychainPasswords).not.toHaveBeenCalled();
    });
  });
});
