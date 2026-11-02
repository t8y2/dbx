// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import OracleDatabaseLinksDialog from "../OracleDatabaseLinksDialog.vue";

const mocks = vi.hoisted(() => ({ executeQuery: vi.fn() }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), executeQuery: mocks.executeQuery }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  mocks.executeQuery.mockReset();
});
const link = { name: "REMOTE", owner: "A_USER", username: "REMOTE_USER", host: "127.0.0.1:2881", created: "" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  expect(match, text).toBeDefined();
  return match!;
}
async function fill(label: string, value: string) {
  const item = [...document.querySelectorAll("label")].find((element) => element.textContent?.includes(label));
  const input = item?.querySelector("input");
  expect(input, label).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function createForm() {
  button("databaseLinks.create").click();
  await nextTick();
  for (const [label, value] of [
    ["name", "REMOTE_NEW"],
    ["username", "remote_user"],
    ["host", "127.0.0.1:2881"],
    ["remoteTenant", "MixedTenant"],
    ["password", "local-test-secret"],
  ])
    await fill("databaseLinks." + label, value);
}
function submit() {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
async function mount(options: { dbType?: DatabaseType; readonly?: boolean; list?: ReturnType<typeof vi.fn>; owner?: string; name?: string } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  vi.spyOn(store, "getConfig").mockImplementation((id) => ({ id, name: id, db_type: options.dbType ?? "oceanbase-oracle", read_only: options.readonly ?? false }) as ConnectionConfig);
  const list = vi.spyOn(store, "listOracleDatabaseLinks").mockImplementation(options.list ?? (async () => [link]));
  mocks.executeQuery.mockImplementation(async (connectionId: string, _database: string, sql: string) => ({ columns: ["VALUE"], rows: [[sql.includes("SESSION_USER") ? (connectionId === "a" ? "A_USER" : "B_USER") : 1]] }));
  const state = reactive({ connectionId: "a", database: "service", open: true });
  const changed = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(OracleDatabaseLinksDialog, { ...state, name: options.name, owner: options.owner, onChanged: changed }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  return { state, changed, list };
}
async function ready() {
  await vi.waitFor(() => expect(button("databaseLinks.create").disabled).toBe(false));
}

describe("DBX Oracle DBLink dialog reused for OceanBase", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("preserves supported controls for %s", async (dbType) => {
    await mount({ dbType, name: "REMOTE", owner: "A_USER" });
    await ready();
    expect([...document.querySelectorAll("button")].some((element) => element.textContent?.trim() === "databaseLinks.alter")).toBe(dbType === "oracle");
    button("databaseLinks.create").click();
    await nextTick();
    expect(document.querySelector("select") !== null).toBe(dbType === "oceanbase-oracle");
    const publicControl = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(dbType === "oceanbase-oracle" ? "databaseLinks.oceanbasePublic" : "databaseLinks.public"));
    expect(publicControl).toBeDefined();
    expect(publicControl?.querySelector("input")?.disabled).toBe(false);
    expect(publicControl?.querySelector("input")?.checked).toBe(false);
  });
  it("creates through the shared execution guard using SESSION_USER instead of selected schema", async () => {
    const { changed, list } = await mount();
    await ready();
    await createForm();
    submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const request = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("CREATE DATABASE LINK"));
    expect(request?.slice(0, 2)).toEqual(["a", "service"]);
    expect(request?.[2]).toContain('CONNECT TO "REMOTE_USER"@"MixedTenant"');
    expect(request?.[2]).toContain(" OB HOST '127.0.0.1:2881'");
    expect(request?.[2]).not.toContain("CREATE PUBLIC");
    expect(request?.[3]).toBe("A_USER");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("creates the explicit PUBLIC form when the OceanBase option is selected", async () => {
    const { changed } = await mount();
    await ready();
    await createForm();
    const publicControl = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("databaseLinks.oceanbasePublic"));
    const checkbox = publicControl?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeDefined();
    checkbox!.click();
    await nextTick();
    submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const request = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("CREATE PUBLIC DATABASE LINK"));
    expect(request?.[2]).toContain('CONNECT TO "REMOTE_USER"@"MixedTenant"');
  });
  it("does not leak a supplied password in backend errors", async () => {
    await mount();
    await ready();
    await createForm();
    mocks.executeQuery.mockRejectedValueOnce(new Error('rejected IDENTIFIED BY "local-test-secret"'));
    submit();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("[redacted]"));
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("local-test-secret");
  });
  it("does not leak a password prefix from a truncated OceanBase SQL error", async () => {
    await mount();
    await ready();
    await createForm();
    mocks.executeQuery.mockRejectedValueOnce(new Error('syntax error near IDENTIFIED BY "local-test-se'));
    submit();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("[redacted]"));
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("local-test-se");
  });
  it("does not send a late identity lookup to a newly selected connection", async () => {
    const pending = deferred<(typeof link)[]>();
    const { state } = await mount({ list: vi.fn((id: string) => (id === "a" ? pending.promise : Promise.resolve([{ ...link, name: "B_LINK", owner: "B_USER" }]))) });
    state.connectionId = "b";
    await nextTick();
    await ready();
    pending.resolve([link]);
    await nextTick();
    await nextTick();
    const identityRequests = mocks.executeQuery.mock.calls.filter((call) => String(call[2]).includes("SESSION_USER"));
    expect(identityRequests).toHaveLength(1);
    expect(identityRequests[0][0]).toBe("b");
    expect(document.body.textContent).toContain("B_LINK");
    expect(document.body.textContent).not.toContain("A_USER");
  });
  it("ignores a write failure belonging to the previous connection", async () => {
    const { state, changed } = await mount();
    await ready();
    await createForm();
    const pending = deferred<never>();
    mocks.executeQuery.mockImplementationOnce(() => pending.promise);
    submit();
    await vi.waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledTimes(2));
    state.connectionId = "b";
    await nextTick();
    await ready();
    pending.reject(new Error("old-target failure"));
    await nextTick();
    await nextTick();
    expect(changed).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("old-target failure");
    expect(button("databaseLinks.create").disabled).toBe(false);
  });
  it("revalidates the target after awaiting read-only unlock approval", async () => {
    const { state, changed } = await mount({ readonly: true });
    await ready();
    await createForm();
    const pending = deferred<boolean>();
    const unlock = vi.spyOn(useReadOnlyUnlockStore(), "requestUnlock").mockImplementation(() => pending.promise);
    submit();
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
    state.connectionId = "b";
    await nextTick();
    await ready();
    pending.resolve(true);
    await nextTick();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("CREATE"))).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
  it("does not test a public link shadowed by the login user's private link", async () => {
    await mount({ dbType: "oracle", owner: "PUBLIC", name: "REMOTE", list: vi.fn(async () => [link, { ...link, owner: "PUBLIC" }]) });
    await ready();
    expect(button("databaseLinks.test").disabled).toBe(true);
    expect(document.body.textContent).toContain("databaseLinks.shadowed");
  });
  it("allows testing but not deleting an OceanBase link created by another user", async () => {
    await mount({ owner: "PUBLIC", name: "REMOTE", list: vi.fn(async () => [{ ...link, owner: "PUBLIC", canDrop: false }]) });
    await ready();
    expect(button("databaseLinks.test").disabled).toBe(false);
    expect(button("common.delete").disabled).toBe(true);
    expect(document.body.textContent).toContain("databaseLinks.oceanbaseSharedReadOnly");
  });
});
