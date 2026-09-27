import type { QueryResult } from "@/types/database";
import { mysqlUserAccount, normalizeStarrocksCatalog, POSTGRES_TABLE_PRIVILEGES, quoteMySqlIdentifier, quotePostgresIdentifier, type CreatePrincipalInput, type DatabaseTablePrivilegeGrant, type DatabaseUserAdminProvider, type DatabaseUserIdentity } from "@/lib/database/databaseUserAdmin";

export type AuthorizationAccountType = "standard" | "admin";
export type AuthorizationPreset = "readWrite" | "readOnly" | "ddl" | "dml" | "custom";
export type AuthorizationTargetScope = "database" | "table";
export type AuthorizationStepOperation = "createUser" | "grantAdmin" | "createDatabase" | "grantDatabase" | "revokePrivileges" | "grantCurrentObjects" | "grantFutureObjects";
export type AuthorizationObjectScope = "schemas" | "tables" | "sequences" | "functions";

export interface DatabaseAuthorizationSelection {
  catalog?: string;
  database: string;
  preset: AuthorizationPreset;
  privileges?: string[];
  schemas?: string[];
  tables?: AuthorizationTableSelection[];
}

export interface AuthorizationTableSelection {
  name: string;
  schema?: string;
}

export interface AuthorizationDatabaseOption {
  catalog?: string;
  database: string;
}

export interface LoadedDatabaseAuthorizations {
  selections: DatabaseAuthorizationSelection[];
  grantOption: boolean;
}

export interface AuthorizationPlanStep {
  id: string;
  label: string;
  database: string;
  sql: string;
  dependsOn?: string[];
  operation: AuthorizationStepOperation;
  subject?: string;
  targetCatalog?: string;
  targetDatabase?: string;
  targetSchema?: string;
  targetTable?: string;
  objectScope?: AuthorizationObjectScope;
  schema?: string;
  owner?: string;
}

export interface AuthorizationPlan {
  steps: AuthorizationPlanStep[];
}

export type AuthorizationStepStatus = "success" | "failed" | "skipped";

export interface AuthorizationStepResult {
  step: AuthorizationPlanStep;
  status: AuthorizationStepStatus;
  message?: string;
}

export interface CreateUserAuthorizationPlanInput {
  provider: DatabaseUserAdminProvider;
  principal: CreatePrincipalInput;
  accountType: AuthorizationAccountType;
  databases: DatabaseAuthorizationSelection[];
}

export interface CreateDatabaseAuthorizationPlanInput {
  provider: DatabaseUserAdminProvider;
  database: string;
  createSql: string;
  users: DatabaseUserIdentity[];
}

const MYSQL_PRESETS: Record<Exclude<AuthorizationPreset, "custom">, string[]> = {
  readOnly: ["SELECT", "SHOW VIEW"],
  dml: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ddl: ["CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "SHOW VIEW", "CREATE VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "TRIGGER", "EVENT", "CREATE TEMPORARY TABLES"],
  readWrite: ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "EXECUTE", "SHOW VIEW", "CREATE VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "TRIGGER", "EVENT", "CREATE TEMPORARY TABLES", "LOCK TABLES"],
};

const MYSQL_TABLE_PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "SHOW VIEW", "CREATE VIEW", "TRIGGER"]);
const POSTGRES_TABLE_PRIVILEGE_SET = new Set<string>(POSTGRES_TABLE_PRIVILEGES);

const POSTGRES_PRESETS: Record<Exclude<AuthorizationPreset, "custom">, string[]> = {
  readOnly: ["SELECT"],
  dml: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ddl: ["CREATE"],
  readWrite: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "EXECUTE", "CREATE", "TEMPORARY"],
};

const STARROCKS_PRESETS: Record<Exclude<AuthorizationPreset, "custom">, string[]> = {
  readOnly: ["SELECT"],
  dml: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ddl: ["ALTER", "DROP"],
  readWrite: ["SELECT", "INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "EXPORT"],
};

export function authorizationPresetPrivileges(provider: DatabaseUserAdminProvider, preset: AuthorizationPreset, custom: string[] = [], targetScope: AuthorizationTargetScope = "database"): string[] {
  const presetPrivileges = provider.authorizationModel === "starrocks" ? STARROCKS_PRESETS : provider.dialect === "mysql" ? MYSQL_PRESETS : POSTGRES_PRESETS;
  const privileges = preset === "custom" ? uniquePrivileges(custom) : [...presetPrivileges[preset]];
  if (provider.authorizationModel === "starrocks" && privileges.includes("ALL")) return ["ALL"];
  if (targetScope !== "table") return privileges;
  if (provider.authorizationModel === "mysql") return privileges.filter((privilege) => MYSQL_TABLE_PRIVILEGES.has(privilege));
  const tablePrivileges = new Set(provider.privilegesForScope?.("table") ?? []);
  return privileges.filter((privilege) => tablePrivileges.has(privilege));
}

export function authorizationPrivileges(provider: DatabaseUserAdminProvider, targetScope: AuthorizationTargetScope = "database"): string[] {
  const privilegesForScope = provider.privilegesForScope;
  if (!privilegesForScope) return [];
  if (provider.authorizationModel === "starrocks") return Array.from(privilegesForScope("table"));
  if (provider.dialect === "mysql") {
    const privileges = Array.from(privilegesForScope("mysql"));
    return provider.authorizationModel === "mysql" && targetScope === "table" ? privileges.filter((privilege) => MYSQL_TABLE_PRIVILEGES.has(privilege)) : privileges;
  }
  if (targetScope === "table") return Array.from(privilegesForScope("table"));
  return uniquePrivileges([...privilegesForScope("database"), ...privilegesForScope("schema"), ...privilegesForScope("table"), "EXECUTE", "USAGE", "UPDATE"]);
}

export function databaseAuthorizationsFromTableGrants(provider: DatabaseUserAdminProvider, grants: readonly DatabaseTablePrivilegeGrant[]): LoadedDatabaseAuthorizations {
  const available = authorizationPrivileges(provider, "table");
  const allowed = new Set(available);
  const byDatabase = new Map<string, DatabaseTablePrivilegeGrant[]>();
  for (const grant of grants) {
    if (!grant.database.trim() || grant.database === "*" || !grant.table.trim() || !allowed.has(grant.privilege)) continue;
    const key = JSON.stringify([normalizeStarrocksCatalog(grant.catalog ?? "") ?? "", grant.database]);
    const entries = byDatabase.get(key) ?? [];
    entries.push(grant);
    byDatabase.set(key, entries);
  }

  const selections: DatabaseAuthorizationSelection[] = [];
  let everyGrantable = true;
  for (const entries of byDatabase.values()) {
    const wildcardEntries = entries.filter((grant) => grant.table === "*");
    const selectedEntries = wildcardEntries.length > 0 ? wildcardEntries : entries;
    const byTable = new Map<string, DatabaseTablePrivilegeGrant[]>();
    for (const entry of selectedEntries) {
      const key = JSON.stringify([entry.schema ?? "", entry.table]);
      const tableGrants = byTable.get(key) ?? [];
      tableGrants.push(entry);
      byTable.set(key, tableGrants);
    }
    const tableGrants = Array.from(byTable.values());
    if (tableGrants.length === 0) continue;
    const allOnEveryTarget = tableGrants.every((targetGrants) => targetGrants.some((grant) => grant.privilege === "ALL"));
    const commonPrivileges = allOnEveryTarget ? ["ALL"] : available.filter((privilege) => privilege !== "ALL" && tableGrants.every((targetGrants) => targetGrants.some((grant) => grant.privilege === privilege || grant.privilege === "ALL")));
    if (commonPrivileges.length === 0) continue;
    everyGrantable &&= tableGrants.every((targetGrants) => commonPrivileges.every((privilege) => targetGrants.some((grant) => (grant.privilege === privilege || grant.privilege === "ALL") && grant.grantOption)));
    const first = selectedEntries[0];
    const schemas = Array.from(new Set(wildcardEntries.flatMap((grant) => (grant.schema ? [grant.schema] : []))));
    selections.push({
      ...(first.catalog ? { catalog: normalizeStarrocksCatalog(first.catalog) } : {}),
      database: first.database,
      preset: "custom",
      privileges: commonPrivileges,
      ...(wildcardEntries.length > 0 ? { schemas } : { tables: Array.from(byTable.values(), ([grant]) => ({ name: grant.table, ...(grant.schema ? { schema: grant.schema } : {}) })) }),
    });
  }
  return { selections, grantOption: selections.length > 0 && everyGrantable };
}

export function buildCreateUserAuthorizationPlan(input: CreateUserAuthorizationPlanInput): AuthorizationPlan {
  const createStepId = "create-user";
  // Connection-specific providers expose only the admin operations supported by that server.
  if (!input.provider.createUserSql) return { steps: [] };
  const steps: AuthorizationPlanStep[] = [
    {
      id: createStepId,
      label: "create user",
      database: "",
      sql: input.provider.createUserSql(input.principal),
      operation: "createUser",
      subject: input.provider.label(input.principal),
    },
  ];

  if (input.accountType === "admin") {
    if (input.provider.dialect === "mysql" && !input.provider.grantPrivilegesSql) return { steps };
    steps.push({
      id: "grant-admin",
      label: `grant admin privileges to ${input.provider.label(input.principal)}`,
      database: "",
      sql: adminPrincipalGrantSql(input.provider, input.principal),
      dependsOn: [createStepId],
      operation: "grantAdmin",
      subject: input.provider.label(input.principal),
    });
    return { steps };
  }

  const identity: DatabaseUserIdentity = {
    user: input.principal.user,
    host: input.principal.host,
  };
  if (!input.provider.grantPrivilegesSql) return { steps };
  for (const selection of input.databases) {
    const database = selection.database.trim();
    if (!database) continue;
    if (selection.tables !== undefined && uniqueTables(selection.tables).length === 0) continue;
    if (input.provider.authorizationModel === "starrocks") {
      const privileges = authorizationPresetPrivileges(input.provider, selection.preset, selection.privileges, "table");
      if (privileges.length === 0) continue;
      const tables = selection.tables === undefined ? [{ name: "*" }] : uniqueTables(selection.tables);
      for (const table of tables) {
        const targetTable = table.name === "*" ? undefined : table.name;
        steps.push({
          id: `grant-${steps.length}`,
          label: `grant ${input.provider.label(identity)} access to ${authorizationTargetLabel(selection.catalog, database, undefined, targetTable)}`,
          database,
          sql: input.provider.grantPrivilegesSql({ user: identity, privileges, catalog: selection.catalog, database, table: table.name, scope: "table" }),
          dependsOn: [createStepId],
          operation: "grantDatabase",
          subject: input.provider.label(identity),
          targetCatalog: selection.catalog,
          targetDatabase: database,
          targetTable,
        });
      }
      continue;
    }
    if (input.provider.dialect === "mysql") {
      const targetScope = input.provider.supportsTableGrantsOnCreate && selection.tables !== undefined ? "table" : "database";
      const privileges = authorizationPresetPrivileges(input.provider, selection.preset, selection.privileges, targetScope);
      const tables = targetScope === "database" ? [{ name: "*" }] : uniqueTables(selection.tables ?? []);
      for (const table of tables) {
        const targetTable = table.name === "*" ? undefined : table.name;
        steps.push({
          id: `grant-${steps.length}`,
          label: `grant ${input.provider.label(identity)} access to ${authorizationTargetLabel(undefined, database, undefined, targetTable)}`,
          database: "",
          sql: input.provider.grantPrivilegesSql({ user: identity, privileges, database, table: table.name, scope: "mysql" }),
          dependsOn: [createStepId],
          operation: "grantDatabase",
          subject: input.provider.label(identity),
          targetDatabase: database,
          targetTable,
        });
      }
      continue;
    }
    const targetScope = input.provider.authorizationModel === "postgres" && selection.tables !== undefined ? "table" : "database";
    const privileges = authorizationPresetPrivileges(input.provider, selection.preset, selection.privileges, targetScope);
    steps.push(...postgresDatabaseAuthorizationSteps(identity, database, privileges, selection.schemas ?? ["public"], createStepId, steps.length, selection.tables));
  }
  return { steps };
}

export interface GrantAuthorizationPlanInput {
  provider: DatabaseUserAdminProvider;
  /** 目标用户身份 */
  user: DatabaseUserIdentity;
  /** 需要授权（或撤权）的库/表选择 */
  databases: DatabaseAuthorizationSelection[];
  /** 是否携带 WITH GRANT OPTION，仅对授权语句生效 */
  grantOption?: boolean;
  /** 为 true 时生成 REVOKE，默认生成 GRANT */
  revoke?: boolean;
  /** 已加载的直接表授权；提供后仅生成实际有变化的权限语句 */
  currentGrants?: readonly DatabaseTablePrivilegeGrant[];
}

/**
 * 为“已存在的用户”构造授权计划：把多库/多表选择展开为多条独立的 GRANT / REVOKE。
 * 与 buildCreateUserAuthorizationPlan 的差异：
 * 1. 不包含创建用户步骤，因此各步骤之间没有依赖关系；
 * 2. MySQL 保持原有追加式语义；PostgreSQL 与 StarRocks 在已加载直接授权时按权限差异生成语句；
 * 3. PostgreSQL 的执行数据库、StarRocks 的执行 catalog 都保存在步骤元数据中，不能套用 MySQL 上下文。
 */
export function buildGrantAuthorizationPlan(input: GrantAuthorizationPlanInput): AuthorizationPlan {
  const changePrivilegesSql = input.revoke ? input.provider.revokePrivilegesSql : input.provider.grantPrivilegesSql;
  if (!changePrivilegesSql) return { steps: [] };
  if (!input.provider.supportsTableGrantsOnCreate) return { steps: [] };
  const steps: AuthorizationPlanStep[] = [];
  for (const selection of input.databases) {
    const database = selection.database.trim();
    if (!database) continue;
    const model = input.provider.authorizationModel;
    const targetScope = selection.tables !== undefined || model === "postgres" || model === "starrocks" ? "table" : "database";
    const desiredPrivileges = authorizationPresetPrivileges(input.provider, selection.preset, selection.privileges, targetScope);
    if (desiredPrivileges.length === 0) continue;

    if (model === "postgres") {
      const targets = selection.tables === undefined ? uniqueSchemas(selection.schemas ?? []).map((schema) => ({ name: "*", schema })) : uniqueTables(selection.tables);
      for (const target of targets) {
        const schema = target.schema?.trim();
        if (!schema) continue;
        const privileges = changedPrivileges(input, { database, schema, table: target.name }, desiredPrivileges);
        if (privileges.length === 0) continue;
        const targetTable = target.name === "*" ? undefined : target.name;
        steps.push({
          id: `change-${steps.length}`,
          label: `${input.revoke ? "revoke" : "grant"} ${input.provider.label(input.user)} ${authorizationTargetLabel(undefined, database, schema, targetTable)}`,
          database,
          sql: changePrivilegesSql({ user: input.user, privileges, database: schema, table: target.name, grantOption: input.grantOption, scope: "table" }),
          operation: input.revoke ? "revokePrivileges" : "grantDatabase",
          subject: input.provider.label(input.user),
          targetDatabase: database,
          targetSchema: schema,
          targetTable,
        });
      }
      continue;
    }

    const tables = selection.tables === undefined ? [{ name: "*" }] : uniqueTables(selection.tables);
    for (const table of tables) {
      const targetTable = table.name === "*" ? undefined : table.name;
      const privileges = model === "starrocks" ? changedPrivileges(input, { catalog: selection.catalog, database, table: table.name }, desiredPrivileges) : desiredPrivileges;
      if (privileges.length === 0) continue;
      const scope = model === "mysql" ? "mysql" : "table";
      steps.push({
        id: `change-${steps.length}`,
        label: `${input.revoke ? "revoke" : "grant"} ${input.provider.label(input.user)} ${authorizationTargetLabel(selection.catalog, database, undefined, targetTable)}`,
        database: model === "starrocks" ? database : "",
        sql: changePrivilegesSql({ user: input.user, privileges, catalog: selection.catalog, database, table: table.name, grantOption: input.grantOption, scope }),
        operation: input.revoke ? "revokePrivileges" : "grantDatabase",
        subject: input.provider.label(input.user),
        targetCatalog: selection.catalog,
        targetDatabase: database,
        targetTable,
      });
    }
  }
  return { steps };
}

export function buildCreateDatabaseAuthorizationPlan(input: CreateDatabaseAuthorizationPlanInput): AuthorizationPlan {
  const createStepId = "create-database";
  const steps: AuthorizationPlanStep[] = [
    {
      id: createStepId,
      label: `create database ${input.database}`,
      database: "",
      sql: input.createSql,
      operation: "createDatabase",
      targetDatabase: input.database,
    },
  ];
  const postgresUsers: DatabaseUserIdentity[] = [];
  const postgresDatabaseGrantIds = new Map<string, string>();
  if (!input.provider.grantPrivilegesSql) return { steps };
  for (const user of input.users) {
    if (input.provider.dialect === "mysql") {
      steps.push({
        id: `grant-${steps.length}`,
        label: `grant ${input.provider.label(user)} access to ${input.database}`,
        database: "",
        sql: `GRANT ALL PRIVILEGES ON ${quoteMySqlIdentifier(input.database)}.* TO ${mysqlUserAccount(user)};`,
        dependsOn: [createStepId],
        operation: "grantDatabase",
        subject: input.provider.label(user),
        targetDatabase: input.database,
      });
      continue;
    }
    postgresUsers.push(user);
    const role = quotePostgresIdentifier(user.user);
    const database = quotePostgresIdentifier(input.database);
    const databaseGrantId = `grant-database-${steps.length}`;
    postgresDatabaseGrantIds.set(user.user, databaseGrantId);
    steps.push({
      id: databaseGrantId,
      label: `grant ${input.provider.label(user)} access to ${input.database}`,
      database: "",
      sql: `GRANT ALL PRIVILEGES ON DATABASE ${database} TO ${role};`,
      dependsOn: [createStepId],
      operation: "grantDatabase",
      subject: input.provider.label(user),
      targetDatabase: input.database,
    });
    steps.push(...postgresFullCurrentObjectSteps(user, input.database, "public", [createStepId, databaseGrantId], `create-${steps.length}`));
    steps.push(...postgresFullFutureObjectSteps(user, input.database, undefined, [createStepId, databaseGrantId], `creator-${steps.length}`));
  }

  for (const owner of postgresUsers) {
    for (const grantee of postgresUsers) {
      if (owner.user === grantee.user) continue;
      const databaseGrantId = postgresDatabaseGrantIds.get(grantee.user);
      steps.push(...postgresFullFutureObjectSteps(grantee, input.database, owner.user, [createStepId, ...(databaseGrantId ? [databaseGrantId] : [])], `owner-${steps.length}`));
    }
  }
  return { steps };
}

export function authorizationPlanSql(plan: AuthorizationPlan): string {
  return plan.steps
    .map((step) => {
      const target = step.database ? `database: ${step.database}` : "connection scope";
      return `-- ${step.label} (${target})\n${step.sql}`;
    })
    .join("\n\n");
}

export async function executeAuthorizationPlan(plan: AuthorizationPlan, execute: (step: AuthorizationPlanStep) => Promise<QueryResult[]>): Promise<AuthorizationStepResult[]> {
  const results: AuthorizationStepResult[] = [];
  const failed = new Set<string>();
  for (const step of plan.steps) {
    if (step.dependsOn?.some((dependency) => failed.has(dependency))) {
      failed.add(step.id);
      results.push({ step, status: "skipped" });
      continue;
    }
    try {
      const queryResults = await execute(step);
      const error = queryResults.find((result) => result.execution_error === true);
      if (error) {
        failed.add(step.id);
        results.push({ step, status: "failed", message: queryResultMessage(error) });
      } else {
        results.push({ step, status: "success" });
      }
    } catch (error: any) {
      failed.add(step.id);
      results.push({ step, status: "failed", message: error?.message || String(error) });
    }
  }
  return results;
}

export function authorizationPlanStatus(results: AuthorizationStepResult[]): "success" | "partial" | "failed" {
  const successes = results.filter((result) => result.status === "success").length;
  const failures = results.filter((result) => result.status === "failed").length;
  if (failures === 0) return "success";
  return successes > 0 ? "partial" : "failed";
}

function adminPrincipalGrantSql(provider: DatabaseUserAdminProvider, principal: CreatePrincipalInput): string {
  if (provider.dialect === "mysql") {
    return `GRANT ALL PRIVILEGES ON *.* TO ${mysqlUserAccount(principal)} WITH GRANT OPTION;`;
  }
  return `ALTER ROLE ${quotePostgresIdentifier(principal.user)} SUPERUSER CREATEDB CREATEROLE;`;
}

function postgresDatabaseAuthorizationSteps(user: DatabaseUserIdentity, databaseName: string, privileges: string[], schemaNames: string[], createStepId: string, index: number, selectedTables?: AuthorizationTableSelection[]): AuthorizationPlanStep[] {
  const role = quotePostgresIdentifier(user.user);
  const database = quotePostgresIdentifier(databaseName);
  const privilegeSet = new Set(uniquePrivileges(privileges));
  const databasePrivileges = uniquePrivileges(["CONNECT", ...(privilegeSet.has("CREATE") ? ["CREATE"] : []), ...(privilegeSet.has("TEMPORARY") ? ["TEMPORARY"] : [])]);
  const databaseStepId = `grant-database-${index}`;
  const steps: AuthorizationPlanStep[] = [
    {
      id: databaseStepId,
      label: `grant ${user.user} access to ${databaseName}`,
      database: "",
      sql: `GRANT ${databasePrivileges.join(", ")} ON DATABASE ${database} TO ${role};`,
      dependsOn: [createStepId],
      operation: "grantDatabase",
      subject: user.user,
      targetDatabase: databaseName,
    },
  ];

  if (selectedTables !== undefined) {
    const tablePrivileges = [...privilegeSet].filter((privilege) => POSTGRES_TABLE_PRIVILEGE_SET.has(privilege));
    const tables = uniqueTables(selectedTables).filter((table) => table.schema?.trim());
    const schemas = uniqueSchemas(tables.flatMap((table) => (table.schema ? [table.schema] : [])));
    for (const [schemaIndex, schemaName] of schemas.entries()) {
      steps.push(
        authorizationObjectStep({
          id: `grant-schema-${index}-${schemaIndex}`,
          user,
          databaseName,
          schema: schemaName,
          objectScope: "schemas",
          sql: `GRANT USAGE ON SCHEMA ${quotePostgresIdentifier(schemaName)} TO ${role};`,
          dependsOn: [createStepId, databaseStepId],
        }),
      );
    }
    if (tablePrivileges.length > 0) {
      for (const [tableIndex, table] of tables.entries()) {
        const schemaName = table.schema!.trim();
        steps.push(
          authorizationObjectStep({
            id: `grant-table-${index}-${tableIndex}`,
            user,
            databaseName,
            schema: schemaName,
            objectScope: "tables",
            sql: `GRANT ${tablePrivileges.join(", ")} ON TABLE ${quotePostgresIdentifier(schemaName)}.${quotePostgresIdentifier(table.name)} TO ${role};`,
            dependsOn: [createStepId, databaseStepId],
            targetTable: table.name,
          }),
        );
      }
    }
    return steps;
  }

  const schemas = uniqueSchemas(schemaNames);
  if (schemas.length > 0) {
    const tablePrivileges = [...privilegeSet].filter((privilege) => ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(privilege));
    const sequencePrivileges = privilegeSet.has("UPDATE") ? "USAGE, SELECT, UPDATE" : privilegeSet.has("INSERT") ? "USAGE, SELECT" : privilegeSet.has("SELECT") ? "SELECT" : "";
    for (const [schemaIndex, schemaName] of schemas.entries()) {
      const schema = quotePostgresIdentifier(schemaName);
      steps.push(
        authorizationObjectStep({
          id: `grant-schema-${index}-${schemaIndex}`,
          user,
          databaseName,
          schema: schemaName,
          objectScope: "schemas",
          sql: `GRANT USAGE${privilegeSet.has("CREATE") ? ", CREATE" : ""} ON SCHEMA ${schema} TO ${role};`,
          dependsOn: [createStepId, databaseStepId],
        }),
      );
      if (tablePrivileges.length > 0) {
        const tablePrivilegeSql = tablePrivileges.join(", ");
        steps.push(
          authorizationObjectStep({
            id: `grant-tables-${index}-${schemaIndex}`,
            user,
            databaseName,
            schema: schemaName,
            objectScope: "tables",
            sql: `GRANT ${tablePrivilegeSql} ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
            dependsOn: [createStepId, databaseStepId],
          }),
        );
      }
      if (sequencePrivileges) {
        steps.push(
          authorizationObjectStep({
            id: `grant-sequences-${index}-${schemaIndex}`,
            user,
            databaseName,
            schema: schemaName,
            objectScope: "sequences",
            sql: `GRANT ${sequencePrivileges} ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`,
            dependsOn: [createStepId, databaseStepId],
          }),
        );
      }
      if (privilegeSet.has("EXECUTE")) {
        steps.push(
          authorizationObjectStep({
            id: `grant-functions-${index}-${schemaIndex}`,
            user,
            databaseName,
            schema: schemaName,
            objectScope: "functions",
            sql: `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role};`,
            dependsOn: [createStepId, databaseStepId],
          }),
        );
      }
    }

    const schemaPrivileges = privilegeSet.has("CREATE") ? "USAGE, CREATE" : "USAGE";
    steps.push(authorizationFutureObjectStep({ id: `grant-default-schemas-${index}`, user, databaseName, objectScope: "schemas", privileges: schemaPrivileges, dependsOn: [createStepId, databaseStepId] }));
    if (tablePrivileges.length > 0) {
      steps.push(authorizationFutureObjectStep({ id: `grant-default-tables-${index}`, user, databaseName, objectScope: "tables", privileges: tablePrivileges.join(", "), dependsOn: [createStepId, databaseStepId] }));
    }
    if (sequencePrivileges) {
      steps.push(authorizationFutureObjectStep({ id: `grant-default-sequences-${index}`, user, databaseName, objectScope: "sequences", privileges: sequencePrivileges, dependsOn: [createStepId, databaseStepId] }));
    }
    if (privilegeSet.has("EXECUTE")) {
      steps.push(authorizationFutureObjectStep({ id: `grant-default-functions-${index}`, user, databaseName, objectScope: "functions", privileges: "EXECUTE", dependsOn: [createStepId, databaseStepId] }));
    }
  }
  return steps;
}

interface AuthorizationObjectStepInput {
  id: string;
  user: DatabaseUserIdentity;
  databaseName: string;
  objectScope: AuthorizationObjectScope;
  sql: string;
  dependsOn: string[];
  schema?: string;
  targetTable?: string;
}

function authorizationObjectStep(input: AuthorizationObjectStepInput): AuthorizationPlanStep {
  return {
    id: input.id,
    label: `grant current ${input.objectScope} to ${input.user.user} in ${input.databaseName}`,
    database: input.databaseName,
    sql: input.sql,
    dependsOn: input.dependsOn,
    operation: "grantCurrentObjects",
    subject: input.user.user,
    targetDatabase: input.databaseName,
    targetSchema: input.schema,
    objectScope: input.objectScope,
    schema: input.schema,
    targetTable: input.targetTable,
  };
}

interface AuthorizationFutureObjectStepInput {
  id: string;
  user: DatabaseUserIdentity;
  databaseName: string;
  objectScope: AuthorizationObjectScope;
  privileges: string;
  dependsOn: string[];
  owner?: string;
}

function authorizationFutureObjectStep(input: AuthorizationFutureObjectStepInput): AuthorizationPlanStep {
  const ownerSql = input.owner ? ` FOR ROLE ${quotePostgresIdentifier(input.owner)}` : "";
  return {
    id: input.id,
    label: `grant future ${input.objectScope} from ${input.owner ?? "current role"} to ${input.user.user} in ${input.databaseName}`,
    database: input.databaseName,
    sql: `ALTER DEFAULT PRIVILEGES${ownerSql} GRANT ${input.privileges} ON ${input.objectScope.toUpperCase()} TO ${quotePostgresIdentifier(input.user.user)};`,
    dependsOn: input.dependsOn,
    operation: "grantFutureObjects",
    subject: input.user.user,
    targetDatabase: input.databaseName,
    objectScope: input.objectScope,
    owner: input.owner,
  };
}

function postgresFullCurrentObjectSteps(user: DatabaseUserIdentity, databaseName: string, schemaName: string, dependsOn: string[], idPrefix: string): AuthorizationPlanStep[] {
  const role = quotePostgresIdentifier(user.user);
  const schema = quotePostgresIdentifier(schemaName);
  return [
    authorizationObjectStep({ id: `${idPrefix}-schema`, user, databaseName, schema: schemaName, objectScope: "schemas", sql: `GRANT ALL PRIVILEGES ON SCHEMA ${schema} TO ${role};`, dependsOn }),
    authorizationObjectStep({ id: `${idPrefix}-tables`, user, databaseName, schema: schemaName, objectScope: "tables", sql: `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${role};`, dependsOn }),
    authorizationObjectStep({ id: `${idPrefix}-sequences`, user, databaseName, schema: schemaName, objectScope: "sequences", sql: `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};`, dependsOn }),
    authorizationObjectStep({ id: `${idPrefix}-functions`, user, databaseName, schema: schemaName, objectScope: "functions", sql: `GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role};`, dependsOn }),
  ];
}

function postgresFullFutureObjectSteps(user: DatabaseUserIdentity, databaseName: string, owner: string | undefined, dependsOn: string[], idPrefix: string): AuthorizationPlanStep[] {
  return (["schemas", "tables", "sequences", "functions"] as const).map((objectScope) => authorizationFutureObjectStep({ id: `${idPrefix}-default-${objectScope}`, user, databaseName, objectScope, privileges: "ALL PRIVILEGES", dependsOn, owner }));
}

function uniqueSchemas(schemaNames: string[]): string[] {
  return Array.from(
    new Set(
      schemaNames
        .map((schema) => schema.trim())
        .filter((schema) => {
          const normalized = schema.toLowerCase();
          return !!schema && normalized !== "information_schema" && normalized !== "sys_catalog" && !normalized.startsWith("pg_");
        }),
    ),
  );
}

function uniquePrivileges(privileges: string[]): string[] {
  return Array.from(new Set(privileges.map((privilege) => privilege.trim().toUpperCase()).filter(Boolean)));
}

function uniqueTables(tables: readonly AuthorizationTableSelection[]): AuthorizationTableSelection[] {
  const seen = new Set<string>();
  const unique: AuthorizationTableSelection[] = [];
  for (const table of tables) {
    const name = table.name.trim();
    const schema = table.schema?.trim() || undefined;
    if (!name) continue;
    const key = JSON.stringify([schema ?? "", name]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ name, ...(schema ? { schema } : {}) });
  }
  return unique;
}

interface AuthorizationGrantTarget {
  catalog?: string;
  database: string;
  schema?: string;
  table: string;
}

function changedPrivileges(input: GrantAuthorizationPlanInput, target: AuthorizationGrantTarget, desiredPrivileges: string[]): string[] {
  if (input.currentGrants === undefined) return desiredPrivileges;
  const exactGrants = input.currentGrants.filter((grant) => tableGrantMatchesTarget(grant, target, false) || (input.revoke && input.provider.authorizationModel === "postgres" && target.table === "*" && postgresGrantIsInTargetSchema(grant, target)));
  if (input.revoke) {
    if (desiredPrivileges.includes("ALL")) return exactGrants.length > 0 ? ["ALL"] : [];
    return desiredPrivileges.filter((privilege) => exactGrants.some((grant) => grant.privilege === privilege || grant.privilege === "ALL"));
  }

  const effectiveGrants = input.currentGrants.filter((grant) => tableGrantMatchesTarget(grant, target, true));
  return desiredPrivileges.filter((privilege) => {
    const current = effectiveGrants.filter((grant) => grant.privilege === privilege || grant.privilege === "ALL");
    return current.length === 0 || (!!input.grantOption && current.every((grant) => !grant.grantOption));
  });
}

function postgresGrantIsInTargetSchema(grant: DatabaseTablePrivilegeGrant, target: AuthorizationGrantTarget): boolean {
  return grant.catalog === undefined && grant.database === target.database && grant.schema === target.schema;
}

function tableGrantMatchesTarget(grant: DatabaseTablePrivilegeGrant, target: AuthorizationGrantTarget, allowBroader: boolean): boolean {
  const targetCatalog = normalizeStarrocksCatalog(target.catalog ?? "") ?? "default_catalog";
  const grantCatalog = normalizeStarrocksCatalog(grant.catalog ?? "") ?? "default_catalog";
  if (target.catalog !== undefined || grant.catalog !== undefined) {
    if (targetCatalog !== grantCatalog) return false;
  }
  if (grant.schema !== target.schema) return false;
  if (grant.database !== target.database && !(allowBroader && grant.database === "*")) return false;
  return grant.table === target.table || (allowBroader && grant.table === "*");
}

function authorizationTargetLabel(catalog: string | undefined, database: string, schema: string | undefined, table: string | undefined): string {
  return [catalog, database, schema, table].filter((part): part is string => !!part).join(".");
}

function queryResultMessage(result: QueryResult): string {
  return String(result.rows[0]?.[0] ?? "Execution failed");
}
