import type { AiConfig } from "@/types/ai";

export function isAiConnectionTestConfigCurrent(testedConfig: AiConfig, currentConfig: AiConfig): boolean {
  return JSON.stringify(testedConfig) === JSON.stringify(currentConfig);
}
