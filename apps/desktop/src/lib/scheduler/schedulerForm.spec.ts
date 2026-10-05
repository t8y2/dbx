import { describe, expect, it } from "vitest";
import { configFromFormValues, defaultFormValues, formValuesFromConfig, validateFormFields, visibleFormFields } from "./schedulerForm";
import type { PluginFormField } from "@/types/database";

const fields: PluginFormField[] = [
  { key: "command", label: "Command", type: "textarea", required: true },
  {
    key: "mode",
    label: "Mode",
    type: "select",
    options: [
      { label: "Fast", value: "fast" },
      { label: "Safe", value: "safe" },
    ],
    default: "safe",
  },
  { key: "extra", label: "Extra args", type: "text", visible_when: { field: "mode", one_of: ["safe"] } },
  { key: "token", label: "Token", type: "password", binding: "secret" },
  { key: "retries", label: "Retries", type: "number", default: 3 },
];

describe("defaultFormValues", () => {
  it("seeds declared defaults so conditions can read them", () => {
    const values = defaultFormValues(fields);
    expect(values.mode).toBe("safe");
    expect(values.retries).toBe(3);
    expect(values.command).toBeUndefined();
  });
});

describe("visibility cascade", () => {
  it("shows conditional fields only when their controller matches", () => {
    expect(visibleFormFields(fields, { mode: "safe" }).map((field) => field.key)).toContain("extra");
    expect(visibleFormFields(fields, { mode: "fast" }).map((field) => field.key)).not.toContain("extra");
  });

  it("does not light hidden controllers up through their stored defaults", () => {
    // `mode` holds a stored "safe" but is itself conditioned off — `extra` must not reappear.
    const conditioned: PluginFormField[] = [
      { key: "enabled", label: "Enabled", type: "boolean" },
      { key: "mode", label: "Mode", type: "select", default: "safe", options: [{ label: "Safe", value: "safe" }], visible_when: { field: "enabled", one_of: [true] } },
      { key: "extra", label: "Extra", type: "text", visible_when: { field: "mode", one_of: ["safe"] } },
    ];
    expect(visibleFormFields(conditioned, { enabled: false, mode: "safe" }).map((field) => field.key)).not.toContain("extra");
  });
});

describe("validateFormFields", () => {
  it("flags required visible fields and ignores hidden ones", () => {
    const issues = validateFormFields(fields, { mode: "safe" });
    expect(issues.map((issue) => issue.key)).toEqual(["command"]);
    expect(validateFormFields(fields, { command: "uptime", mode: "safe" })).toEqual([]);
  });

  it("treats blank strings as missing", () => {
    expect(validateFormFields(fields, { command: "   " }).map((issue) => issue.key)).toEqual(["command"]);
  });
});

describe("configFromFormValues", () => {
  it("keeps only visible, non-secret values and preserves the host trigger key", () => {
    const config = configFromFormValues(fields, { command: "uptime", mode: "safe", extra: "-v", token: "super-secret", retries: 3 }, { __triggerId: "io.dbx.ssh.tasks/execute" });
    expect(config).toEqual({ command: "uptime", mode: "safe", extra: "-v", retries: 3, __triggerId: "io.dbx.ssh.tasks/execute" });
    expect(JSON.stringify(config)).not.toContain("super-secret");
  });

  it("drops values of fields hidden by conditions and empty strings", () => {
    const config = configFromFormValues(fields, { command: "uptime", mode: "fast", extra: "orphaned" });
    expect("extra" in config).toBe(false);
  });
});

describe("formValuesFromConfig", () => {
  it("hydrates stored config over defaults, ignoring host keys", () => {
    const values = formValuesFromConfig(fields, { command: "ls -la", __triggerId: "x" });
    expect(values.command).toBe("ls -la");
    expect(values.mode).toBe("safe");
    expect(values.retries).toBe(3);
  });

  it("tolerates a missing config", () => {
    const values = formValuesFromConfig(fields, undefined);
    expect(values.mode).toBe("safe");
  });
});
