// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import McpDefaultAccessPanel from "../McpDefaultAccessPanel.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import type { McpExecutionMode } from "@/lib/mcp/mcpPolicySelection";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((unmount) => unmount()));

function mountPanel(initial: { mode?: McpExecutionMode; disabled?: boolean; acceptMode?: boolean } = {}) {
  const props = reactive({ mode: initial.mode ?? "read_only", disabled: initial.disabled ?? false });
  const setMode = vi.fn((mode: McpExecutionMode) => {
    if (initial.acceptMode !== false) props.mode = mode;
  });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({ render: () => h(McpDefaultAccessPanel, { ...props, "onSet:mode": setMode }) });
  app.mount(root);
  cleanup.push(() => {
    app.unmount();
    root.remove();
  });
  const radio = (mode: McpExecutionMode) => root.querySelector<HTMLButtonElement>(`[data-mcp-execution-mode="${mode}"]`)!;
  return { root, props, setMode, radio };
}

describe("McpDefaultAccessPanel", () => {
  it("shows three permissions and starts with the explanation table collapsed", () => {
    const { root, radio } = mountPanel();
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(radio("read_only").getAttribute("aria-checked")).toBe("true");
    expect(radio("read_only").tabIndex).toBe(0);
    expect(radio("safe_write").tabIndex).toBe(-1);
    expect(root.querySelector<HTMLDetailsElement>("[data-mcp-permission-help]")!.open).toBe(false);
    expect(root.querySelector("[data-mcp-high-risk-confirmation]")).toBeNull();
  });

  it("updates permissions without exposing call-safety controls in the default panel", async () => {
    const { root, radio, setMode } = mountPanel();
    radio("safe_write").click();
    await nextTick();
    expect(setMode).toHaveBeenCalledExactlyOnceWith("safe_write");
    expect(radio("safe_write").getAttribute("aria-checked")).toBe("true");
    expect(root.querySelector("[data-mcp-mode-description]")!.textContent).toContain("settings.mcpExecutionModeSafeWriteDescription");
    expect(root.querySelector("[data-mcp-high-risk-confirmation]")).toBeNull();
  });

  it("explains that creating connections allows data-write access but removal requires full access", async () => {
    const { root } = mountPanel({ mode: "safe_write" });
    root.querySelector<HTMLElement>("[data-mcp-permission-help] summary")!.click();
    await nextTick();
    const rows = Array.from(root.querySelectorAll("tbody tr"));
    const permissions = (label: string) => {
      const row = rows.find((candidate) => candidate.querySelector("th")?.textContent === label)!;
      return Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.trim());
    };
    expect(permissions("settings.mcpCapabilityConnectionCreate")).toEqual(["settings.mcpCapabilityBlocked", "settings.mcpCapabilityAllowed", "settings.mcpCapabilityAllowed"]);
    expect(permissions("settings.mcpCapabilityConnectionRemove")).toEqual(["settings.mcpCapabilityBlocked", "settings.mcpCapabilityBlocked", "settings.mcpCapabilityAllowed"]);
  });

  it("supports arrow, Home and End navigation with focus on the selected radio", async () => {
    const { radio } = mountPanel();
    for (const [from, key, to] of [
      ["read_only", "ArrowRight", "safe_write"],
      ["safe_write", "End", "high_risk_write"],
      ["high_risk_write", "ArrowRight", "read_only"],
      ["read_only", "ArrowLeft", "high_risk_write"],
      ["high_risk_write", "Home", "read_only"],
    ] as const) {
      radio(from).focus();
      radio(from).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await nextTick();
      expect(document.activeElement).toBe(radio(to));
      expect(radio(to).getAttribute("aria-checked")).toBe("true");
      expect(radio(to).tabIndex).toBe(0);
    }
  });

  it("keeps focus and selection when the parent cancels the full-access change", async () => {
    const { radio, setMode } = mountPanel({ mode: "safe_write", acceptMode: false });
    radio("safe_write").focus();
    radio("safe_write").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(setMode).toHaveBeenCalledExactlyOnceWith("high_risk_write");
    expect(radio("safe_write").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radio("safe_write"));
  });

  it("moves keyboard focus into the real confirmation dialog and preserves selection on cancellation", async () => {
    const state = reactive({ mode: "safe_write" as McpExecutionMode, pending: false });
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp({
      render: () =>
        h("div", [
          h(McpDefaultAccessPanel, {
            mode: state.mode,
            "onSet:mode": (mode) => {
              if (mode === "high_risk_write") state.pending = true;
              else state.mode = mode;
            },
          }),
          h(DangerConfirmDialog, {
            open: state.pending,
            initialFocus: "cancel",
            closeOnConfirm: false,
            "onUpdate:open": (open) => {
              state.pending = open;
            },
            onConfirm: () => {
              state.pending = false;
              state.mode = "high_risk_write";
            },
          }),
        ]),
    });
    app.mount(root);
    cleanup.push(() => {
      app.unmount();
      root.remove();
    });
    const radio = root.querySelector<HTMLButtonElement>('[data-mcp-execution-mode="safe_write"]')!;
    radio.focus();
    radio.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("dangerDialog.cancel"));
    expect(state.mode).toBe("safe_write");
    (document.activeElement as HTMLButtonElement).click();
    await vi.waitFor(() => expect(state.pending).toBe(false));
    expect(radio.getAttribute("aria-checked")).toBe("true");
    await vi.waitFor(() => expect(document.activeElement).toBe(radio));
    radio.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("dangerDialog.cancel"));
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.trim() === "dangerDialog.confirm")!;
    confirm.click();
    await vi.waitFor(() => expect(state.mode).toBe("high_risk_write"));
  });

  it("disables edits while settings are loading or saving", async () => {
    const { radio, setMode } = mountPanel({ mode: "safe_write", disabled: true });
    expect(radio("read_only").disabled).toBe(true);
    radio("read_only").click();
    radio("safe_write").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(setMode).not.toHaveBeenCalled();
  });
});
