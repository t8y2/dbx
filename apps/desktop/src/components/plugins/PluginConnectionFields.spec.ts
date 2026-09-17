// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import PluginConnectionFields from "./PluginConnectionFields.vue";
import type { PluginConnectionProviderContribution, PluginFormField, PluginFormFieldBinding, PluginFormFieldValue } from "@/types/database";

const invokePluginMock = vi.fn();
const { pickPluginFieldFileMock, tauriRuntime } = vi.hoisted(() => ({
  pickPluginFieldFileMock: vi.fn(),
  tauriRuntime: { value: false },
}));

vi.mock("@/lib/plugins/pluginFieldPicker", () => ({
  PLUGIN_PICKER_MAX_BYTES: 1_048_576,
  pickPluginFieldFile: (...args: unknown[]) => pickPluginFieldFileMock(...args),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => tauriRuntime.value }));

vi.mock("@/lib/backend/api", () => ({
  listLocalSshKeys: vi.fn(async () => [
    { path: "/home/dev/.ssh/id_ed25519", algorithm: "ssh-ed25519", fingerprint: "SHA256:abc", hasPassphrase: false },
    { path: "/home/dev/.ssh/id_rsa", algorithm: "ssh-rsa", fingerprint: "", hasPassphrase: true },
  ]),
  invokePlugin: (...args: unknown[]) => invokePluginMock(...args),
}));

const mountedApps: App[] = [];

const contribution: PluginConnectionProviderContribution = {
  type: "connection-provider",
  id: "example.connection",
  label: "Example connection",
  database_type: "example",
  fields: [
    { key: "host", label: "Host", type: "text", required: true, placeholder: "localhost" },
    { key: "password", label: "Password", type: "password" },
  ],
};

async function mountFields(initialValues: Record<string, PluginFormFieldValue> = {}, hiddenBindings: PluginFormFieldBinding[] = [], layout: "stacked" | "connection-dialog" = "stacked") {
  const state = reactive({ values: initialValues });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(PluginConnectionFields, {
            contribution,
            modelValue: state.values,
            hiddenBindings,
            layout,
            "onUpdate:modelValue": (value: Record<string, PluginFormFieldValue>) => {
              state.values = value;
            },
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return state;
}

describe("PluginConnectionFields file picker", () => {
  const pickerContribution = (picker: PluginFormField["picker"], contentField = true): PluginConnectionProviderContribution => ({
    type: "connection-provider",
    id: "ssh.connection",
    label: "SSH",
    database_type: "ssh",
    fields: [{ key: "private_key_path", label: "Private key path", type: "text", picker }, ...(contentField ? [{ key: "private_key", label: "Private key", type: "textarea" as const, binding: "secret" as const }] : [])],
  });

  it("stores the chosen client path on desktop and drops a stale uploaded copy", async () => {
    tauriRuntime.value = true;
    pickPluginFieldFileMock.mockReset().mockResolvedValue({ path: "/Users/dev/.ssh/id_rsa", name: "id_rsa" });
    const provider = pickerContribution({ kind: "file", accept: [".pem"], content_field: "private_key" });
    const state = await mountContribution(provider, { private_key: "OLD-UPLOADED-KEY" });

    const browse = document.querySelector<HTMLButtonElement>("#ssh-connection-private_key_path-picker");
    expect(browse?.textContent).toContain("Choose file");
    browse?.click();

    await vi.waitFor(() => expect(state.values.private_key_path).toBe("/Users/dev/.ssh/id_rsa"));
    // The plugin prefers content over a path, so picking a path must clear the
    // previously uploaded key or the stale one would keep winning.
    expect(state.values.private_key).toBeUndefined();
  });

  it("uploads the file content into the paired field on browser hosts", async () => {
    tauriRuntime.value = false;
    pickPluginFieldFileMock.mockReset().mockResolvedValue({ content: "UPLOADED-KEY", name: "id_rsa" });
    const provider = pickerContribution({ kind: "file", accept: [".pem"], content_field: "private_key" });
    const state = await mountContribution(provider, { private_key_path: "/Users/dev/.ssh/id_rsa" });

    const upload = document.querySelector<HTMLButtonElement>("#ssh-connection-private_key_path-picker");
    expect(upload?.textContent).toContain("Upload file");
    upload?.click();

    await vi.waitFor(() => expect(state.values.private_key).toBe("UPLOADED-KEY"));
    // A browser path would point at the user's machine, not the host's.
    expect(state.values.private_key_path).toBeUndefined();
  });

  it("hides a browser-unsupported picker and keeps the desktop one available", async () => {
    const provider = pickerContribution({ kind: "file" }, false);

    tauriRuntime.value = false;
    await mountContribution(provider, {});
    expect(document.querySelector("#ssh-connection-private_key_path-picker")).toBeNull();

    tauriRuntime.value = true;
    await mountContribution(provider, {});
    expect(document.querySelector("#ssh-connection-private_key_path-picker")).not.toBeNull();
  });

  it("surfaces a picker failure without touching the form", async () => {
    tauriRuntime.value = false;
    pickPluginFieldFileMock.mockReset().mockRejectedValue(new Error("File is larger than 1024 KiB"));
    const provider = pickerContribution({ kind: "file", content_field: "private_key" });
    const state = await mountContribution(provider, { private_key: "KEEP-ME" });

    document.querySelector<HTMLButtonElement>("#ssh-connection-private_key_path-picker")?.click();

    await vi.waitFor(() => expect(pickPluginFieldFileMock).toHaveBeenCalled());
    await nextTick();
    expect(state.values).toEqual({ private_key: "KEEP-ME" });
  });
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("PluginConnectionFields", () => {
  it("preserves multiline secret input and masks it again after its branch is reopened", async () => {
    const provider: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "pem.connection",
      label: "PEM",
      database_type: "example",
      fields: [
        { key: "mode", label: "Mode", type: "text", default: "tls" },
        { key: "key", label: "Private key", type: "textarea", binding: "secret", visible_when: { field: "mode", one_of: ["tls"] } },
      ],
    };
    const state = await mountContribution(provider, {});
    const textarea = document.querySelector<HTMLTextAreaElement>("#pem-connection-key")!;
    const pem = "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n";
    expect(textarea.classList.contains("secret-masked")).toBe(true);
    textarea.value = pem;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(state.values.key).toBe(pem);
    textarea.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick();
    expect(textarea.classList.contains("secret-masked")).toBe(false);
    expect(textarea.value).toBe(pem);
    state.values = { ...state.values, mode: "plain" };
    await nextTick();
    expect(document.querySelector("#pem-connection-key")).toBeNull();
    state.values = { ...state.values, mode: "tls" };
    await nextTick();
    const reopened = document.querySelector<HTMLTextAreaElement>("#pem-connection-key")!;
    expect(reopened.value).toBe(pem);
    expect(reopened.classList.contains("secret-masked")).toBe(true);
  });

  it("renders declared fields and emits immutable model updates", async () => {
    const state = await mountFields({ password: "secret" });
    const hostInput = document.querySelector<HTMLInputElement>("#example-connection-host");
    const passwordInput = document.querySelector<HTMLInputElement>("#example-connection-password");

    expect(hostInput?.placeholder).toBe("localhost");
    expect(passwordInput?.value).toBe("secret");

    if (!hostInput) throw new Error("host input not mounted");
    hostInput.value = "db.internal";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(state.values).toEqual({ password: "secret", host: "db.internal" });
  });

  it('renders a null value as an empty field instead of the text "null"', async () => {
    // Hosts before the manifest serialization fix hydrated untouched fields with
    // `null`, and a null reaching an <input> is coerced to the string "null" by
    // the DOM — a password field then looked non-empty without any user input.
    const provider: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "null.connection",
      label: "Nulls",
      database_type: "nulls",
      fields: [
        { key: "sudo_password", label: "Sudo password", type: "password", binding: "secret" },
        { key: "sudo_command", label: "Sudo command", type: "text", binding: "config" },
        { key: "set_env", label: "Env", type: "textarea", binding: "config" },
      ],
    };
    const state = await mountContribution(provider, {
      sudo_password: null,
      sudo_command: null,
      set_env: null,
    } as unknown as Record<string, PluginFormFieldValue>);

    expect(document.querySelector<HTMLInputElement>("#null-connection-sudo_password")?.value).toBe("");
    expect(document.querySelector<HTMLInputElement>("#null-connection-sudo_command")?.value).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>("#null-connection-set_env")?.value).toBe("");

    // Editing still emits a real value, so a null never survives the dialog.
    const command = document.querySelector<HTMLInputElement>("#null-connection-sudo_command")!;
    command.value = "sudo -n true";
    command.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(state.values.sudo_command).toBe("sudo -n true");
  });

  it("can hide host-owned common bindings", async () => {
    contribution.fields[0].binding = "host";
    await mountFields({}, ["host"]);
    expect(document.querySelector("#example-connection-host")).toBeNull();
    expect(document.querySelector("#example-connection-password")).not.toBeNull();
    contribution.fields[0].binding = undefined;
  });

  it("uses the native four-column connection layout without a nested card", async () => {
    await mountFields({}, [], "connection-dialog");

    const root = document.querySelector(".contents");
    const hostInput = document.querySelector("#example-connection-host");
    const fieldRow = hostInput?.closest(".grid");

    expect(root).not.toBeNull();
    expect(root?.textContent).not.toContain("Example connection");
    expect(fieldRow?.classList.contains("grid-cols-4")).toBe(true);
    expect(document.querySelector(".rounded-lg.border")).toBeNull();
  });

  it("hides conditional fields until visible_when matches and marks required_when", async () => {
    const conditional: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "cond.connection",
      label: "Conditional",
      database_type: "cond",
      fields: [
        { key: "mode", label: "Mode", type: "text", default: "password" },
        { key: "private_key_path", label: "Private key", type: "text", visible_when: { field: "mode", one_of: ["key"] }, required_when: { field: "mode", one_of: ["key"] } },
      ],
    };
    const state = await mountContribution(conditional, {});

    expect(document.querySelector("#cond-connection-private_key_path")).toBeNull();

    state.values = { mode: "key" };
    await nextTick();

    const keyInput = document.querySelector<HTMLInputElement>("#cond-connection-private_key_path");
    expect(keyInput).not.toBeNull();
    const label = document.querySelector('label[for="cond-connection-private_key_path"]');
    expect(label?.textContent).toContain("*");

    state.values = { mode: "password" };
    await nextTick();
    expect(document.querySelector("#cond-connection-private_key_path")).toBeNull();
  });

  it("keeps grandchild fields hidden while an intermediate default-only value would match (kafka msk_region regression)", async () => {
    // sasl_mechanism (PLAIN default, hidden without SASL) → oauth_token_source
    // (msk_iam default) → msk_region: the nested default must not surface an
    // always-required AWS region on a plain PLAINTEXT/SCRAM connection.
    const kafka: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "kafka.connection",
      label: "Kafka",
      database_type: "kafka",
      fields: [
        { key: "bootstrap_servers", label: "Bootstrap servers", type: "textarea", required: true },
        {
          key: "security_protocol",
          label: "Security protocol",
          type: "select",
          default: "PLAINTEXT",
          options: [
            { label: "PLAINTEXT", value: "PLAINTEXT" },
            { label: "SASL_SSL", value: "SASL_SSL" },
          ],
        },
        {
          key: "sasl_mechanism",
          label: "SASL mechanism",
          type: "select",
          default: "PLAIN",
          options: [
            { label: "PLAIN", value: "PLAIN" },
            { label: "OAUTHBEARER", value: "OAUTHBEARER" },
          ],
          visible_when: { field: "security_protocol", one_of: ["SASL_PLAINTEXT", "SASL_SSL"] },
        },
        {
          key: "oauth_token_source",
          label: "OAuth token source",
          type: "select",
          default: "msk_iam",
          options: [
            { label: "MSK IAM", value: "msk_iam" },
            { label: "Static token", value: "static_token" },
          ],
          visible_when: { field: "sasl_mechanism", one_of: ["OAUTHBEARER"] },
        },
        { key: "msk_region", label: "MSK AWS region", type: "text", visible_when: { field: "oauth_token_source", one_of: ["msk_iam"] }, required_when: { field: "oauth_token_source", one_of: ["msk_iam"] } },
      ],
    };
    const state = await mountContribution(kafka, {}, "io.dbx.kafka");

    expect(document.querySelector("#kafka-connection-msk_region")).toBeNull();

    state.values = { security_protocol: "SASL_SSL", sasl_mechanism: "OAUTHBEARER" };
    await nextTick();
    expect(document.querySelector("#kafka-connection-msk_region")).not.toBeNull();
    const label = document.querySelector('label[for="kafka-connection-msk_region"]');
    expect(label?.textContent).toContain("*");

    // Selecting the static token source hides the region field again.
    state.values = { sasl_mechanism: "OAUTHBEARER", oauth_token_source: "static_token" };
    await nextTick();
    expect(document.querySelector("#kafka-connection-msk_region")).toBeNull();
  });

  it("renders a field only while every clause of an all_of condition holds (sudo_source + read_only)", async () => {
    // The SSH plugin cannot express "sudo_source = custom AND read_only =
    // false" with one clause per field; all_of + a boolean literal covers it.
    const ssh: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "ssh.connection",
      label: "SSH",
      database_type: "ssh",
      fields: [
        {
          key: "read_only",
          label: "Read only",
          type: "boolean",
          default: false,
        },
        {
          key: "sudo_source",
          label: "Sudo source",
          type: "select",
          default: "none",
          options: [
            { label: "None", value: "none" },
            { label: "Custom", value: "custom" },
          ],
        },
        {
          key: "sudo_command",
          label: "Sudo command",
          type: "text",
          visible_when: {
            all_of: [
              { field: "sudo_source", one_of: ["custom"] },
              { field: "read_only", one_of: [false] },
            ],
          },
          required_when: {
            all_of: [
              { field: "sudo_source", one_of: ["custom"] },
              { field: "read_only", one_of: [false] },
            ],
          },
        },
      ],
    };
    const state = await mountContribution(ssh, {});

    expect(document.querySelector("#ssh-connection-sudo_command")).toBeNull();

    state.values = { sudo_source: "custom", read_only: false };
    await nextTick();
    expect(document.querySelector("#ssh-connection-sudo_command")).not.toBeNull();
    expect(document.querySelector('label[for="ssh-connection-sudo_command"]')?.textContent).toContain("*");

    // Read-only sessions ignore the sudo block entirely.
    state.values = { sudo_source: "custom", read_only: true };
    await nextTick();
    expect(document.querySelector("#ssh-connection-sudo_command")).toBeNull();

    state.values = { sudo_source: "none", read_only: false };
    await nextTick();
    expect(document.querySelector("#ssh-connection-sudo_command")).toBeNull();
  });

  it("offers local SSH keys on private_key_path fields and fills the chosen path", async () => {
    const withKey: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "keys.connection",
      label: "Keys",
      database_type: "keys",
      fields: [{ key: "private_key_path", label: "Private key", type: "text" }],
    };
    const state = await mountContribution(withKey, {});
    await flushAsync();

    const select = document.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(false);
    const encryptedOption = select?.querySelector<HTMLOptionElement>('option[value="/home/dev/.ssh/id_rsa"]');
    expect(encryptedOption?.textContent).toContain("id_rsa");
    expect(encryptedOption?.textContent).toContain("ssh-rsa");
    expect(encryptedOption?.textContent).toMatch(/encrypted|已加密/);

    select!.value = "/home/dev/.ssh/id_rsa";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    expect(state.values.private_key_path).toBe("/home/dev/.ssh/id_rsa");
  });

  it("renders options_action fields as a dynamic select and keeps a stored value visible", async () => {
    const dynamic: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "dyn.connection",
      label: "Dyn",
      database_type: "dyn",
      fields: [{ key: "sudo_profile", label: "Profile", type: "text", options_action: "sudo/profiles/options" }],
    };
    invokePluginMock.mockResolvedValueOnce({
      options: [
        { value: "p1", label: "Ops" },
        { value: "p2", label: "QA" },
      ],
    });
    // "ghost" is stored but no longer offered: the dropdown must keep it visible.
    await mountContribution(dynamic, { sudo_profile: "ghost" }, "io.dbx.ssh");
    await flushAsync();

    expect(invokePluginMock).toHaveBeenCalledWith("io.dbx.ssh", "sudo/profiles/options");
    expect(document.querySelector("input#dyn-connection-sudo_profile")).toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>('#dyn-connection-sudo_profile, button[role="combobox"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("ghost");
  });

  it("falls back to the text input when the options_action call fails or returns nothing", async () => {
    const dynamic: PluginConnectionProviderContribution = {
      type: "connection-provider",
      id: "degrade.connection",
      label: "Degrade",
      database_type: "degrade",
      fields: [{ key: "sudo_profile", label: "Profile", type: "text", options_action: "sudo/profiles/options" }],
    };
    invokePluginMock.mockRejectedValueOnce(new Error("method not registered"));
    await mountContribution(dynamic, {}, "io.dbx.ssh");
    await flushAsync();

    const input = document.querySelector<HTMLInputElement>("input#degrade-connection-sudo_profile");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");

    // An empty option list degrades the same way.
    invokePluginMock.mockResolvedValueOnce({ options: [] });
    const empty = { ...dynamic, id: "empty.connection", label: "Empty" };
    await mountContribution(empty, {}, "io.dbx.ssh");
    await flushAsync();
    expect(document.querySelector("input#empty-connection-sudo_profile")).not.toBeNull();
  });
});

async function flushAsync() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountContribution(contribution: PluginConnectionProviderContribution, initialValues: Record<string, PluginFormFieldValue>, pluginId?: string) {
  const state = reactive({ values: initialValues });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(PluginConnectionFields, {
            contribution,
            modelValue: state.values,
            pluginId,
            "onUpdate:modelValue": (value: Record<string, PluginFormFieldValue>) => {
              state.values = value;
            },
          });
      },
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return state;
}
