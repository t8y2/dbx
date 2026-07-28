export const LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD = 120 * 1024;
export const LARGE_PASTE_HISTORY_USER_EVENT = "input.type.paste";

export function normalizeQueryEditorPasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function shouldRecoverLargeTauriPaste(eventText: string, tauriRuntime: boolean): boolean {
  if (!tauriRuntime || !eventText) return false;
  if (eventText.length >= LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD) return true;
  return new TextEncoder().encode(eventText).byteLength >= LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD;
}

export function recoverableNativePasteSuffix(eventText: string, nativeText: string): string | null {
  const normalizedEventText = normalizeQueryEditorPasteText(eventText);
  const normalizedNativeText = normalizeQueryEditorPasteText(nativeText);
  if (normalizedNativeText.length <= normalizedEventText.length || !normalizedNativeText.startsWith(normalizedEventText)) return null;
  return normalizedNativeText.slice(normalizedEventText.length);
}
