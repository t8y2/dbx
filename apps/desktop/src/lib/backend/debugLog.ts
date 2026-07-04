const DEBUG_LOG_ENABLED_KEY = "dbx-debug-logging-enabled";
const DEBUG_LOG_ENTRIES_KEY = "dbx-debug-log-entries";
const MAX_DEBUG_LOG_ENTRIES = 1500;
const MAX_TEXT_LENGTH = 4000;
const MAX_LABEL_LENGTH = 120;

type DebugLogLevel = "debug" | "info" | "log" | "warn" | "error";

interface DebugLogEntry {
  timestamp: string;
  level: DebugLogLevel;
  message: string;
}

let installed = false;
let originalConsole: Partial<Record<DebugLogLevel, (...args: unknown[]) => void>> = {};

function safeLocalStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore quota or unavailable storage errors. The app should keep running.
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function isDebugLoggingEnabled(): boolean {
  return safeLocalStorageGet(DEBUG_LOG_ENABLED_KEY) === "1";
}

function readEntries(): DebugLogEntry[] {
  const raw = safeLocalStorageGet(DEBUG_LOG_ENTRIES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_DEBUG_LOG_ENTRIES) : [];
  } catch {
    return [];
  }
}

function redactSensitiveText(value: string): string {
  return value.replace(/("(?:password|passphrase|apiKey|api_key|token|secret|connectionString|connection_string)"\s*:\s*")([^"]*)(")/gi, "$1[redacted]$3").replace(/\b(password|passphrase|apiKey|api_key|token|secret)=([^&\s]+)/gi, "$1=[redacted]");
}

function formatValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Error) {
    return redactSensitiveText([value.name, value.message, value.stack].filter(Boolean).join(": "));
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object" || value === null) return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    return redactSensitiveText(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        return item;
      }),
    );
  } catch {
    return redactSensitiveText(String(value));
  }
}

function formatArgs(args: unknown[]): string {
  const message = args.map((arg) => formatValue(arg)).join(" ");
  return message.length > MAX_TEXT_LENGTH ? `${message.slice(0, MAX_TEXT_LENGTH)}...` : message;
}

export function appendDebugLog(level: DebugLogLevel, ...args: unknown[]) {
  if (!isDebugLoggingEnabled()) return;
  const entries = readEntries();
  entries.push({
    timestamp: new Date().toISOString(),
    level,
    message: formatArgs(args),
  });
  safeLocalStorageSet(DEBUG_LOG_ENTRIES_KEY, JSON.stringify(entries.slice(-MAX_DEBUG_LOG_ENTRIES)));
}

export function setDebugLoggingEnabled(enabled: boolean) {
  safeLocalStorageSet(DEBUG_LOG_ENABLED_KEY, enabled ? "1" : "0");
  if (enabled) {
    appendDebugLog("info", "[DBX][debug-log] enabled", {
      url: location.href,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      language: navigator.language,
      online: navigator.onLine,
    });
  }
}

export function clearDebugLogs() {
  safeLocalStorageRemove(DEBUG_LOG_ENTRIES_KEY);
}

export function getDebugLogText(): string {
  const entries = readEntries();
  const header = [`DBX debug log`, `Exported: ${new Date().toISOString()}`, `User agent: ${navigator.userAgent}`, `Platform: ${navigator.platform}`, `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}`, ""];
  const body = entries.map((entry) => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`);
  return [...header, ...body].join("\n");
}

export async function downloadDebugLogs() {
  const text = await getDebugLogBundleText();
  const filename = `dbx-debug-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  if (typeof window !== "undefined" && isTauriRuntimeLike()) {
    const [{ save }, { writeTextFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export async function getDebugLogBundleText(): Promise<string> {
  const sections = [getDebugLogText()];
  const nativeLogs = await loadNativeDebugLogs().catch((error) => `Failed to load native logs: ${formatValue(error)}`);
  if (nativeLogs) {
    sections.push(["", "===== Native / Tauri logs =====", nativeLogs].join("\n"));
  }
  return sections.join("\n");
}

async function loadNativeDebugLogs(): Promise<string> {
  if (!isTauriRuntimeLike()) return "";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("load_native_debug_logs");
}

function isTauriRuntimeLike(): boolean {
  return "__TAURI_INTERNALS__" in globalThis || "__TAURI__" in globalThis;
}

export function installDebugLogCapture() {
  if (installed) return;
  installed = true;
  originalConsole = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  (Object.keys(originalConsole) as DebugLogLevel[]).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      appendDebugLog(level, ...args);
      originalConsole[level]?.(...args);
    };
  });
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      appendDebugLog("error", "[window:resource-error]", describeElement(target));
      return;
    }
    appendDebugLog("error", "[window:error]", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    appendDebugLog("error", "[window:unhandledrejection]", event.reason);
  });
  window.addEventListener("online", () => appendDebugLog("info", "[window:online]"));
  window.addEventListener("offline", () => appendDebugLog("warn", "[window:offline]"));
  window.addEventListener("hashchange", () => appendDebugLog("info", "[window:hashchange]", location.hash));
  document.addEventListener("visibilitychange", () => {
    appendDebugLog("info", "[document:visibilitychange]", document.visibilityState);
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof HTMLElement ? interactiveElement(event.target) : null;
      if (!target) return;
      appendDebugLog("debug", "[ui:click]", describeElement(target));
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || !isFormControl(target)) return;
      appendDebugLog("debug", "[ui:change]", describeElement(target));
    },
    true,
  );
  installPerformanceCapture();
}

function installPerformanceCapture() {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 250) {
          appendDebugLog("warn", "[performance:long-task]", {
            name: entry.name,
            durationMs: Math.round(entry.duration),
            startTimeMs: Math.round(entry.startTime),
          });
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Long task entries are not available in every WebView.
  }
}

function interactiveElement(target: HTMLElement): HTMLElement | null {
  return target.closest(["button", "a[href]", "input", "select", "textarea", "[role='button']", "[role='menuitem']", "[role='tab']", "[data-debug-id]"].join(","));
}

function isFormControl(target: HTMLElement): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target.getAttribute("role") === "switch";
}

function describeElement(element: HTMLElement): Record<string, string> {
  const label = element.getAttribute("data-debug-id") || element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "";
  const attrs: Record<string, string> = {
    tag: element.tagName.toLowerCase(),
  };
  if (element.id) attrs.id = element.id;
  const role = element.getAttribute("role");
  if (role) attrs.role = role;
  const type = element.getAttribute("type");
  if (type) attrs.type = type;
  const safeLabel = redactSensitiveText(label.trim().replace(/\s+/g, " "));
  if (safeLabel) attrs.label = safeLabel.slice(0, MAX_LABEL_LENGTH);
  const testId = element.getAttribute("data-testid");
  if (testId) attrs.testId = testId;
  return attrs;
}
