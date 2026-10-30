// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import InstalledConnectionsDialog from "./InstalledConnectionsDialog.vue";
import { installedImportMessages } from "@/i18n/locales/installedImportMessages";

const discover = vi.hoisted(() => vi.fn());
vi.mock("@/lib/imports/installedConnections", () => ({ loadInstalledConnectionGroups: discover, installedConnectionAppLabels: { navicat: "Navicat", dbeaver: "DBeaver", datagrip: "DataGrip", rdm: "Redis Desktop Manager", dbx: "DBX" } }));
vi.mock("@/components/ui/dialog", () => {
  const wrapper = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return { Dialog: wrapper, DialogContent: wrapper, DialogFooter: wrapper, DialogHeader: wrapper, DialogTitle: wrapper };
});
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("button", slots.default?.()),
  }),
}));

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

async function flush() {
  await Promise.resolve();
  await nextTick();
}
async function mount(busy = false) {
  const confirm = vi.fn();
  const readFile = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(InstalledConnectionsDialog, { open: true, busy, readFile, onConfirm: confirm });
  const i18n = createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: { installedImport: installedImportMessages.en }, id: { installedImport: installedImportMessages.id } } });
  app.use(i18n);
  app.mount(root);
  unmount = () => app.unmount();
  await flush();
  return { root, confirm, readFile, i18n };
}
const groups = [
  {
    source: "dbeaver",
    label: "DBeaver",
    path: "/hidden/data-sources.json",
    content: "{}",
    preview: {
      connections: [
        { id: "a", name: "Production", host: "prod.example", port: 5432, db_type: "postgres" },
        { id: "b", name: "Staging", host: "stage.example", port: 5432, db_type: "postgres" },
      ],
    },
  },
  { source: "rdm", label: "Redis Desktop Manager", path: "/hidden/connections.json", content: "{}", preview: { connections: [{ id: "c", name: "Cache", host: "redis.example", port: 6379, db_type: "redis" }] } },
];
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

describe("installed connections", () => {
  it("updates the dialog when the language changes to Indonesian", async () => {
    discover.mockResolvedValue({ groups: [], errors: [] });
    const { root, i18n } = await mount();
    expect(root.textContent).toContain("Import connections");
    i18n.global.locale.value = "id";
    await nextTick();
    expect(root.textContent).toContain("Impor koneksi");
    expect(button(root, "Tambahkan file")).toBeDefined();
    expect(button(root, "Impor yang dipilih")).toBeDefined();
    expect(root.textContent).not.toContain("No saved connections found");
    expect(root.textContent).not.toContain("Import connections");
  });
  it("shows individual connections and submits only checked rows across apps", async () => {
    discover.mockResolvedValue({ groups, errors: [] });
    const { root, confirm } = await mount();
    expect(root.textContent).toContain("Production");
    expect(root.textContent).toContain("prod.example");
    expect(root.textContent).toContain("Redis Desktop Manager");
    expect(root.textContent).not.toContain("/hidden/");
    expect(root.querySelector('input[type="file"]')).toBeNull();
    const checkboxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes[1].click();
    checkboxes[3].click();
    await nextTick();
    button(root, "Import selected").click();
    expect(confirm).toHaveBeenCalledWith([
      { group: groups[0], connectionIds: ["a"] },
      { group: groups[1], connectionIds: ["c"] },
    ]);
  });

  it("selects all and clears selections when rescanning", async () => {
    discover.mockResolvedValue({ groups, errors: [] });
    const { root } = await mount();
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await nextTick();
    expect(button(root, "Import selected").textContent).toContain("(3)");
    button(root, "Scan again").click();
    await flush();
    expect(button(root, "Import selected").disabled).toBe(true);
    expect(button(root, "Import selected").textContent).toContain("(0)");
  });

  it("shows an empty state with manual file import available", async () => {
    discover.mockResolvedValue({ groups: [], errors: [] });
    const { root } = await mount();
    expect(root.textContent).toContain("No saved connections found");
    expect(root.textContent).toContain("Navicat");
    expect(button(root, "Add file").disabled).toBe(false);
    expect(button(root, "Import selected").disabled).toBe(true);
    expect(root.textContent).not.toContain("From a file");
  });

  it("allows a failed scan to be retried", async () => {
    discover.mockRejectedValueOnce(new Error("Cannot scan"));
    const { root } = await mount();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Cannot scan");
    discover.mockResolvedValue({ groups, errors: [] });
    button(root, "Scan again").click();
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it("prevents confirming while an import is running", async () => {
    discover.mockResolvedValue({ groups, errors: [] });
    const { root, confirm } = await mount(true);
    expect(button(root, "Importing").disabled).toBe(true);
    button(root, "Importing").click();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("adds a Navicat file to the same selection list and preserves it on rescan", async () => {
    discover.mockResolvedValue({ groups, errors: [] });
    const { root, confirm, readFile } = await mount();
    const manual = { source: "navicat", label: "Navicat", path: "manual:1", content: "<Connections/>", preview: { connections: [{ id: "nav", name: "Navicat production", host: "nav.example", port: 3306, db_type: "mysql" }] } };
    readFile.mockResolvedValue(manual);
    button(root, "Add file").click();
    await flush();
    expect(readFile).toHaveBeenCalledWith("navicat");
    expect(root.textContent).toContain("Navicat production");
    button(root, "Scan again").click();
    await flush();
    expect(root.textContent).toContain("Navicat production");
    const checkboxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes[checkboxes.length - 1].click();
    await nextTick();
    button(root, "Import selected").click();
    expect(confirm).toHaveBeenCalledWith([{ group: manual, connectionIds: ["nav"] }]);
  });

  it("keeps discovered connections when manual file selection is cancelled or invalid", async () => {
    discover.mockResolvedValue({ groups, errors: [] });
    const { root, readFile } = await mount();
    readFile.mockResolvedValueOnce(null);
    button(root, "Add file").click();
    await flush();
    expect(root.textContent).toContain("Production");
    readFile.mockRejectedValueOnce(new Error("Invalid Navicat file"));
    button(root, "Add file").click();
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Invalid Navicat file");
    expect(root.textContent).toContain("Production");
  });
});
