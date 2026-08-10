import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tauri = readFileSync(new URL("../tauri.ts", import.meta.url), "utf8");
const http = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const tauriRegistry = readFileSync(new URL("../../../../../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const webRegistry = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");
const operations = [...api.matchAll(/export const (consul\w+) = forward/g)].map((match) => match[1]);
const expectedOperations = [
  "consulCapabilities",
  "consulTxn",
  "consulRenameKey",
  "consulBlockingQuery",
  "consulDomainWatch",
  "consulCancelBlocking",
  "consulWatchStart",
  "consulListRecursive",
  "consulSearch",
  "consulSearchProgress",
  "consulCancelSearch",
  "consulExportBundle",
  "consulImportPreview",
  "consulImportExecute",
  "consulDeletePrefixPreview",
  "consulDeletePrefixExecute",
  "consulListPrefix",
  "consulGet",
  "consulPut",
  "consulDelete",
  "consulPreparedQueryList",
  "consulPreparedQueryRead",
  "consulPreparedQueryCreate",
  "consulPreparedQueryUpdate",
  "consulPreparedQueryDelete",
  "consulPreparedQueryExecute",
  "consulPreparedQueryExplain",
  "consulEventList",
  "consulEventFire",
  "consulCoordinateNodes",
  "consulOperatorRead",
  "consulSnapshotGenerate",
  "consulSnapshotRestore",
  "consulAutopilotUpdate",
  "consulRaftTransfer",
  "consulRaftRemove",
  "consulKeyringWrite",
  "consulLicenseWrite",
  "consulStatusLeader",
  "consulStatusPeers",
  "consulAgentSelf",
  "consulAgentMembers",
  "consulAgentMetrics",
  "consulCatalogDatacenters",
  "consulCatalogNodes",
  "consulCatalogServices",
  "consulCatalogServiceNodes",
  "consulCatalogNodeServices",
  "consulHealthNode",
  "consulHealthChecks",
  "consulHealthService",
  "consulHealthState",
  "consulAgentServices",
  "consulAgentService",
  "consulAgentChecks",
  "consulAgentRegisterService",
  "consulAgentDeregisterService",
  "consulAgentServiceMaintenance",
  "consulAgentRegisterCheck",
  "consulAgentDeregisterCheck",
  "consulAgentUpdateTtl",
  "consulSessions",
  "consulNodeSessions",
  "consulSession",
  "consulSessionKeys",
  "consulSessionDestroyImpact",
  "consulCreateSession",
  "consulRenewSession",
  "consulDestroySession",
  "consulAcquireLock",
  "consulReleaseLock",
  "consulAclList",
  "consulAclTokenSelf",
  "consulAclTokenClone",
  "consulAclGet",
  "consulAclApply",
  "consulAclReferences",
  "consulAclDelete",
  "consulEnterpriseList",
  "consulEnterpriseGet",
  "consulEnterpriseApply",
  "consulEnterpriseImpact",
  "consulEnterpriseDelete",
  "consulMeshConfigList",
  "consulMeshConfigGet",
  "consulMeshConfigApply",
  "consulMeshConfigDelete",
  "consulMeshIntentionsList",
  "consulMeshIntentionGet",
  "consulMeshIntentionGetExact",
  "consulMeshIntentionUpsert",
  "consulMeshIntentionDelete",
  "consulMeshIntentionDeleteExact",
  "consulMeshIntentionMatch",
  "consulMeshIntentionCheck",
  "consulMeshDiscoveryChain",
  "consulMeshPeeringList",
  "consulMeshPeeringGet",
  "consulMeshPeeringGenerateToken",
  "consulMeshPeeringEstablish",
  "consulMeshPeeringDelete",
  "consulMeshExportedServicesList",
  "consulMeshExportedServicesApply",
] as const;

function functionBody(source: string, operation: string): string {
  const start = source.indexOf(`export async function ${operation}(`);
  expect(start, `${operation} transport function`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

describe("Consul dual transport contract", () => {
  it.each(operations)("exports %s in Tauri and Web transports", (operation) => {
    expect(tauri).toContain(`function ${operation}`);
    expect(http).toContain(`function ${operation}`);
  });

  it("covers every public Consul operation", () => {
    expect(operations).toEqual(expectedOperations);
    expect(new Set(operations).size).toBe(operations.length);
  });

  it.each(expectedOperations)("registers %s end-to-end", (operation) => {
    const command = functionBody(tauri, operation).match(/invoke\("([^"]+)"/)?.[1];
    const httpBody = functionBody(http, operation);
    const route = httpBody.match(/post\("([^"]+)"/)?.[1] ?? (operation === "consulWatchStart" && httpBody.includes("consulBlockingQuery") ? "/api/consul/blocking-query" : undefined);
    expect(command, `${operation} invoke command`).toBe(snakeCase(operation));
    expect(route, `${operation} HTTP route`).toMatch(/^\/api\/consul\//);
    expect(tauriRegistry).toContain(`commands::consul_cmd::${command},`);
    expect(webRegistry).toContain(`.route("${route?.replace(/^\/api/, "")}", post(`);
  });

  it("routes cancellable Catalog and Health watches through both transports", () => {
    expect(tauri).toContain('invoke("consul_domain_watch"');
    expect(http).toContain('post("/api/consul/domain-watch"');
    expect(api).toContain('consulDomainWatch = forward("consulDomainWatch")');
  });

  it("exposes the Agent service detail endpoint in both transports", () => {
    expect(tauri).toContain('invoke("consul_agent_service"');
    expect(http).toContain('post("/api/consul/agent/service"');
    expect(api).toContain('consulAgentService = forward("consulAgentService")');
  });

  it("keeps advanced domains asynchronously split", () => {
    const workspace = readFileSync(new URL("../../../components/consul/ConsulWorkspace.vue", import.meta.url), "utf8");
    for (const component of ["ConsulKeyBrowser", "ConsulServices", "ConsulHealth", "ConsulSessions", "ConsulAcl", "ConsulScope", "ConsulMesh", "ConsulTools", "ConsulOperator"]) {
      expect(workspace).toContain(`const ${component} = defineAsyncComponent`);
    }
  });
});
