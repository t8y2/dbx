import { describe, expect, it } from "vitest";
import { sidebarTreeDisplayLabel } from "@/lib/sidebar/sidebarTreeLabel";
import type { TreeNode } from "@/types/database";
import { createI18n } from "vue-i18n";
import zhCN from "@/i18n/locales/zh-CN";
import en from "@/i18n/locales/en";
import { oracleSharedObjects } from "@/lib/sidebar/oracleObjectNavigation";

describe("sidebar tree labels", () => {
  it("uses public objects for OB while retaining its tenant scope and translating cached labels", () => {
    const node = oracleSharedObjects({ id: "c", connectionId: "c", database: "DB" }, "oceanbase-oracle");
    expect(node.label).toBe("tree.publicObjects");
    expect(node.databaseLinkScope).toEqual({ kind: "tenant" });
    expect(node.children![0].databaseLinkScope).toEqual({ kind: "tenant" });
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } });
    expect(sidebarTreeDisplayLabel({ ...node, label: "tree.tenantObjects" }, (key) => i18n.global.t(key))).toBe("公共");
  });

  it.each(["Scheduler", "tree.scheduler"])("localizes new and cached Scheduler groups (%s) without changing their type", (label) => {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN, en } });
    const scheduler: TreeNode = { id: "scheduler", type: "native-job-scheduler", label };
    const job: TreeNode = { id: "legacy", type: "native-job-group", label: "nativeJobs.kinds.legacy" };
    expect(sidebarTreeDisplayLabel(scheduler, (key) => i18n.global.t(key))).toBe("作业");
    expect(sidebarTreeDisplayLabel(job, (key) => i18n.global.t(key))).toBe("作业");
    i18n.global.locale.value = "en";
    expect(sidebarTreeDisplayLabel(scheduler, (key) => i18n.global.t(key))).toBe("Jobs");
    expect(scheduler.type).toBe("native-job-scheduler");
  });
  it("translates the native job entry for rendering and width measurement", () => {
    const node: TreeNode = { id: "jobs", type: "database-job-admin", label: "tree.nativeJobs" };
    expect(sidebarTreeDisplayLabel(node, (key) => `translated:${key}`)).toBe("translated:tree.nativeJobs");
  });
});
