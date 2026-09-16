// Shared test helper: compiles the MCP query-timeout debounce block extracted
// from EditorSettingsDialog.vue into a runnable harness. The source string is
// passed in by the caller so this module stays free of node:fs — the happy-dom
// integration spec cannot load node built-ins.
import ts from "typescript";

export interface McpQueryTimeoutHarness {
  onMcpQueryTimeoutInput: (event: Event) => void;
  flushMcpQueryTimeoutSave: () => void;
}

export function extractMcpQueryTimeoutDebounceBlock(source: string): string {
  const start = source.indexOf("const MCP_QUERY_TIMEOUT_SAVE_DEBOUNCE_MS");
  const end = source.indexOf("const mcpSelectableConnections", start);
  if (start < 0 || end < 0) throw new Error("Missing MCP query timeout debounce block");
  return source.slice(start, end);
}

export function createMcpQueryTimeoutHarness(options: {
  source: string;
  input: { value: string };
  policyQueryTimeoutSecs: number | null;
  saveMcpPolicy: (partial: { queryTimeoutSecs: number | null }, callbacks?: { onSuccess?: () => void; onFailure?: () => void }) => void;
  policyMutationBlocked?: { value: boolean };
  setSaveStatus?: (status: "idle" | "saving" | "saved" | "failed") => void;
  toast?: (message: string, duration: number) => void;
  t?: (key: string) => string;
}): McpQueryTimeoutHarness {
  const block = extractMcpQueryTimeoutDebounceBlock(options.source);
  const javascript = ts.transpileModule(block, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const factory = new Function("mcpQueryTimeoutInput", "settingsStore", "saveMcpPolicy", "toast", "t", "mcpPolicyControlsDisabled", "setMcpQueryTimeoutSaveStatus", `${javascript}\nreturn { onMcpQueryTimeoutInput, flushMcpQueryTimeoutSave };`);
  return factory(
    options.input,
    { mcpGlobalPolicy: { queryTimeoutSecs: options.policyQueryTimeoutSecs } },
    options.saveMcpPolicy,
    options.toast ?? (() => {}),
    options.t ?? ((key: string) => key),
    options.policyMutationBlocked ?? { value: false },
    options.setSaveStatus ?? (() => {}),
  ) as McpQueryTimeoutHarness;
}
