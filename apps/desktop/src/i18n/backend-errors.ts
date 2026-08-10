import { normalizeBackendError, sanitizeBackendErrorMessage, type BackendError } from "@/lib/backend/errorUtils";
import { PHOENIX_DRIVER_NOT_INSTALLED_ERROR, PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR } from "@/lib/database/phoenixConnection";

/**
 * Minimal shape of a translate function, satisfied by both `useI18n().t` inside
 * components and `i18n.global.t` in stores and composables. Using the full
 * `ComposerTranslation` type here would reject the latter, because the global
 * composer is typed against the concrete message schema.
 */
export type BackendErrorTranslate = {
  (key: string): string;
  (key: string, named: Record<string, unknown>): string;
};

const taggedAiCliErrorKeys: Record<string, string> = {
  claudeCodeNotInstalled: "ai.cliErrors.claudeCodeNotInstalled",
  claudeCodeCliPathInvalid: "ai.cliErrors.claudeCodeCliPathInvalid",
  claudeCodeEnvInvalid: "ai.cliErrors.claudeCodeEnvInvalid",
  claudeCodeEnvReserved: "ai.cliErrors.claudeCodeEnvReserved",
  claudeCodeNotAuthenticated: "ai.cliErrors.claudeCodeNotAuthenticated",
  claudeCodeMcpConfigInvalid: "ai.cliErrors.claudeCodeMcpConfigInvalid",
  dbxMcpMissing: "ai.cliErrors.dbxMcpMissing",
  claudeCodeMcpStartupFailed: "ai.cliErrors.claudeCodeMcpStartupFailed",
  claudeCodeCommandLineTooLong: "ai.cliErrors.claudeCodeCommandLineTooLong",
  claudeCodeRunFailed: "ai.cliErrors.claudeCodeRunFailed",
  piAgentNotInstalled: "ai.cliErrors.piAgentNotInstalled",
  piAgentCliPathInvalid: "ai.cliErrors.piAgentCliPathInvalid",
  piAgentEnvInvalid: "ai.cliErrors.piAgentEnvInvalid",
  piAgentEnvReserved: "ai.cliErrors.piAgentEnvReserved",
  piAgentNotAuthenticated: "ai.cliErrors.piAgentNotAuthenticated",
  piAgentMcpStartupFailed: "ai.cliErrors.piAgentMcpStartupFailed",
  piAgentTimeout: "ai.cliErrors.piAgentTimeout",
  piAgentProtocolError: "ai.cliErrors.piAgentProtocolError",
  piAgentModelInvalid: "ai.cliErrors.piAgentModelInvalid",
  piAgentRunFailed: "ai.cliErrors.piAgentRunFailed",
  openCodeNotInstalled: "ai.cliErrors.openCodeNotInstalled",
  openCodeCliPathInvalid: "ai.cliErrors.openCodeCliPathInvalid",
  openCodeEnvInvalid: "ai.cliErrors.openCodeEnvInvalid",
  openCodeEnvReserved: "ai.cliErrors.openCodeEnvReserved",
  openCodeNotAuthenticated: "ai.cliErrors.openCodeNotAuthenticated",
  openCodeMcpStartupFailed: "ai.cliErrors.openCodeMcpStartupFailed",
  openCodeTimeout: "ai.cliErrors.openCodeTimeout",
  openCodeProtocolError: "ai.cliErrors.openCodeProtocolError",
  openCodeRunFailed: "ai.cliErrors.openCodeRunFailed",
  cursorNotInstalled: "ai.cliErrors.cursorNotInstalled",
  cursorCliPathInvalid: "ai.cliErrors.cursorCliPathInvalid",
  grokCliNotInstalled: "ai.cliErrors.grokCliNotInstalled",
  grokCliPathInvalid: "ai.cliErrors.grokCliPathInvalid",
  grokCliEnvInvalid: "ai.cliErrors.grokCliEnvInvalid",
  grokCliEnvReserved: "ai.cliErrors.grokCliEnvReserved",
  grokCliNotAuthenticated: "ai.cliErrors.grokCliNotAuthenticated",
  grokCliMcpStartupFailed: "ai.cliErrors.grokCliMcpStartupFailed",
  grokCliCommandLineTooLong: "ai.cliErrors.grokCliCommandLineTooLong",
  grokCliRunFailed: "ai.cliErrors.grokCliRunFailed",
  cursorEnvInvalid: "ai.cliErrors.cursorEnvInvalid",
  cursorEnvReserved: "ai.cliErrors.cursorEnvReserved",
  cursorNotAuthenticated: "ai.cliErrors.cursorNotAuthenticated",
  cursorMcpStartupFailed: "ai.cliErrors.cursorMcpStartupFailed",
  cursorTimeout: "ai.cliErrors.cursorTimeout",
  cursorProtocolError: "ai.cliErrors.cursorProtocolError",
  cursorRunFailed: "ai.cliErrors.cursorRunFailed",
};

const exactMessageKeys: Record<string, string> = {
  [PHOENIX_DRIVER_NOT_INSTALLED_ERROR]: "connection.phoenixDriverNotInstalled",
  [PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR]: "connection.phoenixDriverNotInstalled",
};

const patterns: [RegExp, string][] = [
  [/^(.+?) driver is not installed\. Please install it from the Driver Manager\.$/, "connection.driverNotInstalled"],
  [/^JRE (.+?) runtime is not installed\. Please install it from the Driver Manager\.$/, "connection.jreNotInstalled"],
  [/^System Java runtime was not found on PATH\. Please install Java or choose a custom Java executable\.$/, "connection.systemJavaNotFound"],
  [/^Custom Java runtime path is empty\. Please choose a Java executable\.$/, "connection.customJavaPathEmpty"],
  [/^Agent requires Java 21, but DBX started it with an older Java runtime\. Use DBX managed JRE 21 or select a Java 21 executable in Driver Manager\./, "connection.agentJavaTooOld"],
  [/^JDBC plugin is not installed\. Install the optional JDBC plugin to use this connection\.$/, "connection.jdbcPluginNotInstalled"],
  [/GBASEDBTSERVER[\s\S]*DBSERVERNAME[\s\S]*DBSERVERALIASES/, "connection.gbaseServerMismatch"],
  [/^ai\.configNameExists:(.+)$/, "ai.configNameExists"],

  // Tunnel / proxy test messages
  [/^HTTP CONNECT proxy connection successful \((\d+)\)$/, "settings.tunnelsHttpTestSuccess"],
  [/^SOCKS5 proxy connection successful$/, "settings.tunnelsSocks5TestSuccess"],
  [/^SSH tunnel connection successful$/, "settings.tunnelsTestSuccess"],
  [/^Proxy host is required\.$/, "settings.tunnelsProxyHostRequired"],
  [/^Proxy port is required\.$/, "settings.tunnelsProxyPortRequired"],
  [/^SSH host is required\.$/, "settings.tunnelsSshHostRequired"],
  [/^Tunnel test is not supported for HTTP tunnel profiles\.$/, "settings.tunnelsHttpTunnelUnsupported"],
  [/^Proxy connection timed out \(([^)]+)\)$/, "settings.tunnelsProxyTimedOut"],
  [/^Failed to connect to proxy: (.+)$/, "settings.tunnelsProxyConnectFailed"],
  [/^Proxy handshake failed \([^)]+\): (.+)$/, "settings.tunnelsProxyHandshakeFailed"],
  [/^Proxy handshake timed out \(([^)]+)\)$/, "settings.tunnelsProxyHandshakeTimedOut"],
  [/^HTTP proxy CONNECT failed: (.+)$/, "settings.tunnelsHttpConnectFailed"],
  [/^Invalid SOCKS proxy version: (\d+)$/, "settings.tunnelsSocksInvalidVersion"],
  [/^SOCKS username or password is too long$/, "settings.tunnelsSocksAuthTooLong"],
  [/^SOCKS proxy authentication failed$/, "settings.tunnelsSocksAuthFailed"],
  [/^SOCKS proxy rejected all supported auth methods$/, "settings.tunnelsSocksAuthRejected"],
  [/^SOCKS proxy selected unsupported auth method: (\d+)$/, "settings.tunnelsSocksUnsupportedAuth"],
  [/^Proxy host too long for SOCKS5 domain address$/, "settings.tunnelsSocksHostTooLong"],
  [/^SOCKS proxy connect rejected \(code (\d+)\)$/, "settings.tunnelsSocksConnectRejected"],
  [/^Unsupported SOCKS bound address type: (\d+)$/, "settings.tunnelsSocksUnsupportedAddrType"],

  // SSH keyboard-interactive prompts (for example JumpServer TOTP).
  [/^(?:SSH layer \d+ failed:\s*)?SSH keyboard-interactive authentication was cancelled$/, "connection.sshTotpCancelled"],

  // Query result export limits (crates/dbx-core/src/query_result_export.rs)
  [/^Streaming export is unsupported for this query\. Simplify it or use a supported driver\.$/, "exportProgress.streamingUnsupported"],
  [/^Streaming export needs a result-set session, but this driver returned no session_id\.$/, "exportProgress.agentSessionMissing"],

  // Legacy bundled DuckDB error kept for compatibility with older backends.
  [/^The previous DuckDB query is still stopping\. Please try again shortly\.$/, "editor.duckdbDraining"],

  // Driver / JRE management (crates/dbx-core/src/agent_service.rs, routes/agents.rs)
  // The Windows variant is multi-line, so it must be tried before the single-line one.
  [/^Failed to remove the old JRE directory: (.+)\nPossible causes:[\s\S]*\(original error: ([\s\S]+)\)$/, "driverStore.jreDirRemoveFailedWindows"],
  [/^Failed to remove the old JRE directory: (.+) \(original error: ([\s\S]+)\)$/, "driverStore.jreDirRemoveFailed"],
  [/^JRE (.+?) is in use by drivers: (.+)\. Uninstall them first\.$/, "driverStore.jreInUseByDrivers"],
  [/^agent-registry\.json not found in the ZIP; not a valid offline driver package\.$/, "driverStore.offlinePackageRegistryMissing"],
  [/^Close these database connections before updating drivers: (.+)$/, "driverStore.driverUpdateBlocked"],

  // Message queues (crates/dbx-core/src/mq/adapters/kafka.rs)
  [/^Kafka does not support unloading topics$/, "mqClients.unloadTopicUnsupportedKafka"],

  // Filesystem (src-tauri/src/commands/fs_open.rs)
  [/^file does not exist: (.+)$/, "common.fileNotFound"],

  // Web auth rate limiting (crates/dbx-web/src/auth.rs)
  [/^Please try again in (\d+)s$/, "auth.rateLimited"],
];

// Named placeholders for each pattern's capture groups, in capture order.
// A bare string is shorthand for a single capture group.
const paramNames: Record<string, string | string[]> = {
  "connection.driverNotInstalled": "driver",
  "connection.jreNotInstalled": "jre",
  "ai.configNameExists": "name",
  "settings.tunnelsHttpTestSuccess": "code",
  "settings.tunnelsProxyTimedOut": "duration",
  "settings.tunnelsProxyConnectFailed": "error",
  "settings.tunnelsProxyHandshakeFailed": "error",
  "settings.tunnelsProxyHandshakeTimedOut": "duration",
  "settings.tunnelsHttpConnectFailed": "detail",
  "settings.tunnelsSocksInvalidVersion": "version",
  "settings.tunnelsSocksUnsupportedAuth": "method",
  "settings.tunnelsSocksConnectRejected": "code",
  "settings.tunnelsSocksUnsupportedAddrType": "type",
  "driverStore.jreDirRemoveFailedWindows": ["path", "error"],
  "driverStore.jreDirRemoveFailed": ["path", "error"],
  "driverStore.jreInUseByDrivers": ["jre", "drivers"],
  "driverStore.driverUpdateBlocked": "labels",
  "common.fileNotFound": "path",
  "auth.rateLimited": "seconds",
};

function backendErrorMessage(error: unknown): string {
  if (typeof error === "string") return sanitizeBackendErrorMessage(error);
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return sanitizeBackendErrorMessage(error.message);
  return sanitizeBackendErrorMessage(String(error));
}

function translateStructuredBackendError(t: BackendErrorTranslate, error: BackendError): string {
  const translated = t(error.messageKey, error.messageParams);
  const summary = translated !== error.messageKey ? translated : t("backendErrors.unknown");
  const detail = error.detail ? sanitizeBackendErrorMessage(error.detail).trim() : undefined;
  const rawAdapterCode = error.diagnostics?.adapterCode;
  const adapterCode = typeof rawAdapterCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawAdapterCode) ? rawAdapterCode : undefined;
  const diagnosticDetail = detail && adapterCode ? `[${adapterCode}] ${detail}` : (detail ?? adapterCode);
  return diagnosticDetail && diagnosticDetail !== summary ? `${summary}\n\n${diagnosticDetail}` : summary;
}

export function translateBackendError(t: BackendErrorTranslate, error: unknown): string {
  const structured = normalizeBackendError(error);
  if (structured) return translateStructuredBackendError(t, structured);

  const message = backendErrorMessage(error);
  const exactKey = exactMessageKeys[message];
  if (exactKey) return t(exactKey);

  const tagged = message.match(/^\[([A-Za-z][A-Za-z0-9]+)\]\s*([\s\S]*)$/);
  if (tagged) {
    const [, code, rawDetail] = tagged;
    const key = taggedAiCliErrorKeys[code];
    if (key) {
      const detail = rawDetail.trim();
      return [t(key), t("ai.cliErrors.code", { code }), t("ai.cliErrors.reportHint"), detail ? `${t("ai.cliErrors.details")}\n${detail}` : ""].filter(Boolean).join("\n\n");
    }
  }

  for (const [regex, key] of patterns) {
    const match = message.match(regex);
    if (match) {
      const names = paramNames[key];
      if (names) {
        const ordered = Array.isArray(names) ? names : [names];
        const params: Record<string, string> = {};
        ordered.forEach((name, index) => {
          const captured = match[index + 1];
          if (captured !== undefined) params[name] = captured;
        });
        if (Object.keys(params).length > 0) return t(key, params);
      }
      return t(key);
    }
  }
  return message;
}
