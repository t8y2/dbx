// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), export: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/binlog/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/binlog/client")>()), requestBinlog: mocks.request, cancelBinlog: mocks.cancel, exportBinlogSql: mocks.export }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: { props: ["open"], template: '<div v-if="open"><slot/></div>' },
  DialogContent: { template: "<section><slot/></section>" },
  DialogHeader: { template: "<header><slot/></header>" },
  DialogTitle: { template: "<h1><slot/></h1>" },
  DialogDescription: { template: "<p><slot/></p>" },
  DialogFooter: { template: "<footer><slot/></footer>" },
}));
import Dialog from "../BinlogRecoveryDialog.vue";
import { binlogRecoveryEn } from "@/i18n/locales/binlogRecovery";
let host: HTMLDivElement;
let app: ReturnType<typeof createApp>;
const list = { sha256: "abc", total: 1, offset: 0, transactions: [{ start_position: "207", end_position: "999", timestamp: 1700000000, gtid: null, rows: 1, tables: [["test", "items"]] }] };
const details = {
  sha256: "abc",
  start_position: "207",
  total: 1,
  offset: 0,
  rows: [
    { position: "400", database: "test", table: "items", full_image: true, has_column_names: true, has_signedness: true, before: [{ ordinal: 0, column: "id", kind: "integer", value: "18446744073709551615" }], after: [{ ordinal: 0, column: "id", kind: "integer", value: "18446744073709551614" }] },
  ],
};
function button(text: string) {
  const found = Array.from(host.querySelectorAll("button")).find((e) => e.textContent?.trim() === text);
  expect(found, `button ${text}`).toBeTruthy();
  return found!;
}
async function click(text: string) {
  button(text).click();
  await nextTick();
}
async function imported() {
  await click("Import binlog");
  await vi.waitFor(() => expect(host.textContent).toContain("test.items"));
  await vi.waitFor(() => expect(host.textContent).toContain("18446744073709551615"));
}
beforeEach(() => {
  mocks.request.mockReset();
  mocks.cancel.mockReset();
  mocks.export.mockReset();
  mocks.open.mockReset();
  mocks.save.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue("/test.binlog");
  mocks.save.mockResolvedValue("/recovery.sql");
  mocks.request.mockImplementation(async (r) => (r.action === "list" ? list : r.action === "details" ? details : { sha256: "abc", sql: "-- reviewed SQL\nDELETE FROM test.items;" }));
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(Dialog, { open: true });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { binlogRecovery: binlogRecoveryEn } } }));
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
});
describe("binlog recovery dialog", () => {
  it("clears an old export error when a new target succeeds", async () => {
    await imported();
    await click("Choose schema");
    host.querySelector<HTMLInputElement>('[data-binlog-select="207"]')!.click();
    host.querySelector<HTMLInputElement>("[data-binlog-attest]")!.click();
    await nextTick();
    await click("Generate SQL preview");
    await vi.waitFor(() => expect(button("Export .sql").disabled).toBe(false));
    mocks.export.mockRejectedValueOnce(new Error("target already exists"));
    await click("Export .sql");
    await vi.waitFor(() => expect(host.textContent).toContain("target already exists"));
    mocks.export.mockResolvedValueOnce(undefined);
    await click("Export .sql");
    await vi.waitFor(() => expect(host.textContent).toContain("SQL exported."));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("previews whole transactions and exact before/after integers without executing SQL", async () => {
    expect(host.textContent).toContain("Nothing is executed");
    await imported();
    expect(host.textContent).toContain("18446744073709551614");
    expect(mocks.request.mock.calls.map((c) => c[0].action)).toEqual(["list", "details"]);
    expect(button("Generate SQL preview").disabled).toBe(true);
  });
  it("requires explicit historical evidence and selection, then exports only reviewed SQL", async () => {
    await imported();
    await click("Choose schema");
    const selected = host.querySelector<HTMLInputElement>('[data-binlog-select="207"]')!;
    selected.click();
    await nextTick();
    expect(button("Generate SQL preview").disabled).toBe(true);
    host.querySelector<HTMLInputElement>("[data-binlog-attest]")!.click();
    await nextTick();
    await click("Generate SQL preview");
    await vi.waitFor(() => expect(button("Export .sql").disabled).toBe(false));
    await click("Export .sql");
    await vi.waitFor(() => expect(mocks.export).toHaveBeenCalledWith("/recovery.sql", "-- reviewed SQL\nDELETE FROM test.items;"));
    selected.click();
    await nextTick();
    expect(button("Export .sql").disabled).toBe(true);
  });
  it("shows worker refusal and never leaves a stale export enabled", async () => {
    await imported();
    await click("Choose schema");
    host.querySelector<HTMLInputElement>('[data-binlog-select="207"]')!.click();
    host.querySelector<HTMLInputElement>("[data-binlog-attest]")!.click();
    await nextTick();
    mocks.request.mockRejectedValueOnce(new Error("historical schema mismatch"));
    await click("Generate SQL preview");
    await vi.waitFor(() => expect(host.textContent).toContain("historical schema mismatch"));
    expect(button("Export .sql").disabled).toBe(true);
  });
  it("marks unknown numeric signedness instead of claiming an exact negative value", async () => {
    mocks.request.mockImplementation(async (r) => (r.action === "list" ? list : { ...details, rows: [{ ...details.rows[0], has_signedness: false, before: [{ ordinal: 0, column: "id", kind: "ambiguous_integer", value: "0xffffffffffffffff" }], after: null }] }));
    await click("Import binlog");
    await vi.waitFor(() => expect(host.textContent).toContain("Signedness unknown"));
    expect(host.textContent).toContain("0xffffffffffffffff");
    expect(host.textContent).not.toContain("-1");
  });
  it("cancels the owned request and ignores a late generation response after close", async () => {
    await imported();
    await click("Choose schema");
    host.querySelector<HTMLInputElement>('[data-binlog-select="207"]')!.click();
    host.querySelector<HTMLInputElement>("[data-binlog-attest]")!.click();
    await nextTick();
    let resolve!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click("Generate SQL preview");
    const id = mocks.request.mock.calls.at(-1)![1];
    await click("Close");
    expect(mocks.cancel).toHaveBeenCalledWith(id);
    resolve({ sha256: "abc", sql: "stale SQL" });
    await nextTick();
    await nextTick();
    expect(button("Export .sql").disabled).toBe(true);
    expect(host.querySelector("textarea")).toBeNull();
  });
});
