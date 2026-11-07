// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useReadOnlyUnlockStore } from "@/stores/readOnlyUnlockStore";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import OracleDatabaseLinksDialog from "../OracleDatabaseLinksDialog.vue";
import type { OracleDatabaseLinkScope } from "@/lib/database/oracleDatabaseLinks";

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
async function mount(options: { dbType?: DatabaseType; readonly?: boolean; list?: ReturnType<typeof vi.fn>; owner?: string; name?: string; scope?: OracleDatabaseLinkScope; createScopes?: OracleDatabaseLinkScope[] } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  vi.spyOn(store, "getConfig").mockImplementation((id) => ({ id, name: id, db_type: options.dbType ?? "oceanbase-oracle", read_only: options.readonly ?? false }) as ConnectionConfig);
  const list = vi.spyOn(store, "listOracleDatabaseLinks").mockImplementation(options.list ?? (async () => [link]));
  mocks.executeQuery.mockImplementation(async (connectionId: string, _database: string, sql: string) => ({ columns: ["VALUE"], rows: [[sql.includes("SESSION_USER") ? (connectionId === "a" ? "A_USER" : "B_USER") : 1]] }));
  const state = reactive({ connectionId: "a", database: "service", open: true, scope: options.scope });
  const changed = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(OracleDatabaseLinksDialog, { ...state, name: options.name, owner: options.owner, createScopes: options.createScopes, intent: options.createScopes ? "create" : "list", onChanged: changed }) });
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
  it("selects an aggregate creation target in the original form and refuses a foreign private target", async () => {
    const { list } = await mount({ dbType: "oracle", createScopes: [{ kind: "schema", schema: "A_USER" }, { kind: "schema", schema: "B_USER" }, { kind: "public" }] });
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    expect(list).not.toHaveBeenCalled();
    expect(button("common.save").disabled).toBe(true);
    const selector = document.querySelector<HTMLSelectElement>('select[aria-label="databaseLinks.owner"]')!;
    for (const [label, value] of [
      ["name", "LINK_NEW"],
      ["username", "REMOTE"],
      ["host", "//remote/service"],
      ["password", "local-test-secret"],
    ])
      await fill(`databaseLinks.${label}`, value);
    selector.value = JSON.stringify({ kind: "schema", schema: "B_USER" });
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    submit();
    await nextTick();
    expect(document.body.textContent).toContain("databaseLinks.privateSchemaUnavailable");
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("CREATE"))).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("local-test-secret");
  });
  it.each(["private", "public"] as const)("creates an explicitly chosen %s target without a separate dialog", async (kind) => {
    const { changed, list } = await mount({ dbType: "oracle", createScopes: [{ kind: "schema", schema: "A_USER" }, { kind: "public" }] });
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const selector = document.querySelector<HTMLSelectElement>('select[aria-label="databaseLinks.owner"]')!;
    selector.value = JSON.stringify(kind === "private" ? { kind: "schema", schema: "A_USER" } : { kind: "public" });
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    for (const [label, value] of [
      ["name", "LINK_NEW"],
      ["username", "REMOTE"],
      ["host", "//remote/service"],
      ["password", "local-test-secret"],
    ])
      await fill(`databaseLinks.${label}`, value);
    submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const request = mocks.executeQuery.mock.calls.find((call) => String(call[2]).startsWith("CREATE"));
    expect(request?.[2]).toContain(kind === "private" ? "CREATE DATABASE LINK" : "CREATE PUBLIC DATABASE LINK");
    expect(request?.[3]).toBe("A_USER");
    expect(list).not.toHaveBeenCalled();
  });
  it("invalidates pending confirmation when the aggregate creation target changes", async () => {
    const { changed } = await mount({ dbType: "oracle", readonly: true, createScopes: [{ kind: "schema", schema: "A_USER" }, { kind: "public" }] });
    await vi.waitFor(() => expect(document.querySelector("form")).not.toBeNull());
    const selector = document.querySelector<HTMLSelectElement>('select[aria-label="databaseLinks.owner"]')!;
    selector.value = JSON.stringify({ kind: "schema", schema: "A_USER" });
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    for (const [label, value] of [
      ["name", "LINK_NEW"],
      ["username", "REMOTE"],
      ["host", "//remote/service"],
      ["password", "local-test-secret"],
    ])
      await fill(`databaseLinks.${label}`, value);
    const pending = deferred<boolean>();
    const unlock = vi.spyOn(useReadOnlyUnlockStore(), "requestUnlock").mockImplementation(() => pending.promise);
    submit();
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
    selector.value = JSON.stringify({ kind: "public" });
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    pending.resolve(true);
    await vi.waitFor(() => expect(button("common.save").disabled).toBe(false));
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("CREATE"))).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
  it("does not label a failed first read as empty and recovers after an explicit refresh", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("catalog_denied")).mockResolvedValueOnce([]);
    await mount({ dbType: "oracle", scope: { kind: "public" }, list });
    await ready();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("catalog_denied");
    expect(document.body.textContent).not.toContain("databaseLinks.empty");
    button("common.refresh").click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("databaseLinks.empty"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("databaseLinks.empty");
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("reads a fixed public scope and preserves private-name shadow protection", async () => {
    const list = vi.fn().mockResolvedValue([{ ...link, owner: "PUBLIC", shadowedBySessionPrivate: true }]);
    await mount({ dbType: "oracle", scope: { kind: "public" }, name: link.name, owner: "PUBLIC", list });
    await ready();
    expect(list).toHaveBeenCalledWith("a", "service", { kind: "public" });
    expect(button("databaseLinks.test").disabled).toBe(true);
    button("databaseLinks.create").click();
    await nextTick();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("refuses private creation in a non-login scope instead of changing its owner", async () => {
    await mount({ dbType: "oracle", scope: { kind: "schema", schema: "OTHER" } });
    await ready();
    button("databaseLinks.create").click();
    await nextTick();
    expect(document.querySelector("form")).toBeNull();
    expect(document.body.textContent).toContain("databaseLinks.privateSchemaUnavailable");
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("CREATE"))).toBe(false);
  });
  it("makes a foreign private link read-only even with canDrop=true and a same-name own link", async () => {
    await mount({ dbType: "oracle", scope: { kind: "schema", schema: "B_USER" }, owner: "B_USER", name: "REMOTE", list: vi.fn(async () => [{ ...link, owner: "B_USER", canDrop: true }]) });
    await ready();
    expect(document.body.textContent).toContain("databaseLinks.foreignPrivateReadOnly");
    for (const action of ["databaseLinks.test", "databaseLinks.alter", "common.delete"]) {
      const control = button(action);
      expect(control.disabled).toBe(true);
      // Dispatch directly to exercise the handler guards, not only disabled HTML.
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await nextTick();
    }
    expect(document.querySelector("form")).toBeNull();
    expect(mocks.executeQuery.mock.calls.every((call) => String(call[2]).includes("SESSION_USER"))).toBe(true);
  });
  it("rechecks the selected private target after confirmation instead of executing a same-name link", async () => {
    await mount({ dbType: "oracle", readonly: true, name: "REMOTE", owner: "A_USER", list: vi.fn(async () => [link, { ...link, owner: "B_USER", canDrop: true }]) });
    await ready();
    const pending = deferred<boolean>();
    const unlock = vi.spyOn(useReadOnlyUnlockStore(), "requestUnlock").mockImplementation(() => pending.promise);
    button("common.delete").click();
    await nextTick();
    submit();
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
    const foreignRow = [...document.querySelectorAll("tbody tr")].find((row) => row.textContent?.includes("B_USER"));
    foreignRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    pending.resolve(true);
    await nextTick();
    await nextTick();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("DROP"))).toBe(false);
  });
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
  it("allows a confirmed delete attempt when OceanBase effective role permission is unknown", async () => {
    await mount({ owner: "PUBLIC", name: "REMOTE", list: vi.fn(async () => [{ ...link, owner: "PUBLIC", canDrop: undefined, permissionUnknown: true }]) });
    await ready();
    expect(button("databaseLinks.test").disabled).toBe(false);
    expect(button("common.delete").disabled).toBe(false);
    expect(document.body.textContent).toContain("databaseLinks.permissionUnknown");
    button("common.delete").click();
    await nextTick();
    expect(document.querySelector("form")).not.toBeNull();
    expect(mocks.executeQuery.mock.calls.some((call) => String(call[2]).startsWith("DROP"))).toBe(false);
  });
});
