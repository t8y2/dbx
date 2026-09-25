import { inject, onBeforeUnmount, provide, watch, type InjectionKey } from "vue";
import type { TabPageUiState, TabUiState } from "@/types/database";

export const MAX_TAB_PAGE_UI_STATE_BYTES = 64 * 1024;
export const TAB_UI_STATE_TRACK_DEBOUNCE_MS = 100;

interface TabUiStateContext {
  snapshot: TabPageUiState;
  update: (patch: TabPageUiState) => void;
}

const TAB_UI_STATE_KEY: InjectionKey<() => TabUiStateContext> = Symbol("dbx-tab-ui-state");

export function provideTabUiState(capture: () => TabUiStateContext): void {
  provide(TAB_UI_STATE_KEY, capture);
}

export function useTabUiState<T extends object>(
  defaults: T,
  namespace?: string,
): {
  initialState: T;
  update: (patch: Partial<T>) => void;
  track: (snapshot: () => Partial<T>) => void;
} {
  const context = inject(TAB_UI_STATE_KEY, undefined)?.();
  const initialState = { ...defaults, ...sanitizeTabPageUiState(namespace ? context?.snapshot[namespace] : context?.snapshot) } as T;
  let active = true;
  const update = (patch: Partial<T>) => {
    if (active) context?.update(namespace ? { [namespace]: patch } : (patch as TabPageUiState));
  };
  const track = (snapshot: () => Partial<T>, debounceMs = TAB_UI_STATE_TRACK_DEBOUNCE_MS) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      update(snapshot());
    };
    const schedule = () => {
      if (!active) return;
      if (timer !== undefined) clearTimeout(timer);
      if (debounceMs <= 0) {
        flush();
        return;
      }
      timer = setTimeout(flush, debounceMs);
    };
    const stop = watch(snapshot, schedule, { deep: true, flush: "post" });
    onBeforeUnmount(() => {
      stop();
      flush();
      active = false;
    });
  };
  return { initialState, update, track };
}

export function sanitizeTabPageUiState(value: unknown): TabPageUiState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const normalized = sanitizeValue(value, 0, new Set(), { remaining: MAX_TAB_PAGE_UI_STATE_BYTES }) as TabPageUiState | undefined;
    if (!normalized || !Object.keys(normalized).length) return undefined;
    if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_TAB_PAGE_UI_STATE_BYTES) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function sanitizeValue(value: unknown, depth: number, ancestors: Set<object>, budget: { remaining: number }): unknown {
  if (depth > 10) throw new Error("UI state nesting limit");
  budget.remaining -= typeof value === "string" ? new TextEncoder().encode(value).byteLength : 8;
  if (budget.remaining < 0) throw new Error("UI state size limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) throw new Error("Cyclic UI state");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return undefined;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 512) throw new Error("UI state array limit");
      return value.map((entry) => sanitizeValue(entry, depth + 1, ancestors, budget)).filter((entry) => entry !== undefined);
    }
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 128) throw new Error("UI state key limit");
    for (const [key, entry] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      budget.remaining -= new TextEncoder().encode(key).byteLength;
      const sanitized = sanitizeValue(entry, depth + 1, ancestors, budget);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeTabUiState(value: unknown): TabUiState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as TabUiState;
  const normalized: TabUiState = {};
  if (state.activeOutputView && ["result", "summary", "explain", "chart", "messages", "profile"].includes(state.activeOutputView)) normalized.activeOutputView = state.activeOutputView;
  if (typeof state.resultPaneOpen === "boolean") normalized.resultPaneOpen = state.resultPaneOpen;
  const sanitizedPage = sanitizeTabPageUiState(state.page);
  if (sanitizedPage) {
    const page: Record<string, TabPageUiState> = {};
    for (const [mode, snapshot] of Object.entries(sanitizedPage)) {
      const sanitized = sanitizeTabPageUiState(snapshot);
      if (sanitized) page[mode] = sanitized;
    }
    if (Object.keys(page).length) normalized.page = page;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}
