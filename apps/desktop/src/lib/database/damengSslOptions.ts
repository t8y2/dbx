export interface DamengSslFormConfig {
  enabled: boolean;
  sslFilesPath: string;
  sslKeystorePassword: string;
  sslProtocol: string;
}

interface DamengUrlParam {
  key: string;
  value: string;
  raw: string;
}

const SSL_FILES_PATH_KEY = "sslfilespath";
const SSL_KEYSTORE_PASSWORD_KEY = "sslkeystorepass";
const SSL_PROTOCOL_KEY = "sslprotocol";

export function damengSslFormConfig(urlParams?: string): DamengSslFormConfig {
  const params = parseDamengUrlParams(urlParams);
  const sslFilesPath = getDamengUrlParam(params, SSL_FILES_PATH_KEY);
  const sslKeystorePassword = getDamengUrlParam(params, SSL_KEYSTORE_PASSWORD_KEY);
  const sslProtocol = getDamengUrlParam(params, SSL_PROTOCOL_KEY);

  return {
    enabled: params.some((param) => isManagedDamengSslParam(param.key)),
    sslFilesPath,
    sslKeystorePassword,
    sslProtocol,
  };
}

export function applyDamengSslUrlParams(urlParams: string | undefined, enabled: boolean, sslFilesPath: string, sslKeystorePassword: string, sslProtocol: string): string {
  const parts = parseDamengUrlParams(urlParams)
    .filter((param) => !isManagedDamengSslParam(param.key))
    .map((param) => param.raw);

  if (enabled) {
    const normalizedFilesPath = sslFilesPath.trim();
    const normalizedProtocol = sslProtocol.trim();
    if (normalizedFilesPath) parts.push(`sslFilesPath=${normalizedFilesPath}`);
    if (sslKeystorePassword) parts.push(`sslkeystorePass=${sslKeystorePassword}`);
    if (normalizedProtocol) parts.push(`sslProtocol=${normalizedProtocol}`);
  }

  return parts.join("&");
}

function parseDamengUrlParams(urlParams?: string): DamengUrlParam[] {
  return (urlParams || "")
    .trim()
    .replace(/^[?&;]+/, "")
    .replace(/[?&;]+$/, "")
    .split(/[&;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((raw) => {
      const equals = raw.indexOf("=");
      if (equals < 0) return { key: raw, value: "", raw };
      return {
        key: raw.slice(0, equals).trim(),
        value: raw.slice(equals + 1).trim(),
        raw,
      };
    })
    .filter((param) => !!param.key);
}

function getDamengUrlParam(params: DamengUrlParam[], key: string): string {
  return params.find((param) => param.key.toLowerCase() === key)?.value || "";
}

function isManagedDamengSslParam(key: string): boolean {
  const normalizedKey = key.trim().toLowerCase();
  return normalizedKey === SSL_FILES_PATH_KEY || normalizedKey === SSL_KEYSTORE_PASSWORD_KEY || normalizedKey === SSL_PROTOCOL_KEY;
}
