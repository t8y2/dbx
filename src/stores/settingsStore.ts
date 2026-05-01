import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/lib/tauri";

export type AiProvider = "claude" | "openai" | "custom";
export type AiApiStyle = "completions" | "responses";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  endpoint: string;
  model: string;
  apiStyle: AiApiStyle;
}

const defaultConfigs: Record<AiProvider, Omit<AiConfig, "apiKey">> = {
  claude: { provider: "claude", endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-20250514", apiStyle: "completions" },
  openai: { provider: "openai", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o", apiStyle: "completions" },
  custom: { provider: "custom", endpoint: "", model: "", apiStyle: "completions" },
};

export const useSettingsStore = defineStore("settings", () => {
  const aiConfig = ref<AiConfig>({ ...defaultConfigs.claude, apiKey: "", apiStyle: "completions" });
  const isAiConfigLoaded = ref(false);

  async function initAiConfig() {
    if (isAiConfigLoaded.value) return;
    const legacy = localStorage.getItem("dbx-ai-config");
    const saved = await api.loadAiConfig().catch(() => null);
    if (saved) {
      aiConfig.value = saved;
    } else if (legacy) {
      aiConfig.value = JSON.parse(legacy);
      await api.saveAiConfig(aiConfig.value).catch(() => {});
      localStorage.removeItem("dbx-ai-config");
    }
    isAiConfigLoaded.value = true;
  }

  function updateAiConfig(config: Partial<AiConfig>) {
    const previousProvider = aiConfig.value.provider;
    if (config.provider && config.provider !== previousProvider) {
      Object.assign(aiConfig.value, defaultConfigs[config.provider]);
    }
    Object.assign(aiConfig.value, config);
    api.saveAiConfig(aiConfig.value).catch(() => {});
  }

  function isConfigured(): boolean {
    return !!aiConfig.value.apiKey && !!aiConfig.value.endpoint;
  }

  return { aiConfig, isAiConfigLoaded, initAiConfig, updateAiConfig, isConfigured };
});
