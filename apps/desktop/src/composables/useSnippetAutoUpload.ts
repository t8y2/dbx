import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { snippetPassphraseStatus, snippetSyncSettings, snippetSyncUpload, snippetTokenStatus } from "@/lib/backend/api";
import {
  readSnippetAutoUploadConfig,
  readSnippetAutoUploadSelection,
  readSnippetRemoteContentHash,
  SNIPPET_AUTO_UPLOAD_CONFIG_CHANGED_EVENT,
  withSnippetSyncLock,
  writeSnippetAutoUploadFields,
  writeSnippetLastSuccessfulUpload,
  writeSnippetRemoteContentHash,
} from "@/lib/cloudSync/snippetAutoUploadConfig";

export function useSnippetAutoUpload() {
  const settingsStore = useSettingsStore();
  let timer: ReturnType<typeof window.setInterval> | undefined;
  let uploading = false;

  function clearTimer() {
    if (!timer) return;
    window.clearInterval(timer);
    timer = undefined;
  }

  function stopAutoUpload(provider: "github" | "gitee" | "gitlab", instanceUrl: string | undefined, intervalMinutes: number) {
    writeSnippetAutoUploadFields(provider, instanceUrl, { enabled: false, intervalMinutes });
  }

  function schedule() {
    clearTimer();
    const config = readSnippetAutoUploadConfig();
    if (!config.enabled) return;
    timer = window.setInterval(() => {
      void runAutoUpload();
    }, config.intervalMinutes * 60_000);
  }

  async function runAutoUpload() {
    if (uploading || !readSnippetAutoUploadConfig().enabled) return;
    uploading = true;
    let config = readSnippetAutoUploadConfig();
    try {
      await withSnippetSyncLock(async () => {
        config = readSnippetAutoUploadConfig();
        if (!config.enabled) return;
        const settings = await snippetSyncSettings(config.provider, config.instanceUrl);
        const snippetId = settings.snippetId?.trim();
        const remoteContentHash = snippetId ? readSnippetRemoteContentHash(config.provider, config.instanceUrl, snippetId) : undefined;
        if (!snippetId || !remoteContentHash) {
          stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
          appendDebugLog("error", "[DBX][snippet:auto-upload:paused]", "A manual upload or download is required before automatic uploads can start.");
          return;
        }

        const account = { provider: config.provider, instanceUrl: config.instanceUrl, snippetId };
        const [tokenStatus, passphraseStatus] = await Promise.all([snippetTokenStatus(account), snippetPassphraseStatus(account)]);
        if (!tokenStatus.hasSavedToken || !passphraseStatus.hasSavedPassphrase) {
          stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
          appendDebugLog("error", "[DBX][snippet:auto-upload:paused]", "A saved snippet token and encryption password are required for automatic uploads.");
          return;
        }

        const summary = await snippetSyncUpload(account, settingsStore.editorSettings, undefined, false, undefined, readSnippetAutoUploadSelection(config.provider, config.instanceUrl), remoteContentHash);
        if (!summary.remoteContentHash) {
          stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
          appendDebugLog("error", "[DBX][snippet:auto-upload:paused]", "The provider did not return a remote content hash.");
          return;
        }
        writeSnippetRemoteContentHash(config.provider, config.instanceUrl, summary.snippetId, summary.remoteContentHash);
        if (!summary.unchanged) writeSnippetLastSuccessfulUpload(config.provider, config.instanceUrl, summary.snippetId);
        appendDebugLog("info", "[DBX][snippet:auto-upload:success]", {
          provider: config.provider,
          snippetId: summary.snippetId,
          bytes: summary.bytes,
          unchanged: summary.unchanged,
          exportedAt: summary.exportedAt,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("remote snippet changed since the last successful upload")) {
        stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
      }
      if (message.includes("encrypted credentials")) {
        stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
      }
      if (message.includes("legacy unencrypted") || message.includes("failed with HTTP 404") || message.includes("Snippet does not contain")) {
        stopAutoUpload(config.provider, config.instanceUrl, config.intervalMinutes);
      }
      appendDebugLog("error", "[DBX][snippet:auto-upload:error]", { provider: config.provider, message });
    } finally {
      uploading = false;
    }
  }

  onMounted(() => {
    schedule();
    window.addEventListener(SNIPPET_AUTO_UPLOAD_CONFIG_CHANGED_EVENT, schedule);
    window.addEventListener("storage", schedule);
  });

  onUnmounted(() => {
    clearTimer();
    window.removeEventListener(SNIPPET_AUTO_UPLOAD_CONFIG_CHANGED_EVENT, schedule);
    window.removeEventListener("storage", schedule);
  });

  return {
    scheduleSnippetAutoUpload: schedule,
    runSnippetAutoUpload: runAutoUpload,
  };
}
