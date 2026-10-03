// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FavoritesDropdown from "../FavoritesDropdown.vue";
import { useFavoritesStore } from "@/stores/favoritesStore";
import { favoritesEn } from "@/i18n/locales/favorites";
import type { TableFavorite } from "@/types/favorites";
const mocks = vi.hoisted(() => ({ listTableFavorites: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => ({ name: "Development" }) }) }));
vi.mock("@/composables/useFavoriteOpen", () => ({ useFavoriteOpen: () => ({ open: mocks.open }) }));
const item: TableFavorite = { id: "a", code: "F0001", name: "Customers", connectionId: "c", catalog: "", database: "crm", schema: "public", objectType: "table", objectName: "customers", revision: 1, createdAt: 1, updatedAt: 1 };
let app: App;
async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await nextTick();
}
async function mount() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useFavoritesStore();
  const root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(FavoritesDropdown)
    .use(pinia)
    .use(createI18n({ legacy: false, locale: "en", messages: { en: { favorites: favoritesEn } } }));
  app.mount(root);
  await flush();
  document.querySelector<HTMLButtonElement>('button[aria-label="Favorites"]')!.click();
  await flush();
  return store;
}
describe("favorites dropdown", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listTableFavorites.mockResolvedValue({ items: [item] });
  });
  afterEach(() => {
    app?.unmount();
    document.body.innerHTML = "";
  });
  it("searches current connection names and table paths", async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.value = "development";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(document.querySelectorAll("[data-favorite-open]")).toHaveLength(1);
    input.value = "missing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(document.body.textContent).toContain(favoritesEn.noMatches);
  });
  it("edit and remove controls do not open the table", async () => {
    const store = await mount();
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove favorite"]')!.click();
    await flush();
    expect(store.dialog).toEqual({ mode: "edit", item, remove: true });
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("moves focus to the first result on ArrowDown from search", async () => {
    mocks.listTableFavorites.mockResolvedValue({ items: [item, { ...item, id: "b", code: "F0002" }] });
    await mount();
    document.querySelector<HTMLInputElement>("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await flush();
    expect(document.activeElement).toBe(document.querySelector("[data-favorite-open]"));
  });
  it("displays connection errors without removing the favorite", async () => {
    const store = await mount();
    mocks.open.mockRejectedValueOnce(new Error("network timeout"));
    document.querySelector<HTMLButtonElement>("[data-favorite-open]")!.click();
    await flush();
    expect(document.body.textContent).toContain("network timeout");
    expect(store.items).toEqual([item]);
  });
  it("clears an open error dialog when the session resets", async () => {
    const store = await mount();
    mocks.open.mockRejectedValueOnce(new Error("private error"));
    document.querySelector<HTMLButtonElement>("[data-favorite-open]")!.click();
    await flush();
    store.reset();
    await flush();
    expect(document.body.textContent).not.toContain("private error");
  });
});
