import { reactive } from "vue";
import * as api from "@/lib/backend/api";
import type { AiModelInfo } from "@/lib/backend/tauri";
import type { AiConfigItem, AiEffortCapability } from "@/types/ai";

const CATALOG_TTL_MS = 5 * 60 * 1000;

export interface AiModelCatalogEntry {
  status: "idle" | "loading" | "ready" | "error";
  models: AiModelInfo[];
  signature?: string;
  error?: string;
  loadedAt?: number;
}

interface AiEffortCatalogEntry {
  status: "idle" | "loading" | "ready" | "error";
  capability?: AiEffortCapability;
  signature?: string;
  error?: string;
  loadedAt?: number;
}

const catalogs = reactive(new Map<string, AiModelCatalogEntry>());
const effortCatalogs = reactive(new Map<string, AiEffortCatalogEntry>());
const modelRequests = new Map<string, Promise<AiModelInfo[]>>();
const effortRequests = new Map<string, Promise<AiEffortCapability>>();

function effortKey(configId: string, modelId: string): string {
  return JSON.stringify([configId, modelId]);
}

function sortedRecord(record: Record<string, string> | undefined): [string, string][] {
  return Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function fingerprint(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

function configSignature(config: AiConfigItem): string {
  return JSON.stringify({
    provider: config.provider,
    authMethod: config.authMethod,
    apiStyle: config.apiStyle,
    proxyEnabled: config.proxyEnabled ?? false,
    contextWindow: config.contextWindow ?? null,
    codexCliPath: config.codexCliPath ?? null,
    claudeCodeCliPath: config.claudeCodeCliPath ?? null,
    piAgentCliPath: config.piAgentCliPath ?? null,
    opencodeCliPath: config.opencodeCliPath ?? null,
    cursorCliPath: config.cursorCliPath ?? null,
    codebuddyCliPath: config.codebuddyCliPath ?? null,
    qoderCliPath: config.qoderCliPath ?? null,
    connectionFingerprint: fingerprint(
      JSON.stringify({
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        proxyUrl: config.proxyUrl ?? "",
        codexCliEnv: sortedRecord(config.codexCliEnv),
        claudeCodeCliEnv: sortedRecord(config.claudeCodeCliEnv),
        piAgentCliEnv: sortedRecord(config.piAgentCliEnv),
        opencodeCliEnv: sortedRecord(config.opencodeCliEnv),
        cursorCliEnv: sortedRecord(config.cursorCliEnv),
        codebuddyCliEnv: sortedRecord(config.codebuddyCliEnv),
        qoderCliEnv: sortedRecord(config.qoderCliEnv),
      }),
    ),
  });
}

function fresh(loadedAt: number | undefined): boolean {
  return typeof loadedAt === "number" && Date.now() - loadedAt < CATALOG_TTL_MS;
}

function configPayload(config: AiConfigItem, modelId = config.model): AiConfigItem {
  return { ...config, model: modelId, runtimeEffort: null };
}

async function loadModels(config: AiConfigItem, force = false): Promise<AiModelInfo[]> {
  const signature = configSignature(config);
  const current = catalogs.get(config.id);
  if (!force && current?.status === "ready" && current.signature === signature && fresh(current.loadedAt)) {
    return current.models;
  }

  const requestKey = JSON.stringify([config.id, signature]);
  const pending = modelRequests.get(requestKey);
  if (pending) return pending;

  const previousModels = current?.signature === signature ? current.models : [];
  catalogs.set(config.id, { status: "loading", models: previousModels, signature });
  const request = api
    .aiListModels(configPayload(config))
    .then((models) => {
      const seen = new Set<string>();
      const uniqueModels = models.filter((model) => {
        const id = model.id.trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (catalogs.get(config.id)?.signature !== signature) return uniqueModels;
      catalogs.set(config.id, { status: "ready", models: uniqueModels, signature, loadedAt: Date.now() });
      for (const model of uniqueModels) {
        if (model.effortCapability) {
          effortCatalogs.set(effortKey(config.id, model.id), {
            status: "ready",
            capability: model.effortCapability,
            signature,
            loadedAt: Date.now(),
          });
        }
      }
      return uniqueModels;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (catalogs.get(config.id)?.signature === signature) {
        catalogs.set(config.id, { status: "error", models: previousModels, signature, error: message });
      }
      throw error;
    })
    .finally(() => {
      modelRequests.delete(requestKey);
    });

  modelRequests.set(requestKey, request);
  return request;
}

async function resolveEffort(config: AiConfigItem, modelId: string, force = false): Promise<AiEffortCapability> {
  const key = effortKey(config.id, modelId);
  const signature = configSignature(config);
  const current = effortCatalogs.get(key);
  if (!force && current?.status === "ready" && current.signature === signature && current.capability && fresh(current.loadedAt)) {
    return current.capability;
  }

  const requestKey = JSON.stringify([key, signature]);
  const pending = effortRequests.get(requestKey);
  if (pending) return pending;

  const previousCapability = current?.signature === signature ? current.capability : undefined;
  effortCatalogs.set(key, { status: "loading", capability: previousCapability, signature });
  const request = api
    .aiResolveModelEffort(configPayload(config, modelId), modelId)
    .then((capability) => {
      if (effortCatalogs.get(key)?.signature === signature) {
        effortCatalogs.set(key, { status: "ready", capability, signature, loadedAt: Date.now() });
      }
      return capability;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (effortCatalogs.get(key)?.signature === signature) {
        effortCatalogs.set(key, { status: "error", capability: previousCapability, signature, error: message });
      }
      throw error;
    })
    .finally(() => {
      effortRequests.delete(requestKey);
    });

  effortRequests.set(requestKey, request);
  return request;
}

export function useAiModelCatalog() {
  return {
    catalogs,
    effortCatalogs,
    loadModels,
    resolveEffort,
    effortKey,
  };
}
