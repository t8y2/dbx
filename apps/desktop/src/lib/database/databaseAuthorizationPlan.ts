import type { QueryResult } from "@/types/database";
import { mysqlUserAccount, quoteMySqlIdentifier, quotePostgresIdentifier, type CreatePrincipalInput, type DatabaseUserAdminProvider, type DatabaseUserIdentity } from "@/lib/database/databaseUserAdmin";

export type AuthorizationAccountType = "standard" | "admin";
export type AuthorizationPreset = "readWrite" | "readOnly" | "ddl" | "dml" | "custom";
export type AuthorizationStepOperation = "createUser" | "grantAdmin" | "createDatabase" | "grantDatabase" | "grantCurrentObjects" | "grantFutureObjects";
export type AuthorizationObjectScope = "schemas" | "tables" | "sequences" | "functions";

export interface DatabaseAuthorizationSelection {
  database: string;
  preset: AuthorizationPreset;
  privileges?: string[];
  schemas?: string[];
}

export interface AuthorizationPlanStep {
  id: string;
  label: string;
  database: string;
  sql: string;
  dependsOn?: string[];
  operation: AuthorizationStepOperation;
  subject?: string;
  targetDatabase?: string;
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

const POSTGRES_PRESETS: Record<Exclude<AuthorizationPreset, "custom">, string[]> = {
  readOnly: ["SELECT"],
  dml: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ddl: ["CREATE"],
  readWrite: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "EXECUTE", "CREATE", "TEMPORARY"],
};

export function authorizationPresetPrivileges(provider: DatabaseUserAdminProvider, preset: AuthorizationPreset, custom: string[] = []): string[] {
  if (preset === "custom") return uniquePrivileges(custom);
  return [...(provider.dialect === "mysql" ? MYSQL_PRESETS[preset] : POSTGRES_PRESETS[preset])];
}

export function authorizationPrivileges(provider: DatabaseUserAdminProvider): string[] {
  const privilegesForScope = provider.privilegesForScope;
  if (!privilegesForScope) return [];
  if (provider.dialect === "mysql") return Array.from(privilegesForScope("mysql"));
  return uniquePrivileges([...privilegesForScope("database"), ...privilegesForScope("schema"), ...privilegesForScope("table"), "EXECUTE", "USAGE", "UPDATE"]);
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
    const privileges = authorizationPresetPrivileges(input.provider, selection.preset, selection.privileges);
    if (input.provider.dialect === "mysql") {
      steps.push({
        id: `grant-${steps.length}`,
        label: `grant ${input.provider.label(identity)} access to ${database}`,
        database: "",
        sql: input.provider.grantPrivilegesSql({ user: identity, privileges, database, table: "*", scope: "mysql" }),
        dependsOn: [createStepId],
        operation: "grantDatabase",
        subject: input.provider.label(identity),
        targetDatabase: database,
      });
      continue;
    }
    steps.push(...postgresDatabaseAuthorizationSteps(identity, database, privileges, selection.schemas ?? ["public"], createStepId, steps.length));
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

function postgresDatabaseAuthorizationSteps(user: DatabaseUserIdentity, databaseName: string, privileges: string[], schemaNames: string[], createStepId: string, index: number): AuthorizationPlanStep[] {
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
    objectScope: input.objectScope,
    schema: input.schema,
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

function queryResultMessage(result: QueryResult): string {
  return String(result.rows[0]?.[0] ?? "Execution failed");
}
