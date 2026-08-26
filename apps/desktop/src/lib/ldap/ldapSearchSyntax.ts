/**
 * Helpers for turning DBX's LDAP search parameters into portable command
 * snippets the user can paste into a terminal, a PowerShell prompt, or a
 * log. We currently emit two flavours:
 *
 * - `ldapsearch` (OpenLDAP / `ldap-utils`) — the de-facto CLI for ad-hoc
 *   LDAP lookups.
 * - `Get-ADObject` (PowerShell Active Directory module) — the canonical
 *   CLI for AD administrators on Windows.
 *
 * The helpers are deliberately pure: no DOM, no clipboard, no toast.
 * Callers wrap them with whatever notification they prefer.
 */

export type LdapScopeToken = "base" | "one" | "sub";

export interface LdapSearchParams {
  /** Search base DN. Empty string means root DSE. */
  baseDn: string;
  /** LDAP scope — `base` (single object), `one` (immediate children), `sub` (subtree). */
  scope: LdapScopeToken;
  /** RFC 4515 LDAP filter, e.g. `(sAMAccountName=alice)`. */
  filter: string;
  /** Optional list of attribute names to request. `null`/empty means "all". */
  attributes?: string[] | null;
  /** Optional client-side maximum. Ignored by `ldapsearch` itself (server-side `sizelimit`). */
  sizeLimit?: number | null;
  /** LDAP server hostname (for `ldapsearch -H`). Empty / undefined means "use the default URI". */
  host?: string;
  /** LDAP port (for `ldapsearch -H`). Defaults to 389 / 636 (ldaps). */
  port?: number;
  /** Use TLS (`ldaps://`) instead of `ldap://`. Defaults to false. */
  useTls?: boolean;
}

export interface GetAdObjectParams {
  /** Search base DN. */
  baseDn: string;
  /** LDAP scope — `base` maps to `Base`, `one` → `OneLevel`, `sub` → `Subtree`. */
  scope: LdapScopeToken;
  /** RFC 4515 LDAP filter. */
  filter: string;
  /** Optional list of attribute names to request. */
  attributes?: string[] | null;
  /** DC hostname (e.g. `dc01.corp.example.com`). Empty means the AD module default. */
  server?: string;
  /** Optional client-side maximum. Maps to `-ResultSetSize`. */
  sizeLimit?: number | null;
}

const EMPTY_FILTER_DEFAULT = "(objectClass=*)";

function normalizeFilter(filter: string): string {
  const trimmed = filter.trim();
  return trimmed.length === 0 ? EMPTY_FILTER_DEFAULT : trimmed;
}

function normalizeAttributes(attributes?: string[] | null): string[] | null {
  if (!attributes || attributes.length === 0) return null;
  const trimmed = attributes.map((attr) => attr.trim()).filter((attr) => attr.length > 0);
  return trimmed.length === 0 ? null : trimmed;
}

function escapeShellSingleQuote(value: string): string {
  // POSIX shell single-quote escaping: 'foo'bar' -> 'foo'\'bar'
  return value.replace(/'/g, "'\\''");
}

function escapePowerShellSingleQuote(value: string): string {
  // PowerShell single-quote escaping: ' -> ''
  return value.replace(/'/g, "''");
}

function scopeToLdapsearchFlag(scope: LdapScopeToken): string {
  switch (scope) {
    case "base":
      // `ldapsearch` uses `-b` for both the search base and the base-object
      // lookup. We always emit `-b <baseDn>` separately above; for scope=base
      // the search is restricted to the object itself without an extra flag.
      return "";
    case "one":
      return "-s one";
    case "sub":
      return "-s sub";
  }
}

function scopeToGetAdObjectFlag(scope: LdapScopeToken): string {
  switch (scope) {
    case "base":
      return "Base";
    case "one":
      return "OneLevel";
    case "sub":
      return "Subtree";
  }
}

function hostPort(params: LdapSearchParams): { uri: string | null; tlsUsed: boolean } {
  const host = params.host?.trim() ?? "";
  if (host.length === 0) return { uri: null, tlsUsed: !!params.useTls };
  const useTls = !!params.useTls;
  const scheme = useTls ? "ldaps" : "ldap";
  const defaultPort = useTls ? 636 : 389;
  const port = params.port && params.port > 0 ? params.port : defaultPort;
  return { uri: `${scheme}://${host}:${port}`, tlsUsed: useTls };
}

/**
 * Build an `ldapsearch` command line that mirrors the DBX UI inputs.
 *
 * Example:
 *
 *     ldapsearch -x -H ldap://ldap.example.com:389 \
 *         -b 'OU=CLIENTS,DC=CORP,DC=INT,DC=KN' \
 *         -s sub '(&(objectClass=user)(sAMAccountName=alice))' cn mail
 */
export function buildLdapSearchCommand(params: LdapSearchParams): string {
  const parts: string[] = ["ldapsearch", "-x", "-LLL"];
  const { uri, tlsUsed } = hostPort(params);
  if (uri !== null) {
    parts.push("-H", `'${escapeShellSingleQuote(uri)}'`);
  } else if (tlsUsed) {
    // Caller asked for TLS but did not supply a host; emit `-ZZ` to
    // negotiate StartTLS when no URI is provided (ldapsearch default
    // behaviour). This is rare but avoids silently dropping the flag.
    parts.push("-ZZ");
  }
  const baseDn = params.baseDn.trim();
  parts.push("-b", `'${escapeShellSingleQuote(baseDn.length === 0 ? "" : baseDn)}'`);
  const scopeFlag = scopeToLdapsearchFlag(params.scope);
  if (scopeFlag.length > 0) {
    parts.push(scopeFlag);
  }
  const filter = normalizeFilter(params.filter);
  parts.push(`'${escapeShellSingleQuote(filter)}'`);
  const attrs = normalizeAttributes(params.attributes ?? null);
  if (attrs !== null) {
    for (const attr of attrs) {
      parts.push(escapeShellSingleQuote(attr));
    }
  }
  return parts.join(" ");
}

/**
 * Build a PowerShell `Get-ADObject` command line.
 *
 * Example:
 *
 *     Get-ADObject -Server 'dc01.corp.example.com' \
 *         -SearchBase 'OU=CLIENTS,DC=CORP,DC=INT,DC=KN' \
 *         -SearchScope Subtree \
 *         -LDAPFilter '(&(objectClass=user)(sAMAccountName=alice))' \
 *         -Properties cn,mail
 */
export function buildGetAdObjectCommand(params: GetAdObjectParams): string {
  const parts: string[] = ["Get-ADObject"];
  const server = params.server?.trim() ?? "";
  if (server.length > 0) {
    parts.push("-Server", `'${escapePowerShellSingleQuote(server)}'`);
  }
  const baseDn = params.baseDn.trim();
  parts.push("-SearchBase", `'${escapePowerShellSingleQuote(baseDn.length === 0 ? "" : baseDn)}'`);
  parts.push("-SearchScope", scopeToGetAdObjectFlag(params.scope));
  parts.push("-LDAPFilter", `'${escapePowerShellSingleQuote(normalizeFilter(params.filter))}'`);
  const attrs = normalizeAttributes(params.attributes ?? null);
  if (attrs !== null) {
    parts.push("-Properties");
    parts.push(attrs.map((attr) => escapePowerShellSingleQuote(attr)).join(","));
  }
  const limit = params.sizeLimit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    parts.push("-ResultSetSize", String(Math.trunc(limit)));
  }
  return parts.join(" ");
}

/**
 * Build a single-object `Get-ADObject -Identity <dn>` command. Used by the
 * detail panel's "copy this entry" action.
 */
export function buildGetAdObjectIdentityCommand(dn: string, server?: string): string {
  const parts: string[] = ["Get-ADObject"];
  if (server && server.trim().length > 0) {
    parts.push("-Server", `'${escapePowerShellSingleQuote(server.trim())}'`);
  }
  parts.push("-Identity", `'${escapePowerShellSingleQuote(dn.trim())}'`);
  parts.push("-Properties", "*");
  return parts.join(" ");
}

/**
 * Build a one-liner `ldapsearch -b '<dn>' '(objectClass=*)' *` for fetching
 * a single entry directly.
 */
export function buildLdapSearchByDnCommand(dn: string, host?: string, port?: number, useTls?: boolean): string {
  return buildLdapSearchCommand({
    baseDn: dn,
    scope: "base",
    filter: "(objectClass=*)",
    attributes: ["*"],
    host,
    port,
    useTls,
  });
}

/** Convert a scope token to the canonical short name used in DBX URLs. */
export function scopeLabel(scope: LdapScopeToken): "base" | "one" | "sub" {
  return scope;
}

/** Parse the DBX UI scope string back into a typed token. */
export function parseScope(raw: string): LdapScopeToken {
  switch (raw.trim().toLowerCase()) {
    case "base":
    case "object":
    case "0":
      return "base";
    case "one":
    case "onelevel":
    case "1":
      return "one";
    default:
      return "sub";
  }
}
