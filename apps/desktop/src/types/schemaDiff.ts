export type SchemaDiffTableFilterPriority = "include" | "exclude";

export interface OracleRoutineEndpoint {
  connectionId: string;
  database: string;
  schema: string;
  databaseType: "oracle" | "oceanbase-oracle";
  generation: number;
}

export type OracleRoutineKind = "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE_BODY";

export interface OracleRoutineIdentity {
  owner: string;
  name: string;
  kind: OracleRoutineKind;
}

export interface OracleRoutineReadOptions {
  objectKinds?: OracleRoutineKind[];
  selectedObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[];
}

export interface OracleRoutineVersion {
  identity: OracleRoutineIdentity;
  objectId: string;
  status: string;
  lastDdlTime: string;
}

export interface OracleRoutineReadIssue {
  stage: string;
  code: string;
  message: string;
}

export interface OracleRoutineDependency {
  owner: string;
  name: string;
  kind: string;
  databaseLink: string | null;
  dependencyType: string;
}

export interface OracleRoutineObjectSnapshot {
  version: OracleRoutineVersion;
  source: string | null;
  sourceOrigin?: "oracle-dictionary" | "oceanbase-dictionary" | "oracle-metadata";
  sourceComplete: boolean;
  dependencies: OracleRoutineDependency[];
  dependenciesComplete: boolean;
  issues: OracleRoutineReadIssue[];
}

export interface OracleRoutineSnapshot {
  endpoint: OracleRoutineEndpoint;
  state: "complete" | "partial" | "failed" | "permission-denied";
  enumerationComplete: boolean;
  objects: OracleRoutineObjectSnapshot[];
  issues: OracleRoutineReadIssue[];
}

export interface OracleRoutineCompareContext {
  sourceDatabaseType: string;
  targetDatabaseType: string;
  sourceSchema: string;
  targetSchema: string;
  sourceEnumerationComplete: boolean;
  targetEnumerationComplete: boolean;
  sourceIncompleteNames: string[];
  targetIncompleteNames: string[];
  objectKinds?: OracleRoutineKind[];
  sourceIncompleteObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[];
  targetIncompleteObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[];
}

export interface OracleRoutineReadback {
  identity: OracleRoutineIdentity;
  state: "verified" | "invalid" | "missing" | "present" | "definition-mismatch" | "readback-failed";
  exists: boolean | null;
  version: OracleRoutineVersion | null;
  source: string | null;
  definitionMatches: boolean | null;
  sourceOrigin?: "oracle-dictionary" | "oceanbase-dictionary" | "oracle-metadata";
  packageCompanion?: OracleRoutineReadback;
  compilerMessages: { attribute: string; line: number; position: number; text: string }[];
  issues: OracleRoutineReadIssue[];
}

export interface OracleRoutineOperation {
  operationId: string;
  target: OracleRoutineEndpoint;
  identity: OracleRoutineIdentity;
  lifecycle: "prepared" | "running" | "terminal" | "unproven";
  dispatched: boolean;
  acknowledged: boolean;
  readback: OracleRoutineReadback | null;
  error: string | null;
}

export interface OracleRoutineOperationObservation {
  operation: OracleRoutineOperation | null;
  lifecycle: OracleRoutineOperation["lifecycle"];
  error: string | null;
}

export interface OracleRoutineSaveInput {
  connectionId: string;
  database: string;
  identity: OracleRoutineIdentity;
  sql: string;
  requireAbsent?: boolean;
  prerequisiteOperationId?: string;
  supersedesOperationId?: string;
}

export type OracleRoutinePlanAction = "create" | "replace" | "delete";

export interface OracleRoutinePlanDraft {
  identity: OracleRoutineIdentity;
  action: OracleRoutinePlanAction;
  sourceName?: string;
  sql?: string;
  baselineOperationId?: string;
  supersedesOperationId?: string;
  packageBodySource?: "source" | "target";
  packageContract?: "source" | "target";
  confirmPackagePair?: boolean;
}

export interface OracleRoutinePlanInput {
  source: OracleRoutineSnapshot;
  target: OracleRoutineSnapshot;
  drafts: OracleRoutinePlanDraft[];
  compactSql?: boolean;
}

export interface OracleRoutinePlanStep {
  identity: OracleRoutineIdentity;
  action: OracleRoutinePlanAction;
  sql: string;
  sourceOriginal: string | null;
  targetOriginal: string | null;
  recoverySql: string | null;
  recoveryComplete: boolean;
  references: { owner: string; name: string; kind: string; member: string | null; selectedIndex: number | null; line: number; column: number }[];
  incomingCallers: OracleRoutineDependency[];
  issues: { code: string; message: string; line: number; column: number }[];
  operation: OracleRoutineOperation | null;
  packageImpact?: OraclePackagePlanImpact;
}

export interface OraclePackagePlanImpact {
  companion: OracleRoutineIdentity;
  companionAction: OracleRoutinePlanAction | null;
  implicitCompanionDelete: boolean;
  retainsTargetBody: boolean;
  bodyPending: boolean;
  mayInitialize: boolean;
  grants: { grants: { grantor: string; grantee: string; privilege: string; grantable: boolean }[]; complete: boolean; issue: string | null } | null;
}

export interface OracleRoutinePlan {
  target: OracleRoutineEndpoint;
  steps: OracleRoutinePlanStep[];
  ready: boolean;
}

export interface SchemaDiffTableMapping {
  sourceTable: string;
  targetTable: string;
}

export interface SchemaDiffRoutineMapping {
  sourceRoutine: string;
  targetRoutine: string;
}

export interface SchemaDiffCompareOptions {
  tables: boolean;
  primaryKeys: boolean;
  foreignKeys: boolean;
  uniqueKeys: boolean;
  checks: boolean;
  exclusions: boolean;
  views: boolean;
  functions: boolean;
  indexes: boolean;
  sequences: boolean;
  triggers: boolean;
  rules: boolean;
  owners: boolean;
  cascadeDelete: boolean;
  sequenceLastValues: boolean;
  compareColumnOrder: boolean;
  compareCharset: boolean;
  ignoreTableNameCase: boolean;
  ignoreColumnNameCase: boolean;
  /**
   * Drop the persisted object metadata cache for both endpoints before loading
   * table details, so the compare reads the live structure. Turn off to reuse
   * cached metadata (faster, but may hide changes made outside DBX).
   */
  refreshMetadata: boolean;
  tableIncludePattern: string;
  tableExcludePattern: string;
  tableFilterPriority: SchemaDiffTableFilterPriority;
  /**
   * Explicitly selected table names to compare (the source table set, applied BEFORE the
   * existing include/exclude regex filters). `undefined` means no visual restriction, so all
   * tables still flow through the regex filters and legacy configs keep their
   * behavior. `[]` means an explicitly enabled restriction with no selected tables and
   * therefore compares nothing. A non-empty array restricts the comparison to exactly those
   * names. Never initialize this to the full table
   * list so newly added tables keep entering unrestricted comparisons and configs stay small.
   */
  selectedTables: string[] | undefined;
  tableMappings?: SchemaDiffTableMapping[];
  /**
   * Explicitly selected routine keys (`name` or `name(args)`) to compare.
   * `undefined` means no restriction (all functions when `functions` is on).
   * `[]` means restriction enabled with nothing selected.
   */
  selectedRoutines: string[] | undefined;
  routineObjectKinds?: OracleRoutineKind[];
  selectedRoutineObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[];
  routineMappings?: SchemaDiffRoutineMapping[];
  detectRenames: boolean;
  renameThreshold: number;
  detectTableRenames: boolean;
  enableRollback: boolean;
  batchPatterns: string;
  sourceDialect: string;
  targetDialect: string;
  compatibilityThreshold: number;
  fieldMappings: FieldMappingEntry[];
}

export type FieldMappingParamStrategy = "preserve" | "strip" | "custom";

export interface FieldMappingEntry {
  sourceType: string;
  targetType: string;
  paramStrategy: FieldMappingParamStrategy;
  customParams?: string;
}

export interface SchemaDiffConfig {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  options: SchemaDiffCompareOptions;
}

export interface SchemaDiffOptionItem {
  id: BooleanSchemaDiffCompareOptionKey;
  labelKey: string;
  defaultChecked: boolean;
  children?: SchemaDiffOptionItem[];
}

export type BooleanSchemaDiffCompareOptionKey = {
  [K in keyof SchemaDiffCompareOptions]-?: NonNullable<SchemaDiffCompareOptions[K]> extends boolean ? K : never;
}[keyof SchemaDiffCompareOptions];

export type SchemaDiffOptionsMap = Partial<Record<string, SchemaDiffOptionItem[]>>;

export const DEFAULT_POSTGRES_OPTIONS: SchemaDiffCompareOptions = {
  tables: true,
  primaryKeys: true,
  foreignKeys: true,
  uniqueKeys: true,
  checks: true,
  exclusions: true,
  views: true,
  functions: true,
  indexes: true,
  sequences: true,
  triggers: true,
  rules: true,
  owners: true,
  cascadeDelete: false,
  sequenceLastValues: true,
  compareColumnOrder: false,
  compareCharset: true,
  ignoreTableNameCase: false,
  ignoreColumnNameCase: false,
  refreshMetadata: true,
  tableIncludePattern: "",
  tableExcludePattern: "",
  tableFilterPriority: "exclude",
  selectedTables: undefined,
  tableMappings: [],
  selectedRoutines: undefined,
  routineMappings: [],
  detectRenames: false,
  renameThreshold: 0.5,
  detectTableRenames: false,
  enableRollback: false,
  batchPatterns: "",
  sourceDialect: "",
  targetDialect: "",
  compatibilityThreshold: 0.5,
  fieldMappings: [],
};

export const DEFAULT_MYSQL_OPTIONS: SchemaDiffCompareOptions = {
  tables: true,
  primaryKeys: true,
  foreignKeys: true,
  uniqueKeys: true,
  checks: true,
  exclusions: false,
  views: true,
  functions: true,
  indexes: true,
  sequences: false,
  triggers: true,
  rules: false,
  owners: false,
  cascadeDelete: false,
  sequenceLastValues: false,
  compareColumnOrder: false,
  compareCharset: true,
  ignoreTableNameCase: false,
  ignoreColumnNameCase: false,
  refreshMetadata: true,
  tableIncludePattern: "",
  tableExcludePattern: "",
  tableFilterPriority: "exclude",
  selectedTables: undefined,
  tableMappings: [],
  selectedRoutines: undefined,
  routineMappings: [],
  detectRenames: false,
  renameThreshold: 0.5,
  detectTableRenames: false,
  enableRollback: false,
  batchPatterns: "",
  sourceDialect: "",
  targetDialect: "",
  compatibilityThreshold: 0.5,
  fieldMappings: [],
};

export function getDefaultOptionsForDbType(dbType: string): SchemaDiffCompareOptions {
  if (dbType === "postgres" || dbType === "opengauss") {
    return { ...DEFAULT_POSTGRES_OPTIONS };
  }
  return { ...DEFAULT_MYSQL_OPTIONS };
}

export function normalizeSchemaDiffCompareOptions(options: Partial<SchemaDiffCompareOptions> | null | undefined, dbType = "postgres"): SchemaDiffCompareOptions {
  const defaults = getDefaultOptionsForDbType(dbType);
  const normalized: SchemaDiffCompareOptions = {
    ...defaults,
    ...options,
    tableMappings: Array.isArray(options?.tableMappings) ? options.tableMappings.map((mapping) => ({ ...mapping })) : defaults.tableMappings,
    routineMappings: Array.isArray(options?.routineMappings) ? options.routineMappings.map((mapping) => ({ ...mapping })) : defaults.routineMappings,
    selectedRoutines: options?.selectedRoutines === undefined ? defaults.selectedRoutines : options.selectedRoutines ? [...options.selectedRoutines] : options.selectedRoutines,
    ...(options?.routineObjectKinds === undefined ? {} : { routineObjectKinds: [...options.routineObjectKinds] }),
    ...(options?.selectedRoutineObjects === undefined ? {} : { selectedRoutineObjects: options.selectedRoutineObjects.map((object) => ({ ...object })) }),
  };
  // Table compare owns views; turning tables off must not leave views loading metadata alone.
  if (!normalized.tables) normalized.views = false;
  return normalized;
}

export function createEmptyConfig(id: string, name: string): SchemaDiffConfig {
  const now = Date.now();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    sourceConnectionId: "",
    sourceDatabase: "",
    sourceSchema: "",
    targetConnectionId: "",
    targetDatabase: "",
    targetSchema: "",
    options: { ...DEFAULT_POSTGRES_OPTIONS },
  };
}

export function cloneConfig(config: SchemaDiffConfig, newId: string, newName: string): SchemaDiffConfig {
  const now = Date.now();
  return {
    ...config,
    id: newId,
    name: newName,
    createdAt: now,
    updatedAt: now,
  };
}
