import type { ComposerTranslation } from "vue-i18n";

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
};

const patterns: [RegExp, string][] = [
  [/^(.+?) driver is not installed\. Please install it from the Driver Manager\.$/, "connection.driverNotInstalled"],
  [/^JRE (.+?) runtime is not installed\. Please install it from the Driver Manager\.$/, "connection.jreNotInstalled"],
  [/^System Java runtime was not found on PATH\. Please install Java or choose a custom Java executable\.$/, "connection.systemJavaNotFound"],
  [/^Custom Java runtime path is empty\. Please choose a Java executable\.$/, "connection.customJavaPathEmpty"],
  [/^Agent requires Java 21, but DBX started it with an older Java runtime\. Use DBX managed JRE 21 or select a Java 21 executable in Driver Manager\./, "connection.agentJavaTooOld"],
  [/^JDBC plugin is not installed\. Install the optional JDBC plugin to use this connection\.$/, "connection.jdbcPluginNotInstalled"],
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
];

const paramNames: Record<string, string> = {
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
};

export function translateBackendError(t: ComposerTranslation, message: string): string {
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
      const name = paramNames[key];
      if (name && match[1]) {
        return t(key, { [name]: match[1] });
      }
      return t(key);
    }
  }
  return message;
}
