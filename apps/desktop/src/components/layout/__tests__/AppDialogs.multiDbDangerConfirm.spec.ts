// @vitest-environment happy-dom
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import MultiDbDangerConfirmDialog from "@/components/layout/MultiDbDangerConfirmDialog.vue";
import type { SqlExecutionDangerRequest } from "@/stores/sqlExecutionDangerStore";

const mocks = vi.hoisted(() => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copyToClipboard }));

function request(overrides: Partial<SqlExecutionDangerRequest> = {}): SqlExecutionDangerRequest {
  return {
    sql: "UPDATE accounts SET balance = 0",
    kind: "sql",
    connectionName: "prod-a",
    database: "shop",
    targetLabel: "prod-a / shop",
    ...overrides,
  };
}

function mountDialog(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(MultiDbDangerConfirmDialog, props) });
  app.use(i18n);
  app.mount(host);
  return { host, app };
}

let mounted: { host: HTMLElement; app: App } | undefined;

afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = undefined;
  mocks.copyToClipboard.mockClear();
});

/** The dialog content is portaled to the document body. */
function codeValue(): string {
  return document.body.querySelector("[data-multi-db-danger-code-value]")?.textContent?.trim() ?? "";
}

function codeInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>("[data-multi-db-danger-code]");
  if (!input) throw new Error("Missing code input");
  return input;
}

function confirmButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === i18n.global.t("multiDbExecute.dangerConfirm"));
  if (!button) throw new Error("Missing confirm button");
  return button;
}

async function typeCode(value: string) {
  const input = codeInput();
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

describe("multi-database batch confirmation", () => {
  it("lists every data source of the batch next to the target that prompted", async () => {
    mounted = mountDialog({ request: request({ targets: ["prod-a / shop", "prod-b / shop", "prod-c / shop"] }) });
    await nextTick();

    const text = document.body.textContent ?? "";
    expect(text).toContain("prod-a / shop");
    expect(text).toContain(i18n.global.t("multiDbExecute.dangerTargets", { count: 3 }));
    expect(text).toContain("• prod-b / shop");
    expect(text).toContain("• prod-c / shop");
    expect(document.body.textContent).toContain("UPDATE accounts SET balance = 0");
  });

  it("keeps the headline only when the statement touches a single source", async () => {
    mounted = mountDialog({ request: request({ targets: ["prod-a / shop"] }) });
    await nextTick();

    expect(document.body.textContent).not.toContain(i18n.global.t("multiDbExecute.dangerTargets", { count: 1 }));
    expect(document.body.textContent).toContain("prod-a / shop");
  });

  it("unlocks the confirm button only for the code of this prompt", async () => {
    mounted = mountDialog({ request: request() });
    await nextTick();

    const code = codeValue();
    expect(code).toHaveLength(6);
    expect(confirmButton().disabled).toBe(true);

    await typeCode("WRONG1");
    expect(confirmButton().disabled).toBe(true);

    await typeCode(code);
    expect(confirmButton().disabled).toBe(false);
  });

  it("accepts a code typed in lower case", async () => {
    mounted = mountDialog({ request: request() });
    await nextTick();

    await typeCode(codeValue().toLowerCase());
    expect(confirmButton().disabled).toBe(false);
  });

  it("copies the displayed code and clears the typed attempt for a new prompt", async () => {
    mounted = mountDialog({ request: request() });
    await nextTick();

    const firstCode = codeValue();
    await typeCode(firstCode);
    (document.body.querySelector("[data-multi-db-danger-code-copy]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(firstCode));

    // The next prompt is a fresh confirmation, not the previous one re-armed.
    mounted.app.unmount();
    mounted.host.remove();
    mounted = mountDialog({ request: request({ sql: "DELETE FROM accounts" }) });
    await nextTick();
    const nextCode = codeValue();
    expect(nextCode).toHaveLength(6);
    expect(codeInput().value).toBe("");
    expect(confirmButton().disabled).toBe(true);
  });

  it("reports confirm and cancel back to the batch", async () => {
    const events: string[] = [];
    mounted = mountDialog({
      request: request(),
      onConfirm: () => events.push("confirm"),
      onCancel: () => events.push("cancel"),
    });
    await nextTick();

    // Cancelling the prompt answers the batch without running it.
    const cancel = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === i18n.global.t("dangerDialog.cancel"));
    cancel?.click();
    await nextTick();
    expect(events).toEqual(["cancel"]);

    await typeCode(codeValue());
    confirmButton().click();
    await nextTick();
    expect(events).toEqual(["cancel", "confirm"]);
  });

  it("still confirms the single-connection danger dialog without any code", async () => {
    const { default: DangerConfirmDialog } = await import("@/components/editor/DangerConfirmDialog.vue");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const confirms: number[] = [];
    const app = createApp({ render: () => h(DangerConfirmDialog, { open: true, title: "Drop table", message: "This cannot be undone", onConfirm: () => confirms.push(1) }) });
    app.use(i18n);
    app.mount(host);
    try {
      await nextTick();
      expect(document.body.querySelector("[data-multi-db-danger-code]")).toBeNull();
      const confirm = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === i18n.global.t("dangerDialog.confirm"));
      expect(confirm).toBeDefined();
      confirm?.click();
      await nextTick();
      expect(confirms).toEqual([1]);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
