import type { DatabaseUserAdminProvider, PrivilegeChangeInput, PrivilegeScope } from "./databaseUserAdmin";
import type { OracleSecuritySnapshot } from "./oracleSecurity";
import type { AuthorizationPlan, AuthorizationPreset, DatabaseAuthorizationSelection } from "./databaseAuthorizationPlan";

type PrincipalKind = "user" | "role" | "public";
type Actions = Pick<DatabaseUserAdminProvider, "alterPasswordSql" | "supportsOldPassword" | "alterLoginSql" | "grantPrivilegesSql" | "revokePrivilegesSql">;
const SYSTEM_PRIVILEGES = ["CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER", "CREATE SYNONYM"];
const OBJECT_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "ALTER", "INDEX", "EXECUTE"];
export const ORACLE_OBJECT_PRIVILEGES: Record<string, readonly string[]> = {
  TABLE: ["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "ALTER", "INDEX"],
  VIEW: ["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES"],
  "MATERIALIZED VIEW": ["SELECT"],
  SEQUENCE: ["SELECT", "ALTER"],
  PROCEDURE: ["EXECUTE"],
  FUNCTION: ["EXECUTE"],
  PACKAGE: ["EXECUTE"],
  TYPE: ["EXECUTE"],
};

export function oracleGrantObjectsSql(owner: string): string {
  const types = Object.keys(ORACLE_OBJECT_PRIVILEGES)
    .map((type) => `'${type}'`)
    .join(", ");
  return `SELECT DISTINCT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = '${owner.replaceAll("'", "''")}' AND OBJECT_TYPE IN (${types}) ORDER BY OBJECT_NAME, OBJECT_TYPE`;
}

export function oraclePresetPrivileges(preset: AuthorizationPreset, custom: string[] = []): string[] {
  return preset === "custom" ? [...new Set(custom)] : preset === "readOnly" ? ["SELECT"] : preset === "ddl" ? ["ALTER", "INDEX"] : ["SELECT", "INSERT", "UPDATE", "DELETE"];
}

export function buildOracleObjectAuthorizationPlan(actions: Actions, name: string, selections: DatabaseAuthorizationSelection[], grantOption: boolean, revoke = false): AuthorizationPlan {
  const buildSql = revoke ? actions.revokePrivilegesSql : actions.grantPrivilegesSql;
  if (!buildSql || !selections.length) throw new Error("Select an object and its privileges");
  const plan: AuthorizationPlan = { steps: [] };
  for (const selection of selections) {
    if (!selection.tables?.length) throw new Error("Select specific objects");
    const privileges = oraclePresetPrivileges(selection.preset, selection.privileges);
    for (const table of selection.tables) {
      const allowed = ORACLE_OBJECT_PRIVILEGES[table.objectType ?? ""] ?? [];
      if (!privileges.length || privileges.some((privilege) => !allowed.includes(privilege))) throw new Error(`Unsupported privileges for ${selection.database}.${table.name} (${table.objectType ?? "unknown"})`);
      const index = plan.steps.length;
      plan.steps.push({
        id: `oracle-object-${index}`,
        label: `${selection.database}.${table.name}`,
        database: "",
        sql: buildSql({ user: { user: name, host: "" }, database: identifier(selection.database, true), table: identifier(table.name, true), scope: "table", privileges, grantOption }),
        operation: revoke ? "revokePrivileges" : "grantCurrentObjects",
        subject: name,
        targetSchema: selection.database,
        targetTable: table.name,
        dependsOn: index ? [`oracle-object-${index - 1}`] : [],
      });
    }
  }
  return plan;
}

/** Visible direct grants only. This is a display, not a replay or revoke plan. */
export function oracleDirectGrantsSql(snapshot: OracleSecuritySnapshot, principal: string): string[] {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const target = (name: string) => (name === "PUBLIC" ? "PUBLIC" : quote(name));
  const direct = (row: { grantee: string }) => !!principal && row.grantee === principal;
  return [
    ...snapshot.roleGrants.rows.filter(direct).map((row) => `GRANT ${quote(row.role)} TO ${target(row.grantee)}${row.adminOption ? " WITH ADMIN OPTION" : ""};`),
    ...snapshot.systemGrants.rows.filter(direct).map((row) => `GRANT ${row.privilege} TO ${target(row.grantee)}${row.adminOption ? " WITH ADMIN OPTION" : ""};`),
    ...[...snapshot.objectGrants.rows, ...snapshot.columnGrants.rows]
      .filter(direct)
      .map((row) => `GRANT ${row.privilege}${"columnName" in row ? ` (${quote(String(row.columnName))})` : ""} ON ${quote(row.owner)}.${quote(row.objectName)} TO ${target(row.grantee)}${row.grantable ? " WITH GRANT OPTION" : ""};`),
  ];
}

function identifier(value: string, fromMetadata = false): string {
  const input = fromMetadata ? value : value.trim();
  const name = fromMetadata ? input : /^"[^"\0\r\n]+"$/.test(input) ? input.slice(1, -1) : /^[A-Za-z][A-Za-z0-9_$#]*$/.test(input) ? input.toUpperCase() : "";
  if (!name || /["\0\r\n]/.test(name) || name === "*") throw new Error("Invalid Oracle identifier; use an exact name, with double quotes for case-sensitive names");
  return `"${name}"`;
}

function passwordToken(value: string): string {
  if (!value || /["\0\r\n]/.test(value)) throw new Error("A password without double quotes, NUL or line breaks is required");
  return `"${value}"`;
}

export function oraclePasswordSql(user: string, password: string, oldPassword?: string): string {
  return `ALTER USER ${identifier(user, true)} IDENTIFIED BY ${passwordToken(password)}${oldPassword ? ` REPLACE ${passwordToken(oldPassword)}` : ""};`;
}

export function oraclePrivilegesForScope(scope: PrivilegeScope): readonly string[] {
  return scope === "system" ? SYSTEM_PRIVILEGES : scope === "table" ? OBJECT_PRIVILEGES : [];
}

export function oraclePrivilegeSql(kind: PrincipalKind, input: PrivilegeChangeInput, revoke = false): string {
  const scope = input.scope ?? "table";
  const principal = kind === "public" ? "PUBLIC" : identifier(input.user.user, true);
  if (!revoke && input.grantOption && (kind === "public" || (kind === "role" && scope === "table"))) throw new Error("This principal cannot receive the selected grant option");
  let privileges: string;
  if (scope === "role") {
    privileges = identifier(input.role ?? "");
    if (privileges === principal) throw new Error("A role cannot be granted to itself");
  } else {
    const allowed = oraclePrivilegesForScope(scope);
    if (!input.privileges.length || input.privileges.some((privilege) => !allowed.includes(privilege))) throw new Error("Select supported Oracle privileges");
    privileges = [...new Set(input.privileges)].join(", ");
  }
  const object = scope === "table" ? ` ON ${identifier(input.database)}.${identifier(input.table ?? "")}` : "";
  const option = !revoke && input.grantOption ? (scope === "table" ? " WITH GRANT OPTION" : " WITH ADMIN OPTION") : "";
  return `${revoke ? "REVOKE" : "GRANT"} ${privileges}${object} ${revoke ? "FROM" : "TO"} ${principal}${option};`;
}

export function createOracleUserAdminActions(snapshot: OracleSecuritySnapshot | undefined, name: string | undefined, supportsOldPassword: boolean): Actions | undefined {
  if (!snapshot || !name) return;
  const kind: PrincipalKind | undefined = name === "PUBLIC" ? "public" : snapshot.users.rows.some((user) => user.name === name) || snapshot.currentUser.rows.includes(name) ? "user" : snapshot.roles.rows.some((role) => role.name === name) ? "role" : undefined;
  if (!kind) return;
  return {
    supportsOldPassword,
    ...(kind === "user"
      ? {
          alterLoginSql: (_user, enabled) => `ALTER USER ${identifier(name, true)} ACCOUNT ${enabled ? "UNLOCK" : "LOCK"};`,
          ...(snapshot.currentUser.rows.length ? { alterPasswordSql: (_user, password, oldPassword) => oraclePasswordSql(name, password, supportsOldPassword ? oldPassword : undefined) } : {}),
        }
      : {}),
    grantPrivilegesSql: (input) => oraclePrivilegeSql(kind, { ...input, user: { user: name, host: "" } }),
    revokePrivilegesSql: (input) => oraclePrivilegeSql(kind, { ...input, user: { user: name, host: "" } }, true),
  };
}
