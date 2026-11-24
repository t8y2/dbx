// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import Banner from "./StructureErrorBanner.vue";

it("keeps a long create error compact, supports dismissal and shows the same error on retry", async () => {
  const conflict = "Agent RPC error (-1): [TABLE_OR_VIEW_ALREADY_EXISTS] Cannot create table or view `ods`.`test` because it already exists.";
  const log = conflict + " at org.apache.spark.CreateTableExec.run(CreateTableExec.scala:50)".repeat(200);
  const message = ref(log);
  const root = document.createElement("div");
  const app = createApp({ render: () => h(Banner, { message: message.value }) });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          structureEditor: { tableNameConflict: "{name} already exists. Choose a different name." },
          diff: { details: "Details" },
          common: { close: "Close" },
        },
      },
    }),
  );
  app.mount(root);
  try {
    expect(root.querySelector("[role=alert]")?.textContent).toContain("`ods`.`test` already exists");
    expect(root.querySelector("pre")).toBeNull();
    root.querySelector<HTMLButtonElement>("[aria-expanded]")!.click();
    await nextTick();
    expect(root.querySelector("pre")?.textContent).toBe(log);
    root.querySelector<HTMLButtonElement>("[aria-label=Close]")!.click();
    await nextTick();
    expect(root.querySelector("button")).toBeNull();
    message.value = "";
    await nextTick();
    message.value = log;
    await nextTick();
    expect(root.querySelector("[role=alert]")).not.toBeNull();
    expect(root.querySelector("pre")).toBeNull();
  } finally {
    app.unmount();
  }
});
