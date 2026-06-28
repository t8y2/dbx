import type { ComposerTranslation } from "vue-i18n";

const patterns: [RegExp, string][] = [
  [/^(.+?) driver is not installed\. Please install it from the Driver Manager\.$/, "connection.driverNotInstalled"],
  [/^JRE (.+?) runtime is not installed\. Please install it from the Driver Manager\.$/, "connection.jreNotInstalled"],
  [/^System Java runtime was not found on PATH\. Please install Java or choose a custom Java executable\.$/, "connection.systemJavaNotFound"],
  [/^Custom Java runtime path is empty\. Please choose a Java executable\.$/, "connection.customJavaPathEmpty"],
  [/^Agent requires Java 21, but DBX started it with an older Java runtime\. Use DBX managed JRE 21 or select a Java 21 executable in Driver Manager\./, "connection.agentJavaTooOld"],
  [/^JDBC plugin is not installed\. Install the optional JDBC plugin to use this connection\.$/, "connection.jdbcPluginNotInstalled"],
];

const paramNames: Record<string, string> = {
  "connection.driverNotInstalled": "driver",
  "connection.jreNotInstalled": "jre",
};

export function translateBackendError(t: ComposerTranslation, message: string): string {
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
