/** Property grammars used by Microsoft JDBC 8.4+ and Teradata JDBC. */
export type JdbcPropertyStyle = "sqlserver" | "teradata";

export interface JdbcProperty {
  key: string;
  value: string;
  raw: string;
  quoted: boolean;
  hasEquals: boolean;
  start: number;
  end: number;
}

interface JdbcPropertyParseOptions {
  separators?: string;
  allowBare?: boolean;
}

const SECRET_CONNECTION_PROPERTY = /^(?:password|pwd|pass|passcode|passphrase|token|secret|key|apikey|api_key|accessToken|access_token|logdata|new_password|ssltruststore_password|sslpassword|oauth_client_secret|client_secret|clientKeyPassword|keyStoreSecret|trustStorePassword)$/i;

export function isSecretConnectionProperty(key: string): boolean {
  const rawKey = key.trim();
  try {
    // URL import decodes property names before interpreting credentials.
    return SECRET_CONNECTION_PROPERTY.test(decodeURIComponent(rawKey).trim());
  } catch {
    return SECRET_CONNECTION_PROPERTY.test(rawKey);
  }
}

export function quoteJdbcProperty(value: string, style: JdbcPropertyStyle): string {
  // DBX imports legacy unquoted SQL Server %xx values as URI escapes.
  // Brace literal percentages in generated URLs so they survive that import path.
  if (/^[\w.~%-]+$/.test(value) && (style !== "sqlserver" || !value.includes("%"))) return value;
  return style === "sqlserver" ? `{${value.replace(/}/g, "}}")}}` : `'${value.replace(/'/g, "''")}'`;
}

/** Preserve the JDBC grammar; callers decide whether to decode legacy unquoted values. */
export function parseJdbcProperties(source: string, style: JdbcPropertyStyle, options: JdbcPropertyParseOptions = {}): JdbcProperty[] | null {
  const { separators = style === "sqlserver" ? ";" : ",", allowBare = false } = options;
  const opening = style === "sqlserver" ? "{" : "'";
  const closing = style === "sqlserver" ? "}" : "'";
  const properties: JdbcProperty[] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && (separators.includes(source[index]) || /\s/.test(source[index]))) index++;
    if (index === source.length) break;
    const start = index;
    while (index < source.length && source[index] !== "=" && !separators.includes(source[index])) index++;
    const key = source.slice(start, index).trim();
    if (!key) return null;
    if (source[index] !== "=") {
      if (!allowBare) return null;
      properties.push({ key, value: "", raw: source.slice(start, index), quoted: false, hasEquals: false, start, end: index });
      if (index < source.length) index++;
      continue;
    }
    index++;
    while (index < source.length && /\s/.test(source[index])) index++;
    let value = "";
    const quoted = source[index] === opening;
    if (quoted) {
      index++;
      let closed = false;
      while (index < source.length) {
        const character = source[index++];
        if (character !== closing) {
          value += character;
        } else if (source[index] === closing) {
          value += closing;
          index++;
        } else {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      while (index < source.length && /\s/.test(source[index])) index++;
      if (index < source.length && !separators.includes(source[index])) return null;
    } else {
      const valueStart = index;
      while (index < source.length && !separators.includes(source[index])) index++;
      value = source.slice(valueStart, index).trim();
      if (style === "sqlserver" && value.includes("{")) return null;
    }
    properties.push({ key, value, raw: source.slice(start, index), quoted, hasEquals: true, start, end: index });
    if (index < source.length) index++;
  }
  return properties;
}

function redactParsedProperties(source: string, properties: JdbcProperty[]): string {
  if (!properties.some(({ key, hasEquals }) => hasEquals && isSecretConnectionProperty(key))) return source;
  // Preserve original separators: JDBC properties use ';' or ',', while mssql:// queries use '&'.
  let redacted = "";
  let cursor = 0;
  for (const { key, hasEquals, start, end } of properties) {
    redacted += source.slice(cursor, start) + (hasEquals && isSecretConnectionProperty(key) ? `${key}=***` : source.slice(start, end));
    cursor = end;
  }
  return redacted + source.slice(cursor);
}

export function redactJdbcProperties(source: string, style: JdbcPropertyStyle): string {
  const properties = parseJdbcProperties(source, style);
  // An invalid quoted value has no trustworthy boundary. Never copy its tail.
  return properties ? redactParsedProperties(source, properties) : "***";
}

/** mssql:// query strings can contain bare flags; JDBC property lists cannot. */
export function redactSqlServerQuery(source: string): string {
  const properties = parseJdbcProperties(source, "sqlserver", { separators: ";&", allowBare: true });
  if (properties) return redactParsedProperties(source, properties);
  // Keep malformed but non-sensitive standard queries copyable. If a secret-looking
  // assignment occurs beyond an unclosed brace, its boundary is unsafe to trust.
  for (const [, key] of source.matchAll(/(?:^|[;&])([^=?&;]+)=/g)) {
    if (isSecretConnectionProperty(key)) return "***";
  }
  return source;
}

/** DBX also accepts &/; separated form parameters; never split inside quoted values. */
export function normalizeJdbcProperties(source: string, style: JdbcPropertyStyle): JdbcProperty[] | null {
  return parseJdbcProperties(source.trim().replace(/^[?&;,]+/, ""), style, { separators: style === "sqlserver" ? ";&" : ",;&" });
}
