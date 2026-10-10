import { describe, expect, it } from "vitest";
import { declaredConnectionAliases, declaredConnectionLabel, discoverTaskProviders, findProvider, findTrigger, splitTriggerId, taskHealth, triggerId, triggerSummary, withLocalizedContributions, withStoredTriggerId, type TriggerSummaryTranslator } from "./schedulerProviders";
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

describe("withLocalizedContributions", () => {
  it("feeds discovery from the registry's localized copies, not the raw manifest", () => {
    const rawPlugin = pluginWithContributions("io.dbx.ssh", [sshProviderContribution]);
    const localizedContribution = {
      type: "task-provider" as const,
      id: "io.dbx.ssh.tasks",
      label: "SSH 计划任务",
      triggers: [{ id: "execute", label: "执行命令", mode: "run" as const, fields: [{ key: "command", label: "命令", type: "textarea" as const, required: true }] }],
    };
    // What the page used to do: keep only `definition.plugin`, whose manifest
    // still carries the raw English copy.
    const plugins = withLocalizedContributions([{ plugin: rawPlugin, contributions: [localizedContribution] }]);
    const providers = discoverTaskProviders(plugins);
    expect(providers[0]!.label).toBe("SSH 计划任务");
    expect(providers[0]!.triggers[0]!.label).toBe("执行命令");
    expect(providers[0]!.triggers[0]!.fields?.[0]!.label).toBe("命令");
    // Non-contribution manifest fields pass through untouched.
    expect(plugins[0]!.manifest.id).toBe("io.dbx.ssh");
  });

  it("falls back to the raw manifest contributions when the registry shipped none", () => {
    const rawPlugin = pluginWithContributions("io.dbx.ssh", [sshProviderContribution]);
    const plugins = withLocalizedContributions([{ plugin: rawPlugin, contributions: undefined as never }]);
    expect(discoverTaskProviders(plugins)[0]!.label).toBe("SSH Tasks");
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

  it("healthy when the bound id is a plugin-reserved alias declared by the trigger", () => {
    // The files tasks' manifest declares `local` as a static option on its
    // host/connections field: a valid side no stored connection row backs.
    const aliasProvider = discoverTaskProviders([
      pluginWithContributions("io.dbx.files", [
        {
          type: "task-provider",
          id: "io.dbx.files.tasks",
          label: "Files Tasks",
          triggers: [
            {
              id: "sync",
              label: "Sync Directory",
              mode: "run",
              fields: [{ key: "source_connection_id", label: "Source", type: "text", options_action: "host/connections", options: [{ value: "local", label: "本地路径" }] }],
            },
          ],
        },
      ]),
    ]);
    const aliasContext = { providers: aliasProvider, connectionIds: new Set<string>() };
    const aliasTask = task({
      providerId: "io.dbx.files.tasks",
      config: { __triggerId: "io.dbx.files.tasks/sync" },
      target: { connectionId: "local" },
    });
    expect(taskHealth(aliasTask, aliasContext)).toBe("healthy");
    // The alias's declaring option also carries the localized row label.
    const trigger = aliasContext.providers[0]!.triggers[0]!;
    expect(declaredConnectionLabel(trigger, "local")).toBe("本地路径");
    expect(declaredConnectionAliases(trigger).has("local")).toBe(true);
    // A genuinely unknown id still warns.
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
  /** Minimal translator standing in for the component's `t`. */
  const t: TriggerSummaryTranslator = (key, named) => {
    const messages: Record<string, string> = {
      "scheduler.triggerSummary.manual": "手动",
      "scheduler.triggerSummary.startup": "启动时",
      "scheduler.triggerSummary.everyMinutes": `每 ${named?.minutes} 分钟`,
      "scheduler.triggerSummary.everySeconds": `每 ${named?.seconds} 秒`,
      "scheduler.triggerSummary.once": `定时一次 · ${named?.at}`,
      "scheduler.triggerSummary.cron": `Cron ${named?.expression}`,
    };
    return messages[key] ?? key;
  };

  it("renders cron without the timezone (the list renders it separately)", () => {
    expect(triggerSummary({ type: "cron", expression: "0 2 * * *", timeZone: "America/Los_Angeles" }, t)).toBe("Cron 0 2 * * *");
  });

  it("renders once, interval and manual forms", () => {
    expect(triggerSummary({ type: "once", at: "2026-10-05T09:00", timeZone: "UTC" }, t)).toBe("定时一次 · 2026-10-05T09:00");
    expect(triggerSummary({ type: "interval", seconds: 3600 }, t)).toBe("每 60 分钟");
    expect(triggerSummary({ type: "interval", seconds: 45 }, t)).toBe("每 45 秒");
    expect(triggerSummary({ type: "manual" }, t)).toBe("手动");
    expect(triggerSummary({ type: "startup" }, t)).toBe("启动时");
  });
});
