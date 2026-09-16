import { describe, expect, it, vi } from "vitest";
import type { NacosConfigItem, NacosConfigUpsert } from "@/types/nacos";
import { applyNacosContentReplacePlan, buildNacosContentReplacePlan, rollbackNacosContentReplace } from "../nacosContentReplace";

function config(overrides: Partial<NacosConfigItem> = {}): NacosConfigItem {
  return {
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "application.yaml",
    content: "url: mysql-old:3306\nreplica: mysql-old:3306",
    configType: "yaml",
    md5: "before-md5",
    ...overrides,
  };
}

describe("buildNacosContentReplacePlan", () => {
  it("builds one global plan across namespaces, groups, and data IDs", () => {
    const plan = buildNacosContentReplacePlan(
      [config(), config({ namespace: "tenant-a", group: "orders", dataId: "orders.yaml", content: "dsn=mysql-old:3306/orders", md5: "orders-md5" }), config({ namespace: "tenant-a", group: "billing", dataId: "billing.properties", content: "host=mysql-new", md5: "billing-md5" })],
      "mysql-old:3306",
      "mysql-new:3306",
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.totalReplacements).toBe(3);
    expect(plan.items.map((item) => `${item.namespace}/${item.group}/${item.dataId}`)).toEqual(["public/DEFAULT_GROUP/application.yaml", "tenant-a/orders/orders.yaml"]);
    expect(plan.items[0].afterContent).toBe("url: mysql-new:3306\nreplica: mysql-new:3306");
  });

  it("deduplicates search matches for the same configuration", () => {
    const item = config();
    const plan = buildNacosContentReplacePlan([item, { ...item }], "mysql-old", "mysql-new");

    expect(plan.items).toHaveLength(1);
    expect(plan.totalReplacements).toBe(2);
  });

  it("rejects an empty search value and a no-op replacement", () => {
    expect(() => buildNacosContentReplacePlan([config()], "", "mysql-new")).toThrow(/required/i);
    expect(() => buildNacosContentReplacePlan([config()], "same", "same")).toThrow(/different/i);
  });
});

describe("applyNacosContentReplacePlan", () => {
  it("awaits durable checkpoints and stops further publishing if a checkpoint fails", async () => {
    const plan = buildNacosContentReplacePlan([config(), config({ dataId: "other.yaml" })], "mysql-old", "mysql-new");
    const publish = vi.fn();
    const onBeforeItem = vi.fn().mockResolvedValue(undefined);
    const onItemResult = vi.fn().mockRejectedValue(new Error("history write failed"));
    let reads = 0;
    await expect(
      applyNacosContentReplacePlan(plan, {
        getConfig: async () => config({ content: ++reads === 1 ? plan.items[0].beforeContent : plan.items[0].afterContent }),
        publishConfig: publish,
        onBeforeItem,
        onItemResult,
      }),
    ).rejects.toThrow("history write failed");
    expect(onBeforeItem).toHaveBeenCalledTimes(1);
    expect(onItemResult).toHaveBeenCalledWith(expect.objectContaining({ status: "replaced" }));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not publish when the pre-item checkpoint cannot be saved", async () => {
    const publish = vi.fn();
    await expect(
      applyNacosContentReplacePlan(buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new"), {
        getConfig: async () => config(),
        publishConfig: publish,
        onBeforeItem: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(publish).not.toHaveBeenCalled();
  });
  it("publishes every current item with CAS metadata and verifies the result", async () => {
    const plan = buildNacosContentReplacePlan([config(), config({ namespace: "tenant-a", dataId: "orders.yaml", content: "mysql-old", md5: "orders-before" })], "mysql-old", "mysql-new");
    const current = new Map(plan.items.map((item) => [item.key, config({ namespace: item.namespace, group: item.group, dataId: item.dataId, content: item.beforeContent, md5: item.expectedMd5 })]));
    const publish = vi.fn(async (request: NacosConfigUpsert) => {
      const key = `${request.namespace || ""}\u0000${request.group}\u0000${request.dataId}`;
      current.set(key, config({ ...request, md5: `after-${request.dataId}` }));
    });

    const report = await applyNacosContentReplacePlan(plan, {
      getConfig: async (key) => current.get(`${key.namespace || ""}\u0000${key.group}\u0000${key.dataId}`)!,
      publishConfig: publish,
    });

    expect(report.replaced).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(report.failed).toBe(0);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({ content: "url: mysql-new:3306\nreplica: mysql-new:3306", casMd5: "before-md5" });
    expect(report.items.every((item) => item.status === "replaced" && item.appliedMd5)).toBe(true);
  });

  it("skips a configuration changed after preview", async () => {
    const plan = buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new");
    const publish = vi.fn();

    const report = await applyNacosContentReplacePlan(plan, {
      getConfig: async () => config({ content: "changed elsewhere", md5: "other-md5" }),
      publishConfig: publish,
    });

    expect(report.conflicts).toBe(1);
    expect(report.replaced).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports a failed verification when the server does not retain the replacement", async () => {
    const plan = buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new");
    let reads = 0;

    const report = await applyNacosContentReplacePlan(plan, {
      getConfig: async () => {
        reads += 1;
        return reads === 1 ? config() : config({ md5: "after-md5" });
      },
      publishConfig: vi.fn().mockResolvedValue(undefined),
    });

    expect(report.failed).toBe(1);
    expect(report.items[0].message).toMatch(/verification/i);
  });

  it("reports a CAS rejection as a conflict instead of a generic failure", async () => {
    const plan = buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new");

    const report = await applyNacosContentReplacePlan(plan, {
      getConfig: async () => config(),
      publishConfig: vi.fn().mockRejectedValue(new Error("Nacos publish rejected by CAS validation")),
    });

    expect(report.conflicts).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.items[0].status).toBe("conflict");
  });
});

describe("rollbackNacosContentReplace", () => {
  it("restores successfully replaced configurations with CAS protection", async () => {
    const plan = buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new");
    const applied = config({ content: plan.items[0].afterContent, md5: "after-md5" });
    const publish = vi.fn().mockResolvedValue(undefined);
    let reads = 0;

    const report = await rollbackNacosContentReplace(
      {
        ...plan,
        items: [{ ...plan.items[0], status: "replaced", appliedMd5: "after-md5" }],
        replaced: 1,
        conflicts: 0,
        failed: 0,
        cancelled: false,
      },
      {
        getConfig: async () => {
          reads += 1;
          return reads === 1 ? applied : config();
        },
        publishConfig: publish,
      },
    );

    expect(report.restored).toBe(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ content: config().content, casMd5: "after-md5" }));
  });

  it("does not overwrite a configuration changed after replacement", async () => {
    const plan = buildNacosContentReplacePlan([config()], "mysql-old", "mysql-new");
    const publish = vi.fn();

    const report = await rollbackNacosContentReplace(
      {
        ...plan,
        items: [{ ...plan.items[0], status: "replaced", appliedMd5: "after-md5" }],
        replaced: 1,
        conflicts: 0,
        failed: 0,
        cancelled: false,
      },
      {
        getConfig: async () => config({ content: "newer change", md5: "newer-md5" }),
        publishConfig: publish,
      },
    );

    expect(report.conflicts).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
