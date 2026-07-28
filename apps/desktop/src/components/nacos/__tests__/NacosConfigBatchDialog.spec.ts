// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import NacosConfigBatchDialog from "@/components/nacos/NacosConfigBatchDialog.vue";
import type { NacosBatchReport } from "@/types/nacos";

const mountedApps: App[] = [];

async function mountDialog(
  targetConnectionId: string,
  namespaces = [
    { namespace: "shared", namespaceShowName: "Shared" },
    { namespace: "remote-only", namespaceShowName: "Remote only" },
  ],
  report: NacosBatchReport | null = null,
) {
  const onTargetConnectionChange = vi.fn();
  const onPreview = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(NacosConfigBatchDialog, {
          open: true,
          mode: "copy",
          loading: false,
          selectedCount: 1,
          filteredCount: 1,
          targetConnections: [
            { id: "source", label: "Source" },
            { id: "remote", label: "Remote" },
          ],
          targetConnectionId,
          sourceConnectionId: "source",
          currentNamespace: "shared",
          namespaces,
          preview: null,
          report,
          onTargetConnectionChange,
          onPreview,
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await nextTick();
  return { onTargetConnectionChange, onPreview };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("NacosConfigBatchDialog cross-connection sync", () => {
  it("keeps a same-named namespace available when the target is another connection", async () => {
    const { onPreview } = await mountDialog("remote");
    const selects = Array.from(document.body.querySelectorAll("select")) as HTMLSelectElement[];
    const targetNamespaceValues = Array.from(selects[1].options).map((option) => option.value);

    expect(targetNamespaceValues).toContain(JSON.stringify("shared"));

    Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Preview"))
      ?.click();
    await nextTick();
    expect(onPreview).toHaveBeenCalledWith({
      scope: "selected",
      targetConnectionId: "remote",
      targetNamespace: "shared",
      policy: "ABORT",
    });
  });

  it("excludes the source namespace only for same-connection sync and emits connection changes", async () => {
    const { onTargetConnectionChange } = await mountDialog("source");
    const selects = Array.from(document.body.querySelectorAll("select")) as HTMLSelectElement[];
    const targetNamespaceValues = Array.from(selects[1].options).map((option) => option.value);

    expect(targetNamespaceValues).not.toContain(JSON.stringify("shared"));
    selects[0].value = "remote";
    selects[0].dispatchEvent(new Event("change"));
    await nextTick();
    expect(onTargetConnectionChange).toHaveBeenCalledWith("remote");
  });

  it("can select the public namespace on another connection", async () => {
    const { onPreview } = await mountDialog("remote", [{ namespace: "", namespaceShowName: "public" }]);

    Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Preview"))
      ?.click();
    await nextTick();
    expect(onPreview).toHaveBeenCalledWith({
      scope: "selected",
      targetConnectionId: "remote",
      targetNamespace: "",
      policy: "ABORT",
    });
  });

  it("shows an accurate result summary and a localized status for every processed config", async () => {
    await mountDialog("remote", undefined, {
      operationId: "sync-result",
      total: 3,
      created: 1,
      overwritten: 0,
      skipped: 1,
      failed: 1,
      aborted: false,
      partial: true,
      cancelled: false,
      items: [
        { namespace: "target", group: "DEFAULT_GROUP", dataId: "created.yaml", status: "created" },
        { namespace: "target", group: "DEFAULT_GROUP", dataId: "skipped.yaml", status: "skipped" },
        { namespace: "target", group: "DEFAULT_GROUP", dataId: "failed.yaml", status: "failed", message: "target unavailable" },
      ],
    });

    expect(document.body.textContent).toContain("Sync partially completed: 1 written, 1 failed");
    expect(document.body.textContent).toContain("Configuration details (3)");
    expect(document.body.textContent).toContain("Created");
    expect(document.body.textContent).toContain("Skipped");
    expect(document.body.textContent).toContain("Failed");
    expect(document.body.textContent).toContain("target unavailable");
  });
});
