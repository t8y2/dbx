// @vitest-environment happy-dom

import { createApp, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

import MongoSqlConvertDialog from "@/components/editor/MongoSqlConvertDialog.vue";

async function mount(sql: string) {
  const events: Array<[string, unknown]> = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  createApp({
    render: () =>
      h(MongoSqlConvertDialog, {
        open: true,
        sql,
        "onUpdate:open": (open: boolean) => events.push(["open", open]),
        onOpenInNewTab: (shell: string) => events.push(["newTab", shell]),
        onReplace: (shell: string) => events.push(["replace", shell]),
      }),
  }).mount(root);
  for (let i = 0; i < 4; i++) await nextTick();
  return events;
}

describe("MongoSqlConvertDialog", () => {
  it("shows the translated shell and sends it to a new tab", async () => {
    const events = await mount("SELECT name FROM users WHERE status = true LIMIT 5");
    const output = document.querySelector("[data-mongo-sql-convert-output]");
    expect(output?.textContent).toContain("db.users.find(");
    expect(output?.textContent).toContain(".limit(5)");
    document.querySelector<HTMLButtonElement>('[data-mongo-sql-convert] [data-action="new-tab"]')!.click();
    expect(events[0]?.[0]).toBe("newTab");
    expect(String(events[0]?.[1])).toContain("db.users.find(");
    expect(events).toContainEqual(["open", false]);
  });

  it("explains unsupported SQL instead of converting it", async () => {
    document.body.innerHTML = "";
    await mount("SELECT UPPER(name) FROM users");
    expect(document.querySelector("[data-mongo-sql-convert-error]")?.textContent).toContain("UPPER");
    expect(document.querySelector<HTMLButtonElement>('[data-mongo-sql-convert] [data-action="replace"]')!.disabled).toBe(true);
  });
});

describe("MongoSqlConvertDialog formatting", () => {
  it("keeps one space after keys but leaves string contents alone", async () => {
    document.body.innerHTML = "";
    await mount("SELECT * FROM users WHERE note = 'a:  b' AND status = true");
    const text = document.querySelector("[data-mongo-sql-convert-output]")?.textContent ?? "";
    expect(text).not.toMatch(/status: {2}/);
    expect(text).toContain("status: true");
    expect(text).toContain('"a:  b"');
  });
});
