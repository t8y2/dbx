import { describe, expect, it } from "vitest";
import { discoverTaskProviders, findProvider, findTrigger, splitTriggerId, taskHealth, triggerId, triggerSummary, withStoredTriggerId } from "./schedulerProviders";
import type { InstalledPlugin } from "@/types/database";
import type { SchedulerTaskProviderDescriptor } from "./schedulerTypes";

function pluginWithContributions(id: string, contributions: unknown[]): InstalledPlugin {
  return { manifest: { id, name: id, drivers: [], contributions } as InstalledPlugin["manifest"], compatibility: { compatible: true } };
}

const sshProviderContribution = {
  type: "task-provider",
  id: "io.dbx.ssh.tasks",
  label: "SSH Tasks",
  connection_providers: ["io.dbx.ssh.connection"],
  capabilities: ["run", "resident", "cancel", "logs"],
  triggers: [
    { id: "execute", label: "Execute Command", mode: "run", risk: "high", fields: [{ key: "command", label: "Command", type: "textarea", required: true }] },
    { id: "resident", label: "Resident Command", mode: "resident" },
  ],
};

const filesProviderContribution = {
  type: "task-provider",
  id: "io.dbx.files.tasks",
  label: "Files Tasks",
  triggers: [{ id: "sync", label: "Sync Directory", mode: "run", fields: [] }],
};

describe("discoverTaskProviders", () => {
  it("collects task-provider contributions from installed manifests", () => {
    const plugins = [pluginWithContributions("io.dbx.ssh", [sshProviderContribution]), pluginWithContributions("io.dbx.files", [filesProviderContribution])];
    const providers = discoverTaskProviders(plugins);
    expect(providers.map((provider) => provider.providerId)).toEqual(["io.dbx.ssh.tasks", "io.dbx.files.tasks"]);
    const ssh = providers[0]!;
    expect(ssh.pluginId).toBe("io.dbx.ssh");
    expect(ssh.label).toBe("SSH Tasks");
    expect(ssh.connectionProviders).toEqual(["io.dbx.ssh.connection"]);
    expect(ssh.triggers).toHaveLength(2);
    expect(ssh.triggers[0]!.mode).toBe("run");
    expect(ssh.triggers[0]!.risk).toBe("high");
  });

  it("skips unrelated and malformed contributions instead of failing", () => {
    const plugins = [pluginWithContributions("io.dbx.ssh", [sshProviderContribution, { type: "workbench", id: "wb" }, null]), pluginWithContributions("broken", [{ type: "task-provider" }, { type: "task-provider", id: 42 }])];
    const providers = discoverTaskProviders(plugins);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.providerId).toBe("io.dbx.ssh.tasks");
  });

  it("returns nothing for undefined plugin lists (discovery must not hardcode providers)", () => {
    expect(discoverTaskProviders(undefined)).toEqual([]);
  });
});

describe("trigger ids", () => {
  it("joins and splits namespaced trigger ids", () => {
    const providers = discoverTaskProviders([pluginWithContributions("io.dbx.ssh", [sshProviderContribution])]);
    const ssh = providers[0]!;
    expect(triggerId(ssh.providerId, ssh.triggers[0]!)).toBe("io.dbx.ssh.tasks/execute");
    expect(splitTriggerId("io.dbx.ssh.tasks/execute")).toEqual({ providerId: "io.dbx.ssh.tasks", triggerId: "execute" });
  });

  it("finds the trigger of a task by full id, defaulting to the sole trigger", () => {
    const providers = discoverTaskProviders([pluginWithContributions("io.dbx.ssh", [sshProviderContribution])]);
    const ssh = providers[0]!;
    expect(findTrigger(ssh, "io.dbx.ssh.tasks/resident")?.mode).toBe("resident");
    const single = discoverTaskProviders([pluginWithContributions("io.dbx.files", [filesProviderContribution])])[0]!;
    expect(findTrigger(single, "io.dbx.files.tasks")?.id).toBe("sync");
  });
});

describe("taskHealth", () => {
  const providers = discoverTaskProviders([pluginWithContributions("io.dbx.ssh", [sshProviderContribution]), pluginWithContributions("io.dbx.files", [filesProviderContribution])]);
  const context = { providers, connectionIds: new Set(["conn-prod"]) };

  function task(overrides: Partial<Parameters<typeof taskHealth>[0]> = {}) {
    return {
      providerId: "io.dbx.ssh.tasks",
      providerType: "plugin" as const,
      trigger: { type: "cron", expression: "*/5 * * * *", timeZone: "Asia/Shanghai" } as const,
      execution: { mode: "run" as const, concurrency: "forbid" as const, retry: { maxAttempts: 1, backoffSeconds: 0, backoffStrategy: "fixed" as const }, misfire: "coalesce" as const },
      target: { connectionId: "conn-prod" },
      config: { __triggerId: "io.dbx.ssh.tasks/execute" },
      ...overrides,
    };
  }

  it("healthy when provider, trigger and connection all exist", () => {
    expect(taskHealth(task(), context)).toBe("healthy");
  });

  it("unavailable when the provider plugin is gone (task is kept)", () => {
    expect(taskHealth(task({ providerId: "io.dbx.gone.tasks" }), context)).toBe("unavailable");
  });

  it("invalid when the declared trigger disappeared after an upgrade", () => {
    expect(taskHealth(task({ config: { __triggerId: "io.dbx.ssh.tasks/legacy" } }), context)).toBe("invalid");
  });

  it("invalid when execution mode does not match the trigger mode", () => {
    expect(taskHealth(task({ execution: { mode: "resident", concurrency: "replace", retry: { maxAttempts: 1, backoffSeconds: 0, backoffStrategy: "fixed" }, misfire: "coalesce" } }), context)).toBe("invalid");
  });

  it("warning when the bound connection is missing", () => {
    expect(taskHealth(task({ target: { connectionId: "conn-deleted" } }), context)).toBe("warning");
  });
});

describe("withStoredTriggerId", () => {
  const providers: SchedulerTaskProviderDescriptor[] = discoverTaskProviders([pluginWithContributions("io.dbx.ssh", [sshProviderContribution])]);
  const multi = providers[0]!;
  const single = discoverTaskProviders([pluginWithContributions("io.dbx.files", [filesProviderContribution])])[0]!;

  it("stores the trigger id only for multi-trigger providers", () => {
    const stored = withStoredTriggerId({ command: "uptime" }, multi, multi.triggers[1]!);
    expect(stored["__triggerId"]).toBe("io.dbx.ssh.tasks/resident");
    expect(stored["command"]).toBe("uptime");
  });

  it("clears the host key for single-trigger providers", () => {
    const stored = withStoredTriggerId({ __triggerId: "io.dbx.files.tasks/sync" }, single, single.triggers[0]!);
    expect("__triggerId" in stored).toBe(false);
  });

  it("findProvider resolves by id across the discovered registry", () => {
    expect(findProvider([...providers, single], "io.dbx.files.tasks")?.pluginId).toBe("io.dbx.files");
    expect(findProvider(providers, "io.dbx.gone")).toBeUndefined();
  });
});

describe("triggerSummary", () => {
  it("renders cron with its persisted timezone", () => {
    expect(triggerSummary({ type: "cron", expression: "0 2 * * *", timeZone: "America/Los_Angeles" })).toBe("Cron 0 2 * * * · America/Los_Angeles");
  });

  it("renders once, interval and manual forms", () => {
    expect(triggerSummary({ type: "once", at: "2026-10-05T09:00", timeZone: "UTC" })).toContain("Once");
    expect(triggerSummary({ type: "interval", seconds: 3600 })).toBe("Every 60 min");
    expect(triggerSummary({ type: "manual" })).toBe("Manual");
    expect(triggerSummary({ type: "startup" })).toBe("Startup");
  });
});
