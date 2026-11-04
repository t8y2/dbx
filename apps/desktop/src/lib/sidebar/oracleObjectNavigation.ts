import type { TreeNode } from "@/types/database";
import type { OracleDatabaseLinkScope } from "@/lib/database/oracleDatabaseLinks";
import type { NativeJobAdminSelection } from "@/lib/database/nativeJobAdmin";
import { sidebarTreeObjectCountText } from "./sidebarTreeLabel";

export function oracleNavigationAuxiliaryText(node: TreeNode, t: (key: string) => string): string | undefined {
  if (node.type !== "oracle-db-links" && node.type !== "native-job-group" && node.type !== "group-extensions" && node.type !== "group-event-triggers" && !(node.relationalNavigationSources && node.type.startsWith("group-"))) return undefined;
  if (node.isLoading || node.oracleNavigationStatus?.kind === "unknown" || node.oracleNavigationStatus?.kind === "truncated") return "";
  if (node.oracleNavigationStatus) return t(`tree.navigationStatus.${node.oracleNavigationStatus.kind}`);
  return sidebarTreeObjectCountText(node);
}

export function nativeJobObjectNode(parent: TreeNode, selection: NativeJobAdminSelection, label: string, comment?: string | null): TreeNode {
  if (selection.kind === "dameng-native") throw new TypeError("native_job_page_scope_mismatch");
  return {
    id: `${parent.id}:${encodeURIComponent(selection.kind === "scheduler" ? selection.name : selection.jobId)}`,
    type: "native-job",
    label,
    objectName: label,
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
    nativeJobPage: parent.nativeJobPage,
    nativeJobSelection: selection.kind === "scheduler" ? { kind: "scheduler", owner: selection.owner, name: selection.name } : { kind: "legacy", jobId: selection.jobId },
    comment,
    isExpanded: false,
  };
}

function navigationId(parent: Pick<TreeNode, "id" | "connectionId" | "database">, kind: string, schema?: string): string {
  return `${parent.id}:__oracle_navigation:${encodeURIComponent(JSON.stringify([parent.connectionId, parent.database ?? "", kind, schema ?? null]))}`;
}

export function oracleDatabaseLinkGroup(parent: Pick<TreeNode, "id" | "connectionId" | "database">, scope: OracleDatabaseLinkScope): TreeNode {
  return {
    id: navigationId(parent, `database-links-${scope.kind}`, scope.kind === "schema" ? scope.schema : undefined),
    type: "oracle-db-links",
    label: "tree.databaseLinks",
    connectionId: parent.connectionId,
    database: parent.database,
    databaseLinkScope: scope,
    schema: scope.kind === "schema" ? scope.schema : undefined,
    isExpanded: false,
    children: [],
  };
}

export function oracleSharedObjects(parent: Pick<TreeNode, "id" | "connectionId" | "database">, engine: "oracle" | "oceanbase-oracle"): TreeNode {
  const scope: OracleDatabaseLinkScope = { kind: engine === "oracle" ? "public" : "tenant" };
  const node: TreeNode = { id: navigationId(parent, `shared-${scope.kind}`), type: "oracle-shared-objects", label: "tree.publicObjects", connectionId: parent.connectionId, database: parent.database, databaseLinkScope: scope, isExpanded: false };
  node.children = [oracleDatabaseLinkGroup(node, scope)];
  return node;
}

export function oracleSchemaJobGroups(parent: Pick<TreeNode, "id" | "connectionId" | "database" | "schema">): TreeNode[] {
  if (!parent.schema) return [];
  const common = { connectionId: parent.connectionId, database: parent.database, schema: parent.schema, isExpanded: false };
  const jobs: TreeNode = { ...common, id: navigationId(parent, "jobs", parent.schema), type: "native-job-scheduler", label: "tree.jobs" };
  jobs.children = [
    ...(["regular", "lightweight", "in-memory"] as const).map((schedulerCategory) => ({
      ...common,
      id: navigationId(jobs, schedulerCategory, parent.schema),
      type: "native-job-group" as const,
      label: `tree.jobCategories.${schedulerCategory === "in-memory" ? "inMemory" : schedulerCategory}`,
      comment: schedulerCategory === "regular" ? "REGULAR" : schedulerCategory === "lightweight" ? "LIGHTWEIGHT" : "IN_MEMORY_RUNTIME, IN_MEMORY_FULL",
      nativeJobPage: { schema: parent.schema!, kind: "scheduler" as const, schedulerCategory },
      children: [],
    })),
    { ...common, id: navigationId(jobs, "legacy", parent.schema), type: "native-job-group", label: "tree.jobCategories.legacy", comment: "DBMS_JOB", nativeJobPage: { schema: parent.schema, kind: "legacy" }, children: [] },
  ];
  return [jobs];
}
