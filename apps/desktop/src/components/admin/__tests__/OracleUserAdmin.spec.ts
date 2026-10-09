// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleUserAdmin from "@/components/admin/OracleUserAdmin.vue";
import type { ConnectionConfig } from "@/types/database";
import type { OracleUserRequest } from "@/lib/database/oracleUserAdmin";

const mocks = vi.hoisted(() => ({ oracleUserAdmin: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ oracleUserAdmin: (...args: unknown[]) => mocks.oracleUserAdmin(...args) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/components/ui/button", () => ({ Button: defineComponent({ setup: (_, { attrs, slots }) => () => h("button", attrs, slots.default?.()) }) }));
vi.mock("@/components/ui/dialog", () => {
  const box = defineComponent({ setup: (_, { slots }) => () => h("div", slots.default?.()) });
  return { Dialog: defineComponent({ props: { open: Boolean }, setup: (props, { slots }) => () => props.open ? h("div", { role: "dialog" }, slots.default?.()) : null }), DialogContent: box, DialogFooter: box, DialogHeader: box, DialogTitle: box };
});
let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;
function mount() {
  root = document.createElement("div"); document.body.append(root);
  app = createApp(OracleUserAdmin, { connection: { id: "a", name: "Oracle", db_type: "oracle", database: "svc" } as ConnectionConfig, selectedName: 'Mixed."User' });
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: { common: { showPassword: "Show password", hidePassword: "Hide password" } } } })); app.mount(root);
}
async function settle() { for (let index = 0; index < 12; index++) { await Promise.resolve(); await nextTick(); } }
async function click(label: string) { const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label); expect(button).toBeDefined(); button!.click(); await settle(); }
async function choose(action: string) { const select = root.querySelector("select")!; select.value = action; select.dispatchEvent(new Event("change", { bubbles: true })); await settle(); }
async function enterPassword() { const input = root.querySelector<HTMLInputElement>("input[data-password-input]")!; input.value = "private-password"; input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); }
beforeEach(() => {
  mocks.guard.mockReset().mockImplementation((options) => options.execute());
  mocks.oracleUserAdmin.mockReset().mockImplementation(async (_id, _database, request: OracleUserRequest) => request.operation === "preview" ? { revision: "rev", requiresPassword: request.change.action === "password", before: { user: { USERNAME: request.change.name }, objects: [], dependencies: [], locked: false }, steps: [{ label: "password", sql: 'ALTER USER "Mixed.""User" IDENTIFIED BY "<password omitted>"' }] } : { outcome: "applied", sentSteps: ["password"], completedSteps: ["password"], authenticationVerified: false, after: { user: { USERNAME: request.change.name } } });
});
afterEach(() => { app?.unmount(); root?.remove(); app = undefined; });

describe("OracleUserAdmin", () => {
  it("does not request a mutation on mount and sends no password for a preview", async () => {
    mount(); await settle(); expect(mocks.oracleUserAdmin).not.toHaveBeenCalled();
    await choose("password"); await enterPassword(); await click("Preview user change");
    const preview = mocks.oracleUserAdmin.mock.calls[0][2];
    expect(preview.operation).toBe("preview"); expect(JSON.stringify(preview)).not.toContain("private-password");
    expect(root.querySelector('[role="dialog"]')?.textContent).not.toContain("private-password");
    await click("Cancel");
    expect(mocks.oracleUserAdmin).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLInputElement>("input[data-password-input]")?.value).toBe("");
  });
  it("sends the password only with apply and never puts it in the production confirmation", async () => {
    mount(); await choose("password"); await enterPassword(); await click("Preview user change"); await click("Apply reviewed change");
    expect(mocks.oracleUserAdmin.mock.calls[1][2]).toMatchObject({ operation: "apply", password: "private-password", revision: "rev" });
    expect(mocks.guard.mock.calls[0][0].reviewText).not.toContain("private-password");
    expect(root.querySelector<HTMLInputElement>("input[data-password-input]")?.value).toBe("");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("has not been tested");
  });
  it("does not apply a blocked deletion preview", async () => {
    mocks.oracleUserAdmin.mockResolvedValue({ blocked: "User owns objects; CASCADE is not permitted", before: { user: {}, objects: [{ OBJECT_NAME: "BUSINESS" }] } });
    mount(); await choose("drop"); await click("Preview user change");
    const apply = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Apply reviewed change");
    expect(apply?.disabled).toBe(true); expect(root.textContent).toContain("CASCADE is not permitted");
  });
  it("does not repeat a sensitive backend exception in ordinary diagnostics", async () => {
    mocks.oracleUserAdmin.mockRejectedValue(new Error("password-secret private-password"));
    mount(); await choose("password"); await enterPassword(); await click("Preview user change");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Credentials are omitted");
    expect(root.textContent).not.toContain("private-password");
  });
});
