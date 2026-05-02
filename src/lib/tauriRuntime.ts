export function isTauriRuntime(globalObject: Record<string, unknown> = globalThis as Record<string, unknown>): boolean {
  return Boolean(globalObject.__TAURI_INTERNALS__ || globalObject.__TAURI__);
}
