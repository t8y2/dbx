import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Scope = "global" | "read" | "write";
type Method = "GET" | "PUT" | "POST" | "DELETE";
type Contract = { domain: string; file: string; method: Method; path: string; needle?: string; methodNeedle?: string; scopeNeedle?: string; scope: Scope };

const contracts: Contract[] = [
  { domain: "capabilities", file: "capabilities.rs", method: "GET", path: "/v1/agent/self", scope: "global" },
  { domain: "capabilities", file: "capabilities.rs", method: "GET", path: "/v1/acl/token/self", scope: "read" },
  { domain: "kv", file: "kv.rs", method: "GET", path: "/v1/kv/{key-or-prefix}", needle: "/v1/kv/{encoded}", scope: "read" },
  { domain: "kv", file: "kv.rs", method: "PUT", path: "/v1/kv/{key}", needle: "/v1/kv/{encoded}", scope: "write" },
  { domain: "kv", file: "kv.rs", method: "DELETE", path: "/v1/kv/{key}", needle: "/v1/kv/{encoded}", scope: "write" },
  { domain: "txn", file: "txn.rs", method: "PUT", path: "/v1/txn", scope: "write" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/kv/{key-or-prefix}", needle: "/v1/kv/{encoded}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/catalog/nodes", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/catalog/services", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/catalog/service/{service}", needle: "/v1/catalog/service/{}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/catalog/node/{node}", needle: "/v1/catalog/node/{}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/health/node/{node}", needle: "/v1/health/node/{}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/health/checks/{service}", needle: "/v1/health/checks/{}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/health/service/{service}", needle: "/v1/health/service/{}{suffix}", scope: "read" },
  { domain: "blocking", file: "blocking.rs", method: "GET", path: "/v1/health/state/{state}", needle: "/v1/health/state/{}", scope: "read" },
  { domain: "status", file: "status.rs", method: "GET", path: "/v1/status/leader", scope: "global" },
  { domain: "status", file: "status.rs", method: "GET", path: "/v1/status/peers", scope: "global" },
  { domain: "catalog", file: "catalog.rs", method: "GET", path: "/v1/catalog/datacenters", scope: "global" },
  { domain: "catalog", file: "catalog.rs", method: "GET", path: "/v1/catalog/nodes", scope: "read" },
  { domain: "catalog", file: "catalog.rs", method: "GET", path: "/v1/catalog/services", scope: "read" },
  { domain: "catalog", file: "catalog.rs", method: "GET", path: "/v1/catalog/service/{service}", needle: "/v1/catalog/service/{}", scope: "read" },
  { domain: "catalog", file: "catalog.rs", method: "GET", path: "/v1/catalog/node/{node}", needle: "/v1/catalog/node/{}", scope: "read" },
  { domain: "health", file: "health.rs", method: "GET", path: "/v1/health/node/{node}", needle: "/v1/health/node/{}", methodNeedle: "read_list(", scope: "read" },
  { domain: "health", file: "health.rs", method: "GET", path: "/v1/health/checks/{service}", needle: "/v1/health/checks/{}", methodNeedle: "read_list(", scope: "read" },
  { domain: "health", file: "health.rs", method: "GET", path: "/v1/health/service/{service}", needle: "/v1/health/service/{}", methodNeedle: "read_list(", scope: "read" },
  { domain: "health", file: "health.rs", method: "GET", path: "/v1/health/state/{state}", needle: "/v1/health/state/{state}", methodNeedle: "read_list(", scope: "read" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/self", scope: "global" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/members", scope: "global" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/metrics", scope: "global" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/services", scope: "read" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/service/{id}", needle: "/v1/agent/service/{}", scope: "read" },
  { domain: "agent", file: "agent.rs", method: "GET", path: "/v1/agent/checks", scope: "read" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/service/register", scope: "write" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/service/deregister/{id}", needle: "/v1/agent/service/deregister/{}", scope: "write" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/service/maintenance/{id}", needle: "/v1/agent/service/maintenance/{}", scope: "write" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/check/register", scope: "write" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/check/deregister/{id}", needle: "/v1/agent/check/deregister/{}", scope: "write" },
  { domain: "agent", file: "agent.rs", method: "PUT", path: "/v1/agent/check/update/{id}", needle: "/v1/agent/check/update/{}", scope: "write" },
  { domain: "session", file: "session.rs", method: "GET", path: "/v1/session/list", scope: "read" },
  { domain: "session", file: "session.rs", method: "GET", path: "/v1/session/node/{node}", needle: "/v1/session/node/{}", scope: "read" },
  { domain: "session", file: "session.rs", method: "GET", path: "/v1/session/info/{id}", needle: "/v1/session/info/{}", scope: "read" },
  { domain: "session", file: "session.rs", method: "PUT", path: "/v1/session/create", scope: "write" },
  { domain: "session", file: "session.rs", method: "PUT", path: "/v1/session/renew/{id}", needle: "/v1/session/renew/{}", scope: "write" },
  { domain: "session", file: "session.rs", method: "PUT", path: "/v1/session/destroy/{id}", needle: "/v1/session/destroy/{}", scope: "write" },
  { domain: "acl", file: "acl.rs", method: "GET", path: "/v1/acl/token/self", scope: "read" },
  { domain: "acl", file: "acl.rs", method: "PUT", path: "/v1/acl/token/{id}/clone", needle: "/v1/acl/token/{accessor_id}/clone", scope: "write" },
  { domain: "acl", file: "acl.rs", method: "GET", path: "/v1/acl/{tokens|policies|roles|auth-methods|binding-rules|templated-policies}", needle: "/v1/acl/tokens", scope: "read" },
  { domain: "acl", file: "acl.rs", method: "PUT", path: "/v1/acl/{token|policy|role|auth-method|binding-rule}", needle: "/v1/acl/token", scope: "write" },
  { domain: "acl", file: "acl.rs", method: "PUT", path: "/v1/acl/{kind}/{id}", needle: "(Method::PUT, item_path", scope: "write" },
  { domain: "acl", file: "acl.rs", method: "DELETE", path: "/v1/acl/{kind}/{id}", needle: "item_path(kind, id)", scope: "write" },
  { domain: "enterprise", file: "enterprise.rs", method: "GET", path: "/v1/namespaces", scope: "read" },
  { domain: "enterprise", file: "enterprise.rs", method: "GET", path: "/v1/partitions", scope: "read" },
  { domain: "enterprise", file: "enterprise.rs", method: "GET", path: "/v1/{namespace|partition}/{name}", needle: "/v1/namespace/{name}", scope: "read" },
  { domain: "enterprise", file: "enterprise.rs", method: "PUT", path: "/v1/{namespace|partition}", needle: "/v1/namespace", scope: "write" },
  { domain: "enterprise", file: "enterprise.rs", method: "PUT", path: "/v1/{namespace|partition}/{name}", needle: "Some(name) => (Method::PUT", scope: "write" },
  { domain: "enterprise", file: "enterprise.rs", method: "DELETE", path: "/v1/{namespace|partition}/{name}", needle: "client.send(Method::DELETE", scopeNeedle: "append_enterprise_target", scope: "write" },
  { domain: "mesh-config", file: "mesh/config_entries.rs", method: "GET", path: "/v1/config/{kind}", needle: "/v1/config/{}", scope: "read" },
  { domain: "mesh-config", file: "mesh/config_entries.rs", method: "GET", path: "/v1/config/{kind}/{name}", needle: "/v1/config/{}/{}", scope: "read" },
  { domain: "mesh-config", file: "mesh/config_entries.rs", method: "PUT", path: "/v1/config", scope: "write" },
  { domain: "mesh-config", file: "mesh/config_entries.rs", method: "DELETE", path: "/v1/config/{kind}/{name}", needle: "config_path(kind, name)", scope: "write" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "GET", path: "/v1/connect/intentions", scope: "read" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "GET", path: "/v1/connect/intentions/{id}", needle: "/v1/connect/intentions/{}", scope: "read" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "GET", path: "/v1/connect/intentions/exact", scope: "read" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "PUT", path: "/v1/connect/intentions/exact", scope: "write" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "DELETE", path: "/v1/connect/intentions/{id|exact}", needle: "send_json(Method::DELETE", scope: "write" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "GET", path: "/v1/connect/intentions/match", scope: "read" },
  { domain: "intentions", file: "mesh/intentions.rs", method: "GET", path: "/v1/connect/intentions/check", scope: "read" },
  { domain: "discovery", file: "mesh/discovery.rs", method: "GET", path: "/v1/discovery-chain/{service}", needle: "/v1/discovery-chain/{service}", scope: "read" },
  { domain: "peering", file: "mesh/peering.rs", method: "GET", path: "/v1/peerings", scope: "read" },
  { domain: "peering", file: "mesh/peering.rs", method: "GET", path: "/v1/peering/{name}", needle: "/v1/peering/{}", scope: "read" },
  { domain: "peering", file: "mesh/peering.rs", method: "POST", path: "/v1/peering/token", scope: "write" },
  { domain: "peering", file: "mesh/peering.rs", method: "POST", path: "/v1/peering/establish", scope: "write" },
  { domain: "peering", file: "mesh/peering.rs", method: "DELETE", path: "/v1/peering/{name}", needle: "send_json(Method::DELETE", scope: "write" },
  { domain: "exported-services", file: "mesh/exported_services.rs", method: "GET", path: "/v1/exported-services", scope: "read" },
  { domain: "exported-services", file: "mesh/exported_services.rs", method: "PUT", path: "/v1/config", needle: "consul_mesh_config_apply_core", methodNeedle: "consul_mesh_config_apply_core", scopeNeedle: "consul_mesh_config_apply_core", scope: "write" },
  { domain: "tools", file: "tools.rs", method: "GET", path: "/v1/query", scope: "read" },
  { domain: "tools", file: "tools.rs", method: "POST", path: "/v1/query", scope: "write" },
  { domain: "tools", file: "tools.rs", method: "PUT", path: "/v1/query/{id}", needle: "/v1/query/{}", scope: "write" },
  { domain: "tools", file: "tools.rs", method: "DELETE", path: "/v1/query/{id}", needle: "send_json(Method::DELETE", scope: "write" },
  { domain: "tools", file: "tools.rs", method: "GET", path: "/v1/query/{id}/execute", needle: "/v1/query/{}/execute", scope: "read" },
  { domain: "tools", file: "tools.rs", method: "GET", path: "/v1/query/{id}/explain", needle: "/v1/query/{}/explain", scope: "read" },
  { domain: "tools", file: "tools.rs", method: "GET", path: "/v1/event/list", scope: "read" },
  { domain: "tools", file: "tools.rs", method: "PUT", path: "/v1/event/fire/{name}", needle: "/v1/event/fire/{}", scope: "write" },
  { domain: "tools", file: "tools.rs", method: "GET", path: "/v1/coordinate/nodes", scope: "read" },
  { domain: "operator", file: "operator.rs", method: "GET", path: "/v1/operator/{autopilot|raft|usage|license}", needle: "/v1/operator/autopilot/configuration", scope: "read" },
  { domain: "operator", file: "operator.rs", method: "POST", path: "/v1/operator/audit-hash", scope: "read" },
  { domain: "operator", file: "operator.rs", method: "GET", path: "/v1/snapshot", scope: "read" },
  { domain: "operator", file: "operator.rs", method: "PUT", path: "/v1/snapshot", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "PUT", path: "/v1/operator/autopilot/configuration", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "POST", path: "/v1/operator/raft/transfer-leader", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "DELETE", path: "/v1/operator/raft/peer", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "POST", path: "/v1/operator/keyring", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "PUT", path: "/v1/operator/keyring", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "DELETE", path: "/v1/operator/keyring", scope: "write" },
  { domain: "operator", file: "operator.rs", method: "PUT", path: "/v1/operator/license", scope: "write" },
];

const sourceCache = new Map<string, string>();
function source(file: string): string {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(join(process.cwd(), "crates/dbx-core/src/consul", file), "utf8"));
  return sourceCache.get(file)!;
}

const methodScopeSnapshot = {
  "kv.rs": [4, 3, 0, 1, 4, 4],
  "txn.rs": [0, 1, 0, 0, 0, 1],
  "blocking.rs": [2, 0, 0, 0, 2, 0],
  "status.rs": [2, 0, 0, 0, 0, 0],
  "catalog.rs": [2, 0, 0, 0, 5, 0],
  "health.rs": [0, 0, 0, 0, 4, 0],
  "agent.rs": [6, 2, 0, 0, 3, 2],
  "session.rs": [1, 3, 0, 0, 3, 3],
  "acl.rs": [9, 3, 0, 1, 9, 3],
  "enterprise.rs": [5, 2, 0, 1, 3, 2],
  "mesh/config_entries.rs": [2, 1, 0, 1, 2, 2],
  "mesh/intentions.rs": [6, 1, 0, 2, 6, 3],
  "mesh/discovery.rs": [1, 0, 0, 0, 1, 0],
  "mesh/peering.rs": [2, 0, 2, 1, 2, 3],
  "mesh/exported_services.rs": [1, 0, 0, 0, 1, 0],
  "tools.rs": [7, 2, 1, 1, 5, 3],
  "operator.rs": [2, 4, 3, 2, 3, 6],
  "capabilities.rs": [3, 0, 1, 0, 3, 0],
} satisfies Record<string, [number, number, number, number, number, number]>;

describe("Consul Core endpoint contract", () => {
  it("enumerates every supported domain without duplicate rows", () => {
    expect(new Set(contracts.map(({ domain }) => domain))).toEqual(new Set(["capabilities", "kv", "txn", "blocking", "status", "catalog", "health", "agent", "session", "acl", "enterprise", "mesh-config", "intentions", "discovery", "peering", "exported-services", "tools", "operator"]));
    const identities = contracts.map(({ domain, method, path, scope }) => `${domain}:${method}:${path}:${scope}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it.each(contracts)("$domain $method $path uses $scope scope", ({ file, method, path, needle, methodNeedle, scopeNeedle, scope }) => {
    const code = source(file);
    const evidence = needle ?? path;
    expect(code, `${file} path evidence for ${path}`).toContain(evidence);
    expect(code, `${file} method evidence for ${method} ${path}`).toContain(methodNeedle ?? `Method::${method}`);
    if (scopeNeedle) expect(code, `${file} scope delegation for ${path}`).toContain(scopeNeedle);
    else if (scope === "read") expect(code).toMatch(/append_scope\(&mut url, true\)|request_json\([\s\S]*?true|send_json\([\s\S]*?true|read_list\(/);
    else if (scope === "write") expect(code).toMatch(/append_scope\(&mut url, false\)|request_json\([\s\S]*?false|send_json\([\s\S]*?false|ensure_writable/);
  });

  it("centralizes scoped requests and ACL token headers", () => {
    const client = source("client.rs");
    expect(client).toContain("self.append_scope(&mut url, read);");
    expect(client).toContain('request.header("X-Consul-Token", &self.config.token)');
    expect(client.match(/request\.header\("X-Consul-Token"/g)).toHaveLength(2);
  });

  it("keeps gossip keys in the request body and maps each operation to its official method", () => {
    const operator = source("operator.rs");
    expect(operator).toContain("ConsulKeyringOperation::Install => Method::POST");
    expect(operator).toContain("ConsulKeyringOperation::Use => Method::PUT");
    expect(operator).toContain("ConsulKeyringOperation::Remove => Method::DELETE");
    expect(operator).toContain("ConsulKeyringWriteBody { key: request.key.trim() }");
    expect(operator).not.toMatch(/query_pairs_mut\(\)\.append_pair\([^\n]*request\.key/);
  });

  it("uses the official write methods for ACL, Enterprise, and Audit endpoints", () => {
    const acl = source("acl.rs");
    expect(acl).toContain('request_json(Method::PUT, url, Some(&request), false, "clone ACL token")');
    expect(acl).toContain("(Method::PUT, collection_create_path(kind)?.to_string())");

    const enterprise = source("enterprise.rs");
    expect(enterprise).toMatch(/None => \(\s*Method::PUT,/);

    const operator = source("operator.rs");
    expect(operator).toContain('ConsulOperatorReadKind::Audit => "/v1/operator/audit-hash"');
    expect(operator).toMatch(/matches!\(kind, ConsulOperatorReadKind::Audit\)[\s\S]*?request_json\(\s*Method::POST/);
  });

  it.each(Object.entries(methodScopeSnapshot))("keeps %s method/scope call counts stable", (file, expected) => {
    const code = source(file).split("#[cfg(test)]")[0];
    const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
    expect([
      count(/Method::GET/g),
      count(/Method::PUT/g),
      count(/Method::POST/g),
      count(/Method::DELETE/g),
      count(/(?:request_json|send_json)\([^;]*?true/g) + count(/append_scope\(&mut url, true/g) + count(/read_list\(/g),
      count(/(?:request_json|send_json)\([^;]*?false/g) + count(/append_scope\(&mut url, false/g) + count(/request_json_unscoped\(/g),
    ]).toEqual(expected);
  });
});
