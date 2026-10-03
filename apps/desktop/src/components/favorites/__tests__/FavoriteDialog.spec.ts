// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FavoriteDialog from "../FavoriteDialog.vue";
import { useFavoritesStore } from "@/stores/favoritesStore";
import { favoritesEn } from "@/i18n/locales/favorites";
import type { TableFavorite } from "@/types/favorites";
const api = vi.hoisted(() => ({ listTableFavorites: vi.fn(), createTableFavorite: vi.fn(), updateTableFavorite: vi.fn(), removeTableFavorite: vi.fn(), relinkTableFavorite: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ name: "Development" }) }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const item: TableFavorite = { id: "a", code: "F0001", name: "Customers", connectionId: "c", catalog: "", database: "crm", schema: "public", objectType: "table", objectName: "customers", revision: 1, createdAt: 1, updatedAt: 1 };
let app: App;
async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await nextTick();
}
async function mount(mode: "create" | "edit" = "create") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useFavoritesStore();
  store.dialog = mode === "create" ? { mode, target: item } : { mode, item };
  const root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(FavoriteDialog)
    .use(pinia)
    .use(createI18n({ legacy: false, locale: "en", messages: { en: { favorites: favoritesEn } } }));
  app.mount(root);
  await flush();
  return store;
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function setInput(index: number, value: string) {
  const input = document.querySelectorAll<HTMLInputElement>("input")[index];
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function submit() {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

describe("favorite dialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listTableFavorites.mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    app?.unmount();
    document.body.innerHTML = "";
  });
  it("starts with actual table name and cancel performs no write", async () => {
    const store = await mount();
    expect(document.querySelectorAll<HTMLInputElement>("input")[1].value).toBe("customers");
    button("Cancel").click();
    await flush();
    expect(store.dialog).toBeNull();
    expect(api.createTableFavorite).not.toHaveBeenCalled();
  });
  it("validates before calling the backend", async () => {
    await mount();
    await setInput(0, "bad code");
    await submit();
    expect(document.body.textContent).toContain(favoritesEn.invalidCode);
    expect(api.createTableFavorite).not.toHaveBeenCalled();
  });
  it("previews the next code but leaves allocation to the backend", async () => {
    api.listTableFavorites.mockResolvedValue({ items: [], nextCode: "05" });
    await mount();
    expect(document.querySelectorAll<HTMLInputElement>("input")[0].value).toBe("05");
    api.createTableFavorite.mockResolvedValueOnce({ item: { ...item, code: "06" }, created: true });
    await submit();
    expect(api.createTableFavorite).toHaveBeenCalledWith(expect.objectContaining({ code: undefined }));
  });
  it("saves a manually edited code as a custom code", async () => {
    api.listTableFavorites.mockResolvedValue({ items: [], nextCode: "05" });
    await mount();
    await setInput(0, "08");
    api.createTableFavorite.mockRejectedValueOnce(new Error("FAVORITE_CODE_CONFLICT: code already exists"));
    await submit();
    expect(api.createTableFavorite).toHaveBeenCalledWith(expect.objectContaining({ code: "08" }));
    expect(document.querySelectorAll<HTMLInputElement>("input")[0].value).toBe("08");
    expect(document.body.textContent).toContain(favoritesEn.codeConflict);
  });
  it("does not overwrite manual input when a late preview arrives", async () => {
    let resolve!: (value: { items: TableFavorite[]; nextCode: string }) => void;
    api.listTableFavorites.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await mount();
    await setInput(0, "custom");
    resolve({ items: [], nextCode: "05" });
    await flush();
    expect(document.querySelectorAll<HTMLInputElement>("input")[0].value).toBe("custom");
  });
  it("retains user input on persistence failure", async () => {
    const store = await mount();
    await setInput(1, "My customers");
    api.createTableFavorite.mockRejectedValueOnce(new Error("disk full"));
    await submit();
    expect(document.body.textContent).toContain("disk full");
    expect(document.querySelectorAll<HTMLInputElement>("input")[1].value).toBe("My customers");
    expect(store.dialog).not.toBeNull();
  });
  it("turns a duplicate create into edit without overwriting the existing name", async () => {
    const store = await mount();
    api.createTableFavorite.mockResolvedValueOnce({ item, created: false });
    await submit();
    expect(store.dialog?.mode).toBe("edit");
    expect(document.querySelectorAll<HTMLInputElement>("input")[1].value).toBe("Customers");
    expect(document.body.textContent).toContain(favoritesEn.duplicate);
    expect(api.updateTableFavorite).not.toHaveBeenCalled();
  });
  it("prevents duplicate submissions while waiting", async () => {
    const store = await mount();
    let resolve!: (result: unknown) => void;
    api.createTableFavorite.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    await submit();
    await submit();
    expect(api.createTableFavorite).toHaveBeenCalledTimes(1);
    expect(button("Cancel").disabled).toBe(true);
    resolve({ item, created: true });
    await flush();
    expect(store.dialog).toBeNull();
  });
  it("requires confirmation before removing only the chosen favorite", async () => {
    const store = await mount("edit");
    api.removeTableFavorite.mockResolvedValueOnce(undefined);
    button("Remove favorite").click();
    await flush();
    expect(api.removeTableFavorite).not.toHaveBeenCalled();
    button("Remove favorite").click();
    await flush();
    expect(api.removeTableFavorite).toHaveBeenCalledWith(item.id, item.revision);
    expect(store.dialog).toBeNull();
  });
  it("starts relinking without changing the stored target", async () => {
    const store = await mount("edit");
    button("Relink table").click();
    await flush();
    expect(store.relinking).toEqual(item);
    expect(store.dialog).toBeNull();
    expect(api.relinkTableFavorite).not.toHaveBeenCalled();
  });
});
