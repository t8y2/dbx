// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const { resolveSshPromptMock } = vi.hoisted(() => ({
  resolveSshPromptMock: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({ resolveSshPrompt: resolveSshPromptMock }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  const dialog = defineComponent({
    props: { open: Boolean },
    setup(props, { slots }) {
      return () => (props.open ? h("div", slots.default?.()) : null);
    },
  });
  return {
    Dialog: dialog,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

import SshHostKeyPromptDialog from "@/components/ssh/SshHostKeyPromptDialog.vue";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

const mountedApps: App[] = [];

beforeEach(() => {
  resolveSshPromptMock.mockReset().mockResolvedValue(undefined);
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as Response));
  i18n.global.locale.value = "en";
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mountDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(SshHostKeyPromptDialog);
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
}

describe("SshHostKeyPromptDialog web bridge", () => {
  it("shows an SSE host-key prompt and posts the user's acceptance", async () => {
    await mountDialog();

    const eventSource = MockEventSource.instances[0];
    expect(eventSource?.url).toBe("/api/ssh/prompts");

    eventSource?.emit({
      type: "prompt",
      request: {
        id: "prompt-1",
        kind: "HostKeyVerify",
        host: "ssh.example.test",
        port: 22,
        key_type: "ssh-ed25519",
        fingerprint: "SHA256:test-fingerprint",
      },
    });
    await nextTick();

    expect(document.body.textContent).toContain("ssh.example.test:22");
    expect(document.body.textContent).toContain("SHA256:test-fingerprint");

    const buttons = document.body.querySelectorAll<HTMLButtonElement>("button");
    buttons.item(buttons.length - 1).click();

    await vi.waitFor(() => {
      expect(resolveSshPromptMock).toHaveBeenCalledWith({
        id: "prompt-1",
        action: "accept",
        remember: true,
        secret: undefined,
      });
    });
  });

  it("clears prompts that are no longer pending after an SSE reconnect snapshot", async () => {
    await mountDialog();

    const eventSource = MockEventSource.instances[0];
    eventSource?.emit({
      type: "prompt",
      request: {
        id: "prompt-2",
        kind: "HostKeyVerify",
        host: "stale.example.test",
        port: 22,
        key_type: "ssh-ed25519",
        fingerprint: "SHA256:stale",
      },
    });
    await nextTick();
    expect(document.body.textContent).toContain("stale.example.test:22");

    eventSource?.emit({ type: "sync", pendingIds: [] });
    await nextTick();
    expect(document.body.textContent).not.toContain("stale.example.test:22");
  });

  it("recovers a pending host-key prompt via the polling fallback when the SSE event is missed", async () => {
    // Simulate a prompt that fired before the EventSource was open: the backend
    // has it pending, but the SSE `Prompt` event never reached the dialog. The
    // polling fallback must surface it so the user can still confirm.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "prompt-3",
          kind: "HostKeyVerify",
          host: "first.example.test",
          port: 22,
          key_type: "ssh-ed25519",
          fingerprint: "SHA256:first",
        },
      ],
    } as Response);

    await mountDialog();
    await nextTick();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("first.example.test:22");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/ssh/prompts/pending", { credentials: "include" });
  });

  it("stops polling once the SSE stream opens and resumes it after an error", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    await mountDialog();
    const eventSource = MockEventSource.instances[0];

    // Polling is armed on mount (first-connect fallback).
    expect(setSpy).toHaveBeenCalled();

    // Opening the stream stops the poller (SSE replay now covers lost prompts).
    eventSource?.open();
    expect(clearSpy).toHaveBeenCalled();

    // A disconnect re-arms polling so prompts are not lost during the outage.
    eventSource?.error();
    expect(setSpy).toHaveBeenCalledTimes(2);
  });
});
