// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { expect, it, vi } from "vitest";

vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/grid/DataGrid.vue", () => ({ default: { render: () => null } }));

import ContentArea from "../ContentArea.vue";

it("ignores a Mongo script request while the editor ref is a loading component and requires a fresh request when ready", async () => {
  const requestExecuteMongoScript = vi.fn(() => true);
  const ready = ref(false);
  const Loading = defineComponent({ render: () => h("div", "Loading editor") });
  const Editor = defineComponent({
    setup(_, { expose }) {
      expose({ requestExecuteMongoScript });
      return () => h("div", "Editor ready");
    },
  });
  // Exercise ContentArea's real exposed action with the same component-ref
  // transition as its asynchronous QueryEditor loading component.
  const Surface = {
    ...ContentArea,
    render() {
      return h(ready.value ? Editor : Loading, { ref: "queryEditorRef" });
    },
  };
  const pinia = createPinia();
  setActivePinia(pinia);
  const surface = ref<InstanceType<typeof ContentArea>>();
  const app = createApp({
    render: () =>
      h(Surface, {
        ref: surface,
        activeTab: { id: "mongo", title: "Mongo", connectionId: "mongo", database: "app", mode: "query", sql: "print(1)", isExecuting: false },
        activeConnection: null,
        activeOutputView: "result",
        executableSql: "",
        formatSqlRequest: null,
        compressSqlRequest: null,
        keywordCaseRequest: null,
        selectedSql: "",
        cursorPos: 0,
        blockDangerousRedisCommands: false,
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  try {
    app.mount(host);
    await nextTick();
    expect(host.textContent).toBe("Loading editor");
    expect(surface.value!.requestQueryEditorExecuteMongoScript()).toBe(false);
    expect(requestExecuteMongoScript).not.toHaveBeenCalled();

    ready.value = true;
    await nextTick();
    expect(host.textContent).toBe("Editor ready");
    expect(requestExecuteMongoScript).not.toHaveBeenCalled();
    expect(surface.value!.requestQueryEditorExecuteMongoScript()).toBe(true);
    expect(requestExecuteMongoScript).toHaveBeenCalledTimes(1);
  } finally {
    app.unmount();
    host.remove();
    localStorage.clear();
  }
});
