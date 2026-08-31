// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToSchemaDiffObjects, groupDiffObjects, type SchemaDiffObject } from "@/lib/schema/schemaDiff";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, params?: { selected: number; total: number }) => (params ? `${key}:${params.selected}/${params.total}` : key) }) }));

import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SchemaDiffObjectTree", () => {
  it("renders operation -> table -> field/index selection without a database root", async () => {
    const groups = groupDiffObjects(
      convertToSchemaDiffObjects([
        {
          type: "modified",
          objectType: "table",
          name: "users",
          columns: [
            { type: "modified", name: "email" },
            { type: "added", name: "nickname" },
          ],
          indexes: [{ type: "removed", name: "idx_legacy" }],
        },
      ]),
    );
    const toggles: Array<{ object: SchemaDiffObject; selected: boolean }> = [];
    const host = document.createElement("div");
    document.body.append(host);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(SchemaDiffObjectTree, {
              groups,
              selectedObjectId: null,
              onToggleObjectSelection: (object: SchemaDiffObject, selected: boolean) => toggles.push({ object, selected }),
            });
        },
      }),
    );
    mountedApps.push(app);
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain("diff.operationLabel.create");
    expect(host.textContent).toContain("diff.operationLabel.delete");
    expect(host.textContent).not.toContain("database");

    const tableExpandButtons = new Set(
      Array.from(host.querySelectorAll("span"))
        .filter((element) => element.textContent === "users")
        .map((element) => element.closest(".grid")?.querySelector("button") as HTMLButtonElement),
    );
    for (const button of tableExpandButtons) button.click();
    await nextTick();

    const tableSides = Array.from(host.querySelectorAll("span"))
      .filter((element) => element.textContent === "users")
      .map((element) => element.parentElement)
      .filter((element): element is HTMLElement => element !== null);
    expect(tableSides.length).toBeGreaterThan(0);
    expect(tableSides.every((element) => element.classList.contains("pl-6"))).toBe(true);

    const emailSides = Array.from(host.querySelectorAll("span")).filter((element) => element.textContent === "email");
    expect(emailSides).toHaveLength(2);
    expect(emailSides.every((element) => element.parentElement?.classList.contains("pl-16"))).toBe(true);

    const nickname = Array.from(host.querySelectorAll("span")).find((element) => element.textContent === "nickname");
    expect(nickname).toBeTruthy();
    const nicknameCheckbox = nickname?.closest(".grid")?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    nicknameCheckbox.checked = false;
    nicknameCheckbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(toggles.at(-1)?.object.id).toBe("col-users-nickname");
    expect(toggles.at(-1)?.selected).toBe(false);
  });
});
