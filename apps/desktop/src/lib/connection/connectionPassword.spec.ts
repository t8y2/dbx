import { describe, expect, it } from "vitest";
import type { PluginFormField } from "@/types/database";
import { connectionNeedsPasswordPrompt, pluginConnectionNeedsPasswordPrompt } from "@/lib/connection/connectionPassword";

/** Mirrors the io.dbx.ssh connection-provider password/authentication fields. */
const sshAuthFields: PluginFormField[] = [
  { key: "authentication", label: "Authentication", type: "select", binding: "config", default: "password", options: [] },
  {
    key: "password",
    label: "Password",
    type: "password",
    binding: "password",
    visible_when: { field: "authentication", one_of: ["password", "private-key-password"] },
    required_when: { field: "authentication", one_of: ["password", "private-key-password"] },
  },
];

describe("connectionNeedsPasswordPrompt", () => {
  it("keeps requiring a prompt for password-carrying connections with saving disabled", () => {
    expect(connectionNeedsPasswordPrompt({ db_type: "postgres", save_password: false, password: "" } as never)).toBe(true);
  });

  it("keeps skipping the prompt when a password is stored or saving is allowed", () => {
    expect(connectionNeedsPasswordPrompt({ db_type: "postgres", save_password: false, password: "pw" } as never)).toBe(false);
    expect(connectionNeedsPasswordPrompt({ db_type: "postgres", save_password: true, password: "" } as never)).toBe(false);
  });
});

describe("pluginConnectionNeedsPasswordPrompt", () => {
  it("does not prompt for SSH key auth even with save_password disabled", () => {
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, { authentication: "private-key" })).toBe(false);
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, { authentication: "agent" })).toBe(false);
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, { authentication: "none" })).toBe(false);
  });

  it("prompts when the manifest marks the password field required for the auth mode", () => {
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, { authentication: "password" })).toBe(true);
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, { authentication: "private-key-password" })).toBe(true);
  });

  it("falls back to the manifest field default when external_config omits the condition key", () => {
    // Default "password" → the form (and this check) sees password auth as active.
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, {})).toBe(true);
    expect(pluginConnectionNeedsPasswordPrompt(sshAuthFields, undefined)).toBe(true);
  });

  it("never prompts when the manifest declares no password-bound field", () => {
    const keyPathOnly: PluginFormField[] = [{ key: "private_key_path", label: "Key", type: "text", binding: "config" }];
    expect(pluginConnectionNeedsPasswordPrompt(keyPathOnly, { authentication: "password" })).toBe(false);
    expect(pluginConnectionNeedsPasswordPrompt([], {})).toBe(false);
  });

  it("treats a condition key with no value and no manifest default as unmatched", () => {
    const noDefaultAuth: PluginFormField[] = [
      { key: "authentication", label: "Authentication", type: "select", binding: "config", options: [] },
      {
        key: "password",
        label: "Password",
        type: "password",
        binding: "password",
        visible_when: { field: "authentication", one_of: ["password"] },
        required_when: { field: "authentication", one_of: ["password"] },
      },
    ];
    expect(pluginConnectionNeedsPasswordPrompt(noDefaultAuth, {})).toBe(false);
    expect(pluginConnectionNeedsPasswordPrompt(noDefaultAuth, undefined)).toBe(false);
  });

  it("prompts when the password field is statically required", () => {
    const staticallyRequired: PluginFormField[] = [{ key: "password", label: "Password", type: "password", binding: "password", required: true }];
    expect(pluginConnectionNeedsPasswordPrompt(staticallyRequired, {})).toBe(true);
  });
});
