import { computed, onScopeDispose, ref, watch, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { externalSqlFileContentMatchesBaseline, externalSqlFileMetadataMatches, externalSqlFileVersionWasIgnored } from "@/lib/sql/externalSqlFileChanges";
import { useQueryStore } from "@/stores/queryStore";
import type { ExternalSqlFileSnapshot } from "@/lib/backend/tauri";
import type { QueryTab } from "@/types/database";

export type ExternalSqlFilePromptDecision = "load" | "keep" | "overwrite" | "recreate" | "saveAs" | "close" | "cancel";

export type ExternalSqlFilePrompt =
  | {
      kind: "modified";
      context: "reload" | "save";
      tabId: string;
      path: string;
      dirty: boolean;
      snapshot: ExternalSqlFileSnapshot;
    }
  | {
      kind: "deleted";
      context: "reload" | "save";
      tabId: string;
      path: string;
      dirty: boolean;
    };

type DetectedExternalSqlFileChange =
  | {
      kind: "modified";
      tabId: string;
      path: string;
      dirty: boolean;
      snapshot: ExternalSqlFileSnapshot;
    }
  | {
      kind: "deleted";
      tabId: string;
      path: string;
      dirty: boolean;
    };

interface UseExternalSqlFileChangesOptions {
  activeTab: ComputedRef<QueryTab | undefined>;
  recreateFile: (tab: QueryTab) => Promise<boolean>;
  saveAsFile: (tab: QueryTab) => Promise<boolean>;
  closeTab: (tab: QueryTab) => void;
  reportError: (message: string) => void;
}

export interface ExternalSqlFileSavePreparation {
  proceed: boolean;
  expectedContentHash?: string;
  expectedMissing?: boolean;
}

const MISSING_FILE_RECHECK_DELAY_MS = 180;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function useExternalSqlFileChanges(options: UseExternalSqlFileChangesOptions) {
  const { t } = useI18n();
  const queryStore = useQueryStore();
  const pendingPrompt = ref<ExternalSqlFilePrompt | null>(null);
  const checkingTabIds = new Set<string>();
  let promptResolver: ((decision: ExternalSqlFilePromptDecision) => void) | null = null;
  let checksSuspended = 0;
  let disposed = false;
  let unlistenWindowFocus: (() => void) | undefined;

  const promptOpen = computed(() => pendingPrompt.value !== null);

  async function inspectStableFile(path: string) {
    let status = await api.inspectExternalSqlFile(path);
    if (status.kind === "missing") {
      await delay(MISSING_FILE_RECHECK_DELAY_MS);
      status = await api.inspectExternalSqlFile(path);
    }
    return status;
  }

  async function readStableSnapshot(path: string) {
    try {
      return await api.readExternalSqlFileSnapshot(path);
    } catch (firstError) {
      await delay(MISSING_FILE_RECHECK_DELAY_MS);
      try {
        return await api.readExternalSqlFileSnapshot(path);
      } catch {
        throw firstError;
      }
    }
  }

  async function detectChange(tab: QueryTab, forceContentCheck = false): Promise<DetectedExternalSqlFileChange | null> {
    if (!tab.externalSqlPath || !isTauriRuntime() || checkingTabIds.has(tab.id)) return null;
    checkingTabIds.add(tab.id);
    try {
      const status = await inspectStableFile(tab.externalSqlPath);
      if (status.kind === "missing") {
        if (!forceContentCheck && tab.externalSqlFileMissing) return null;
        return {
          kind: "deleted",
          tabId: tab.id,
          path: tab.externalSqlPath,
          dirty: queryStore.isTabDirty(tab),
        };
      }

      if (!forceContentCheck && !tab.externalSqlFileMissing && externalSqlFileMetadataMatches(tab.externalSqlFileVersion, status)) return null;

      const snapshot = await readStableSnapshot(tab.externalSqlPath);
      if (externalSqlFileContentMatchesBaseline(tab, snapshot) || (!tab.externalSqlFileVersion && tab.sql === snapshot.content)) {
        queryStore.updateExternalSqlFileVersion(tab.id, snapshot.version);
        return null;
      }
      if (!forceContentCheck && externalSqlFileVersionWasIgnored(tab, snapshot)) return null;

      return {
        kind: "modified",
        tabId: tab.id,
        path: tab.externalSqlPath,
        dirty: queryStore.isTabDirty(tab),
        snapshot,
      };
    } finally {
      checkingTabIds.delete(tab.id);
    }
  }

  function requestDecision(change: DetectedExternalSqlFileChange, context: ExternalSqlFilePrompt["context"]): Promise<ExternalSqlFilePromptDecision> {
    if (promptResolver) return Promise.resolve("cancel");
    pendingPrompt.value = { ...change, context } as ExternalSqlFilePrompt;
    return new Promise((resolve) => {
      promptResolver = resolve;
    });
  }

  function resolvePrompt(decision: ExternalSqlFilePromptDecision) {
    const resolve = promptResolver;
    promptResolver = null;
    pendingPrompt.value = null;
    resolve?.(decision);
  }

  async function loadLatest(tab: QueryTab) {
    if (!tab.externalSqlPath) return false;
    try {
      const snapshot = await readStableSnapshot(tab.externalSqlPath);
      queryStore.applyExternalSqlFileSnapshot(tab.id, snapshot.content, snapshot.version);
      return true;
    } catch (error: any) {
      options.reportError(t("externalSqlFile.loadFailed", { message: error?.message || String(error) }));
      return false;
    }
  }

  async function handleDeletedDecision(tab: QueryTab, decision: ExternalSqlFilePromptDecision) {
    checksSuspended += 1;
    try {
      if (decision === "recreate") await options.recreateFile(tab);
      else if (decision === "saveAs") await options.saveAsFile(tab);
      else if (decision === "close") options.closeTab(tab);
      else if (decision === "keep") queryStore.acknowledgeExternalSqlFileMissing(tab.id);
    } finally {
      checksSuspended -= 1;
    }
  }

  async function checkActiveFile() {
    if (checksSuspended || pendingPrompt.value) return;
    const tab = options.activeTab.value;
    if (!tab?.externalSqlPath) return;
    try {
      const change = await detectChange(tab);
      if (!change || !queryStore.tabs.some((candidate) => candidate.id === tab.id)) return;
      const decision = await requestDecision(change, "reload");
      if (change.kind === "modified") {
        if (decision === "load") await loadLatest(tab);
        else if (decision === "keep") queryStore.ignoreExternalSqlFileVersion(tab.id, change.snapshot.version);
      } else {
        await handleDeletedDecision(tab, decision);
      }
    } catch (error: any) {
      options.reportError(t("externalSqlFile.checkFailed", { message: error?.message || String(error) }));
    }
  }

  async function prepareSave(tab: QueryTab): Promise<ExternalSqlFileSavePreparation> {
    if (!tab.externalSqlPath) return { proceed: true };
    checksSuspended += 1;
    try {
      const change = await detectChange(tab, true);
      if (!change) {
        return {
          proceed: true,
          expectedContentHash: tab.externalSqlFileVersion?.contentHash,
        };
      }

      const decision = await requestDecision(change, "save");
      if (change.kind === "modified") {
        if (decision === "overwrite") {
          return {
            proceed: true,
            expectedContentHash: change.snapshot.version.contentHash,
          };
        }
        if (decision === "load") await loadLatest(tab);
        return { proceed: false };
      }

      if (decision === "recreate") return { proceed: true, expectedMissing: true };
      await handleDeletedDecision(tab, decision);
      return { proceed: false };
    } catch (error: any) {
      options.reportError(t("externalSqlFile.checkFailed", { message: error?.message || String(error) }));
      return { proceed: false };
    } finally {
      checksSuspended -= 1;
    }
  }

  watch(
    () => options.activeTab.value?.id,
    () => {
      if (!disposed) void checkActiveFile();
    },
    { flush: "post" },
  );

  if (isTauriRuntime()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload && !disposed) void checkActiveFile();
        }),
      )
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenWindowFocus = unlisten;
      })
      .catch(() => {});
  }

  onScopeDispose(() => {
    disposed = true;
    unlistenWindowFocus?.();
    promptResolver?.("cancel");
    promptResolver = null;
  });

  return {
    pendingPrompt,
    promptOpen,
    resolvePrompt,
    checkActiveFile,
    prepareSave,
  };
}
