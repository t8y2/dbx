// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostgresForeignTableDraft } from "@/lib/table/postgresForeignTable";

const mocks = vi.hoisted(() => ({ executeQuery: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ executeQuery: mocks.executeQuery }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    props: { modelValue: String, options: Array, disabled: Boolean },
    emits: ["update:modelValue"],
    setup:
      (props, { emit }) =>
      () =>
        h("div", [
          h("input", { "data-server-picker": "", value: props.modelValue, disabled: props.disabled, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
          h(
            "datalist",
            (props.options ?? []).map((option) => h("option", { value: String(option) })),
          ),
        ]),
  }),
}));
import PostgresForeignTableOptionsEditor from "@/components/structure/PostgresForeignTableOptionsEditor.vue";

const apps: App[] = [];
const result = (names: string[]) => ({ columns: ["name", "wrapper"], rows: names.map((name) => [name, "postgres_fdw"]) });
beforeEach(() => {
  mocks.executeQuery.mockReset();
  mocks.executeQuery.mockResolvedValue(result(["remote server"]));
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
});

async function mountEditor(initial: PostgresForeignTableDraft = { enabled: true, server: "", options: [] }) {
  const scope = reactive({ connectionId: "conn-a", database: "db-a", catalog: "catalog-a", disabled: false });
  const draft = ref(initial);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () =>
      h(PostgresForeignTableOptionsEditor, {
        ...scope,
        modelValue: draft.value,
        "onUpdate:modelValue": (value) => {
          draft.value = value;
        },
      }),
  });
  apps.push(app);
  app.mount(host);
  await nextTick();
  return { host, scope, draft };
}

function button(host: HTMLElement, key: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === key || item.title === key)!;
}

function inputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PostgreSQL foreign table options editor", () => {
  it("loads server choices in the selected database and updates the draft", async () => {
    const { host, draft } = await mountEditor();
    await vi.waitFor(() => expect(host.querySelector("option")?.getAttribute("value")).toBe("remote server"));
    expect(mocks.executeQuery).toHaveBeenCalledWith("conn-a", "db-a", expect.any(String), undefined, undefined, { catalog: "catalog-a", maxRows: 10000 });
    inputValue(host.querySelector("[data-server-picker]")!, 'server"name');
    await nextTick();
    button(host, "postgresForeignTable.addOption").click();
    await nextTick();
    const inputs = host.querySelectorAll<HTMLInputElement>("[data-foreign-table-option] input");
    inputValue(inputs[0]!, "schema_name");
    inputValue(inputs[1]!, "remote's schema");
    await nextTick();
    expect(draft.value.server).toBe('server"name');
    expect(draft.value.options).toEqual([{ name: "schema_name", value: "remote's schema" }]);
    button(host, "common.delete").click();
    await nextTick();
    expect(draft.value.options).toEqual([]);
  });

  it("keeps a restored server and options when metadata loading fails", async () => {
    mocks.executeQuery.mockRejectedValue(new Error("permission denied"));
    const initial = { enabled: true, server: "saved server", options: [{ name: "filename", value: "/data/input.csv" }] };
    const { host, draft } = await mountEditor(initial);
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).toBeTruthy());
    expect(draft.value).toEqual(initial);
    expect(host.querySelector<HTMLInputElement>("[data-server-picker]")!.value).toBe("saved server");
  });

  it("discards stale choices when the target database changes", async () => {
    let old!: (value: ReturnType<typeof result>) => void;
    mocks.executeQuery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    );
    const { host, scope } = await mountEditor();
    mocks.executeQuery.mockResolvedValue(result(["new server"]));
    scope.database = "db-b";
    await nextTick();
    await vi.waitFor(() => expect(host.querySelector("option")?.value).toBe("new server"));
    old(result(["old server"]));
    await nextTick();
    await nextTick();
    expect([...host.querySelectorAll("option")].map((option) => option.value)).toEqual(["new server"]);
  });
});
