export type HiveKerberosAuthMode = "none" | "kerberos";

export interface HiveKerberosFormConfig {
  authMode: HiveKerberosAuthMode;
  principal: string;
  krb5ConfPath: string;
  jaasConfigPath: string;
  useSubjectCredsOnlyFalse: boolean;
  extraJavaOptions: string;
}

export interface HiveKerberosSubmitConfig extends HiveKerberosFormConfig {
  urlParams?: string;
}

const KRB5_CONF_PREFIX = "-Djava.security.krb5.conf=";
const JAAS_CONFIG_PREFIX = "-Djava.security.auth.login.config=";
const SUBJECT_CREDS_PREFIX = "-Djavax.security.auth.useSubjectCredsOnly=";

export function hiveKerberosFormConfig(urlParams?: string, agentJavaOptions?: string[]): HiveKerberosFormConfig {
  const params = parseHiveUrlParams(urlParams);
  const auth = getHiveUrlParam(params, "auth").toLowerCase();
  const principal = getHiveUrlParam(params, "principal");
  const java = parseHiveKerberosJavaOptions(agentJavaOptions || []);

  return {
    authMode: auth === "kerberos" || principal ? "kerberos" : "none",
    principal,
    ...java,
  };
}

export function applyHiveKerberosSubmitConfig(config: HiveKerberosSubmitConfig): {
  urlParams: string;
  agentJavaOptions: string[];
} {
  const enabled = config.authMode === "kerberos";
  return {
    urlParams: applyHiveKerberosUrlParams(config.urlParams, enabled, config.principal),
    agentJavaOptions: buildHiveKerberosJavaOptions(enabled, config),
  };
}

export function applyHiveKerberosUrlParams(urlParams: string | undefined, enabled: boolean, principal: string): string {
  const params = parseHiveUrlParams(urlParams).filter((param) => shouldKeepHiveUrlParam(param, enabled));
  if (enabled) {
    const normalizedPrincipal = principal.trim();
    if (normalizedPrincipal) {
      params.push({ key: "principal", value: normalizedPrincipal });
    }
  }
  return serializeHiveUrlParams(params);
}

export function buildHiveKerberosJavaOptions(enabled: boolean, config: HiveKerberosFormConfig): string[] {
  const options: string[] = [];
  if (enabled) {
    const krb5ConfPath = config.krb5ConfPath.trim();
    const jaasConfigPath = config.jaasConfigPath.trim();
    if (krb5ConfPath) options.push(`${KRB5_CONF_PREFIX}${krb5ConfPath}`);
    if (jaasConfigPath) options.push(`${JAAS_CONFIG_PREFIX}${jaasConfigPath}`);
    if (config.useSubjectCredsOnlyFalse) options.push(`${SUBJECT_CREDS_PREFIX}false`);
  }
  options.push(...splitExtraJavaOptions(config.extraJavaOptions));
  return options;
}

interface HiveUrlParam {
  key: string;
  value: string;
}

function parseHiveUrlParams(urlParams?: string): HiveUrlParam[] {
  return trimHiveUrlParams(urlParams)
    .split(/[;&]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals < 0) return { key: part, value: "" };
      return { key: part.slice(0, equals).trim(), value: part.slice(equals + 1).trim() };
    })
    .filter((param) => !!param.key);
}

function serializeHiveUrlParams(params: HiveUrlParam[]): string {
  return params.map((param) => (param.value ? `${param.key}=${param.value}` : param.key)).join(";");
}

function trimHiveUrlParams(urlParams?: string): string {
  return (urlParams || "")
    .trim()
    .replace(/^[?&;]+/, "")
    .replace(/[?&;]+$/, "");
}

function getHiveUrlParam(params: HiveUrlParam[], key: string): string {
  const lowerKey = key.toLowerCase();
  return params.find((param) => param.key.toLowerCase() === lowerKey)?.value || "";
}

function shouldKeepHiveUrlParam(param: HiveUrlParam, kerberosEnabled: boolean): boolean {
  const key = param.key.toLowerCase();
  if (key === "principal") return false;
  if (key !== "auth") return true;

  const auth = param.value.toLowerCase();
  if (kerberosEnabled) {
    // `auth=noSasl` and token auth conflict with Kerberos. Hive's JDBC driver selects
    // regular Kerberos from `principal`; `auth=kerberos` is only needed for explicit advanced cases.
    return auth === "kerberos";
  }
  return auth !== "kerberos";
}

function parseHiveKerberosJavaOptions(options: string[]): Omit<HiveKerberosFormConfig, "authMode" | "principal"> {
  let krb5ConfPath = "";
  let jaasConfigPath = "";
  let useSubjectCredsOnlyFalse = false;
  const extra: string[] = [];

  for (const option of options) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(KRB5_CONF_PREFIX)) {
      krb5ConfPath = trimmed.slice(KRB5_CONF_PREFIX.length);
    } else if (trimmed.startsWith(JAAS_CONFIG_PREFIX)) {
      jaasConfigPath = trimmed.slice(JAAS_CONFIG_PREFIX.length);
    } else if (trimmed.startsWith(SUBJECT_CREDS_PREFIX)) {
      useSubjectCredsOnlyFalse = trimmed.slice(SUBJECT_CREDS_PREFIX.length).toLowerCase() === "false";
    } else {
      extra.push(trimmed);
    }
  }

  return {
    krb5ConfPath,
    jaasConfigPath,
    useSubjectCredsOnlyFalse,
    extraJavaOptions: extra.join("\n"),
  };
}

function splitExtraJavaOptions(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
