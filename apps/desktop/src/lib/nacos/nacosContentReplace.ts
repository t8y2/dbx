import type { NacosConfigItem, NacosConfigKey, NacosConfigUpsert } from "@/types/nacos";

export type NacosContentReplaceItemStatus = "replaced" | "conflict" | "failed";

export interface NacosContentReplacePlanItem {
  key: string;
  namespace: string;
  group: string;
  dataId: string;
  beforeContent: string;
  afterContent: string;
  replacements: number;
  expectedMd5?: string;
  configType?: string;
  appName?: string;
  desc?: string;
  tags?: string;
}

export interface NacosContentReplacePlan {
  search: string;
  replacement: string;
  totalReplacements: number;
  items: NacosContentReplacePlanItem[];
}

export interface NacosContentReplaceResultItem extends NacosContentReplacePlanItem {
  status: NacosContentReplaceItemStatus;
  message?: string;
  appliedMd5?: string;
}

export interface NacosContentReplaceReport extends Omit<NacosContentReplacePlan, "items"> {
  items: NacosContentReplaceResultItem[];
  replaced: number;
  conflicts: number;
  failed: number;
  cancelled: boolean;
}

export interface NacosContentRollbackReport {
  restored: number;
  conflicts: number;
  failed: number;
  items: Array<{
    key: string;
    namespace: string;
    group: string;
    dataId: string;
    status: "restored" | "conflict" | "failed";
    message?: string;
  }>;
}

export interface NacosContentReplaceApi {
  getConfig(key: NacosConfigKey): Promise<NacosConfigItem>;
  publishConfig(request: NacosConfigUpsert): Promise<void>;
}

export interface NacosContentReplaceExecutionOptions extends NacosContentReplaceApi {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  onBeforeItem?: (item: NacosContentReplacePlanItem) => Promise<void>;
  onItemResult?: (item: NacosContentReplaceResultItem) => Promise<void>;
}

export interface NacosContentRollbackOptions extends NacosContentReplaceApi {
  onBeforeItem?: (item: NacosContentReplaceResultItem) => Promise<void>;
  onItemResult?: (item: NacosContentRollbackReport["items"][number]) => Promise<void>;
}

export function nacosConfigIdentity(config: Pick<NacosConfigItem, "namespace" | "group" | "dataId">): string {
  return `${config.namespace || ""}\u0000${config.group}\u0000${config.dataId}`;
}

function countLiteralOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return count;
    count += 1;
    offset = match + search.length;
  }
}

function validateReplaceInput(search: string, replacement: string) {
  if (!search) throw new Error("Nacos content replacement search value is required");
  if (search.length > 1024) throw new Error("Nacos content replacement search value exceeds the 1024 character limit");
  if (search === replacement) throw new Error("Nacos content replacement values must be different");
}

export function buildNacosContentReplacePlan(configs: readonly NacosConfigItem[], search: string, replacement: string): NacosContentReplacePlan {
  validateReplaceInput(search, replacement);
  const seen = new Set<string>();
  const items: NacosContentReplacePlanItem[] = [];
  let totalReplacements = 0;

  for (const config of configs) {
    const key = nacosConfigIdentity(config);
    if (seen.has(key)) continue;
    seen.add(key);
    const beforeContent = config.content ?? "";
    const replacements = countLiteralOccurrences(beforeContent, search);
    if (replacements === 0) continue;
    totalReplacements += replacements;
    items.push({
      key,
      namespace: config.namespace || "",
      group: config.group,
      dataId: config.dataId,
      beforeContent,
      afterContent: beforeContent.split(search).join(replacement),
      replacements,
      expectedMd5: config.md5,
      configType: config.configType,
      appName: config.appName,
      desc: config.desc,
      tags: config.tags,
    });
  }

  return { search, replacement, totalReplacements, items };
}

function configKey(item: NacosContentReplacePlanItem): NacosConfigKey & { namespace: string } {
  return { namespace: item.namespace, group: item.group, dataId: item.dataId };
}

function configMatchesPreview(item: NacosContentReplacePlanItem, current: NacosConfigItem): boolean {
  if (current.content !== item.beforeContent) return false;
  return !item.expectedMd5 || !current.md5 || current.md5 === item.expectedMd5;
}

function configMatchesApplied(item: NacosContentReplaceResultItem, current: NacosConfigItem): boolean {
  if (current.content !== item.afterContent) return false;
  return !item.appliedMd5 || !current.md5 || current.md5 === item.appliedMd5;
}

function replacementUpsert(item: NacosContentReplacePlanItem, currentMd5?: string): NacosConfigUpsert {
  return {
    namespace: item.namespace,
    group: item.group,
    dataId: item.dataId,
    content: item.afterContent,
    configType: item.configType,
    appName: item.appName,
    desc: item.desc,
    tags: item.tags,
    casMd5: currentMd5,
  };
}

function rollbackUpsert(item: NacosContentReplaceResultItem, currentMd5?: string): NacosConfigUpsert {
  return {
    namespace: item.namespace,
    group: item.group,
    dataId: item.dataId,
    content: item.beforeContent,
    configType: item.configType,
    appName: item.appName,
    desc: item.desc,
    tags: item.tags,
    casMd5: currentMd5,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function applyNacosContentReplacePlan(plan: NacosContentReplacePlan, options: NacosContentReplaceExecutionOptions): Promise<NacosContentReplaceReport> {
  const resultItems: NacosContentReplaceResultItem[] = [];
  let replaced = 0;
  let conflicts = 0;
  let failed = 0;

  for (const item of plan.items) {
    if (options.signal?.aborted) break;
    await options.onBeforeItem?.(item);
    try {
      const current = await options.getConfig(configKey(item));
      if (!configMatchesPreview(item, current)) {
        conflicts += 1;
        resultItems.push({ ...item, status: "conflict", message: "Configuration changed after preview" });
        continue;
      }
      await options.publishConfig(replacementUpsert(item, current.md5));
      const verified = await options.getConfig(configKey(item));
      if (verified.content !== item.afterContent) {
        failed += 1;
        resultItems.push({ ...item, status: "failed", message: "Published content verification failed" });
        continue;
      }
      replaced += 1;
      resultItems.push({ ...item, status: "replaced", appliedMd5: verified.md5 });
    } catch (error) {
      const message = errorMessage(error);
      if (/\bcas\b|casmd5/i.test(message)) {
        conflicts += 1;
        resultItems.push({ ...item, status: "conflict", message });
      } else {
        failed += 1;
        resultItems.push({ ...item, status: "failed", message });
      }
    } finally {
      // Journal errors must escape the API-error handler and stop subsequent writes.
      await options.onItemResult?.(resultItems[resultItems.length - 1]);
      options.onProgress?.(resultItems.length, plan.items.length);
    }
  }

  return {
    ...plan,
    items: resultItems,
    replaced,
    conflicts,
    failed,
    cancelled: options.signal?.aborted === true,
  };
}

export async function rollbackNacosContentReplace(report: NacosContentReplaceReport, options: NacosContentRollbackOptions): Promise<NacosContentRollbackReport> {
  const items: NacosContentRollbackReport["items"] = [];
  let restored = 0;
  let conflicts = 0;
  let failed = 0;

  for (const item of report.items.filter((candidate) => candidate.status === "replaced")) {
    await options.onBeforeItem?.(item);
    try {
      const current = await options.getConfig(configKey(item));
      if (!configMatchesApplied(item, current)) {
        conflicts += 1;
        items.push({ ...configKey(item), key: item.key, status: "conflict", message: "Configuration changed after replacement" });
        continue;
      }
      await options.publishConfig(rollbackUpsert(item, current.md5));
      const verified = await options.getConfig(configKey(item));
      if (verified.content !== item.beforeContent) {
        failed += 1;
        items.push({ ...configKey(item), key: item.key, status: "failed", message: "Rollback verification failed" });
        continue;
      }
      restored += 1;
      items.push({ ...configKey(item), key: item.key, status: "restored" });
    } catch (error) {
      failed += 1;
      items.push({ ...configKey(item), key: item.key, status: "failed", message: errorMessage(error) });
    } finally {
      await options.onItemResult?.(items[items.length - 1]);
    }
  }

  return { restored, conflicts, failed, items };
}
