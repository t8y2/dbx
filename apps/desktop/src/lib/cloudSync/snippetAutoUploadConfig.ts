import type { SnippetProvider, SyncSelection } from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const SNIPPET_AUTO_UPLOAD_CONFIG_CHANGED_EVENT = "dbx:snippet-auto-upload-config-changed";
export const SNIPPET_LAST_UPLOAD_CHANGED_EVENT = "dbx:snippet-last-upload-changed";
export const SNIPPET_AUTO_UPLOAD_SELECTION_STORAGE_KEY_PREFIX = "dbx-snippet-auto-upload-selection-";
const SNIPPET_LAST_UPLOAD_STORAGE_KEY_PREFIX = "dbx-snippet-last-upload-";
export const DEFAULT_SNIPPET_AUTO_UPLOAD_INTERVAL_MINUTES = 30;
export const MAX_SNIPPET_AUTO_UPLOAD_INTERVAL_MINUTES = 1440;

let snippetSyncQueue: Promise<void> = Promise.resolve();

export async function withSnippetSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = snippetSyncQueue;
  let release!: () => void;
  snippetSyncQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface SnippetAutoUploadConfig {
  provider: SnippetProvider;
  instanceUrl?: string;
  enabled: boolean;
  intervalMinutes: number;
}

function normalizedProvider(value: string | null): SnippetProvider {
  return value === "gitee" || value === "gitlab" ? value : "github";
}

export function normalizedSnippetAutoUploadInterval(value: unknown): number {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return DEFAULT_SNIPPET_AUTO_UPLOAD_INTERVAL_MINUTES;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_SNIPPET_AUTO_UPLOAD_INTERVAL_MINUTES;
  return Math.max(1, Math.min(MAX_SNIPPET_AUTO_UPLOAD_INTERVAL_MINUTES, Math.round(numberValue)));
}

function snippetScope(provider: SnippetProvider, instanceUrl?: string): string {
  const scope = provider === "gitlab" ? instanceUrl?.trim().replace(/\/$/, "") || "https://gitlab.com" : "default";
  return `${provider}-${encodeURIComponent(scope)}`;
}

function preferenceKey(kind: "enabled" | "interval", provider: SnippetProvider, instanceUrl?: string): string {
  return `dbx-snippet-auto-upload-${kind}-${snippetScope(provider, instanceUrl)}`;
}

export function readSnippetAutoUploadConfig(): SnippetAutoUploadConfig {
  const provider = normalizedProvider(safeLocalStorageGet("dbx-snippet-provider"));
  const instanceUrl = safeLocalStorageGet("dbx-gitlab-instance-url")?.trim().replace(/\/$/, "") || "https://gitlab.com";
  return {
    provider,
    instanceUrl: provider === "gitlab" ? instanceUrl : undefined,
    enabled: safeLocalStorageGet(preferenceKey("enabled", provider, instanceUrl)) === "true",
    intervalMinutes: normalizedSnippetAutoUploadInterval(safeLocalStorageGet(preferenceKey("interval", provider, instanceUrl))),
  };
}

export function writeSnippetAutoUploadFields(provider: SnippetProvider, instanceUrl: string | undefined, values: { enabled: boolean; intervalMinutes: unknown }) {
  safeLocalStorageSet(preferenceKey("enabled", provider, instanceUrl), String(values.enabled));
  safeLocalStorageSet(preferenceKey("interval", provider, instanceUrl), String(normalizedSnippetAutoUploadInterval(values.intervalMinutes)));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SNIPPET_AUTO_UPLOAD_CONFIG_CHANGED_EVENT));
}

export function snippetAutoUploadSelectionKey(provider: SnippetProvider, instanceUrl?: string): string {
  return `${SNIPPET_AUTO_UPLOAD_SELECTION_STORAGE_KEY_PREFIX}${snippetScope(provider, instanceUrl)}`;
}

export function readSnippetAutoUploadSelection(provider: SnippetProvider, instanceUrl?: string): SyncSelection | undefined {
  const serialized = safeLocalStorageGet(snippetAutoUploadSelectionKey(provider, instanceUrl));
  if (!serialized) return undefined;
  try {
    const selection = JSON.parse(serialized) as SyncSelection;
    if (typeof selection !== "object" || selection === null || typeof selection.includeSecrets !== "boolean") return undefined;
    return { ...selection, includeSecrets: false };
  } catch {
    return undefined;
  }
}

export function writeSnippetAutoUploadSelection(provider: SnippetProvider, instanceUrl: string | undefined, selection: SyncSelection) {
  safeLocalStorageSet(snippetAutoUploadSelectionKey(provider, instanceUrl), JSON.stringify({ ...selection, includeSecrets: false }));
}

export function snippetRemoteContentHashKey(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string): string {
  return `dbx-snippet-auto-upload-remote-hash-${snippetScope(provider, instanceUrl)}-${encodeURIComponent(snippetId.trim())}`;
}

export function readSnippetRemoteContentHash(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string): string | undefined {
  return safeLocalStorageGet(snippetRemoteContentHashKey(provider, instanceUrl, snippetId)) || undefined;
}

export function writeSnippetRemoteContentHash(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string, remoteContentHash: string | undefined) {
  const key = snippetRemoteContentHashKey(provider, instanceUrl, snippetId);
  if (remoteContentHash) safeLocalStorageSet(key, remoteContentHash);
  else safeLocalStorageRemove(key);
}

function snippetLastUploadKey(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string): string {
  return `${SNIPPET_LAST_UPLOAD_STORAGE_KEY_PREFIX}${snippetScope(provider, instanceUrl)}-${encodeURIComponent(snippetId.trim())}`;
}

export function readSnippetLastSuccessfulUpload(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string): string | undefined {
  if (!snippetId.trim()) return undefined;
  return safeLocalStorageGet(snippetLastUploadKey(provider, instanceUrl, snippetId)) || undefined;
}

export function writeSnippetLastSuccessfulUpload(provider: SnippetProvider, instanceUrl: string | undefined, snippetId: string, uploadedAt = new Date().toISOString()) {
  if (!snippetId.trim()) return;
  safeLocalStorageSet(snippetLastUploadKey(provider, instanceUrl, snippetId), uploadedAt);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SNIPPET_LAST_UPLOAD_CHANGED_EVENT));
}
