// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDrivers: vi.fn(),
  saveProfile: vi.fn(),
  testProfile: vi.fn(),
}));

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

function inputStub(): Component {
  return defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: [String, Number], default: "" } },
    emits: ["update:modelValue"],
    setup(props, { attrs, emit }) {
      return () =>
        h("input", {
          ...attrs,
          value: props.modelValue,
          onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
        });
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => ({ CircleCheck: passthrough("span"), FolderOpen: passthrough("span"), LoaderCircle: passthrough("span") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: passthrough("div"),
  DialogContent: passthrough("div"),
  DialogFooter: passthrough("div"),
  DialogHeader: passthrough("div"),
  DialogTitle: passthrough("div"),
}));
vi.mock("@/components/ui/input", () => ({ Input: inputStub() }));
vi.mock("@/components/ui/label", () => ({ Label: passthrough("label") }));
vi.mock("@/components/ui/select", () => ({
  Select: passthrough("div"),
  SelectContent: passthrough("div"),
  SelectItem: passthrough("div"),
  SelectTrigger: passthrough("div"),
  SelectValue: passthrough("span"),
}));
vi.mock("@/components/ui/LightTooltip.vue", () => ({ default: passthrough("span") }));
vi.mock("@/lib/backend/ssh-terminal-tauri", () => ({
  listSshTerminalDrivers: mocks.listDrivers,
  saveSshProfile: mocks.saveProfile,
  testSshTerminalProfile: mocks.testProfile,
}));
vi.mock("@/lib/common/utils", () => ({ uuid: () => "profile-id" }));

import SshProfileDialog from "@/components/ssh/SshProfileDialog.vue";

let app: ReturnType<typeof createApp> | undefined;
let root: HTMLDivElement | undefined;

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  root = undefined;
  vi.clearAllMocks();
});

async function mountDialog() {
  mocks.listDrivers.mockResolvedValue([{ id: "builtin-russh", name: "DBX SSH", version: "0.1.0", builtIn: true, capabilities: [] }]);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(SshProfileDialog, { open: true });
  app.mount(root);
  await vi.waitFor(() => expect(mocks.listDrivers).toHaveBeenCalledOnce());
  await nextTick();
  return root;
}

function enter(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SshProfileDialog", () => {
  it("defaults to password authentication and hides a single driver choice", async () => {
    const dialog = await mountDialog();

    expect(dialog.querySelector("#ssh-profile-password")).not.toBeNull();
    expect(dialog.querySelector("#ssh-profile-agent-socket")).toBeNull();
    expect(dialog.textContent).not.toContain("sshTerminal.driver");
  });

  it("tests a complete SSH connection and reports success", async () => {
    mocks.testProfile.mockResolvedValue(undefined);
    const dialog = await mountDialog();
    enter(dialog, "#ssh-profile-name", " Local ");
    enter(dialog, "#ssh-profile-host", " 127.0.0.1 ");
    enter(dialog, "#ssh-profile-username", " staff ");
    enter(dialog, "#ssh-profile-password", "secret");
    await nextTick();

    const testButton = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.trim() === "sshTerminal.testConnection");
    expect(testButton?.disabled).toBe(false);
    testButton!.click();

    await vi.waitFor(() => expect(mocks.testProfile).toHaveBeenCalledOnce());
    expect(mocks.testProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "profile-id",
        name: "Local",
        host: "127.0.0.1",
        username: "staff",
        authMethod: "password",
        password: "secret",
      }),
    );
    await vi.waitFor(() => expect(dialog.textContent).toContain("sshTerminal.testSuccess"));
  });
});
