// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OracleRoleAdmin from "@/components/admin/OracleRoleAdmin.vue";
import type { ConnectionConfig } from "@/types/database";
import type { OracleRoleRequest } from "@/lib/database/oracleRoleAdmin";

const mocks = vi.hoisted(() => ({ oracleRoleAdmin: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ oracleRoleAdmin: (...args: unknown[]) => mocks.oracleRoleAdmin(...args) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => mocks.guard(options) }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        h("button", attrs, slots.default?.()),
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const box = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", { role: "dialog" }, slots.default?.()) : null,
    }),
    DialogContent: box,
    DialogFooter: box,
    DialogHeader: box,
    DialogTitle: box,
  };
});
let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement;
function mount(extra: Record<string, unknown> = {}) {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(OracleRoleAdmin, { connection: { id: "a", name: "Oracle", db_type: "oracle", database: "svc" } as ConnectionConfig, initialPrincipal: "U", ...extra });
  app.use(createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: { common: { showPassword: "Show password", hidePassword: "Hide password" } } } }));
  app.mount(root);
}
async function settle() {
  for (let index = 0; index < 14; index++) {
    await Promise.resolve();
    await nextTick();
  }
}
async function click(label: string) {
  const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
  await settle();
}
async function select(label: string, value: string) {
  const element = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
beforeEach(() => {
  mocks.guard.mockReset().mockImplementation((options) => options.execute());
  mocks.oracleRoleAdmin.mockReset().mockImplementation(async (_id, _database, request: OracleRoleRequest) =>
    request.operation === "preview"
      ? {
          revision: "rev",
          before: {},
          sources: [],
          requiresPassword: request.change.authentication === "password",
          steps: [{ label: request.change.action, sql: request.change.authentication === "password" ? 'ALTER ROLE "U" IDENTIFIED BY "<password omitted>"' : 'REVOKE CREATE SESSION FROM "U"' }],
        }
      : { outcome: "verified", sentSteps: [request.change.action], completedSteps: [request.change.action], remainingSources: [{ source: "role", grant: { GRANTEE: "R", PRIVILEGE: "CREATE SESSION" } }] },
  );
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
});

describe("OracleRoleAdmin", () => {
  it("limits a table entry to its exact object and excludes role lifecycle actions", async () => {
    mount({ objectScope: { owner: "Case.Owner", name: 'Table"Name' } });
    await settle();
    expect(root.querySelector('option[value="dropRole"]')).toBeNull();
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Grant kind"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Object owner"]')?.disabled).toBe(true);
    await click("Preview role or grant change");
    expect(mocks.oracleRoleAdmin.mock.calls[0][2].change).toMatchObject({ action: "grant", kind: "object", owner: "Case.Owner", objectName: 'Table"Name', privilege: "SELECT", principal: "U" });
  });
  it("never writes on mount and cancels a preview without apply", async () => {
    mount();
    await settle();
    expect(mocks.oracleRoleAdmin).not.toHaveBeenCalled();
    await select("Role action", "revoke");
    await click("Preview role or grant change");
    await click("Cancel");
    expect(mocks.oracleRoleAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.guard).not.toHaveBeenCalled();
  });
  it("keeps remaining inherited privileges visible after a direct revoke", async () => {
    mount();
    await select("Role action", "revoke");
    await click("Preview role or grant change");
    await click("Apply reviewed change");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Remaining direct, role or PUBLIC sources");
    expect(root.querySelector('[role="status"]')?.textContent).toContain('"source": "role"');
  });
  it("sends a role password only with apply and keeps production confirmation redacted", async () => {
    mount();
    await select("Role action", "alterRole");
    await select("Role authentication", "password");
    const input = root.querySelector<HTMLInputElement>("input[data-password-input]")!;
    input.value = "private-role-password";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await click("Preview role or grant change");
    expect(JSON.stringify(mocks.oracleRoleAdmin.mock.calls[0][2])).not.toContain("private-role-password");
    await click("Apply reviewed change");
    expect(mocks.oracleRoleAdmin.mock.calls[1][2].password).toBe("private-role-password");
    expect(mocks.guard.mock.calls[0][0].reviewText).not.toContain("private-role-password");
    expect(input.value).toBe("");
  });
  it("disables apply when only inherited rights are present", async () => {
    mocks.oracleRoleAdmin.mockResolvedValue({ blocked: "No matching direct grant exists", before: {}, sources: [{ source: "role" }] });
    mount();
    await select("Role action", "revoke");
    await click("Preview role or grant change");
    const button = Array.from(root.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Apply reviewed change");
    expect(button?.disabled).toBe(true);
    expect(root.textContent).toContain("No matching direct grant exists");
  });
});
